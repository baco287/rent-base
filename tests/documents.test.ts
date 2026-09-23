// Integrationstest Phase 5: PDF-Dokumente, Archiv, E-Mail-Versand. Gegen die lokale Entwicklungsdatenbank.
// SMTP wird durch eine Attrappe ersetzt: Aus der Testsuite geht nie eine echte E-Mail hinaus.
// Der lokale Entwicklungs-Postausgang aus .env soll in den Tests nicht greifen: hier zählt nur die Attrappe.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature } from "../src/lib/contracts";
import { addNewDamage, answerChecklist, finalizeHandover, getHandoverContentHash, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { DocumentIntegrityError, documentFileName, ensureContractDocument, ensurePickupDocument, loadPhotosForPdf, loadSketchSvg, readDocumentFile, safeFilePart, shrinkPhoto } from "../src/lib/documents";
import { loadContractDocumentData, loadHandoverDocumentData } from "../src/lib/document-data";
import { runPickupFollowUp } from "../src/lib/followup";
import { getMailTransport, isValidEmail, mailStatus, safeMailError, type MailMessage, type MailTransport } from "../src/lib/mail";
import { composePickupMail, sendPickupDocuments } from "../src/lib/rental-mail";
import { renderContractPdf } from "../src/lib/pdf/contract-pdf";
import { renderHandoverPdf } from "../src/lib/pdf/handover-pdf";
import { parseSketchSvg } from "../src/lib/pdf/sketch";
import type { PdfTrace } from "../src/lib/pdf/layout";
import { isImmutableError, sha256 } from "../src/lib/integrity";
import { buildStorageKey, getStorage, type StorageDriver } from "../src/lib/storage";
import { createWorld, purgeTenants } from "./helpers";
import { LONG_NAME, contractData, handoverData, photoJpeg, signaturePng, sketchSvg } from "./pdf-fixtures";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-docs-"));
  storage = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

class FakeTransport implements MailTransport {
  readonly name = "fake";
  sent: MailMessage[] = [];
  fail: unknown = null;
  async send(m: MailMessage) {
    if (this.fail) throw this.fail;
    this.sent.push(m);
    return { messageId: `<fake-${this.sent.length}@test>` };
  }
}

const pngDataUrl = async () => `data:image/png;base64,${Buffer.from(await signaturePng(600, 200)).toString("base64")}`;

/** Buchung mit abgeschlossenem Mietvertrag (echtes Unterschriftsbild, damit es im PDF landet). */
async function signedWorld(label: string, customer?: Record<string, unknown>) {
  await ready;
  const w = await createWorld(label, { customer });
  tenants.push(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: await pngDataUrl(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return { w, contractId: c.id };
}

/** Dazu eine finalisierte Übergabe mit einem bestehenden und einem neu entdeckten Schaden. */
async function pickedUpWorld(label: string, customer?: Record<string, unknown>) {
  const { w, contractId } = await signedWorld(label, customer);
  const old = await db.damage.create({ data: { tenantId: w.tenantId, vehicleId: w.vehicleId, view: "LEFT", posX: 0.4, posY: 0.5, kind: "SCRATCH", severity: "MINOR", description: "Kratzer Fahrertür alt", status: "OPEN" } });
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, h.id, { mileage: 50_040, fuelLevelEighths: 6 });
  const fresh = await addNewDamage(w.tenantId, h.id, { view: "FRONT", posX: 1, posY: 0, kind: "CHIP", severity: "MINOR", description: "Steinschlag Haube neu" });
  // echtes Kamerafoto zum neuen Schaden, damit die Einbettung ins PDF mitgeprüft wird
  const jpeg = await photoJpeg("Steinschlag");
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  await storage.put(storageKey, jpeg, "image/jpeg");
  await registerPhoto(w.tenantId, w.actor, { handoverId: h.id, handoverDamageId: fresh.id, storageKey, category: "DAMAGE", contentType: "image/jpeg", sizeBytes: jpeg.length, checksum: sha256(jpeg) });
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId: h.id }, orderBy: { sortOrder: "asc" } });
  await answerChecklist(w.tenantId, h.id, items.map((i, n) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2" : n === 0 ? "NA" : n === 3 ? "NOT_OK" : i.answerType === "YES_NO" ? "YES" : "OK", note: n === 3 ? "Profil vorne rechts gering" : null })));
  await saveHandoverSignature(w.tenantId, w.actor, h.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: await pngDataUrl(), seenHash: await getHandoverContentHash(w.tenantId, h.id), ipAddress: null, userAgent: "test" });
  await finalizeHandover(w.tenantId, h.id, w.actor, { enforcePhotos: false });
  return { w, contractId, handoverId: h.id, oldDamageId: old.id };
}

test("Übergabe-PDF: Fotos kopierter Vorschäden (aus Fahrzeugakte oder früherem Protokoll) werden eingebettet, nicht nur verwiesen", async () => {
  await ready;
  const { w } = await signedWorld("doc-pickup-prephoto");
  // Vorschaden auf dem Hof erfasst und fotografiert – das Foto hängt am Schaden, nicht an einem Protokoll
  const old = await db.damage.create({ data: { tenantId: w.tenantId, vehicleId: w.vehicleId, view: "LEFT", posX: 0.4, posY: 0.5, kind: "SCRATCH", severity: "MINOR", description: "Kratzer Schiebetür alt", status: "OPEN" } });
  const jpeg = await photoJpeg("Vorschaden");
  const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", contentType: "image/jpeg" });
  await storage.put(key, jpeg, "image/jpeg");
  const prePhoto = await db.photo.create({ data: { tenantId: w.tenantId, damageId: old.id, storageKey: key, category: "DAMAGE", contentType: "image/jpeg", sizeBytes: jpeg.length, checksum: sha256(jpeg) } });
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, h.id, { mileage: 50_040, fuelLevelEighths: 6 });
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId: h.id }, orderBy: { sortOrder: "asc" } });
  await answerChecklist(w.tenantId, h.id, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  await saveHandoverSignature(w.tenantId, w.actor, h.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: await pngDataUrl(), seenHash: await getHandoverContentHash(w.tenantId, h.id), ipAddress: null, userAgent: "test" });
  await finalizeHandover(w.tenantId, h.id, w.actor, { enforcePhotos: false });
  assert.equal(await db.photo.count({ where: { handoverId: h.id } }), 0, "zu diesem Protokoll selbst wurde kein Foto hochgeladen");

  const data = await loadHandoverDocumentData(w.tenantId, h.id);
  const existing = data.doc.damages.find((d) => d.marker === "EXISTING")!;
  assert.deepEqual(existing.photos.map((p) => p.id), [prePhoto.id], "Protokollkopie verweist auf das Vorschadenfoto");
  assert.ok(data.photoFiles.some((f) => f.id === prePhoto.id && f.storageKey === key && f.checksum === sha256(jpeg)), "Fotodatei des Vorschadens wird für das PDF geladen (Speicherort und Prüfsumme aus der Kopie)");
  const photos = await loadPhotosForPdf(w.tenantId, storage, data.photoFiles);
  assert.ok(photos.has(prePhoto.id));
  const { trace } = await renderHandoverPdf(data.doc, { sketchSvg: await loadSketchSvg(data.sketch), photos, signatures: data.signatureImages });
  assertCleanLayout(trace, "Übergabe mit Vorschadenfoto");
  assert.equal(trace.images.filter((i) => i.kind === "photo").length, 1, "das Vorschadenfoto ist eingebettet");
  assert.ok(!trace.notes.some((n) => n.includes("nicht eingebettet")), "kein Platzhalter „Original liegt im Archiv“");
  // Wird das Original später verändert, weicht es von der versiegelten Prüfsumme ab und wird bewusst nicht eingebettet
  await storage.remove(key);
  await storage.put(key, await photoJpeg("Ausgetauscht"), "image/jpeg");
  const tampered = await loadPhotosForPdf(w.tenantId, storage, data.photoFiles);
  assert.equal(tampered.has(prePhoto.id), false, "abweichende Datei wird nicht eingebettet");
  const res = await ensurePickupDocument(w.tenantId, h.id, w.actor.id, { storage });
  assert.equal(res.created, true);
});

function assertCleanLayout(trace: PdfTrace, what: string) {
  assert.deepEqual(trace.boxes.filter((b) => b.overflow), [], `${what}: kein Text außerhalb des Satzspiegels`);
  for (const m of trace.markers) {
    assert.ok(m.cx - m.r >= m.frame.x - 0.01 && m.cx + m.r <= m.frame.x + m.frame.w + 0.01 && m.cy - m.r >= m.frame.y - 0.01 && m.cy + m.r <= m.frame.y + m.frame.h + 0.01, `${what}: Marker ${m.index} liegt in der Skizze`);
  }
  for (const i of trace.images) assert.ok(Math.abs(i.w / i.h - i.naturalW / i.naturalH) < 0.01, `${what}: ${i.kind} ist nicht verzerrt`);
}

test("PDF-Layout: kurz und lang, 0 und viele Schäden, viele Fotos, lange Checkliste, mehrere Seiten", async () => {
  const signatures = new Map([["sig-renter", await signaturePng(800, 200)], ["sig-employee", await signaturePng(500, 400)]]);
  const short = await renderContractPdf(contractData("short"), signatures);
  const long = await renderContractPdf(contractData("long"), signatures);
  for (const [name, r] of [["Vertrag kurz", short], ["Vertrag lang", long]] as const) {
    assert.equal(r.bytes.subarray(0, 5).toString(), "%PDF-");
    assertCleanLayout(r.trace, name);
  }
  assert.ok(long.trace.pages >= 5, "lange Mietbedingungen laufen über mehrere Seiten");
  assert.ok(long.trace.texts.includes(LONG_NAME), "sehr langer Name steht vollständig im Dokument");
  assert.equal(long.trace.texts.filter((t) => /^Zusatzfahrer \d$/i.test(t)).length, 3);
  assert.equal(long.trace.images.filter((i) => i.kind === "signature").length, 2);

  const empty = await renderHandoverPdf(handoverData("empty"), { sketchSvg: await sketchSvg(), photos: new Map(), signatures });
  assertCleanLayout(empty.trace, "Übergabe leer");
  assert.equal(empty.trace.markers.length, 0);
  assert.ok(empty.trace.texts.some((t) => t.includes("keine Schäden dokumentiert")));

  const full = handoverData("full");
  const photos = new Map<string, Uint8Array>();
  for (const id of [...full.photos.map((p) => p.id), ...full.damages.flatMap((d) => d.photos.map((p) => p.id))]) photos.set(id, (await shrinkPhoto(await photoJpeg(id)))!);
  const big = await renderHandoverPdf(full, { sketchSvg: await sketchSvg(), photos, signatures });
  assertCleanLayout(big.trace, "Übergabe voll");
  assert.equal(big.trace.markers.length, 14, "jeder Schaden hat genau einen Marker, auch in den Ecken der Skizze");
  assert.equal(big.trace.images.filter((i) => i.kind === "photo").length, 14);
  assert.ok(big.trace.pages >= 4);
  assert.ok(big.bytes.length < 1_500_000, `PDF mit 14 Kamerafotos bleibt handlich (${big.bytes.length} Bytes)`);
  assert.equal(big.trace.texts.filter((t) => t === "BESTEHENDER SCHADEN").length, 8);
  assert.equal(big.trace.texts.filter((t) => t === "BEI ÜBERGABE DOKUMENTIERTER VORSCHADEN").length, 6);
  assert.ok(big.trace.texts.includes("NICHT ZUTREFFEND") && big.trace.texts.includes("NICHT IN ORDNUNG"));
  assert.ok(!big.trace.texts.some((t) => /verursacht|vom Mieter/i.test(t)), "kein Text schreibt einen Vorschaden dem Mieter zu");
});

test("Skizze: die Systemskizzen werden vollständig verstanden, Dateinamen sind sicher", async () => {
  const model = parseSketchSvg(await sketchSvg());
  assert.deepEqual(model.skipped, []);
  assert.ok(model.elements.length > 30);
  assert.ok(model.elements.some((e) => e.matrix[0] === -1), "gespiegelte rechte Seite wird übernommen");
  assert.ok(model.elements.some((e) => e.dash), "gestrichelte Linien bleiben gestrichelt");
  assert.equal(await loadSketchSvg({ assetPath: "/sketches/../../.env", assetHash: "x" }), null);
  assert.equal(await loadSketchSvg({ assetPath: "/sketches/generic-pkw-v2.svg", assetHash: "falsch" }), null, "andere Fassung als im Protokoll wird nicht verwendet");

  assert.equal(documentFileName("RENTAL_CONTRACT", "MV-2026-000123"), "Mietvertrag_MV-2026-000123.pdf");
  assert.equal(documentFileName("PICKUP_PROTOCOL", "MV-2026-000123", "AB-C 123"), "Uebergabe_MV-2026-000123_AB-C-123.pdf");
  assert.equal(documentFileName("PICKUP_PROTOCOL", "MV-1", "../../etc/passwd\r\n", 2), "Uebergabe_MV-1_etc-passwd_v2.pdf");
  assert.equal(safeFilePart("Müller & Söhne/..\\x"), "Mueller-Soehne-x");
});

test("Mietvertrag-PDF: nur nach Abschluss, mit Prüfsumme archiviert, kein Duplikat bei parallelen Anfragen, Versionierung", async () => {
  await ready;
  const w = await createWorld("doc-contract");
  tenants.push(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await assert.rejects(() => ensureContractDocument(w.tenantId, c.id, w.actor.id, { storage }), /erst, wenn der Mietvertrag abgeschlossen ist/);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: await pngDataUrl(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  const signed = await finalizeContract(w.tenantId, c.id);

  const results = await Promise.all(Array.from({ length: 5 }, () => ensureContractDocument(w.tenantId, c.id, w.actor.id, { storage })));
  assert.equal(results.filter((r) => r.created).length, 1, "genau eine Anfrage erzeugt das Dokument");
  assert.equal(new Set(results.map((r) => r.document.id)).size, 1);
  assert.equal(await db.document.count({ where: { tenantId: w.tenantId, contractId: c.id } }), 1);

  const doc = results[0].document;
  assert.equal(doc.type, "RENTAL_CONTRACT");
  assert.equal(doc.version, 1);
  assert.equal(doc.fileName, `Mietvertrag_${signed.number}.pdf`);
  assert.equal(doc.sourceHash, signed.contentHash);
  assert.ok(doc.storageKey.startsWith(`t/${w.tenantId}/documents/`));
  const file = await readDocumentFile(w.tenantId, doc.id, storage);
  assert.equal(Buffer.from(file!.body.subarray(0, 5)).toString(), "%PDF-");
  assert.equal(sha256(file!.body), doc.checksum);
  assert.equal(file!.body.length, doc.sizeBytes);

  const again = await ensureContractDocument(w.tenantId, c.id, w.actor.id, { storage });
  assert.equal(again.created, false);
  assert.equal(again.document.id, doc.id);

  const v2 = await ensureContractDocument(w.tenantId, c.id, w.actor.id, { storage, newVersion: true });
  assert.equal(v2.created, true);
  assert.equal(v2.document.version, 2);
  assert.notEqual(v2.document.storageKey, doc.storageKey);
  assert.ok(v2.document.fileName.endsWith("_v2.pdf"));
  assert.equal(sha256((await readDocumentFile(w.tenantId, doc.id, storage))!.body), doc.checksum, "Version 1 bleibt unverändert bestehen");

  await assert.rejects(() => db.document.update({ where: { id: doc.id }, data: { fileName: "x.pdf" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.document.delete({ where: { id: doc.id } }), (e) => isImmutableError(e));
  // zweite Sicherung in der Datenbank: dieselbe Version lässt sich nicht doppelt anlegen
  await assert.rejects(() => db.document.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, contractId: c.id, type: "RENTAL_CONTRACT", version: 1, storageKey: `t/${w.tenantId}/documents/x.pdf`, fileName: "x.pdf", sizeBytes: 1, checksum: "0".repeat(64) } }));
});

test("Snapshot: spätere Änderungen an Kunde, Fahrzeug, Preisen, Mietbedingungen und Firmendaten ändern das Dokument nicht", async () => {
  const { w, contractId } = await signedWorld("doc-snapshot");
  const before = await loadContractDocumentData(w.tenantId, contractId);
  await db.customer.update({ where: { id: w.customerId }, data: { firstName: "Geändert", lastName: "Anders", street: "Neue Str. 9", email: "neu@example.test" } });
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { plate: "XX-NEU 1", model: "Anderes Modell", dailyRate: 999 } });
  await db.tenant.update({ where: { id: w.tenantId }, data: { name: "Umbenannte Firma", rentalTermsText: "Ganz neue Bedingungen", rentalTermsVersion: "2099-01" } });
  const afterChange = await loadContractDocumentData(w.tenantId, contractId);
  assert.deepEqual(afterChange.doc, before.doc, "Dokumentdaten sind nach den Änderungen identisch");
  assert.equal(afterChange.doc.renterEmail, "erika@example.test");

  const { trace } = await renderContractPdf(afterChange.doc, afterChange.signatureImages);
  const all = trace.texts.join("\n");
  assert.ok(all.includes("Erika Muster") && all.includes("§1 Das Fahrzeug ist pfleglich zu behandeln."));
  assert.ok(!all.includes("Geändert") && !all.includes("XX-NEU") && !all.includes("Ganz neue Bedingungen") && !all.includes("Umbenannte Firma"));
  assert.equal(trace.images.filter((i) => i.kind === "signature").length, 1, "die Unterschrift des Vertrags ist eingebettet");
});

test("Übergabe-PDF: nur nach Abschluss, Snapshot, Schadenklassifizierung, Checkliste, gültige Unterschrift", async () => {
  await ready;
  const { w } = await signedWorld("doc-pickup-draft");
  const draft = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await assert.rejects(() => ensurePickupDocument(w.tenantId, draft.id, w.actor.id, { storage }), /erst, wenn die Übergabe abgeschlossen ist/);

  const p = await pickedUpWorld("doc-pickup");
  const before = await loadHandoverDocumentData(p.w.tenantId, p.handoverId);
  // Live-Daten ändern sich später: Schadenakte, Fahrzeug, Kunde, Checklistenvorlage
  await db.damage.update({ where: { id: p.oldDamageId }, data: { description: "NACHTRÄGLICH GEÄNDERT", status: "REPAIRED" } });
  await db.vehicle.update({ where: { id: p.w.vehicleId }, data: { plate: "XX-NEU 2", fuel: "ELEKTRO" } });
  await db.customer.update({ where: { id: p.w.customerId }, data: { lastName: "Anders" } });
  const data = await loadHandoverDocumentData(p.w.tenantId, p.handoverId);
  assert.deepEqual(data.doc, before.doc);

  const sealed = await db.handover.findUniqueOrThrow({ where: { id: p.handoverId } });
  const validSig = await db.signature.findFirstOrThrow({ where: { handoverId: p.handoverId, contentHash: sealed.contentHash! } });
  assert.deepEqual(data.doc.signatures.map((s) => s.id), [validSig.id], "nur die zum versiegelten Inhalt gehörende Unterschrift");
  assert.equal(data.doc.damages.find((d) => d.marker === "EXISTING")!.description, "Kratzer Fahrertür alt");
  assert.equal(data.doc.context!.renterName, "Erika Muster");
  assert.ok(data.doc.context!.plate.startsWith("HB-T"));

  const res = await ensurePickupDocument(p.w.tenantId, p.handoverId, p.w.actor.id, { storage });
  assert.equal(res.created, true);
  assert.equal(res.document.type, "PICKUP_PROTOCOL");
  assert.equal(res.document.sourceHash, sealed.contentHash);
  assert.match(res.document.fileName, /^Uebergabe_MV-\d{4}-\d+_HB-T-[A-Za-z0-9-]+\.pdf$/);
  const parallel = await Promise.all([1, 2, 3].map(() => ensurePickupDocument(p.w.tenantId, p.handoverId, p.w.actor.id, { storage })));
  assert.ok(parallel.every((r) => !r.created && r.document.id === res.document.id));

  const { trace } = await renderHandoverPdf(data.doc, { sketchSvg: await loadSketchSvg(data.sketch), photos: new Map(), signatures: data.signatureImages });
  assertCleanLayout(trace, "Übergabe");
  const all = trace.texts.join("\n");
  assert.equal(trace.texts.filter((t) => t === "BESTEHENDER SCHADEN").length, 1);
  assert.equal(trace.texts.filter((t) => t === "BEI ÜBERGABE DOKUMENTIERTER VORSCHADEN").length, 1);
  assert.ok(all.includes("Kratzer Fahrertür alt") && all.includes("Steinschlag Haube neu") && !all.includes("NACHTRÄGLICH"));
  assert.ok(all.includes("NICHT ZUTREFFEND") && all.includes("NICHT IN ORDNUNG") && all.includes("Profil vorne rechts gering"));
  assert.equal(trace.markers.length, 2);
  assert.equal(trace.images.filter((i) => i.kind === "signature").length, 1);
  assert.ok(trace.notes.some((n) => n.includes("nicht eingebettet")), "ohne hereingereichte Fotodateien entsteht das PDF kontrolliert ohne Bilder");
  // mit Speicherzugriff wird das Schadenfoto verkleinert eingebettet, das Original bleibt unverändert
  const stored = await db.photo.findFirstOrThrow({ where: { handoverId: p.handoverId } });
  const original = (await storage.get(stored.storageKey))!.body;
  const small = (await shrinkPhoto(original))!;
  assert.ok(small.length < original.length / 2, "Foto wird für das PDF deutlich verkleinert");
  const withPhoto = await renderHandoverPdf(data.doc, { sketchSvg: await loadSketchSvg(data.sketch), photos: new Map([[stored.id, small]]), signatures: data.signatureImages });
  assert.equal(withPhoto.trace.images.filter((i) => i.kind === "photo").length, 1);
  assert.equal(sha256((await storage.get(stored.storageKey))!.body), stored.checksum);
});

test("E-Mail: Erfolg, richtige Anhänge, Empfänger aus der Vertragskopie, kein Doppelversand, erneut senden", async () => {
  const p = await pickedUpWorld("mail-ok");
  await db.customer.update({ where: { id: p.w.customerId }, data: { email: "spaeter-geaendert@example.test" } });
  const transport = new FakeTransport();
  const first = await runPickupFollowUp(p.w.tenantId, { id: p.handoverId, contractId: p.contractId }, p.w.actor.id, { storage, transport });
  assert.deepEqual([first.contractDocument.ok, first.pickupDocument.ok, first.email.status], [true, true, "SENT"]);
  assert.equal(transport.sent.length, 1);

  const mail = transport.sent[0];
  assert.equal(mail.to, "erika@example.test", "Empfänger ist die Adresse aus dem Vertrag, nicht die später geänderte");
  assert.match(mail.subject, /^Ihre Mietunterlagen – MV-/);
  assert.ok(mail.text.includes("Guten Tag Erika Muster,") && mail.text.includes("VW Crafter") && mail.text.includes("Bitte bewahren Sie die Unterlagen"));
  const docs = await db.document.findMany({ where: { tenantId: p.w.tenantId, bookingId: p.w.bookingId }, orderBy: { type: "desc" } });
  assert.deepEqual(docs.map((d) => d.type), ["RENTAL_CONTRACT", "PICKUP_PROTOCOL"]);
  assert.deepEqual(mail.attachments.map((a) => a.filename), docs.map((d) => d.fileName));
  assert.deepEqual(mail.attachments.map((a) => sha256(a.content)), docs.map((d) => d.checksum), "verschickt werden exakt die archivierten Dateien");

  const log = await db.emailLog.findFirstOrThrow({ where: { tenantId: p.w.tenantId, bookingId: p.w.bookingId } });
  assert.deepEqual([log.status, log.trigger, log.attemptNo, log.attempts, log.recipient, log.handoverId], ["SENT", "AUTO", 1, 1, "erika@example.test", p.handoverId]);
  assert.equal(log.providerMessageId, "<fake-1@test>");
  assert.ok(log.sentAt && log.idempotencyKey.startsWith(`PICKUP_DOCUMENTS:${p.handoverId}:`));
  assert.equal((log.attachments as unknown[]).length, 2);

  // Neuladen, Doppelklick, parallele Requests: nichts geht doppelt raus
  const second = await runPickupFollowUp(p.w.tenantId, { id: p.handoverId, contractId: p.contractId }, p.w.actor.id, { storage, transport });
  assert.equal(second.email.status, "DUPLICATE");
  const many = await Promise.all([1, 2, 3, 4].map(() => sendPickupDocuments(p.w.tenantId, p.handoverId, { trigger: "AUTO", transport, storage })));
  assert.ok(many.every((r) => r.status === "DUPLICATE"));
  assert.equal(transport.sent.length, 1);
  assert.equal(await db.emailLog.count({ where: { tenantId: p.w.tenantId } }), 1);

  // Erneut senden: derselbe Formularwert sendet einmal, ein neuer Formularwert ist ein neuer Versuch
  const manual = await Promise.all([1, 2].map(() => sendPickupDocuments(p.w.tenantId, p.handoverId, { trigger: "MANUAL", actorId: p.w.actor.id, nonce: "nonce-aaaa-1111", transport, storage })));
  assert.deepEqual(manual.map((r) => r.status).sort(), ["DUPLICATE", "SENT"]);
  const third = await sendPickupDocuments(p.w.tenantId, p.handoverId, { trigger: "MANUAL", actorId: p.w.actor.id, nonce: "nonce-bbbb-2222", transport, storage });
  assert.equal(third.status, "SENT");
  assert.equal(transport.sent.length, 3);
  const logs = await db.emailLog.findMany({ where: { tenantId: p.w.tenantId }, orderBy: { attemptNo: "asc" } });
  assert.deepEqual(logs.map((l) => [l.attemptNo, l.trigger, l.status]), [[1, "AUTO", "SENT"], [2, "MANUAL", "SENT"], [3, "MANUAL", "SENT"]]);
  assert.equal(await db.document.count({ where: { tenantId: p.w.tenantId } }), 2, "beim erneuten Senden entsteht kein neues Dokument");
  await assert.rejects(() => sendPickupDocuments(p.w.tenantId, p.handoverId, { trigger: "MANUAL", nonce: "x", transport, storage }), /veraltet/);
});

test("SMTP-Ausfall und ungültige Adresse: Übergabe bleibt abgeschlossen, Versuch ist als FAILED protokolliert, Wiederholung klappt", async () => {
  const p = await pickedUpWorld("mail-fail");
  const stateBefore = { booking: await db.booking.findUniqueOrThrow({ where: { id: p.w.bookingId } }), vehicle: await db.vehicle.findUniqueOrThrow({ where: { id: p.w.vehicleId } }), damages: await db.damage.count({ where: { tenantId: p.w.tenantId } }) };
  const transport = new FakeTransport();
  transport.fail = Object.assign(new Error("connect ECONNREFUSED smtp://postfach:GEHEIMES-PASSWORT@mail.example:587"), { code: "ECONNREFUSED" });
  const res = await runPickupFollowUp(p.w.tenantId, { id: p.handoverId, contractId: p.contractId }, p.w.actor.id, { storage, transport });
  assert.equal(res.email.status, "FAILED");
  const failed = await db.emailLog.findFirstOrThrow({ where: { tenantId: p.w.tenantId } });
  assert.deepEqual([failed.status, failed.error, failed.attempts], ["FAILED", "SMTP-Verbindung fehlgeschlagen", 1]);
  assert.ok(!JSON.stringify(failed).includes("GEHEIM"), "keine Zugangsdaten im Protokoll");

  const h = await db.handover.findUniqueOrThrow({ where: { id: p.handoverId } });
  const b = await db.booking.findUniqueOrThrow({ where: { id: p.w.bookingId } });
  const v = await db.vehicle.findUniqueOrThrow({ where: { id: p.w.vehicleId } });
  assert.deepEqual([h.status, b.status, v.mileage], ["FINALIZED", "ACTIVE", 50_040]);
  assert.deepEqual([b.status, v.mileage, await db.damage.count({ where: { tenantId: p.w.tenantId } })], [stateBefore.booking.status, stateBefore.vehicle.mileage, stateBefore.damages]);

  transport.fail = null;
  const retry = await sendPickupDocuments(p.w.tenantId, p.handoverId, { trigger: "MANUAL", actorId: p.w.actor.id, nonce: "nonce-retry-0001", transport, storage });
  assert.equal(retry.status, "SENT");
  assert.deepEqual((await db.emailLog.findMany({ where: { tenantId: p.w.tenantId }, orderBy: { attemptNo: "asc" } })).map((l) => l.status), ["FAILED", "SENT"]);
  assert.equal(await db.document.count({ where: { tenantId: p.w.tenantId } }), 2);

  // ungültige Adresse im Vertrag: nichts wird gesendet, der Versuch ist dokumentiert
  const bad = await pickedUpWorld("mail-invalid", { email: "keine-adresse" });
  const t2 = new FakeTransport();
  const r2 = await runPickupFollowUp(bad.w.tenantId, { id: bad.handoverId, contractId: bad.contractId }, bad.w.actor.id, { storage, transport: t2 });
  assert.equal(r2.email.status, "FAILED");
  assert.match(r2.email.error ?? "", /keine gültige E-Mail-Adresse/);
  assert.equal(t2.sent.length, 0);
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: bad.handoverId } })).status, "FINALIZED");

  // SMTP gar nicht eingerichtet: klare Meldung, nichts Heimliches
  assert.deepEqual(mailStatus({} as NodeJS.ProcessEnv), { configured: false, driver: "none", missing: ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM_EMAIL"] });
  assert.equal(mailStatus({ NODE_ENV: "production", MAIL_DEV_OUTBOX: ".outbox" } as unknown as NodeJS.ProcessEnv).configured, false, "der Entwicklungs-Postausgang greift in Produktion nicht");
  assert.throws(() => getMailTransport({} as NodeJS.ProcessEnv), /noch nicht eingerichtet/);
  const none = await pickedUpWorld("mail-unconfigured");
  const r3 = await runPickupFollowUp(none.w.tenantId, { id: none.handoverId, contractId: none.contractId }, none.w.actor.id, { storage });
  assert.deepEqual([r3.pickupDocument.ok, r3.email.status], [true, "FAILED"]);
  assert.match(r3.email.error ?? "", /noch nicht eingerichtet/);
});

test("Dokumenterzeugung scheitert: Übergabe bleibt gültig, nichts wird versendet, Wiederholung ist sicher", async () => {
  const p = await pickedUpWorld("doc-fail");
  const broken: StorageDriver = { name: "local", put: async () => { throw new Error("Speicher nicht erreichbar"); }, get: async () => null, remove: async () => {} };
  const transport = new FakeTransport();
  const res = await runPickupFollowUp(p.w.tenantId, { id: p.handoverId, contractId: p.contractId }, p.w.actor.id, { storage: broken, transport });
  assert.deepEqual([res.contractDocument.ok, res.pickupDocument.ok, res.email.status], [false, false, "SKIPPED"]);
  assert.equal(transport.sent.length, 0);
  assert.equal(await db.document.count({ where: { tenantId: p.w.tenantId } }), 0);
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: p.handoverId } })).status, "FINALIZED");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: p.w.bookingId } })).status, "ACTIVE");

  // in Produktion ohne Object Storage: klare Meldung statt Ausweichen auf lokale Dateien
  assert.throws(() => getStorage({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv), /noch nicht eingerichtet/);

  const retry = await runPickupFollowUp(p.w.tenantId, { id: p.handoverId, contractId: p.contractId }, p.w.actor.id, { storage, transport });
  assert.deepEqual([retry.contractDocument.ok, retry.pickupDocument.ok, retry.email.status], [true, true, "SENT"]);
});

test("Mandantentrennung und Integrität: fremde Mandanten kommen an nichts heran, veränderte Dateien werden erkannt", async () => {
  const a = await pickedUpWorld("iso-a");
  const b = await signedWorld("iso-b");
  const transport = new FakeTransport();
  await runPickupFollowUp(a.w.tenantId, { id: a.handoverId, contractId: a.contractId }, a.w.actor.id, { storage, transport });
  const doc = await db.document.findFirstOrThrow({ where: { tenantId: a.w.tenantId, type: "PICKUP_PROTOCOL" } });

  assert.equal(await readDocumentFile(b.w.tenantId, doc.id, storage), null, "fremder Mandant kann das Dokument nicht lesen");
  await assert.rejects(() => ensureContractDocument(b.w.tenantId, a.contractId, null, { storage }), /Vertrag nicht gefunden/);
  await assert.rejects(() => ensurePickupDocument(b.w.tenantId, a.handoverId, null, { storage }), /Protokoll nicht gefunden/);
  await assert.rejects(() => sendPickupDocuments(b.w.tenantId, a.handoverId, { trigger: "AUTO", transport, storage }), /Protokoll nicht gefunden/);
  assert.equal(await db.document.count({ where: { tenantId: b.w.tenantId } }), 0);
  assert.equal(await db.emailLog.count({ where: { tenantId: b.w.tenantId } }), 0);

  // Datei im Speicher wird verändert: Auslieferung und Versand verweigern
  await writeFile(path.join(dir, ...doc.storageKey.split("/")), "manipuliert");
  await assert.rejects(() => readDocumentFile(a.w.tenantId, doc.id, storage), (e) => e instanceof DocumentIntegrityError);
  const sent = transport.sent.length;
  const res = await sendPickupDocuments(a.w.tenantId, a.handoverId, { trigger: "MANUAL", nonce: "nonce-tamper-01", transport, storage });
  assert.equal(res.status, "FAILED");
  assert.match(res.log.error ?? "", /nicht unverändert/);
  assert.equal(transport.sent.length, sent);
});

test("E-Mail-Bausteine: Adressprüfung, Text, unbedenkliche Fehlermeldungen", () => {
  for (const ok of ["a@b.de", "erika.muster+miete@example.co.uk"]) assert.equal(isValidEmail(ok), true, ok);
  for (const bad of ["", "keine", "a@b", "a b@c.de", "a@b.de, c@d.de", "a@b.de\nBcc: x@y.de", "<a@b.de>", null, undefined]) assert.equal(isValidEmail(bad), false, String(bad));
  const mail = composePickupMail({ renterName: "Al <Li>", contractNumber: "MV-2026-0001", vehicleTitle: "VW Crafter", plate: "HB-RT 200", startAt: "21.09.2026, 10:00", landlordName: "JetRent", landlordContact: "0421 1" });
  assert.equal(mail.subject, "Ihre Mietunterlagen – MV-2026-0001");
  assert.ok(mail.text.includes("- Mietvertrag\n- Übergabeprotokoll") && mail.text.endsWith("JetRent\n0421 1"));
  assert.ok(mail.html.includes("Al &lt;Li&gt;") && !mail.html.includes("<Li>"));
  assert.equal(safeMailError(Object.assign(new Error("535 auth failed for user x password y"), { code: "EAUTH" })), "SMTP-Anmeldung wurde abgelehnt");
  assert.equal(safeMailError(new Error("irgendwas mit passwort=geheim")), "Versand fehlgeschlagen");
});

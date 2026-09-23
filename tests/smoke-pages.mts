// Rauchtest der Seiten gegen den laufenden Dev-Server (npm run dev) und die lokale Datenbank.
// Legt einen Testmandanten mit Sitzung an, ruft jede Seite auf und räumt danach auf.
// Aufruf: npx tsx tests/smoke-pages.mts [http://localhost:3000] [--keep]
//   --keep  lässt die Testdaten stehen und gibt Sitzung und Buchung aus (für die Sichtprüfung im Browser)
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature } from "../src/lib/contracts";
import { answerChecklist, finalizeHandover, getHandoverContentHash, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft, addNewDamage } from "../src/lib/handovers";
import { buildStorageKey } from "../src/lib/storage";
import { sha256 } from "../src/lib/integrity";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { createWorld, fakeSignaturePng, purgeTenants } from "./helpers";
import { ensureContractDocument, ensurePickupDocument, ensureReturnDocument } from "../src/lib/documents";
import { addManualCharge, confirmProposal } from "../src/lib/returns";
import { ensureInvoiceDocument } from "../src/lib/documents";
import { ensureInvoiceDraft, finalizeInvoice, startInvoiceEdit, updateInvoiceDraft } from "../src/lib/invoices";
import { recordInvoicePayment } from "../src/lib/payments";
import { recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { chargeCustomer, openDamageCase, setLiability } from "../src/lib/damage-cases";
import { reportDamage } from "../src/lib/damages";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3000";

const w = await createWorld("smoke");
await db.user.update({ where: { id: w.userId }, data: { role: "OWNER" } });
const sessionId = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: sessionId, userId: w.userId, expiresAt: new Date(Date.now() + 6 * 3600_000) } });
const cookie = `rb_session=${sessionId}`;

// zweite, alte Buchung ohne Preisstufen (wie vor Phase 2) und eine dritte für den abgeschlossenen Vertrag
const old = await db.booking.create({ data: { tenantId: w.tenantId, number: "ALT-1", vehicleId: w.vehicleId, customerId: w.customerId, startAt: new Date(Date.now() - 40 * 86400_000), endAt: new Date(Date.now() - 30 * 86400_000), dailyRate: 89, deposit: 500, status: "RETURNED" } });
const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-RT 200", make: "VW", model: "Golf", groupId: w.groupId, dailyRate: 49, deposit: 300 } });
const start2 = new Date(Date.now() + 3 * 86400_000);
const signedBooking = await db.booking.create({ data: { tenantId: w.tenantId, number: "SIGN-1", vehicleId: v2.id, customerId: w.customerId, startAt: start2, endAt: new Date(start2.getTime() + 2 * 86400_000), dailyRate: 49, deposit: 300 } });
const signedContract = await ensureContractDraft(w.tenantId, signedBooking.id, w.actor);
const sig = await saveContractSignature(w.tenantId, w.actor, signedContract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, signedContract.id) });
await finalizeContract(w.tenantId, signedContract.id);

// Übergabe-Entwurf für die Buchung mit abgeschlossenem Vertrag, samt Altschaden und neuem Schaden
await db.damage.create({ data: { tenantId: w.tenantId, vehicleId: v2.id, view: "LEFT", posX: 0.3, posY: 0.55, kind: "SCRATCH", description: "Kratzer Fahrertür" } });
const pickup = await startHandover(w.tenantId, signedBooking.id, "PICKUP", w.actor);
await addNewDamage(w.tenantId, pickup.id, { view: "FRONT", posX: 0.5, posY: 0.6, kind: "CHIP", description: "Steinschlag Haube", size: "ca. 1 cm" });

// dritte Buchung: Übergabe komplett finalisiert
const v3 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-RT 300", make: "Tesla", model: "Model 3", groupId: w.groupId, fuel: "ELEKTRO", dailyRate: 99, deposit: 500, mileage: 12000 } });
const doneBooking = await db.booking.create({ data: { tenantId: w.tenantId, number: "DONE-1", vehicleId: v3.id, customerId: w.customerId, startAt: start2, endAt: new Date(start2.getTime() + 2 * 86400_000), dailyRate: 99, deposit: 500 } });
const doneContract = await ensureContractDraft(w.tenantId, doneBooking.id, w.actor);
await saveContractSignature(w.tenantId, w.actor, doneContract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, doneContract.id) });
await finalizeContract(w.tenantId, doneContract.id);
const done = await startHandover(w.tenantId, doneBooking.id, "PICKUP", w.actor);
await updateHandoverDraft(w.tenantId, done.id, { mileage: 12040, batteryPercent: 90 });
for (const c of REQUIRED_PHOTO_CATEGORIES) { const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: doneBooking.id, contentType: "image/jpeg" }); await registerPhoto(w.tenantId, w.actor, { handoverId: done.id, storageKey: key, category: c, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) }); }
const doneItems = await db.handoverChecklistItem.findMany({ where: { handoverId: done.id } });
await answerChecklist(w.tenantId, done.id, doneItems.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2" : i.answerType === "YES_NO" ? "YES" : "OK" })));
await saveHandoverSignature(w.tenantId, w.actor, done.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, done.id) });
await finalizeHandover(w.tenantId, done.id, w.actor);

// Rückgabe-Entwurf für die übergebene Buchung (Elektro): Vergleich, Vorschlag, manuelle Position
const ret = await startHandover(w.tenantId, doneBooking.id, "RETURN", w.actor);
await updateHandoverDraft(w.tenantId, ret.id, { mileage: 12690, batteryPercent: 30 });
const retDamage = await addNewDamage(w.tenantId, ret.id, { view: "REAR", posX: 0.7, posY: 0.5, kind: "DENT", severity: "MINOR", description: "Delle Heckklappe, bei Rückgabe" });
await addManualCharge(w.tenantId, ret.id, w.userId, { type: "CLEANING", description: "Innenreinigung", quantity: 1, unit: "pauschal", unitPrice: 30 });

// Zweite übergebene Buchung mit abgeschlossener Rückgabe (Vergleich, Zusatzkosten, Return-PDF)
const v4 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-RT 400", make: "Ford", model: "Transit", groupId: w.groupId, fuel: "DIESEL", dailyRate: 89, deposit: 500, mileage: 20000, tankCapacityLiters: 80 } });
const retBooking = await db.booking.create({ data: { tenantId: w.tenantId, number: "RET-1", vehicleId: v4.id, customerId: w.customerId, startAt: new Date(Date.now() - 4 * 86400_000), endAt: new Date(Date.now() - 3600_000), dailyRate: 89, deposit: 500 } });
const retContract = await ensureContractDraft(w.tenantId, retBooking.id, w.actor);
await saveContractSignature(w.tenantId, w.actor, retContract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, retContract.id) });
await finalizeContract(w.tenantId, retContract.id);
const fillHandover = async (handoverId: string, bookingId: string, mileage: number, fuel: number) => {
  await updateHandoverDraft(w.tenantId, handoverId, { mileage, fuelLevelEighths: fuel });
  for (const c of REQUIRED_PHOTO_CATEGORIES) { const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId, contentType: "image/jpeg" }); await registerPhoto(w.tenantId, w.actor, { handoverId, storageKey: key, category: c, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) }); }
  const items = await db.handoverChecklistItem.findMany({ where: { handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "remarks" ? "" : "2") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  await saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId) });
  await finalizeHandover(w.tenantId, handoverId, w.actor);
};
const retPickup = await startHandover(w.tenantId, retBooking.id, "PICKUP", w.actor);
await fillHandover(retPickup.id, retBooking.id, 20010, 8);
const retReturn = await startHandover(w.tenantId, retBooking.id, "RETURN", w.actor);
await updateHandoverDraft(w.tenantId, retReturn.id, { mileage: 21600, fuelLevelEighths: 5, fuelPricePerLiter: 1.85 });
await confirmProposal(w.tenantId, retReturn.id, w.userId, "EXTRA_MILEAGE");
await confirmProposal(w.tenantId, retReturn.id, w.userId, "FUEL");
await fillHandover(retReturn.id, retBooking.id, 21600, 5);

// Entwurf für die erste Buchung
const draft = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);

const pages: [string, string][] = [
  [`/buchungen/${doneBooking.id}`, "Rückgabe fortsetzen"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=1`, "mit dem dokumentierten Übergabezustand"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=2`, "650 km"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=3`, "Prozentpunkte"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=4`, "Bei Rückgabe neu festgestellt"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=5`, "Übergabe (vorher)"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=6`, "Anzahl zurückgegebener Schlüssel"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=7`, "Innenreinigung"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=8`, "kein Anerkenntnis"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=9`, "Fahrzeugrückgabe verbindlich abschließen"],
  [`/buchungen/${retBooking.id}`, "Rückgabeprotokoll anzeigen"],
  [`/buchungen/${retBooking.id}`, "Zusatzkosten"],
  [`/buchungen/${retBooking.id}/rueckgabe`, "Vergleich mit der Übergabe"],
  [`/buchungen/${retBooking.id}/rueckgabe`, "Prüfsumme des versiegelten Protokolls"],
  [`/fahrzeuge/${v4.id}`, "Schadenakte"],
  [`/fahrzeuge/${v4.id}`, "Rückgabe"],
  ["/heute", "Abholungen heute"],
  ["/dispo", "Dispo-Kalender"],
  ["/fahrzeuge", "HB-RT 200"],
  ["/fahrzeuge/gruppen", "Kalenderwoche"],
  ["/fahrzeuge/neu", "Fahrzeuggruppe"],
  [`/fahrzeuge/${w.vehicleId}`, "Crafter"],
  ["/kunden", "Muster"],
  ["/kunden/neu", "Ausweisnummer"],
  [`/kunden/${w.customerId}`, "K-00001"],
  ["/buchungen", "Bereit zur Übergabe"],
  ["/buchungen?filter=alle", "ALT-1"],
  ["/buchungen/neu", "Neuer Kunde"],
  [`/buchungen/${w.bookingId}`, "Mietvertrag fortsetzen"],
  [`/buchungen/${old.id}`, "Muster"],
  [`/buchungen/${signedBooking.id}`, "Übergabe fortsetzen"],
  [`/buchungen/${doneBooking.id}`, "Übergabeprotokoll anzeigen"],
  ["/einstellungen", "Mietbedingungen für Verträge"],
  // Vertragsassistent, alle sieben Schritte
  [`/buchungen/${w.bookingId}/vertrag?schritt=1`, "Die Daten des Mieters sind vollständig"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=2`, "Mieter fährt selbst"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=3`, "Das Fahrzeug ist vermietbar und im Zeitraum frei"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=4`, "So entsteht der Mietpreis"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=5`, "Zusatzfahrer hinzufügen"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=6`, "Gesamtmietpreis (brutto)"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=7`, "Mietvertrag verbindlich abschließen"],
  // abgeschlossener Vertrag und vorbereitete Übergabeseite
  [`/buchungen/${signedBooking.id}/vertrag`, "Prüfsumme des unterschriebenen Inhalts"],
  // Übergabe-Assistent, alle sieben Schritte
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=1`, "Bekannte Schäden"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=2`, "Tankstand in Achteln"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=3`, "gilt als Vorschaden"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=4`, "Kilometerstand"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=5`, "Reifen und Felgen"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=6`, "Unterschrift Mieter"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=7`, "Übergabe verbindlich abschließen"],
  // finalisiertes Protokoll eines Elektrofahrzeugs
  [`/buchungen/${doneBooking.id}/uebergabe`, "Prüfsumme des versiegelten Protokolls"],
  [`/buchungen/${doneBooking.id}/uebergabe`, "Batteriestand"],
  [`/buchungen/${w.bookingId}/uebergabe`, "erst möglich, wenn der Mietvertrag abgeschlossen ist"],
];

let failed = 0;
const report = (ok: boolean, text: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FEHL"} ${text}`);
};
for (const [path, expect] of pages) {
  const res = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
  const body = res.status === 200 ? await res.text() : "";
  const ok = res.status === 200 && body.includes(expect);
  report(ok, `${res.status} ${path}${ok ? "" : `  (erwartet: "${expect}")`}`);
}

// Foto-Upload über die geschützte Adresse: echtes JPEG hoch, wieder abrufen, fremder Mandant und anonym abgewiesen
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const upload = async (file: Blob, headers: Record<string, string>) => { const body = new FormData(); body.set("file", file, "foto.jpg"); body.set("category", "FRONT"); return fetch(`${base}/api/handovers/${pickup.id}/photos`, { method: "POST", body, headers, redirect: "manual" }); };
const up = await upload(new Blob([jpeg], { type: "image/jpeg" }), { cookie });
const upJson = (await up.json().catch(() => ({}))) as { id?: string };
report(up.status === 201 && Boolean(upJson.id), `${up.status} Foto-Upload in den Entwurf`);
const got = await fetch(`${base}/api/photos/${upJson.id}`, { headers: { cookie } });
report(got.status === 200 && got.headers.get("content-type") === "image/jpeg" && (await got.arrayBuffer()).byteLength === jpeg.length, `${got.status} Foto wird unverändert ausgeliefert`);
const fake = await upload(new Blob([new TextEncoder().encode("<svg onload=alert(1)>")], { type: "image/jpeg" }), { cookie });
report(fake.status === 415, `${fake.status} Datei, die kein Bild ist, wird abgelehnt`);
const lockedUp = await fetch(`${base}/api/handovers/${done.id}/photos`, { method: "POST", body: (() => { const b = new FormData(); b.set("file", new Blob([jpeg]), "x.jpg"); b.set("category", "OTHER"); return b; })(), headers: { cookie } });
report(lockedUp.status === 409, `${lockedUp.status} Upload in finalisiertes Protokoll wird abgelehnt`);
const anonUp = await upload(new Blob([jpeg]), {});
report(anonUp.status !== 201, `${anonUp.status} Upload ohne Sitzung wird verweigert`);

// Unterschriftsbild: nur mit Sitzung des richtigen Mandanten
const img = await fetch(`${base}/api/signatures/${sig.id}`, { headers: { cookie } });
report(img.status === 200 && img.headers.get("content-type") === "image/png" && (img.headers.get("cache-control") ?? "").includes("no-store"), `${img.status} Unterschriftsbild mit Sitzung, nicht im Cache`);
const anonImg = await fetch(`${base}/api/signatures/${sig.id}`, { redirect: "manual" });
report(anonImg.status !== 200, `${anonImg.status} Unterschriftsbild ohne Sitzung wird verweigert`);
const foreign = await createWorld("smoke-fremd");
const foreignSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: foreignSession, userId: foreign.userId, expiresAt: new Date(Date.now() + 3600_000) } });
const foreignImg = await fetch(`${base}/api/signatures/${sig.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignImg.status === 404, `${foreignImg.status} Unterschriftsbild für fremden Mandanten nicht auffindbar`);
const foreignPhoto = await fetch(`${base}/api/photos/${upJson.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignPhoto.status === 404, `${foreignPhoto.status} Foto für fremden Mandanten nicht auffindbar`);
const foreignUp = await upload(new Blob([jpeg]), { cookie: `rb_session=${foreignSession}` });
report(foreignUp.status === 404, `${foreignUp.status} Upload in fremdes Protokoll nicht möglich`);
const foreignPage = await fetch(`${base}/buchungen/${w.bookingId}/vertrag`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignPage.status === 404, `${foreignPage.status} Vertrag für fremden Mandanten nicht auffindbar`);

// Phase 5: archivierte Dokumente. Erzeugt wird über dieselbe Bibliothek wie in der App, ausgeliefert über die geschützte Adresse.
const contractPdf = await ensureContractDocument(w.tenantId, doneContract.id, w.actor.id);
const pickupPdf = await ensurePickupDocument(w.tenantId, done.id, w.actor.id);
const returnPdf = await ensureReturnDocument(w.tenantId, retReturn.id, w.actor.id);
for (const [name, d] of [["Mietvertrag", contractPdf.document], ["Übergabeprotokoll", pickupPdf.document], ["Rückgabeprotokoll", returnPdf.document]] as const) {
  const res = await fetch(`${base}/api/documents/${d.id}`, { headers: { cookie } });
  const body = new Uint8Array(await res.arrayBuffer());
  report(res.status === 200 && res.headers.get("content-type") === "application/pdf" && sha256(body) === d.checksum && (res.headers.get("cache-control") ?? "").includes("no-store") && (res.headers.get("content-disposition") ?? "").startsWith("inline"), `${res.status} ${name}-PDF mit Sitzung, Prüfsumme stimmt, nicht im Cache`);
}
const dl = await fetch(`${base}/api/documents/${pickupPdf.document.id}?download=1`, { headers: { cookie } });
report(dl.status === 200 && (dl.headers.get("content-disposition") ?? "") === `attachment; filename="${pickupPdf.document.fileName}"`, `${dl.status} Herunterladen mit verständlichem Dateinamen (${pickupPdf.document.fileName})`);
const anonDoc = await fetch(`${base}/api/documents/${pickupPdf.document.id}`, { redirect: "manual" });
report(anonDoc.status !== 200, `${anonDoc.status} Dokument ohne Sitzung wird verweigert`);
const foreignDoc = await fetch(`${base}/api/documents/${pickupPdf.document.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignDoc.status === 404, `${foreignDoc.status} Dokument für fremden Mandanten nicht auffindbar`);
const bookingPage = await (await fetch(`${base}/buchungen/${doneBooking.id}`, { headers: { cookie } })).text();
report(bookingPage.includes("Dokumente") && bookingPage.includes(pickupPdf.document.fileName) && bookingPage.includes("E-Mail nach der Übergabe"), "200 Buchungsseite zeigt Dokumente und E-Mail-Bereich");

// Audit: Upload-Angriffe. Der Server erkennt den Typ am Inhalt, nicht an Name oder Content-Type.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0]);
const attack = async (label: string, body: Uint8Array | string, type: string, expect: number, name = "foto.jpg") => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body; const fd = new FormData(); fd.set("file", new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type }), name); fd.set("category", "OTHER");
  const r = await fetch(`${base}/api/handovers/${pickup.id}/photos`, { method: "POST", body: fd, headers: { cookie } });
  report(r.status === expect, `${r.status} Upload: ${label} (erwartet ${expect})`);
};
await attack("gültiges PNG", png, "image/png", 201, "bild.png");
await attack("gültiges WebP", webp, "image/webp", 201, "bild.webp");
await attack("Endung JPG, Inhalt Text", "kein bild", "image/jpeg", 415);
await attack("SVG mit Skript", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "image/svg+xml", 415, "foto.svg");
await attack("HTML als JPG getarnt", "<html><script>alert(1)</script></html>", "image/jpeg", 415);
await attack("JavaScript", "alert(1)", "text/javascript", 415, "foto.js");
await attack("PDF als Foto", "%PDF-1.7 ...", "application/pdf", 415, "foto.pdf");
await attack("0-Byte-Datei", new Uint8Array(0), "image/jpeg", 400);
await attack("zu große Datei", new Uint8Array(8 * 1024 * 1024 + 1), "image/jpeg", 413);
await attack("beschädigtes JPEG (nur Kopf)", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "image/jpeg", 201);

// Audit: direkte URLs mit falschem Prozessstand
const direct: [string, string][] = [
  [`/buchungen/${w.bookingId}/rueckgabe`, "nur für Fahrzeuge möglich, die unterwegs sind"],
  [`/buchungen/${old.id}/uebergabe`, "kein Übergabeprotokoll"],
  [`/buchungen/${old.id}/rueckgabe`, "Zurückgegeben"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=7`, "Mietvertrag"],
  [`/buchungen/${doneBooking.id}/uebergabe?schritt=3`, "Prüfsumme des versiegelten Protokolls"],
  [`/buchungen/${retBooking.id}/rueckgabe?schritt=2`, "Prüfsumme des versiegelten Protokolls"],
];
for (const [path, expected] of direct) {
  const r = await fetch(base + path, { headers: { cookie } });
  const html = await r.text();
  report(r.status === 200 && html.includes(expected), `${r.status} Direkt-URL ${path} zeigt "${expected}"`);
}
const foreignRet = await fetch(`${base}/buchungen/${retBooking.id}/rueckgabe`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignRet.status === 404, `${foreignRet.status} Rückgabeprotokoll für fremden Mandanten nicht auffindbar`);
const foreignVehicle = await fetch(`${base}/fahrzeuge/${v4.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignVehicle.status === 404, `${foreignVehicle.status} Fahrzeugakte für fremden Mandanten nicht auffindbar`);

// Rechnungsmodul: Startseite ohne Einstellungen, Entwurf, Abschluss, PDF, Buchungsseite
// (React trennt Text und Ausdrücke im HTML durch Kommentare; für die Textsuche werden sie entfernt)
const plain = async (res: Response) => (await res.text()).replace(/<!-- -->/g, "");
const invStart0 = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(invStart0.includes("Rechnung zur Buchung RET-1 erstellen") && invStart0.includes("Steuersatz für Rechnungspositionen") && invStart0.includes("disabled"), "Rechnung: Startseite nennt fehlende Steuereinstellungen, Knopf gesperrt");
await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank" } });
const settingsHtml = await (await fetch(base + "/einstellungen", { headers: { cookie } })).text();
report(settingsHtml.includes("Rechnungsdaten und Steuer") && settingsHtml.includes("DE02120300000000202051"), "Einstellungen: Rechnungsdaten und Steuer");
const invStart1 = await (await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } })).text();
report(invStart1.includes("Rechnung erstellen") && !invStart1.includes("Steuersatz für Rechnungspositionen"), "Rechnung: Startseite bereit");
const retBookingHtml0 = await (await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } })).text();
report(retBookingHtml0.includes("Rechnung erstellen") && retBookingHtml0.includes("noch nicht erstellt"), "Buchung: Rechnung erstellen sichtbar");
const invoice = await ensureInvoiceDraft(w.tenantId, retBooking.id, w.actor);
const invDraft = await (await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } })).text();
report(["Rechnung (Entwurf)", "Alle Prüfungen bestanden", "Rechnungsempfänger", "Quellen des Entwurfs", "Mehrkilometer", "Kraftstoff", "Entwurf speichern", "Rechnung finalisieren", "Position hinzufügen", "Steuerzusammenfassung", "Änderungsprotokoll", "Entwurf verwerfen"].every((t) => invDraft.includes(t)), "Rechnung: Entwurfsseite mit allen Bereichen");
const retBookingHtml1 = await (await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } })).text();
report(retBookingHtml1.includes("Rechnung fortsetzen"), "Buchung: Rechnung fortsetzen");
const finalVersion = await finalizeInvoice(w.tenantId, invoice.id, w.actor);
const finalInvoice = { number: (await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).number!, versionId: finalVersion.id };
const invoicePdf = await ensureInvoiceDocument(w.tenantId, finalVersion.id, w.actor.id);
const invFinal = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?abgeschlossen=1`, { headers: { cookie } }));
report([`Rechnung ${finalInvoice.number}`, "Finalisiert", "Aktuelle Fassung 1", "Noch nicht übermittelt", "Fassungsverlauf", "Rechnung bearbeiten", "Als an Kunden übergeben markieren", "Prüfsumme (SHA-256)", "Rechnungsbetrag", `Rechnung_${finalInvoice.number}_Fassung1.pdf`, "Herunterladen", "E-Mail mit Rechnung", "Rechnung jetzt senden", "Interne Notiz"].every((t) => invFinal.includes(t)) && !invFinal.includes("Entwurf speichern"), "Rechnung: abgeschlossene Ansicht mit Fassungsverlauf, Dokument und E-Mail-Bereich");
const invDoc = await fetch(`${base}/api/documents/${invoicePdf.document.id}?download=1`, { headers: { cookie } });
report(invDoc.status === 200 && (invDoc.headers.get("content-disposition") ?? "").includes(`Rechnung_${finalInvoice.number}_Fassung1.pdf`) && (await invDoc.arrayBuffer()).byteLength === invoicePdf.document.sizeBytes, `${invDoc.status} Rechnungs-PDF herunterladen`);
const retBookingHtml2 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(retBookingHtml2.includes(`Rechnung ${finalInvoice.number} anzeigen`) && retBookingHtml2.includes("abgeschlossen"), "Buchung: Rechnung anzeigen und Status");

// Zahlungen und Kaution (Phase 9): Buchungsseite mit getrennten Bereichen, Rechnungsseite mit Saldo, Rechnungsliste, Dashboard
const bookingFin0 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(["Zahlungen", "Zahlung erfassen", "Kaution", "Kaution als erhalten erfassen", "Noch nicht erhalten", "Kautionshistorie", "Zahlungshistorie", "Offen"].every((t) => bookingFin0.includes(t)), "Buchung: Bereiche Zahlungen und Kaution mit Aktionen");
const pickupNotice = await plain(await fetch(`${base}/buchungen/${signedBooking.id}/uebergabe?schritt=1`, { headers: { cookie } }));
report(pickupNotice.includes("noch nicht") && pickupNotice.includes("als erhalten dokumentiert") && pickupNotice.includes("Bekannte Schäden"), "Übergabe: Warnung Kaution nicht dokumentiert, Übergabe nicht blockiert");
const pay1 = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: invoice.id, amount: "100", method: "CASH", paidAt: new Date(Date.now() - 60_000), reference: "Beleg 77" });
const invPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(invPage.includes("Teilbezahlt") && invPage.includes("100,00") && invPage.includes("Beleg 77") && invPage.includes("Zahlung stornieren") && invPage.includes("Zahlung erfassen"), "Rechnung: Saldo, Status Teilbezahlt, Historie, Storno-Möglichkeit");
await recordDepositReceived(w.tenantId, w.actor, { bookingId: retBooking.id, amount: "500", method: "CASH", occurredAt: new Date(Date.now() - 60_000) });
await settleDeposit(w.tenantId, w.actor, { bookingId: retBooking.id, releaseAmount: "350", method: "CASH", reason: "Prüfung eines bei Rückgabe festgestellten Schadens", occurredAt: new Date(Date.now() - 30_000) });
const bookingFin1 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(["Teilweise freigegeben", "350,00", "150,00", "Prüfung eines bei Rückgabe festgestellten Schadens", "keine Verrechnung", "Bewegung korrigieren"].every((t) => bookingFin1.includes(t)) && !bookingFin1.includes("Kaution als erhalten erfassen"), "Buchung: Kaution teilweise freigegeben, Historie, Hinweis keine Verrechnung");
const invList = await plain(await fetch(base + "/rechnungen?filter=teilbezahlt", { headers: { cookie } }));
report(invList.includes(finalInvoice.number) && invList.includes("Teilbezahlt") && invList.includes("100,00") && invList.includes("nicht übermittelt"), "Rechnungsliste: Filter Teilbezahlt mit Beträgen und Übermittlungsstatus");
const invListPaid = await plain(await fetch(base + "/rechnungen?filter=bezahlt", { headers: { cookie } }));
report(!invListPaid.includes(finalInvoice.number) && invListPaid.includes("Keine Rechnungen"), "Rechnungsliste: Filter Bezahlt leer");
// Rechnungsfassungen: Bearbeiten (Modus A, nicht übermittelt), Fassung 2 finalisieren, Verlauf, PDF je Fassung, Hof sieht nur
const fassung2Draft = await startInvoiceEdit(w.tenantId, invoice.id, w.actor);
const editPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(editPage.includes("Fassung 2 (Entwurf)") && editPage.includes("noch nicht übermittelt") && editPage.includes("Änderungsgrund (optional)") && editPage.includes("Rechnungsempfänger") && editPage.includes("Fassung 2 finalisieren") && editPage.includes("Zahlungen zu dieser Rechnung"), "Rechnung bearbeiten: Entwurf Fassung 2 aus Fassung 1, Modus A mit Zahlungsvorschau");
await updateInvoiceDraft(w.tenantId, invoice.id, w.actor, { items: fassung2Draft.items.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), taxRate: String(i.taxRate) })), customer: { street: "Neue Straße 5" }, reason: "Anschrift korrigiert" });
const fassung2 = await finalizeInvoice(w.tenantId, invoice.id, w.actor);
const v2pdf = await ensureInvoiceDocument(w.tenantId, fassung2.id, w.actor.id);
const afterV2 = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(afterV2.includes("Aktuelle Fassung 2") && afterV2.includes("2 Fassungen") && afterV2.includes("Ersetzt") && afterV2.includes("Neufassung") && afterV2.includes("Neue Straße 5") && afterV2.includes("Änderungen gegenüber Fassung 1") && afterV2.includes(`Rechnung_${finalInvoice.number}_Fassung2.pdf`), "Rechnung: Fassung 2 aktuell, Fassung 1 ersetzt, Differenz sichtbar");
const oldView = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?fassung=1`, { headers: { cookie } }));
report(oldView.includes("Sie sehen die ersetzte Fassung 1") && oldView.includes("Weg 1"), "Rechnung: historische Fassung 1 weiterhin lesbar mit alten Daten");
const oldPdf = await fetch(`${base}/api/documents/${invoicePdf.document.id}?download=1`, { headers: { cookie } });
report(oldPdf.status === 200 && (await oldPdf.arrayBuffer()).byteLength === invoicePdf.document.sizeBytes, `${oldPdf.status} altes PDF der Fassung 1 unverändert abrufbar`);
void v2pdf;
const retBookingV = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(retBookingV.includes("2 Fassungen") && retBookingV.includes("aktuell 2"), "Buchung: Fassungshinweis");
const today = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(today.includes("Offene Rechnungen") && today.includes("Zahlungen heute") && today.includes("Offene Kautionen") && today.includes("Offener Rechnungsbetrag"), "Dashboard: Kennzahlen Zahlungen und Kaution");
void pay1;

// Phase 12: Schadenmanagement. Schaden → Akte → Uploads → Haftung → Kundenbelastung → Schadenabrechnung neben der Mietrechnung.
const hofDamage = await reportDamage(w.tenantId, w.actor, { vehicleId: v4.id, view: "LEFT", posX: 0.4, posY: 0.5, kind: "SCRATCH", description: "Kratzer Schiebetür, nach Rückgabe bemerkt", bookingId: retBooking.id });
const { damageCase: dc } = await openDamageCase(w.tenantId, hofDamage.id, w.actor);
const casesList = await plain(await fetch(base + "/schaeden", { headers: { cookie } }));
report(casesList.includes(dc.caseNumber) && casesList.includes("Noch nicht bewertet") && casesList.includes("HB-RT 400"), "Schäden: Liste mit Akte, Haftung und Fahrzeug");
const casesSearch = await plain(await fetch(base + "/schaeden?filter=alle&q=gibt-es-nicht", { headers: { cookie } }));
report(!casesSearch.includes(dc.caseNumber) && casesSearch.includes("Keine Schadenakten"), "Schäden: Suche ohne Treffer");
const casePage0 = await plain(await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie } }));
report(casePage0.includes(`Schadenakte ${dc.caseNumber}`) && casePage0.includes("Haftungsprüfung") && casePage0.includes("Kaution und Forderung wurden noch nicht miteinander verrechnet") && casePage0.includes("Fahrzeug wegen Schaden sperren") && casePage0.includes("Schadenakte schließen") && casePage0.includes("Selbstbeteiligung") && !casePage0.includes("Schaden dem Kunden berechnen"), "Schadenakte: Abschnitte, Kautionshinweis, ohne bestätigte Haftung keine Belastung");
const caseUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "f.jpg"); fd.set("caption", "Werkstattaufnahme"); return fetch(`${base}/api/damage-cases/${dc.id}/photos`, { method: "POST", body: fd, headers: { cookie } }); })();
report(caseUp.status === 201, `${caseUp.status} Schadenakte: Foto hochgeladen`);
const pdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const caseDoc = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "KV-4711.pdf"); fd.set("type", "ESTIMATE"); return fetch(`${base}/api/damage-cases/${dc.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
const caseDocJson = (await caseDoc.json()) as { id: string };
report(caseDoc.status === 201, `${caseDoc.status} Schadenakte: Kostenvoranschlag (PDF) hochgeladen`);
const caseDocBad = await (async () => { const fd = new FormData(); fd.set("file", new Blob([new TextEncoder().encode("<html>x</html>")], { type: "application/pdf" }), "x.pdf"); fd.set("type", "OTHER"); return fetch(`${base}/api/damage-cases/${dc.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
report(caseDocBad.status === 415, `${caseDocBad.status} Schadenakte: Datei ohne PDF/Bild-Signatur abgewiesen`);
const caseDocGet = await fetch(`${base}/api/damage-documents/${caseDocJson.id}`, { headers: { cookie } });
report(caseDocGet.status === 200 && caseDocGet.headers.get("content-type") === "application/pdf", `${caseDocGet.status} Schadenakte: Dokument über geschützte Adresse`);
const foreignCase = await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignCase.status === 404, `${foreignCase.status} Schadenakte für fremden Mandanten nicht auffindbar`);
const foreignCaseDoc = await fetch(`${base}/api/damage-documents/${caseDocJson.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignCaseDoc.status === 404, `${foreignCaseDoc.status} Schadendokument für fremden Mandanten nicht auffindbar`);
const foreignCaseUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "f.jpg"); return fetch(`${base}/api/damage-cases/${dc.id}/photos`, { method: "POST", body: fd, headers: { cookie: `rb_session=${foreignSession}` } }); })();
report(foreignCaseUp.status === 404, `${foreignCaseUp.status} Upload in fremde Schadenakte nicht möglich`);
await setLiability(w.tenantId, dc.id, w.actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "Mieter hat den Kratzer bei Rückgabe eingeräumt");
const casePage1 = await plain(await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie } }));
report(casePage1.includes("Kunde verantwortlich (bestätigt)") && casePage1.includes("Schaden dem Kunden berechnen") && casePage1.includes("Werkstattaufnahme") && casePage1.includes("KV-4711.pdf"), "Schadenakte: Haftung bestätigt, Belastung möglich, Foto und Dokument sichtbar");
const charge = await chargeCustomer(w.tenantId, dc.id, w.actor, { amount: "350", basis: "Lackierung Schiebetür laut Kostenvoranschlag KV-4711", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" });
const dmgDraft = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${charge.invoiceId}`, { headers: { cookie } }));
report(dmgDraft.includes("Schadenabrechnung (Entwurf)") && dmgDraft.includes("Zur Schadenakte") && dmgDraft.includes(dc.caseNumber) && dmgDraft.includes("nicht steuerbar") && !dmgDraft.includes("Quellen des Entwurfs"), "Schadenabrechnung: Entwurf über ?nr= mit Aktenbezug und Steuerhinweis");
const rentalStill = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(rentalStill.includes(`Rechnung ${finalInvoice.number}`) && rentalStill.includes("Aktuelle Fassung 2"), "Mietrechnung ohne ?nr= unverändert erreichbar");
const dmgVersion = await finalizeInvoice(w.tenantId, charge.invoiceId, w.actor);
const dmgInvoice = await db.invoice.findUniqueOrThrow({ where: { id: charge.invoiceId } });
const dmgPdf = await ensureInvoiceDocument(w.tenantId, dmgVersion.id, w.actor.id);
const dmgFinal = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${charge.invoiceId}&abgeschlossen=1`, { headers: { cookie } }));
report(dmgFinal.includes(`Schadenabrechnung ${dmgInvoice.number}`) && dmgFinal.includes("Finalisiert") && dmgFinal.includes("Zahlungen zur Schadenabrechnung") && dmgFinal.includes(`Schadenabrechnung ${dmgInvoice.number}`) && dmgFinal.includes("Herunterladen"), "Schadenabrechnung: finalisiert, Zahlungen und PDF je Rechnung");
report(dmgPdf.document.fileName.includes(dmgInvoice.number ?? "?"), `PDF ${dmgPdf.document.fileName}`);
const casePage2 = await plain(await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie } }));
report(casePage2.includes(`Schadenabrechnung ${dmgInvoice.number}`) && casePage2.includes("Fassung 1") && casePage2.includes("Offen") && casePage2.includes("350,00") && !casePage2.includes("Schaden dem Kunden berechnen") && casePage2.includes("Die Kundenbelastung ist festgelegt"), "Schadenakte: Rechnung, Fassung, Zahlungsstatus, Belastung einmalig");
const invListDmg = await plain(await fetch(base + "/rechnungen?filter=alle&art=schaden", { headers: { cookie } }));
const invListRent = await plain(await fetch(base + "/rechnungen?filter=alle&art=miete", { headers: { cookie } }));
report(invListDmg.includes(dmgInvoice.number!) && invListDmg.includes(dc.caseNumber) && !invListDmg.includes(finalInvoice.number!) && invListRent.includes(finalInvoice.number!) && !invListRent.includes(dmgInvoice.number!), "Rechnungsliste: Filter Mietrechnung / Schadensrechnung");
const bookingDmg = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(bookingDmg.includes("Schadenabrechnung") && bookingDmg.includes(dc.caseNumber) && bookingDmg.includes("Schäden dieser Vermietung") && bookingDmg.includes("Rechnung " + finalInvoice.number), "Buchung: Mietrechnung und Schadenabrechnung getrennt, Schäden-Karte");
const vehicleDmg = await plain(await fetch(`${base}/fahrzeuge/${v4.id}`, { headers: { cookie } }));
report(vehicleDmg.includes(dc.caseNumber) && vehicleDmg.includes("Kunde verantwortlich (bestätigt)"), "Fahrzeugakte: Schaden mit Aktenbezug und Haftungsstand");
const todayDmg = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(todayDmg.includes("Offene Schadenakten") && todayDmg.includes("Wegen Schaden gesperrt") && todayDmg.includes("Haftung ungeklärt") && todayDmg.includes("In Reparatur"), "Dashboard: Schaden-Kennzahlen");
const hofOnly = await reportDamage(w.tenantId, w.actor, { vehicleId: v3.id, view: "FRONT", posX: 0.2, posY: 0.4, kind: "CHIP", description: "Steinschlag ohne Miete" });
const { damageCase: dcHof } = await openDamageCase(w.tenantId, hofOnly.id, w.actor);
const hofCase = await plain(await fetch(`${base}/schaeden/${dcHof.id}`, { headers: { cookie } }));
report(hofCase.includes("keiner Vermietung zugeordnet") && !hofCase.includes("Schaden dem Kunden berechnen"), "Schadenakte ohne Vermietung: keine Kundenbelastung möglich");

// Audit: Rollen. Hofmitarbeiter dürfen Buchungen weder anlegen noch stornieren, Übergabe und Rückgabe aber durchführen.
const yard = await db.user.create({ data: { tenantId: w.tenantId, email: `yard-${Date.now()}@example.test`, name: "Hof", passwordHash: "x", role: "YARD" } });
const yardSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: yardSession, userId: yard.id, expiresAt: new Date(Date.now() + 3600_000) } });
const yardNew = await fetch(base + "/buchungen/neu", { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardNew.status === 307 && (yardNew.headers.get("location") ?? "").includes("fehler=rechte"), `${yardNew.status} Hofmitarbeiter: keine neue Buchung`);
const yardPickup = await fetch(`${base}/buchungen/${doneBooking.id}/uebergabe`, { headers: { cookie: `rb_session=${yardSession}` } });
report(yardPickup.status === 200, `${yardPickup.status} Hofmitarbeiter: Übergabe erlaubt`);
const yardBooking = await (await fetch(`${base}/buchungen/${w.bookingId}`, { headers: { cookie: `rb_session=${yardSession}` } })).text();
report(!yardBooking.includes(">Stornieren<"), "Hofmitarbeiter: kein Storno-Knopf");
const yardSettings = await fetch(base + "/einstellungen", { headers: { cookie: `rb_session=${yardSession}` } });
report(yardSettings.status === 200, `${yardSettings.status} Einstellungen lesbar (Aktionen nur Inhaber)`);

// Hofmitarbeiter: Vertragsentwurf gesperrt, abgeschlossener Vertrag einsehbar, Übergabe und Rückgabe erlaubt, Dokumente und E-Mail-Bereich sichtbar
const yardDraft = await fetch(`${base}/buchungen/${w.bookingId}/vertrag`, { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardDraft.status === 307 && decodeURIComponent(yardDraft.headers.get("location") ?? "").includes("nur Inhaber und Disponenten"), `${yardDraft.status} Hofmitarbeiter: Vertragsentwurf nicht bearbeitbar`);
const yardSigned = await fetch(`${base}/buchungen/${doneBooking.id}/vertrag`, { headers: { cookie: `rb_session=${yardSession}` } });
report(yardSigned.status === 200 && (await yardSigned.text()).includes("Prüfsumme"), `${yardSigned.status} Hofmitarbeiter: abgeschlossenen Vertrag ansehen`);
const yardReturn = await fetch(`${base}/buchungen/${retBooking.id}/rueckgabe`, { headers: { cookie: `rb_session=${yardSession}` } });
const yardReturnHtml = await yardReturn.text();
report(yardReturn.status === 200 && yardReturnHtml.includes("Herunterladen") && /Unterlagen (jetzt|erneut) senden|E-Mail erneut senden/.test(yardReturnHtml), `${yardReturn.status} Hofmitarbeiter: Rückgabeprotokoll, Dokumente und E-Mail erneut senden`);
const yardDoc = await fetch(`${base}/api/documents/${returnPdf.document.id}?download=1`, { headers: { cookie: `rb_session=${yardSession}` } });
report(yardDoc.status === 200, `${yardDoc.status} Hofmitarbeiter: Dokument herunterladen`);
const yardInvoice = await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie: `rb_session=${yardSession}` } });
const yardInvoiceHtml = await yardInvoice.text();
report(yardInvoice.status === 200 && yardInvoiceHtml.includes("Herunterladen") && yardInvoiceHtml.includes("Fassungsverlauf") && !yardInvoiceHtml.includes("Rechnung bearbeiten") && !yardInvoiceHtml.includes("Als an Kunden übergeben markieren") && yardInvoiceHtml.includes("Der Versand der Rechnung erfolgt durch die Disposition") && !yardInvoiceHtml.includes("Interne Notiz"), `${yardInvoice.status} Hofmitarbeiter: Fassungen ansehen, kein Bearbeiten, keine Übergabemarkierung, kein Versand, keine interne Notiz`);
const yardInvoiceDoc = await fetch(`${base}/api/documents/${invoicePdf.document.id}?download=1`, { headers: { cookie: `rb_session=${yardSession}` } });
report(yardInvoiceDoc.status === 200, `${yardInvoiceDoc.status} Hofmitarbeiter: Rechnungs-PDF herunterladen`);
const yardNoInvoice = await fetch(`${base}/buchungen/${doneBooking.id}/rechnung`, { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardNoInvoice.status === 307, `${yardNoInvoice.status} Hofmitarbeiter: keine Rechnungsanlage`);
const yardRetBooking = await (await fetch(`${base}/buchungen/${old.id}`, { headers: { cookie: `rb_session=${yardSession}` } })).text();
report(!yardRetBooking.includes("Rechnung erstellen"), "Hofmitarbeiter: kein Knopf „Rechnung erstellen“");
const yardFin = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardFin.includes("Teilbezahlt") && yardFin.includes("Teilweise freigegeben") && !yardFin.includes("Zahlung erfassen") && !yardFin.includes("Zahlung stornieren") && !yardFin.includes("Bewegung korrigieren") && yardFin.includes("erfasst und korrigiert die Disposition"), "Hofmitarbeiter: sieht Zahlungs- und Kautionsstatus, keine Erfassung/Storno/Korrektur");
const yardPickupDeposit = await plain(await fetch(`${base}/buchungen/${signedBooking.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardPickupDeposit.includes("Kaution als erhalten erfassen"), "Hofmitarbeiter: darf Kaution bei Übergabe als erhalten dokumentieren");
const yardList = await fetch(base + "/rechnungen", { headers: { cookie: `rb_session=${yardSession}` } });
report(yardList.status === 200, `${yardList.status} Hofmitarbeiter: Rechnungsliste lesbar`);
const yardCase = await plain(await fetch(`${base}/schaeden/${dcHof.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardCase.includes("Notiz speichern") && yardCase.includes("Foto aufnehmen") && yardCase.includes("Dokument hochladen") && !yardCase.includes("Haftung festlegen") && !yardCase.includes("Kosten speichern") && !yardCase.includes("Fahrzeug wegen Schaden sperren") && !yardCase.includes("Schadenakte schließen") && !yardCase.includes("Schaden dem Kunden berechnen") && yardCase.includes("entscheidet die Disposition"), "Hofmitarbeiter: Schadenakte sehen, Notiz/Foto/Dokument, keine Haftung/Kosten/Sperre/Abschluss/Belastung");
const yardCaseUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "f.jpg"); return fetch(`${base}/api/damage-cases/${dcHof.id}/photos`, { method: "POST", body: fd, headers: { cookie: `rb_session=${yardSession}` } }); })();
report(yardCaseUp.status === 201, `${yardCaseUp.status} Hofmitarbeiter: Foto an Schadenakte`);
const yardCases = await fetch(base + "/schaeden", { headers: { cookie: `rb_session=${yardSession}` } });
report(yardCases.status === 200, `${yardCases.status} Hofmitarbeiter: Schadenliste lesbar`);
const yardDmgInvoice = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${charge.invoiceId}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardDmgInvoice.includes(`Schadenabrechnung ${dmgInvoice.number}`) && !yardDmgInvoice.includes("Rechnung bearbeiten"), "Hofmitarbeiter: Schadenabrechnung ansehen, nicht bearbeiten");
const yardUpload = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "f.jpg"); fd.set("category", "OTHER"); return fetch(`${base}/api/handovers/${pickup.id}/photos`, { method: "POST", body: fd, headers: { cookie: `rb_session=${yardSession}` } }); })();
report(yardUpload.status === 201, `${yardUpload.status} Hofmitarbeiter: Foto im Übergabe-Entwurf hochladen`);
const yardBookingNoStart = await (await fetch(`${base}/buchungen/${old.id}`, { headers: { cookie: `rb_session=${yardSession}` } })).text();
report(!yardBookingNoStart.includes("Mietvertrag erstellen") && !yardBookingNoStart.includes("Mietvertrag fortsetzen"), "Hofmitarbeiter: keine Vertragsknöpfe");
// Disponent: Vertrag bearbeiten, Buchung anlegen, keine Einstellungen
const dispo = await db.user.create({ data: { tenantId: w.tenantId, email: `dispo-${Date.now()}@example.test`, name: "Dispo", passwordHash: "x", role: "DISPO" } });
const dispoSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: dispoSession, userId: dispo.id, expiresAt: new Date(Date.now() + 3600_000) } });
const dispoDraft = await fetch(`${base}/buchungen/${w.bookingId}/vertrag?schritt=4`, { headers: { cookie: `rb_session=${dispoSession}` } });
report(dispoDraft.status === 200 && (await dispoDraft.text()).includes("Konditionen"), `${dispoDraft.status} Disponent: Vertragsentwurf bearbeiten`);
const dispoNew = await fetch(base + "/buchungen/neu", { headers: { cookie: `rb_session=${dispoSession}` } });
report(dispoNew.status === 200, `${dispoNew.status} Disponent: neue Buchung`);
// Inhaber (Testsitzung ist OWNER): Vertragsentwurf und Einstellungen
const ownerDraft = await fetch(`${base}/buchungen/${w.bookingId}/vertrag?schritt=7`, { headers: { cookie } });
report(ownerDraft.status === 200 && (await ownerDraft.text()).includes("Mietvertrag verbindlich abschließen"), `${ownerDraft.status} Inhaber: Vertrag abschließen sichtbar`);

const anon = await fetch(base + "/heute", { redirect: "manual" });
report(anon.status === 307 && (anon.headers.get("location") ?? "").includes("/login"), `${anon.status} /heute ohne Sitzung leitet zum Login`);
// Abgelaufene Sitzung: keine Endlosschleife zwischen Startseite und Login, das alte Cookie wird entfernt
const stale = { cookie: "rb_session=gibt-es-nicht-mehr" };
const staleHome = await fetch(base + "/heute", { headers: stale, redirect: "manual" });
const staleLogin = await fetch(base + "/login?abgelaufen=1", { headers: stale, redirect: "manual" });
report(staleHome.status === 307 && (staleHome.headers.get("location") ?? "").includes("/login?abgelaufen=1") && staleLogin.status === 200 && (staleLogin.headers.get("set-cookie") ?? "").includes("rb_session=;"), `${staleHome.status}/${staleLogin.status} abgelaufene Sitzung landet sauber beim Login`);

if (keep) {
  console.log(`\nTestdaten bleiben stehen.\nSITZUNG=${sessionId}\nBUCHUNG=${w.bookingId}\nRUECKGABE_ENTWURF=${doneBooking.id}\nRUECKGABE_FERTIG=${retBooking.id}\nRET_DAMAGE=${retDamage.id} UEBERGEBEN=${doneBooking.id} BEREIT=${signedBooking.id}\nVERTRAG=${draft.number}\nMANDANTEN=${w.tenantId},${foreign.tenantId}`);
} else {
  await purgeTenants([w.tenantId, foreign.tenantId]);
}
await db.$disconnect();
console.log(failed === 0 ? "\nAlle Seiten in Ordnung." : `\n${failed} Prüfung(en) fehlgeschlagen.`);
process.exit(failed === 0 ? 0 : 1);

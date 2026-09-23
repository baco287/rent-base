// Mietbedingungen, Geschäftsregeln und Vertragsversionierung (Phase 15) gegen die lokale Entwicklungsdatenbank:
// Fassungen (Entwurf → veröffentlicht → unveränderlich → neue Fassung → archiviert), Vertragsbindung (Auswahl, Kenntnis-
// nahme, Signaturbindung, keine stille Übernahme, PDF nach Änderungen identisch), Geschäftsregeln (Prioritätskette,
// Hinweis statt stiller Änderung, Fahreralter, Zusatzfahrerpreis), Wettläufe, Mandantentrennung, keine Nebenwirkungen.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { changeBookingStatus } from "../src/lib/booking-status";
import { acknowledgeTerms, addAdditionalDriver, adoptContractDefaults, adoptTermsVersion, ensureContractDraft, finalizeContract, getContractContentHash, getContractState, saveConditions, saveContractSignature, verifyContract, type ConditionsInput, type DriverInput } from "../src/lib/contracts";
import { buildContractDocument } from "../src/lib/contract-view";
import { loadContractDocumentData } from "../src/lib/document-data";
import { renderContractPdf } from "../src/lib/pdf/contract-pdf";
import { DomainError, isImmutableError, sha256 } from "../src/lib/integrity";
import { activeTermsVersion, archiveTermsVersion, createNextVersion, createTermsDraft, discardTermsDraft, publishTermsVersion, termsFeatureActive, termsOverview, updateTermsDraft } from "../src/lib/rental-terms";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";

const tenants: string[] = [];
async function world(label: string, opts?: Parameters<typeof createWorld>[1]): Promise<World> {
  const w = await createWorld(label, opts);
  tenants.push(w.tenantId);
  return w;
}
after(async () => { await purgeTenants(tenants); await db.$disconnect(); });

const TEXT = "# Allgemeine Mietbedingungen\n\n## 1. Geltungsbereich\nDiese Bedingungen gelten für alle Mietverträge. Sie sind **Beispieltext** für den Test.\n\n## 2. Fahrer\n- Nur eingetragene Fahrer\n- Gültige Fahrerlaubnis";
async function publish(w: World, content = TEXT, label?: string) {
  const d = await createTermsDraft(w.tenantId, w.actor, { content, label });
  return publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true });
}
const sign = async (w: World, contractId: string, role: "RENTER" | "EMPLOYEE" = "RENTER") => saveContractSignature(w.tenantId, w.actor, contractId, { role, signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, contractId) });
const codes = async (w: World, id: string) => (await getContractState(w.tenantId, id)).issues.map((i) => `${i.severity}:${i.code}`);
const baseConditions = (c: { startAt: Date; endAt: Date; deposit: unknown; kmIncludedPerDay: number; extraKmRate: unknown; deductible: unknown }): ConditionsInput => ({ startAt: c.startAt, endAt: c.endAt, deposit: Number(c.deposit), kmIncludedPerDay: c.kmIncludedPerDay, extraKmRate: Number(c.extraKmRate), deductible: Number(c.deductible), fuelPolicy: "FULL_TO_FULL", pickupLocation: "Hof" });
const driver = (over: Partial<DriverInput> = {}): DriverInput => ({ firstName: "Max", lastName: "Zusatz", birthDate: new Date("1990-05-01"), street: "Hafen 3", zip: "28217", city: "Bremen", country: "DE", licenseNumber: "Z1", licenseClass: "B", licenseIssuedAt: new Date("2010-06-01"), licenseValidUntil: new Date("2033-06-01"), licenseCountry: "DE", ...over });

async function financialSnapshot(tenantId: string) {
  const [i, iv, p, e, d, dc, ac] = await Promise.all([db.invoice.count({ where: { tenantId } }), db.invoiceVersion.count({ where: { tenantId } }), db.payment.count({ where: { tenantId } }), db.extraCharge.count({ where: { tenantId } }), db.securityDepositEvent.count({ where: { tenantId } }), db.damageCase.count({ where: { tenantId, customerChargeCents: { not: null } } }), db.authorityCase.count({ where: { tenantId } })]);
  return JSON.stringify({ i, iv, p, e, d, dc, ac });
}

// ---------------------------------------------------------------------------
// Fassungen
// ---------------------------------------------------------------------------

test("Fassungen: Entwurf, Bearbeiten, Veröffentlichen nur mit Bestätigung, danach unveränderlich (App und DB), neue Fassung als Kopie, Archivieren, kein Löschen", async () => {
  const w = await world("terms-life");
  assert.equal(await termsFeatureActive(db, w.tenantId), false);
  const d = await createTermsDraft(w.tenantId, w.actor, {});
  assert.equal(d.label, "1.0");
  assert.equal(d.versionNumber, 1);
  assert.equal(d.status, "DRAFT");
  assert.match(d.content, /Mustertext – vor Verwendung rechtlich prüfen/);
  await assert.rejects(() => createTermsDraft(w.tenantId, w.actor, {}), /bereits einen Entwurf/);
  await assert.rejects(() => publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true }), /Vorlagenhinweis/);
  await updateTermsDraft(w.tenantId, d.id, w.actor, { title: "AGB", content: "# Nur Überschriften\n\n## Ohne Inhalt\n\n### Auch hier nichts\n" });
  await assert.rejects(() => publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true }), /nur Überschriften/);
  await assert.rejects(() => updateTermsDraft(w.tenantId, d.id, w.actor, { title: "AGB", content: "<b>html</b> ist hier nicht erlaubt, auch nicht als Test" }), /HTML/);
  const edited = await updateTermsDraft(w.tenantId, d.id, w.actor, { title: "Allgemeine Mietbedingungen", content: TEXT, changeNote: "Erstfassung" });
  assert.equal(edited.checksum, null);
  await assert.rejects(() => publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: false }), /ausdrücklich bestätigen/);
  const p = await publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true });
  assert.equal(p.status, "PUBLISHED");
  assert.equal(p.checksum, sha256(TEXT));
  assert.ok(p.publishedAt && p.publishedById === w.userId);
  assert.equal(await termsFeatureActive(db, w.tenantId), true);
  assert.equal((await activeTermsVersion(db, w.tenantId))?.id, p.id);
  assert.equal((await publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true })).publishedAt?.getTime(), p.publishedAt!.getTime(), "Doppelklick ändert nichts");
  // unveränderlich – Anwendung und Datenbank, auch für den Inhaber
  await assert.rejects(() => updateTermsDraft(w.tenantId, p.id, w.actor, { title: "Geänderter Titel", content: TEXT + "\nNachtrag" }), /veröffentlicht und kann nicht mehr geändert werden/);
  await assert.rejects(() => db.rentalTermsVersion.update({ where: { id: p.id }, data: { content: "geändert" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.rentalTermsVersion.update({ where: { id: p.id }, data: { checksum: "0".repeat(64) } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.rentalTermsVersion.update({ where: { id: p.id }, data: { label: "9.9" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.rentalTermsVersion.delete({ where: { id: p.id } }), (e) => isImmutableError(e));
  // neue Fassung: Kopie als Entwurf, Quelle unverändert, nur ein offener Entwurf
  const n = await createNextVersion(w.tenantId, p.id, w.actor);
  assert.equal(n.label, "1.1");
  assert.equal(n.versionNumber, 2);
  assert.equal(n.content, TEXT);
  assert.equal(n.sourceVersionId, p.id);
  await assert.rejects(() => createNextVersion(w.tenantId, p.id, w.actor), /bereits einen Entwurf/);
  assert.equal((await db.rentalTermsVersion.findUniqueOrThrow({ where: { id: p.id } })).content, TEXT);
  await updateTermsDraft(w.tenantId, n.id, w.actor, { title: "Allgemeine Mietbedingungen", content: TEXT + "\n## 3. Neu\nEin neuer Abschnitt.\n" });
  await assert.rejects(() => db.rentalTermsVersion.update({ where: { id: n.id }, data: { status: "ARCHIVED", archivedAt: new Date() } }), /nicht archiviert, sondern verworfen|RB_DOMAIN/);
  const p2 = await publishTermsVersion(w.tenantId, n.id, w.actor, { confirmed: true });
  assert.equal((await activeTermsVersion(db, w.tenantId))?.id, p2.id, "höchste veröffentlichte Fassung ist aktiv");
  // archivieren: unveränderlich, kein Löschen, alte bleibt für Verträge
  const a = await archiveTermsVersion(w.tenantId, p.id, w.actor, "ersetzt durch 1.1");
  assert.equal(a.status, "ARCHIVED");
  await assert.rejects(() => db.rentalTermsVersion.update({ where: { id: p.id }, data: { content: "x" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.rentalTermsVersion.update({ where: { id: p.id }, data: { status: "PUBLISHED" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.rentalTermsVersion.delete({ where: { id: p.id } }), (e) => isImmutableError(e));
  // Entwurf verwerfen ist die einzige Löschung; Versionsnummern werden nie wiederverwendet
  const d3 = await createNextVersion(w.tenantId, p2.id, w.actor);
  assert.equal(d3.versionNumber, 3);
  await assert.rejects(() => archiveTermsVersion(w.tenantId, d3.id, w.actor), /Nur veröffentlichte/);
  await discardTermsDraft(w.tenantId, d3.id, w.actor);
  const d4 = await createNextVersion(w.tenantId, p2.id, w.actor, { label: "2.0" });
  assert.equal(d4.versionNumber, 4, "Nummer 3 bleibt verbraucht");
  await assert.rejects(() => createNextVersion(w.tenantId, p2.id, w.actor, { label: "1.0" }), /bereits/);
  const o = await termsOverview(w.tenantId);
  assert.deepEqual(o.versions.map((v) => `${v.label}:${v.status}${v.isActive ? ":aktiv" : ""}`), ["2.0:DRAFT", "1.1:PUBLISHED:aktiv", "1.0:ARCHIVED"]);
  assert.deepEqual((await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { startsWith: "RENTAL_TERMS_" } }, orderBy: { createdAt: "asc" } })).map((x) => x.action), ["RENTAL_TERMS_DRAFT_CREATED", "RENTAL_TERMS_UPDATED", "RENTAL_TERMS_UPDATED", "RENTAL_TERMS_PUBLISHED", "RENTAL_TERMS_NEW_VERSION_CREATED", "RENTAL_TERMS_UPDATED", "RENTAL_TERMS_PUBLISHED", "RENTAL_TERMS_ARCHIVED", "RENTAL_TERMS_NEW_VERSION_CREATED", "RENTAL_TERMS_DRAFT_DISCARDED", "RENTAL_TERMS_NEW_VERSION_CREATED"]);
});

test("Gültigkeit: eine Fassung mit späterem Gültigkeitsbeginn ist veröffentlicht, aber noch nicht aktiv; Übernahme in einen Vertrag wird abgelehnt", async () => {
  const w = await world("terms-effective");
  const p1 = await publish(w);
  const d = await createNextVersion(w.tenantId, p1.id, w.actor);
  await updateTermsDraft(w.tenantId, d.id, w.actor, { title: "AGB", content: TEXT + "\nNeu.\n", effectiveFrom: new Date(Date.now() + 10 * 86_400_000) });
  const p2 = await publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true });
  assert.equal((await activeTermsVersion(db, w.tenantId))?.id, p1.id);
  assert.equal((await activeTermsVersion(db, w.tenantId, new Date(Date.now() + 11 * 86_400_000)))?.id, p2.id);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(c.rentalTermsVersionId, p1.id);
  await assert.rejects(() => adoptTermsVersion(w.tenantId, c.id, w.actor, p2.id), /später/);
  assert.equal((await termsOverview(w.tenantId)).scheduled.length, 1);
});

test("Wettläufe: parallele Veröffentlichung, parallele neue Fassungen und Entwürfe, eindeutige Versionsnummern", async () => {
  const w = await world("terms-race");
  const d = await createTermsDraft(w.tenantId, w.actor, { content: TEXT });
  const pubs = await Promise.all([1, 2, 3].map(() => publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true })));
  assert.equal(new Set(pubs.map((p) => p.publishedAt?.getTime())).size, 1, "genau eine Veröffentlichung");
  const next = await Promise.allSettled([1, 2, 3].map(() => createNextVersion(w.tenantId, d.id, w.actor)));
  assert.equal(next.filter((r) => r.status === "fulfilled").length, 1, "nur eine neue Fassung entsteht");
  for (const r of next) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError, String(r.reason));
  await discardTermsDraft(w.tenantId, (next.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value.id, w.actor);
  const drafts = await Promise.allSettled([1, 2, 3].map(() => createTermsDraft(w.tenantId, w.actor, { content: TEXT })));
  assert.equal(drafts.filter((r) => r.status === "fulfilled").length, 1);
  const numbers = (await db.rentalTermsVersion.findMany({ where: { tenantId: w.tenantId }, select: { versionNumber: true } })).map((v) => v.versionNumber);
  assert.equal(new Set(numbers).size, numbers.length);
});

test("Mandantentrennung: fremde Fassungen sind unsichtbar, nicht veröffentlichbar, nicht archivierbar, nicht einem Vertrag zuordenbar", async () => {
  const a = await world("terms-tenant-a");
  const b = await world("terms-tenant-b");
  const pa = await publish(a);
  await assert.rejects(() => publishTermsVersion(b.tenantId, pa.id, b.actor, { confirmed: true }), /nicht gefunden/);
  await assert.rejects(() => archiveTermsVersion(b.tenantId, pa.id, b.actor), /nicht gefunden/);
  await assert.rejects(() => createNextVersion(b.tenantId, pa.id, b.actor), /nicht gefunden/);
  assert.equal(await termsFeatureActive(db, b.tenantId), false);
  const cb = await ensureContractDraft(b.tenantId, b.bookingId, b.actor);
  assert.equal(cb.rentalTermsVersionId, null, "Mandant B bleibt im Altbestand");
  await assert.rejects(() => adoptTermsVersion(b.tenantId, cb.id, b.actor, pa.id), /nicht gefunden|keine veröffentlichte/);
  await assert.rejects(() => db.rentalContract.update({ where: { id: cb.id }, data: { rentalTermsVersionId: pa.id, termsHash: pa.checksum } }), /RB_TENANT/);
});

// ---------------------------------------------------------------------------
// Vertrag: Auswahl, Kenntnisnahme, Signaturbindung, keine stille Übernahme, Unveränderlichkeit
// ---------------------------------------------------------------------------

test("Vertrag: neuer Entwurf friert die aktive Fassung ein; ohne Kenntnisnahme keine Mieterunterschrift und kein Abschluss; Kenntnisnahme dokumentiert Zeitpunkt, Person, Fassung", async () => {
  const w = await world("terms-contract");
  const p = await publish(w);
  const before = await financialSnapshot(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(c.rentalTermsVersionId, p.id);
  assert.equal(c.termsVersion, "1.0");
  assert.equal(c.termsText, TEXT);
  assert.equal(c.termsHash, p.checksum);
  assert.equal(c.termsFormat, "MARKDOWN");
  assert.equal(c.termsAcknowledgedAt, null);
  assert.ok((await codes(w, c.id)).includes("error:TERMS_ACK_MISSING"));
  await assert.rejects(() => sign(w, c.id), /Kenntnisnahme/);
  await sign(w, c.id, "EMPLOYEE"); // Mitarbeiterunterschrift braucht keine Kenntnisnahme
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /Kenntnisnahme|Unterschrift des Mieters/);
  await assert.rejects(() => acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: false }), /ausdrücklich/);
  const ack = await acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: true });
  assert.ok(ack.termsAcknowledgedAt);
  assert.equal(ack.termsAcknowledgedByName, w.actor.name);
  assert.equal(ack.termsAcknowledgedHash, `${p.id}:${p.checksum}`);
  assert.ok(!(await codes(w, c.id)).includes("error:TERMS_ACK_MISSING"));
  const state = await getContractState(w.tenantId, c.id);
  assert.equal(state.terms.acknowledged, true);
  assert.equal(state.terms.selected?.label, "1.0");
  assert.equal(state.terms.newerAvailable, false);
  await sign(w, c.id);
  const signed = await finalizeContract(w.tenantId, c.id);
  assert.equal(signed.status, "SIGNED");
  assert.equal(signed.rentalTermsVersionId, p.id);
  const doc = buildContractDocument({ ...signed, drivers: state.contract.drivers }, await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } }), []);
  assert.equal(doc.terms.title, "Allgemeine Mietbedingungen – Version 1.0");
  assert.equal(doc.terms.legacy, false);
  assert.ok(doc.terms.blocks && doc.terms.blocks.length >= 4);
  assert.ok(doc.rules && doc.rules.rows.some((r) => r.label === "Auslandsfahrten" && r.value === "Nicht gestattet"));
  const audit = (await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { startsWith: "CONTRACT_TERMS_" } }, orderBy: { createdAt: "asc" } })).map((x) => x.action);
  assert.deepEqual(audit, ["CONTRACT_TERMS_SELECTED", "CONTRACT_TERMS_ACKNOWLEDGED"]);
  assert.equal(await financialSnapshot(w.tenantId), before, "keine finanzielle Nebenwirkung");
});

test("Signaturbindung und keine stille Übernahme: Unterschrift hängt an Fassung und Prüfsumme; neuere Fassung ändert den Entwurf nicht; bewusster Wechsel setzt Kenntnisnahme und Unterschrift zurück", async () => {
  const w = await world("terms-switch");
  const p1 = await publish(w);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: true });
  const hashBefore = await getContractContentHash(w.tenantId, c.id);
  await sign(w, c.id);
  // neue Fassung veröffentlichen: der Entwurf bleibt auf 1.0
  const d = await createNextVersion(w.tenantId, p1.id, w.actor);
  await updateTermsDraft(w.tenantId, d.id, w.actor, { title: "AGB", content: TEXT + "\n## 3. Geändert\nNeuer Absatz.\n" });
  const p2 = await publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true });
  const s1 = await getContractState(w.tenantId, c.id);
  assert.equal(s1.contract.rentalTermsVersionId, p1.id, "kein stiller Wechsel");
  assert.equal(s1.contract.termsText, TEXT);
  assert.equal(s1.hash, hashBefore, "Inhalt und damit die Unterschrift bleiben gültig");
  assert.equal(s1.signatures.length, 1);
  assert.equal(s1.terms.newerAvailable, true);
  assert.ok(s1.issues.some((i) => i.code === "TERMS_NEWER" && i.severity === "warning"));
  // direkter Austausch des Textes ohne passende Prüfsumme wird von der Datenbank abgelehnt
  await assert.rejects(() => db.rentalContract.update({ where: { id: c.id }, data: { rentalTermsVersionId: p2.id } }), /RB_DOMAIN/);
  // bewusster Wechsel
  const switched = await adoptTermsVersion(w.tenantId, c.id, w.actor, null);
  assert.equal(switched.rentalTermsVersionId, p2.id);
  assert.equal(switched.termsHash, p2.checksum);
  assert.equal(switched.termsAcknowledgedAt, null, "Kenntnisnahme zurückgesetzt");
  const s2 = await getContractState(w.tenantId, c.id);
  assert.notEqual(s2.hash, hashBefore, "Fassung und Prüfsumme sind Teil des unterschriebenen Inhalts");
  assert.equal(s2.signatures.length, 0, "Unterschrift verworfen");
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /Kenntnisnahme|Unterschrift/);
  await acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: true });
  await sign(w, c.id);
  const signed = await finalizeContract(w.tenantId, c.id);
  assert.equal(signed.rentalTermsVersionId, p2.id);
  // Datenbank: Abschluss ohne Kenntnisnahme ist auch direkt unmöglich
  const w2 = await world("terms-switch-db");
  const px = await publish(w2);
  const cx = await ensureContractDraft(w2.tenantId, w2.bookingId, w2.actor);
  await assert.rejects(() => db.rentalContract.update({ where: { id: cx.id }, data: { status: "SIGNED", signedAt: new Date(), contentHash: "0".repeat(64) } }), /Kenntnisnahme/);
  await assert.rejects(() => db.rentalContract.update({ where: { id: cx.id }, data: { rentalTermsVersionId: null, termsHash: null, termsText: null, status: "SIGNED", signedAt: new Date(), contentHash: "0".repeat(64) } }), /braucht eine veröffentlichte/);
  void px;
});

test("Historie: abgeschlossener Vertrag behält Fassung, Text und PDF nach neuer Fassung und Archivierung; Storno behält die Fassung; kein nachträgliches Umhängen", async () => {
  const w = await world("terms-history");
  const p1 = await publish(w);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: true });
  await sign(w, c.id);
  const signed = await finalizeContract(w.tenantId, c.id);
  const before = await loadContractDocumentData(w.tenantId, c.id);
  const pdfBefore = await renderContractPdf(before.doc, before.signatureImages);
  assert.ok(pdfBefore.trace.texts.some((t) => t.includes("Mietbedingungen: Version 1.0")));
  assert.ok(pdfBefore.trace.texts.some((t) => t.includes("Diese Bedingungen gelten für alle Mietverträge")));
  assert.ok(pdfBefore.trace.texts.some((t) => t === "Nur eingetragene Fahrer"), "Listenpunkte werden gesetzt");
  assert.equal(pdfBefore.trace.boxes.filter((b) => b.overflow).length, 0);
  // neue Fassung, alte archivieren
  const d = await createNextVersion(w.tenantId, p1.id, w.actor);
  await updateTermsDraft(w.tenantId, d.id, w.actor, { title: "AGB", content: "# Ganz neu\n\nVöllig anderer Text mit neuen Klauseln.\n" });
  await publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true });
  await archiveTermsVersion(w.tenantId, p1.id, w.actor);
  const after = await loadContractDocumentData(w.tenantId, c.id);
  assert.deepEqual(after.doc, before.doc, "Dokumentdaten identisch");
  const pdfAfter = await renderContractPdf(after.doc, after.signatureImages);
  assert.deepEqual(pdfAfter.trace.texts, pdfBefore.trace.texts, "PDF-Inhalt identisch");
  assert.ok(!pdfAfter.trace.texts.some((t) => t.includes("Völlig anderer Text")));
  const row = await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(row.rentalTermsVersionId, p1.id);
  assert.equal(row.termsText, TEXT);
  assert.equal((await verifyContract(w.tenantId, c.id)).intact, true);
  await assert.rejects(() => db.rentalContract.update({ where: { id: c.id }, data: { termsText: "x" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.rentalContract.update({ where: { id: c.id }, data: { individualAgreements: "nachträglich" } }), (e) => isImmutableError(e));
  await assert.rejects(() => adoptTermsVersion(w.tenantId, c.id, w.actor, null), (e) => isImmutableError(e) || e instanceof DomainError);
  // Verwendung sichtbar; archivierte Fassung lässt sich nicht löschen, solange Verträge sie nutzen
  assert.equal((await termsOverview(w.tenantId)).versions.find((v) => v.id === p1.id)?.usedInContracts, 1);
  await assert.rejects(() => db.rentalTermsVersion.delete({ where: { id: p1.id } }));
  // Storno: Fassung und Text bleiben
  await changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED");
  const cancelled = await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.rentalTermsVersionId, p1.id);
  assert.equal(cancelled.termsHash, signed.termsHash);
  assert.equal(cancelled.contentHash, signed.contentHash);
});

test("Archivieren während eines Entwurfs: Abschluss mit archivierter Fassung wird abgelehnt (App und DB), nach bewusstem Wechsel möglich", async () => {
  const w = await world("terms-archived");
  const p1 = await publish(w);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: true });
  await sign(w, c.id);
  const d = await createNextVersion(w.tenantId, p1.id, w.actor);
  await updateTermsDraft(w.tenantId, d.id, w.actor, { title: "AGB", content: TEXT + "\nErgänzung.\n" });
  const p2 = await publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true });
  await archiveTermsVersion(w.tenantId, p1.id, w.actor);
  assert.ok((await codes(w, c.id)).includes("error:TERMS_ARCHIVED"));
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /archiviert/);
  await assert.rejects(() => acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: true }), /nicht mehr gültig/);
  await adoptTermsVersion(w.tenantId, c.id, w.actor, null);
  await acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: true });
  await sign(w, c.id);
  assert.equal((await finalizeContract(w.tenantId, c.id)).rentalTermsVersionId, p2.id);
  // Wettlauf Archivieren + Abschluss: der Vertrag ist am Ende entweder abgeschlossen mit gültiger Fassung oder nicht abgeschlossen
  const w2 = await world("terms-archive-race");
  const q1 = await publish(w2);
  const c2 = await ensureContractDraft(w2.tenantId, w2.bookingId, w2.actor);
  await acknowledgeTerms(w2.tenantId, c2.id, w2.actor, { confirmed: true });
  await sign(w2, c2.id);
  const q2d = await createNextVersion(w2.tenantId, q1.id, w2.actor);
  await updateTermsDraft(w2.tenantId, q2d.id, w2.actor, { title: "AGB", content: TEXT + "\nB.\n" });
  await publishTermsVersion(w2.tenantId, q2d.id, w2.actor, { confirmed: true });
  const [arch, fin] = await Promise.allSettled([archiveTermsVersion(w2.tenantId, q1.id, w2.actor), finalizeContract(w2.tenantId, c2.id)]);
  assert.equal(arch.status, "fulfilled");
  const row = await db.rentalContract.findUniqueOrThrow({ where: { id: c2.id } });
  if (fin.status === "fulfilled") { assert.equal(row.status, "SIGNED"); assert.equal(row.termsHash, q1.checksum); assert.equal(row.rentalTermsVersionId, q1.id); }
  else assert.equal(row.status, "DRAFT");
  // Wettlauf Kenntnisnahme + Fassungswechsel: die Kenntnisnahme passt am Ende immer zur Fassung oder fehlt
  const w3 = await world("terms-ack-race");
  const r1 = await publish(w3);
  const c3 = await ensureContractDraft(w3.tenantId, w3.bookingId, w3.actor);
  const r2d = await createNextVersion(w3.tenantId, r1.id, w3.actor);
  await updateTermsDraft(w3.tenantId, r2d.id, w3.actor, { title: "AGB", content: TEXT + "\nC.\n" });
  await publishTermsVersion(w3.tenantId, r2d.id, w3.actor, { confirmed: true });
  await Promise.allSettled([acknowledgeTerms(w3.tenantId, c3.id, w3.actor, { confirmed: true }), adoptTermsVersion(w3.tenantId, c3.id, w3.actor, null)]);
  const row3 = await db.rentalContract.findUniqueOrThrow({ where: { id: c3.id } });
  assert.ok(row3.termsAcknowledgedHash === null || row3.termsAcknowledgedHash === `${row3.rentalTermsVersionId}:${row3.termsHash}`);
});

test("Altbestand: ohne veröffentlichte Fassung gilt der bisherige Mandantentext; Verträge davor bekommen keine erfundene Fassung", async () => {
  const w = await world("terms-legacy");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(c.rentalTermsVersionId, null);
  assert.equal(c.termsFormat, "PLAIN");
  assert.equal(c.termsText, "§1 Das Fahrzeug ist pfleglich zu behandeln.");
  assert.ok((await codes(w, c.id)).every((x) => !x.includes("TERMS_")));
  await sign(w, c.id);
  const signed = await finalizeContract(w.tenantId, c.id);
  assert.equal(signed.rentalTermsVersionId, null);
  // erst jetzt wird eine Fassung veröffentlicht: der Altvertrag bleibt unversioniert, Verwendung 0, Anzeige „Altbestand“
  await publish(w);
  const row = await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(row.rentalTermsVersionId, null);
  assert.equal((await termsOverview(w.tenantId)).versions[0].usedInContracts, 0);
  const doc = buildContractDocument({ ...row, drivers: [] }, await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } }), []);
  assert.equal(doc.terms.legacy, true);
  assert.equal(doc.terms.blocks, null);
  assert.equal((await verifyContract(w.tenantId, c.id)).intact, true, "Hash alter Verträge bleibt gültig");
});

// ---------------------------------------------------------------------------
// Geschäftsregeln am Vertrag
// ---------------------------------------------------------------------------

test("Geschäftsregeln: Mandant → Gruppe → Fahrzeug → Vertrag mit Herkunft; Änderungen der Vorgaben ändern Entwürfe nur auf Wunsch und abgeschlossene Verträge nie; Zusatzfahrer als eigene Position", async () => {
  const w = await world("rules-flow");
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { deductibleCents: 100000, smokingAllowed: false, abroadAllowed: true, abroadCountries: ["AT", "NL"], additionalDriverFeeType: "FLAT", additionalDriverFeeCents: 1500, petsPolicy: "NOT_ALLOWED" } } });
  await db.vehicleGroup.update({ where: { id: w.groupId }, data: { businessRules: { deductibleCents: 150000 } } });
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { businessRules: { petsPolicy: "BY_APPROVAL" } } });
  await assert.rejects(() => db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { deductibleCents: -5 } } }), /rules_valid/);
  const before = await financialSnapshot(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(Number(c.deductible), 1500);
  const s0 = await getContractState(w.tenantId, c.id);
  assert.equal(s0.rules.snapshot?.sources.deductibleCents, "GROUP");
  assert.equal(s0.rules.snapshot?.sources.petsPolicy, "VEHICLE");
  assert.equal(s0.rules.snapshot?.values.petsPolicy, "BY_APPROVAL");
  assert.equal(s0.rules.snapshot?.sources.abroadAllowed, "TENANT");
  assert.equal(s0.rules.snapshot?.sources.kmPolicy, "DEFAULT");
  assert.equal(s0.rules.newerDefaults, false);
  // Vertragsanpassung: Rauchen erlaubt, Ausland nur AT, ein Zusatzfahrer → Preisposition
  await addAdditionalDriver(w.tenantId, c.id, driver());
  await saveConditions(w.tenantId, c.id, { ...baseConditions(c), rules: { smokingAllowed: true, abroadAllowed: true, abroadCountries: ["AT"] }, individualAgreements: "Kindersitz inklusive." }, w.actor);
  const s1 = await getContractState(w.tenantId, c.id);
  assert.equal(s1.rules.snapshot?.sources.smokingAllowed, "CONTRACT");
  assert.deepEqual(s1.rules.snapshot?.values.abroadCountries, ["AT"]);
  assert.equal(s1.contract.individualAgreements, "Kindersitz inklusive.");
  const price = s1.contract.priceSnapshot as { extras?: { label: string; amount: number }[]; total: number; finalTotal: number; extrasTotal?: number };
  assert.equal(price.extras?.length, 1);
  assert.equal(price.extras?.[0].amount, 15);
  assert.equal(price.finalTotal, Math.round((price.total + 15) * 100) / 100, "Zusatzfahrer kommt als eigene Position hinzu");
  assert.equal(Number(s1.contract.totalAmount), price.finalTotal);
  assert.deepEqual(price.total, 458.1, "Kernpreislogik unverändert (Woche + Tag, 10 % Rabatt)");
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: "CONTRACT_BUSINESS_RULE_OVERRIDDEN" } });
  assert.deepEqual(audit.map((a) => (a.details as { field: string }).field).sort(), ["abroadCountries", "smokingAllowed"]);
  // Vorgaben ändern sich: Entwurf bleibt, Hinweis erscheint, Übernahme lässt individuelle Werte stehen
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { deductibleCents: 100000, smokingAllowed: false, abroadAllowed: true, abroadCountries: ["AT", "NL", "CH"], additionalDriverFeeType: "PER_DAY", additionalDriverFeeCents: 500, petsPolicy: "ALLOWED" } } });
  const s2 = await getContractState(w.tenantId, c.id);
  assert.equal(s2.rules.newerDefaults, true);
  assert.ok(s2.issues.some((i) => i.code === "RULES_NEWER" && i.severity === "warning"));
  assert.equal(s2.rules.snapshot?.values.additionalDriverFeeType, "FLAT", "nicht still geändert");
  assert.equal(Number(s2.contract.totalAmount), price.finalTotal);
  await adoptContractDefaults(w.tenantId, c.id, w.actor);
  const s3 = await getContractState(w.tenantId, c.id);
  assert.equal(s3.rules.newerDefaults, false);
  assert.equal(s3.rules.snapshot?.values.smokingAllowed, true, "individuell angepasst bleibt");
  assert.equal(s3.rules.snapshot?.values.additionalDriverFeeType, "PER_DAY");
  assert.equal(s3.rules.snapshot?.values.petsPolicy, "BY_APPROVAL", "Fahrzeugregel bleibt vor dem Mandantenstandard");
  assert.equal((s3.contract.priceSnapshot as { extras: { amount: number }[] }).extras[0].amount, 30, "1 Fahrer × 6 Tage × 5 €");
  // Abschluss friert alles ein; danach ändern Vorgaben nichts
  await sign(w, c.id);
  const signed = await finalizeContract(w.tenantId, c.id);
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { deductibleCents: 999900, smokingAllowed: false } } });
  await db.vehicleGroup.update({ where: { id: w.groupId }, data: { businessRules: Prisma.DbNull } });
  const row = await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(Number(row.deductible), 1500);
  assert.deepEqual(row.conditions, signed.conditions);
  assert.equal((await verifyContract(w.tenantId, c.id)).intact, true);
  const tenantRow = await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
  const doc = buildContractDocument({ ...row, drivers: (await getContractState(w.tenantId, c.id)).contract.drivers }, tenantRow, []);
  assert.equal(doc.price.extras.length, 1);
  assert.ok(doc.rules?.rows.some((r) => r.label === "Auslandsfahrten" && r.value === "Genehmigt für: Österreich"));
  assert.ok(doc.rules?.rows.some((r) => r.label === "Rauchen im Fahrzeug" && r.value === "Gestattet"));
  assert.ok(doc.rules?.rows.some((r) => r.label === "Zusatzfahrer" && /1 eingetragen/.test(r.value)));
  assert.equal(doc.individualAgreements, "Kindersitz inklusive.");
  assert.equal(await financialSnapshot(w.tenantId), before, "Regeländerungen erzeugen weder Rechnung, Zahlung, Zusatzkosten, Kautionsbewegung noch Forderung");
});

test("Geschäftsregeln: Grenzen und Konsistenz im Vertrag – Ausland außerhalb der Freigabe, Mindestfüllstand je Antrieb, Zusatzfahrer nicht erlaubt, Kilometer unbegrenzt", async () => {
  const w = await world("rules-limits");
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { abroadAllowed: true, abroadCountries: ["AT"], additionalDriversAllowed: false } } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await saveConditions(w.tenantId, c.id, { ...baseConditions(c), rules: { abroadAllowed: true, abroadCountries: ["PL"] } });
  assert.ok((await codes(w, c.id)).includes("error:RULES_INCONSISTENT"));
  await saveConditions(w.tenantId, c.id, { ...baseConditions(c), rules: { abroadAllowed: true, abroadCountries: ["AT"], kmPolicy: "UNLIMITED" } });
  assert.ok(!(await codes(w, c.id)).includes("error:RULES_INCONSISTENT"));
  await addAdditionalDriver(w.tenantId, c.id, driver());
  assert.ok((await getContractState(w.tenantId, c.id)).issues.some((i) => /keine Zusatzfahrer/.test(i.message)));
  // Verbrenner: Mindestfüllstand ohne Wert → Fehler; mit Achteln → in Ordnung; Ladestand am Verbrenner → Fehler
  await saveConditions(w.tenantId, c.id, { ...baseConditions(c), fuelPolicy: "MINIMUM_LEVEL", rules: { abroadAllowed: false, abroadCountries: [] } });
  assert.ok((await getContractState(w.tenantId, c.id)).issues.some((i) => /Mindestfüllstand in Achteln/.test(i.message)));
  await saveConditions(w.tenantId, c.id, { ...baseConditions(c), fuelPolicy: "MINIMUM_LEVEL", rules: { fuelMinimumEighths: 4, abroadAllowed: false, abroadCountries: [] } });
  assert.ok(!(await getContractState(w.tenantId, c.id)).issues.some((i) => /Mindest/.test(i.message)));
  await saveConditions(w.tenantId, c.id, { ...baseConditions(c), fuelPolicy: "MINIMUM_LEVEL", rules: { fuelMinimumEighths: 4, batteryMinimumPercent: 50, abroadAllowed: false, abroadCountries: [] } });
  assert.ok((await getContractState(w.tenantId, c.id)).issues.some((i) => /Verbrenner hat keinen Ladestand/.test(i.message)));
  // Elektrofahrzeug
  const w2 = await world("rules-ev");
  await db.vehicle.update({ where: { id: w2.vehicleId }, data: { fuel: "ELEKTRO" } });
  const c2 = await ensureContractDraft(w2.tenantId, w2.bookingId, w2.actor);
  await saveConditions(w2.tenantId, c2.id, { ...baseConditions(c2), fuelPolicy: "MINIMUM_LEVEL", rules: { batteryMinimumPercent: 80 } });
  const s = await getContractState(w2.tenantId, c2.id);
  assert.equal(s.rules.driveClass, "ELECTRIC");
  assert.ok(!s.issues.some((i) => i.code === "RULES_INCONSISTENT"));
  const doc = buildContractDocument(s.contract, await db.tenant.findUniqueOrThrow({ where: { id: w2.tenantId } }), []);
  assert.ok(doc.rules?.rows.some((r) => r.label === "Laderegel" && /Batterie mindestens 80 %/.test(r.value)));
  await saveConditions(w2.tenantId, c2.id, { ...baseConditions(c2), fuelPolicy: "MINIMUM_LEVEL", rules: { fuelMinimumEighths: 4 } });
  assert.ok((await getContractState(w2.tenantId, c2.id)).issues.some((i) => /keinen Tank/.test(i.message)));
});

test("Fahrer: Mindestalter kalendergenau (18 exakt, 17 Jahre 364 Tage, 29. Februar), Mandantenregel 21, Zusatzfahrer unter Mindestalter, Führerscheinmonate", async () => {
  const startInDays = 30;
  const start = new Date(Date.now() + startInDays * 86_400_000);
  const berlin = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(start); // JJJJ-MM-TT des Mietbeginns
  const [y, m, d] = berlin.split("-").map(Number);
  const birth18 = new Date(Date.UTC(y - 18, m - 1, d));
  const birth17 = new Date(birth18.getTime() + 86_400_000); // ein Tag jünger → 17 Jahre 364 Tage
  const w = await world("rules-age", { startInDays, customer: { birthDate: birth18 } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.ok(!(await codes(w, c.id)).includes("error:DRIVER_UNDERAGE"), "genau 18 am Mietbeginn ist erlaubt");
  await db.customer.update({ where: { id: w.customerId }, data: { birthDate: birth17 } });
  assert.ok((await codes(w, c.id)).includes("error:DRIVER_UNDERAGE"), "17 Jahre 364 Tage: abgelehnt");
  await db.customer.update({ where: { id: w.customerId }, data: { birthDate: birth18 } });
  await addAdditionalDriver(w.tenantId, c.id, driver({ birthDate: birth17 }));
  const s = await getContractState(w.tenantId, c.id);
  assert.ok(s.issues.some((i) => i.code === "DRIVER_UNDERAGE" && i.area === "ADDITIONAL_DRIVER"), "Zusatzfahrer unter Mindestalter");
  // Mandantenregel 21 Jahre und 12 Monate Führerscheinbesitz gelten für neue Verträge
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { minimumDriverAge: 21, minimumLicenseHoldingMonths: 12 } } });
  await adoptContractDefaults(w.tenantId, c.id, w.actor);
  const s2 = await getContractState(w.tenantId, c.id);
  assert.ok(s2.issues.some((i) => i.code === "DRIVER_UNDERAGE" && /21 Jahre/.test(i.message)));
  await db.customer.update({ where: { id: w.customerId }, data: { birthDate: new Date("1990-01-01"), licenseIssuedAt: new Date(start.getTime() - 100 * 86_400_000) } });
  assert.ok((await codes(w, c.id)).includes("error:LICENSE_TOO_NEW"));
  await db.customer.update({ where: { id: w.customerId }, data: { licenseIssuedAt: new Date("2005-06-01") } });
  assert.ok(!(await getContractState(w.tenantId, c.id)).issues.some((i) => i.area === "DRIVER" && (i.code === "LICENSE_TOO_NEW" || i.code === "DRIVER_UNDERAGE")), "Hauptfahrer erfüllt jetzt Alter und Führerscheindauer; nur der Zusatzfahrer bleibt zu jung");
  // 29. Februar: geboren 29.02.2008 – mit Mietbeginn 28.02.2026 noch 17, ab 01.03.2026 18 (Regel 18)
  const w2 = await world("rules-leap", { customer: { birthDate: new Date("2008-02-29") } });
  const c2 = await ensureContractDraft(w2.tenantId, w2.bookingId, w2.actor);
  const cond = baseConditions(c2);
  await saveConditions(w2.tenantId, c2.id, { ...cond, startAt: new Date("2026-02-28T09:00:00+01:00"), endAt: new Date("2026-03-02T09:00:00+01:00") });
  assert.ok((await codes(w2, c2.id)).includes("error:DRIVER_UNDERAGE"));
  await saveConditions(w2.tenantId, c2.id, { ...cond, startAt: new Date("2026-03-01T00:30:00+01:00"), endAt: new Date("2026-03-03T09:00:00+01:00") });
  assert.ok(!(await codes(w2, c2.id)).includes("error:DRIVER_UNDERAGE"));
});

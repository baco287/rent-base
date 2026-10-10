// Verworfene Übergabe-Entwürfe (Storno nach Fahrerprüfung). Prüfvermerke und Dokumentkopien verweisen mit RESTRICT auf den
// Entwurf und werden nie gelöscht – deshalb wird ein solcher Entwurf beim Storno nicht gelöscht, sondern als DISCARDED gekennzeichnet.
// Hier: die Datenbankregeln dazu, direkt an der Anwendung vorbei.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature } from "../src/lib/contracts";
import { startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { isImmutableError, sha256 } from "../src/lib/integrity";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { buildStorageKey, getStorage } from "../src/lib/storage";
import { readFileSync } from "node:fs";
import { changeBookingStatus } from "../src/lib/booking-status";
import { cancellationOverview, COPY_DELETION_REASON_CANCELLED, HANDOVER_DISCARD_REASON, removeCancellationFiles } from "../src/lib/cancellation";
import { recordDriverDocumentCopy, recordIdentityCheck, recordLicenseCheck, startOrGetVerification } from "../src/lib/driver-verification";
import type { StorageDriver } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { photoJpeg } from "./pdf-fixtures";
import { answerAll, photo, sign } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-discard-"));
  // derselbe Speicher wie in der Anwendung (getStorage() ohne Argument): Kopien und Aufräumen landen im Testverzeichnis
  process.env.LOCAL_STORAGE_DIR = dir;
  storage = getStorage();
})();
after(async () => {
  // Löschen eines Mandanten (bewusste Ausnahme rentbase.allow_purge) räumt auch verworfene Protokolle ab
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const DISCARD = { status: "DISCARDED", discardedAt: new Date(), discardReason: "Mit dem Storno der Buchung verworfen" } as const;
const rejectsImmutable = (fn: () => Promise<unknown>, what: string) => assert.rejects(fn, (e) => isImmutableError(e), what);
const rejectsCheck = (fn: () => Promise<unknown>, constraint: string, what: string) => assert.rejects(fn, (e) => String((e as Error).message).includes(constraint), what);

async function world(label: string) { await ready; const w = await createWorld(label); tenants.push(w.tenantId); return w; }
/** Übergabe-Entwurf mit Fotos, Checkliste, Unterschrift; optional mit bestätigter Fahrerprüfung. */
async function pickupDraft(label: string, verify: boolean): Promise<{ w: World; contractId: string; handoverId: string }> {
  const w = await world(label);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 50_010, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, p.id, cat);
  await answerAll(w, p.id);
  await sign(w, p.id);
  if (verify) await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  return { w, contractId: c.id, handoverId: p.id };
}

test("Datenbank: Verwerfen ändert nur Status, Zeitpunkt und Grund – danach ist das Protokoll unveränderlich und nicht löschbar", async () => {
  const { w, handoverId } = await pickupDraft("discard-db-guard", false);
  // Verwerfen mit gleichzeitiger Inhaltsänderung wird abgelehnt
  await rejectsImmutable(() => db.handover.update({ where: { id: handoverId }, data: { ...DISCARD, mileage: 1 } }), "Verwerfen mit Inhaltsänderung");
  await db.handover.update({ where: { id: handoverId }, data: DISCARD });
  await rejectsImmutable(() => db.handover.update({ where: { id: handoverId }, data: { mileage: 1 } }), "verworfenes Protokoll ändern");
  await rejectsImmutable(() => db.handover.update({ where: { id: handoverId }, data: { status: "DRAFT", discardedAt: null, discardReason: null } }), "zurück zum Entwurf");
  await rejectsImmutable(() => db.handover.update({ where: { id: handoverId }, data: { status: "FINALIZED", finalizedAt: new Date(), contentHash: "x" } }), "nachträglich versiegeln");
  await rejectsImmutable(() => db.handover.delete({ where: { id: handoverId } }), "verworfenes Protokoll löschen (ohne Prüfvermerke greift nur der Trigger)");
  // Bestandteile: weder anlegen noch ändern noch löschen
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  await rejectsImmutable(() => db.photo.create({ data: { tenantId: w.tenantId, handoverId, storageKey, category: "FRONT", contentType: "image/jpeg", sizeBytes: 100, checksum: sha256(storageKey) } }), "Foto nachtragen");
  await rejectsImmutable(() => db.photo.deleteMany({ where: { handoverId } }), "Foto löschen");
  await rejectsImmutable(() => db.handoverChecklistItem.updateMany({ where: { handoverId }, data: { result: "NOT_OK" } }), "Checkliste ändern");
  await rejectsImmutable(() => db.handoverDamage.create({ data: { tenantId: w.tenantId, handoverId, marker: "NEW", view: "LEFT", posX: 0.1, posY: 0.1, kind: "DENT", severity: "MINOR", description: "später" } }), "Schaden nachtragen");
  await rejectsImmutable(() => db.extraCharge.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, handoverId, type: "CLEANING", description: "später", quantity: 1, unit: "pauschal", unitPrice: 10, amount: 10, formula: "1 × 10 €", calculation: {} } }), "Zusatzkosten nachtragen");
  await rejectsImmutable(() => db.signature.create({ data: { tenantId: w.tenantId, handoverId, role: "EMPLOYEE", signerName: "Jemand", storageKey: `${storageKey}.png`, contentHash: "x" } }), "Unterschrift nachtragen");
  await rejectsImmutable(() => db.signature.deleteMany({ where: { handoverId } }), "Unterschrift löschen");
  const row = await db.handover.findUniqueOrThrow({ where: { id: handoverId } });
  assert.deepEqual([row.status, row.mileage, row.discardReason], ["DISCARDED", 50_010, DISCARD.discardReason], "Inhalt unverändert");
});

test("Datenbank: zu einem verworfenen Protokoll entstehen keine Prüfvermerke; vorhandene bleiben unveränderlich", async () => {
  const { w, contractId, handoverId } = await pickupDraft("discard-db-verification", true);
  const before = await db.driverVerification.findMany({ where: { handoverId }, orderBy: { id: "asc" } });
  assert.ok(before.length >= 1 && before.every((v) => v.status === "CONFIRMED"));
  // Kinder vorher entfernen (wie das Storno), dann verwerfen
  await db.photo.deleteMany({ where: { handoverId } });
  await db.signature.deleteMany({ where: { handoverId } });
  await db.handoverChecklistItem.deleteMany({ where: { handoverId } });
  await db.handoverDamage.deleteMany({ where: { handoverId } });
  await db.handover.update({ where: { id: handoverId }, data: DISCARD });
  const driver = await db.contractDriver.findFirstOrThrow({ where: { contractId } });
  await rejectsImmutable(() => db.driverVerification.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, contractId, handoverId, contractDriverId: driver.id, driverRole: driver.role, driverFirstNameSnapshot: driver.firstName, driverLastNameSnapshot: driver.lastName, driverBirthDateSnapshot: driver.birthDate, version: 2 } }), "neuer Prüfvermerk");
  await rejectsImmutable(() => db.driverVerification.deleteMany({ where: { handoverId } }), "Prüfvermerk löschen");
  await rejectsImmutable(() => db.driverVerification.updateMany({ where: { handoverId }, data: { notes: "nachträglich" } }), "bestätigten Prüfvermerk ändern");
  // Protokoll mit Prüfvermerken ist zusätzlich über den Fremdschlüssel vor dem Löschen geschützt
  await assert.rejects(() => db.handover.delete({ where: { id: handoverId } }), "verworfenes Protokoll mit Prüfvermerken löschen");
  assert.deepEqual(await db.driverVerification.findMany({ where: { handoverId }, orderBy: { id: "asc" } }), before, "Prüfvermerke unverändert");
});

test("Datenbank: CHECK-Regeln – verworfen nur als Übergabe, nie ohne Zeitpunkt und Grund, nie versiegelt, nur bekannte Status", async () => {
  const { w, handoverId } = await pickupDraft("discard-db-check", false);
  await rejectsCheck(() => db.handover.update({ where: { id: handoverId }, data: { status: "DISCARDED" } }), "rb_handover_discarded", "ohne Zeitpunkt und Grund");
  await rejectsCheck(() => db.handover.update({ where: { id: handoverId }, data: { status: "DISCARDED", discardedAt: new Date() } }), "rb_handover_discarded", "ohne Grund");
  await rejectsCheck(() => db.handover.update({ where: { id: handoverId }, data: { ...DISCARD, discardReason: " x " } }), "rb_handover_discarded", "Grund zu kurz");
  await rejectsCheck(() => db.handover.update({ where: { id: handoverId }, data: { discardReason: "Grund ohne Verwerfen" } }), "rb_handover_discarded", "Grund am Entwurf");
  await rejectsCheck(() => db.handover.update({ where: { id: handoverId }, data: { status: "STORNIERT" } }), "rb_handover_status", "unbekannter Status");
  // Rückgaben werden nie verworfen
  const ret = await db.handover.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, vehicleId: w.vehicleId, type: "RETURN", number: `RP-T-${Date.now()}`, employeeName: "Test", driveType: "DIESEL" } });
  await rejectsCheck(() => db.handover.update({ where: { id: ret.id }, data: DISCARD }), "rb_handover_discarded", "Rückgabe verwerfen");
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: handoverId } })).status, "DRAFT");
});

// ---------------------------------------------------------------------------
// Anwendung: Storno nach Fahrerprüfung
// ---------------------------------------------------------------------------

/** Übergabe-Entwurf, Hauptfahrer mit Ausweis- und Führerscheinkopie (während der Prüfung), danach alle Fahrer bestätigt. */
async function draftWithCopies(label: string) {
  const d = await pickupDraft(label, false);
  const primary = await db.contractDriver.findFirstOrThrow({ where: { tenantId: d.w.tenantId, contractId: d.contractId, role: "PRIMARY_DRIVER" } });
  const v = await startOrGetVerification(d.w.tenantId, d.w.actor, d.handoverId, primary.id);
  const ids = await recordDriverDocumentCopy(d.w.tenantId, d.w.actor, { bookingId: d.w.bookingId, handoverId: d.handoverId, verificationId: v.id, contractDriverId: primary.id, documentKind: "IDENTITY", side: "FRONT", bytes: await photoJpeg("Ausweis", 400, 300), consent: { given: true } });
  const lic = await recordDriverDocumentCopy(d.w.tenantId, d.w.actor, { bookingId: d.w.bookingId, handoverId: d.handoverId, verificationId: v.id, contractDriverId: primary.id, documentKind: "LICENSE", side: "FRONT", bytes: await photoJpeg("Fuehrerschein", 400, 300) });
  await verifyAllDriversForPickup(d.w.tenantId, d.w.actor, d.handoverId, d.contractId);
  return { ...d, copies: [ids, lic] };
}
const cancel = (w: World) => changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "Führerschein ungültig" });
const children = async (handoverId: string) => Promise.all([db.photo.count({ where: { handoverId } }), db.signature.count({ where: { handoverId } }), db.handoverChecklistItem.count({ where: { handoverId } }), db.handoverDamage.count({ where: { handoverId } }), db.extraCharge.count({ where: { handoverId } })]);
const audits = (tenantId: string, action: string) => db.auditLog.findMany({ where: { tenantId, action }, orderBy: { createdAt: "asc" } });
const exists = async (key: string) => (await storage.get(key)) !== null;
const withoutDeletion = <T extends Record<string, unknown>>(c: T) => { const { deletionStatus, deletedAt, deletedById, deletedByName, deletionReason, ...rest } = c; void deletionStatus; void deletedAt; void deletedById; void deletedByName; void deletionReason; return rest; };

test("Storno nach bestätigter Fahrerprüfung: Buchung storniert, Entwurf verworfen, Prüfvermerke unverändert, Kopien gelöscht", async () => {
  const d = await draftWithCopies("discard-confirmed");
  const verificationsBefore = await db.driverVerification.findMany({ where: { handoverId: d.handoverId }, orderBy: { id: "asc" } });
  const copiesBefore = await db.driverDocumentCopy.findMany({ where: { handoverId: d.handoverId }, orderBy: { id: "asc" } });
  const photoKeys = (await db.photo.findMany({ where: { handoverId: d.handoverId }, select: { storageKey: true } })).map((p) => p.storageKey).sort();
  assert.ok(verificationsBefore.length >= 1 && verificationsBefore.every((v) => v.status === "CONFIRMED"));
  assert.ok(await exists(d.copies[0].storageKey) && await exists(d.copies[1].storageKey), "Kopien liegen im Speicher");
  // Der Storno-Assistent kündigt es an
  assert.ok((await cancellationOverview(d.w.tenantId, d.w.bookingId)).warnings.some((x) => x.includes("Erfasste Fahrerprüfungen bleiben als Nachweis erhalten; Ausweis- und Führerscheinkopien werden gelöscht")));

  const files = await cancel(d.w);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: d.w.bookingId } })).status, "CANCELLED");
  const h = await db.handover.findUniqueOrThrow({ where: { id: d.handoverId } });
  assert.deepEqual([h.status, h.discardReason, h.mileage, h.finalizedAt, h.contentHash], ["DISCARDED", HANDOVER_DISCARD_REASON, 50_010, null, null]);
  assert.ok(h.discardedAt);
  assert.deepEqual(await db.driverVerification.findMany({ where: { handoverId: d.handoverId }, orderBy: { id: "asc" } }), verificationsBefore, "Prüfvermerke vollständig unverändert");
  const copiesAfter = await db.driverDocumentCopy.findMany({ where: { handoverId: d.handoverId }, orderBy: { id: "asc" } });
  assert.ok(copiesAfter.every((c) => c.deletionStatus === "DELETED" && c.deletionReason === COPY_DELETION_REASON_CANCELLED && c.deletedById === d.w.actor.id && c.deletedAt), "Kopien als gelöscht markiert");
  assert.deepEqual(copiesAfter.map(withoutDeletion), copiesBefore.map(withoutDeletion), "an den Kopien ändern sich nur die Löschfelder");
  assert.deepEqual(await children(d.handoverId), [0, 0, 0, 0, 0], "Fotos, Unterschriften, Checkliste, Schadenkopien, Zusatzkosten entfernt");
  // Dateien: im Ergebnis zum Entfernen nach dem Commit; bis dahin noch vorhanden (ein Rollback hätte nichts verloren)
  assert.deepEqual([...files.orphanedStorageKeys].sort(), photoKeys);
  assert.deepEqual(files.driverCopyFiles.map((f) => f.copyId).sort(), d.copies.map((c) => c.id).sort());
  assert.ok(await exists(d.copies[0].storageKey), "vor dem Aufräumen noch vorhanden");
  const removal = await removeCancellationFiles(d.w.tenantId, d.w.actor, d.w.bookingId, files, { storage });
  assert.deepEqual([removal.removed, removal.failed.length], [photoKeys.length + 2, 0]);
  assert.ok(!(await exists(d.copies[0].storageKey)) && !(await exists(d.copies[1].storageKey)), "Kopien aus dem Speicher entfernt");
  // Audit: Verwerfen und je Kopie die Löschung, kein Fehlschlag
  const discarded = await audits(d.w.tenantId, "HANDOVER_DRAFT_DISCARDED");
  assert.equal(discarded.length, 1);
  assert.deepEqual((discarded[0].details as { deletedCopies: number }).deletedCopies, 2);
  assert.equal((await audits(d.w.tenantId, "DRIVER_DOCUMENT_DELETED")).length, 2);
  assert.equal((await audits(d.w.tenantId, "STORAGE_FILE_REMOVAL_FAILED")).length, 0);
  // Danach: nichts mehr am Entwurf änderbar, keine neue Übergabe, kein zweites Storno
  await assert.rejects(() => updateHandoverDraft(d.w.tenantId, d.handoverId, { mileage: 1 }), /mit dem Storno der Buchung verworfen/);
  await assert.rejects(() => startHandover(d.w.tenantId, d.w.bookingId, "PICKUP", d.w.actor));
  await assert.rejects(() => cancel(d.w), /bereits storniert/);
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: d.handoverId } })).updatedAt.getTime(), h.updatedAt.getTime(), "zweites Storno ändert nichts");
});

test("Storno nach blockierter Fahrerprüfung (ohne Kopien): Entwurf verworfen, blockierter Prüfvermerk bleibt unverändert", async () => {
  const d = await pickupDraft("discard-blocked", false);
  const primary = await db.contractDriver.findFirstOrThrow({ where: { tenantId: d.w.tenantId, contractId: d.contractId, role: "PRIMARY_DRIVER" } });
  const v = await startOrGetVerification(d.w.tenantId, d.w.actor, d.handoverId, primary.id);
  await recordIdentityCheck(d.w.tenantId, d.w.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
  await recordLicenseCheck(d.w.tenantId, d.w.actor, v.id, { originalSeen: true, documentValid: false, nameMatched: true, licenseNumber: primary.licenseNumber, licenseCountry: primary.licenseCountry, licenseIssuedAt: primary.licenseIssuedAt, licenseValidUntil: primary.licenseValidUntil, licenseClasses: [primary.licenseClass], internationalPermitPresented: false, translationPresented: false });
  const before = await db.driverVerification.findUniqueOrThrow({ where: { id: v.id } });
  assert.equal(before.status, "BLOCKED", "Führerschein ungültig → Prüfung blockiert");
  const files = await cancel(d.w);
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: d.handoverId } })).status, "DISCARDED");
  assert.deepEqual(await db.driverVerification.findUniqueOrThrow({ where: { id: v.id } }), before);
  assert.deepEqual(files.driverCopyFiles, []);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: d.w.bookingId } })).status, "CANCELLED");
});

test("Storno ohne Prüfdaten: Entwurf wird wie bisher gelöscht, nichts verworfen", async () => {
  const d = await pickupDraft("discard-plain", false);
  assert.ok((await cancellationOverview(d.w.tenantId, d.w.bookingId)).warnings.includes("Ein begonnener Übergabe-Entwurf wird verworfen."));
  const files = await cancel(d.w);
  assert.equal(await db.handover.findFirst({ where: { id: d.handoverId } }), null);
  assert.equal(files.orphanedStorageKeys.length, REQUIRED_PHOTO_CATEGORIES.length);
  assert.equal((await audits(d.w.tenantId, "HANDOVER_DRAFT_DISCARDED")).length, 0);
});

test("Fehlerfälle beim Entfernen der Dateien: Storno bleibt gültig, Fehlschlag steht im Audit-Log, Nachholen und vorübergehende Fehler", async () => {
  const d = await draftWithCopies("discard-storage-fail");
  const files = await cancel(d.w);
  // Speicher dauerhaft nicht erreichbar
  let calls = 0;
  const down: StorageDriver = { name: storage.name, get: (k) => storage.get(k), put: (k, b, t) => storage.put(k, b, t), remove: async () => { calls++; throw new Error("Speicher nicht erreichbar"); } };
  const first = await removeCancellationFiles(d.w.tenantId, d.w.actor, d.w.bookingId, files, { storage: down, attempts: 3, pauseMs: 1 });
  const total = files.orphanedStorageKeys.length + files.driverCopyFiles.length;
  assert.deepEqual([first.removed, first.failed.length, calls], [0, total, total * 3], "jede Datei dreimal versucht, nichts geworfen");
  const failedAudits = await audits(d.w.tenantId, "STORAGE_FILE_REMOVAL_FAILED");
  assert.equal(failedAudits.length, total, "jeder Fehlschlag protokolliert");
  const copyAudits = failedAudits.map((a) => a.details as { kind: string; storageKey: string; copyId: string | null; error: string }).filter((x) => x.kind === "DRIVER_COPY");
  assert.deepEqual(copyAudits.map((x) => x.copyId).sort(), d.copies.map((c) => c.id).sort(), "Kopien mit Id im Audit-Log");
  assert.ok(copyAudits.every((x) => x.error.includes("Speicher nicht erreichbar")));
  // Datenbank bleibt konsistent: Storno, Verwerfen und Löschmarkierung gelten; die Dateien liegen noch
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: d.w.bookingId } })).status, "CANCELLED");
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: d.handoverId } })).status, "DISCARDED");
  assert.ok((await db.driverDocumentCopy.findMany({ where: { handoverId: d.handoverId } })).every((c) => c.deletionStatus === "DELETED"));
  assert.ok(await exists(d.copies[0].storageKey), "Datei nach dauerhaftem Fehler noch vorhanden");
  // Nachholen aus dem Audit-Log mit erreichbarem Speicher
  const photoAudits = failedAudits.map((a) => a.details as { kind: string; storageKey: string }).filter((x) => x.kind === "PHOTO");
  const retry = { orphanedStorageKeys: photoAudits.map((x) => x.storageKey), driverCopyFiles: copyAudits.map((x) => ({ copyId: x.copyId!, storageKey: x.storageKey })) };
  const second = await removeCancellationFiles(d.w.tenantId, d.w.actor, d.w.bookingId, retry, { storage });
  assert.deepEqual([second.removed, second.failed.length], [total, 0]);
  assert.ok(!(await exists(d.copies[0].storageKey)) && !(await exists(d.copies[1].storageKey)), "nach dem Nachholen entfernt");
  // Vorübergehender Fehler: erster Versuch scheitert, der zweite gelingt – kein Audit-Eintrag
  const d2 = await draftWithCopies("discard-storage-flaky");
  const files2 = await cancel(d2.w);
  const seen = new Set<string>();
  const flaky: StorageDriver = { name: storage.name, get: (k) => storage.get(k), put: (k, b, t) => storage.put(k, b, t), remove: async (k) => { if (!seen.has(k)) { seen.add(k); throw new Error("Zeitüberschreitung"); } return storage.remove(k); } };
  const third = await removeCancellationFiles(d2.w.tenantId, d2.w.actor, d2.w.bookingId, files2, { storage: flaky, pauseMs: 1 });
  assert.deepEqual([third.removed, third.failed.length], [files2.orphanedStorageKeys.length + 2, 0]);
  assert.equal((await audits(d2.w.tenantId, "STORAGE_FILE_REMOVAL_FAILED")).length, 0);
  assert.ok(!(await exists(d2.copies[0].storageKey)));
});

test("Übergabe-Seite und -Aktionen greifen nie auf einen verworfenen Entwurf zu", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/uebergabe/page.tsx"), "utf8");
  const actions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/uebergabe/actions.ts"), "utf8");
  assert.match(page, /handovers: \{ where: \{ type: "PICKUP", correctsId: null, status: \{ not: "DISCARDED" \} \}/);
  assert.match(actions, /type: "PICKUP", correctsId: null, status: \{ not: "DISCARDED" \} \}/);
});

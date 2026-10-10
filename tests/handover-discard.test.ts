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
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { answerAll, photo, sign } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-discard-"));
  getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
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

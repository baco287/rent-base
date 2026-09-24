// Phase 7: End-to-End-Audit. Greift den Kernprozess gezielt an: Race Conditions, Statusmaschine, Storno je Phase,
// Verfügbarkeit, Zeitgrenzen, Snapshots, Schäden, Koordinaten, Signatur-Replay, Mandantentrennung, Datenbankregeln,
// Transaktionsfehler, Preise, Geldbeträge, Zeitzone. Läuft gegen die lokale Entwicklungsdatenbank.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { assertVehicleBookable, findConflicts } from "../src/lib/bookings";
import { ALLOWED_TRANSITIONS, bookingStage, canCancel, changeBookingStatus } from "../src/lib/booking-status";
import { addAdditionalDriver, ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature, verifyContract } from "../src/lib/contracts";
import { buildContractDocument } from "../src/lib/contract-view";
import { addNewDamage, answerChecklist, finalizeHandover, getHandoverContentHash, getHandoverState, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft, verifyHandover } from "../src/lib/handovers";
import { buildHandoverDocument } from "../src/lib/handover-view";
import { confirmProposal, getReturnComparison } from "../src/lib/returns";
import { ensureContractDocument, ensurePickupDocument } from "../src/lib/documents";
import { loadContractDocumentData, loadHandoverDocumentData } from "../src/lib/document-data";
import { runPickupFollowUp } from "../src/lib/followup";
import { extraMileageCharge, flatCharge, fuelCharge } from "../src/lib/extra-charges";
import { calculateRentalPrice, rentalDays } from "../src/lib/pricing";
import { DomainError, isImmutableError, sha256 } from "../src/lib/integrity";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { buildStorageKey, getStorage, type StorageDriver } from "../src/lib/storage";
import { parseLocalDateTime, toDateTimeInputValue, zoneOffsetMinutes } from "../src/lib/time";
import { fmtDateTime } from "../src/lib/format";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-audit-"));
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
  async send(m: MailMessage) { this.sent.push(m); return { messageId: `<fake-${this.sent.length}@test>` }; }
}
const DAY = 86400_000;
const settled = <T,>(ps: Promise<T>[]) => Promise.allSettled(ps).then((r) => ({ ok: r.filter((x) => x.status === "fulfilled").length, failed: r.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason?.message ?? x)) }));

async function world(label: string) { await ready; const w = await createWorld(label); tenants.push(w.tenantId); return w; }
async function signContract(w: World, contractId: string) {
  await saveContractSignature(w.tenantId, w.actor, contractId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, contractId) });
}
async function photo(w: World, handoverId: string, category: string, handoverDamageId?: string) {
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  return registerPhoto(w.tenantId, w.actor, { handoverId, handoverDamageId, storageKey, category, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(storageKey) });
}
async function fillHandover(w: World, handoverId: string, mileage: number) {
  await updateHandoverDraft(w.tenantId, handoverId, { mileage, fuelLevelEighths: 8 });
  for (const c of REQUIRED_PHOTO_CATEGORIES) await photo(w, handoverId, c);
  const items = await db.handoverChecklistItem.findMany({ where: { handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "remarks" ? "" : "2") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  await saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId) });
}
/** Buchung bis "Unterwegs" mit finalisiertem Vertrag und Übergabe. */
async function activeWorld(label: string) {
  const w = await world(label);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await signContract(w, c.id);
  await finalizeContract(w.tenantId, c.id);
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await fillHandover(w, p.id, 50_010);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  return { w, contractId: c.id, pickupId: p.id };
}

test("Race Conditions: Doppelklick und parallele Requests erzeugen nie Duplikate", async () => {
  const w = await world("race");
  // Vertrag doppelt erstellen
  const drafts = await Promise.all([1, 2, 3].map(() => ensureContractDraft(w.tenantId, w.bookingId, w.actor)));
  assert.equal(new Set(drafts.map((d) => d.id)).size, 1);
  assert.equal(await db.rentalContract.count({ where: { bookingId: w.bookingId } }), 1);
  await signContract(w, drafts[0].id);
  // Vertrag doppelt finalisieren
  const fin = await settled([1, 2, 3].map(() => finalizeContract(w.tenantId, drafts[0].id)));
  assert.equal(fin.ok, 1, `genau ein Abschluss, Rest: ${fin.failed.join(" | ")}`);
  assert.ok(fin.failed.every((m) => /bereits abgeschlossen/.test(m)));
  // Übergabe doppelt starten
  const starts = await Promise.all([1, 2, 3].map(() => startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor)));
  assert.equal(new Set(starts.map((s) => s.id)).size, 1);
  assert.equal(await db.handover.count({ where: { bookingId: w.bookingId, type: "PICKUP" } }), 1);
  await fillHandover(w, starts[0].id, 50_010);
  await verifyAllDriversForPickup(w.tenantId, w.actor, starts[0].id, drafts[0].id);
  // Übergabe doppelt finalisieren
  const pf = await settled([1, 2, 3].map(() => finalizeHandover(w.tenantId, starts[0].id, w.actor)));
  assert.equal(pf.ok, 1);
  assert.equal(await db.vehicleEvent.count({ where: { handoverId: starts[0].id } }), 2, "PICKUP und MILEAGE genau einmal");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "ACTIVE");
  // PDF und automatische E-Mail mehrfach ausgelöst
  const transport = new FakeTransport();
  await Promise.all([1, 2, 3].map(() => runPickupFollowUp(w.tenantId, { id: starts[0].id, contractId: drafts[0].id }, w.actor.id, { storage, transport })));
  assert.equal(await db.document.count({ where: { tenantId: w.tenantId } }), 2, "je ein Vertrags- und Übergabe-PDF");
  assert.equal(transport.sent.length, 1, "eine automatische E-Mail");
  assert.equal(await db.emailLog.count({ where: { tenantId: w.tenantId } }), 1);
  // Rückgabe doppelt starten, Vorschlag doppelt bestätigen, Rückgabe doppelt finalisieren
  const rs = await Promise.all([1, 2, 3].map(() => startHandover(w.tenantId, w.bookingId, "RETURN", w.actor)));
  assert.equal(new Set(rs.map((s) => s.id)).size, 1);
  await updateHandoverDraft(w.tenantId, rs[0].id, { mileage: 52_000, fuelLevelEighths: 8 });
  const cf = await settled([1, 2, 3].map(() => confirmProposal(w.tenantId, rs[0].id, w.actor.id, "EXTRA_MILEAGE")));
  assert.equal(cf.ok, 1);
  assert.equal(await db.extraCharge.count({ where: { handoverId: rs[0].id } }), 1);
  await fillHandover(w, rs[0].id, 52_000);
  const rf = await settled([1, 2].map(() => finalizeHandover(w.tenantId, rs[0].id, w.actor)));
  assert.equal(rf.ok, 1);
  assert.equal(await db.vehicleEvent.count({ where: { tenantId: w.tenantId, type: "RETURN" } }), 1);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "RETURNED");
});

test("Race: veralteter Entwurf, veraltete Unterschrift und gleichzeitiges Storno überschreiben nichts", async () => {
  const w = await world("stale");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const conditions = { startAt: b.startAt, endAt: b.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL" as const };
  // Mitarbeiter B hat die Seite mit Hash H1 offen, A ändert die Konditionen, B unterschreibt den alten Stand
  const h1 = await getContractContentHash(w.tenantId, c.id);
  await saveConditions(w.tenantId, c.id, { ...conditions, deposit: 900 });
  await assert.rejects(() => saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: h1 }), /seit der Anzeige geändert|veraltet/);
  await signContract(w, c.id);
  await finalizeContract(w.tenantId, c.id);
  // B versucht den alten Entwurf zu speichern
  await assert.rejects(() => saveConditions(w.tenantId, c.id, { ...conditions, deposit: 1 }), (e) => e instanceof DomainError || isImmutableError(e));
  await assert.rejects(() => addAdditionalDriver(w.tenantId, c.id, { firstName: "Max", lastName: "Muster", birthDate: new Date("1990-01-01"), street: "Weg 1", zip: "28195", city: "Bremen", country: "DE", licenseNumber: "X1", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: null, licenseCountry: "DE" }), (e) => e instanceof DomainError || isImmutableError(e));
  assert.equal(Number((await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } })).deposit), 900);
  // Übergabe: A ändert, B unterschreibt den alten Stand
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 50_010, fuelLevelEighths: 8 });
  const old = await getHandoverContentHash(w.tenantId, p.id);
  await addNewDamage(w.tenantId, p.id, { view: "FRONT", posX: 0.5, posY: 0.5, kind: "CHIP", severity: "MINOR", description: "Steinschlag" });
  await assert.rejects(() => saveHandoverSignature(w.tenantId, w.actor, p.id, { role: "RENTER", signerName: "Erika", imageDataUrl: fakeSignaturePng(), seenHash: old }), /seit der Anzeige geändert/);
  // Gleichzeitig: A schließt die Übergabe ab, B storniert. Genau eines gewinnt, der Zustand bleibt konsistent.
  await db.handoverDamage.deleteMany({ where: { handoverId: p.id, marker: "NEW" } });
  await fillHandover(w, p.id, 50_010);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  const r = await Promise.allSettled([finalizeHandover(w.tenantId, p.id, w.actor), changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED")]);
  const after = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const handover = await db.handover.findFirst({ where: { id: p.id } });
  if (after.status === "ACTIVE") { assert.equal(r[1].status, "rejected"); assert.equal(handover?.status, "FINALIZED"); }
  else { assert.equal(after.status, "CANCELLED"); assert.equal(r[0].status, "rejected"); assert.equal(handover, null, "Entwurf beim Storno verworfen"); }
});

test("Statusmaschine und Storno je Phase", async () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.RESERVED.map((t) => `${t.to}:${t.via}`), ["ACTIVE:HANDOVER", "CANCELLED:BUTTON"]);
  assert.deepEqual(ALLOWED_TRANSITIONS.ACTIVE.map((t) => `${t.to}:${t.via}`), ["RETURNED:HANDOVER"]);
  assert.deepEqual([ALLOWED_TRANSITIONS.RETURNED, ALLOWED_TRANSITIONS.CANCELLED], [[], []]);

  // A) ohne Vertrag
  const a = await world("storno-a");
  await changeBookingStatus(a.tenantId, a.bookingId, "CANCELLED");
  assert.equal(bookingStage(await db.booking.findUniqueOrThrow({ where: { id: a.bookingId } }), null), "CANCELLED");
  await assert.rejects(() => ensureContractDraft(a.tenantId, a.bookingId, a.actor), /nur für reservierte/);
  await assert.rejects(() => changeBookingStatus(a.tenantId, a.bookingId, "CANCELLED"), /bereits storniert/);
  // Unterwegs per Knopf ist nie möglich, Zurückgegeben per Knopf nur ohne Protokoll und nur aus ACTIVE
  await assert.rejects(() => changeBookingStatus(a.tenantId, a.bookingId, "ACTIVE"), /nur über Mietvertrag und Übergabeprotokoll/);
  const fresh = await world("storno-fresh");
  await assert.rejects(() => changeBookingStatus(fresh.tenantId, fresh.bookingId, "RETURNED"), /Nur laufende Mieten/);

  // B) Vertragsentwurf: Entwurf wird verworfen
  const bw = await world("storno-b");
  const bc = await ensureContractDraft(bw.tenantId, bw.bookingId, bw.actor);
  await changeBookingStatus(bw.tenantId, bw.bookingId, "CANCELLED");
  assert.equal(await db.rentalContract.count({ where: { id: bc.id } }), 0);

  // C) finalisierter Vertrag ohne Übergabe: Vertrag, Unterschrift und Dokument bleiben, Status CANCELLED, kein neuer Vertrag
  const cw = await world("storno-c");
  const cc = await ensureContractDraft(cw.tenantId, cw.bookingId, cw.actor);
  await signContract(cw, cc.id);
  await finalizeContract(cw.tenantId, cc.id);
  await ensureContractDocument(cw.tenantId, cc.id, null, { storage });
  await changeBookingStatus(cw.tenantId, cw.bookingId, "CANCELLED");
  const kept = await db.rentalContract.findUniqueOrThrow({ where: { id: cc.id } });
  assert.equal(kept.status, "CANCELLED");
  assert.ok(kept.cancelledAt);
  assert.equal(await db.signature.count({ where: { contractId: cc.id } }), 1);
  assert.equal(await db.document.count({ where: { contractId: cc.id } }), 1);
  assert.equal((await ensureContractDraft(cw.tenantId, cw.bookingId, cw.actor)).id, cc.id, "kein zweiter Vertrag, es bleibt der stornierte");
  await assert.rejects(() => startHandover(cw.tenantId, cw.bookingId, "PICKUP", cw.actor), /nur für reservierte/);

  // D) Übergabe-Entwurf: Entwurf samt Fotos und Unterschrift wird verworfen
  const dw = await world("storno-d");
  const dc = await ensureContractDraft(dw.tenantId, dw.bookingId, dw.actor);
  await signContract(dw, dc.id);
  await finalizeContract(dw.tenantId, dc.id);
  const dp = await startHandover(dw.tenantId, dw.bookingId, "PICKUP", dw.actor);
  await fillHandover(dw, dp.id, 50_010);
  const { orphanedStorageKeys } = await changeBookingStatus(dw.tenantId, dw.bookingId, "CANCELLED");
  assert.equal(orphanedStorageKeys.length, REQUIRED_PHOTO_CATEGORIES.length);
  assert.equal(await db.handover.count({ where: { bookingId: dw.bookingId } }), 0);
  assert.equal(await db.photo.count({ where: { tenantId: dw.tenantId } }), 0);

  // E) unterwegs, F) Rückgabe-Entwurf, G) zurückgegeben: kein Storno
  const e = await activeWorld("storno-e");
  assert.equal(canCancel({ status: "ACTIVE" }), false);
  await assert.rejects(() => changeBookingStatus(e.w.tenantId, e.w.bookingId, "CANCELLED"), /bereits übergeben/);
  await assert.rejects(() => changeBookingStatus(e.w.tenantId, e.w.bookingId, "RETURNED"), /über das Rückgabeprotokoll/);
  const er = await startHandover(e.w.tenantId, e.w.bookingId, "RETURN", e.w.actor);
  await assert.rejects(() => changeBookingStatus(e.w.tenantId, e.w.bookingId, "CANCELLED"), /bereits übergeben/);
  await fillHandover(e.w, er.id, 50_500);
  await finalizeHandover(e.w.tenantId, er.id, e.w.actor);
  await assert.rejects(() => changeBookingStatus(e.w.tenantId, e.w.bookingId, "CANCELLED"), /abgeschlossen/);
  assert.equal(await db.handover.count({ where: { bookingId: e.w.bookingId, status: "FINALIZED" } }), 2, "Protokolle bleiben erhalten");
});

test("Fahrzeugverfügbarkeit: Status, Überschneidung, Zeitgrenzen [start, end), Zeilensperre", async () => {
  const w = await world("avail");
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  // Zeitgrenzen: Ende 10:00 und Beginn 10:00 ist kein Konflikt, eine Minute Überschneidung schon
  await db.$transaction(async (tx) => {
    assert.equal((await findConflicts(tx, w.tenantId, w.vehicleId, b.endAt, new Date(b.endAt.getTime() + DAY))).length, 0, "[start, end): Anschluss zur selben Minute ist frei");
    assert.equal((await findConflicts(tx, w.tenantId, w.vehicleId, new Date(b.startAt.getTime() - DAY), b.startAt)).length, 0);
    assert.equal((await findConflicts(tx, w.tenantId, w.vehicleId, new Date(b.endAt.getTime() - 60_000), new Date(b.endAt.getTime() + DAY))).length, 1);
    assert.equal((await findConflicts(tx, w.tenantId, w.vehicleId, new Date(b.startAt.getTime() - DAY), new Date(b.startAt.getTime() + 60_000))).length, 1);
  });
  // Fahrzeugstatus
  for (const status of ["WORKSHOP", "BLOCKED", "INACTIVE"]) {
    await db.vehicle.update({ where: { id: w.vehicleId }, data: { status } });
    await assert.rejects(() => db.$transaction((tx) => assertVehicleBookable(tx, w.tenantId, w.vehicleId, new Date(Date.now() + 30 * DAY), new Date(Date.now() + 31 * DAY))), /nicht vermietet werden/);
  }
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { status: "AVAILABLE" } });
  // fremder Mandant sieht das Fahrzeug nicht
  const other = await world("avail-other");
  await assert.rejects(() => db.$transaction((tx) => assertVehicleBookable(tx, other.tenantId, w.vehicleId, b.endAt, new Date(b.endAt.getTime() + DAY))), /Fahrzeug nicht gefunden/);
  // stornierte Buchung blockiert nicht mehr
  await changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED");
  await db.$transaction(async (tx) => assert.equal((await findConflicts(tx, w.tenantId, w.vehicleId, b.startAt, b.endAt)).length, 0));
  // Parallele Buchungen desselben Zeitraums: nur eine kommt durch
  const start = new Date(Date.now() + 40 * DAY);
  const end = new Date(start.getTime() + 2 * DAY);
  const attempt = (n: number) => db.$transaction(async (tx) => {
    const { conflicts } = await assertVehicleBookable(tx, w.tenantId, w.vehicleId, start, end);
    if (conflicts.length > 0) throw new DomainError("Doppelbelegung");
    return tx.booking.create({ data: { tenantId: w.tenantId, number: `P-${n}-${Date.now()}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: start, endAt: end, dailyRate: 89, deposit: 500 } });
  });
  const r = await settled([1, 2, 3, 4].map(attempt));
  assert.equal(r.ok, 1, `eine Buchung, Rest: ${r.failed.join(" | ")}`);
  assert.equal(await db.booking.count({ where: { tenantId: w.tenantId, startAt: start } }), 1);
  // Übergabe blockiert bei Werkstatt/gesperrt und wenn das Fahrzeug laut anderer Buchung noch unterwegs ist
  const v = await world("avail-pickup");
  const c = await ensureContractDraft(v.tenantId, v.bookingId, v.actor);
  await signContract(v, c.id);
  await finalizeContract(v.tenantId, c.id);
  const p = await startHandover(v.tenantId, v.bookingId, "PICKUP", v.actor);
  await fillHandover(v, p.id, 50_010);
  await db.vehicle.update({ where: { id: v.vehicleId }, data: { status: "WORKSHOP" } });
  await assert.rejects(() => finalizeHandover(v.tenantId, p.id, v.actor), /Werkstatt/);
  await db.vehicle.update({ where: { id: v.vehicleId }, data: { status: "AVAILABLE" } });
  const otherBooking = await db.booking.create({ data: { tenantId: v.tenantId, number: `ALT-${Date.now()}`, vehicleId: v.vehicleId, customerId: v.customerId, startAt: new Date(Date.now() - 5 * DAY), endAt: new Date(Date.now() - 4 * DAY), dailyRate: 89, deposit: 500, status: "ACTIVE" } });
  await assert.rejects(() => finalizeHandover(v.tenantId, p.id, v.actor), /noch unterwegs/);
  await db.booking.update({ where: { id: otherBooking.id }, data: { status: "RETURNED" } });
  await fillHandover(v, p.id, 50_010);
  await verifyAllDriversForPickup(v.tenantId, v.actor, p.id, c.id);
  await finalizeHandover(v.tenantId, p.id, v.actor);
});

test("Snapshots: Vertrag, Übergabe und Rückgabe bleiben nach jeder Live-Änderung unverändert", async () => {
  const { w, contractId, pickupId } = await activeWorld("snap");
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await fillHandover(w, r.id, 51_000);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  const before = {
    contract: (await loadContractDocumentData(w.tenantId, contractId)).doc,
    pickup: (await loadHandoverDocumentData(w.tenantId, pickupId)).doc,
    ret: (await loadHandoverDocumentData(w.tenantId, r.id)).doc,
    cmp: await getReturnComparison(w.tenantId, r.id),
    hashes: [(await verifyContract(w.tenantId, contractId)).intact, (await verifyHandover(w.tenantId, pickupId)).intact, (await verifyHandover(w.tenantId, r.id)).intact],
  };
  assert.deepEqual(before.hashes, [true, true, true]);
  // Alles ändern, was live geändert werden kann
  await db.customer.update({ where: { id: w.customerId }, data: { firstName: "Neu", lastName: "Anders", street: "Andere 9", email: "x@y.de", licenseNumber: "ZZZ", licenseClass: "C" } });
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { make: "Anders", model: "Modell", plate: "XX-Y 1", dailyRate: 999, deposit: 9, mileage: 99_999, kmIncludedPerDay: 1, extraKmRate: 9 } });
  await db.vehicleGroup.update({ where: { id: w.groupId }, data: { name: "Andere Gruppe" } });
  await db.tenant.update({ where: { id: w.tenantId }, data: { name: "Andere Firma", street: "Anderswo 1", rentalTermsText: "Neue Bedingungen", rentalTermsVersion: "9" } });
  await db.damage.updateMany({ where: { tenantId: w.tenantId }, data: { description: "GEÄNDERT", status: "REPAIRED", severity: "SEVERE" } });
  await db.checklistTemplate.create({ data: { tenantId: w.tenantId, name: "Neu", handoverType: "BOTH", items: [{ key: "x", label: "Neu", answerType: "YES_NO", required: true }] } });
  await db.vehicleSketch.updateMany({ where: { tenantId: null, version: 2 }, data: { active: false } });
  await db.vehicleSketch.updateMany({ where: { tenantId: null, version: 2 }, data: { active: true } });
  const after = {
    contract: (await loadContractDocumentData(w.tenantId, contractId)).doc,
    pickup: (await loadHandoverDocumentData(w.tenantId, pickupId)).doc,
    ret: (await loadHandoverDocumentData(w.tenantId, r.id)).doc,
    cmp: await getReturnComparison(w.tenantId, r.id),
  };
  assert.deepEqual(after.contract, before.contract, "Vertrag");
  assert.deepEqual(after.pickup, before.pickup, "Übergabe");
  assert.deepEqual(after.ret, before.ret, "Rückgabe");
  assert.deepEqual(after.cmp, before.cmp, "Vergleich der Rückgabe");
  assert.deepEqual([(await verifyContract(w.tenantId, contractId)).intact, (await verifyHandover(w.tenantId, pickupId)).intact, (await verifyHandover(w.tenantId, r.id)).intact], [true, true, true]);
  // Auch die HTML-Ansicht (Entwurfs-ViewModel) liest nur die Kopie
  const state = await getHandoverState(w.tenantId, pickupId);
  const html = buildHandoverDocument(state.handover, state.sketch, state.signatures, REQUIRED_PHOTO_CATEGORIES);
  assert.deepEqual(html.damages.map((d) => d.description), before.pickup.damages.map((d) => d.description));
  const contract = await db.rentalContract.findUniqueOrThrow({ where: { id: contractId }, include: { drivers: true } });
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
  const htmlContract = buildContractDocument(contract, tenant, []);
  assert.equal(htmlContract.landlord.name, before.contract.landlord.name, "Firmenname aus der Vertragskopie, nicht aus den geänderten Stammdaten");
  assert.ok(!JSON.stringify(htmlContract).includes("Anders"));
});

test("Schäden über den ganzen Zyklus: Alt, Vorschaden, Rückgabeschaden", async () => {
  const w = await world("dmg");
  const old = await db.damage.create({ data: { tenantId: w.tenantId, vehicleId: w.vehicleId, view: "LEFT", posX: 0, posY: 0, kind: "SCRATCH", severity: "MINOR", description: "Alt, links oben" } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await signContract(w, c.id);
  await finalizeContract(w.tenantId, c.id);
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  const pre = await addNewDamage(w.tenantId, p.id, { view: "FRONT", posX: 1, posY: 1, kind: "CHIP", severity: "MINOR", description: "Vorschaden Haube" });
  await photo(w, p.id, "DAMAGE", pre.id);
  await fillHandover(w, p.id, 50_010);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  const preDamage = await db.damage.findFirstOrThrow({ where: { discoveredInHandoverId: p.id } });
  assert.equal(preDamage.bookingId, null, "Vorschaden ohne Mieterbezug");
  // Live: alten Schaden bearbeiten, danach Rückgabe
  await db.damage.update({ where: { id: old.id }, data: { description: "Alt, inzwischen anders beschrieben", posX: 0.5, posY: 0.5 } });
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  const copied = await db.handoverDamage.findMany({ where: { handoverId: r.id }, orderBy: { sortOrder: "asc" } });
  assert.deepEqual(copied.map((d) => [d.marker, d.description]), [["EXISTING", "Alt, inzwischen anders beschrieben"], ["PICKUP_NEW", "Vorschaden Haube"]], "Rückgabe kopiert die Akte von jetzt, mit Herkunft");
  const pickupDoc = (await loadHandoverDocumentData(w.tenantId, p.id)).doc;
  assert.equal(pickupDoc.damages[0].description, "Alt, links oben", "der Vergleich zeigt weiter den damaligen Übergabe-Snapshot");
  const fresh = await addNewDamage(w.tenantId, r.id, { view: "REAR", posX: 0.5, posY: 0.5, kind: "DENT", severity: "MODERATE", description: "Neu bei Rückgabe" });
  await photo(w, r.id, "DAMAGE", fresh.id);
  await fillHandover(w, r.id, 50_300);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  const created = await db.damage.findMany({ where: { discoveredInHandoverId: r.id } });
  assert.equal(created.length, 1, "genau ein Damage");
  assert.deepEqual([created[0].bookingId, created[0].settlementReview], [w.bookingId, true]);
  assert.equal(await db.extraCharge.count({ where: { tenantId: w.tenantId, type: "DAMAGE" } }), 0, "keine automatische Forderung");
  assert.equal(await db.damage.count({ where: { tenantId: w.tenantId } }), 3);
  const events = await db.vehicleEvent.findMany({ where: { damageId: created[0].id } });
  assert.ok(events.every((e) => !/verursacht|schuld/i.test(e.description ?? "")));
});

test("Schadenkoordinaten: Randwerte gültig, alles andere abgelehnt", async () => {
  const w = await world("coords");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await signContract(w, c.id);
  await finalizeContract(w.tenantId, c.id);
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  for (const [x, y] of [[0, 0], [1, 1], [0.5, 0.5]]) await addNewDamage(w.tenantId, p.id, { view: "FRONT", posX: x, posY: y, kind: "CHIP", severity: "MINOR", description: `Rand ${x}/${y}` });
  for (const [x, y] of [[-0.01, 0.5], [1.01, 0.5], [0.5, NaN], [Infinity, 0.5], [0.5, undefined], ["0.5", 0.5]]) {
    await assert.rejects(() => addNewDamage(w.tenantId, p.id, { view: "FRONT", posX: x as number, posY: y as number, kind: "CHIP", severity: "MINOR", description: "ungültig" }), /normalisiert/, `${x}/${y}`);
  }
  await assert.rejects(() => addNewDamage(w.tenantId, p.id, { view: "UNDERBODY", posX: 0.5, posY: 0.5, kind: "CHIP", severity: "MINOR", description: "falsche Ansicht" }), /ansicht/i);
  await assert.rejects(() => db.handoverDamage.create({ data: { tenantId: w.tenantId, handoverId: p.id, marker: "NEW", view: "FRONT", posX: 2, posY: 0, kind: "CHIP", description: "an der App vorbei", severity: "MINOR" } }), "Datenbank-Check verhindert Pixelwerte");
  assert.equal(await db.handoverDamage.count({ where: { handoverId: p.id } }), 3);
});

test("Signaturen: leer, zu klein, zu groß, falsches Format, Replay über Vertrag, Protokoll und Mandant", async () => {
  const w = await world("sig");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const hash = await getContractContentHash(w.tenantId, c.id);
  const sig = (img: string) => saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika", imageDataUrl: img, seenHash: hash });
  await assert.rejects(() => sig(""), /erneut unterschreiben/);
  await assert.rejects(() => sig("data:image/png;base64,"), /erneut unterschreiben|leer/);
  await assert.rejects(() => sig(`data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]).toString("base64")}`), /leer/);
  await assert.rejects(() => sig(`data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500_000)]).toString("base64")}`), /zu groß/);
  await assert.rejects(() => sig(`data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)/>").toString("base64")}`), /erneut unterschreiben/);
  await assert.rejects(() => sig(`data:image/png;base64,${Buffer.from("<html>" + "x".repeat(2000)).toString("base64")}`), /ungültig/);
  await sig(fakeSignaturePng());
  // Replay: Hash von Vertrag A auf Vertrag B
  const w2 = await world("sig-b");
  const c2 = await ensureContractDraft(w2.tenantId, w2.bookingId, w2.actor);
  await assert.rejects(() => saveContractSignature(w2.tenantId, w2.actor, c2.id, { role: "RENTER", signerName: "Erika", imageDataUrl: fakeSignaturePng(), seenHash: hash }), /seit der Anzeige geändert/);
  // Mandant B kann Vertrag A nicht unterschreiben
  await assert.rejects(() => saveContractSignature(w2.tenantId, w2.actor, c.id, { role: "RENTER", signerName: "Erika", imageDataUrl: fakeSignaturePng(), seenHash: hash }), /Vertrag nicht gefunden/);
  await finalizeContract(w.tenantId, c.id);
  // PICKUP-Signatur darf nicht als RETURN-Signatur gelten: eine Signaturzeile mit fremdem Hash zählt nicht
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await fillHandover(w, p.id, 50_010);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  const pickupSig = await db.signature.findFirstOrThrow({ where: { handoverId: p.id } });
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 50_100, fuelLevelEighths: 8 });
  await db.signature.create({ data: { tenantId: w.tenantId, handoverId: r.id, role: "RENTER", signerName: "Erika", storageKey: buildStorageKey({ tenantId: w.tenantId, area: "signatures", contentType: "image/png" }), imageData: pickupSig.imageData, contentHash: pickupSig.contentHash } });
  const issues = (await getHandoverState(w.tenantId, r.id)).issues;
  assert.equal(await db.signature.count({ where: { handoverId: r.id } }), 0, "eine Unterschrift mit fremdem Hash wird sofort verworfen");
  assert.ok(!issues.some((i) => i.code === "SIGNATURE_STALE"));
  await assert.rejects(() => finalizeHandover(w.tenantId, r.id, w.actor), /Unterschrift des Mieters fehlt|fehlen/);
});

test("Mandantentrennung: jede ID eines anderen Mandanten ist unauffindbar", async () => {
  const a = await activeWorld("iso-a");
  const b = await world("iso-b");
  const doc = await ensurePickupDocument(a.w.tenantId, a.pickupId, null, { storage });
  const sig = await db.signature.findFirstOrThrow({ where: { handoverId: a.pickupId } });
  const ph = await db.photo.findFirstOrThrow({ where: { handoverId: a.pickupId } });
  const checks: [string, () => Promise<unknown>][] = [
    ["Buchung", () => changeBookingStatus(b.tenantId, a.w.bookingId, "CANCELLED")],
    ["Vertrag", () => getContractContentHash(b.tenantId, a.contractId)],
    ["Protokoll", () => updateHandoverDraft(b.tenantId, a.pickupId, { notes: "x" })],
    ["Rückgabe", () => startHandover(b.tenantId, a.w.bookingId, "RETURN", b.actor)],
    ["Dokument", () => ensurePickupDocument(b.tenantId, a.pickupId, null, { storage })],
    ["Vergleich", () => getReturnComparison(b.tenantId, a.pickupId)],
  ];
  for (const [name, fn] of checks) await assert.rejects(fn, /nicht gefunden/, name);
  assert.equal(await db.document.findFirst({ where: { id: doc.document.id, tenantId: b.tenantId } }), null);
  assert.equal(await db.signature.findFirst({ where: { id: sig.id, tenantId: b.tenantId } }), null);
  assert.equal(await db.photo.findFirst({ where: { id: ph.id, tenantId: b.tenantId } }), null);
  assert.equal(await db.customer.findFirst({ where: { id: a.w.customerId, tenantId: b.tenantId } }), null);
  assert.equal(await db.vehicle.findFirst({ where: { id: a.w.vehicleId, tenantId: b.tenantId } }), null);
  assert.equal(await db.emailLog.count({ where: { tenantId: b.tenantId } }), 0);
});

test("Datenbankregeln schützen historische Daten auch an der Anwendung vorbei", async () => {
  const { w, contractId, pickupId } = await activeWorld("db");
  const doc = (await ensurePickupDocument(w.tenantId, pickupId, null, { storage })).document;
  const dmg = await db.damage.create({ data: { tenantId: w.tenantId, vehicleId: w.vehicleId, view: "LEFT", posX: 0.1, posY: 0.1, kind: "SCRATCH", severity: "MINOR", description: "x" } });
  const sig = await db.signature.findFirstOrThrow({ where: { handoverId: pickupId } });
  const ev = await db.vehicleEvent.findFirstOrThrow({ where: { handoverId: pickupId } });
  const hd = await db.handoverDamage.findFirst({ where: { handoverId: pickupId } });
  const cases: [string, () => Promise<unknown>][] = [
    ["finalisierten Vertrag ändern", () => db.rentalContract.update({ where: { id: contractId }, data: { totalAmount: 1 } })],
    ["Vertrags-Snapshot ändern", () => db.rentalContract.update({ where: { id: contractId }, data: { customerSnapshot: {} } })],
    ["Fahrer eines finalisierten Vertrags ändern", () => db.contractDriver.updateMany({ where: { contractId }, data: { lastName: "x" } })],
    ["finalisiertes Protokoll ändern", () => db.handover.update({ where: { id: pickupId }, data: { mileage: 1 } })],
    ["finalisiertes Protokoll löschen", () => db.handover.delete({ where: { id: pickupId } })],
    ["Foto eines finalisierten Protokolls löschen", () => db.photo.deleteMany({ where: { handoverId: pickupId } })],
    ["Checkliste eines finalisierten Protokolls ändern", () => db.handoverChecklistItem.updateMany({ where: { handoverId: pickupId }, data: { result: "NO" } })],
    ["Dokument überschreiben", () => db.document.update({ where: { id: doc.id }, data: { checksum: "0".repeat(64) } })],
    ["Dokument löschen", () => db.document.delete({ where: { id: doc.id } })],
    ["Schaden löschen", () => db.damage.delete({ where: { id: dmg.id } })],
    ["Unterschrift ändern", () => db.signature.update({ where: { id: sig.id }, data: { signerName: "x" } })],
    ["Unterschrift löschen", () => db.signature.delete({ where: { id: sig.id } })],
    ["Fahrzeughistorie ändern", () => db.vehicleEvent.update({ where: { id: ev.id }, data: { mileage: 1 } })],
    ["Fahrzeughistorie löschen", () => db.vehicleEvent.delete({ where: { id: ev.id } })],
    ["Skizzenfassung ändern", () => db.vehicleSketch.update({ where: { id: "sys_sketch_pkw_v2" }, data: { assetHash: "x" } })],
  ];
  if (hd) cases.push(["Schaden-Snapshot ändern", () => db.handoverDamage.update({ where: { id: hd.id }, data: { description: "x" } })]);
  for (const [name, fn] of cases) await assert.rejects(fn, (e) => isImmutableError(e), name);
  await assert.rejects(() => db.extraCharge.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, handoverId: pickupId, type: "OTHER", description: "x", quantity: 1, unit: "Stk", unitPrice: 1, amount: 1, formula: "x", calculation: {} } }), (e) => isImmutableError(e), "Zusatzkosten an finalisiertes Protokoll hängen");
  await assert.rejects(() => db.extraCharge.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, type: "OTHER", description: "x", quantity: 1, unit: "Stk", unitPrice: -1, amount: -1, formula: "x", calculation: {} } }), "negative Beträge");
});

test("Transaktionsfehler mitten in Vertrags- und Übergabefinalisierung rollen vollständig zurück", async () => {
  const w = await world("tx");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await signContract(w, c.id);
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION rb_test_block_contract() RETURNS trigger AS 'BEGIN IF NEW."status" = ''SIGNED'' THEN RAISE EXCEPTION ''TESTBLOCK''; END IF; RETURN NEW; END' LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER rb_test_block_contract BEFORE UPDATE ON "RentalContract" FOR EACH ROW EXECUTE FUNCTION rb_test_block_contract()`);
  try { await assert.rejects(() => finalizeContract(w.tenantId, c.id), /TESTBLOCK/); } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS rb_test_block_contract ON "RentalContract"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS rb_test_block_contract()`);
  }
  const cc = await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual([cc.status, cc.contentHash, cc.signedAt, cc.landlordSnapshot], ["DRAFT", null, null, null]);
  await finalizeContract(w.tenantId, c.id);

  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  const d = await addNewDamage(w.tenantId, p.id, { view: "FRONT", posX: 0.5, posY: 0.5, kind: "CHIP", severity: "MINOR", description: "Vorschaden" });
  await photo(w, p.id, "DAMAGE", d.id);
  await fillHandover(w, p.id, 50_010);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  // Fehler beim Fortschreiben des Kilometerstands, also NACH Buchungsstatus und Schadenakte
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION rb_test_block_vehicle() RETURNS trigger AS 'BEGIN IF NEW."mileage" <> OLD."mileage" THEN RAISE EXCEPTION ''TESTBLOCK''; END IF; RETURN NEW; END' LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER rb_test_block_vehicle BEFORE UPDATE ON "Vehicle" FOR EACH ROW EXECUTE FUNCTION rb_test_block_vehicle()`);
  try { await assert.rejects(() => finalizeHandover(w.tenantId, p.id, w.actor), /TESTBLOCK/); } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS rb_test_block_vehicle ON "Vehicle"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS rb_test_block_vehicle()`);
  }
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "RESERVED", "Buchung nicht halb auf Unterwegs");
  assert.equal(await db.damage.count({ where: { tenantId: w.tenantId } }), 0, "keine halb erzeugte Schadenakte");
  assert.equal(await db.vehicleEvent.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: p.id } })).status, "DRAFT");
  assert.equal((await db.handoverDamage.findUniqueOrThrow({ where: { id: d.id } })).damageId, null);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  assert.equal(await db.damage.count({ where: { tenantId: w.tenantId } }), 1);
});

test("Preise: die zentrale Regel (günstigste Kombination) gegen eine unabhängige Vergleichsrechnung", () => {
  const rates = { dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: 1790 };
  const oracle = (days: number) => {
    let best = Infinity;
    for (let m = 0; m * 30 <= days + 30; m++) for (let wk = 0; wk * 7 <= days + 7; wk++) for (let ww = 0; ww * 5 <= days + 5; ww++) {
      const rest = Math.max(0, days - 30 * m - 7 * wk - 5 * ww);
      best = Math.min(best, m * 1790 + wk * 540 + ww * 420 + rest * 89);
    }
    return best;
  };
  const at = (d: number) => new Date(Date.UTC(2026, 8, 1, 8) + d * DAY);
  for (const days of [1, 2, 5, 6, 7, 8, 14, 29, 30, 31, 45, 60, 90]) {
    const p = calculateRentalPrice({ start: at(0), end: at(days), rates });
    assert.equal(p.days, days);
    assert.equal(p.total, oracle(days), `${days} Tage`);
    assert.equal(p.lines.reduce((s, l) => s + l.amount, 0), p.subtotal);
  }
  // angebrochene Tage zählen als voller Tag, 0 oder negative Dauer ergibt 0 Tage
  assert.equal(rentalDays(at(0), new Date(at(1).getTime() + 60_000)), 2);
  assert.equal(rentalDays(at(1), at(0)), 0);
  // ohne Stufen bleibt es bei Tagen × Tagespreis
  assert.equal(calculateRentalPrice({ start: at(0), end: at(31), rates: { dailyRate: 89 } }).total, 31 * 89);
});

test("Geldbeträge: Rundung auf Cent, Kleinstbeträge, große Beträge, Summen ohne Gleitkommafehler", () => {
  assert.equal(flatCharge("CLEANING", "x", 1, "pauschal", 0).amount, 0);
  assert.equal(flatCharge("CLEANING", "x", 1, "pauschal", 0.01).amount, 0.01);
  assert.equal(flatCharge("OTHER", "x", 3, "Stk", 0.1).amount, 0.3);
  assert.equal(flatCharge("OTHER", "x", 0.3, "h", 0.2).amount, 0.06);
  assert.equal(flatCharge("DAMAGE", "x", 1, "pauschal", 123_456.78).amount, 123_456.78);
  const km = extraMileageCharge({ pickupMileage: 0, returnMileage: 1_000_003, start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-02T00:00:00Z"), kmIncludedPerDay: 0, extraKmRate: 0.333 })!;
  assert.equal(km.amount, 333_001);
  const fuel = fuelCharge({ pickupEighths: 8, returnEighths: 1, tankCapacityLiters: 33, pricePerLiter: 1.999 })!;
  assert.equal(fuel.quantity, 28.88);
  assert.equal(fuel.amount, 57.73);
  const total = [0.1, 0.2, 0.3, 19.99, 0.01].map((v) => flatCharge("OTHER", "x", 1, "Stk", v).amount).reduce((s, v) => s + v, 0);
  assert.equal(Math.round(total * 100) / 100, 20.6);
  const p = calculateRentalPrice({ start: new Date("2026-01-01T08:00:00Z"), end: new Date("2026-01-04T08:00:00Z"), rates: { dailyRate: 33.33 }, discountPercent: 10 });
  assert.deepEqual([p.subtotal, p.discountAmount, p.total], [99.99, 10, 89.99]);
});

test("Zeitzone: Eingaben und Anzeigen laufen in Europe/Berlin, auch über die Umstellung, unabhängig vom Server", () => {
  const winter = parseLocalDateTime("2026-01-15T10:00")!;
  const summer = parseLocalDateTime("2026-07-15T10:00")!;
  assert.equal(winter.toISOString(), "2026-01-15T09:00:00.000Z");
  assert.equal(summer.toISOString(), "2026-07-15T08:00:00.000Z");
  assert.deepEqual([zoneOffsetMinutes(winter), zoneOffsetMinutes(summer)], [60, 120]);
  assert.equal(fmtDateTime(winter), "15.01.2026, 10:00");
  assert.equal(fmtDateTime(summer), "15.07.2026, 10:00");
  assert.equal(toDateTimeInputValue(summer), "2026-07-15T10:00");
  // Umstellung auf Sommerzeit 2027: 02:30 gibt es nicht, wird auf die nächste gültige Uhrzeit geschoben
  const gap = parseLocalDateTime("2027-03-28T02:30")!;
  assert.equal(gap.toISOString(), "2027-03-28T01:30:00.000Z");
  assert.equal(fmtDateTime(gap), "28.03.2027, 03:30");
  // Rückstellung 2026: 02:30 ist zweimal gültig, es wird eine der beiden genommen und rund um die Grenze stimmt die Anzeige
  const back = parseLocalDateTime("2026-10-25T02:30")!;
  assert.equal(fmtDateTime(back), "25.10.2026, 02:30");
  assert.equal(fmtDateTime(parseLocalDateTime("2026-10-25T04:00")!), "25.10.2026, 04:00");
  // Buchung 10:00 bis 10:00 über die Umstellung: Zeitgrenzen bleiben Wandzeit
  const a = parseLocalDateTime("2026-10-24T10:00")!;
  const b = parseLocalDateTime("2026-10-26T10:00")!;
  assert.equal((b.getTime() - a.getTime()) / 3600_000, 49);
  assert.equal(rentalDays(a, b), 3);
  for (const bad of ["", "2026-13-01T10:00", "2026-02-30T10:00", "2026-01-01T24:00", "gestern", "2026-10-25", null, 42]) assert.equal(parseLocalDateTime(bad), null, String(bad));
});

test("PDF-Fehler: beschädigtes Foto, beschädigte Unterschrift, fehlende oder falsche Skizze brechen nichts und ersetzen nichts still", async () => {
  const { renderHandoverPdf } = await import("../src/lib/pdf/handover-pdf");
  const { loadSketchSvg } = await import("../src/lib/documents");
  const { handoverData } = await import("./pdf-fixtures");
  const data = handoverData("full");
  const garbage = new Uint8Array(3000).fill(0x41);
  const photos = new Map(data.photos.map((p) => [p.id, garbage] as const));
  const signatures = new Map([["sig-renter", garbage], ["sig-employee", garbage]]);
  const { trace, bytes } = await renderHandoverPdf(data, { sketchSvg: null, photos, signatures });
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.deepEqual(trace.boxes.filter((b) => b.overflow), []);
  assert.ok(trace.notes.includes("Skizze nicht verfügbar"));
  assert.ok(trace.notes.some((n) => n.includes("nicht darstellbar")), "beschädigtes Foto wird als Hinweis gezeigt");
  assert.ok(trace.notes.some((n) => n.startsWith("Unterschrift RENTER ohne Bild")), "beschädigte Unterschrift wird als Hinweis gezeigt");
  assert.equal(trace.images.length, 0, "nichts Beschädigtes wird eingebettet");
  // falsche Skizzen-Prüfsumme: keine Skizze statt eine andere Datei
  assert.equal(await loadSketchSvg({ assetPath: "/sketches/generic-transporter-v2.svg", assetHash: "0".repeat(64) }), null);
  // sehr lange Texte
  const long = handoverData("full");
  long.notes = "Sehr lange Bemerkung. ".repeat(200);
  long.damages[0].description = "Beschreibung ".repeat(120);
  long.checklist[0].note = "Notiz ".repeat(150);
  const r = await renderHandoverPdf(long, { sketchSvg: null, photos: new Map(), signatures: new Map() });
  assert.deepEqual(r.trace.boxes.filter((b) => b.overflow), []);
});

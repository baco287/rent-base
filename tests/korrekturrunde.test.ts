// Befehl 27: Korrekturrunde nach dem Produkt-Audit. Jede Korrektur wird gegen die echte Serverlogik (lokale Datenbank)
// geprüft: Kautionsuntergrenze bei Nachträgen (inkl. Datenbank-Invariante und Parallelität), unbegrenzte Kilometer in der
// Rückgabe, sicheres Buchungsstorno, Zahlungsstand im Rechnungs-PDF, überfällige Mieten in Dispo/Verfügbarkeit, Tankgröße,
// Schaden ohne Protokoll, Fahrerkandidaten zum Tatzeitpunkt, Kundenakte-Links, wirksamer Vertragsstand, sichere
// Login-Weiterleitung, Dashboard-Links, Miettage über die Zeitumstellung, Fahrzeugstatus und Kilometerstand.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { roleAllows } from "../src/lib/constants";
import {
  addAmendmentDriver, contractKmPolicy, createAmendmentDraft, effectiveStateForBooking, getAmendmentContentHash, getAmendmentState, saveAmendmentSignature, setAmendmentDriverRemoval, signAmendment, updateAmendmentDraft,
} from "../src/lib/amendments";
import { driverCandidatesOf } from "../src/lib/authority";
import { cancellationCheck, changeBookingStatus, CANCELLATION_REASON_MAX } from "../src/lib/booking-status";
import { cancelBooking } from "../src/lib/cancellation";
import { findConflicts, isOverdue, occupiedUntil } from "../src/lib/bookings";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { createCreditNoteDraft, finalizeCounterDocument, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { customerBookings, customerFinance, paymentHref } from "../src/lib/customer-file";
import { loadDashboard } from "../src/lib/dashboard";
import { blockVehicleForCase, openDamageCase, releaseVehicleForCase } from "../src/lib/damage-cases";
import { registerDamagePhoto, reportDamage } from "../src/lib/damages";
import { applyDepositOffset } from "../src/lib/deposit-offset";
import { balanceOf, cancelDepositEvent, depositView, openDepositRows, recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { ensureInvoiceDocument } from "../src/lib/documents";
import { verifyDriverInOneStep } from "../src/lib/driver-verification";
import { startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { invoicePaymentBlock } from "../src/lib/invoice-view";
import { createGeneralInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, getInvoiceState, startInvoiceEdit, updateInvoiceDraft } from "../src/lib/invoices";
import { recordInvoicePayment } from "../src/lib/payments";
import { renderInvoicePdf } from "../src/lib/pdf/invoice-pdf";
import { rentalDays } from "../src/lib/pricing";
import { expectedRentalCents, recordRentalPayment } from "../src/lib/rental-payments";
import { buildComparison, confirmProposal, getReturnComparison } from "../src/lib/returns";
import { safeInternalPath } from "../src/lib/safe-redirect";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { parseLocalDateTime } from "../src/lib/time";
import { normalizeTankCapacity, updateVehicleMasterData, vehicleStatusHold } from "../src/lib/vehicle-master";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";
import { pickedUpWorld, returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-b27-"));
  storage = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const at = new Date(Date.now() - 60_000);
const nonce = (s: string) => `${s}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const track = <T extends { tenantId: string }>(w: T): T => { tenants.push(w.tenantId); return w; };

async function draft(w: World, label: string) {
  return (await createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: nonce(label) })).amendment;
}
async function renterSign(w: World, amendmentId: string) {
  return saveAmendmentSignature(w.tenantId, w.actor, amendmentId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(3), seenHash: await getAmendmentContentHash(w.tenantId, amendmentId) });
}
async function signed(w: World, amendmentId: string, now?: Date) {
  await renterSign(w, amendmentId);
  return (await signAmendment(w.tenantId, w.actor, amendmentId, now ? { now } : {})).amendment;
}
/** Unterschriebener Vertrag, Buchung RESERVED (vor der Übergabe). */
async function signedWorld(label: string, conditions: Record<string, unknown> = {}): Promise<World & { contractId: string }> {
  const w = track(await createWorld(label));
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof", ...conditions });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return { ...w, contractId: c.id };
}
const receivedOf = async (w: World) => {
  const dep = await db.securityDeposit.findFirst({ where: { tenantId: w.tenantId, bookingId: w.bookingId }, include: { events: true } });
  return dep ? { expected: dep.expectedAmountCents, received: balanceOf(dep.expectedAmountCents, dep.events).receivedCents } : null;
};

// ===========================================================================
// 2 · P0 Kautionsminderung durch Nachtrag
// ===========================================================================

test("Kaution 1–4: erhalten 500 → Reduzierung auf 300 abgelehnt (Klartext), auf 500 erlaubt, Erhöhung ohne Bewegung; ohne Eingang frei reduzierbar", async () => {
  const w = track(await pickedUpWorld("b27-dep-floor"));
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const a = await draft(w, "d1");
  // 1) Entwurf: Server lehnt ab, nichts gespeichert
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 30000 }), /Die vereinbarte Kaution kann nicht auf 300,00\s€ reduziert werden, da bereits 500,00\s€ Kaution als erhalten dokumentiert wurden\./);
  assert.equal((await db.contractAmendment.findUniqueOrThrow({ where: { id: a.id } })).newDepositCents, null);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 49999 }), /kann nicht auf 499,99\s€/);
  // 2) genau die erhaltene Kaution: erlaubt (wäre gleich der vereinbarten → eigene Meldung), daher Erhöhung 700 und danach 500
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 50000 }), /entspricht der bisherigen/);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 70000 });
  await signed(w, a.id);
  assert.deepEqual(await receivedOf(w), { expected: 70000, received: 50000 }, "Erhöhung: keine Kautionsbewegung");
  const b = await draft(w, "d2");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { newDepositCents: 50000 });
  await signed(w, b.id);
  assert.deepEqual(await receivedOf(w), { expected: 50000, received: 50000 });
  assert.equal(await db.payout.count({ where: { tenantId: w.tenantId } }), 0, "Reduzierung zahlt nichts automatisch aus");
  // 3) ohne erhaltene Kaution: Reduzierung bis 0 möglich
  const w2 = track(await pickedUpWorld("b27-dep-none"));
  const c = await draft(w2, "d3");
  await updateAmendmentDraft(w2.tenantId, w2.actor, c.id, { newDepositCents: 0 });
  await signed(w2, c.id);
  assert.equal((await depositView(w2.tenantId, w2.bookingId)).expectedCents, 0);
});

test("Kaution 5–6: stornierter Eingang zählt nicht; Unterschrift prüft erneut (Eingang nach dem Entwurf blockiert)", async () => {
  const w = track(await pickedUpWorld("b27-dep-cancel"));
  const r = await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await cancelDepositEvent(w.tenantId, w.actor, r.event.id, "Irrtümlich erfasst");
  const a = await draft(w, "c1");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 30000 });
  // Entwurf (300) liegt vor, danach gehen 400 Kaution ein (≤ vereinbarte 500, also zulässig)
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "400", method: "CASH", occurredAt: at });
  const st = await getAmendmentState(w.tenantId, a.id);
  assert.ok(st.issues.some((i) => i.code === "DEPOSIT_BELOW_RECEIVED" && /400,00\s€/.test(i.message)), JSON.stringify(st.issues));
  await renterSign(w, a.id);
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, a.id), /kann nicht auf 300,00\s€ reduziert werden, da bereits 400,00\s€/);
  assert.deepEqual(await receivedOf(w), { expected: 50000, received: 40000 }, "nichts verändert");
  // Freigaben/Einbehalte/Verrechnungen verteilen nur die erhaltene Kaution – „erhalten“ bleibt die Untergrenze
  const bal = balanceOf(50000, [{ type: "RECEIVED", amountCents: 50000, status: "CONFIRMED" }, { type: "RELEASED", amountCents: 20000, status: "CONFIRMED" }, { type: "RETAINED", amountCents: 10000, status: "CONFIRMED" }, { type: "RECEIVED", amountCents: 5000, status: "CANCELLED" }]);
  assert.equal(bal.receivedCents, 50000);
});

test("Kaution 7–8: Datenbank-Invariante – vereinbart nie unter erhalten, auch direkt per SQL; Erhöhung bleibt möglich", async () => {
  const w = track(await pickedUpWorld("b27-dep-db"));
  const a = await draft(w, "x1");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 30000 });
  await signed(w, a.id); // vereinbart 300, noch nichts erhalten
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "300", method: "CASH", occurredAt: at });
  await assert.rejects(() => recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "1", method: "CASH", occurredAt: at }), /mehr|übersteigt|vereinbart/i);
  const b = await draft(w, "x2");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { newDepositCents: 60000 });
  await signed(w, b.id);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "300", method: "CASH", occurredAt: at });
  const dep = await db.securityDeposit.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId: w.bookingId } });
  // Nachtrag A (300) ist unterschrieben – die Herkunftsprüfung des Triggers ließe 300 zu, die neue Untergrenze nicht
  await assert.rejects(() => db.securityDeposit.update({ where: { id: dep.id }, data: { expectedAmountCents: 30000 } }), /RB_DOMAIN: Die vereinbarte Kaution kann nicht unter die bereits erhaltene Kaution \(60000 Cent\)/);
  await assert.rejects(() => db.securityDeposit.update({ where: { id: dep.id }, data: { expectedAmountCents: 45000 } }), /RB_IMMUTABLE/, "ohne passenden Nachtrag ohnehin gesperrt");
  assert.deepEqual(await receivedOf(w), { expected: 60000, received: 60000 });
});

test("Kaution 9: parallel Kautionseingang und Unterschrift einer Reduzierung – genau einer gewinnt, Invariante hält", async () => {
  const w = track(await pickedUpWorld("b27-dep-race"));
  const a = await draft(w, "r1");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 30000 });
  await renterSign(w, a.id);
  const res = await Promise.allSettled([recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at }), signAmendment(w.tenantId, w.actor, a.id)]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(res.map((r) => r.status === "rejected" ? String(r.reason) : "ok")));
  const s = await receivedOf(w);
  if (s) assert.ok(s.received <= s.expected, `erhalten ${s.received} ≤ vereinbart ${s.expected}`);
});

test("Kaution 10: offene Kautionen (Dashboard) nach wirksamem Vertragsstand; fremder Mandant sieht/ändert nichts", async () => {
  const w = track(await pickedUpWorld("b27-dep-dash"));
  const a = await draft(w, "dd");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 70000 });
  await signed(w, a.id);
  const rows = await openDepositRows(w.tenantId);
  const row = rows.expectedActive.find((b) => b.id === w.bookingId);
  assert.equal(row?.expectedDepositCents, 70000, "vereinbart laut Nachtrag, nicht laut Original (500)");
  const dash = await loadDashboard(w.tenantId);
  const task = dash.tasks.find((t) => t.key === `deposit-expected-${w.bookingId}`);
  assert.match(task?.detail ?? "", /vereinbart 700,00\s€/);
  const b = await draft(w, "dd0");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { newDepositCents: 0 });
  await signed(w, b.id);
  assert.equal((await openDepositRows(w.tenantId)).expectedActive.some((x) => x.id === w.bookingId), false, "Kaution 0 → keine offene Kaution");
  const other = track(await createWorld("b27-dep-other"));
  await assert.rejects(() => updateAmendmentDraft(other.tenantId, other.actor, b.id, { newDepositCents: 1 }), /nicht gefunden/);
  assert.equal((await openDepositRows(other.tenantId)).expectedActive.some((x) => x.id === w.bookingId), false);
});

// ===========================================================================
// 3 · Unbegrenzte Kilometer in der Rückgabe
// ===========================================================================

/** Reiner Rückgabevergleich: 2 Miettage, 1.000 km gefahren, 200 km/Tag frei, 0,25 €/km. */
function compare(o: { policy?: string | null; amendedPolicy?: "UNLIMITED" | "FREE_KILOMETERS"; tankSnapshot?: number | null; vehicleTank?: number | null; fuelBack?: number; rate?: number }) {
  const start = new Date("2026-11-02T08:00:00Z");
  const end = new Date("2026-11-04T08:00:00Z");
  const handover = { id: "r", number: "RP-1", extraCharges: [], dismissedProposals: [], driveType: "DIESEL", mileage: 11_000, fuelLevelEighths: o.fuelBack ?? 8, batteryPercent: null, finalizedAt: end, returnTimeOverrideAt: null, customerDropOffAt: null, fuelPricePerLiter: null };
  const pickup = { id: "p", number: "UP-1", mileage: 10_000, fuelLevelEighths: 8, batteryPercent: null, finalizedAt: start };
  const contract = {
    number: "MV-1", startAt: start, endAt: end, kmIncludedPerDay: 200, extraKmRate: String(o.rate ?? 0.25), fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: "1.80", deposit: "500", deductible: "1000",
    vehicleSnapshot: o.tankSnapshot != null ? { tankCapacityLiters: o.tankSnapshot } : {},
    conditions: o.policy ? { rulesVersion: 1, values: { kmPolicy: o.policy }, sources: {} } : null,
    ...(o.amendedPolicy ? { amended: { numbers: ["NT-2026-000001"], kmPolicy: o.amendedPolicy } } : {}),
  };
  return buildComparison({ handover, booking: { startAt: start, endAt: end, actualPickupAt: start }, contract, pickup, vehicleTankLiters: o.vehicleTank ?? null } as unknown as Parameters<typeof buildComparison>[0]);
}

test("Kilometer: FREE und INDIVIDUAL rechnen Mehrkilometer; UNLIMITED (auch mit hinterlegtem Preis) nie; alte Verträge ohne Regel = Freikilometer", () => {
  const free = compare({ policy: "FREE_KILOMETERS" });
  const p = free.proposals.find((x) => x.key === "EXTRA_MILEAGE");
  assert.ok(p, "Mehrkilometer-Vorschlag");
  assert.equal(p!.draft.quantity, 600); assert.equal(p!.draft.amount, 150);
  assert.equal(free.contract.includedKm, 400);
  const indiv = compare({ policy: "INDIVIDUAL" });
  assert.equal(indiv.proposals.find((x) => x.key === "EXTRA_MILEAGE")?.draft.amount, 150, "individuell: vereinbarte Werte des Vertrags");
  for (const rate of [0.25, 1.5]) {
    const un = compare({ policy: "UNLIMITED", rate });
    assert.equal(un.proposals.some((x) => x.key === "EXTRA_MILEAGE"), false, `UNLIMITED mit ${rate} €/km: kein Vorschlag`);
    assert.equal(un.contract.kmPolicy, "UNLIMITED"); assert.equal(un.contract.includedKm, null);
    assert.ok(un.hints.some((h) => h.code === "KM_UNLIMITED" && /keine Mehrkilometer/.test(h.text)));
    assert.equal(un.mileage.driven, 1000, "Kilometerstand wird trotzdem dokumentiert");
  }
  // alte, versiegelte Verträge ohne Regel-Schnappschuss: unverändert Freikilometer
  assert.equal(contractKmPolicy(null), "FREE_KILOMETERS");
  assert.equal(contractKmPolicy({ foo: 1 }), "FREE_KILOMETERS");
  const legacy = compare({ policy: null });
  assert.equal(legacy.proposals.find((x) => x.key === "EXTRA_MILEAGE")?.draft.amount, 150);
  // Nachtrag überschreibt die Vertragsregel (wirksamer Stand)
  assert.equal(compare({ policy: "FREE_KILOMETERS", amendedPolicy: "UNLIMITED" }).proposals.some((x) => x.key === "EXTRA_MILEAGE"), false);
  assert.ok(compare({ policy: "UNLIMITED", amendedPolicy: "FREE_KILOMETERS" }).proposals.some((x) => x.key === "EXTRA_MILEAGE"));
});

test("Kilometer: Vertrag mit „Unbegrenzt“ → Rückgabe ohne Mehrkilometer, Bestätigen nicht möglich; Nachtrag FREE → UNLIMITED wirkt in der Rückgabe", async () => {
  const w = track(await pickedUpWorld("b27-km-unl", { conditions: { rules: { kmPolicy: "UNLIMITED" } } }));
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 49_000, fuelLevelEighths: 7 });
  const cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.contract.kmPolicy, "UNLIMITED");
  assert.equal(cmp.proposals.some((x) => x.key === "EXTRA_MILEAGE"), false);
  assert.equal(cmp.mileage.driven, 49_000 - 45_210);
  await assert.rejects(() => confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE"));
  assert.equal(await db.extraCharge.count({ where: { tenantId: w.tenantId, type: "EXTRA_MILEAGE" } }), 0);

  const v = track(await pickedUpWorld("b27-km-amend"));
  const a = await draft(v, "km");
  await assert.rejects(() => updateAmendmentDraft(v.tenantId, v.actor, a.id, { newKmPolicy: "FREE_KILOMETERS" }), /bereits vereinbart/);
  await updateAmendmentDraft(v.tenantId, v.actor, a.id, { newKmPolicy: "UNLIMITED" });
  const st = await getAmendmentState(v.tenantId, a.id);
  assert.match(st.changes.find((c) => c.kind === "KM")?.after ?? "", /Unbegrenzt/);
  const row = await signed(v, a.id);
  assert.equal((row.snapshot as { after: { kmPolicy: string } }).after.kmPolicy, "UNLIMITED");
  const c0 = await db.rentalContract.findUniqueOrThrow({ where: { id: v.contractId } });
  assert.equal(contractKmPolicy(c0.conditions), "FREE_KILOMETERS", "Originalvertrag unverändert");
  const r2 = await startHandover(v.tenantId, v.bookingId, "RETURN", v.actor);
  await updateHandoverDraft(v.tenantId, r2.id, { mileage: 49_000, fuelLevelEighths: 7 });
  const cmp2 = await getReturnComparison(v.tenantId, r2.id);
  assert.equal(cmp2.contract.kmPolicy, "UNLIMITED");
  assert.equal(cmp2.proposals.some((x) => x.key === "EXTRA_MILEAGE"), false);
  assert.ok(cmp2.contract.amendmentNumbers.includes(row.number!));
  // begonnene Rückgabe: Kilometerregel nicht mehr per Nachtrag änderbar
  const b = await draft(v, "km2");
  await updateAmendmentDraft(v.tenantId, v.actor, b.id, { newKmPolicy: "FREE_KILOMETERS" });
  assert.ok((await getAmendmentState(v.tenantId, b.id)).issues.some((i) => i.code === "RETURN_STARTED"));
});

test("Kilometer: abgeschlossene Rückgabe eines alten Vertrags bleibt unverändert (versiegelter Vergleich, gleiche Position)", async () => {
  const w = track(await returnedWorld("b27-km-sealed"));
  const charge = await db.extraCharge.findUniqueOrThrow({ where: { id: w.charges.mileageId } });
  assert.equal(Number(charge.amount), 200, "800 km × 0,25 €");
  const cmp = await getReturnComparison(w.tenantId, w.returnId);
  assert.equal(cmp.contract.kmPolicy, "FREE_KILOMETERS");
  assert.equal(cmp.proposals.find((p) => p.key === "EXTRA_MILEAGE")?.draft.amount, 200);
});

// ===========================================================================
// 4 · Buchungsstorno
// ===========================================================================

test("Storno: Grund Pflicht (Server), Benutzer Pflicht, Länge begrenzt; Erfolg speichert Grund, Benutzer, Zeit und Audit", async () => {
  const w = track(await createWorld("b27-cancel"));
  await assert.rejects(() => changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "" }), /Grund der Stornierung/);
  await assert.rejects(() => changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "  a " }), /Grund der Stornierung/);
  await assert.rejects(() => changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { reason: "Kunde sagt ab" }), /angemeldeten Benutzer/);
  await assert.rejects(() => changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "x".repeat(CANCELLATION_REASON_MAX + 1) }), /zu lang/);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "RESERVED");
  // Datenbank: ein Grund ohne Storno ist unzulässig
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { cancellationReason: "nur Grund" } }), /rb_booking_cancellation|check/i);

  const chk = await cancellationCheck(w.tenantId, w.bookingId);
  assert.equal(chk.allowed, true);
  assert.equal(chk.booking.customerName, "Erika Muster");
  assert.match(chk.booking.plate, /^HB-T/);
  await changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "  Kunde hat   telefonisch abgesagt " });
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.status, "CANCELLED");
  assert.equal(b.cancellationReason, "Kunde hat telefonisch abgesagt");
  assert.equal(b.cancelledById, w.actor.id); assert.equal(b.cancelledByName, w.actor.name);
  assert.ok(b.cancelledAt && Math.abs(b.cancelledAt.getTime() - Date.now()) < 60_000);
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: "BOOKING_CANCELLED" } });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].bookingId, w.bookingId); assert.equal(audit[0].userId, w.actor.id);
  const d = audit[0].details as { bookingNumber: string; reason: string; previousStatus: string };
  assert.equal(d.bookingNumber, b.number); assert.equal(d.reason, "Kunde hat telefonisch abgesagt"); assert.equal(d.previousStatus, "Reserviert");
  // bereits storniert: nicht noch einmal, kein zweiter Audit-Eintrag
  await assert.rejects(() => changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "nochmal" }), /bereits storniert/);
  assert.equal((await cancellationCheck(w.tenantId, w.bookingId)).allowed, false);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "BOOKING_CANCELLED" } }), 1);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).cancellationReason, "Kunde hat telefonisch abgesagt");
});

test("Storno: Doppelklick (parallel) storniert genau einmal; fremder Mandant findet die Buchung nicht", async () => {
  const w = track(await createWorld("b27-cancel-dbl"));
  const res = await Promise.allSettled([1, 2].map(() => changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "Doppelt geklickt" })));
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rej.reason), /bereits storniert/);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "BOOKING_CANCELLED" } }), 1);
  const other = track(await createWorld("b27-cancel-other"));
  const x = track(await createWorld("b27-cancel-x"));
  await assert.rejects(() => changeBookingStatus(other.tenantId, x.bookingId, "CANCELLED", { actor: other.actor, reason: "fremd" }), /nicht gefunden/);
  await assert.rejects(() => cancellationCheck(other.tenantId, x.bookingId), /nicht gefunden/);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: x.bookingId } })).status, "RESERVED");
});

// Befehl 28: Storno mit Geld ist jetzt über den Storno-Assistenten möglich – statt der Sperre (Befehl 27) verlangt der Server
// eine bewusste Entscheidung zu Kaution bzw. Mietvorauszahlung; ohne Entscheidung wird nichts storniert.
test("Storno: Vertrag wird mit storniert (Historie bleibt), Kaution/Mietzahlung verlangen eine Entscheidung (Befehl 28)", async () => {
  const w = await signedWorld("b27-cancel-contract");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const chk = await cancellationCheck(w.tenantId, w.bookingId);
  assert.equal(chk.allowed, true);
  assert.ok(chk.warnings.some((x) => /bereits ein Mietvertrag erstellt \(MV-/.test(x)), JSON.stringify(chk.warnings));
  await assert.rejects(() => changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "Fahrzeug defekt" }), /erhaltenen Kaution \(500,00\s€\)/);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "RESERVED");
  await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Fahrzeug defekt, Kunde informiert", deposit: { mode: "KEEP" } });
  const c = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal(c.status, "CANCELLED"); assert.ok(c.contentHash, "Inhalt bleibt erhalten");
  const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "BOOKING_CANCELLED" } });
  assert.match(String((audit.details as { contract: string }).contract), /MV-.*SIGNED/);
  // Kaution: bestehender Weg nach Storno
  await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "500", method: "CASH", occurredAt: new Date() });
  assert.equal((await depositView(w.tenantId, w.bookingId)).remainingCents, 0);

  const p = track(await createWorld("b27-cancel-paid"));
  const pay = await recordRentalPayment(p.tenantId, p.actor, p.bookingId, { amount: "100", method: "CASH", paidAt: at });
  const pc = await cancellationCheck(p.tenantId, p.bookingId);
  assert.equal(pc.allowed, true, "Befehl 28: nicht mehr gesperrt");
  await assert.rejects(() => changeBookingStatus(p.tenantId, p.bookingId, "CANCELLED", { actor: p.actor, reason: "Kunde sagt ab" }), /Mietvorauszahlung geschieht: 100,00\s€/);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: p.bookingId } })).status, "RESERVED");
  assert.equal(await db.payment.count({ where: { tenantId: p.tenantId, id: pay.payment.id, status: "CONFIRMED" } }), 1, "Zahlung unverändert");
});

test("Storno: Rollen und Supportmodus – Aktion nur DISPO/OWNER (requireRole ist im Supportmodus immer read-only), Hofmitarbeiter nie", () => {
  assert.equal(roleAllows("OWNER", ["DISPO"]), true);
  assert.equal(roleAllows("DISPO", ["DISPO"]), true);
  assert.equal(roleAllows("YARD", ["DISPO"]), false);
  const actions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/actions.ts"), "utf8");
  const fn = /export async function cancelBookingAction[\s\S]*?\n}/.exec(actions)?.[0] ?? "";
  assert.match(fn, /requireRole\("DISPO"\)/);
  assert.match(fn, /cancelBooking\(tenant\.id, actor, id, cancellationInputOf\(formData\)\)/);
  const auth = readFileSync(path.join(process.cwd(), "src/lib/auth.ts"), "utf8");
  assert.match(auth, /export async function requireRole[\s\S]*?if \(session\.supportSession\) redirect\("\/heute\?fehler=support"\)/, "Supportmodus: keine Schreibaktion");
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/page.tsx"), "utf8");
  assert.match(page, /user\.role !== "YARD" && !supportSession \? await cancellationOverview/, "Dialog weder für Hofmitarbeiter noch im Supportmodus");
});

// ===========================================================================
// 5 · Rechnungs-PDF: Zahlungsstand
// ===========================================================================

async function invoiceWorld(label: string, gross: string) {
  const w = track(await returnedWorld(label, { tenant: { iban: "DE02120300000000202051", bankName: "Testbank" } }));
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const st = await getInvoiceState(w.tenantId, inv.id);
  const items = st.draft!.items;
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: items[0].id, description: items[0].description, quantity: "1", unit: "pauschal", unitPrice: gross, taxRate: "19" }] });
  const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  return { w, invoiceId: inv.id, v1 };
}
const pdfText = async (versionId: string, tenantId: string) => (await renderInvoicePdf((await loadInvoiceDocumentData(tenantId, versionId)).doc)).trace.texts.join(" ¦ ");

test("Rechnungs-PDF: unbezahlt → Zahlungsaufforderung über den Rechnungsbetrag; teilbezahlt → bezahlt/offen; voll → keine Zahlungsaufforderung", async () => {
  const { w, invoiceId, v1 } = await invoiceWorld("b27-pdf", "400");
  const d0 = await loadInvoiceDocumentData(w.tenantId, v1.id);
  assert.equal(d0.doc.paymentStatus, null, "nichts gezahlt: kein Saldoblock");
  const t0 = await pdfText(v1.id, w.tenantId);
  assert.match(t0, /Zahlbar bis/); assert.match(t0, /IBAN/);
  assert.doesNotMatch(t0, /Noch offen/);

  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "150", method: "CASH", paidAt: at });
  const d1 = (await loadInvoiceDocumentData(w.tenantId, v1.id)).doc.paymentStatus!;
  assert.deepEqual(d1.lines.map((l) => `${l.label}=${l.value}`.replace(/\u00a0/g, " ")), ["Rechnungsbetrag=400,00 €", "Bereits bezahlt=− 150,00 €", "Noch offen=250,00 €"]);
  assert.equal(d1.settled, false);
  const t1 = await pdfText(v1.id, w.tenantId);
  assert.match(t1, /Bereits bezahlt/); assert.match(t1, /Noch offen/);
  assert.match(t1, /Bitte zahlen Sie den offenen Betrag von 250,00\s€/);
  assert.doesNotMatch(t1, /Zahlbar bis .*\(\d+ Tage nach Rechnungsdatum\)/, "keine Aufforderung über den vollen Betrag");

  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "250", method: "BANK_TRANSFER", paidAt: at });
  const d2 = (await loadInvoiceDocumentData(w.tenantId, v1.id)).doc.paymentStatus!;
  assert.equal(d2.settled, true); assert.equal(d2.openCents, 0);
  const t2 = await pdfText(v1.id, w.tenantId);
  assert.match(t2, /vollständig ausgeglichen\. Es ist keine Zahlung mehr erforderlich/);
  assert.doesNotMatch(t2, /Bitte zahlen|Bitte überweisen|Zahlbar bis/);
  assert.doesNotMatch(t2, /IBAN/, "keine Bankverbindung als Zahlungsaufforderung");
  // Rechnungsbetrag und Positionen bleiben unverändert (Saldo ist keine Rechnungsposition)
  const vAfter = await db.invoiceVersion.findUniqueOrThrow({ where: { id: v1.id }, include: { items: true } });
  assert.equal(String(vAfter.grossTotal), String(v1.grossTotal)); assert.equal(vAfter.contentHash, v1.contentHash); assert.equal(vAfter.items.length, v1.items.length);
});

test("Rechnungs-PDF: Kautionsverrechnung als Ausgleich (nicht als Zahlung), Zahlung + Verrechnung, Gutschrift, nie negativ", async () => {
  const { w, invoiceId, v1 } = await invoiceWorld("b27-pdf-offset", "600");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "500", occurredAt: at });
  const d1 = (await loadInvoiceDocumentData(w.tenantId, v1.id)).doc.paymentStatus!;
  assert.deepEqual(d1.lines.map((l) => l.label), ["Rechnungsbetrag", "Mit Kaution verrechnet", "Noch offen"], "keine Zeile „Bereits bezahlt“");
  assert.equal(d1.openCents, 10000);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "100", method: "CASH", paidAt: at });
  const d2 = (await loadInvoiceDocumentData(w.tenantId, v1.id)).doc.paymentStatus!;
  assert.deepEqual(d2.lines.map((l) => `${l.label}=${l.value}`.replace(/\u00a0/g, " ")), ["Rechnungsbetrag=600,00 €", "Bereits bezahlt=− 100,00 €", "Mit Kaution verrechnet=− 500,00 €", "Noch offen=0,00 €"]);
  assert.equal(d2.settled, true);
  const t2 = await pdfText(v1.id, w.tenantId);
  assert.match(t2, /Mit Kaution verrechnet/); assert.match(t2, /keine Zahlung mehr erforderlich/);

  // Gutschrift nach voller Zahlung: Forderung sinkt, Guthaben wird ausgewiesen, „Noch offen“ bleibt 0 (nie negativ)
  const g = await invoiceWorld("b27-pdf-credit", "300");
  await recordInvoicePayment(g.w.tenantId, g.w.actor, { invoiceId: g.invoiceId, amount: "300", method: "CASH", paidAt: at });
  const cn = await createCreditNoteDraft(g.w.tenantId, g.invoiceId, g.w.actor);
  await updateCounterDocumentDraft(g.w.tenantId, cn.id, g.w.actor, { items: [{ sourceItemId: g.v1.items[0].id, mode: "AMOUNT", grossAmount: "50" }], reason: "Kulanz" });
  await finalizeCounterDocument(g.w.tenantId, cn.id, g.w.actor, { confirmed: true });
  const d3 = (await loadInvoiceDocumentData(g.w.tenantId, g.v1.id)).doc.paymentStatus!;
  assert.deepEqual(d3.lines.map((l) => `${l.label}=${l.value}`.replace(/\u00a0/g, " ")), ["Rechnungsbetrag=300,00 €", "abzüglich Gutschriften=− 50,00 €", "Bereits bezahlt=− 300,00 €", "Noch offen=0,00 €"]);
  assert.equal(d3.creditCents, 5000);
  assert.match(await pdfText(g.v1.id, g.w.tenantId), /Guthaben von 50,00\s€ zu Ihren Gunsten/);
  // reine Ableitung: nie negativ, ohne Minderung kein Block
  assert.equal(invoicePaymentBlock({ invoiceCents: 100, creditedCents: 0, cancelledCents: 0, paidCents: 0, offsetCents: 0, openCents: 100, customerCreditCents: 0 }, new Date()), null);
  assert.equal(invoicePaymentBlock({ invoiceCents: 100, creditedCents: 200, cancelledCents: 0, paidCents: 0, offsetCents: 0, openCents: -100, customerCreditCents: 0 }, new Date())!.openCents, 0);
});

test("Rechnungs-PDF: archiviertes PDF und ältere Fassung bleiben unverändert; Saldo nur auf der aktuellen Fassung; Gegenbelege ohne Saldo", async () => {
  await ready;
  const { w, invoiceId, v1 } = await invoiceWorld("b27-pdf-hist", "200");
  const doc1 = await ensureInvoiceDocument(w.tenantId, v1.id, w.actor.id, { storage });
  assert.equal(doc1.created, true);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "50", method: "CASH", paidAt: at });
  const doc2 = await ensureInvoiceDocument(w.tenantId, v1.id, w.actor.id, { storage });
  assert.equal(doc2.created, false, "archiviertes PDF wird nicht neu erzeugt");
  assert.equal(doc2.document.id, doc1.document.id); assert.equal(doc2.document.checksum, doc1.document.checksum);
  assert.equal(await db.document.count({ where: { tenantId: w.tenantId, invoiceVersionId: v1.id } }), 1);
  // Korrekturfassung: die alte Fassung zeigt keinen Saldo (nur die aktuelle)
  const d = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items: [{ id: d.items[0].id, description: d.items[0].description, quantity: "1", unit: "pauschal", unitPrice: "220", taxRate: "19" }], reason: "Preis korrigiert" });
  const v2 = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  assert.equal((await loadInvoiceDocumentData(w.tenantId, v1.id)).doc.paymentStatus, null, "frühere Fassung: unverändert ohne Saldo");
  const cur = (await loadInvoiceDocumentData(w.tenantId, v2.id)).doc.paymentStatus!;
  assert.equal(cur.openCents, 17000);
  const old = await db.invoiceVersion.findUniqueOrThrow({ where: { id: v1.id } });
  assert.equal(old.contentHash, v1.contentHash, "versiegelte Fassung unverändert");
});

// ===========================================================================
// 6 · Dispo / Verfügbarkeit: überfällige Mieten
// ===========================================================================

test("Überfällig: laufende Miete nach geplantem Ende belegt das Fahrzeug bis jetzt – Konfliktprüfung und Dispo nutzen dieselbe Regel", async () => {
  const end = new Date("2026-10-10T08:00:00Z");
  assert.equal(isOverdue({ status: "ACTIVE", endAt: end }, new Date(end.getTime() + 1)), true);
  assert.equal(isOverdue({ status: "ACTIVE", endAt: end }, new Date(end.getTime() - 1)), false);
  assert.equal(isOverdue({ status: "RESERVED", endAt: end }, new Date(end.getTime() + DAY)), false, "nicht abgeholte Reservierung ist nicht „überfällig“");
  const now = new Date(end.getTime() + 5 * 3600_000);
  assert.equal(occupiedUntil({ status: "ACTIVE", endAt: end }, now).getTime(), now.getTime());
  assert.equal(occupiedUntil({ status: "RETURNED", endAt: end }, now).getTime(), end.getTime());

  const w = track(await pickedUpWorld("b27-overdue"));
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.status, "ACTIVE");
  const later = new Date(b.endAt.getTime() + DAY); // simuliertes „jetzt“: einen Tag nach dem geplanten Ende
  const ids = async (from: Date, to: Date, n: Date) => (await findConflicts(db, w.tenantId, w.vehicleId, from, to, undefined, n)).map((x) => x.id);
  assert.deepEqual(await ids(new Date(b.endAt.getTime() + 3600_000), new Date(b.endAt.getTime() + 5 * 3600_000), later), [w.bookingId], "überfällig: Folgebuchung kollidiert");
  assert.deepEqual(await ids(new Date(b.endAt.getTime() + 3600_000), new Date(b.endAt.getTime() + 5 * 3600_000), new Date(b.endAt.getTime() - 3600_000)), [], "noch nicht überfällig: kein Konflikt");
  assert.deepEqual(await ids(new Date(later.getTime() + 3600_000), new Date(later.getTime() + 2 * 3600_000), later), [], "Zeitraum nach „jetzt“ bleibt frei");
  const dispo = readFileSync(path.join(process.cwd(), "src/app/(app)/dispo/page.tsx"), "utf8");
  assert.match(dispo, /occupyingWhere\(/); assert.match(dispo, /Rückgabe überfällig/); assert.match(dispo, /occupiedUntil\(/);
});

// ===========================================================================
// 7 · Tankgröße
// ===========================================================================

test("Tankgröße: Validierung, Elektro ohne Tank, Datenbankgrenze, Rückgabe nutzt die Fahrzeugangabe als Ersatz", async () => {
  assert.equal(normalizeTankCapacity("DIESEL", 60), 60);
  assert.equal(normalizeTankCapacity("DIESEL", null), null);
  assert.equal(normalizeTankCapacity("ELEKTRO", 60), null, "Elektro: keine Tankgröße");
  for (const bad of [4, 301, 60.5, -1]) assert.throws(() => normalizeTankCapacity("BENZIN", bad), /ganze Liter zwischen 5 und 300/);
  const w = track(await createWorld("b27-tank"));
  await assert.rejects(() => db.vehicle.update({ where: { id: w.vehicleId }, data: { tankCapacityLiters: 0 } }), /rb_vehicle_tank_capacity|check/i);
  await updateVehicleMasterData(w.tenantId, w.actor, w.vehicleId, { status: "AVAILABLE", mileage: 50_000, fuel: "DIESEL", tankCapacityLiters: 80 });
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).tankCapacityLiters, 80);
  await assert.rejects(() => updateVehicleMasterData(w.tenantId, w.actor, w.vehicleId, { status: "AVAILABLE", mileage: 50_000, fuel: "DIESEL", tankCapacityLiters: 1000 }), /ganze Liter/);
  await updateVehicleMasterData(w.tenantId, w.actor, w.vehicleId, { status: "AVAILABLE", mileage: 50_000, fuel: "ELEKTRO", tankCapacityLiters: 80 });
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).tankCapacityLiters, null);
  // Rückgabe: Vertrags-Schnappschuss hat Vorrang; fehlt er (ältere Verträge), gilt die Fahrzeugangabe
  const snap = compare({ fuelBack: 4, tankSnapshot: 60, vehicleTank: 80 });
  assert.equal(snap.proposals.find((p) => p.key === "FUEL")?.draft.quantity, 30);
  assert.equal(snap.contract.tankCapacityLiters, 60);
  const veh = compare({ fuelBack: 4, tankSnapshot: null, vehicleTank: 80 });
  const fuel = veh.proposals.find((p) => p.key === "FUEL");
  assert.equal(fuel?.draft.quantity, 40); assert.equal(fuel?.draft.calculation.tankOrigin, "Fahrzeug");
  const none = compare({ fuelBack: 4, tankSnapshot: null, vehicleTank: null });
  assert.equal(none.proposals.some((p) => p.key === "FUEL"), false);
  assert.ok(none.hints.some((h) => h.code === "FUEL_NO_BASIS"));
});

// ===========================================================================
// 8 · Schaden ohne Protokoll
// ===========================================================================

test("Schaden manuell erfassen: Validierung, Herkunft ohne Protokoll, Historie + Audit, keine Belastung; erscheint in der nächsten Übergabe", async () => {
  const w = await signedWorld("b27-damage");
  const base = { vehicleId: w.vehicleId, view: "REAR", posX: 0.4, posY: 0.5, kind: "DENT", severity: "MINOR", description: "Delle Stoßstange hinten" };
  await assert.rejects(() => reportDamage(w.tenantId, w.actor, { ...base, description: "x" }), /kurz beschreiben/);
  await assert.rejects(() => reportDamage(w.tenantId, w.actor, { ...base, view: "UNDER" }), /Fahrzeugbereich/);
  await assert.rejects(() => reportDamage(w.tenantId, w.actor, { ...base, kind: "FOO" }), /Schadenart/);
  await assert.rejects(() => reportDamage(w.tenantId, w.actor, { ...base, posX: 1.2 }), /0 bis 1/);
  await assert.rejects(() => reportDamage(w.tenantId, w.actor, { ...base, discoveredAt: new Date(Date.now() + DAY) }), /Zukunft/);
  const other = track(await createWorld("b27-damage-other"));
  await assert.rejects(() => reportDamage(other.tenantId, other.actor, base), /nicht gefunden/i);

  const discoveredAt = new Date(Date.now() - 3600_000);
  const d = await reportDamage(w.tenantId, w.actor, { ...base, discoveredAt, note: "beim Waschen entdeckt", size: " ca. 5 cm " });
  assert.equal(d.discoveredInHandoverId, null, "Herkunft: manuell erfasst");
  assert.equal(d.note, "beim Waschen entdeckt"); assert.equal(d.size, "ca. 5 cm");
  assert.equal(d.discoveredAt.getTime(), discoveredAt.getTime());
  const ev = await db.vehicleEvent.findFirstOrThrow({ where: { tenantId: w.tenantId, damageId: d.id, type: "DAMAGE_DISCOVERED" } });
  assert.match(ev.description ?? "", /^Manuell erfasst: Delle Stoßstange hinten/);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "DAMAGE_REPORTED" } }), 1);
  assert.equal(await db.extraCharge.count({ where: { tenantId: w.tenantId } }), 0, "keine Belastung");
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0, "keine Rechnung");
  assert.equal(await db.damageCase.count({ where: { tenantId: w.tenantId } }), 0, "keine Schadenakte ohne bewusste Eröffnung");
  // Foto zum manuellen Schaden
  const photo = await registerDamagePhoto(w.tenantId, w.actor, d.id, { storageKey: `tenants/${w.tenantId}/photos/x.jpg`, contentType: "image/jpeg", sizeBytes: 1000, checksum: "a".repeat(64) });
  assert.equal(photo.damageId, d.id);
  await assert.rejects(() => registerDamagePhoto(other.tenantId, other.actor, d.id, { storageKey: "k", contentType: "image/jpeg", sizeBytes: 1, checksum: "b".repeat(64) }), /nicht gefunden/);
  // nächste Übergabe übernimmt ihn als Vorschaden
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  const hd = await db.handoverDamage.findFirstOrThrow({ where: { tenantId: w.tenantId, handoverId: h.id, damageId: d.id } });
  assert.equal(hd.marker, "EXISTING");
  // Schaden aus einem Protokoll: Fotos gehören dorthin
  const r = track(await returnedWorld("b27-damage-proto"));
  const fromProtocol = await db.damage.findFirstOrThrow({ where: { tenantId: r.tenantId, discoveredInHandoverId: r.returnId } });
  await assert.rejects(() => registerDamagePhoto(r.tenantId, r.actor, fromProtocol.id, { storageKey: "k", contentType: "image/jpeg", sizeBytes: 1, checksum: "c".repeat(64) }), /gehören zum Protokoll/);
  // Rollen: Erfassen DISPO und YARD (wie Schäden im Protokoll), Foto-Upload nur schreibend, nie im Supportmodus
  const act = readFileSync(path.join(process.cwd(), "src/app/(app)/fahrzeuge/[id]/damage-actions.ts"), "utf8");
  assert.match(act, /requireRole\("DISPO", "YARD"\)/);
  const route = readFileSync(path.join(process.cwd(), "src/app/api/damages/[id]/photos/route.ts"), "utf8");
  assert.match(route, /apiSession\("write"\)/);
});

// ===========================================================================
// 9 · Behörden: Fahrerkandidaten zum Tatzeitpunkt
// ===========================================================================

const DRIVER = { customerId: null, firstName: "Max", lastName: "Beifahrer", birthDate: new Date("1990-05-05"), street: "Weg 2", zip: "28195", city: "Bremen", country: "DE", licenseNumber: "Z999", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2032-01-01"), licenseCountry: "DE", licenseIssuedBy: null };
const CHECK = { documentType: "PERSONALAUSWEIS", licenseNumber: "Z999", licenseCountry: "DE", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2032-01-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false, manualReviewConfirmed: false, deviationConfirmed: false, notes: null };

test("Fahrerkandidaten: Zusatzfahrer erst ab Unterschrift des Nachtrags, Herausnahme nicht rückwirkend, Entwürfe nie; Tattag ohne Uhrzeit", async () => {
  const w = await signedWorld("b27-auth-drivers");
  const names = async (offenseAt: Date, offenseTimeKnown = true) => (await driverCandidatesOf(db, w.tenantId, w.contractId, { offenseAt, offenseTimeKnown })).map((d) => d.firstName).sort();
  const t1 = parseLocalDateTime("2026-10-05T12:00")!; // Aufnahme Max
  const t2 = parseLocalDateTime("2026-10-08T12:00")!; // Herausnahme Max
  const a = await draft(w, "add");
  const d = await addAmendmentDriver(w.tenantId, w.actor, a.id, DRIVER);
  // Entwurf: nie Kandidat
  assert.deepEqual(await names(parseLocalDateTime("2026-10-06T12:00")!), ["Erika"]);
  const res = await verifyDriverInOneStep(w.tenantId, w.actor, { amendmentId: a.id }, d.id, CHECK);
  assert.equal(res.confirmed, true, res.blockers.join(","));
  await signed(w, a.id, t1);
  assert.deepEqual(await names(new Date(t1.getTime() - 60_000)), ["Erika"], "Tat vor der Unterschrift: nicht rückwirkend");
  assert.deepEqual(await names(new Date(t1.getTime() + 60_000)), ["Erika", "Max"]);
  assert.deepEqual(await names(parseLocalDateTime("2026-10-05T08:00")!, false), ["Erika", "Max"], "nur Tattag bekannt: Aufnahme am selben Tag zählt");
  assert.deepEqual(await names(parseLocalDateTime("2026-10-04T08:00")!, false), ["Erika"]);
  const b = await draft(w, "remove");
  await setAmendmentDriverRemoval(w.tenantId, b.id, d.id, true);
  assert.deepEqual(await names(new Date(t2.getTime() + 60_000)), ["Erika", "Max"], "Herausnahme als Entwurf wirkt nicht");
  await signed(w, b.id, t2);
  assert.deepEqual(await names(new Date(t2.getTime() - 60_000)), ["Erika", "Max"], "Tat vor der Herausnahme: Max bleibt Kandidat");
  assert.deepEqual(await names(new Date(t2.getTime() + 60_000)), ["Erika"]);
  assert.deepEqual(await names(parseLocalDateTime("2026-10-08T20:00")!, false), ["Erika", "Max"], "Tattag der Herausnahme: möglicherweise noch berechtigt");
  assert.deepEqual(await names(parseLocalDateTime("2026-10-09T08:00")!, false), ["Erika"]);
  const other = track(await createWorld("b27-auth-other"));
  assert.deepEqual(await driverCandidatesOf(db, other.tenantId, w.contractId, { offenseAt: new Date(t1.getTime() + 60_000), offenseTimeKnown: true }), [], "fremder Mandant: keine Fahrer");
});

// ===========================================================================
// 10 · Kundenakte · 11 · wirksamer Vertragsstand · 13 · Dashboard-Link
// ===========================================================================

test("Kundenakte: Zahlungslinks ohne 404 (Rechnung bzw. #mietzahlung), Mahnstufe je Rechnung, „+ Neue Rechnung“ mit Kunde vorbelegt", async () => {
  const fake = { bookingId: "b1", invoice: null };
  assert.equal(paymentHref(fake), "/buchungen/b1#mietzahlung");
  assert.equal(paymentHref({ bookingId: "b1", invoice: { id: "i1", bookingId: "b1", kind: "RENTAL" } }), "/buchungen/b1/rechnung?nr=i1");
  assert.equal(paymentHref({ bookingId: null, invoice: { id: "i2", bookingId: null, kind: "GENERAL" } }), "/rechnungen/i2");
  assert.equal(paymentHref({ bookingId: null, invoice: null }), null);

  const w = track(await createWorld("b27-cf"));
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14 } });
  await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "50", method: "CASH", paidAt: at });
  const { invoice } = await createGeneralInvoiceDraft(w.tenantId, w.actor, { customerId: w.customerId, bookingId: null, nonce: nonce("gi") });
  await updateInvoiceDraft(w.tenantId, invoice.id, w.actor, { items: [{ description: "Sonderreinigung", quantity: "1", unit: "pauschal", unitPrice: "80", taxRate: "19" }] });
  await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: invoice.id, amount: "30", method: "CASH", paidAt: at });
  const fin = await customerFinance(w.tenantId, w.customerId);
  const hrefs = fin.payments.map((p) => p.href).sort();
  assert.deepEqual(hrefs, [`/buchungen/${w.bookingId}#mietzahlung`, `/rechnungen/${invoice.id}`].sort());
  assert.ok(fin.payments.every((p) => !String(p.href).includes("/finanzen")), "die Adresse /buchungen/…/finanzen gibt es nicht");
  assert.equal(fin.documents.find((d) => d.id === invoice.id)?.dunning, null, "ohne Mahnschreiben keine Mahnstufe");
  const panel = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/finanzen/panels.tsx"), "utf8");
  assert.match(panel, /id="mietzahlung"/, "Sprungziel existiert");
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/kunden/[id]/page.tsx"), "utf8");
  assert.match(page, /href=\{`\/rechnungen\/neu\?kunde=\$\{c\.id\}`\}/);
  assert.match(page, /canManage && !supportSession && <Link href=\{`\/rechnungen\/neu/);
  // Dashboard: fehlendes PDF einer freien Rechnung verlinkt auf /rechnungen/…, nie /buchungen/null
  const dash = await loadDashboard(w.tenantId);
  assert.ok(dash.tasks.some((t) => t.href === `/rechnungen/${invoice.id}`), JSON.stringify(dash.tasks.map((t) => t.href)));
  assert.ok(dash.tasks.every((t) => !/\/null(\b|\/|#|\?|$)/.test(t.href ?? "")), "kein Link auf /buchungen/null");
});

test("Wirksamer Vertragsstand an vier Stellen: Dashboard-Kaution, Kundenakte-Betrag, Rechnungsseite, Buchungsliste", async () => {
  const w = track(await pickedUpWorld("b27-eff"));
  const c0 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const original = Math.round(Number(c0.totalAmount) * 100);
  const a = await draft(w, "eff");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: 5000, priceReason: "Dachbox vereinbart", newDepositCents: 80000 });
  await signed(w, a.id);
  // Dashboard
  assert.equal((await openDepositRows(w.tenantId)).expectedActive.find((b) => b.id === w.bookingId)?.expectedDepositCents, 80000);
  // Kundenakte
  const cb = await customerBookings(w.tenantId, w.customerId);
  assert.equal(cb.rows.find((r) => r.id === w.bookingId)?.contractTotalCents, original + 5000);
  // Rechnungsseite (Label „Mietpreis laut Mietvertrag … und Nachtrag …“)
  const eff = await effectiveStateForBooking(w.tenantId, w.bookingId);
  assert.equal(eff?.totalCents, original + 5000);
  const rp = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rechnung/page.tsx"), "utf8");
  assert.match(rp, /effectiveStateForBooking\(/);
  // Buchungsliste „Voraussichtlich“: dieselbe Auswahl wie die Seite
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId }, select: { startAt: true, endAt: true, dailyRate: true, workWeekRate: true, weeklyRate: true, monthlyRate: true, customer: { select: { discountPercent: true } }, contract: { select: { status: true, totalAmount: true, amendments: { where: { status: "SIGNED" }, select: { priceDeltaCents: true, newDepositCents: true, sequenceNo: true } } } } } });
  assert.equal(expectedRentalCents(b as unknown as Parameters<typeof expectedRentalCents>[0]).cents, original + 5000);
  const list = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/page.tsx"), "utf8");
  assert.match(list, /expectedRentalCents\(/);
  assert.match(list, /amendments: SIGNED_AMENDMENTS_SELECT/);
});

// ===========================================================================
// 12 · Login-Weiterleitung · 14 · Zeitumstellung
// ===========================================================================

test("Login-Weiterleitung: nur interne Pfade", () => {
  for (const ok of ["/heute", "/buchungen/abc?tab=1#x", "/kunden"]) assert.equal(safeInternalPath(ok), ok);
  for (const bad of ["//evil.example", "https://evil.example", "http://evil.example/x", "javascript:alert(1)", "/\\evil.example", "\\\\evil.example", " //evil.example", "/heute\nSet-Cookie: x", "", "heute", "%2F%2Fevil.example", null, undefined, 42, "/" + "a".repeat(2001)]) {
    assert.equal(safeInternalPath(bad), null, JSON.stringify(bad));
  }
  assert.equal(safeInternalPath("/%2F%2Fevil.example"), "/%2F%2Fevil.example", "kodiert bleibt es ein interner Pfad");
  const act = readFileSync(path.join(process.cwd(), "src/app/(auth)/actions.ts"), "utf8");
  assert.match(act, /safeInternalPath\(/);
});

test("Miettage über die Zeitumstellung: Sa 10:00 – Mo 10:00 = 2 Tage (Sommer→Winter und Winter→Sommer); echte Überziehung zählt", () => {
  const p = (s: string) => parseLocalDateTime(s)!;
  assert.equal(rentalDays(p("2026-10-10T10:00"), p("2026-10-12T10:00")), 2, "normal 48 h");
  assert.equal(rentalDays(p("2026-10-24T10:00"), p("2026-10-26T10:00")), 2, "Sommer → Winter (49 h)");
  assert.equal(rentalDays(p("2027-03-27T10:00"), p("2027-03-29T10:00")), 2, "Winter → Sommer (47 h)");
  assert.equal(rentalDays(p("2026-10-24T10:00"), p("2026-10-25T10:00")), 1, "gleiche Uhrzeit nach einem Tag (über die Umstellung)");
  assert.equal(rentalDays(p("2027-03-27T10:00"), p("2027-03-28T10:00")), 1);
  assert.equal(rentalDays(p("2026-10-24T10:00"), p("2026-10-26T10:01")), 3, "echte Überziehung beginnt einen neuen Tag");
  assert.equal(rentalDays(p("2027-03-27T10:00"), p("2027-03-29T10:01")), 3);
  assert.equal(rentalDays(p("2026-10-24T10:00"), p("2026-10-24T10:00")), 0);
});

// ===========================================================================
// 15 · Fahrzeugstatus und Kilometerstand nicht still ändern
// ===========================================================================

test("Fahrzeugstammdaten: Kilometer nie still nach unten, Korrektur mit Grund + Historie + Audit; Statuswechsel protokolliert; Schadensperre nur in der Akte lösbar", async () => {
  const w = track(await createWorld("b27-veh"));
  const upd = (data: { status: string; mileage: number }, reason?: string) => updateVehicleMasterData(w.tenantId, w.actor, w.vehicleId, { ...data, fuel: "DIESEL", tankCapacityLiters: 75 }, { mileageCorrectionReason: reason ?? null });
  await assert.rejects(() => upd({ status: "AVAILABLE", mileage: 49_000 }), /nicht unter den dokumentierten Stand von 50\.000 km/);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).mileage, 50_000);
  const r = await upd({ status: "AVAILABLE", mileage: 49_000 }, "Tippfehler bei Anlage");
  assert.equal(r.mileageCorrected, true);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).mileage, 49_000);
  assert.match((await db.vehicleEvent.findFirstOrThrow({ where: { tenantId: w.tenantId, vehicleId: w.vehicleId, type: "MILEAGE_CORRECTED" } })).description ?? "", /50\.000 km auf 49\.000 km: Tippfehler/);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "VEHICLE_MILEAGE_CORRECTED" } }), 1);
  await upd({ status: "AVAILABLE", mileage: 49_500 });
  assert.equal(await db.vehicleEvent.count({ where: { tenantId: w.tenantId, vehicleId: w.vehicleId, type: "MILEAGE" } }), 1);
  // manueller Statuswechsel: Historie und Audit
  const s = await upd({ status: "WORKSHOP", mileage: 49_500 });
  assert.equal(s.statusChanged, true);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "VEHICLE_STATUS_CHANGED" } }), 1);
  assert.match((await db.vehicleEvent.findFirstOrThrow({ where: { tenantId: w.tenantId, vehicleId: w.vehicleId, type: "STATUS_CHANGED" } })).description ?? "", /→/);
  await upd({ status: "AVAILABLE", mileage: 49_500 });
  // Schadensperre aus der Schadenakte: im Stammdatenformular nicht lösbar
  const d = await reportDamage(w.tenantId, w.actor, { vehicleId: w.vehicleId, view: "LEFT", posX: 0.5, posY: 0.5, kind: "SCRATCH", description: "Kratzer Fahrertür", severity: "SEVERE" });
  const { damageCase } = await openDamageCase(w.tenantId, d.id, w.actor);
  await blockVehicleForCase(w.tenantId, damageCase.id, w.actor, "nicht verkehrssicher");
  assert.match((await vehicleStatusHold(db, w.tenantId, w.vehicleId, "BLOCKED")) ?? "", /Schadenakte .* gesperrt/);
  await assert.rejects(() => upd({ status: "AVAILABLE", mileage: 49_500 }), /durch die Schadenakte .* gesperrt/);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "BLOCKED");
  await releaseVehicleForCase(w.tenantId, damageCase.id, w.actor, "repariert");
  assert.equal(await vehicleStatusHold(db, w.tenantId, w.vehicleId, "BLOCKED"), null);
  // fremder Mandant
  const other = track(await createWorld("b27-veh-other"));
  await assert.rejects(() => updateVehicleMasterData(other.tenantId, other.actor, w.vehicleId, { status: "AVAILABLE", mileage: 1, fuel: "DIESEL" }), /nicht gefunden/);
  const act = readFileSync(path.join(process.cwd(), "src/app/(app)/fahrzeuge/actions.ts"), "utf8");
  assert.match(act, /updateVehicleMasterData\(/);
});

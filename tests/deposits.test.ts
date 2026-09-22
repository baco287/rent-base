// Kaution: vereinbart aus dem Vertrags-Snapshot, erhalten, vollständig/teilweise freigegeben, einbehalten, Historie,
// Korrektur mit Grund, Grenzen (Freigabe/Einbehalt > erhalten), keine Verrechnung, Rollen serverseitig, Parallelität, Idempotenz.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { balanceOf, cancelDepositEvent, depositView, deriveDepositStatus, openDepositCounts, previewDepositSettlement, recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { isImmutableError } from "../src/lib/integrity";
import { ensureInvoiceDraft, finalizeInvoice } from "../src/lib/invoices";
import { invoicePaymentSummary } from "../src/lib/payments";
import { createWorld, fakeSignaturePng, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});
const at = new Date(Date.now() - 60_000);

test("Status wird aus den Bewegungen abgeleitet", () => {
  assert.equal(deriveDepositStatus(0, 0, 0), "EXPECTED");
  assert.equal(deriveDepositStatus(50_000, 0, 0), "RECEIVED");
  assert.equal(deriveDepositStatus(50_000, 50_000, 0), "RELEASED");
  assert.equal(deriveDepositStatus(50_000, 0, 50_000), "RETAINED");
  assert.equal(deriveDepositStatus(50_000, 35_000, 15_000), "PARTIALLY_RELEASED");
  assert.equal(deriveDepositStatus(50_000, 20_000, 0), "PARTIALLY_RELEASED", "Rest noch nicht zugeordnet");
  const b = balanceOf(50_000, [{ type: "RECEIVED", amountCents: 50_000, status: "CONFIRMED" }, { type: "RETAINED", amountCents: 15_000, status: "CONFIRMED" }, { type: "RELEASED", amountCents: 35_000, status: "CANCELLED" }]);
  assert.deepEqual([b.receivedCents, b.releasedCents, b.retainedCents, b.remainingCents, b.status], [50_000, 0, 15_000, 35_000, "PARTIALLY_RELEASED"]);
});

test("Kaution aus dem Vertrags-Snapshot: vor Vertragsabschluss nichts, danach fest, spätere Fahrzeug-/Buchungsänderungen wirken nicht", async () => {
  const w = await createWorld("dep-contract");
  tenants.push(w.tenantId);
  const v0 = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v0.contractSigned, v0.expectedCents, v0.status], [false, 0, "EXPECTED"]);
  await assert.rejects(() => recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at }), /abgeschlossenen Mietvertrag/);

  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 750, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: null, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const v1 = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v1.contractSigned, v1.expectedCents, v1.receivedCents, v1.status, v1.deposit], [true, 75_000, 0, "EXPECTED", null], "vereinbart aus dem Vertrag, noch keine gespeicherte Kaution nötig");

  // Eingang (Hofmitarbeiter darf das operativ; Rolle wird in der Action geprüft, hier die Fachlogik)
  const r = await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "750,00", method: "CARD", occurredAt: at, reference: "Terminal 4711" });
  assert.deepEqual([r.created, r.event.type, r.event.amountCents, r.event.method], [true, "RECEIVED", 75_000, "CARD"]);
  const v2 = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v2.deposit?.expectedAmountCents, v2.deposit?.contractId, v2.deposit?.status, v2.receivedCents, v2.status], [75_000, c.id, "RECEIVED", 75_000, "RECEIVED"]);

  // spätere Änderungen an Fahrzeugpreisen/Buchung ändern die vereinbarte Kaution nicht
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { deposit: 9999 } });
  await assert.rejects(() => db.securityDeposit.update({ where: { id: v2.deposit!.id }, data: { expectedAmountCents: 1 } }), /RB_IMMUTABLE|fest/);
  await assert.rejects(() => db.securityDeposit.delete({ where: { id: v2.deposit!.id } }), (e) => isImmutableError(e));
  assert.equal((await depositView(w.tenantId, w.bookingId)).expectedCents, 75_000);

  // mehr als vereinbart: blockiert (App und DB); Freigabe vor Rückgabe: blockiert
  await assert.rejects(() => recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "1", method: "CASH", occurredAt: at }), /Mehr als die vereinbarte Kaution/);
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: w.tenantId, depositId: v2.deposit!.id, type: "RECEIVED", amountCents: 1, occurredAt: at } }), /Mehr Kaution erhalten als vereinbart/);
  await assert.rejects(() => settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "750", method: "CASH", occurredAt: at }), /erst nach der Rückgabe/);
  await assert.rejects(() => recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "0", method: "CASH", occurredAt: at }), /größer als 0,00/);
  await assert.rejects(() => recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "-1", method: "CASH", occurredAt: at }), /nicht negativ/);
});

test("Nach Rückgabe: Teilbetrag erhalten, vollständige Freigabe; teilweise Freigabe mit Pflichtgrund; vollständiger Einbehalt; Grenzen; keine Verrechnung", async () => {
  // Fall A: Teilbeträge erhalten, dann vollständig freigegeben
  const a = await returnedWorld("dep-release");
  tenants.push(a.tenantId);
  await recordDepositReceived(a.tenantId, a.actor, { bookingId: a.bookingId, amount: "200", method: "CASH", occurredAt: at });
  await recordDepositReceived(a.tenantId, a.actor, { bookingId: a.bookingId, amount: "300", method: "BANK_TRANSFER", occurredAt: at });
  let v = await depositView(a.tenantId, a.bookingId);
  assert.deepEqual([v.expectedCents, v.receivedCents, v.remainingCents, v.status], [50_000, 50_000, 50_000, "RECEIVED"]);
  await assert.rejects(() => settleDeposit(a.tenantId, a.actor, { bookingId: a.bookingId, releaseAmount: "500,01", method: "CASH", occurredAt: at }), /Freigabe über die erhaltene Kaution hinaus/);
  await assert.rejects(() => settleDeposit(a.tenantId, a.actor, { bookingId: a.bookingId, releaseAmount: "500", occurredAt: at }), /Zahlungsart/);
  const pv = await previewDepositSettlement(a.tenantId, a.bookingId, "500");
  assert.deepEqual([pv.kind, pv.releaseCents, pv.retainCents, pv.statusAfter, pv.error], ["RELEASE", 50_000, 0, "RELEASED", null]);
  const rel = await settleDeposit(a.tenantId, a.actor, { bookingId: a.bookingId, releaseAmount: "500", method: "BANK_TRANSFER", occurredAt: at, note: "Rücküberweisung veranlasst" });
  assert.deepEqual([rel.kind, rel.events.length, rel.events[0].type, rel.events[0].amountCents], ["RELEASE", 1, "RELEASED", 50_000]);
  v = await depositView(a.tenantId, a.bookingId);
  assert.deepEqual([v.releasedCents, v.retainedCents, v.remainingCents, v.status, v.deposit?.status], [50_000, 0, 0, "RELEASED", "RELEASED"]);
  await assert.rejects(() => settleDeposit(a.tenantId, a.actor, { bookingId: a.bookingId, releaseAmount: "1", method: "CASH", occurredAt: at }), /bereits vollständig/);
  assert.equal(v.events.length, 3, "Historie: 2 Eingänge, 1 Freigabe");

  // Fall B: teilweise Freigabe 350 / Einbehalt 150 mit Pflichtgrund
  const b = await returnedWorld("dep-partial", { damageCharge: true });
  tenants.push(b.tenantId);
  await recordDepositReceived(b.tenantId, b.actor, { bookingId: b.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await assert.rejects(() => settleDeposit(b.tenantId, b.actor, { bookingId: b.bookingId, releaseAmount: "350", method: "CASH", occurredAt: at }), /Grund für den einbehaltenen Betrag/);
  const ppv = await previewDepositSettlement(b.tenantId, b.bookingId, "350");
  assert.deepEqual([ppv.kind, ppv.releaseCents, ppv.retainCents, ppv.statusAfter], ["PARTIAL", 35_000, 15_000, "PARTIALLY_RELEASED"]);
  const part = await settleDeposit(b.tenantId, b.actor, { bookingId: b.bookingId, releaseAmount: "350", method: "CASH", reason: "Prüfung eines bei Rückgabe festgestellten Schadens", occurredAt: at });
  assert.deepEqual(part.events.map((e) => [e.type, e.amountCents, e.reason]), [["RELEASED", 35_000, null], ["RETAINED", 15_000, "Prüfung eines bei Rückgabe festgestellten Schadens"]]);
  v = await depositView(b.tenantId, b.bookingId);
  assert.deepEqual([v.releasedCents, v.retainedCents, v.remainingCents, v.status], [35_000, 15_000, 0, "PARTIALLY_RELEASED"]);

  // keine Verrechnung: Zusatzkosten (270 €), Rechnung und Schaden bleiben unberührt; Einbehalt ist keine Zahlung
  const draft = await ensureInvoiceDraft(b.tenantId, b.bookingId, b.actor);
  const inv = await finalizeInvoice(b.tenantId, draft.id, b.actor);
  const pay = await invoicePaymentSummary(b.tenantId, inv.id);
  assert.deepEqual([pay.paidCents, pay.status], [0, "OPEN"], "Einbehalt zählt nicht als Rechnungszahlung");
  assert.equal(await db.payment.count({ where: { tenantId: b.tenantId } }), 0, "kein automatisch erzeugtes Payment");
  const charges = await db.extraCharge.findMany({ where: { tenantId: b.tenantId, handoverId: b.returnId } });
  assert.equal(charges.reduce((s, c) => s + Number(c.amount), 0), 470, "Zusatzkosten unverändert (200 + 30 + 240)");
  const damage = await db.damage.findFirstOrThrow({ where: { tenantId: b.tenantId, bookingId: b.bookingId } });
  assert.deepEqual([damage.status, damage.settlementReview], ["OPEN", true], "keine automatische Schadenforderung oder Haftungsfeststellung");
  const audit = await db.auditLog.findMany({ where: { tenantId: b.tenantId, depositId: v.deposit!.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(audit.map((x) => x.action), ["DEPOSIT_RECEIVED", "DEPOSIT_PARTIALLY_RELEASED"]);
  assert.deepEqual((audit[1].details as { released: number; retained: number }), { ...(audit[1].details as object), released: 35_000, retained: 15_000 });

  // Fall C: vollständiger Einbehalt mit Grund
  const c = await returnedWorld("dep-retain");
  tenants.push(c.tenantId);
  await recordDepositReceived(c.tenantId, c.actor, { bookingId: c.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await assert.rejects(() => settleDeposit(c.tenantId, c.actor, { bookingId: c.bookingId, releaseAmount: "0", occurredAt: at }), /Grund/);
  const depC = (await depositView(c.tenantId, c.bookingId)).deposit!;
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: c.tenantId, depositId: depC.id, type: "RETAINED", amountCents: 1, occurredAt: at } }), /rb_deposit_event_reason|check/i, "DB: Einbehalt ohne Grund");
  const ret = await settleDeposit(c.tenantId, c.actor, { bookingId: c.bookingId, releaseAmount: "0", reason: "Prüfung eines bei Rückgabe festgestellten Schadens", occurredAt: at });
  assert.deepEqual([ret.kind, ret.events[0].type, ret.events[0].amountCents], ["RETAIN", "RETAINED", 50_000]);
  v = await depositView(c.tenantId, c.bookingId);
  assert.deepEqual([v.retainedCents, v.status], [50_000, "RETAINED"]);
  // DB: Einbehalt über erhalten hinaus
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: c.tenantId, depositId: v.deposit!.id, type: "RELEASED", amountCents: 1, reason: "x", occurredAt: at } }), /nicht übersteigen/);
});

test("Korrektur: Bewegung nur mit Grund stornieren, Historie bleibt, Status neu; Eingang mit Freigabe darauf nicht stornierbar; Unveränderlichkeit; Parallelität; Doppelklick; Mandant", async () => {
  const w = await returnedWorld("dep-correct");
  tenants.push(w.tenantId);
  const rec = await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await assert.rejects(() => cancelDepositEvent(w.tenantId, w.actor, rec.event.id, ""), /Grund/);
  await assert.rejects(() => db.securityDepositEvent.update({ where: { id: rec.event.id }, data: { amountCents: 1 } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.securityDepositEvent.delete({ where: { id: rec.event.id } }), (e) => isImmutableError(e));

  // parallele Freigaben desselben Rests: genau eine gewinnt
  const results = await Promise.allSettled([
    settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "500", method: "CASH", occurredAt: at }),
    settleDeposit(w.tenantId, { id: w.userId, name: "Kollege" }, { bookingId: w.bookingId, releaseAmount: "500", method: "CASH", occurredAt: at }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  let v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.releasedCents, v.status], [50_000, "RELEASED"], "nicht 1.000 € freigegeben");

  // Eingang, auf dem eine Freigabe beruht, ist nicht stornierbar (DB-Regel), die Freigabe schon
  await assert.rejects(() => cancelDepositEvent(w.tenantId, w.actor, rec.event.id, "versehentlich"), /nicht übersteigen/);
  const relEvent = v.events.find((e) => e.type === "RELEASED")!;
  const cancelled = await cancelDepositEvent(w.tenantId, w.actor, relEvent.id, "Freigabe versehentlich dokumentiert");
  assert.deepEqual([cancelled.status, cancelled.cancellationReason, cancelled.cancelledByName], ["CANCELLED", "Freigabe versehentlich dokumentiert", "Test Mitarbeiter"]);
  v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.releasedCents, v.remainingCents, v.status, v.events.length], [0, 50_000, "RECEIVED", 2], "Historie bleibt, Status neu abgeleitet");
  await assert.rejects(() => cancelDepositEvent(w.tenantId, w.actor, relEvent.id, "nochmal"), /bereits storniert/);
  await assert.rejects(() => db.securityDepositEvent.update({ where: { id: relEvent.id }, data: { status: "CONFIRMED" } }), (e) => isImmutableError(e));
  assert.equal((await db.auditLog.count({ where: { tenantId: w.tenantId, action: "DEPOSIT_CORRECTION" } })), 1);
  assert.equal((await openDepositCounts(w.tenantId)).held, 1, "nach dem Storno wieder offen");

  // Doppelklick bei Freigabe und Eingang: gleicher Schlüssel nur einmal
  const key = "33333333-aaaa-bbbb-cccc-444444444444";
  const twice = await Promise.all([
    settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "350", method: "CASH", reason: "Schadenprüfung", occurredAt: at, idempotencyKey: key }),
    settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "350", method: "CASH", reason: "Schadenprüfung", occurredAt: at, idempotencyKey: key }),
  ]);
  assert.deepEqual(twice.map((t) => t.created).sort(), [false, true]);
  v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.releasedCents, v.retainedCents, v.status], [35_000, 15_000, "PARTIALLY_RELEASED"]);
  const w2 = await returnedWorld("dep-idem");
  tenants.push(w2.tenantId);
  const k2 = "55555555-aaaa-bbbb-cccc-666666666666";
  const rr = await Promise.all([
    recordDepositReceived(w2.tenantId, w2.actor, { bookingId: w2.bookingId, amount: "500", method: "CASH", occurredAt: at, idempotencyKey: k2 }),
    recordDepositReceived(w2.tenantId, w2.actor, { bookingId: w2.bookingId, amount: "500", method: "CASH", occurredAt: at, idempotencyKey: k2 }),
  ]);
  assert.deepEqual(rr.map((t) => t.created).sort(), [false, true]);
  assert.equal((await depositView(w2.tenantId, w2.bookingId)).receivedCents, 50_000);

  // Mandantentrennung: fremde Buchung/Kaution unsichtbar, DB verhindert Fremdverknüpfung
  await assert.rejects(() => depositView(w2.tenantId, w.bookingId), /Buchung nicht gefunden/);
  await assert.rejects(() => recordDepositReceived(w2.tenantId, w2.actor, { bookingId: w.bookingId, amount: "1", method: "CASH", occurredAt: at }), /Buchung nicht gefunden/);
  await assert.rejects(() => cancelDepositEvent(w2.tenantId, w2.actor, rec.event.id, "fremd"), /nicht gefunden/);
  await assert.rejects(() => db.securityDeposit.create({ data: { tenantId: w2.tenantId, bookingId: w.bookingId, expectedAmountCents: 1 } }), /RB_TENANT/);
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: w2.tenantId, depositId: v.deposit!.id, type: "RECEIVED", amountCents: 1, occurredAt: at } }), /RB_TENANT/);
});

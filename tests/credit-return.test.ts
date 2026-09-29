// Befehl 22: Gutschrift, Rechnungsstorno und Kautionskorrektur. Referenzfall: Rechnung 140 €, bar 45 €, aus Kaution 95 €
// (Kaution 500 €). Danach Gutschrift 40 € → Kundenguthaben 40 € – ohne jede automatische Folge. Der Vermieter wählt:
// zur Kaution zurückführen (Gegenbewegung, Teilbeträge, Storno) oder auszahlen (bestehender Auszahlungsprozess).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { createCancellationDraft, createCreditNoteDraft, finalizeCounterDocument, invoiceFinancials, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { cancelDepositOffset } from "../src/lib/deposit-offset";
import { cancelOffsetReturn, offsetReturnOptions, previewOffsetReturn, returnOffsetToDeposit } from "../src/lib/deposit-offset-return";
import { cancelDepositEvent, depositView, recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { finalizeInvoiceWithDepositOffset } from "../src/lib/invoice-settlement";
import { ensureInvoiceDraft, getInvoiceState, updateInvoiceDraft, verifyInvoice } from "../src/lib/invoices";
import { cancelPayment } from "../src/lib/payments";
import { cancelPayout, createPayout, payoutSource } from "../src/lib/payouts";
import { recordRentalPayment } from "../src/lib/rental-payments";
import { createWorld, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});
const at = new Date(Date.now() - 60_000);
const cash = (amount: string) => ({ amount, method: "CASH", executedAt: at, receiptConfirmed: true });

/** Rechnung `gross` €, bar `cash` €, Rest aus 500 € Kaution verrechnet (atomar beim Abschluss, Befehl 21). */
async function settledWorld(label: string, opts: { gross?: string; cash?: string } = {}) {
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: opts.cash ?? "45", method: "CASH", paidAt: at });
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const st = await getInvoiceState(w.tenantId, inv.id);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: st.draft!.items[0].id, description: st.draft!.items[0].description, quantity: "1", unit: "pauschal", unitPrice: opts.gross ?? "140", taxRate: "19" }] });
  const gross = Math.round(Number(opts.gross ?? "140") * 100), paid = Math.round(Number(opts.cash ?? "45") * 100);
  const res = await finalizeInvoiceWithDepositOffset(w.tenantId, inv.id, w.actor, {}, { amount: ((gross - paid) / 100).toFixed(2), occurredAt: at, idempotencyKey: `${label}-settle-1` });
  return { w, invoiceId: inv.id, version: res.version, offsetPaymentId: res.offset.payment.id };
}
async function credit(w: { tenantId: string; actor: { id: string; name: string } }, invoiceId: string, versionItemId: string, amount: string) {
  const cn = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: versionItemId, mode: "AMOUNT", grossAmount: amount }], reason: "Kulanz nach Rücksprache" });
  await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
  return (await db.invoice.findUniqueOrThrow({ where: { id: cn.id } })).number!;
}
const counts = (tenantId: string) => Promise.all([
  db.payment.count({ where: { tenantId } }), db.payment.count({ where: { tenantId, status: "CANCELLED" } }),
  db.securityDepositEvent.count({ where: { tenantId } }), db.payout.count({ where: { tenantId } }),
]);
const returnInput = (invoiceId: string, paymentId: string, amount: string, key?: string) => ({ invoiceId, paymentId, amount, occurredAt: at, idempotencyKey: key });

test("Referenzfall: Gutschrift 40 € → 40 € Kundenguthaben, keine automatische Kautionsbewegung, Auszahlung oder Zahlungsänderung; Rechnung unverändert", async () => {
  const { w, invoiceId, version } = await settledWorld("cr-ref");
  const f0 = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f0.invoiceCents, f0.paidCents, f0.offsetCents, f0.openCents, f0.customerCreditCents], [14_000, 14_000, 9_500, 0, 0]);
  const hash0 = (await verifyInvoice(w.tenantId, invoiceId)).storedHash;
  const before = await counts(w.tenantId);
  const gs = await credit(w, invoiceId, version.items[0].id, "40");
  assert.match(gs, /^GS-/);
  const f = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f.effectiveCents, f.paidCents, f.offsetCents, f.openCents, f.customerCreditCents, f.completedRefundCents, f.returnedToDepositCents, f.refundRemainingCents], [10_000, 14_000, 9_500, 0, 4_000, 0, 0, 4_000]);
  assert.deepEqual(await counts(w.tenantId), before, "keine Zahlung, keine Kautionsbewegung, keine Auszahlung entstanden oder storniert");
  const d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([d.receivedCents, d.offsetCents, d.offsetGrossCents, d.offsetReturnedCents, d.remainingCents], [50_000, 9_500, 9_500, 0, 40_500], "Kaution unverändert");
  const v = await verifyInvoice(w.tenantId, invoiceId);
  assert.deepEqual([v.intact, v.storedHash], [true, hash0], "Originalrechnung versiegelt und unverändert");
  const o = await offsetReturnOptions(w.tenantId, invoiceId);
  assert.deepEqual([o.blockedReason, o.offsets.length, o.offsets[0].returnableCents, o.counterDocuments.map((c) => c.number)], [null, 1, 9_500, [gs]]);
});

test("Rückführung 40 € vollständig: netto verrechnet 55 €, Kaution verfügbar 445 €, Guthaben 0; Originalbewegungen unverändert; Historie und Audit", async () => {
  const { w, invoiceId, version, offsetPaymentId } = await settledWorld("cr-full");
  const gs = await credit(w, invoiceId, version.items[0].id, "40");
  const offsetBefore = await db.payment.findUniqueOrThrow({ where: { id: offsetPaymentId }, include: { depositOffsetEvent: true } });
  const pv = await previewOffsetReturn(w.tenantId, invoiceId, offsetPaymentId, "");
  assert.deepEqual([pv.availableCreditCents, pv.offsetCents, pv.offsetReturnedCents, pv.maxCents, pv.amountCents, pv.creditAfterCents, pv.depositAvailableBeforeCents, pv.depositAvailableAfterCents, pv.offsetNetAfterCents, pv.error], [4_000, 9_500, 0, 4_000, 4_000, 0, 40_500, 44_500, 5_500, null]);
  const r = await returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "40", "cr-full-key-1"));
  assert.deepEqual([r.created, r.event.type, r.event.amountCents, r.event.invoiceId, r.event.returnsPaymentId, r.event.method, r.event.status], [true, "OFFSET_RETURN", 4_000, invoiceId, offsetPaymentId, null, "CONFIRMED"]);
  assert.match(r.event.reference ?? "", new RegExp(`${gs}.*Rechnung RE-`));
  const d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([d.receivedCents, d.offsetGrossCents, d.offsetReturnedCents, d.offsetCents, d.remainingCents, d.releasedCents, d.completedPayoutCents], [50_000, 9_500, 4_000, 5_500, 44_500, 0, 0]);
  assert.deepEqual(d.events.map((e) => [e.type, e.amountCents]).sort(), [["OFFSET", 9_500], ["OFFSET_RETURN", 4_000], ["RECEIVED", 50_000]].sort());
  const f = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f.paidCents, f.offsetCents, f.customerCreditCents, f.returnedToDepositCents, f.completedRefundCents, f.refundRemainingCents, f.openCents], [14_000, 9_500, 4_000, 4_000, 0, 0, 0]);
  // die ursprüngliche Verrechnung (95 €) ist unverändert – Zahlung und Kautionsbewegung
  const offsetAfter = await db.payment.findUniqueOrThrow({ where: { id: offsetPaymentId }, include: { depositOffsetEvent: true } });
  assert.deepEqual([offsetAfter.amountCents, offsetAfter.status, offsetAfter.depositOffsetEvent?.amountCents, offsetAfter.depositOffsetEvent?.status], [offsetBefore.amountCents, "CONFIRMED", 9_500, "CONFIRMED"]);
  // kein Umsatz, kein Geldeingang: keine neue Zahlung, Bar-/Bankzahlungen unverändert 45 €
  const cashIn = await db.payment.aggregate({ where: { tenantId: w.tenantId, status: "CONFIRMED", method: { in: ["CASH", "CARD", "BANK_TRANSFER", "OTHER"] } }, _sum: { amountCents: true } });
  assert.equal(cashIn._sum.amountCents, 4_500);
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId } }), 2);
  assert.equal(await db.payout.count({ where: { tenantId: w.tenantId } }), 0, "Rückführung ist keine Auszahlung");
  // Audit
  const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "DEPOSIT_OFFSET_PARTIALLY_RETURNED" } });
  assert.deepEqual([audit.invoiceId, audit.bookingId, audit.paymentId, audit.amountCents, audit.userId], [invoiceId, w.bookingId, offsetPaymentId, 4_000, w.actor.id]);
  const det = audit.details as Record<string, unknown>;
  assert.deepEqual([det.counterDocuments, det.offsetReturnedBefore, det.offsetReturnedAfter, det.creditAvailableBefore, det.creditAvailableAfter, det.depositAvailableBefore, det.depositAvailableAfter], [gs, 0, 4_000, 4_000, 0, 40_500, 44_500]);
  // danach: nichts mehr rückführbar, auch keine Auszahlung mehr möglich
  assert.match((await offsetReturnOptions(w.tenantId, invoiceId)).blockedReason ?? "", /vollständig ausgezahlt oder zur Kaution zurückgeführt/);
  assert.equal((await payoutSource(db, w.tenantId, { sourceType: "INVOICE_REFUND", invoiceId })).remainingCents, 0);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId }, cash("1"), { complete: true, confirmed: true }), /Noch auszuzahlen sind 0,00|nichts|kein/i);
  // die zurückgeführten 40 € stehen der Kaution zur Verfügung: Freigabe über 445 € ist jetzt möglich (nicht automatisch)
  const rel = await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "445", method: "CASH", occurredAt: at });
  assert.equal(rel.events[0].amountCents, 44_500);
});

test("Teilrückführung 25 € → 15 € Guthaben; Rest später zurückführen; stattdessen/zusätzlich auszahlen; Obergrenzen", async () => {
  const { w, invoiceId, version, offsetPaymentId } = await settledWorld("cr-part");
  await credit(w, invoiceId, version.items[0].id, "40");
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "40,01")), /Verfügbar sind nur 40,00\s€ Kundenguthaben/);
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "0")), /größer als 0,00/);
  await returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "25"));
  let f = await invoiceFinancials(w.tenantId, invoiceId);
  let d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([f.refundRemainingCents, f.returnedToDepositCents, d.offsetCents, d.remainingCents], [1_500, 2_500, 7_000, 43_000]);
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "DEPOSIT_OFFSET_PARTIALLY_RETURNED", amountCents: 2_500 } }));
  // bereits zurückgeführtes Guthaben kann nicht erneut verwendet werden
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "15,01")), /Verfügbar sind nur 15,00/);
  // Rest 15 €: auszahlen (bestehender Auszahlungsprozess), danach ist nichts mehr übrig – weder für Rückführung noch Auszahlung
  const { payout } = await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId }, cash("15"), { complete: true, confirmed: true });
  assert.deepEqual([payout.status, payout.amountCents, payout.sourceType], ["COMPLETED", 1_500, "INVOICE_REFUND"]);
  f = await invoiceFinancials(w.tenantId, invoiceId);
  d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([f.customerCreditCents, f.returnedToDepositCents, f.completedRefundCents, f.refundRemainingCents, d.remainingCents], [4_000, 2_500, 1_500, 0, 43_000], "Auszahlung ändert die Kaution nicht");
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "1")), /vollständig ausgezahlt oder zur Kaution zurückgeführt/);
  // zweiter Fall: 25 € zurück, später die restlichen 15 € ebenfalls zurück → vollständige Rückführung des Guthabens
  const b = await settledWorld("cr-part2");
  await credit(b.w, b.invoiceId, b.version.items[0].id, "40");
  await returnOffsetToDeposit(b.w.tenantId, b.w.actor, returnInput(b.invoiceId, b.offsetPaymentId, "25"));
  await returnOffsetToDeposit(b.w.tenantId, b.w.actor, returnInput(b.invoiceId, b.offsetPaymentId, "15"));
  const fb = await invoiceFinancials(b.w.tenantId, b.invoiceId);
  const db2 = await depositView(b.w.tenantId, b.w.bookingId);
  assert.deepEqual([fb.refundRemainingCents, fb.returnedToDepositCents, db2.offsetCents, db2.remainingCents], [0, 4_000, 5_500, 44_500]);
  // Auszahlung statt Rückführung: Guthaben 0, Kaution unverändert
  const c = await settledWorld("cr-payout");
  await credit(c.w, c.invoiceId, c.version.items[0].id, "40");
  await createPayout(c.w.tenantId, c.w.actor, { sourceType: "INVOICE_REFUND", invoiceId: c.invoiceId }, cash("40"), { complete: true, confirmed: true });
  const fc = await invoiceFinancials(c.w.tenantId, c.invoiceId);
  const dc = await depositView(c.w.tenantId, c.w.bookingId);
  assert.deepEqual([fc.refundRemainingCents, fc.completedRefundCents, fc.returnedToDepositCents, dc.offsetCents, dc.remainingCents], [0, 4_000, 0, 9_500, 40_500]);
  await assert.rejects(() => returnOffsetToDeposit(c.w.tenantId, c.w.actor, returnInput(c.invoiceId, c.offsetPaymentId, "1")), /vollständig ausgezahlt/);
});

test("Obergrenze Verrechnung: Guthaben 120 € bei 95 € Verrechnung → höchstens 95 € zurück, 25 € bleiben auszahlbar", async () => {
  const { w, invoiceId, version, offsetPaymentId } = await settledWorld("cr-cap");
  await credit(w, invoiceId, version.items[0].id, "120");
  const pv = await previewOffsetReturn(w.tenantId, invoiceId, offsetPaymentId, "");
  assert.deepEqual([pv.availableCreditCents, pv.maxCents, pv.amountCents], [12_000, 9_500, 9_500]);
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "95,01")), /nur noch 95,00\s€ rückführbar/);
  await returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "95"));
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "DEPOSIT_OFFSET_FULLY_RETURNED" } }), "vollständig zurückgeführt eigens protokolliert");
  const f = await invoiceFinancials(w.tenantId, invoiceId);
  const d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([f.refundRemainingCents, f.returnedToDepositCents, d.offsetCents, d.remainingCents], [2_500, 9_500, 0, 50_000]);
  assert.match((await offsetReturnOptions(w.tenantId, invoiceId)).blockedReason ?? "", /bereits vollständig zurückgeführt/);
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "1")), /bereits vollständig zurückgeführt/);
  assert.equal((await payoutSource(db, w.tenantId, { sourceType: "INVOICE_REFUND", invoiceId })).remainingCents, 2_500);
  // Datenbank: auch direkt nie mehr als verrechnet und nie mehr als Guthaben
  const dep = await db.securityDeposit.findFirstOrThrow({ where: { bookingId: w.bookingId } });
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: w.tenantId, depositId: dep.id, type: "OFFSET_RETURN", amountCents: 100, occurredAt: at, invoiceId, returnsPaymentId: offsetPaymentId } }), /noch nicht zurückgeführten Teil|übersteigt/);
});

test("Vollstorno 140 €: 140 € Guthaben; bewusst 95 € zur Kaution + 45 € auszahlen → Guthaben 0, Verrechnung netto 0, Kaution wieder 500 € verfügbar", async () => {
  const { w, invoiceId, offsetPaymentId } = await settledWorld("cr-cancel");
  const st = await createCancellationDraft(w.tenantId, invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, st.id, w.actor, { reason: "Miete storniert" });
  const before = await counts(w.tenantId);
  await finalizeCounterDocument(w.tenantId, st.id, w.actor, { confirmed: true });
  assert.deepEqual(await counts(w.tenantId), before, "Storno bucht nichts automatisch");
  let f = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f.chain, f.effectiveCents, f.paidCents, f.customerCreditCents, f.refundRemainingCents], ["CANCELLED", 0, 14_000, 14_000, 14_000]);
  await returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "95"));
  await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId }, cash("45"), { complete: true, confirmed: true });
  f = await invoiceFinancials(w.tenantId, invoiceId);
  const d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([f.refundRemainingCents, f.returnedToDepositCents, f.completedRefundCents, d.offsetCents, d.offsetGrossCents, d.offsetReturnedCents, d.remainingCents, d.status], [0, 9_500, 4_500, 0, 9_500, 9_500, 50_000, "RECEIVED"]);
  assert.equal((await verifyInvoice(w.tenantId, invoiceId)).intact, true);
});

test("Mehrere Zahlungsquellen: keine Quellenzuordnung durch das System; mehrere Gutschriften kumulieren, keine Doppelnutzung", async () => {
  // Rechnung 500: bar 250 vorab, 250 aus Kaution; Gutschrift 80 → 80 Guthaben ohne automatische Quellenwahl
  const { w, invoiceId, version, offsetPaymentId } = await settledWorld("cr-multi", { gross: "500", cash: "250" });
  const before = await counts(w.tenantId);
  await credit(w, invoiceId, version.items[0].id, "40");
  await credit(w, invoiceId, version.items[0].id, "20");
  assert.deepEqual(await counts(w.tenantId), before);
  let f = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f.creditedCents, f.customerCreditCents, f.refundRemainingCents], [6_000, 6_000, 6_000]);
  const o = await offsetReturnOptions(w.tenantId, invoiceId);
  assert.equal(o.counterDocuments.length, 2);
  await returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "25"));
  await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId }, cash("10"), { complete: true, confirmed: true });
  f = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f.returnedToDepositCents, f.completedRefundCents, f.refundRemainingCents], [2_500, 1_000, 2_500]);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId }, cash("25,01"), { complete: true, confirmed: true }), /Noch auszuzahlen sind 25,00/);
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "25,01")), /Verfügbar sind nur 25,00/);
});

test("Kaution bereits zurückgezahlt: Rückführung nicht angeboten und abgelehnt; historische Auszahlung unverändert; Guthaben bleibt auszahlbar", async () => {
  const { w, invoiceId, version, offsetPaymentId } = await settledWorld("cr-paidout");
  await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "405", method: "CASH", occurredAt: at });
  const { payout } = await createPayout(w.tenantId, w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId }, cash("405"), { complete: true, confirmed: true });
  await credit(w, invoiceId, version.items[0].id, "40");
  const o = await offsetReturnOptions(w.tenantId, invoiceId);
  assert.match(o.blockedReason ?? "", /bereits \(teilweise\) an den Kunden zurückgezahlt/);
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "40")), /zurückgezahlt/);
  const p = await db.payout.findUniqueOrThrow({ where: { id: payout.id } });
  assert.deepEqual([p.status, p.amountCents], ["COMPLETED", 40_500]);
  const d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([d.remainingCents, d.completedPayoutCents, d.offsetCents], [0, 40_500, 9_500], "keine wiedereröffnete Kaution");
  assert.equal((await payoutSource(db, w.tenantId, { sourceType: "INVOICE_REFUND", invoiceId })).remainingCents, 4_000);
});

test("Storno der Rückführung: nur mit Grund, beidseitig; blockiert, wenn die Beträge an der Kaution inzwischen verbraucht sind; Verrechnung mit Rückführungen nicht stornierbar; Einzelstornos abgelehnt", async () => {
  const { w, invoiceId, version, offsetPaymentId } = await settledWorld("cr-undo");
  await credit(w, invoiceId, version.items[0].id, "40");
  const r = await returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "40"));
  await assert.rejects(() => cancelDepositEvent(w.tenantId, w.actor, r.event.id, "falsch"), /Rückführung aus Kundenguthaben/);
  await assert.rejects(() => cancelDepositOffset(w.tenantId, w.actor, offsetPaymentId, "falsch"), /zuerst die Rückführung stornieren/);
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, offsetPaymentId, "falsch"), /Kautionsverrechnung/);
  const cashPay = await db.payment.findFirstOrThrow({ where: { tenantId: w.tenantId, invoiceId, type: "RENTAL_PAYMENT" } });
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, cashPay.id, "falsch"), /zur Kaution zurückgeführt/, "Storno der Barzahlung würde verbrauchtes Guthaben ungedeckt lassen");
  await assert.rejects(() => cancelOffsetReturn(w.tenantId, w.actor, r.event.id, "x"), /Grund/);
  const c = await cancelOffsetReturn(w.tenantId, w.actor, r.event.id, "irrtümlich zurückgeführt");
  assert.deepEqual([c.status, c.cancellationReason, c.amountCents], ["CANCELLED", "irrtümlich zurückgeführt", 4_000]);
  let f = await invoiceFinancials(w.tenantId, invoiceId);
  let d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([f.refundRemainingCents, f.returnedToDepositCents, d.offsetCents, d.remainingCents], [4_000, 0, 9_500, 40_500]);
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "DEPOSIT_OFFSET_RETURN_CANCELLED", invoiceId } }));
  await assert.rejects(() => cancelOffsetReturn(w.tenantId, w.actor, r.event.id, "nochmal"), /bereits storniert/);
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId, type: "OFFSET_RETURN" } }), 1, "Historie bleibt");
  // erneut zurückführen, dann die gesamte Kaution freigeben + auszahlen → Storno der Rückführung blockiert
  const r2 = await returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "40"));
  await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "445", method: "CASH", occurredAt: at });
  await assert.rejects(() => cancelOffsetReturn(w.tenantId, w.actor, r2.event.id, "doch nicht"), /bereits freigegeben|ausgezahlt/);
  const { payout } = await createPayout(w.tenantId, w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId }, cash("445"), { complete: true, confirmed: true });
  await assert.rejects(() => cancelOffsetReturn(w.tenantId, w.actor, r2.event.id, "doch nicht"), /bereits freigegeben|ausgezahlt/);
  await assert.rejects(() => db.securityDepositEvent.update({ where: { id: r2.event.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: "direkt" } }), /RB_DOMAIN|übersteigen|ausgezahlt/);
  await cancelPayout(w.tenantId, w.actor, payout.id, "Test: Auszahlung storniert");
  f = await invoiceFinancials(w.tenantId, invoiceId);
  d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([f.refundRemainingCents, d.offsetCents], [0, 5_500]);
  // Unveränderlichkeit
  await assert.rejects(() => db.securityDepositEvent.delete({ where: { id: r2.event.id } }), /RB_IMMUTABLE|nicht gelöscht/);
  await assert.rejects(() => db.securityDepositEvent.update({ where: { id: r2.event.id }, data: { amountCents: 1 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.securityDepositEvent.update({ where: { id: r2.event.id }, data: { returnsPaymentId: null, invoiceId: null } }), /RB_IMMUTABLE|rb_deposit_event_offset_return/);
});

test("Nebenläufigkeit: Doppelklick bucht einmal; zwei volle Rückführungen parallel – eine gewinnt; Auszahlung und Rückführung parallel verbrauchen nie mehr als das Guthaben; Teilbeträge parallel", async () => {
  const { w, invoiceId, version, offsetPaymentId } = await settledWorld("cr-race");
  await credit(w, invoiceId, version.items[0].id, "40");
  const same = returnInput(invoiceId, offsetPaymentId, "40", "cr-race-key-1");
  const [a, b] = await Promise.all([returnOffsetToDeposit(w.tenantId, w.actor, same), returnOffsetToDeposit(w.tenantId, w.actor, same)]);
  assert.equal([a, b].filter((x) => x.created).length, 1);
  assert.equal(a.event.id, b.event.id);
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId, type: "OFFSET_RETURN", status: "CONFIRMED" } }), 1);
  // zwei Tabs, je volle 40 €
  const t = await settledWorld("cr-race2");
  await credit(t.w, t.invoiceId, t.version.items[0].id, "40");
  const both = await Promise.allSettled([returnOffsetToDeposit(t.w.tenantId, t.w.actor, returnInput(t.invoiceId, t.offsetPaymentId, "40")), returnOffsetToDeposit(t.w.tenantId, t.w.actor, returnInput(t.invoiceId, t.offsetPaymentId, "40"))]);
  assert.equal(both.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await invoiceFinancials(t.w.tenantId, t.invoiceId)).returnedToDepositCents, 4_000);
  // Auszahlung 40 und Rückführung 40 gleichzeitig
  const u = await settledWorld("cr-race3");
  await credit(u.w, u.invoiceId, u.version.items[0].id, "40");
  await Promise.allSettled([
    createPayout(u.w.tenantId, u.w.actor, { sourceType: "INVOICE_REFUND", invoiceId: u.invoiceId }, cash("40"), { complete: true, confirmed: true }),
    returnOffsetToDeposit(u.w.tenantId, u.w.actor, returnInput(u.invoiceId, u.offsetPaymentId, "40")),
  ]);
  const fu = await invoiceFinancials(u.w.tenantId, u.invoiceId);
  assert.ok(fu.completedRefundCents + fu.returnedToDepositCents <= 4_000, `verbraucht ${fu.completedRefundCents + fu.returnedToDepositCents}`);
  assert.equal(fu.completedRefundCents + fu.returnedToDepositCents, 4_000, "genau eine Aktion gewinnt");
  // Teilbeträge parallel: 3 × 15 € bei 40 € → höchstens zwei gelingen
  const v = await settledWorld("cr-race4");
  await credit(v.w, v.invoiceId, v.version.items[0].id, "40");
  await Promise.allSettled([1, 2, 3].map(() => returnOffsetToDeposit(v.w.tenantId, v.w.actor, returnInput(v.invoiceId, v.offsetPaymentId, "15"))));
  const fv = await invoiceFinancials(v.w.tenantId, v.invoiceId);
  assert.deepEqual([fv.returnedToDepositCents, fv.refundRemainingCents], [3_000, 1_000]);
});

test("Mandantentrennung, fremde IDs, Rollen, Supportmodus", async () => {
  const { w, invoiceId, version, offsetPaymentId } = await settledWorld("cr-tenant");
  await credit(w, invoiceId, version.items[0].id, "40");
  const other = await settledWorld("cr-tenant-b");
  await credit(other.w, other.invoiceId, other.version.items[0].id, "40");
  // fremder Mandant: nichts sichtbar, nichts buchbar
  await assert.rejects(() => offsetReturnOptions(other.w.tenantId, invoiceId), /nicht gefunden/);
  await assert.rejects(() => returnOffsetToDeposit(other.w.tenantId, other.w.actor, returnInput(invoiceId, offsetPaymentId, "10")), /nicht gefunden/);
  // eigene Rechnung, fremde Verrechnungszahlung
  await assert.rejects(() => returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, other.offsetPaymentId, "10")), /nicht gefunden|gehört nicht/);
  const r = await returnOffsetToDeposit(w.tenantId, w.actor, returnInput(invoiceId, offsetPaymentId, "10"));
  await assert.rejects(() => cancelOffsetReturn(other.w.tenantId, other.w.actor, r.event.id, "fremd"), /nicht gefunden/);
  // Datenbank: Rückführung an fremde Rechnung/Zahlung
  const dep = await db.securityDeposit.findFirstOrThrow({ where: { bookingId: w.bookingId } });
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: w.tenantId, depositId: dep.id, type: "OFFSET_RETURN", amountCents: 100, occurredAt: at, invoiceId: other.invoiceId, returnsPaymentId: other.offsetPaymentId } }), /RB_DOMAIN|derselben Buchung/);
  assert.deepEqual([(await invoiceFinancials(other.w.tenantId, other.invoiceId)).returnedToDepositCents], [0]);
  // Rollen/Support: alle Aktionen serverseitig über requireRole("DISPO") (Hofmitarbeiter und Supportmodus werden dort abgewiesen)
  const actions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/finanzen/actions.ts"), "utf8");
  for (const fn of ["previewOffsetReturnAction", "returnOffsetToDepositAction", "cancelOffsetReturnAction"]) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 300), /requireRole\("DISPO"\)/, fn);
  }
  const auth = readFileSync(path.join(process.cwd(), "src/lib/auth.ts"), "utf8");
  assert.match(auth, /export async function requireRole[\s\S]{0,200}if \(session\.supportSession\) redirect/, "Supportmodus ist für Aktionen read-only");
  const yard = await createWorld("cr-yard");
  tenants.push(yard.tenantId);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: yard.userId } })).role, "YARD", "Testnutzer ist Hofmitarbeiter – die UI zeigt ihm keine Aktionen (canManage)");
});

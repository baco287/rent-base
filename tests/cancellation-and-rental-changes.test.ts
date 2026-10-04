// Befehl 28: Storno, Erstattung und Mietänderungen im Realbetrieb – echte Serverlogik gegen die lokale Datenbank.
// Storno ohne/mit Geld (Erstattung, Stornogebühr, Kundenguthaben, Kaution), Atomarität und Idempotenz, unterschriebener
// Vertrag, Stornobestätigung und Mail; Zeitraum vor dem Vertrag, Startverschiebung per Nachtrag, telefonische Verlängerung
// (vereinbart → reserviert → Unterschrift / Zurücknahme), Verkürzung, Folgekonflikte, Überfälligkeit, Verspätungsvorschlag,
// Historie, Kundenakte, Dispo, Rollen, Mandantentrennung und Datenbank-Invarianten.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { roleAllows } from "../src/lib/constants";
import { agreeAmendment, createAmendmentDraft, discardAmendment, effectiveContractState, getAmendmentContentHash, getAmendmentState, saveAmendmentSignature, signAmendment, updateAmendmentDraft } from "../src/lib/amendments";
import { changeBookingPeriod, previewBookingPeriodChange } from "../src/lib/booking-period";
import { assertVehicleBookable, findConflicts, isOverdue, occupiedUntil } from "../src/lib/bookings";
import { cancelBooking, cancellationOverview, previewCancellation, type CancellationInput } from "../src/lib/cancellation";
import { loadCancellationDocumentData } from "../src/lib/cancellation-document";
import { sendCancellationConfirmation } from "../src/lib/cancellation-mail";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { bookingTimeline, customerFinance, customerTimeline } from "../src/lib/customer-file";
import { applyDepositOffset } from "../src/lib/deposit-offset";
import { depositView, openDepositRows, recordDepositReceived } from "../src/lib/deposits";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { runCancellationFollowUp } from "../src/lib/followup";
import { getHandoverState, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { invoiceFinancials } from "../src/lib/counter-documents";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { cancelPayment } from "../src/lib/payments";
import { createPayout, openPayoutClaims } from "../src/lib/payouts";
import { renderCancellationPdf } from "../src/lib/pdf/cancellation-pdf";
import { prepaymentBalance, recordRentalPayment, rentalPaymentSummary } from "../src/lib/rental-payments";
import { buildComparison, confirmProposal, getReturnComparison } from "../src/lib/returns";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";
import { pickedUpWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-b28-"));
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

const DAY = 86_400_000;
const HOUR = 3_600_000;
const at = new Date(Date.now() - 60_000);
const IBAN = "DE89370400440532013000";
const nonce = (s: string) => `${s}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const key = () => randomUUID();
const TAX = { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" };
const plusMs = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** Reservierte Buchung (ohne Vertrag) mit Rechnungseinstellungen. */
async function reservedWorld(label: string): Promise<World> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: TAX });
  return w;
}
/** Unterschriebener Vertrag, Buchung RESERVED. */
async function signedWorld(label: string): Promise<World & { contractId: string }> {
  const w = await reservedWorld(label);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return { ...w, contractId: c.id };
}
async function active(label: string, opts: Parameters<typeof pickedUpWorld>[1] = {}) {
  const w = await pickedUpWorld(label, opts);
  tenants.push(w.tenantId);
  return w;
}
const pay = (w: World, amount: string) => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount, method: "CASH", paidAt: at });
const cash = (extra: Record<string, unknown> = {}) => ({ method: "CASH", confirmed: true, ...extra });
async function draft(w: World, label: string) { return (await createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: nonce(label) })).amendment; }
async function renterSign(w: World, id: string) { return saveAmendmentSignature(w.tenantId, w.actor, id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(5), seenHash: await getAmendmentContentHash(w.tenantId, id) }); }
async function signed(w: World, id: string) { await renterSign(w, id); return (await signAmendment(w.tenantId, w.actor, id)).amendment; }
const booking = (w: World) => db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
const audits = (w: World, action: string) => db.auditLog.findMany({ where: { tenantId: w.tenantId, action } });

// ===========================================================================
// STORNO
// ===========================================================================

test("1 Storno ohne Geld: Status, Grund, Zeit, Benutzer, eingefrorene Abrechnung, Audit; Fahrzeugzeitraum frei", async () => {
  const w = await reservedWorld("b28-plain");
  const b0 = await booking(w);
  const r = await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Kunde hat abgesagt", idempotencyKey: key() });
  assert.equal(r.created, true);
  const b = await booking(w);
  assert.equal(b.status, "CANCELLED"); assert.equal(b.cancellationReason, "Kunde hat abgesagt"); assert.equal(b.cancelledById, w.actor.id); assert.ok(b.cancelledAt && b.cancellationHash && b.cancellationSnapshot);
  assert.equal(r.snapshot!.finances.prepaidCents, 0); assert.equal(r.snapshot!.finances.fee, null); assert.equal(r.snapshot!.finances.refund.mode, "NONE");
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0, "keine Rechnung");
  assert.equal(await db.payout.count({ where: { tenantId: w.tenantId } }), 0, "keine Auszahlung");
  const a = (await audits(w, "BOOKING_CANCELLED"))[0];
  assert.equal((a.details as { reason: string }).reason, "Kunde hat abgesagt"); assert.equal(a.userId, w.actor.id);
  assert.deepEqual(await findConflicts(db, w.tenantId, w.vehicleId, b0.startAt, b0.endAt), [], "Zeitraum wieder frei");
  // endgültig: Datenbank sperrt Rückkehr und Änderung des Grundes
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { status: "RESERVED" } }), /RB_IMMUTABLE|rb_booking_cancellation/);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { cancellationReason: "anders" } }), /RB_IMMUTABLE/);
});

test("2 Storno mit Vorauszahlung verlangt eine bewusste Entscheidung; nichts wird halb gebucht", async () => {
  const w = await reservedWorld("b28-needs");
  await pay(w, "300");
  const ov = await cancellationOverview(w.tenantId, w.bookingId);
  assert.equal(ov.finances.prepaidCents, 30000); assert.equal(ov.needs.refundDecision, true); assert.equal(ov.allowed, true);
  await assert.rejects(() => cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Kunde sagt ab", idempotencyKey: key() }), /Bitte festlegen, was mit der Mietvorauszahlung geschieht: 300,00\s€/);
  assert.equal((await booking(w)).status, "RESERVED", "kein Teil-Storno");
  // Vorschau: rechnet, bucht nichts
  const { plan } = await previewCancellation(w.tenantId, w.bookingId, { reason: "Kunde sagt ab", refund: { mode: "CREDIT" } });
  assert.deepEqual([plan.creditCents, plan.refund.mode, plan.errors.length], [30000, "CREDIT", 0]);
  assert.equal((await booking(w)).status, "RESERVED");
});

test("3 Vorauszahlung vollständig erstatten: Auszahlung aus der Vorauszahlung (keine Hilfsrechnung), Zahlungen unverändert, nie doppelt", async () => {
  const w = await reservedWorld("b28-refund");
  const p = await pay(w, "300");
  const r = await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Kunde sagt ab", idempotencyKey: key(), refund: { mode: "PAYOUT", payout: cash() } });
  assert.equal(r.payoutIds.length, 1);
  const po = await db.payout.findUniqueOrThrow({ where: { id: r.payoutIds[0] } });
  assert.deepEqual([po.sourceType, po.status, po.amountCents, po.invoiceId], ["RENTAL_PREPAYMENT_REFUND", "COMPLETED", 30000, null]);
  assert.match(po.number ?? "", /^[A-Z]{1,6}-\d{4}-\d{6}$/);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0, "keine Fake-Rechnung");
  const pay0 = await db.payment.findUniqueOrThrow({ where: { id: p.payment.id } });
  assert.deepEqual([pay0.status, pay0.invoiceId, pay0.amountCents], ["CONFIRMED", null, 30000], "Zahlung unverändert");
  assert.equal((await prepaymentBalance(w.tenantId, w.bookingId)).remainingCents, 0);
  assert.equal((await audits(w, "RENTAL_PAYMENT_REFUND_CREATED")).length, 1);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, { sourceType: "RENTAL_PREPAYMENT_REFUND", bookingId: w.bookingId }, { amount: "1", method: "CASH", executedAt: at, receiptConfirmed: true }, { complete: true, confirmed: true }), /nichts zu erstatten/);
  // Datenbank: Storno der Zahlung würde die Erstattung ungedeckt lassen; Zuordnung zu einer Rechnung ebenso
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, p.payment.id, "Fehlbuchung"), /bereits erstattet|ungedeckt/);
  await assert.rejects(() => db.payment.update({ where: { id: p.payment.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: "x" } }), /RB_DOMAIN/);
});

test("4 Stornogebühr: eigene Rechnung (Steuer bewusst gewählt), Vorauszahlung zugeordnet, Rest 210 € ausgezahlt; ohne Steuerwahl kein Abschluss", async () => {
  const w = await signedWorld("b28-fee");
  const c0 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  await pay(w, "300");
  await assert.rejects(() => cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Storno", idempotencyKey: key(), fee: { amount: "90", description: "Stornogebühr laut Mietbedingungen", taxTreatment: "" }, refund: { mode: "CREDIT" } }), /steuerliche Behandlung/);
  assert.equal((await booking(w)).status, "RESERVED");
  const r = await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Kunde storniert kurzfristig", idempotencyKey: key(), fee: { amount: "90", description: "Stornogebühr laut Mietbedingungen", taxTreatment: "TAXABLE_SUPPLY" }, refund: { mode: "PAYOUT", payout: cash() } });
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: r.feeInvoiceId! }, include: { currentVersion: true } });
  assert.deepEqual([inv.kind, inv.status, inv.taxTreatment, String(inv.currentVersion!.grossTotal)], ["CANCELLATION_FEE", "FINALIZED", "TAXABLE_SUPPLY", "90"]);
  assert.deepEqual([String(inv.currentVersion!.netTotal), String(inv.currentVersion!.taxTotal)], ["75.63", "14.37"]);
  const f = await invoiceFinancials(w.tenantId, inv.id);
  assert.deepEqual([f.paidCents, f.effectiveCents, f.customerCreditCents, f.completedRefundCents, f.refundRemainingCents], [30000, 9000, 21000, 21000, 0]);
  const po = await db.payout.findUniqueOrThrow({ where: { id: r.payoutIds[0] } });
  assert.deepEqual([po.sourceType, po.invoiceId, po.amountCents], ["INVOICE_REFUND", inv.id, 21000]);
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId, invoiceId: inv.id, type: "RENTAL_PAYMENT" } }), 1, "Vorauszahlung der Gebühr zugeordnet");
  const c1 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal(String(c1.totalAmount), String(c0.totalAmount), "ursprünglicher Mietpreis unverändert");
  assert.equal((await audits(w, "CANCELLATION_FEE_CREATED")).length, 1);
  assert.equal(r.snapshot!.finances.fee!.grossCents, 9000);
  assert.equal(r.snapshot!.finances.refund.amountCents, 21000);
});

test("4b Stornogebühr nicht steuerbar: kein Steuersatz, Hinweis auf dem Beleg, keine „Schadensersatz“-Bezeichnung", async () => {
  const w = await reservedWorld("b28-fee-nt");
  const r = await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Storno", idempotencyKey: key(), fee: { amount: "50", description: "Stornogebühr", taxTreatment: "NON_TAXABLE_FEE" } });
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: r.feeInvoiceId! }, include: { currentVersion: { include: { items: true } } } });
  assert.deepEqual([String(inv.currentVersion!.taxTotal), String(inv.currentVersion!.items[0].taxRate)], ["0", "0"]);
  const doc = (await loadInvoiceDocumentData(w.tenantId, inv.currentVersion!.id)).doc;
  assert.equal(doc.nonTaxable, true);
  assert.match(doc.taxTreatmentNote ?? "", /ohne Umsatzsteuer/);
  assert.doesNotMatch(`${doc.taxTreatmentLabel} ${doc.taxTreatmentNote}`, /Schadensersatz/);
  assert.equal(r.snapshot!.finances.stillOwedCents, 5000, "ohne Vorauszahlung: offene Forderung");
  assert.equal((await invoiceFinancials(w.tenantId, inv.id)).openCents, 5000);
});

test("5 Rest als Kundenguthaben: an der Gebührenrechnung (mit Gebühr) bzw. an der Buchung (ohne) – in Kundenakte und offenen Ansprüchen, später auszahlbar", async () => {
  const w = await reservedWorld("b28-credit");
  await pay(w, "300");
  const r = await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Storno", idempotencyKey: key(), fee: { amount: "90", description: "Stornogebühr", taxTreatment: "TAXABLE_SUPPLY" }, refund: { mode: "CREDIT" } });
  assert.equal((await invoiceFinancials(w.tenantId, r.feeInvoiceId!)).refundRemainingCents, 21000);
  assert.ok((await openPayoutClaims(w.tenantId)).invoices.some((c) => c.invoiceId === r.feeInvoiceId && c.remainingCents === 21000));
  assert.equal((await customerFinance(w.tenantId, w.customerId)).sums.refundOpenCents, 21000);
  assert.equal((await audits(w, "RENTAL_PAYMENT_TO_CREDIT")).length, 1);

  const v = await reservedWorld("b28-credit2");
  await pay(v, "300");
  await cancelBooking(v.tenantId, v.actor, v.bookingId, { reason: "Storno", idempotencyKey: key(), refund: { mode: "CREDIT" } });
  const cf = await customerFinance(v.tenantId, v.customerId);
  assert.deepEqual(cf.prepayments.map((p) => [p.paidCents, p.remainingCents]), [[30000, 30000]]);
  assert.equal(cf.sums.refundOpenCents, 30000, "echtes Guthaben in der Kundenakte");
  assert.ok((await openPayoutClaims(v.tenantId)).prepayments.some((c) => c.bookingId === v.bookingId && c.remainingCents === 30000));
  await createPayout(v.tenantId, v.actor, { sourceType: "RENTAL_PREPAYMENT_REFUND", bookingId: v.bookingId }, { amount: "100", method: "BANK_TRANSFER", iban: IBAN, executedAt: at }, { complete: true, confirmed: true });
  assert.equal((await prepaymentBalance(v.tenantId, v.bookingId)).remainingCents, 20000);
  assert.equal(await db.invoice.count({ where: { tenantId: v.tenantId } }), 0, "keine automatische Verrechnung, keine Rechnung");
});

test("6 Kaution erhalten → freigeben und Rückzahlung dokumentieren; ohne Entscheidung kein Storno; „behalten“ bleibt als Aufgabe sichtbar", async () => {
  const w = await signedWorld("b28-dep");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await assert.rejects(() => cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Storno", idempotencyKey: key() }), /erhaltenen Kaution \(500,00\s€\)/);
  const r = await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Storno", idempotencyKey: key(), deposit: { mode: "RELEASE", payout: { method: "BANK_TRANSFER", iban: IBAN, confirmed: true } } });
  const dv = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([dv.receivedCents, dv.releasedCents, dv.remainingCents], [50000, 50000, 0]);
  const po = await db.payout.findUniqueOrThrow({ where: { id: r.payoutIds[0] } });
  assert.deepEqual([po.sourceType, po.amountCents, po.status], ["SECURITY_DEPOSIT_REFUND", 50000, "COMPLETED"]);
  assert.equal((await audits(w, "DEPOSIT_RELEASED_ON_CANCELLATION")).length, 1);

  const k = await signedWorld("b28-dep-keep");
  await recordDepositReceived(k.tenantId, k.actor, { bookingId: k.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await cancelBooking(k.tenantId, k.actor, k.bookingId, { reason: "Storno", idempotencyKey: key(), deposit: { mode: "KEEP" } });
  assert.equal((await depositView(k.tenantId, k.bookingId)).remainingCents, 50000);
  assert.ok((await openDepositRows(k.tenantId)).held.some((d) => d.booking.id === k.bookingId), "nicht hängen gelassen: offene Aufgabe");
});

test("7 Kaution + Stornogebühr: keine automatische Verrechnung – nur über die bestehende, bewusste Kautionsverrechnung", async () => {
  const w = await signedWorld("b28-dep-fee");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const r = await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Storno", idempotencyKey: key(), fee: { amount: "90", description: "Stornogebühr", taxTreatment: "TAXABLE_SUPPLY" }, deposit: { mode: "KEEP" } });
  assert.equal((await invoiceFinancials(w.tenantId, r.feeInvoiceId!)).openCents, 9000, "Gebühr offen");
  assert.equal((await depositView(w.tenantId, w.bookingId)).remainingCents, 50000, "Kaution unangetastet");
  await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId: r.feeInvoiceId!, amount: "90", occurredAt: new Date() });
  assert.equal((await invoiceFinancials(w.tenantId, r.feeInvoiceId!)).openCents, 0);
  assert.equal((await depositView(w.tenantId, w.bookingId)).remainingCents, 41000);
});

test("8 Unterschriebener Vertrag bleibt unverändert (Inhalt, Prüfsumme, Unterschriften); nur der Status zeigt die stornierte Buchung", async () => {
  const w = await signedWorld("b28-contract");
  const c0 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const sig0 = await db.signature.count({ where: { tenantId: w.tenantId, contractId: w.contractId } });
  await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Storno", idempotencyKey: key() });
  const c1 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal(c1.status, "CANCELLED");
  assert.deepEqual([c1.contentHash, String(c1.totalAmount), c1.startAt.getTime(), c1.endAt.getTime()], [c0.contentHash, String(c0.totalAmount), c0.startAt.getTime(), c0.endAt.getTime()]);
  assert.equal(await db.signature.count({ where: { tenantId: w.tenantId, contractId: w.contractId } }), sig0);
  await assert.rejects(() => db.rentalContract.update({ where: { id: w.contractId }, data: { totalAmount: 1 } }), /RB_IMMUTABLE/);
  const ov = await cancellationOverview(w.tenantId, w.bookingId);
  assert.ok(ov.blockers.some((b) => /bereits storniert/.test(b)));
});

test("9/10 Doppelklick (gleicher Schlüssel) → ein Abschluss; zwei Tabs (verschiedene Schlüssel) → keine doppelte Auszahlung", async () => {
  const w = await reservedWorld("b28-dbl");
  await pay(w, "200");
  const k = key();
  const input: CancellationInput = { reason: "Storno", idempotencyKey: k, refund: { mode: "PAYOUT", payout: cash() } };
  const [a, b] = await Promise.all([cancelBooking(w.tenantId, w.actor, w.bookingId, input), cancelBooking(w.tenantId, w.actor, w.bookingId, input)]);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(await db.payout.count({ where: { tenantId: w.tenantId } }), 1);
  assert.equal((await audits(w, "BOOKING_CANCELLED")).length, 1);
  const again = await cancelBooking(w.tenantId, w.actor, w.bookingId, input);
  assert.equal(again.created, false); assert.deepEqual(again.payoutIds, a.payoutIds.length ? a.payoutIds : b.payoutIds);

  const t = await reservedWorld("b28-tabs");
  await pay(t, "200");
  const res = await Promise.allSettled([1, 2].map(() => cancelBooking(t.tenantId, t.actor, t.bookingId, { reason: "Storno", idempotencyKey: key(), refund: { mode: "PAYOUT", payout: cash() } })));
  assert.equal(res.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(String((res.find((x) => x.status === "rejected") as PromiseRejectedResult).reason), /bereits storniert/);
  assert.equal(await db.payout.count({ where: { tenantId: t.tenantId } }), 1, "genau eine Erstattung");
});

test("11 Mandantentrennung: fremder Mandant storniert, prüft oder erstattet nichts", async () => {
  const w = await reservedWorld("b28-ten");
  await pay(w, "100");
  const o = await reservedWorld("b28-ten-o");
  await assert.rejects(() => cancelBooking(o.tenantId, o.actor, w.bookingId, { reason: "fremd", idempotencyKey: key(), refund: { mode: "CREDIT" } }), /nicht gefunden/);
  await assert.rejects(() => cancellationOverview(o.tenantId, w.bookingId), /nicht gefunden/);
  await assert.rejects(() => createPayout(o.tenantId, o.actor, { sourceType: "RENTAL_PREPAYMENT_REFUND", bookingId: w.bookingId }, { amount: "1", method: "CASH", executedAt: at, receiptConfirmed: true }, { complete: true, confirmed: true }), /nicht gefunden/);
  assert.equal((await booking(w)).status, "RESERVED");
});

test("12/13 Rollen und Supportmodus: Storno, Gebühr, Erstattung, Vereinbarung nur Inhaber/Disposition – serverseitig", () => {
  assert.equal(roleAllows("OWNER", ["DISPO"]), true);
  assert.equal(roleAllows("DISPO", ["DISPO"]), true);
  assert.equal(roleAllows("YARD", ["DISPO"]), false);
  const actions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/actions.ts"), "utf8");
  for (const fn of ["cancelBookingAction", "previewCancellationAction", "sendCancellationAction", "changePeriodAction", "previewPeriodChangeAction", "ensureCancellationDocumentAction"]) {
    assert.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`).exec(actions)?.[0] ?? "", /requireRole\("DISPO"\)/, fn);
  }
  assert.ok(!/"YARD"/.test(actions));
  const amend = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/nachtrag/actions.ts"), "utf8");
  assert.match(amend, /async function context\(\) \{\r?\n  const \{ tenant, user \} = await requireRole\("DISPO"\)/);
  for (const fn of ["agreeAmendmentAction", "withdrawAgreedAmendmentAction"]) assert.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`).exec(amend)?.[0] ?? "", /await context\(\)/, fn);
  const auth = readFileSync(path.join(process.cwd(), "src/lib/auth.ts"), "utf8");
  assert.match(auth, /export async function requireRole[\s\S]*?if \(session\.supportSession\) redirect\("\/heute\?fehler=support"\)/);
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/page.tsx"), "utf8");
  assert.match(page, /canCancel\(b\) && user\.role !== "YARD" && !supportSession \? await cancellationOverview/);
  assert.match(page, /const canChangePeriod = b\.status === "RESERVED" && b\.contract\?\.status !== "SIGNED" && user\.role !== "YARD" && !supportSession/);
});

test("Stornobestätigung: einmalig archiviert aus der eingefrorenen Abrechnung; Mail nur bewusst mit den neuen Belegen, gleicher nonce sendet nie zweimal", async () => {
  await ready;
  const w = await reservedWorld("b28-doc");
  await pay(w, "300");
  const r = await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Kunde krank", idempotencyKey: key(), fee: { amount: "90", description: "Stornogebühr", taxTreatment: "TAXABLE_SUPPLY" }, refund: { mode: "PAYOUT", payout: cash() } });
  const fu = await runCancellationFollowUp(w.tenantId, r, w.actor.id, { storage });
  assert.equal(fu.confirmation.ok, true, fu.confirmation.error); assert.equal(fu.feeInvoice?.ok, true); assert.ok(fu.payouts.every((x) => x.ok));
  const d1 = await db.document.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId: w.bookingId, type: "BOOKING_CANCELLATION" } });
  await runCancellationFollowUp(w.tenantId, r, w.actor.id, { storage });
  assert.equal(await db.document.count({ where: { tenantId: w.tenantId, type: "BOOKING_CANCELLATION" } }), 1, "kein zweites PDF");
  const data = await loadCancellationDocumentData(w.tenantId, w.bookingId);
  const text = (await renderCancellationPdf(data.doc)).trace.texts.join(" ¦ ");
  for (const needle of ["Stornobestätigung", (await booking(w)).number, "Kunde krank", "Stornogebühr", "Erstattet"]) assert.ok(text.includes(needle), needle);
  assert.equal(d1.checksum.length, 64);
  const t = new FakeTransport();
  const n = nonce("mail");
  const s1 = await sendCancellationConfirmation(w.tenantId, w.actor, w.bookingId, { nonce: n, transport: t, storage });
  assert.equal(s1.status, "SENT");
  assert.equal(t.sent[0].attachments?.length, 3, "Bestätigung + Gebührenrechnung + Auszahlungsbeleg");
  assert.ok(!(t.sent[0].attachments ?? []).some((x) => /Mietvertrag/.test(x.filename)), "keine alten Dokumente");
  const s2 = await sendCancellationConfirmation(w.tenantId, w.actor, w.bookingId, { nonce: n, transport: t, storage });
  assert.equal(s2.status, "DUPLICATE"); assert.equal(t.sent.length, 1);
});

// ===========================================================================
// ÄNDERUNGEN
// ===========================================================================

test("14/15 Zeitraum vor dem Vertrag: kontrolliert mit Grund, Preisvorschlag, Audit; Konflikt wird abgelehnt; Zahlungen bleiben", async () => {
  const w = await reservedWorld("b28-period");
  await pay(w, "100");
  const b0 = await booking(w);
  const ns = plusMs(b0.startAt, 5 * HOUR);
  const pv = await previewBookingPeriodChange(w.tenantId, w.bookingId, ns, b0.endAt);
  assert.equal(pv.error, null); assert.ok(pv.after); assert.equal(pv.paidCents, 10000);
  await assert.rejects(() => changeBookingPeriod(w.tenantId, w.actor, w.bookingId, { startAt: ns, endAt: b0.endAt, reason: "" }), /Grund/);
  await changeBookingPeriod(w.tenantId, w.actor, w.bookingId, { startAt: ns, endAt: b0.endAt, reason: "Kunde kommt erst um 15:00" });
  const b1 = await booking(w);
  assert.equal(b1.startAt.getTime(), ns.getTime());
  const a = (await audits(w, "BOOKING_PERIOD_CHANGED"))[0];
  const d = a.details as { startBefore: string; startAfter: string; priceBeforeCents: number; priceAfterCents: number; reason: string };
  assert.equal(new Date(d.startBefore).getTime(), b0.startAt.getTime()); assert.equal(d.reason, "Kunde kommt erst um 15:00"); assert.equal(typeof d.priceAfterCents, "number");
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId, bookingId: w.bookingId, status: "CONFIRMED" } }), 1, "Zahlung bleibt an der Buchung");
  // Konflikt: zweite Buchung desselben Fahrzeugs direkt danach
  const other = await db.booking.create({ data: { tenantId: w.tenantId, number: `X-${Date.now()}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: plusMs(b0.endAt, 2 * HOUR), endAt: plusMs(b0.endAt, 2 * DAY), dailyRate: 89, deposit: 500 } });
  await assert.rejects(() => changeBookingPeriod(w.tenantId, w.actor, w.bookingId, { startAt: ns, endAt: plusMs(b0.endAt, DAY), reason: "länger" }), new RegExp(`bereits für Buchung ${other.number} vorgesehen`));
  assert.equal((await booking(w)).endAt.getTime(), b0.endAt.getTime());
});

test("16 Unterschriebener Vertrag: keine direkte Zeitraumänderung; Startverschiebung nur per Nachtrag (Original unverändert)", async () => {
  const w = await signedWorld("b28-start");
  const b0 = await booking(w);
  await assert.rejects(() => changeBookingPeriod(w.tenantId, w.actor, w.bookingId, { startAt: plusMs(b0.startAt, HOUR), endAt: b0.endAt, reason: "später" }), /Nachtrag/);
  const a = await draft(w, "start");
  const ns = plusMs(b0.startAt, 3 * HOUR);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newStartAt: ns });
  const st = await getAmendmentState(w.tenantId, a.id);
  assert.ok(st.changes.some((c) => c.label === "Mietbeginn / Abholung"));
  const row = await signed(w, a.id);
  assert.equal((await booking(w)).startAt.getTime(), ns.getTime(), "Buchung (Disposition) übernimmt den neuen Beginn");
  const c = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal(c.startAt.getTime(), b0.startAt.getTime(), "Originalvertrag unverändert");
  const eff = await effectiveContractState(w.tenantId, w.contractId);
  assert.equal(eff.startAt.getTime(), ns.getTime()); assert.equal(eff.startChangedBy, row.number);
  const src = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/actions.ts"), "utf8");
  assert.match(src, /Der Zeitraum wird über „Zeitraum ändern“ geändert/, "freies Bearbeiten des Zeitraums gesperrt");
});

test("17/18/19 Telefonische Verlängerung: sofort reserviert, ohne Vertrags-/Rechnungswirkung, Inhalt fest; Unterschrift macht sie endgültig", async () => {
  const w = await active("b28-agree");
  const b0 = await booking(w);
  const c0 = await effectiveContractState(w.tenantId, w.contractId);
  const a = await draft(w, "ext");
  const newEnd = plusMs(b0.endAt, DAY);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: newEnd });
  const row0 = await db.contractAmendment.findUniqueOrThrow({ where: { id: a.id } });
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: row0.priceProposalCents });
  await assert.rejects(() => agreeAmendment(w.tenantId, w.actor, a.id, { channel: "FAX" }), /wie die Änderung vereinbart/);
  const agreed = await agreeAmendment(w.tenantId, w.actor, a.id, { channel: "PHONE", note: "Anruf 15:05" });
  assert.equal(agreed.status, "AGREED"); assert.ok(agreed.agreedAt);
  // operativ: blockiert sofort
  const conflicts = await findConflicts(db, w.tenantId, w.vehicleId, plusMs(b0.endAt, 2 * HOUR), plusMs(b0.endAt, 5 * HOUR));
  assert.deepEqual(conflicts.map((c) => c.id), [w.bookingId]);
  await assert.rejects(() => db.$transaction(async (tx) => { const r = await assertVehicleBookable(tx, w.tenantId, w.vehicleId, plusMs(b0.endAt, 2 * HOUR), plusMs(b0.endAt, 5 * HOUR)); if (r.conflicts.length) throw new Error("Doppelbelegung"); }), /Doppelbelegung/);
  // vertraglich/finanziell: noch nichts
  const c1 = await effectiveContractState(w.tenantId, w.contractId);
  assert.deepEqual([c1.endAt.getTime(), c1.totalCents], [c0.endAt.getTime(), c0.totalCents]);
  assert.equal((await booking(w)).endAt.getTime(), b0.endAt.getTime());
  assert.equal((await rentalPaymentSummary(w.tenantId, w.bookingId)).grossCents, c0.totalCents);
  // Inhalt fest: weder Fachlogik noch Datenbank ändern eine vereinbarte Änderung
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusMs(newEnd, DAY) }), /vereinbart/);
  await assert.rejects(() => db.contractAmendment.update({ where: { id: a.id }, data: { newEndAt: plusMs(newEnd, DAY) } }), /RB_IMMUTABLE/);
  await assert.rejects(() => createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: nonce("x2") }), /Unterschrift noch fehlt/);
  // Unterschrift nachholen
  const s = await signed(w, a.id);
  assert.equal(s.status, "SIGNED");
  assert.equal((await booking(w)).endAt.getTime(), newEnd.getTime());
  const c2 = await effectiveContractState(w.tenantId, w.contractId);
  assert.equal(c2.totalCents, c0.totalCents + (row0.priceProposalCents ?? 0), "Verlängerung genau einmal im Preis");
  assert.equal((s.snapshot as { agreed?: { channel: string } }).agreed?.channel, "PHONE");
  assert.deepEqual((await audits(w, "AMENDMENT_AGREED")).length, 1);
  assert.equal(((await audits(w, "AMENDMENT_SIGNED"))[0].details as { wasAgreed: boolean }).wasAgreed, true);
});

test("20 Zurücknahme einer vereinbarten Verlängerung: nur mit Grund, Reservierung entfällt, Vertrag unverändert, Historie bleibt", async () => {
  const w = await active("b28-withdraw");
  const b0 = await booking(w);
  const a = await draft(w, "w");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusMs(b0.endAt, DAY) });
  await agreeAmendment(w.tenantId, w.actor, a.id, { channel: "PHONE" });
  await assert.rejects(() => discardAmendment(w.tenantId, w.actor, a.id), /Grund/);
  const d = await discardAmendment(w.tenantId, w.actor, a.id, "Kunde hat doch abgesagt");
  assert.deepEqual([d.status, d.discardReason], ["DISCARDED", "Kunde hat doch abgesagt"]);
  assert.deepEqual(await findConflicts(db, w.tenantId, w.vehicleId, plusMs(b0.endAt, 2 * HOUR), plusMs(b0.endAt, 5 * HOUR)), [], "Reservierung aufgehoben");
  assert.equal((await booking(w)).endAt.getTime(), b0.endAt.getTime());
  const audit = (await audits(w, "AMENDMENT_DISCARDED"))[0].details as { wasAgreed: boolean; reason: string };
  assert.deepEqual([audit.wasAgreed, audit.reason], [true, "Kunde hat doch abgesagt"]);
  assert.equal(await db.contractAmendment.count({ where: { id: a.id } }), 1, "nicht gelöscht");
});

test("21 Rennen: Verlängerung vs. neue Buchung – nur eine gewinnt; zwei Vereinbarungen – ein Zustand; Unterschrift vs. Zurücknahme – ein Endzustand", async () => {
  const w = await active("b28-race");
  const b0 = await booking(w);
  const a = await draft(w, "r");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusMs(b0.endAt, 2 * DAY) });
  const res = await Promise.allSettled([
    agreeAmendment(w.tenantId, w.actor, a.id, { channel: "PHONE" }),
    db.$transaction(async (tx) => {
      const r = await assertVehicleBookable(tx, w.tenantId, w.vehicleId, plusMs(b0.endAt, 3 * HOUR), plusMs(b0.endAt, DAY));
      if (r.conflicts.length) throw new Error("Doppelbelegung");
      return tx.booking.create({ data: { tenantId: w.tenantId, number: `R-${Date.now()}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: plusMs(b0.endAt, 3 * HOUR), endAt: plusMs(b0.endAt, DAY), dailyRate: 89, deposit: 0 } });
    }),
  ]);
  assert.equal(res.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(res.map((x) => (x.status === "rejected" ? String(x.reason).slice(0, 120) : "ok"))));

  const v = await active("b28-race2");
  const v0 = await booking(v);
  const b = await draft(v, "r2");
  await updateAmendmentDraft(v.tenantId, v.actor, b.id, { newEndAt: plusMs(v0.endAt, DAY) });
  const two = await Promise.allSettled([agreeAmendment(v.tenantId, v.actor, b.id, { channel: "PHONE" }), agreeAmendment(v.tenantId, v.actor, b.id, { channel: "EMAIL" })]);
  assert.ok(two.every((x) => x.status === "fulfilled"));
  assert.equal((await audits(v, "AMENDMENT_AGREED")).length, 1, "einmal vereinbart");
  // Datenbank: höchstens eine vereinbarte Änderung je Vertrag
  const extra = await db.contractAmendment.create({ data: { tenantId: v.tenantId, contractId: v.contractId, bookingId: v.bookingId, idempotencyKey: nonce("raw"), newEndAt: plusMs(v0.endAt, 3 * DAY) } });
  await assert.rejects(() => db.contractAmendment.update({ where: { id: extra.id }, data: { status: "AGREED", agreedAt: new Date(), agreedChannel: "PHONE" } }), /rb_amendment_one_agreed|Unique|unique/i);
  await db.contractAmendment.delete({ where: { id: extra.id } });
  // Unterschrift gleichzeitig mit Zurücknahme
  await renterSign(v, b.id);
  const end = await Promise.allSettled([signAmendment(v.tenantId, v.actor, b.id), discardAmendment(v.tenantId, v.actor, b.id, "Kunde sagt ab")]);
  assert.equal(end.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(end.map((x) => (x.status === "rejected" ? String(x.reason).slice(0, 120) : "ok"))));
  const final = await db.contractAmendment.findUniqueOrThrow({ where: { id: b.id } });
  assert.ok(final.status === "SIGNED" || final.status === "DISCARDED");
  assert.equal((await booking(v)).endAt.getTime(), final.status === "SIGNED" ? plusMs(v0.endAt, DAY).getTime() : v0.endAt.getTime());
});

test("22/23 Verkürzung senkt den Preis nicht automatisch; bewusste Reduktion nur mit Begründung", async () => {
  const w = await active("b28-short");
  const b0 = await booking(w);
  const c0 = await effectiveContractState(w.tenantId, w.contractId);
  const a = await draft(w, "s");
  const row = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusMs(b0.endAt, -2 * DAY) });
  assert.ok(row.priceProposalCents != null && row.priceProposalCents < 0, "Vorschlag zeigt die mögliche Minderung");
  assert.equal((await getAmendmentState(w.tenantId, a.id)).changes.some((c) => c.kind === "PRICE"), false);
  await signed(w, a.id);
  assert.equal((await effectiveContractState(w.tenantId, w.contractId)).totalCents, c0.totalCents, "Preis bleibt");

  const v = await active("b28-short2");
  const v0 = await booking(v);
  const d0 = await effectiveContractState(v.tenantId, v.contractId);
  const b = await draft(v, "s2");
  const r2 = await updateAmendmentDraft(v.tenantId, v.actor, b.id, { newEndAt: plusMs(v0.endAt, -2 * DAY) });
  await updateAmendmentDraft(v.tenantId, v.actor, b.id, { priceDeltaCents: r2.priceProposalCents });
  assert.ok((await getAmendmentState(v.tenantId, b.id)).issues.some((i) => i.code === "PRICE_REASON" && /Preisreduktion/.test(i.message)));
  await renterSign(v, b.id);
  await assert.rejects(() => signAmendment(v.tenantId, v.actor, b.id), /Preisreduktion begründen/);
  await updateAmendmentDraft(v.tenantId, v.actor, b.id, { priceReason: "Fahrzeug früher zurück, Kulanz vereinbart" });
  await signed(v, b.id);
  assert.equal((await effectiveContractState(v.tenantId, v.contractId)).totalCents, d0.totalCents + r2.priceProposalCents!);
});

test("24/25 Folgekonflikt blockiert die Verlängerung klar; eine überfällige Miete wird durch vereinbarte Verlängerung nicht mehr als überfällig geführt", async () => {
  const w = await active("b28-follow");
  const b0 = await booking(w);
  const next = await db.booking.create({ data: { tenantId: w.tenantId, number: `F-${Date.now()}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: plusMs(b0.endAt, 14 * HOUR), endAt: plusMs(b0.endAt, 3 * DAY), dailyRate: 89, deposit: 0 } });
  const a = await draft(w, "f");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusMs(b0.endAt, 18 * HOUR) });
  const st = await getAmendmentState(w.tenantId, a.id);
  assert.ok(st.issues.some((i) => i.code === "CONFLICT" && new RegExp(`Verlängerung nicht möglich\\. Das Fahrzeug ist ab .+ bereits für Buchung ${next.number} vorgesehen`).test(i.message)), JSON.stringify(st.issues));
  await assert.rejects(() => agreeAmendment(w.tenantId, w.actor, a.id, { channel: "PHONE" }), /Verlängerung nicht möglich/);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: next.id } })).startAt.getTime(), next.startAt.getTime(), "keine Umbuchung der Folgebuchung");
  // überfällig (simuliertes „jetzt“ nach dem geplanten Ende) → mit vereinbarter Verlängerung nicht mehr überfällig
  const now = plusMs(b0.endAt, 2 * HOUR);
  assert.equal(isOverdue({ status: "ACTIVE", endAt: b0.endAt }, now), true);
  assert.equal(isOverdue({ status: "ACTIVE", endAt: b0.endAt, agreedEndAt: plusMs(b0.endAt, DAY) }, now), false);
  assert.equal(occupiedUntil({ status: "ACTIVE", endAt: b0.endAt, agreedEndAt: plusMs(b0.endAt, DAY) }, now).getTime(), plusMs(b0.endAt, DAY).getTime());
});

test("Rückgabe: vereinbarte, nicht unterschriebene Änderung sperrt den Abschluss der Rückgabe", async () => {
  const w = await active("b28-return-block");
  const b0 = await booking(w);
  const a = await draft(w, "rb");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusMs(b0.endAt, DAY) });
  await agreeAmendment(w.tenantId, w.actor, a.id, { channel: "PHONE" });
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  const st = await getHandoverState(w.tenantId, r.id);
  assert.ok(st.issues.some((i) => i.code === "AGREED_AMENDMENT_PENDING" && i.severity === "error"));
  // während der Rückgabe darf die vorab vereinbarte Änderung unterschrieben werden
  await signed(w, a.id);
  assert.equal((await getHandoverState(w.tenantId, r.id)).issues.some((i) => i.code === "AGREED_AMENDMENT_PENDING"), false);
});

test("Verspätung: Vorschlag nur nach eingefrorener Vertragsregel (Richtwert, Mietzeit nach Vertragspreis); manuell → nur Regel, kein Betrag", () => {
  const start = new Date("2026-11-02T08:00:00Z");
  const end = new Date("2026-11-04T08:00:00Z");
  const run = (values: Record<string, unknown>) => buildComparison({
    handover: { id: "r", extraCharges: [], dismissedProposals: [], driveType: "DIESEL", mileage: 10_100, fuelLevelEighths: 8, batteryPercent: null, finalizedAt: new Date(end.getTime() + 26 * HOUR), returnTimeOverrideAt: null, customerDropOffAt: null, fuelPricePerLiter: null },
    booking: { startAt: start, endAt: end, actualPickupAt: start },
    contract: { number: "MV-1", startAt: start, endAt: end, kmIncludedPerDay: 200, extraKmRate: "0.25", fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: "1.80", deposit: "500", deductible: "1000", vehicleSnapshot: {}, discountPercent: 0, priceSnapshot: { rates: { dailyRate: 89, workWeekRate: null, weeklyRate: null, monthlyRate: null } }, conditions: { rulesVersion: 1, values, sources: {} } },
    pickup: { id: "p", number: "UP-1", mileage: 10_000, fuelLevelEighths: 8, batteryPercent: null, finalizedAt: start },
  } as unknown as Parameters<typeof buildComparison>[0]);
  const fee = run({ lateReturnRule: "CONFIGURED_FEE", lateReturnFeeCents: 5000 });
  const pf = fee.proposals.find((p) => p.key === "LATE_RETURN");
  assert.equal(pf?.draft.amount, 50); assert.equal(pf?.confirmed, false, "nur Vorschlag");
  const time = run({ lateReturnRule: "ADDITIONAL_RENTAL_TIME" });
  const pt = time.proposals.find((p) => p.key === "LATE_RETURN");
  assert.ok(pt && pt.draft.amount > 0, "zusätzliche Mietzeit nach der eingefrorenen Preislogik");
  const manual = run({ lateReturnRule: "MANUAL" });
  assert.equal(manual.proposals.some((p) => p.key === "LATE_RETURN"), false);
  assert.ok(manual.hints.some((h) => h.code === "LATE_RETURN" && /Manuelle Bearbeitung/.test(h.text) && /kein Betrag/.test(h.text)));
});

test("Tank-Ersatz (Korrektur): ohne Tankgröße im Vertrag wird die Fahrzeugangabe auch live angezeigt und lässt sich bestätigen", async () => {
  const w = await active("b28-tank", { vehicle: { tankCapacityLiters: null } });
  assert.equal(((await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } })).vehicleSnapshot as { tankCapacityLiters?: number | null }).tankCapacityLiters ?? null, null);
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { tankCapacityLiters: 80 } });
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 45_500, fuelLevelEighths: 3 });
  const cmp = await getReturnComparison(w.tenantId, r.id);
  const fuel = cmp.proposals.find((p) => p.key === "FUEL");
  assert.equal(fuel?.draft.calculation.tankOrigin, "Fahrzeug");
  await confirmProposal(w.tenantId, r.id, w.actor.id, "FUEL");
  assert.equal(await db.extraCharge.count({ where: { tenantId: w.tenantId, handoverId: r.id, type: "FUEL" } }), 1);
});

test("26/27 Historie und Kundenakte: Storno mit Grund, Vereinbarung, Unterschrift, Zeitraumänderung, Guthaben – aus Zeitstempeln und Audit", async () => {
  const w = await active("b28-hist");
  const b0 = await booking(w);
  const a = await draft(w, "h");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusMs(b0.endAt, DAY) });
  await agreeAmendment(w.tenantId, w.actor, a.id, { channel: "PHONE" });
  const row = await signed(w, a.id);
  const h = await bookingTimeline(w.tenantId, w.bookingId);
  assert.ok(h.some((e) => /Vertragsänderung vereinbart \(telefonisch\)/.test(e.title)));
  assert.ok(h.some((e) => e.title.startsWith(`Nachtrag ${row.number} unterschrieben`)));
  assert.ok(h.some((e) => e.kind === "Übergabe"));

  const v = await reservedWorld("b28-hist2");
  await pay(v, "120");
  const vb = await booking(v);
  await changeBookingPeriod(v.tenantId, v.actor, v.bookingId, { startAt: plusMs(vb.startAt, HOUR), endAt: vb.endAt, reason: "später" });
  await cancelBooking(v.tenantId, v.actor, v.bookingId, { reason: "Termin entfällt", idempotencyKey: key(), refund: { mode: "CREDIT" } });
  const hv = await bookingTimeline(v.tenantId, v.bookingId);
  assert.ok(hv.some((e) => e.kind === "Storno" && e.detail?.startsWith("Termin entfällt")));
  assert.ok(hv.some((e) => e.title.startsWith("Zeitraum geändert")));
  assert.ok(hv.some((e) => e.title.startsWith("Mietvorauszahlung als Kundenguthaben belassen")));
  const ct = await customerTimeline(v.tenantId, v.customerId);
  assert.ok(ct.some((e) => e.kind === "Storno" && e.title.includes(vb.number)));
  assert.equal((await customerFinance(v.tenantId, v.customerId)).prepayments[0].remainingCents, 12000);
});

test("28 Dispo: vereinbarte Verlängerung eigens gekennzeichnet; dieselbe zentrale Belegungsregel wie die Verfügbarkeit", () => {
  const src = readFileSync(path.join(process.cwd(), "src/app/(app)/dispo/page.tsx"), "utf8");
  assert.match(src, /occupyingWhere\(/); assert.match(src, /contractAmendments: AGREED_EXTENSION_SELECT/);
  assert.match(src, /Verlängerung vereinbart – Unterschrift fehlt/);
  assert.match(src, /Rückgabe überfällig/);
  const lib = readFileSync(path.join(process.cwd(), "src/lib/bookings.ts"), "utf8");
  assert.match(lib, /ends\.push\(\{ contractAmendments: \{ some: \{ status: "AGREED", newEndAt: \{ gt: startAt \} \} \} \}\)/);
});

test("DB-Invarianten: Stornogebühr nur zu stornierter Buchung und mit Steuerbehandlung; Vorauszahlungs-Erstattung nur bei Storno; keine Mietzahlung nach Storno", async () => {
  const w = await reservedWorld("b28-inv");
  const base = { tenantId: w.tenantId, bookingId: w.bookingId, customerId: w.customerId, kind: "CANCELLATION_FEE", createdById: w.actor.id, changeLog: [] };
  await assert.rejects(() => db.invoice.create({ data: { ...base, taxTreatment: "TAXABLE_SUPPLY", sourceHash: nonce("h") } }), /nur zu einer stornierten Buchung/);
  await assert.rejects(() => db.payout.create({ data: { tenantId: w.tenantId, sourceType: "RENTAL_PREPAYMENT_REFUND", bookingId: w.bookingId, customerId: w.customerId, status: "DRAFT", amountCents: 100, method: "CASH", recipientName: "Erika Muster", idempotencyKey: nonce("p") } }), /nur zu einer stornierten Buchung/);
  await cancelBooking(w.tenantId, w.actor, w.bookingId, { reason: "Storno", idempotencyKey: key() });
  await assert.rejects(() => db.invoice.create({ data: { ...base, sourceHash: nonce("h2") } }), /rb_invoice_cancellation_fee|check/i);
  await assert.rejects(() => db.payment.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, type: "RENTAL_PAYMENT", method: "CASH", amountCents: 100, paidAt: at } }), /storniert/);
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "1", method: "CASH", paidAt: at }), /storniert/);
  // vereinbart ohne Vereinbarungsangaben ist unzulässig
  const s = await signedWorld("b28-inv2");
  const raw = await db.contractAmendment.create({ data: { tenantId: s.tenantId, contractId: s.contractId, bookingId: s.bookingId, idempotencyKey: nonce("a"), newEndAt: plusMs((await booking(s)).endAt, DAY) } });
  await assert.rejects(() => db.contractAmendment.update({ where: { id: raw.id }, data: { status: "AGREED" } }), /rb_amendment_agreed|check/i);
  await db.contractAmendment.delete({ where: { id: raw.id } });
});

// Befehl 20.7: Kautionsverrechnung. Bewusste Verrechnung erhaltener Kaution mit einer offenen Forderung derselben Buchung:
// Teil-/Vollverrechnung, Rest-Forderung und Rest-Kaution, keine Doppelnutzung (Einbehalt, Freigabe, Auszahlung), keine
// Überverrechnung, kein Geldeingang, Doppelklick, Parallelität, Mandantengrenze, Rollen, Audit, Summen, Storno beidseitig,
// Gutschrift nach Verrechnung (offene Entscheidung: nur ausgewiesen), Datenbank-Trigger.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { applyDepositOffset, cancelDepositOffset, depositOffsetOptions, previewDepositOffset } from "../src/lib/deposit-offset";
import { balanceOf, cancelDepositEvent, depositView, deriveDepositStatus, openDepositRows, recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { createCreditNoteDraft, finalizeCounterDocument, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { customerFinance } from "../src/lib/customer-file";
import { ensureInvoiceDraft, finalizeInvoice, updateInvoiceDraft, getInvoiceState } from "../src/lib/invoices";
import { cancelPayment, invoicePaymentSummary, recordInvoicePayment } from "../src/lib/payments";
import { createPayout, payoutSource } from "../src/lib/payouts";
import { purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});
const at = new Date(Date.now() - 60_000);

/** Zurückgegebene Miete mit abgeschlossener Rechnung über `gross` € (19 % inkl.) und `received` € erhaltener Kaution (vereinbart 500 €). */
async function offsetWorld(label: string, opts: { gross: string; received?: string | null; paid?: string | null }) {
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const st = await getInvoiceState(w.tenantId, inv.id);
  const items = st.draft!.items;
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: items[0].id, description: items[0].description, quantity: "1", unit: "pauschal", unitPrice: opts.gross, taxRate: "19" }] });
  const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  if (opts.received !== null) await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: opts.received ?? "500", method: "CASH", occurredAt: at });
  if (opts.paid) await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: opts.paid, method: "CASH", paidAt: at });
  return { w, invoiceId: inv.id, v1 };
}

test("Status: Verrechnung zählt wie Einbehalt, Rest bleibt verfügbar; bestehende Signatur unverändert", () => {
  assert.equal(deriveDepositStatus(50_000, 0, 0), "RECEIVED");
  assert.equal(deriveDepositStatus(50_000, 0, 0, 49_500), "PARTIALLY_RELEASED");
  assert.equal(deriveDepositStatus(50_000, 0, 0, 50_000), "RETAINED", "vollständig verrechnet: Status wie einbehalten, Anzeige über offsetCents");
  assert.equal(deriveDepositStatus(50_000, 500, 0, 49_500), "PARTIALLY_RELEASED");
  const b = balanceOf(50_000, [{ type: "RECEIVED", amountCents: 50_000, status: "CONFIRMED" }, { type: "OFFSET", amountCents: 49_500, status: "CONFIRMED" }, { type: "OFFSET", amountCents: 100, status: "CANCELLED" }]);
  assert.deepEqual([b.receivedCents, b.offsetCents, b.retainedCents, b.remainingCents, b.status], [50_000, 49_500, 0, 500, "PARTIALLY_RELEASED"]);
});

test("Beispiel: Rechnung 845 €, bezahlt 350 €, offen 495 €, Kaution 500 € → 495 € verrechnet, 5 € Rest, danach Freigabe + Auszahlung von höchstens 5 €", async () => {
  const { w, invoiceId } = await offsetWorld("off-basic", { gross: "845", paid: "350" });
  const s0 = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s0.grossCents, s0.paidCents, s0.openCents, s0.offsetCents], [84_500, 35_000, 49_500, 0]);

  const o = await depositOffsetOptions(w.tenantId, w.bookingId);
  assert.equal(o.blockedReason, null);
  assert.deepEqual([o.availableCents, o.invoices.length, o.invoices[0].openCents], [50_000, 1, 49_500]);

  const pv = await previewDepositOffset(w.tenantId, w.bookingId, invoiceId, "");
  assert.deepEqual([pv.openCents, pv.receivedCents, pv.availableCents, pv.suggestedCents, pv.amountCents, pv.claimAfterCents, pv.depositAfterCents, pv.invoiceStatusAfter, pv.error], [49_500, 50_000, 50_000, 49_500, 49_500, 0, 500, "PAID", null]);

  const r = await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: null, occurredAt: at, idempotencyKey: "off-basic-key-1" });
  assert.equal(r.created, true);
  assert.deepEqual([r.payment.type, r.payment.method, r.payment.amountCents, r.payment.invoiceId, r.payment.status], ["DEPOSIT_OFFSET", "DEPOSIT_OFFSET", 49_500, invoiceId, "CONFIRMED"]);
  assert.deepEqual([r.event?.type, r.event?.amountCents, r.event?.method, r.event?.paymentId, r.event?.status], ["OFFSET", 49_500, null, r.payment.id, "CONFIRMED"]);

  // Rechnungsseite: offen 0, bezahlt enthält die Verrechnung – getrennt ausgewiesen; kein Kundenguthaben
  const s1 = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s1.paidCents, s1.offsetCents, s1.openCents, s1.overpaidCents, s1.status], [84_500, 49_500, 0, 0, "PAID"]);
  // Kautionsseite: verrechnet 495, verfügbar 5, nichts ausgezahlt
  const v1 = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v1.receivedCents, v1.offsetCents, v1.retainedCents, v1.releasedCents, v1.remainingCents, v1.completedPayoutCents, v1.payoutRemainingCents, v1.status], [50_000, 49_500, 0, 0, 500, 0, 0, "PARTIALLY_RELEASED"]);
  // kein neues Geld: keine Bar-/Bankzahlung entstanden
  const cash = await db.payment.findMany({ where: { tenantId: w.tenantId, invoiceId, method: { in: ["CASH", "CARD", "BANK_TRANSFER", "OTHER"] }, status: "CONFIRMED" } });
  assert.equal(cash.reduce((a, p) => a + p.amountCents, 0), 35_000);
  // Audit: Rechnung, Buchung, Betrag, Benutzer, Zeitpunkt
  const audit = await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "DEPOSIT_OFFSET_APPLIED" } });
  assert.ok(audit);
  assert.deepEqual([audit.invoiceId, audit.bookingId, audit.paymentId, audit.amountCents, audit.userId, audit.userName], [invoiceId, w.bookingId, r.payment.id, 49_500, w.actor.id, w.actor.name]);
  assert.equal((audit.details as { openAfter: number }).openAfter, 0);
  assert.ok(audit.createdAt instanceof Date);

  // Rest 5 € über den bestehenden Kautionsprozess: Freigabe nur bis 5 €, Auszahlung nur bis 5 €
  await assert.rejects(() => settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "5,01", occurredAt: at }), /Freigabe über die erhaltene Kaution hinaus/);
  const rel = await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "5", method: "CASH", occurredAt: at });
  assert.deepEqual([rel.kind, rel.events[0].amountCents], ["RELEASE", 500]);
  const src = await payoutSource(db, w.tenantId, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId });
  assert.equal(src.remainingCents, 500);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId }, { amount: "5,01", method: "CASH", executedAt: at, recipientName: "Erika Muster", receiptConfirmed: true }, { complete: true, confirmed: true }), /Noch auszuzahlen sind 5,00/);
  const { payout } = await createPayout(w.tenantId, w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId }, { amount: "5", method: "CASH", executedAt: at, recipientName: "Erika Muster", receiptConfirmed: true }, { complete: true, confirmed: true });
  assert.deepEqual([payout.status, payout.amountCents], ["COMPLETED", 500]);
  const v2 = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v2.completedPayoutCents, v2.payoutRemainingCents, v2.remainingCents, v2.status], [500, 0, 0, "PARTIALLY_RELEASED"]);
  // Datenbank-Trigger: direkt eine weitere Auszahlung über die verbrauchte Kaution scheitert
  await assert.rejects(() => db.payout.create({ data: { tenantId: w.tenantId, sourceType: "SECURITY_DEPOSIT_REFUND", securityDepositId: v2.deposit!.id, bookingId: w.bookingId, customerId: w.customerId, status: "COMPLETED", amountCents: 100, method: "CASH", executedAt: at, recipientName: "X" } }), /nichts mehr auszuzahlen|übersteigt/);
  // Kundenakte-Summen: bezahlt 845, davon 495 verrechnet
  const fin = await customerFinance(w.tenantId, w.customerId);
  assert.deepEqual([fin.sums.paidCents, fin.sums.offsetCents, fin.sums.openCents], [84_500, 49_500, 0]);
  // Dashboard: keine offene Kaution mehr
  const open = await openDepositRows(w.tenantId);
  assert.equal(open.held.some((h) => h.bookingId === w.bookingId), false);
});

test("Teilverrechnung: offen 700 €, Kaution 500 € → höchstens 500 €, Rechnung 200 € offen; zweite Verrechnung nur aus dem Rest; Nutzer-Teilbetrag", async () => {
  const { w, invoiceId } = await offsetWorld("off-partial", { gross: "700" });
  const pv = await previewDepositOffset(w.tenantId, w.bookingId, invoiceId, "");
  assert.deepEqual([pv.openCents, pv.availableCents, pv.suggestedCents, pv.claimAfterCents, pv.depositAfterCents, pv.invoiceStatusAfter], [70_000, 50_000, 50_000, 20_000, 0, "PARTIAL"]);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "500,01", occurredAt: at }), /Verfügbar sind nur 500,00/);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "0", occurredAt: at }), /größer als 0,00/);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "abc", occurredAt: at }), /gültigen Betrag/);
  // bewusster Teilbetrag durch den Nutzer
  const r1 = await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "120", occurredAt: at });
  assert.equal(r1.payment.amountCents, 12_000);
  let s = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s.paidCents, s.openCents, s.status], [12_000, 58_000, "PARTIAL"]);
  let v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.offsetCents, v.remainingCents], [12_000, 38_000]);
  // Rest: nur noch 380 verfügbar → Vorschlag 380, Rechnung danach 200 offen
  const pv2 = await previewDepositOffset(w.tenantId, w.bookingId, invoiceId, null);
  assert.deepEqual([pv2.offsetCents, pv2.availableCents, pv2.suggestedCents, pv2.claimAfterCents], [12_000, 38_000, 38_000, 20_000]);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "380,01", occurredAt: at }), /Verfügbar sind nur 380,00/);
  const r2 = await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: null, occurredAt: at });
  assert.equal(r2.payment.amountCents, 38_000);
  s = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s.paidCents, s.offsetCents, s.openCents, s.status], [50_000, 50_000, 20_000, "PARTIAL"]);
  v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.offsetCents, v.remainingCents, v.status], [50_000, 0, "RETAINED"]);
  // Kaution verbraucht: nichts mehr verrechenbar, nichts freizugeben
  const o = await depositOffsetOptions(w.tenantId, w.bookingId);
  assert.match(o.blockedReason ?? "", /vollständig freigegeben, einbehalten oder verrechnet/);
  await assert.rejects(() => settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "1", occurredAt: at }), /bereits vollständig/);
  // Rest der Forderung mit normaler Zahlung begleichbar; Überzahlung weiter blockiert
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "200,01", method: "CASH", paidAt: at }), /Überzahlung/);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "200", method: "CASH", paidAt: at });
  s = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s.paidCents, s.offsetCents, s.openCents, s.status], [70_000, 50_000, 0, "PAID"]);
});

test("Keine Kaution erhalten, bereits ausgezahlt/freigegeben, Einbehalt: nichts wird doppelt verwendet", async () => {
  // keine Kaution erhalten
  const a = await offsetWorld("off-none", { gross: "300", received: null });
  const oa = await depositOffsetOptions(a.w.tenantId, a.w.bookingId);
  assert.match(oa.blockedReason ?? "", /noch keine Kaution/);
  await assert.rejects(() => applyDepositOffset(a.w.tenantId, a.w.actor, { bookingId: a.w.bookingId, invoiceId: a.invoiceId, occurredAt: at }), /noch keine Kaution/);

  // Kaution freigegeben und ausgezahlt: nichts verfügbar
  const b = await offsetWorld("off-paidout", { gross: "300" });
  await settleDeposit(b.w.tenantId, b.w.actor, { bookingId: b.w.bookingId, releaseAmount: "500", method: "CASH", occurredAt: at });
  await createPayout(b.w.tenantId, b.w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: b.w.bookingId }, { amount: "500", method: "CASH", executedAt: at, recipientName: "Erika Muster", receiptConfirmed: true }, { complete: true, confirmed: true });
  await assert.rejects(() => applyDepositOffset(b.w.tenantId, b.w.actor, { bookingId: b.w.bookingId, invoiceId: b.invoiceId, occurredAt: at }), /nichts mehr verfügbar/);
  // auch direkt in der Datenbank: Verrechnung über die erhaltene Kaution hinaus scheitert am Trigger
  const dep = await db.securityDeposit.findFirstOrThrow({ where: { bookingId: b.w.bookingId } });
  const fake = await db.payment.create({ data: { tenantId: b.w.tenantId, bookingId: b.w.bookingId, invoiceId: b.invoiceId, type: "DEPOSIT_OFFSET", method: "DEPOSIT_OFFSET", amountCents: 100, paidAt: at } });
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: b.w.tenantId, depositId: dep.id, type: "OFFSET", amountCents: 100, occurredAt: at, paymentId: fake.id } }), /nicht übersteigen/);
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: b.w.tenantId, depositId: dep.id, type: "OFFSET", amountCents: 100, occurredAt: at } }), /Verrechnungszahlung|rb_deposit_event_offset_payment/i, "OFFSET ohne Zahlung: Trigger bzw. CHECK verweigern");
  // Zahlung eines anderen Mandanten/einer anderen Buchung taugt nicht als Verrechnungszahlung
  const foreign = await db.payment.create({ data: { tenantId: a.w.tenantId, bookingId: a.w.bookingId, invoiceId: a.invoiceId, type: "DEPOSIT_OFFSET", method: "DEPOSIT_OFFSET", amountCents: 100, paidAt: at } });
  await assert.rejects(() => db.securityDepositEvent.create({ data: { tenantId: b.w.tenantId, depositId: dep.id, type: "OFFSET", amountCents: 100, occurredAt: at, paymentId: foreign.id } }), /Verrechnungszahlung derselben Buchung/);

  // Einbehalt 200 wegen ungeklärtem Schaden: nur 300 verfügbar; Einbehalt ist keine Verrechnung
  const c = await offsetWorld("off-retained", { gross: "400" });
  await settleDeposit(c.w.tenantId, c.w.actor, { bookingId: c.w.bookingId, releaseAmount: "300", reason: "Prüfung Schaden Heckklappe", occurredAt: at }); // 300 freigegeben, 200 einbehalten
  let o = await depositOffsetOptions(c.w.tenantId, c.w.bookingId);
  assert.match(o.blockedReason ?? "", /vollständig freigegeben, einbehalten oder verrechnet/, "freigegeben + einbehalten = alles zugeordnet, nichts verfügbar");
  // Freigabe zurücknehmen (Storno) → 300 wieder verfügbar, Einbehalt 200 bleibt gesperrt
  const released = await db.securityDepositEvent.findFirstOrThrow({ where: { tenantId: c.w.tenantId, depositId: (await db.securityDeposit.findFirstOrThrow({ where: { bookingId: c.w.bookingId } })).id, type: "RELEASED" } });
  await cancelDepositEvent(c.w.tenantId, c.w.actor, released.id, "Doch verrechnen");
  o = await depositOffsetOptions(c.w.tenantId, c.w.bookingId);
  assert.deepEqual([o.blockedReason, o.availableCents, o.deposit.retainedCents], [null, 30_000, 20_000]);
  await assert.rejects(() => applyDepositOffset(c.w.tenantId, c.w.actor, { bookingId: c.w.bookingId, invoiceId: c.invoiceId, amount: "300,01", occurredAt: at }), /Verfügbar sind nur 300,00/);
  const r = await applyDepositOffset(c.w.tenantId, c.w.actor, { bookingId: c.w.bookingId, invoiceId: c.invoiceId, occurredAt: at });
  assert.equal(r.payment.amountCents, 30_000);
  const v = await depositView(c.w.tenantId, c.w.bookingId);
  assert.deepEqual([v.retainedCents, v.offsetCents, v.remainingCents, v.status], [20_000, 30_000, 0, "RETAINED"]);
  assert.equal((await invoicePaymentSummary(c.w.tenantId, c.invoiceId)).openCents, 10_000);
});

test("Nur nach Rückgabe, nur gleiche Buchung, nur abgeschlossene Rechnung ohne Gegenbeleg-Entwurf; stornierte/gutgeschriebene Forderung nicht verrechenbar", async () => {
  const { w, invoiceId, v1 } = await offsetWorld("off-guards", { gross: "300" });
  // fremde Buchung / fremder Mandant
  const other = await offsetWorld("off-guards-other", { gross: "100" });
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId: other.invoiceId, occurredAt: at }), /Rechnung nicht gefunden/);
  await assert.rejects(() => applyDepositOffset(other.w.tenantId, other.w.actor, { bookingId: w.bookingId, invoiceId, occurredAt: at }), /nicht gefunden/);
  // Gegenbeleg-Entwurf blockiert
  const cn = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, occurredAt: at }), /Gegenbeleg-Entwurf/);
  assert.match((await previewDepositOffset(w.tenantId, w.bookingId, invoiceId, "")).error ?? "", /Gegenbeleg-Entwurf/);
  // vollständige Gutschrift: nichts mehr offen → nicht verrechenbar
  await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "300" }], reason: "Kulanz" });
  await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
  const o = await depositOffsetOptions(w.tenantId, w.bookingId);
  assert.match(o.blockedReason ?? "", /keine offene Forderung/);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, occurredAt: at }), /vollständig bezahlt|keine offene|nichts zu verrechnen/);
  // Gutschrift selbst ist keine Rechnung
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId: cn.id, occurredAt: at }), /nicht mit Gutschriften|nicht offen|nichts zu verrechnen/);
  // vor der Rückgabe: blockiert (laufende Miete im selben Mandanten)
  const running = await returnedWorld("off-running", { within: w, stopAfterPickup: true });
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: running.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const or = await depositOffsetOptions(w.tenantId, running.bookingId);
  assert.match(or.blockedReason ?? "", /erst nach der Rückgabe/);
});

test("Doppelklick (gleicher Schlüssel) bucht einmal; zwei parallele Verrechnungen verbrauchen zusammen nie mehr als verfügbar", async () => {
  const { w, invoiceId } = await offsetWorld("off-race", { gross: "800" });
  const input = { bookingId: w.bookingId, invoiceId, amount: "300", occurredAt: at, idempotencyKey: "off-race-key-1" };
  const [a, b] = await Promise.all([applyDepositOffset(w.tenantId, w.actor, input), applyDepositOffset(w.tenantId, w.actor, input)]);
  assert.equal([a, b].filter((r) => r.created).length, 1);
  assert.equal(a.payment.id, b.payment.id);
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId, type: "DEPOSIT_OFFSET" } }), 1);
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId, type: "OFFSET" } }), 1);
  // zwei verschiedene Verrechnungen gleichzeitig über 200 + 200 bei 200 Rest: genau eine gewinnt
  const results = await Promise.allSettled([
    applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "200", occurredAt: at }),
    applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "200", occurredAt: at }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason?.message), /Verfügbar sind nur 0,00|nichts mehr verfügbar/);
  const v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.offsetCents, v.remainingCents], [50_000, 0]);
  assert.equal((await invoicePaymentSummary(w.tenantId, invoiceId)).openCents, 30_000);
});

test("Storno beidseitig mit Grund; normale Stornos lehnen Verrechnungszeilen ab; RECEIVED-Storno nach Verrechnung scheitert; Gutschrift nach Verrechnung wird nur ausgewiesen", async () => {
  const { w, invoiceId, v1 } = await offsetWorld("off-cancel", { gross: "300" });
  const r = await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "300", occurredAt: at });
  // einseitige Stornos verweigert
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, r.payment.id, "falsch"), /Kautionsverrechnung/);
  await assert.rejects(() => cancelDepositEvent(w.tenantId, w.actor, r.event!.id, "falsch"), /Kautionsverrechnung/);
  // Eingang kann nicht storniert werden, solange die Verrechnung ihn verbraucht (Trigger: settled > received)
  const received = await db.securityDepositEvent.findFirstOrThrow({ where: { tenantId: w.tenantId, type: "RECEIVED" } });
  await assert.rejects(() => cancelDepositEvent(w.tenantId, w.actor, received.id, "falsch erfasst"), /nicht übersteigen/);
  // Gutschrift 100 € nach vollständiger Verrechnung: Guthaben 100 wird ausgewiesen, Verrechnung bleibt (offene Entscheidung, kein Automatismus)
  const cn = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "100" }], reason: "Kulanz" });
  await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
  const s = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s.grossCents, s.paidCents, s.offsetCents, s.openCents, s.overpaidCents, s.status], [20_000, 30_000, 30_000, 0, 10_000, "OVERPAID"]);
  const src = await payoutSource(db, w.tenantId, { sourceType: "INVOICE_REFUND", invoiceId });
  assert.deepEqual([src.remainingCents, src.snapshot.offsetCents], [10_000, 30_000]);
  assert.equal((await depositView(w.tenantId, w.bookingId)).offsetCents, 30_000, "Kaution bleibt verrechnet – keine automatische Rückführung");
  // Storno der Verrechnung: beide Seiten, Forderung wieder offen (Rest nach Gutschrift), Kaution wieder verfügbar, Audit
  await assert.rejects(() => cancelDepositOffset(w.tenantId, w.actor, r.payment.id, "x"), /Grund/);
  const c = await cancelDepositOffset(w.tenantId, w.actor, r.payment.id, "Kunde zahlt per Überweisung");
  assert.deepEqual([c.payment.status, c.payment.cancellationReason, c.event.status, c.event.cancellationReason], ["CANCELLED", "Kunde zahlt per Überweisung", "CANCELLED", "Kunde zahlt per Überweisung"]);
  const s2 = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s2.paidCents, s2.offsetCents, s2.openCents, s2.status], [0, 0, 20_000, "OPEN"]);
  const v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.offsetCents, v.remainingCents, v.status], [0, 50_000, "RECEIVED"]);
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "DEPOSIT_OFFSET_CANCELLED", paymentId: r.payment.id } }));
  await assert.rejects(() => cancelDepositOffset(w.tenantId, w.actor, r.payment.id, "nochmal"), /bereits storniert/);
  // Unveränderlichkeit: bestätigte Verrechnungszeilen lassen sich nicht löschen
  const r2 = await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "200", occurredAt: at });
  await assert.rejects(() => db.payment.delete({ where: { id: r2.payment.id } }), /RB_IMMUTABLE|nicht gelöscht/);
  await assert.rejects(() => db.securityDepositEvent.delete({ where: { id: r2.event!.id } }), /RB_IMMUTABLE|nicht gelöscht/);
});

test("Verrechnung nie als normale Zahlungsart: Zahlungsformular lehnt DEPOSIT_OFFSET ab; Rollen serverseitig", async () => {
  const { w, invoiceId } = await offsetWorld("off-method", { gross: "300" });
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "10", method: "DEPOSIT_OFFSET", paidAt: at }), /Unbekannte Zahlungsart/);
  await assert.rejects(() => recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "1", method: "DEPOSIT_OFFSET", occurredAt: at }), /Zahlungsart|vereinbarte Kaution/);
  const src = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/finanzen/actions.ts"), "utf8");
  for (const fn of ["previewDepositOffsetAction", "applyDepositOffsetAction", "cancelDepositOffsetAction"]) {
    const body = src.slice(src.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 400), /requireRole\("DISPO"\)/, `${fn}: nur Inhaber und Disposition`);
  }
});

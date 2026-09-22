// Zahlungen: Erfassen auf abgeschlossene Rechnungen, Teilzahlungen, Überzahlungsschutz, abgeleiteter Zahlungsstatus,
// Storno mit Grund, Serialisierung paralleler Buchungen, Idempotenz, Unveränderlichkeit, Mandantentrennung, Protokoll.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { isImmutableError } from "../src/lib/integrity";
import { ensureInvoiceDraft, finalizeInvoice, verifyInvoice } from "../src/lib/invoices";
import { cancelPayment, invoicePaymentSummary, paymentStatusOf, paymentSummaries, previewInvoicePayment, recordInvoicePayment } from "../src/lib/payments";
import { toCents } from "../src/lib/money";
import { purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

/** Abgeschlossene Rechnung auf einer zurückgegebenen Miete. */
async function invoicedWorld(label: string) {
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  const draft = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const inv = await finalizeInvoice(w.tenantId, draft.id, w.actor);
  return { w, inv, gross: toCents(inv.grossTotal), hashBefore: inv.contentHash! };
}
const at = new Date(Date.now() - 60_000);

test("Zahlungsstatus wird abgeleitet: offen, teilbezahlt, bezahlt; Cent-genau", () => {
  assert.equal(paymentStatusOf(100_000, 0), "OPEN");
  assert.equal(paymentStatusOf(100_000, 30_000), "PARTIAL");
  assert.equal(paymentStatusOf(100_000, 99_999), "PARTIAL");
  assert.equal(paymentStatusOf(100_000, 100_000), "PAID");
});

test("Vollständige Zahlung, Teilzahlungen, Überzahlung/0 €/negativ blockiert, Rechnung bleibt unverändert, Vorschau serverseitig", async () => {
  const { w, inv, gross, hashBefore } = await invoicedWorld("pay-basic");
  assert.deepEqual(await invoicePaymentSummary(w.tenantId, inv.id), { grossCents: gross, paidCents: 0, openCents: gross, status: "OPEN" });

  // ungültige Beträge
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "0", method: "CASH", paidAt: at }), /größer als 0,00/);
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "-5", method: "CASH", paidAt: at }), /größer als 0,00/);
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "abc", method: "CASH", paidAt: at }), /gültigen Betrag/);
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "10", method: "PAYPAL", paidAt: at }), /Unbekannte Zahlungsart/);
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "10", method: "CASH", paidAt: new Date(Date.now() + 86400_000) }), /Zukunft/);
  // Überzahlung
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: (gross + 1) / 100, method: "CASH", paidAt: at }), /Überzahlung/);
  const pv = await previewInvoicePayment(w.tenantId, inv.id, String((gross + 100) / 100).replace(".", ","), "CARD");
  assert.match(pv.error ?? "", /Überzahlung/);
  assert.equal(pv.methodLabel, "Kartenzahlung (extern)");

  // Teilzahlung 1: 300,00, Vorschau zeigt Rechnungsbetrag / erfasst / offen / neu / danach
  const p1 = await previewInvoicePayment(w.tenantId, inv.id, "300,00", "CASH");
  assert.deepEqual([p1.grossCents, p1.paidCents, p1.openCents, p1.newCents, p1.afterCents, p1.status, p1.error], [gross, 0, gross, 30_000, gross - 30_000, "PARTIAL", null]);
  const r1 = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "300,00", method: "CASH", paidAt: at, reference: "Beleg 1" });
  assert.equal(r1.created, true);
  assert.deepEqual([r1.payment.type, r1.payment.method, r1.payment.amountCents, r1.payment.status, r1.payment.bookingId, r1.payment.createdByName], ["INVOICE_PAYMENT", "CASH", 30_000, "CONFIRMED", w.bookingId, "Test Mitarbeiter"]);
  let s = await invoicePaymentSummary(w.tenantId, inv.id);
  assert.deepEqual([s.paidCents, s.openCents, s.status], [30_000, gross - 30_000, "PARTIAL"]);

  // Teilzahlung 2 mit Rundung: 0,105 € → 0,11 €
  const r2 = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "0,105", method: "BANK_TRANSFER", paidAt: at });
  assert.equal(r2.payment.amountCents, 11);
  // Rest exakt: bezahlt
  const rest = gross - 30_011;
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: (rest + 1) / 100, method: "CASH", paidAt: at }), /Überzahlung/);
  const r3 = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: rest / 100, method: "CARD", paidAt: at });
  assert.equal(r3.payment.amountCents, rest);
  s = await invoicePaymentSummary(w.tenantId, inv.id);
  assert.deepEqual([s.paidCents, s.openCents, s.status], [gross, 0, "PAID"]);
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "0,01", method: "CASH", paidAt: at }), /Überzahlung/);

  // Rechnung selbst unverändert (Dokumentzustand ≠ Zahlungsstatus)
  const after = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.deepEqual([after.status, after.contentHash, String(after.grossTotal)], ["FINALIZED", hashBefore, String(inv.grossTotal)]);
  assert.equal((await verifyInvoice(w.tenantId, inv.id)).intact, true);

  // Protokoll
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, bookingId: w.bookingId }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(audit.map((a) => [a.action, a.amountCents, a.userName]), [["PAYMENT_RECORDED", 30_000, "Test Mitarbeiter"], ["PAYMENT_RECORDED", 11, "Test Mitarbeiter"], ["PAYMENT_RECORDED", rest, "Test Mitarbeiter"]]);
  assert.ok(audit.every((a) => a.invoiceId === inv.id && a.paymentId));
  assert.ok(!JSON.stringify(audit).includes("Muster"), "keine Kundendaten im Protokoll");

  // Listen-Summen
  const many = await paymentSummaries(w.tenantId, [{ id: inv.id, grossTotal: inv.grossTotal }]);
  assert.equal(many.get(inv.id)!.status, "PAID");
});

test("Storno: nur mit Grund, Zahlung bleibt sichtbar, zählt nicht mehr, offener Betrag neu; keine Änderung/Löschung bestätigter Zahlungen (DB)", async () => {
  const { w, inv, gross } = await invoicedWorld("pay-cancel");
  const { payment } = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "100", method: "CASH", paidAt: at });
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, payment.id, "  "), /Grund/);
  // DB: keine Änderung, keine Löschung, kein Storno ohne Grund
  await assert.rejects(() => db.payment.update({ where: { id: payment.id }, data: { amountCents: 1 } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.payment.update({ where: { id: payment.id }, data: { invoiceId: null } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.payment.delete({ where: { id: payment.id } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.payment.update({ where: { id: payment.id }, data: { status: "CANCELLED" } }), (e: { code?: string }) => e.code === "P2010" || /check|rb_payment_cancel_fields/i.test(String((e as Error).message)));
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, "CONFIRMED");

  const cancelled = await cancelPayment(w.tenantId, w.actor, payment.id, "Betrag falsch eingegeben");
  assert.deepEqual([cancelled.status, cancelled.cancellationReason, cancelled.cancelledByName, !!cancelled.cancelledAt], ["CANCELLED", "Betrag falsch eingegeben", "Test Mitarbeiter", true]);
  const s = await invoicePaymentSummary(w.tenantId, inv.id);
  assert.deepEqual([s.paidCents, s.openCents, s.status], [0, gross, "OPEN"]);
  assert.equal(await db.payment.count({ where: { invoiceId: inv.id } }), 1, "kein Hard Delete");
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, payment.id, "nochmal"), /bereits storniert/);
  await assert.rejects(() => db.payment.update({ where: { id: payment.id }, data: { status: "CONFIRMED" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.payment.delete({ where: { id: payment.id } }), (e) => isImmutableError(e));
  const audit = await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "PAYMENT_CANCELLED" } });
  assert.equal((audit?.details as { reason?: string })?.reason, "Betrag falsch eingegeben");
  // danach wieder erfassbar bis zum offenen Betrag
  const again = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: gross / 100, method: "CASH", paidAt: at });
  assert.equal((await invoicePaymentSummary(w.tenantId, inv.id)).status, "PAID");
  assert.equal(again.payment.amountCents, gross);
});

test("Parallele Zahlungen werden serialisiert (kein doppelter Ausgleich), Doppelklick ist idempotent, Entwurf und fremder Mandant blockiert", async () => {
  const { w, inv, gross } = await invoicedWorld("pay-race");
  // zwei Mitarbeiter erfassen gleichzeitig je den vollen Betrag
  const results = await Promise.allSettled([
    recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: gross / 100, method: "CASH", paidAt: at }),
    recordInvoicePayment(w.tenantId, { id: w.userId, name: "Kollege" }, { invoiceId: inv.id, amount: gross / 100, method: "CARD", paidAt: at }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message), /Überzahlung/);
  assert.equal((await invoicePaymentSummary(w.tenantId, inv.id)).paidCents, gross, "nicht 200 %");

  // Doppelklick: gleicher Schlüssel bucht nur einmal (auch parallel)
  const { w: w2, inv: inv2 } = await invoicedWorld("pay-idem");
  const key = "11111111-aaaa-bbbb-cccc-222222222222";
  const twice = await Promise.all([
    recordInvoicePayment(w2.tenantId, w2.actor, { invoiceId: inv2.id, amount: "50", method: "CASH", paidAt: at, idempotencyKey: key }),
    recordInvoicePayment(w2.tenantId, w2.actor, { invoiceId: inv2.id, amount: "50", method: "CASH", paidAt: at, idempotencyKey: key }),
  ]);
  assert.deepEqual(twice.map((t) => t.created).sort(), [false, true]);
  assert.equal(twice[0].payment.id, twice[1].payment.id);
  const third = await recordInvoicePayment(w2.tenantId, w2.actor, { invoiceId: inv2.id, amount: "50", method: "CASH", paidAt: at, idempotencyKey: key });
  assert.equal(third.created, false);
  assert.equal((await invoicePaymentSummary(w2.tenantId, inv2.id)).paidCents, 5000);
  await assert.rejects(() => recordInvoicePayment(w2.tenantId, w2.actor, { invoiceId: inv2.id, amount: "1", method: "CASH", paidAt: at, idempotencyKey: "kurz" }), /veraltet/);

  // Entwurf: keine Zahlung (App und DB)
  const w3 = await returnedWorld("pay-draft");
  tenants.push(w3.tenantId);
  const draft = await ensureInvoiceDraft(w3.tenantId, w3.bookingId, w3.actor);
  await assert.rejects(() => recordInvoicePayment(w3.tenantId, w3.actor, { invoiceId: draft.id, amount: "1", method: "CASH", paidAt: at }), /nur auf abgeschlossene Rechnungen/);
  await assert.rejects(() => db.payment.create({ data: { tenantId: w3.tenantId, bookingId: w3.bookingId, invoiceId: draft.id, type: "INVOICE_PAYMENT", method: "CASH", amountCents: 1, paidAt: at } }), /abgeschlossene Rechnungen/);

  // fremder Mandant: weder erfassen noch stornieren noch sehen; DB verhindert Fremdverknüpfung
  await assert.rejects(() => recordInvoicePayment(w2.tenantId, w2.actor, { invoiceId: inv.id, amount: "1", method: "CASH", paidAt: at }), /Rechnung nicht gefunden/);
  await assert.rejects(() => cancelPayment(w2.tenantId, w2.actor, twice[0].payment.id, "fremd").then(() => cancelPayment(w.tenantId, w.actor, twice[0].payment.id, "fremd")), /Zahlung nicht gefunden/);
  await assert.rejects(() => invoicePaymentSummary(w2.tenantId, inv.id), /Rechnung nicht gefunden/);
  await assert.rejects(() => db.payment.create({ data: { tenantId: w2.tenantId, bookingId: w.bookingId, invoiceId: inv.id, type: "INVOICE_PAYMENT", method: "CASH", amountCents: 1, paidAt: at } }), /RB_TENANT/);
  await assert.rejects(() => db.payment.create({ data: { tenantId: w2.tenantId, bookingId: w2.bookingId, invoiceId: inv.id, type: "INVOICE_PAYMENT", method: "CASH", amountCents: 1, paidAt: at } }), /RB_TENANT/);
  await assert.rejects(() => db.payment.create({ data: { tenantId: w2.tenantId, bookingId: w2.bookingId, type: "INVOICE_PAYMENT", method: "CASH", amountCents: 1, paidAt: at } }), /rb_payment_invoice_required|check/i);
  await assert.rejects(() => db.payment.create({ data: { tenantId: w2.tenantId, bookingId: w2.bookingId, invoiceId: inv2.id, type: "INVOICE_PAYMENT", method: "CASH", amountCents: -1, paidAt: at } }), /rb_payment_amount|check/i);
  // Protokoll nur anfügen
  const log = await db.auditLog.findFirstOrThrow({ where: { tenantId: w2.tenantId } });
  await assert.rejects(() => db.auditLog.delete({ where: { id: log.id } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.auditLog.update({ where: { id: log.id }, data: { amountCents: 0 } }), (e) => isImmutableError(e));
});

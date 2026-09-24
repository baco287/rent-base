// Mietzahlungen bei Buchung / Mietvertrag (vor der Rechnung): eigene Zahlungsbewegungen, abgeleiteter Status,
// Teilzahlungen mit verschiedenen Zahlungsarten, Storno statt Löschen, strikte Trennung von der Kaution,
// Zuordnung zur Mietrechnung beim Abschluss, Idempotenz, Wettlauf, Mandantentrennung, DB-Schutz.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { isImmutableError } from "../src/lib/integrity";
import { ensureInvoiceDraft, finalizeInvoice } from "../src/lib/invoices";
import { cancelPayment, invoicePaymentSummary } from "../src/lib/payments";
import { insertRentalPayment, listRentalPayments, previewRentalPayment, recordRentalPayment, rentalPaymentSummary } from "../src/lib/rental-payments";
import { depositView, recordDepositReceived } from "../src/lib/deposits";
import { changeBookingStatus } from "../src/lib/booking-status";
import { toCents } from "../src/lib/money";
import { createWorld, purgeTenants, type World } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const at = new Date(Date.now() - 60_000);
const DAY = 86400_000;

/** Buchung über genau 5 Tage zu 90 €/Tag ohne Stufen und ohne Rabatt → Mietpreis 450,00 €, Kaution 500 €. */
async function world450(label: string): Promise<World> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await db.booking.update({ where: { id: w.bookingId }, data: { endAt: new Date(b.startAt.getTime() + 5 * DAY), dailyRate: 90, workWeekRate: null, weeklyRate: null, monthlyRate: null, deposit: 500 } });
  await db.customer.update({ where: { id: w.customerId }, data: { discountPercent: 0 } });
  return w;
}

test("Buchung ohne Zahlung: offen, Gesamtpreis aus der Buchung, keine Kaution im Gesamtpreis", async () => {
  const w = await world450("rp-none");
  const s = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s.grossCents, s.paidCents, s.openCents, s.status, s.source, s.canRecord, s.invoiceId], [45_000, 0, 45_000, "OPEN", "ESTIMATE", true, null]);
  assert.equal((await listRentalPayments(w.tenantId, w.bookingId)).length, 0);
  // Altbestand: Buchung ohne jede Zahlungszeile funktioniert und ist „offen“
  assert.equal(await db.payment.count({ where: { bookingId: w.bookingId } }), 0);
});

test("Vollständig bezahlt in einer Zahlung; danach keine weitere Mietzahlung; „vollständig“ mit falschem Betrag abgelehnt", async () => {
  const w = await world450("rp-full");
  // Absicht „vollständig“, Betrag passt nicht → abgelehnt, nichts gespeichert
  await assert.rejects(() => db.$transaction((tx) => insertRentalPayment(tx, w.tenantId, w.actor, w.bookingId, { amount: "400", method: "CASH", paidAt: at }, { expectFull: true })), /Vollständig bezahlt/);
  assert.equal(await db.payment.count({ where: { bookingId: w.bookingId } }), 0);

  const r = await db.$transaction((tx) => insertRentalPayment(tx, w.tenantId, w.actor, w.bookingId, { amount: "450,00", method: "CARD", paidAt: at, reference: "Terminal 4711" }, { expectFull: true }));
  assert.deepEqual([r.created, r.payment.type, r.payment.invoiceId, r.payment.amountCents, r.payment.method, r.payment.status, r.payment.reference], [true, "RENTAL_PAYMENT", null, 45_000, "CARD", "CONFIRMED", "Terminal 4711"]);
  const s = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s.paidCents, s.openCents, s.status, s.canRecord], [45_000, 0, "PAID", false]);
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "1", method: "CASH", paidAt: at }), /vollständig bezahlt/);
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, bookingId: w.bookingId, action: "PAYMENT_RECORDED" } });
  assert.equal(audit.length, 1);
  assert.equal((audit[0].details as { type: string }).type, "RENTAL_PAYMENT");
});

test("Teilzahlung und mehrere Zahlungsarten: 450 € = 100 € Überweisung + 350 € bar; Überzahlung/ungültige Eingaben blockiert", async () => {
  const w = await world450("rp-multi");
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "0", method: "CASH", paidAt: at }), /größer als 0,00/);
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "abc", method: "CASH", paidAt: at }), /gültigen Zahlungsbetrag/);
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "10", method: "PAYPAL", paidAt: at }), /Zahlungsart/);
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "10", method: "CASH", paidAt: new Date(Date.now() + DAY) }), /Zukunft/);
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "450,01", method: "CASH", paidAt: at }), /Überzahlung/);

  const pv = await previewRentalPayment(w.tenantId, w.bookingId, "100", "BANK_TRANSFER");
  assert.deepEqual([pv.grossCents, pv.paidCents, pv.openCents, pv.newCents, pv.afterCents, pv.status, pv.error], [45_000, 0, 45_000, 10_000, 35_000, "PARTIAL", null]);
  await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "100", method: "BANK_TRANSFER", paidAt: at, reference: "Überweisung Kunde" });
  const s1 = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s1.paidCents, s1.openCents, s1.status], [10_000, 35_000, "PARTIAL"]);

  await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "350", method: "CASH", paidAt: at, note: "bar bei Abholung" });
  const s2 = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s2.grossCents, s2.paidCents, s2.openCents, s2.status], [45_000, 45_000, 0, "PAID"]);
  const list = await listRentalPayments(w.tenantId, w.bookingId);
  assert.deepEqual(list.map((p) => [p.method, p.amountCents]).sort(), [["BANK_TRANSFER", 10_000], ["CASH", 35_000]]);
});

test("Storno statt Löschen: Zahlung bleibt sichtbar, Status neu berechnet; DB verbietet Löschen und Ändern", async () => {
  const w = await world450("rp-cancel");
  const a = await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "100", method: "BANK_TRANSFER", paidAt: at });
  const b = await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "350", method: "CASH", paidAt: at });
  assert.equal((await rentalPaymentSummary(w.tenantId, w.bookingId)).status, "PAID");
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, b.payment.id, "x"), /Grund/);
  await cancelPayment(w.tenantId, w.actor, b.payment.id, "Betrag falsch eingegeben");
  const s = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s.paidCents, s.openCents, s.status], [10_000, 35_000, "PARTIAL"]);
  const rows = await listRentalPayments(w.tenantId, w.bookingId);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === b.payment.id)!.status, "CANCELLED");
  // physisch löschen / Betrag ändern / Rechnung beliebig setzen: vom DB-Trigger abgelehnt
  assert.ok(isImmutableError(await db.payment.delete({ where: { id: a.payment.id } }).catch((e) => e)));
  assert.ok(isImmutableError(await db.payment.update({ where: { id: a.payment.id }, data: { amountCents: 1 } }).catch((e) => e)));
  assert.ok(isImmutableError(await db.payment.update({ where: { id: b.payment.id }, data: { note: "nachträglich" } }).catch((e) => e)));
  // korrigierte Zahlung neu erfassen ist möglich
  await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "300", method: "CASH", paidAt: at });
  assert.deepEqual([(await rentalPaymentSummary(w.tenantId, w.bookingId)).paidCents], [40_000]);
});

test("Kaution und Mietzahlung bleiben getrennt: Kautionseingang reduziert nie den offenen Mietbetrag und umgekehrt", async () => {
  const w = await returnedWorld("rp-deposit");
  tenants.push(w.tenantId);
  const contract = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const s0 = await rentalPaymentSummary(w.tenantId, w.bookingId);
  // Gesamtpreis = Vertragspreis, ohne Kaution
  assert.deepEqual([s0.source, s0.grossCents, s0.paidCents, s0.status], ["CONTRACT", toCents(contract.totalAmount), 0, "OPEN"]);

  // Kaution vollständig erhalten → Mietzahlung bleibt offen
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const s1 = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s1.paidCents, s1.openCents, s1.status], [0, s0.grossCents, "OPEN"]);
  assert.equal(await db.payment.count({ where: { bookingId: w.bookingId } }), 0, "Kaution erzeugt keine Zahlung");

  // Mietzahlung → Kaution unverändert
  const dv0 = await depositView(w.tenantId, w.bookingId);
  await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "100", method: "CARD", paidAt: at });
  const dv1 = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([dv1.receivedCents, dv1.releasedCents, dv1.retainedCents, dv1.status, dv1.events.length], [dv0.receivedCents, dv0.releasedCents, dv0.retainedCents, dv0.status, dv0.events.length]);
  assert.equal(dv1.receivedCents, 50_000);
  assert.equal((await rentalPaymentSummary(w.tenantId, w.bookingId)).paidCents, 10_000);
});

test("Mietrechnung: vorab erfasste Mietzahlungen werden beim Abschluss zugeordnet, danach laufen Zahlungen über die Rechnung", async () => {
  const w = await returnedWorld("rp-invoice");
  tenants.push(w.tenantId);
  await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "100", method: "BANK_TRANSFER", paidAt: at });
  const cash = await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "50", method: "CASH", paidAt: at });
  await cancelPayment(w.tenantId, w.actor, cash.payment.id, "doppelt erfasst");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });

  const draft = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  // vor dem Abschluss: Entwurf ändert nichts an der Zuordnung
  assert.equal(await db.payment.count({ where: { bookingId: w.bookingId, invoiceId: { not: null } } }), 0);
  const v = await finalizeInvoice(w.tenantId, draft.id, w.actor);
  const gross = toCents(v.grossTotal);

  const linked = await db.payment.findMany({ where: { bookingId: w.bookingId }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(linked.map((p) => [p.type, p.status, p.invoiceId]), [["RENTAL_PAYMENT", "CONFIRMED", draft.id], ["RENTAL_PAYMENT", "CANCELLED", null]], "nur bestätigte Zahlungen werden zugeordnet");
  const inv = await invoicePaymentSummary(w.tenantId, draft.id);
  assert.deepEqual([inv.grossCents, inv.paidCents, inv.openCents, inv.status], [gross, 10_000, gross - 10_000, "PARTIAL"], "Kaution zählt nicht als Zahlung");
  const s = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s.source, s.invoiceId, s.paidCents, s.openCents], ["INVOICE", draft.id, 10_000, gross - 10_000]);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "RENTAL_PAYMENTS_LINKED", invoiceId: draft.id } }), 1);

  // neue Zahlung an der Buchung läuft jetzt als Rechnungszahlung
  const next = await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "20", method: "CASH", paidAt: at });
  assert.deepEqual([next.payment.type, next.payment.invoiceId], ["INVOICE_PAYMENT", draft.id]);
  // DB: keine unzugeordnete Mietzahlung mehr neben einer abgeschlossenen Mietrechnung, zugeordnete bleibt fest
  const direct = await db.payment.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, type: "RENTAL_PAYMENT", method: "CASH", amountCents: 100, paidAt: at } }).catch((e) => e);
  assert.match(String(direct?.message ?? direct), /abgeschlossene Mietrechnung/);
  assert.ok(isImmutableError(await db.payment.update({ where: { id: linked[0].id }, data: { invoiceId: null } }).catch((e) => e)));
  // Kaution unverändert
  assert.equal((await depositView(w.tenantId, w.bookingId)).receivedCents, 50_000);
});

test("Storno der Buchung: keine neue Mietzahlung, vorhandene bleiben sichtbar", async () => {
  const w = await world450("rp-storno");
  await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "100", method: "CASH", paidAt: at });
  await changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED");
  const s = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s.bookingStatus, s.paidCents, s.canRecord], ["CANCELLED", 10_000, false]);
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "10", method: "CASH", paidAt: at }), /storniert/);
});

test("Idempotenz, parallele Erfassung ohne Überzahlung, Mandantentrennung, DB-Regeln für Mietzahlungen", async () => {
  const w = await world450("rp-race");
  const key = "rp-key-12345678";
  const a = await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "50", method: "CASH", paidAt: at, idempotencyKey: key });
  const b = await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "50", method: "CASH", paidAt: at, idempotencyKey: key });
  assert.deepEqual([a.created, b.created, a.payment.id], [true, false, b.payment.id]);

  // zwei gleichzeitige Zahlungen über den ganzen Rest: genau eine gelingt
  const res = await Promise.allSettled([400, 400].map((eur) => recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: String(eur), method: "CASH", paidAt: at })));
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await rentalPaymentSummary(w.tenantId, w.bookingId)).paidCents, 45_000);

  // fremder Mandant
  const other = await createWorld("rp-other");
  tenants.push(other.tenantId);
  await assert.rejects(() => recordRentalPayment(other.tenantId, other.actor, w.bookingId, { amount: "1", method: "CASH", paidAt: at }), /nicht gefunden/);
  await assert.rejects(() => rentalPaymentSummary(other.tenantId, w.bookingId), /nicht gefunden/);
  const cross = await db.payment.create({ data: { tenantId: other.tenantId, bookingId: w.bookingId, type: "RENTAL_PAYMENT", method: "CASH", amountCents: 100, paidAt: at } }).catch((e) => e);
  assert.match(String(cross?.message ?? cross), /RB_TENANT/);
  // unbekannter Zahlungstyp (z. B. „Kaution“ als Zahlung) wird von der DB abgelehnt
  const wrongType = await db.payment.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, type: "DEPOSIT", method: "CASH", amountCents: 100, paidAt: at } }).catch((e) => e);
  assert.match(String(wrongType?.message ?? wrongType), /rb_payment_type/);
});

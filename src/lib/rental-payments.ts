// Mietzahlungen schon bei Buchung und Mietvertrag, also bevor es eine Rechnung gibt.
// Grundsätze (wie Phase 9):
// - Jede Zahlung ist eine eigene Bewegung (Payment, type RENTAL_PAYMENT). Mehrere Teilzahlungen, verschiedene Wege.
// - Der Status (offen / teilweise / vollständig bezahlt) wird immer aus den bestätigten Zahlungen berechnet, nie gespeichert.
// - Kaution ist eine getrennte Sicherheitsleistung (SecurityDeposit). Sie wird hier weder gelesen noch verrechnet und
//   reduziert den offenen Mietbetrag nie.
// - Bestätigte Zahlungen werden nie geändert oder gelöscht, nur mit Grund storniert (cancelPayment, DB-Trigger).
// - Gesamtpreis: abgeschlossene Mietrechnung → deren wirksame Forderung; sonst unterschriebener Vertrag → Vertragspreis;
//   sonst die Berechnung aus der Buchung („voraussichtlich“).
// - Mit Abschluss der Mietrechnung werden die Mietzahlungen ihr zugeordnet (rental-payment-link.ts); danach laufen neue
//   Zahlungen über recordInvoicePayment.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { PAYMENT_METHODS, type InvoicePaymentStatus, type PaymentMethod } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation } from "@/lib/numbering";
import { calculateRentalPrice, rateCardFrom } from "@/lib/pricing";
import { invoicePaymentSummary, paymentStatusOf, recordInvoicePayment, summarizePayment, type PaymentPreview, type PaymentRow, type PaymentSummary } from "@/lib/payments";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };

/** Woher der Gesamtpreis stammt. */
export type RentalTotalSource = "INVOICE" | "CONTRACT" | "ESTIMATE";

export type RentalPaymentSummary = PaymentSummary & {
  source: RentalTotalSource;
  invoiceId: string | null;
  invoiceNumber: string | null;
  bookingStatus: string;
  /** Neue Mietzahlung möglich (nicht storniert, noch etwas offen) */
  canRecord: boolean;
  blockedReason: string | null;
};

const bookingSelect = { id: true, tenantId: true, status: true, startAt: true, endAt: true, dailyRate: true, workWeekRate: true, weeklyRate: true, monthlyRate: true, customer: { select: { discountPercent: true } }, contract: { select: { status: true, totalAmount: true } } } as const;
type BookingForTotal = Prisma.BookingGetPayload<{ select: typeof bookingSelect }>;

/** Erwarteter Mietpreis ohne Rechnung: Vertragspreis (unterschrieben) oder Berechnung aus der Buchung. Nie die Kaution. */
export function expectedRentalCents(b: Pick<BookingForTotal, "startAt" | "endAt" | "dailyRate" | "workWeekRate" | "weeklyRate" | "monthlyRate" | "customer" | "contract">): { cents: Cents; source: "CONTRACT" | "ESTIMATE" } {
  if (b.contract?.status === "SIGNED") return { cents: toCents(b.contract.totalAmount), source: "CONTRACT" };
  const price = calculateRentalPrice({ start: b.startAt, end: b.endAt, rates: rateCardFrom(b), discountPercent: b.customer.discountPercent });
  return { cents: toCents(price.total.toFixed(2)), source: "ESTIMATE" };
}

function finalizedRentalInvoice(client: Tx | typeof db, tenantId: string, bookingId: string) {
  return client.invoice.findFirst({ where: { tenantId, bookingId, kind: "RENTAL", documentType: "INVOICE", status: "FINALIZED" }, select: { id: true, number: true } });
}

/** Gesamtpreis, bereits bezahlt, noch offen und Status der Miete einer Buchung. */
export async function rentalPaymentSummary(tenantId: string, bookingId: string, client: Tx | typeof db = db): Promise<RentalPaymentSummary> {
  const b = await client.booking.findFirst({ where: { id: bookingId, tenantId }, select: bookingSelect });
  if (!b) throw new DomainError("Buchung nicht gefunden.");
  const cancelled = b.status === "CANCELLED";
  const inv = await finalizedRentalInvoice(client, tenantId, bookingId);
  if (inv) {
    const s = await invoicePaymentSummary(tenantId, inv.id, client);
    return { ...s, source: "INVOICE", invoiceId: inv.id, invoiceNumber: inv.number, bookingStatus: b.status, canRecord: !cancelled && s.openCents > 0, blockedReason: cancelled ? "Die Buchung ist storniert." : s.openCents === 0 ? "Es ist nichts mehr offen." : null };
  }
  const { cents, source } = expectedRentalCents(b);
  const paid = await client.payment.aggregate({ where: { tenantId, bookingId, type: "RENTAL_PAYMENT", invoiceId: null, status: "CONFIRMED" }, _sum: { amountCents: true } });
  const s = summarizePayment(cents, paid._sum.amountCents ?? 0);
  const blockedReason = cancelled ? "Die Buchung ist storniert. Neue Mietzahlungen werden nicht erfasst." : s.openCents === 0 ? "Der Mietpreis ist vollständig bezahlt." : null;
  return { ...s, source, invoiceId: null, invoiceNumber: null, bookingStatus: b.status, canRecord: blockedReason === null, blockedReason };
}

/** Mietzahlungen einer Buchung: vor der Rechnung erfasste und zur Mietrechnung erfasste, neueste zuerst. */
export function listRentalPayments(tenantId: string, bookingId: string) {
  return db.payment.findMany({
    where: { tenantId, bookingId, OR: [{ type: "RENTAL_PAYMENT" }, { invoice: { kind: "RENTAL", documentType: "INVOICE" } }] },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
    include: { invoice: { select: { number: true } } },
  });
}

export type RentalPaymentInput = {
  amount: string | number;
  method: string;
  paidAt: Date;
  reference?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
};

export function parseRentalAmount(v: string | number): Cents {
  let cents: Cents;
  try {
    cents = toCents(v);
  } catch {
    throw new DomainError("Bitte einen gültigen Zahlungsbetrag eingeben (z. B. 120,50).");
  }
  if (cents <= 0) throw new DomainError("Der gezahlte Betrag muss größer als 0,00 € sein.");
  if (cents > 100_000_000_00) throw new DomainError("Der Betrag ist unplausibel hoch.");
  return cents;
}

function checkInput(input: RentalPaymentInput): { amountCents: Cents; method: PaymentMethod; key: string | null } {
  const amountCents = parseRentalAmount(input.amount);
  if (!(input.method in PAYMENT_METHODS)) throw new DomainError("Bitte eine Zahlungsart wählen.");
  if (!(input.paidAt instanceof Date) || Number.isNaN(input.paidAt.getTime())) throw new DomainError("Bitte das Zahlungsdatum angeben.");
  if (input.paidAt.getTime() > Date.now() + 5 * 60_000) throw new DomainError("Das Zahlungsdatum darf nicht in der Zukunft liegen.");
  const key = input.idempotencyKey?.trim() || null;
  if (key && !/^[A-Za-z0-9-]{8,64}$/.test(key)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  return { amountCents, method: input.method as PaymentMethod, key };
}

const overpayMessage = (open: Cents, amount: Cents) => `Überzahlung: Offen sind ${fmtCents(open)}, eingegeben wurden ${fmtCents(amount)}. Eine Mietzahlung über den offenen Betrag hinaus wird nicht erfasst. Die Kaution wird getrennt unter „Kaution“ erfasst.`;

/**
 * Kern: Mietzahlung in einer laufenden Transaktion anlegen (auch direkt beim Anlegen der Buchung).
 * Sperrt die Buchung, rechnet offen aus den bestätigten Mietzahlungen und lehnt Überzahlung ab.
 */
export async function insertRentalPayment(tx: Tx, tenantId: string, actor: Actor, bookingId: string, input: RentalPaymentInput, opts: { expectFull?: boolean } = {}): Promise<{ payment: PaymentRow; created: boolean }> {
  const { amountCents, method, key } = checkInput(input);
  const locked = await tx.$queryRaw<{ id: string; status: string; number: string }[]>`SELECT "id", "status", "number" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
  if (key) {
    const dup = await tx.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
    if (dup) return { payment: dup, created: false };
  }
  if (locked[0].status === "CANCELLED") throw new DomainError("Die Buchung ist storniert. Neue Mietzahlungen werden nicht erfasst.");
  const inv = await finalizedRentalInvoice(tx, tenantId, bookingId);
  if (inv) throw new DomainError(`Zu dieser Buchung ist die Mietrechnung ${inv.number ?? ""} abgeschlossen. Zahlungen werden jetzt zur Rechnung erfasst. Bitte die Seite neu laden.`);
  const s = await rentalPaymentSummary(tenantId, bookingId, tx);
  if (s.openCents === 0) throw new DomainError(s.paidCents > 0 ? "Der Mietpreis ist bereits vollständig bezahlt. Weitere Mietzahlungen werden nicht erfasst." : "Für diese Buchung ergibt sich kein Mietpreis. Es wird keine Zahlung erfasst.");
  if (amountCents > s.openCents) throw new DomainError(overpayMessage(s.openCents, amountCents));
  if (opts.expectFull && amountCents !== s.openCents) throw new DomainError(`„Vollständig bezahlt“ passt nicht zum Betrag: Der Gesamtpreis beträgt ${fmtCents(s.openCents)}, eingegeben wurden ${fmtCents(amountCents)}. Bitte den Betrag anpassen oder „Teilweise bezahlt“ wählen.`);
  const payment = await tx.payment.create({
    data: { tenantId, bookingId, invoiceId: null, type: "RENTAL_PAYMENT", method, amountCents, paidAt: input.paidAt, reference: input.reference?.trim() || null, note: input.note?.trim() || null, idempotencyKey: key, createdById: actor.id, createdByName: actor.name },
  });
  await recordAudit(tx, tenantId, actor, { action: "PAYMENT_RECORDED", bookingId, paymentId: payment.id, amountCents, details: { type: "RENTAL_PAYMENT", method, bookingNumber: locked[0].number, totalSource: s.source, totalCents: s.grossCents, openBefore: s.openCents, openAfter: s.openCents - amountCents } });
  return { payment, created: true };
}

/**
 * Mietzahlung zu einer Buchung erfassen. Gibt es schon eine abgeschlossene Mietrechnung, wird die Zahlung als
 * Rechnungszahlung zu ihr erfasst (bestehender Weg). Gleicher idempotencyKey bucht nie doppelt.
 */
export async function recordRentalPayment(tenantId: string, actor: Actor, bookingId: string, input: RentalPaymentInput): Promise<{ payment: PaymentRow; created: boolean }> {
  const { key } = checkInput(input);
  if (key) {
    const existing = await db.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
    if (existing) return { payment: existing, created: false };
  }
  const inv = await finalizedRentalInvoice(db, tenantId, bookingId);
  if (inv) return recordInvoicePayment(tenantId, actor, { ...input, invoiceId: inv.id });
  try {
    return await db.$transaction((tx) => insertRentalPayment(tx, tenantId, actor, bookingId, input), TX);
  } catch (e) {
    if (key && isUniqueViolation(e, "idempotencyKey")) {
      const winner = await db.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (winner) return { payment: winner, created: false };
    }
    throw e;
  }
}

/** Vorschau für den Bestätigungsschritt; rechnet serverseitig, bucht nichts. */
export async function previewRentalPayment(tenantId: string, bookingId: string, amount: string | number, method: string): Promise<PaymentPreview> {
  const s = await rentalPaymentSummary(tenantId, bookingId);
  let newCents = 0;
  let error: string | null = null;
  try {
    newCents = parseRentalAmount(amount);
    if (!(method in PAYMENT_METHODS)) throw new DomainError("Bitte eine Zahlungsart wählen.");
    if (!s.canRecord) error = s.blockedReason;
    else if (newCents > s.openCents) error = overpayMessage(s.openCents, newCents);
  } catch (e) {
    error = e instanceof DomainError ? e.message : "Ungültige Eingabe.";
  }
  const status: InvoicePaymentStatus = paymentStatusOf(s.grossCents, s.paidCents + newCents);
  return { grossCents: s.grossCents, paidCents: s.paidCents, openCents: s.openCents, newCents, afterCents: Math.max(0, s.openCents - newCents), status, error, methodLabel: PAYMENT_METHODS[method as PaymentMethod] ?? method };
}

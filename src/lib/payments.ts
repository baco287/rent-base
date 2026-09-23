// Zahlungen: dokumentierte Geldflüsse zu abgeschlossenen Rechnungen. Rent-Base zieht nichts ein; Karten- und
// Überweisungszahlungen wurden außerhalb ausgeführt und werden hier festgehalten.
// Grundsätze:
// - Der Zahlungsstatus einer Rechnung (offen / teilbezahlt / bezahlt) wird immer aus den bestätigten Zahlungen
//   abgeleitet und nie gespeichert.
// - Überzahlung wird blockiert (kein Kundenkonto, kein Guthaben).
// - Erfassen serialisiert über eine Zeilensperre auf der Rechnung; ein Formularschlüssel verhindert Doppelbuchung.
// - Bestätigte Zahlungen werden nie geändert oder gelöscht, nur mit Grund storniert (zusätzlich DB-Trigger).

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { PAYMENT_METHODS, type InvoicePaymentStatus, type PaymentMethod } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation } from "@/lib/numbering";
import { financialsFor, type InvoiceFinancials } from "@/lib/counter-documents";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type PaymentRow = Prisma.PaymentGetPayload<object>;

/**
 * grossCents = wirksame Forderung (Rechnungsbetrag − abgeschlossene Gutschriften − Storno). overpaidCents = Kundenguthaben:
 * Zahlungen über der wirksamen Forderung → Erstattung erforderlich, nie ein negativer offener Betrag (Phase 17).
 */
export type PaymentSummary = { grossCents: Cents; paidCents: Cents; openCents: Cents; overpaidCents: Cents; status: InvoicePaymentStatus; invoiceCents: Cents; creditedCents: Cents; cancelledCents: Cents; chain: InvoiceFinancials["chain"] };

/** Offen / teilbezahlt / bezahlt / überzahlt – immer aus Bruttobetrag der aktuellen Fassung und bestätigten Zahlungen. */
export function paymentStatusOf(grossCents: Cents, paidCents: Cents): InvoicePaymentStatus {
  if (paidCents <= 0) return grossCents === 0 ? "PAID" : "OPEN";
  if (paidCents > grossCents) return "OVERPAID";
  return paidCents >= grossCents ? "PAID" : "PARTIAL";
}

export function summarizePayment(grossCents: Cents, paidCents: Cents, extra: { invoiceCents?: Cents; creditedCents?: Cents; cancelledCents?: Cents; chain?: InvoiceFinancials["chain"] } = {}): PaymentSummary {
  return { grossCents, paidCents, openCents: Math.max(0, grossCents - paidCents), overpaidCents: Math.max(0, paidCents - grossCents), status: paymentStatusOf(grossCents, paidCents), invoiceCents: extra.invoiceCents ?? grossCents, creditedCents: extra.creditedCents ?? 0, cancelledCents: extra.cancelledCents ?? 0, chain: extra.chain ?? "NONE" };
}

const fromFinancials = (f: InvoiceFinancials): PaymentSummary => summarizePayment(f.effectiveCents, f.paidCents, { invoiceCents: f.invoiceCents, creditedCents: f.creditedCents, cancelledCents: f.cancelledCents, chain: f.chain });

/** Wirksame Forderung, bezahlt, offen, Guthaben und Status – zentral aus Fassung, Gegenbelegen und bestätigten Zahlungen. */
export async function invoicePaymentSummary(tenantId: string, invoiceId: string, tx: Tx | typeof db = db): Promise<PaymentSummary> {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, grossTotal: true, currentVersion: { select: { grossTotal: true } } } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  const m = await financialsFor(tenantId, [{ id: inv.id, grossTotal: inv.currentVersion?.grossTotal ?? inv.grossTotal }], tx);
  return fromFinancials(m.get(inv.id)!);
}

/** Summen für mehrere Rechnungen auf einmal (Listen, Kennzahlen). Erwartet je Rechnung den Bruttobetrag der aktuellen Fassung. */
export async function paymentSummaries(tenantId: string, invoices: { id: string; grossTotal: unknown }[]): Promise<Map<string, PaymentSummary>> {
  const m = await financialsFor(tenantId, invoices);
  return new Map(invoices.map((i) => [i.id, fromFinancials(m.get(i.id)!)]));
}

export function listInvoicePayments(tenantId: string, invoiceId: string) {
  return db.payment.findMany({ where: { tenantId, invoiceId }, orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }] });
}

export function listBookingPayments(tenantId: string, bookingId: string) {
  return db.payment.findMany({ where: { tenantId, bookingId }, orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }] });
}

export type PaymentInput = {
  invoiceId: string;
  amount: string | number;
  method: string;
  paidAt: Date;
  reference?: string | null;
  note?: string | null;
  /** einmaliger Schlüssel des Formulars; derselbe Schlüssel bucht nie zweimal */
  idempotencyKey?: string | null;
};

function parseAmount(v: string | number): Cents {
  let cents: Cents;
  try {
    cents = toCents(v);
  } catch {
    throw new DomainError("Bitte einen gültigen Betrag eingeben (z. B. 120,50).");
  }
  if (cents <= 0) throw new DomainError("Der Betrag muss größer als 0,00 € sein.");
  if (cents > 100_000_000_00) throw new DomainError("Der Betrag ist unplausibel hoch.");
  return cents;
}

function checkMethod(m: string): PaymentMethod {
  if (!(m in PAYMENT_METHODS)) throw new DomainError("Unbekannte Zahlungsart.");
  return m as PaymentMethod;
}

function checkDate(d: Date, what: string) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new DomainError(`Bitte ${what} angeben.`);
  if (d.getTime() > Date.now() + 5 * 60_000) throw new DomainError(`${what} darf nicht in der Zukunft liegen.`);
}

export type PaymentPreview = { grossCents: Cents; paidCents: Cents; openCents: Cents; newCents: Cents; afterCents: Cents; status: InvoicePaymentStatus; error: string | null; methodLabel: string };

/** Vorschau für den Bestätigungsschritt; rechnet serverseitig, bucht nichts. */
export async function previewInvoicePayment(tenantId: string, invoiceId: string, amount: string | number, method: string): Promise<PaymentPreview> {
  const s = await invoicePaymentSummary(tenantId, invoiceId);
  let newCents = 0;
  let error: string | null = null;
  try {
    newCents = parseAmount(amount);
    checkMethod(method);
    if (s.openCents === 0) error = s.status === "OVERPAID" ? `Diese Rechnung ist überzahlt (${fmtCents(s.overpaidCents)} zu viel). Weitere Zahlungen werden nicht erfasst; die Erstattung ist zu klären.` : "Diese Rechnung ist vollständig bezahlt. Weitere Zahlungen werden nicht erfasst.";
    else if (newCents > s.openCents) error = `Überzahlung: Offen sind ${fmtCents(s.openCents)}, eingegeben wurden ${fmtCents(newCents)}. Eine Zahlung über den offenen Betrag hinaus wird nicht erfasst.`;
  } catch (e) {
    error = e instanceof DomainError ? e.message : "Ungültige Eingabe.";
  }
  const afterCents = Math.max(0, s.openCents - newCents);
  return { ...s, newCents, afterCents, status: paymentStatusOf(s.grossCents, s.paidCents + newCents), error, methodLabel: PAYMENT_METHODS[method as PaymentMethod] ?? method };
}

/**
 * Zahlung auf eine abgeschlossene Rechnung erfassen. Sperrt die Rechnung, rechnet den offenen Betrag aus den
 * bestätigten Zahlungen und lehnt Überzahlung ab. Gleicher idempotencyKey liefert die vorhandene Zahlung zurück.
 */
export async function recordInvoicePayment(tenantId: string, actor: Actor, input: PaymentInput): Promise<{ payment: PaymentRow; created: boolean }> {
  const amountCents = parseAmount(input.amount);
  const method = checkMethod(input.method);
  checkDate(input.paidAt, "das Zahlungsdatum");
  const key = input.idempotencyKey?.trim() || null;
  if (key && !/^[A-Za-z0-9-]{8,64}$/.test(key)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  if (key) {
    const existing = await db.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
    if (existing) return { payment: existing, created: false };
  }
  try {
    const outcome = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string; bookingId: string; number: string | null; documentType: string }[]>`SELECT "id", "status", "bookingId", "number", "documentType" FROM "Invoice" WHERE "id" = ${input.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
      const inv = locked[0];
      if (key) {
        // unter der Sperre erneut prüfen: ein paralleler Klick mit demselben Schlüssel war vielleicht schneller
        const dup = await tx.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
        if (dup) return { payment: dup, created: false };
      }
      if (inv.status !== "FINALIZED") throw new DomainError("Zahlungen können nur auf abgeschlossene Rechnungen erfasst werden.");
      if (inv.documentType !== "INVOICE") throw new DomainError("Zahlungen werden nur zu Rechnungen erfasst, nicht zu Gutschriften oder Stornobelegen.");
      // wirksame Forderung unter der Sperre: Rechnungsbetrag abzüglich abgeschlossener Gutschriften und Storno
      const { grossCents, paidCents, openCents } = await invoicePaymentSummary(tenantId, inv.id, tx);
      if (openCents === 0) throw new DomainError(paidCents > grossCents ? `Diese Rechnung ist überzahlt (${fmtCents(paidCents - grossCents)} zu viel). Weitere Zahlungen werden nicht erfasst; die Erstattung ist zu klären.` : "Diese Rechnung ist vollständig bezahlt. Weitere Zahlungen werden nicht erfasst.");
      if (amountCents > openCents) throw new DomainError(`Überzahlung: Offen sind ${fmtCents(openCents)}, eingegeben wurden ${fmtCents(amountCents)}. Eine Zahlung über den offenen Betrag hinaus wird nicht erfasst.`);
      const payment = await tx.payment.create({
        data: {
          tenantId,
          bookingId: inv.bookingId,
          invoiceId: inv.id,
          type: "INVOICE_PAYMENT",
          method,
          amountCents,
          paidAt: input.paidAt,
          reference: input.reference?.trim() || null,
          note: input.note?.trim() || null,
          idempotencyKey: key,
          createdById: actor.id,
          createdByName: actor.name,
        },
      });
      await recordAudit(tx, tenantId, actor, { action: "PAYMENT_RECORDED", bookingId: inv.bookingId, invoiceId: inv.id, paymentId: payment.id, amountCents, details: { method, invoiceNumber: inv.number, openBefore: openCents, openAfter: openCents - amountCents } });
      return { payment, created: true };
    }, TX);
    return outcome;
  } catch (e) {
    if (key && isUniqueViolation(e, "idempotencyKey")) {
      const winner = await db.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (winner) return { payment: winner, created: false };
    }
    throw e;
  }
}

/** Storno mit Pflichtgrund. Die Zahlung bleibt sichtbar, zählt aber nicht mehr als bezahlt. */
export async function cancelPayment(tenantId: string, actor: Actor, paymentId: string, reason: string): Promise<PaymentRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund der Korrektur angeben.");
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Payment" WHERE "id" = ${paymentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Zahlung nicht gefunden.");
    if (locked[0].status !== "CONFIRMED") throw new DomainError("Diese Zahlung ist bereits storniert.");
    const now = new Date();
    const payment = await tx.payment.update({ where: { id: paymentId }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id, cancelledByName: actor.name, cancellationReason: why } });
    await recordAudit(tx, tenantId, actor, { action: "PAYMENT_CANCELLED", bookingId: payment.bookingId, invoiceId: payment.invoiceId, paymentId: payment.id, amountCents: payment.amountCents, details: { reason: why, method: payment.method } });
    return payment;
  }, TX);
}

// Befehl 20.7: Kautionsverrechnung – erhaltene Kaution bewusst gegen eine konkrete, offene Forderung derselben Buchung
// verwenden. Kein Geldeingang: das Geld wurde bereits als Kaution vereinnahmt. Eine Verrechnung ist EIN Vorgang aus zwei
// Zeilen, die nur gemeinsam entstehen und nur gemeinsam storniert werden:
//   Payment (type/method DEPOSIT_OFFSET, zur Rechnung)  →  zählt in financialsFor als „bezahlt“ (Forderung sinkt)
//   SecurityDepositEvent OFFSET (paymentId)             →  zählt in balanceOf als verbraucht (verfügbare Kaution sinkt)
// Es gibt keine zweite Saldenrechnung: Forderungsseite = financialsFor, Kautionsseite = balanceOf/computeDepositFinancials.
// Nie automatisch: weder Mehrkilometer, Reinigung, fehlendes Zubehör, Schaden noch der Rückgabeabschluss lösen sie aus.
// Ein Einbehalt (RETAINED, ungeklärter Schaden) ist keine Verrechnung und wird nicht doppelt verwendet.
// Sperr-Reihenfolge (siehe deposits.ts): Booking → SecurityDeposit → Invoice → Payment.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DEPOSIT_OFFSET_METHOD } from "@/lib/constants";
import { invoiceFinancials, financialsFor } from "@/lib/counter-documents";
import { checkDate, checkKey, depositView, domainFromDb, lockOrCreateDeposit, parseAmount, syncStatus, type DepositEventRow, type DepositView } from "@/lib/deposits";
import { DomainError } from "@/lib/integrity";
import { fmtCents, type Cents } from "@/lib/money";
import { isUniqueViolation } from "@/lib/numbering";
import { paymentStatusOf, type PaymentRow } from "@/lib/payments";
import type { InvoicePaymentStatus } from "@/lib/constants";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };

export const OFFSET_ALLOWED_BOOKING_STATUS = new Set(["RETURNED", "CANCELLED"]);

export type OffsetInvoiceOption = { id: string; number: string; kind: string; grossCents: Cents; paidCents: Cents; openCents: Cents; hasDraftCounter: boolean };

/** Ausgangslage für die Oberfläche: offene Rechnungen der Buchung und der Kautionsstand. Rechnet nichts Neues. */
export type DepositOffsetOptions = {
  deposit: DepositView;
  /** tatsächlich noch verfügbar = erhalten − freigegeben − einbehalten − verrechnet */
  availableCents: Cents;
  invoices: OffsetInvoiceOption[];
  /** null = Verrechnung grundsätzlich möglich, sonst der Grund, warum nicht */
  blockedReason: string | null;
};

async function openInvoicesOf(client: Tx | typeof db, tenantId: string, bookingId: string): Promise<OffsetInvoiceOption[]> {
  const rows = await client.invoice.findMany({ where: { tenantId, bookingId, status: "FINALIZED", documentType: "INVOICE" }, orderBy: { finalizedAt: "asc" }, select: { id: true, number: true, kind: true, grossTotal: true, currentVersion: { select: { grossTotal: true } } } });
  if (rows.length === 0) return [];
  const fin = await financialsFor(tenantId, rows.map((r) => ({ id: r.id, grossTotal: r.currentVersion?.grossTotal ?? r.grossTotal })), client);
  return rows.map((r) => { const f = fin.get(r.id)!; return { id: r.id, number: r.number ?? "", kind: r.kind, grossCents: f.effectiveCents, paidCents: f.paidCents, openCents: f.openCents, hasDraftCounter: f.hasDraftCounter }; }).filter((r) => r.openCents > 0);
}

export async function depositOffsetOptions(tenantId: string, bookingId: string): Promise<DepositOffsetOptions> {
  const deposit = await depositView(tenantId, bookingId);
  const invoices = await openInvoicesOf(db, tenantId, bookingId);
  const availableCents = Math.max(0, deposit.remainingCents);
  let blockedReason: string | null = null;
  if (!deposit.contractSigned) blockedReason = "Ohne abgeschlossenen Mietvertrag gibt es keine Kaution.";
  else if (!OFFSET_ALLOWED_BOOKING_STATUS.has(deposit.bookingStatus)) blockedReason = "Eine Verrechnung ist erst nach der Rückgabe (oder bei Storno) möglich.";
  else if (deposit.receivedCents <= 0) blockedReason = "Es wurde noch keine Kaution als erhalten dokumentiert.";
  else if (availableCents <= 0) blockedReason = "Die erhaltene Kaution ist bereits vollständig freigegeben, einbehalten oder verrechnet.";
  else if (invoices.length === 0) blockedReason = "Zu dieser Buchung gibt es keine offene Forderung.";
  return { deposit, availableCents, invoices, blockedReason };
}

export type DepositOffsetPreview = {
  invoiceId: string;
  invoiceNumber: string;
  openCents: Cents;
  receivedCents: Cents;
  releasedCents: Cents;
  paidOutCents: Cents;
  retainedCents: Cents;
  offsetCents: Cents;
  availableCents: Cents;
  /** Vorschlag = min(offen, verfügbar) */
  suggestedCents: Cents;
  amountCents: Cents;
  claimAfterCents: Cents;
  depositAfterCents: Cents;
  invoiceStatusAfter: InvoicePaymentStatus;
  error: string | null;
};

function planAmount(openCents: Cents, availableCents: Cents, amount: string | number | null | undefined): { amountCents: Cents; error: string | null } {
  const suggested = Math.max(0, Math.min(openCents, availableCents));
  try {
    if (openCents <= 0) throw new DomainError("Diese Rechnung ist vollständig bezahlt; es gibt nichts zu verrechnen.");
    if (availableCents <= 0) throw new DomainError("Von der Kaution ist nichts mehr verfügbar.");
    const amountCents = amount == null || amount === "" ? suggested : parseAmount(amount, "Der Verrechnungsbetrag");
    if (amountCents <= 0) throw new DomainError("Der Verrechnungsbetrag muss größer als 0,00 € sein.");
    if (amountCents > openCents) throw new DomainError(`Überverrechnung: Offen sind ${fmtCents(openCents)}, eingegeben wurden ${fmtCents(amountCents)}. Mehr als die offene Forderung wird nicht verrechnet.`);
    if (amountCents > availableCents) throw new DomainError(`Verfügbar sind nur ${fmtCents(availableCents)} der Kaution, eingegeben wurden ${fmtCents(amountCents)}. Die Kaution kann nicht negativ werden.`);
    return { amountCents, error: null };
  } catch (e) {
    return { amountCents: 0, error: e instanceof DomainError ? e.message : "Ungültige Eingabe." };
  }
}

/** Vorschau für den Bestätigungsschritt; rechnet serverseitig aus denselben Summen wie die Ausführung, bucht nichts. */
export async function previewDepositOffset(tenantId: string, bookingId: string, invoiceId: string, amount: string | number | null | undefined): Promise<DepositOffsetPreview> {
  const o = await depositOffsetOptions(tenantId, bookingId);
  const inv = o.invoices.find((i) => i.id === invoiceId);
  const openCents = inv?.openCents ?? 0;
  const plan = planAmount(openCents, o.availableCents, amount);
  let error = o.blockedReason ?? plan.error;
  if (!error && !inv) error = "Diese Rechnung ist nicht offen oder gehört nicht zu dieser Buchung.";
  if (!error && inv?.hasDraftCounter) error = "Zu dieser Rechnung gibt es einen Gegenbeleg-Entwurf. Bitte zuerst abschließen oder verwerfen.";
  const amountCents = error ? 0 : plan.amountCents;
  const d = o.deposit;
  return {
    invoiceId, invoiceNumber: inv?.number ?? "", openCents,
    receivedCents: d.receivedCents, releasedCents: d.releasedCents, paidOutCents: d.completedPayoutCents, retainedCents: d.retainedCents, offsetCents: d.offsetCents,
    availableCents: o.availableCents, suggestedCents: Math.max(0, Math.min(openCents, o.availableCents)),
    amountCents, claimAfterCents: Math.max(0, openCents - amountCents), depositAfterCents: Math.max(0, o.availableCents - amountCents),
    invoiceStatusAfter: paymentStatusOf(inv?.grossCents ?? 0, (inv?.paidCents ?? 0) + amountCents),
    error,
  };
}

export type DepositOffsetInput = {
  bookingId: string;
  invoiceId: string;
  /** leer = Vorschlag (min(offen, verfügbar)) */
  amount?: string | number | null;
  occurredAt: Date;
  note?: string | null;
  idempotencyKey?: string | null;
};

export type DepositOffsetResult = { payment: PaymentRow; event: DepositEventRow | null; created: boolean };

const paymentByKey = (client: Tx | typeof db, tenantId: string, key: string) => client.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } }, include: { depositOffsetEvent: true } });

/**
 * Verrechnung ausführen. Sperrt Buchung, Kaution und Rechnung, rechnet offenen Betrag und verfügbare Kaution unter der
 * Sperre neu, lehnt Überverrechnung und negative Kaution ab und schreibt Zahlung, Kautionsbewegung und Audit in einer
 * Transaktion. Gleicher idempotencyKey liefert die vorhandene Verrechnung zurück (Doppelklick bucht nie doppelt).
 */
export async function applyDepositOffset(tenantId: string, actor: Actor, input: DepositOffsetInput): Promise<DepositOffsetResult> {
  checkDate(input.occurredAt, "den Zeitpunkt");
  const key = checkKey(input.idempotencyKey);
  if (key) {
    const existing = await paymentByKey(db, tenantId, key);
    if (existing) return { payment: existing, event: existing.depositOffsetEvent, created: false };
  }
  try {
    return await db.$transaction(async (tx) => {
      const { row: deposit, balance, bookingStatus } = await lockOrCreateDeposit(tx, tenantId, input.bookingId, actor);
      const locked = await tx.$queryRaw<{ id: string; status: string; documentType: string; bookingId: string; number: string | null }[]>`SELECT "id", "status", "documentType", "bookingId", "number" FROM "Invoice" WHERE "id" = ${input.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (key) {
        // unter der Sperre erneut prüfen: ein paralleler Klick mit demselben Schlüssel war vielleicht schneller
        const dup = await paymentByKey(tx, tenantId, key);
        if (dup) return { payment: dup, event: dup.depositOffsetEvent, created: false };
      }
      if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
      const inv = locked[0];
      if (inv.bookingId !== input.bookingId) throw new DomainError("Die Rechnung gehört nicht zu dieser Buchung. Verrechnet wird nur die Kaution derselben Miete.");
      if (inv.status !== "FINALIZED") throw new DomainError("Verrechnet wird nur mit abgeschlossenen Rechnungen.");
      if (inv.documentType !== "INVOICE") throw new DomainError("Verrechnet wird nur mit Rechnungen, nicht mit Gutschriften oder Stornobelegen.");
      if (!OFFSET_ALLOWED_BOOKING_STATUS.has(bookingStatus)) throw new DomainError("Eine Verrechnung ist erst nach der Rückgabe (oder bei Storno) möglich.");
      if (balance.receivedCents <= 0) throw new DomainError("Es wurde noch keine Kaution als erhalten dokumentiert.");
      const f = await invoiceFinancials(tenantId, inv.id, tx);
      if (f.hasDraftCounter) throw new DomainError("Zu dieser Rechnung gibt es einen Gegenbeleg-Entwurf. Bitte zuerst abschließen oder verwerfen.");
      const availableCents = Math.max(0, balance.remainingCents);
      const plan = planAmount(f.openCents, availableCents, input.amount);
      if (plan.error) throw new DomainError(plan.error);
      const amountCents = plan.amountCents;
      const note = input.note?.trim() || null;

      const payment = await tx.payment.create({
        data: {
          tenantId, bookingId: inv.bookingId, invoiceId: inv.id, type: DEPOSIT_OFFSET_METHOD, method: DEPOSIT_OFFSET_METHOD, amountCents,
          paidAt: input.occurredAt, reference: "Verrechnung aus der Kaution", note, idempotencyKey: key, createdById: actor.id, createdByName: actor.name,
        },
      });
      const event = await tx.securityDepositEvent.create({
        data: {
          tenantId, depositId: deposit.id, type: "OFFSET", amountCents, method: null, reference: inv.number ? `Rechnung ${inv.number}` : "Rechnung", note, occurredAt: input.occurredAt,
          idempotencyKey: key ? `${key}-o` : null, paymentId: payment.id, createdById: actor.id, createdByName: actor.name,
        },
      });
      const after = await syncStatus(tx, tenantId, deposit.id);
      await recordAudit(tx, tenantId, actor, {
        action: "DEPOSIT_OFFSET_APPLIED", bookingId: inv.bookingId, invoiceId: inv.id, paymentId: payment.id, depositId: deposit.id, amountCents,
        details: { invoiceNumber: inv.number, openBefore: f.openCents, openAfter: f.openCents - amountCents, depositAvailableBefore: availableCents, depositAvailableAfter: availableCents - amountCents, depositStatusAfter: after.status, at: input.occurredAt.toISOString() },
      });
      return { payment, event, created: true };
    }, TX);
  } catch (e) {
    if (key && isUniqueViolation(e, "idempotencyKey")) {
      const winner = await paymentByKey(db, tenantId, key);
      if (winner) return { payment: winner, event: winner.depositOffsetEvent, created: false };
    }
    return domainFromDb(e);
  }
}

/**
 * Storno einer Verrechnung mit Pflichtgrund: Zahlung und Kautionsbewegung werden gemeinsam storniert, beide Zeilen
 * bleiben sichtbar. Die Forderung ist danach wieder offen, die Kaution wieder verfügbar. Nicht möglich, solange eine
 * abgeschlossene Erstattung der Rechnung dadurch ohne Deckung wäre (dieselbe Regel wie beim Storno einer Zahlung).
 */
export async function cancelDepositOffset(tenantId: string, actor: Actor, paymentId: string, reason: string): Promise<{ payment: PaymentRow; event: DepositEventRow }> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund der Korrektur angeben.");
  try {
    return await db.$transaction(async (tx) => {
      const p0 = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
      if (!p0) throw new DomainError("Verrechnung nicht gefunden.");
      if (p0.type !== "DEPOSIT_OFFSET" || !p0.invoiceId) throw new DomainError("Dieser Eintrag ist keine Kautionsverrechnung.");
      const { row: deposit } = await lockOrCreateDeposit(tx, tenantId, p0.bookingId, actor);
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${p0.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Payment" WHERE "id" = ${paymentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0 || locked[0].status !== "CONFIRMED") throw new DomainError("Diese Verrechnung ist bereits storniert.");
      const ev = await tx.securityDepositEvent.findFirst({ where: { tenantId, paymentId, depositId: deposit.id } });
      if (!ev) throw new DomainError("Die Kautionsbewegung zu dieser Verrechnung wurde nicht gefunden.");
      if (ev.status !== "CONFIRMED") throw new DomainError("Diese Verrechnung ist bereits storniert.");
      // Rechnungsseite: bereits ausgezahlte Erstattungen dürfen nicht ohne Deckung bleiben (wie cancelPayment)
      const f = await invoiceFinancials(tenantId, p0.invoiceId, tx);
      if (f.completedRefundCents > 0 && f.completedRefundCents > Math.max(0, f.paidCents - p0.amountCents - f.effectiveCents)) throw new DomainError(`Zu dieser Rechnung wurden bereits ${fmtCents(f.completedRefundCents)} erstattet. Die Verrechnung kann erst storniert werden, wenn die Auszahlung storniert ist.`);
      const now = new Date();
      const payment = await tx.payment.update({ where: { id: paymentId }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id, cancelledByName: actor.name, cancellationReason: why } });
      const event = await tx.securityDepositEvent.update({ where: { id: ev.id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id, cancelledByName: actor.name, cancellationReason: why } });
      const after = await syncStatus(tx, tenantId, deposit.id);
      await recordAudit(tx, tenantId, actor, { action: "DEPOSIT_OFFSET_CANCELLED", bookingId: p0.bookingId, invoiceId: p0.invoiceId, paymentId, depositId: deposit.id, amountCents: p0.amountCents, details: { reason: why, depositStatusAfter: after.status, openAfter: f.openCents + p0.amountCents } });
      return { payment, event };
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

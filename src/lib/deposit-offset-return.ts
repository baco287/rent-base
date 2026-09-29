// Befehl 22: Kundenguthaben nach Gutschrift/Storno – bewusste Rückführung einer Kautionsverrechnung zur Kaution.
//
// Ausgangslage: Eine Rechnung wurde (auch) aus der Kaution ausgeglichen (Befehl 20.7/21, Payment DEPOSIT_OFFSET + Bewegung
// OFFSET). Später mindert eine Gutschrift oder ein Stornobeleg die Forderung; es entsteht Kundenguthaben (zentral berechnet in
// counter-documents.ts computeFinancials). Rent-Base entscheidet NICHTS automatisch. Der Vermieter wählt je Betrag:
//   a) Guthaben auszahlen   → bestehender Auszahlungsprozess (Payout INVOICE_REFUND, payouts.ts)
//   b) zur Kaution zurückführen → hier: eine neue Gegenbewegung OFFSET_RETURN an der Kaution
// Die ursprüngliche Verrechnung (95 €) bleibt unverändert; die Rückführung (40 €) steht daneben: netto verrechnet 55 €.
// Eine Rückführung ist kein Geldeingang, kein Umsatz, keine Zahlung und ändert keine Rechnung.
//
// Grenzen (App und Datenbank-Trigger rb_check_deposit_event): nie mehr als das noch verfügbare Kundenguthaben der Rechnung
// (Guthaben − ausgezahlt − bereits zurückgeführt) und nie mehr als der noch nicht zurückgeführte Teil der gewählten
// Verrechnung. Keine Auswahl einer „Zahlungsquelle“ durch das System: der Vermieter wählt die konkrete Verrechnung.
// Sperr-Reihenfolge wie überall (deposits.ts): Booking → SecurityDeposit → Invoice → Payment.
//
// Bereits zurückgezahlte Kaution: Liegt zur Kaution eine abgeschlossene Auszahlung vor, ist die Kaution in Geld abgewickelt.
// Eine Rückführung würde sie wieder öffnen (neuer auszahlbarer Rest an einer bereits zurückgezahlten Kaution). Das wird nicht
// angeboten und serverseitig abgelehnt; das Guthaben bleibt bestehen und wird über „Guthaben auszahlen“ erstattet.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { invoiceFinancials, type InvoiceFinancials } from "@/lib/counter-documents";
import { checkDate, checkKey, computeDepositFinancials, balanceOf, domainFromDb, lockOrCreateDeposit, parseAmount, syncStatus, type DepositEventRow } from "@/lib/deposits";
import { DomainError } from "@/lib/integrity";
import { fmtCents, type Cents } from "@/lib/money";
import { isUniqueViolation } from "@/lib/numbering";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;
const TX = { timeout: 20_000, maxWait: 10_000 };

export type ReturnableOffset = {
  paymentId: string;
  paidAt: Date;
  amountCents: Cents;
  returnedCents: Cents;
  /** noch nicht zurückgeführter Teil dieser Verrechnung */
  returnableCents: Cents;
};

export type OffsetReturnOptions = {
  invoiceId: string;
  invoiceNumber: string | null;
  bookingId: string;
  financials: InvoiceFinancials;
  /** Gutschriften/Stornobelege, aus denen das Guthaben (auch) stammt */
  counterDocuments: { id: string; number: string | null; documentType: string; grossCents: Cents }[];
  offsets: ReturnableOffset[];
  /** Kautionsstand für die Vorschau */
  deposit: { depositId: string | null; receivedCents: Cents; offsetGrossCents: Cents; offsetReturnedCents: Cents; offsetNetCents: Cents; availableCents: Cents; completedPayoutCents: Cents };
  /** null = Rückführung grundsätzlich möglich */
  blockedReason: string | null;
};

async function offsetsOf(client: Client, tenantId: string, invoiceId: string): Promise<ReturnableOffset[]> {
  const rows = await client.payment.findMany({ where: { tenantId, invoiceId, type: "DEPOSIT_OFFSET", status: "CONFIRMED" }, orderBy: { paidAt: "asc" }, select: { id: true, paidAt: true, amountCents: true, offsetReturns: { where: { status: "CONFIRMED", type: "OFFSET_RETURN" }, select: { amountCents: true } } } });
  return rows.map((r) => {
    const returnedCents = r.offsetReturns.reduce((a, e) => a + e.amountCents, 0);
    return { paymentId: r.id, paidAt: r.paidAt, amountCents: r.amountCents, returnedCents, returnableCents: Math.max(0, r.amountCents - returnedCents) };
  });
}

async function depositStateOf(client: Client, tenantId: string, bookingId: string) {
  const dep = await client.securityDeposit.findFirst({ where: { tenantId, bookingId }, include: { events: { select: { type: true, amountCents: true, status: true } } } });
  if (!dep) return { depositId: null, receivedCents: 0, offsetGrossCents: 0, offsetReturnedCents: 0, offsetNetCents: 0, availableCents: 0, completedPayoutCents: 0 };
  const paidOut = (await client.payout.aggregate({ where: { tenantId, securityDepositId: dep.id, status: "COMPLETED" }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
  const b = balanceOf(dep.expectedAmountCents, dep.events);
  return { depositId: dep.id, receivedCents: b.receivedCents, offsetGrossCents: b.offsetGrossCents, offsetReturnedCents: b.offsetReturnedCents, offsetNetCents: b.offsetCents, availableCents: Math.max(0, b.remainingCents), completedPayoutCents: paidOut };
}

function blockedOf(inv: { status: string; documentType: string }, f: InvoiceFinancials, offsets: ReturnableOffset[], deposit: { depositId: string | null; completedPayoutCents: Cents }): string | null {
  if (inv.status !== "FINALIZED" || inv.documentType !== "INVOICE") return "Zurückgeführt wird nur zu abgeschlossenen Rechnungen.";
  if (f.refundRemainingCents <= 0) return f.customerCreditCents > 0 ? "Das Kundenguthaben dieser Rechnung ist bereits vollständig ausgezahlt oder zur Kaution zurückgeführt." : "Zu dieser Rechnung besteht kein Kundenguthaben.";
  if (offsets.length === 0) return "Diese Rechnung wurde nicht aus der Kaution ausgeglichen; das Guthaben kann nur ausgezahlt werden.";
  if (!offsets.some((o) => o.returnableCents > 0)) return "Die Kautionsverrechnungen dieser Rechnung sind bereits vollständig zurückgeführt.";
  if (!deposit.depositId) return "Zu dieser Buchung gibt es keine Kaution.";
  if (deposit.completedPayoutCents > 0) return "Die Kaution wurde bereits (teilweise) an den Kunden zurückgezahlt und ist damit abgewickelt. Das Guthaben bleibt bestehen und kann über „Guthaben auszahlen“ erstattet werden.";
  return null;
}

/** Ausgangslage für die Oberfläche (rechnet nichts Neues, bucht nichts). */
export async function offsetReturnOptions(tenantId: string, invoiceId: string, client: Client = db): Promise<OffsetReturnOptions> {
  const inv = await client.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, number: true, status: true, documentType: true, bookingId: true, counterDocuments: { where: { status: "FINALIZED" }, orderBy: { finalizedAt: "asc" }, select: { id: true, number: true, documentType: true, currentVersion: { select: { grossTotal: true } } } } } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  const [financials, offsets, deposit] = await Promise.all([invoiceFinancials(tenantId, inv.id, client), offsetsOf(client, tenantId, inv.id), depositStateOf(client, tenantId, inv.bookingId)]);
  return {
    invoiceId: inv.id, invoiceNumber: inv.number, bookingId: inv.bookingId, financials,
    counterDocuments: inv.counterDocuments.map((c) => ({ id: c.id, number: c.number, documentType: c.documentType, grossCents: Math.round(Number(c.currentVersion?.grossTotal ?? 0) * 100) })),
    offsets, deposit, blockedReason: blockedOf(inv, financials, offsets, deposit),
  };
}

export type OffsetReturnPreview = { availableCreditCents: Cents; offsetCents: Cents; offsetReturnedCents: Cents; maxCents: Cents; amountCents: Cents; creditAfterCents: Cents; depositAvailableBeforeCents: Cents; depositAvailableAfterCents: Cents; offsetNetAfterCents: Cents; error: string | null };

function planReturn(availableCredit: Cents, returnable: Cents, amount: string | number | null | undefined): { amountCents: Cents; maxCents: Cents; error: string | null } {
  const maxCents = Math.max(0, Math.min(availableCredit, returnable));
  try {
    if (availableCredit <= 0) throw new DomainError("Es ist kein Kundenguthaben mehr verfügbar.");
    if (returnable <= 0) throw new DomainError("Diese Kautionsverrechnung ist bereits vollständig zurückgeführt.");
    const amountCents = amount == null || amount === "" ? maxCents : parseAmount(amount, "Der Rückführungsbetrag");
    if (amountCents <= 0) throw new DomainError("Der Rückführungsbetrag muss größer als 0,00 € sein.");
    if (amountCents > availableCredit) throw new DomainError(`Verfügbar sind nur ${fmtCents(availableCredit)} Kundenguthaben, eingegeben wurden ${fmtCents(amountCents)}.`);
    if (amountCents > returnable) throw new DomainError(`Aus dieser Verrechnung sind nur noch ${fmtCents(returnable)} rückführbar, eingegeben wurden ${fmtCents(amountCents)}. Mehr als verrechnet wurde, kann nicht zurückgeführt werden.`);
    return { amountCents, maxCents, error: null };
  } catch (e) {
    return { amountCents: 0, maxCents, error: e instanceof DomainError ? e.message : "Ungültige Eingabe." };
  }
}

/** Vorschau für den Bestätigungsschritt: rechnet aus denselben Summen wie die Ausführung, bucht nichts. */
export async function previewOffsetReturn(tenantId: string, invoiceId: string, paymentId: string, amount: string | number | null | undefined): Promise<OffsetReturnPreview> {
  const o = await offsetReturnOptions(tenantId, invoiceId);
  const off = o.offsets.find((x) => x.paymentId === paymentId);
  const plan = planReturn(o.financials.refundRemainingCents, off?.returnableCents ?? 0, amount);
  let error = o.blockedReason ?? plan.error;
  if (!error && !off) error = "Diese Kautionsverrechnung gehört nicht zu dieser Rechnung.";
  const amountCents = error ? 0 : plan.amountCents;
  return {
    availableCreditCents: o.financials.refundRemainingCents, offsetCents: off?.amountCents ?? 0, offsetReturnedCents: off?.returnedCents ?? 0, maxCents: plan.maxCents, amountCents,
    creditAfterCents: o.financials.refundRemainingCents - amountCents, depositAvailableBeforeCents: o.deposit.availableCents, depositAvailableAfterCents: o.deposit.availableCents + amountCents, offsetNetAfterCents: o.deposit.offsetNetCents - amountCents, error,
  };
}

export type OffsetReturnInput = { invoiceId: string; paymentId: string; amount: string | number; occurredAt: Date; note?: string | null; idempotencyKey?: string | null };

const eventByKey = (client: Client, tenantId: string, key: string) => client.securityDepositEvent.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });

/**
 * Rückführung ausführen – ausschließlich auf ausdrückliche Bestätigung. Sperrt Buchung, Kaution, Rechnung und die
 * Verrechnungszahlung, rechnet Guthaben und rückführbaren Rest unter der Sperre neu und schreibt Gegenbewegung und Audit in
 * einer Transaktion. Gleicher Schlüssel liefert die vorhandene Rückführung (Doppelklick bucht nie doppelt).
 */
export async function returnOffsetToDeposit(tenantId: string, actor: Actor, input: OffsetReturnInput): Promise<{ event: DepositEventRow; created: boolean }> {
  checkDate(input.occurredAt, "den Zeitpunkt");
  const key = checkKey(input.idempotencyKey);
  if (parseAmount(input.amount, "Der Rückführungsbetrag") <= 0) throw new DomainError("Der Rückführungsbetrag muss größer als 0,00 € sein.");
  if (key) {
    const existing = await eventByKey(db, tenantId, key);
    if (existing) return { event: existing, created: false };
  }
  const head = await db.invoice.findFirst({ where: { id: input.invoiceId, tenantId }, select: { bookingId: true } });
  if (!head) throw new DomainError("Rechnung nicht gefunden.");
  try {
    return await db.$transaction(async (tx) => {
      const { row: deposit, balance } = await lockOrCreateDeposit(tx, tenantId, head.bookingId, actor);
      const inv = await tx.$queryRaw<{ id: string; status: string; documentType: string; bookingId: string; number: string | null }[]>`SELECT "id", "status", "documentType", "bookingId", "number" FROM "Invoice" WHERE "id" = ${input.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (inv.length === 0) throw new DomainError("Rechnung nicht gefunden.");
      const pay = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Payment" WHERE "id" = ${input.paymentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (key) {
        const dup = await eventByKey(tx, tenantId, key);
        if (dup) return { event: dup, created: false };
      }
      if (pay.length === 0) throw new DomainError("Kautionsverrechnung nicht gefunden.");
      const o = await offsetReturnOptions(tenantId, input.invoiceId, tx);
      if (o.blockedReason) throw new DomainError(o.blockedReason);
      const off = o.offsets.find((x) => x.paymentId === input.paymentId);
      if (!off) throw new DomainError("Diese Kautionsverrechnung gehört nicht zu dieser Rechnung.");
      const plan = planReturn(o.financials.refundRemainingCents, off.returnableCents, input.amount);
      if (plan.error) throw new DomainError(plan.error);
      const amountCents = plan.amountCents;
      const docs = o.counterDocuments.map((c) => c.number).filter(Boolean).join(", ");
      const event = await tx.securityDepositEvent.create({
        data: {
          tenantId, depositId: deposit.id, type: "OFFSET_RETURN", amountCents, method: null,
          reference: `${docs ? `${docs} zu ` : ""}Rechnung ${inv[0].number ?? ""}`.trim(), note: input.note?.trim() || null, occurredAt: input.occurredAt,
          idempotencyKey: key, invoiceId: input.invoiceId, returnsPaymentId: input.paymentId, createdById: actor.id, createdByName: actor.name,
        },
      });
      const after = await syncStatus(tx, tenantId, deposit.id);
      const fully = off.returnedCents + amountCents >= off.amountCents;
      await recordAudit(tx, tenantId, actor, {
        action: fully ? "DEPOSIT_OFFSET_FULLY_RETURNED" : "DEPOSIT_OFFSET_PARTIALLY_RETURNED",
        bookingId: head.bookingId, invoiceId: input.invoiceId, paymentId: input.paymentId, depositId: deposit.id, amountCents,
        details: {
          invoiceNumber: inv[0].number, counterDocuments: docs || null, eventId: event.id,
          offsetCents: off.amountCents, offsetReturnedBefore: off.returnedCents, offsetReturnedAfter: off.returnedCents + amountCents,
          creditAvailableBefore: o.financials.refundRemainingCents, creditAvailableAfter: o.financials.refundRemainingCents - amountCents,
          depositAvailableBefore: Math.max(0, balance.remainingCents), depositAvailableAfter: Math.max(0, after.remainingCents), depositStatusAfter: after.status, at: input.occurredAt.toISOString(),
        },
      });
      return { event, created: true };
    }, TX);
  } catch (e) {
    if (key && isUniqueViolation(e, "idempotencyKey")) {
      const winner = await eventByKey(db, tenantId, key);
      if (winner) return { event: winner, created: false };
    }
    return domainFromDb(e);
  }
}

/**
 * Storno einer irrtümlichen Rückführung (Grund Pflicht). Die Bewegung bleibt sichtbar. Das Guthaben ist danach wieder
 * verfügbar; die Kaution verliert den zurückgeführten Betrag wieder – nur zulässig, solange er nicht inzwischen freigegeben
 * und ausgezahlt bzw. anderweitig verbraucht wurde (sonst würde der Kautionssaldo negativ oder eine Auszahlung ungedeckt).
 */
export async function cancelOffsetReturn(tenantId: string, actor: Actor, eventId: string, reason: string): Promise<DepositEventRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund der Korrektur angeben.");
  const head = await db.securityDepositEvent.findFirst({ where: { id: eventId, tenantId }, select: { type: true, deposit: { select: { bookingId: true } } } });
  if (!head || head.type !== "OFFSET_RETURN") throw new DomainError("Rückführung nicht gefunden.");
  try {
    return await db.$transaction(async (tx) => {
      const { row: deposit } = await lockOrCreateDeposit(tx, tenantId, head.deposit.bookingId, actor);
      const ev = await tx.securityDepositEvent.findFirstOrThrow({ where: { id: eventId, tenantId } });
      if (ev.depositId !== deposit.id) throw new DomainError("Rückführung nicht gefunden.");
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${ev.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (ev.status !== "CONFIRMED") throw new DomainError("Diese Rückführung ist bereits storniert.");
      // Kautionsseite: ohne diese Rückführung muss der Saldo gedeckt bleiben (nichts freigegeben/ausgezahlt, was daraus stammt)
      const others = await tx.securityDepositEvent.findMany({ where: { tenantId, depositId: deposit.id, status: "CONFIRMED", id: { not: ev.id } }, select: { type: true, amountCents: true, status: true } });
      const paidOut = (await tx.payout.aggregate({ where: { tenantId, securityDepositId: deposit.id, status: "COMPLETED" }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
      const afterBalance = computeDepositFinancials(balanceOf(deposit.expectedAmountCents, others), paidOut);
      if (afterBalance.remainingCents < 0) throw new DomainError(`Die zurückgeführten ${fmtCents(ev.amountCents)} sind an der Kaution bereits freigegeben, einbehalten oder erneut verrechnet. Bitte zuerst diese Bewegung korrigieren.`);
      if (afterBalance.payoutExcessCents > 0) throw new DomainError(`Von dieser Kaution wurden bereits ${fmtCents(paidOut)} ausgezahlt. Die Rückführung kann erst storniert werden, wenn die Auszahlung storniert ist.`);
      const now = new Date();
      const updated = await tx.securityDepositEvent.update({ where: { id: ev.id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id, cancelledByName: actor.name, cancellationReason: why } });
      const after = await syncStatus(tx, tenantId, deposit.id);
      const f = await invoiceFinancials(tenantId, ev.invoiceId!, tx);
      await recordAudit(tx, tenantId, actor, { action: "DEPOSIT_OFFSET_RETURN_CANCELLED", bookingId: deposit.bookingId, invoiceId: ev.invoiceId, paymentId: ev.returnsPaymentId, depositId: deposit.id, amountCents: ev.amountCents, details: { eventId: ev.id, reason: why, creditAvailableAfter: f.refundRemainingCents, depositAvailableAfter: Math.max(0, after.remainingCents), depositStatusAfter: after.status } });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

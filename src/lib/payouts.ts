// Auszahlungen (Phase 18): tatsächliche Geldabflüsse an den Kunden – Rechnungserstattung oder Kautionsrückzahlung – mit
// einer gemeinsamen Architektur. Vier Dinge bleiben getrennt:
//   Forderung (Invoice) · Zahlung (Payment, Geld rein) · Guthaben/Freigabe (abgeleitet bzw. RELEASED) · Auszahlung (Payout, Geld raus).
// Grundsätze:
// - Nur COMPLETED zählt finanziell. Ein Entwurf verringert nie den Rest.
// - Nie mehr auszahlen als verfügbar: Rechnung → Kundenguthaben − bereits ausgezahlt; Kaution → freigegeben (höchstens erhalten −
//   einbehalten) − bereits ausgezahlt. Beim Abschluss wird die Quelle gesperrt und der Rest neu gerechnet (zusätzlich DB-Trigger).
// - Payments und Kautionsbewegungen werden nie verändert. Keine Verrechnung, keine Bank-, Karten- oder Providertransaktion.
// - COMPLETED ist unveränderlich; Korrektur nur als Storno mit Grund und neue Auszahlung. Kein Löschen.
// - IBAN nur an der Auszahlung (Snapshot), verschleiert in Anzeige, PDF und Protokoll.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { PAYOUT_METHODS, type PayoutMethod } from "@/lib/constants";
import { financialsFor, invoiceFinancials, type InvoiceFinancials } from "@/lib/counter-documents";
import { domainFromDb } from "@/lib/db-errors";
import { computeDepositFinancials, balanceOf, securityDepositFinancials, type DepositFinancials } from "@/lib/deposits";
import { DomainError, contentHash } from "@/lib/integrity";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation, nextPayoutNumber, withNumberRetry } from "@/lib/numbering";
import type { PayoutSourceSnapshot } from "@/lib/payout-view";
import { loadPayoutDocumentData } from "@/lib/document-data";
import { readDocumentFile, registerDocument } from "@/lib/documents";
import { claimEmail, markEmailFailed, markEmailSent, type EmailLogRow } from "@/lib/email-log";
import { getMailTransport, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import type { StorageDriver } from "@/lib/storage";
import { APP_TIME_ZONE } from "@/lib/time";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type PayoutRow = Prisma.PayoutGetPayload<object>;

const dateFmt = (d: Date | null) => (d ? d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }) : null);

// ---------------------------------------------------------------------------
// IBAN: Formatprüfung (Länge je Land grob, Prüfziffer mod 97) und Verschleierung. Keine Aussage über den Kontoinhaber.
// ---------------------------------------------------------------------------

export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** DE12 3456 7890 1234 5678 90 → DE** **** **** **** **78 90 (Land und letzte 4 Stellen bleiben). */
export function maskIban(raw: string): string {
  const iban = normalizeIban(raw);
  const masked = iban.slice(0, 2) + "*".repeat(Math.max(0, iban.length - 6)) + iban.slice(-4);
  return masked.replace(/(.{4})/g, "$1 ").trim();
}

// ---------------------------------------------------------------------------
// Verfügbarer Rest je Quelle
// ---------------------------------------------------------------------------

export type PayoutSource =
  | { sourceType: "INVOICE_REFUND"; invoiceId: string; bookingId: string; customerId: string | null; customerName: string; customerEmail: string | null; remainingCents: Cents; snapshot: PayoutSourceSnapshot; invoice: InvoiceFinancials }
  | { sourceType: "SECURITY_DEPOSIT_REFUND"; securityDepositId: string; bookingId: string; customerId: string | null; customerName: string; customerEmail: string | null; remainingCents: Cents; snapshot: PayoutSourceSnapshot; deposit: DepositFinancials };

const nameOf = (c: { type?: string; companyName?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined) => {
  if (!c) return "";
  const person = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  return c.type === "COMPANY" && c.companyName ? (person ? `${c.companyName}, ${person}` : c.companyName) : person;
};

/** Rechnung als Auszahlungsquelle: Kundenguthaben aus der zentralen Summierung, Empfänger aus der Rechnungskopie. */
export async function invoiceRefundSource(client: Client, tenantId: string, invoiceId: string): Promise<PayoutSource & { sourceType: "INVOICE_REFUND" }> {
  const inv = await client.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, number: true, status: true, documentType: true, bookingId: true, customerId: true, booking: { select: { number: true } }, contract: { select: { number: true } }, currentVersion: { select: { issueDate: true, customerSnapshot: true, grossTotal: true } }, counterDocuments: { where: { status: "FINALIZED" }, select: { number: true }, orderBy: { finalizedAt: "asc" } } } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  if (inv.status !== "FINALIZED" || inv.documentType !== "INVOICE" || !inv.currentVersion) throw new DomainError("Erstattungen gibt es nur zu abgeschlossenen Rechnungen, nicht zu Entwürfen, Gutschriften oder Stornobelegen.");
  const f = (await financialsFor(tenantId, [{ id: inv.id, grossTotal: inv.currentVersion.grossTotal }], client)).get(inv.id)!;
  const c = inv.currentVersion.customerSnapshot as { type?: string; companyName?: string | null; firstName?: string; lastName?: string; email?: string | null };
  const snapshot: PayoutSourceSnapshot = {
    sourceType: "INVOICE_REFUND", bookingNumber: inv.booking.number, contractNumber: inv.contract?.number ?? null, invoiceNumber: inv.number, invoiceDate: dateFmt(inv.currentVersion.issueDate),
    chain: inv.counterDocuments.map((c) => c.number).filter((n): n is string => !!n), customerName: nameOf(c), customerEmail: typeof c.email === "string" && c.email.trim() ? c.email.trim() : null,
    invoiceCents: f.invoiceCents, effectiveCents: f.effectiveCents, paidCents: f.paidCents, customerCreditCents: f.customerCreditCents, paidOutBeforeCents: f.completedRefundCents,
  };
  return { sourceType: "INVOICE_REFUND", invoiceId: inv.id, bookingId: inv.bookingId, customerId: inv.customerId, customerName: snapshot.customerName, customerEmail: snapshot.customerEmail, remainingCents: f.refundRemainingCents, snapshot, invoice: f };
}

/** Kaution als Auszahlungsquelle: freigegeben minus ausgezahlt, Empfänger aus der Vertragskopie. */
export async function depositRefundSource(client: Client, tenantId: string, bookingId: string): Promise<PayoutSource & { sourceType: "SECURITY_DEPOSIT_REFUND" }> {
  const booking = await client.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, number: true, customerId: true, contract: { select: { number: true, customerSnapshot: true } }, securityDeposit: { select: { id: true } } } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  if (!booking.securityDeposit) throw new DomainError("Zu dieser Buchung ist keine Kaution als erhalten dokumentiert; es ist nichts auszuzahlen.");
  const d = await securityDepositFinancials(tenantId, bookingId, client);
  const c = booking.contract?.customerSnapshot as { type?: string; companyName?: string | null; firstName?: string; lastName?: string; email?: string | null } | null;
  const snapshot: PayoutSourceSnapshot = {
    sourceType: "SECURITY_DEPOSIT_REFUND", bookingNumber: booking.number, contractNumber: booking.contract?.number ?? null, invoiceNumber: null, invoiceDate: null, chain: [],
    customerName: nameOf(c), customerEmail: typeof c?.email === "string" && c.email.trim() ? c.email.trim() : null,
    expectedCents: d.expectedCents, receivedCents: d.receivedCents, retainedCents: d.retainedCents, releasedCents: d.releasedCents, paidOutBeforeCents: d.completedPayoutCents,
  };
  return { sourceType: "SECURITY_DEPOSIT_REFUND", securityDepositId: booking.securityDeposit.id, bookingId: booking.id, customerId: booking.customerId, customerName: snapshot.customerName, customerEmail: snapshot.customerEmail, remainingCents: d.payoutRemainingCents, snapshot, deposit: d };
}

export type SourceRef = { sourceType: "INVOICE_REFUND"; invoiceId: string } | { sourceType: "SECURITY_DEPOSIT_REFUND"; bookingId: string };

export async function payoutSource(client: Client, tenantId: string, ref: SourceRef): Promise<PayoutSource> {
  return ref.sourceType === "INVOICE_REFUND" ? invoiceRefundSource(client, tenantId, ref.invoiceId) : depositRefundSource(client, tenantId, ref.bookingId);
}

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------

export type PayoutInput = {
  amount: string | number;
  method: string;
  methodDescription?: string | null;
  /** tatsächlicher Zeitpunkt (Pflicht beim Abschluss); im Entwurf optional als geplanter Zeitpunkt */
  executedAt?: Date | null;
  recipientName?: string | null;
  recipientReason?: string | null;
  iban?: string | null;
  reference?: string | null;
  receiptConfirmed?: boolean;
  historicalEntry?: boolean;
  customerNote?: string | null;
  internalNote?: string | null;
  /** einmaliger Formularschlüssel gegen Doppelbuchung */
  idempotencyKey?: string | null;
};

type Checked = { amountCents: Cents; method: PayoutMethod; methodDescription: string | null; recipientName: string; recipientDeviates: boolean; recipientReason: string | null; iban: string | null; ibanMasked: string | null; reference: string | null; receiptConfirmed: boolean; historicalEntry: boolean; customerNote: string | null; internalNote: string | null };

function parseAmount(v: string | number): Cents {
  let cents: Cents;
  try { cents = toCents(v); } catch { throw new DomainError("Bitte einen gültigen Betrag eingeben (z. B. 120,50)."); }
  if (cents <= 0) throw new DomainError("Der Auszahlungsbetrag muss größer als 0,00 € sein.");
  if (cents > 100_000_000_00) throw new DomainError("Der Betrag ist unplausibel hoch.");
  return cents;
}

/** Eingaben prüfen; `strict` = Pflichtfelder für den Abschluss (Datum, Weg-spezifische Angaben). */
function checkInput(input: PayoutInput, source: PayoutSource, strict: boolean): Checked {
  const amountCents = parseAmount(input.amount);
  if (!(input.method in PAYOUT_METHODS)) throw new DomainError("Bitte den Auszahlungsweg wählen.");
  const method = input.method as PayoutMethod;
  const methodDescription = input.methodDescription?.trim() || null;
  if (method === "OTHER" && strict && (!methodDescription || methodDescription.length < 3)) throw new DomainError("Bitte beschreiben, auf welchem Weg ausgezahlt wurde.");
  const recipientName = (input.recipientName?.trim() || source.customerName).slice(0, 200);
  if (!recipientName) throw new DomainError("Bitte den Empfänger angeben.");
  const recipientDeviates = recipientName !== source.customerName;
  const recipientReason = input.recipientReason?.trim() || null;
  if (recipientDeviates && (!recipientReason || recipientReason.length < 3)) throw new DomainError("Der Empfänger weicht vom Kunden ab. Bitte den Grund angeben.");
  let iban: string | null = null;
  let ibanMasked: string | null = null;
  if (method === "BANK_TRANSFER") {
    const raw = input.iban?.trim() || "";
    if (strict && !raw) throw new DomainError("Bei einer Überweisung ist die IBAN des Empfängerkontos anzugeben.");
    if (raw) {
      if (!isValidIban(raw)) throw new DomainError("Die IBAN ist nicht plausibel (Format oder Prüfziffer). Bitte prüfen.");
      iban = normalizeIban(raw);
      ibanMasked = maskIban(iban);
    }
  }
  const reference = input.reference?.trim().slice(0, 140) || null;
  if (strict && method === "CARD" && !reference) throw new DomainError("Bei einer Kartenrückbuchung bitte die Transaktions- oder Belegreferenz angeben.");
  return { amountCents, method, methodDescription, recipientName, recipientDeviates, recipientReason: recipientDeviates ? recipientReason : null, iban, ibanMasked, reference, receiptConfirmed: !!input.receiptConfirmed && method === "CASH", historicalEntry: !!input.historicalEntry, customerNote: input.customerNote?.trim().slice(0, 1000) || null, internalNote: input.internalNote?.trim().slice(0, 2000) || null };
}

function checkExecutedAt(d: Date | null | undefined, strict: boolean): Date | null {
  if (!d) {
    if (strict) throw new DomainError("Bitte den tatsächlichen Zeitpunkt der Auszahlung angeben.");
    return null;
  }
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new DomainError("Bitte einen gültigen Zeitpunkt angeben.");
  if (strict && d.getTime() > Date.now() + 5 * 60_000) throw new DomainError("Der Auszahlungszeitpunkt einer erfolgten Auszahlung darf nicht in der Zukunft liegen.");
  if (d.getTime() < Date.parse("2000-01-01T00:00:00Z")) throw new DomainError("Der Zeitpunkt ist unplausibel.");
  return d;
}

function checkKey(key: string | null | undefined) {
  const k = key?.trim() || null;
  if (k && !/^[A-Za-z0-9-]{8,64}$/.test(k)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  return k;
}

const auditDetails = (p: PayoutRow, extra: Record<string, string | number | boolean | null> = {}) => ({ payoutId: p.id, number: p.number, sourceType: p.sourceType, sourceId: p.invoiceId ?? p.securityDepositId ?? null, amountCents: p.amountCents, method: p.method, status: p.status, ibanMasked: p.ibanMasked, historicalEntry: p.historicalEntry, ...extra });

// ---------------------------------------------------------------------------
// Vorschau
// ---------------------------------------------------------------------------

export type PayoutPreview = { source: PayoutSource; amountCents: Cents; remainingBefore: Cents; remainingAfter: Cents; recipientName: string; recipientDeviates: boolean; ibanMasked: string | null; method: PayoutMethod; error: string | null };

/** Serverseitige Vorschau für den Bestätigungsschritt; bucht nichts. */
export async function previewPayout(tenantId: string, ref: SourceRef, input: PayoutInput): Promise<PayoutPreview> {
  const source = await payoutSource(db, tenantId, ref);
  let error: string | null = null;
  let checked: Checked | null = null;
  try {
    checked = checkInput(input, source, true);
    checkExecutedAt(input.executedAt, true);
    if (source.remainingCents <= 0) throw new DomainError(source.sourceType === "INVOICE_REFUND" ? "Zu dieser Rechnung ist nichts auszuzahlen." : "Von dieser Kaution ist nichts auszuzahlen.");
    if (checked.amountCents > source.remainingCents) throw new DomainError(`Noch auszuzahlen sind ${fmtCents(source.remainingCents)}, eingegeben wurden ${fmtCents(checked.amountCents)}. Mehr als der Rest wird nicht ausgezahlt.`);
  } catch (e) {
    error = e instanceof DomainError ? e.message : "Ungültige Eingabe.";
  }
  const amountCents = checked?.amountCents ?? 0;
  return { source, amountCents, remainingBefore: source.remainingCents, remainingAfter: Math.max(0, source.remainingCents - amountCents), recipientName: checked?.recipientName ?? source.customerName, recipientDeviates: checked?.recipientDeviates ?? false, ibanMasked: checked?.ibanMasked ?? null, method: checked?.method ?? "BANK_TRANSFER", error };
}

// ---------------------------------------------------------------------------
// Anlegen (Entwurf oder sofort als erfolgt), ändern, abschließen, stornieren
// ---------------------------------------------------------------------------

async function lockSource(tx: Tx, tenantId: string, ref: SourceRef): Promise<PayoutSource> {
  if (ref.sourceType === "INVOICE_REFUND") {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${ref.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
  } else {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT d."id" FROM "SecurityDeposit" d WHERE d."bookingId" = ${ref.bookingId} AND d."tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Zu dieser Buchung ist keine Kaution als erhalten dokumentiert; es ist nichts auszuzahlen.");
  }
  return payoutSource(tx, tenantId, ref);
}

const refOf = (p: { sourceType: string; invoiceId: string | null; bookingId: string }): SourceRef => (p.sourceType === "INVOICE_REFUND" ? { sourceType: "INVOICE_REFUND", invoiceId: p.invoiceId! } : { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: p.bookingId });

function sealedPayoutContent(p: PayoutRow) {
  return {
    number: p.number, sourceType: p.sourceType, invoiceId: p.invoiceId, securityDepositId: p.securityDepositId, bookingId: p.bookingId, customerId: p.customerId,
    amountCents: p.amountCents, currency: p.currency, method: p.method, methodDescription: p.methodDescription, executedAt: p.executedAt,
    recipientName: p.recipientName, recipientDeviates: p.recipientDeviates, recipientReason: p.recipientReason, ibanMasked: p.ibanMasked, iban: p.iban,
    reference: p.reference, receiptConfirmed: p.receiptConfirmed, historicalEntry: p.historicalEntry, customerNote: p.customerNote, sourceSnapshot: p.sourceSnapshot, completedAt: p.completedAt, completedById: p.completedById,
  };
}

async function completeInTx(tx: Tx, tenantId: string, actor: Actor, payoutId: string, now: Date): Promise<PayoutRow> {
  const p0 = await tx.payout.findFirstOrThrow({ where: { id: payoutId, tenantId } });
  const source = await lockSource(tx, tenantId, refOf(p0));
  const p = await tx.payout.findFirstOrThrow({ where: { id: payoutId, tenantId } }); // unter der Sperre neu lesen
  if (p.status !== "DRAFT") throw new DomainError(p.status === "COMPLETED" ? `Auszahlung ${p.number} ist bereits als erfolgt erfasst.` : "Diese Auszahlung ist storniert.");
  if (!p.executedAt) throw new DomainError("Bitte den tatsächlichen Zeitpunkt der Auszahlung angeben.");
  checkExecutedAt(p.executedAt, true);
  if (p.method === "BANK_TRANSFER" && !p.iban) throw new DomainError("Bei einer Überweisung ist die IBAN des Empfängerkontos anzugeben.");
  if (p.method === "OTHER" && (!p.methodDescription || p.methodDescription.trim().length < 3)) throw new DomainError("Bitte beschreiben, auf welchem Weg ausgezahlt wurde.");
  if (source.remainingCents <= 0) throw new DomainError(source.sourceType === "INVOICE_REFUND" ? `Zur Rechnung ${source.snapshot.invoiceNumber} ist nichts (mehr) auszuzahlen.` : "Von dieser Kaution ist nichts (mehr) auszuzahlen.");
  if (p.amountCents > source.remainingCents) throw new DomainError(`Die Auszahlung (${fmtCents(p.amountCents)}) übersteigt den noch auszuzahlenden Betrag (${fmtCents(source.remainingCents)}). Bitte den Betrag anpassen.`);
  const number = await nextPayoutNumber(tx, tenantId, now);
  const withNumber = await tx.payout.update({ where: { id: p.id }, data: { number, completedAt: now, completedById: actor.id, completedByName: actor.name, sourceSnapshot: source.snapshot as unknown as Prisma.InputJsonValue } });
  const hash = contentHash(sealedPayoutContent(withNumber));
  const done = await tx.payout.update({ where: { id: p.id }, data: { status: "COMPLETED", contentHash: hash } });
  await recordAudit(tx, tenantId, actor, { action: "PAYOUT_COMPLETED", bookingId: done.bookingId, invoiceId: done.invoiceId, depositId: done.securityDepositId, amountCents: done.amountCents, details: auditDetails(done, { remainingBefore: source.remainingCents, remainingAfter: source.remainingCents - done.amountCents, executedAt: done.executedAt!.toISOString() }) });
  return done;
}

export type CreateOptions = { complete: boolean; confirmed?: boolean };

/**
 * Auszahlung anlegen: als Entwurf (kein Geldfluss) oder direkt als tatsächlich erfolgt (COMPLETED, mit Nummer, Snapshot und
 * Prüfsumme). Gleicher idempotencyKey erzeugt nie zwei Auszahlungen.
 */
export async function createPayout(tenantId: string, actor: Actor, ref: SourceRef, input: PayoutInput, opts: CreateOptions): Promise<{ payout: PayoutRow; created: boolean }> {
  const key = checkKey(input.idempotencyKey);
  if (opts.complete && !opts.confirmed) throw new DomainError("Bitte bestätigen, dass die Auszahlung tatsächlich erfolgt ist.");
  if (key) {
    const existing = await db.payout.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
    if (existing) return { payout: existing, created: false };
  }
  const run = () => db.$transaction(async (tx) => {
    const source = await lockSource(tx, tenantId, ref);
    if (key) {
      // unter der Sperre erneut prüfen: ein paralleler Klick mit demselben Schlüssel war vielleicht schneller
      const dup = await tx.payout.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (dup) return { payout: dup, created: false };
    }
    const checked = checkInput(input, source, opts.complete);
    const executedAt = checkExecutedAt(input.executedAt, opts.complete);
    if (source.remainingCents <= 0) throw new DomainError(source.sourceType === "INVOICE_REFUND" ? `Zur Rechnung ${source.snapshot.invoiceNumber} ist nichts auszuzahlen.` : "Von dieser Kaution ist nichts auszuzahlen.");
    if (checked.amountCents > source.remainingCents) throw new DomainError(`Noch auszuzahlen sind ${fmtCents(source.remainingCents)}, eingegeben wurden ${fmtCents(checked.amountCents)}. Mehr als der Rest wird nicht ausgezahlt.`);
    const now = new Date();
    const draft = await tx.payout.create({
      data: {
        tenantId, sourceType: source.sourceType, invoiceId: source.sourceType === "INVOICE_REFUND" ? source.invoiceId : null, securityDepositId: source.sourceType === "SECURITY_DEPOSIT_REFUND" ? source.securityDepositId : null,
        bookingId: source.bookingId, customerId: source.customerId, status: "DRAFT", amountCents: checked.amountCents, method: checked.method, methodDescription: checked.methodDescription,
        executedAt, plannedAt: opts.complete ? null : executedAt, recipientName: checked.recipientName, recipientDeviates: checked.recipientDeviates, recipientReason: checked.recipientReason,
        iban: checked.iban, ibanMasked: checked.ibanMasked, reference: checked.reference, receiptConfirmed: checked.receiptConfirmed, historicalEntry: checked.historicalEntry, customerNote: checked.customerNote, internalNote: checked.internalNote,
        idempotencyKey: key, createdById: actor.id, createdByName: actor.name,
      },
    });
    await recordAudit(tx, tenantId, actor, { action: "PAYOUT_DRAFT_CREATED", bookingId: draft.bookingId, invoiceId: draft.invoiceId, depositId: draft.securityDepositId, amountCents: draft.amountCents, details: auditDetails(draft, { remainingBefore: source.remainingCents }) });
    if (!opts.complete) return { payout: draft, created: true };
    return { payout: await completeInTx(tx, tenantId, actor, draft.id, now), created: true };
  }, TX);
  try {
    return await withNumberRetry(run);
  } catch (e) {
    if (key && isUniqueViolation(e, "idempotencyKey")) {
      const winner = await db.payout.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (winner) return { payout: winner, created: false };
    }
    if (isUniqueViolation(e, "number")) throw new DomainError("Die Auszahlungsnummer konnte nicht vergeben werden. Bitte erneut versuchen.");
    return domainFromDb(e);
  }
}

/** Entwurf ändern (nur DRAFT). Abgeschlossene Auszahlungen sind unveränderlich. */
export async function updatePayoutDraft(tenantId: string, actor: Actor, payoutId: string, input: PayoutInput): Promise<PayoutRow> {
  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Payout" WHERE "id" = ${payoutId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Auszahlung nicht gefunden.");
      const p = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
      if (p.status !== "DRAFT") throw new DomainError("Nur Entwürfe können geändert werden. Eine erfolgte Auszahlung wird bei Bedarf storniert und neu erfasst.");
      const source = await payoutSource(tx, tenantId, refOf(p));
      const checked = checkInput(input, source, false);
      const executedAt = checkExecutedAt(input.executedAt, false);
      const updated = await tx.payout.update({ where: { id: p.id }, data: { amountCents: checked.amountCents, method: checked.method, methodDescription: checked.methodDescription, executedAt, plannedAt: executedAt, recipientName: checked.recipientName, recipientDeviates: checked.recipientDeviates, recipientReason: checked.recipientReason, iban: checked.iban, ibanMasked: checked.ibanMasked, reference: checked.reference, receiptConfirmed: checked.receiptConfirmed, historicalEntry: checked.historicalEntry, customerNote: checked.customerNote, internalNote: checked.internalNote } });
      await recordAudit(tx, tenantId, actor, { action: "PAYOUT_UPDATED", bookingId: p.bookingId, invoiceId: p.invoiceId, depositId: p.securityDepositId, amountCents: updated.amountCents, details: auditDetails(updated, { amountBefore: p.amountCents }) });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Entwurf als tatsächlich erfolgt erfassen: Quelle sperren, Rest neu rechnen, Nummer, Snapshot, Prüfsumme. Doppelklick-sicher. */
export async function completePayout(tenantId: string, actor: Actor, payoutId: string, opts: { confirmed: boolean; executedAt?: Date | null }): Promise<PayoutRow> {
  if (!opts.confirmed) throw new DomainError("Bitte bestätigen, dass die Auszahlung tatsächlich erfolgt ist.");
  try {
    return await withNumberRetry(() => db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Payout" WHERE "id" = ${payoutId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Auszahlung nicht gefunden.");
      if (opts.executedAt !== undefined) {
        const p = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
        if (p.status === "DRAFT") await tx.payout.update({ where: { id: payoutId }, data: { executedAt: checkExecutedAt(opts.executedAt, true) } });
      }
      return completeInTx(tx, tenantId, actor, payoutId, new Date());
    }, TX));
  } catch (e) {
    return domainFromDb(e);
  }
}

/**
 * Storno mit Pflichtgrund: Entwurf aufheben oder eine erfolgte Auszahlung als Fehlbuchung kennzeichnen. Die Zeile bleibt
 * vollständig sichtbar (Nummer, Betrag, Beleg); sie zählt finanziell nicht mehr, der Rest steht wieder zur Verfügung.
 */
export async function cancelPayout(tenantId: string, actor: Actor, payoutId: string, reason: string): Promise<PayoutRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund des Stornos angeben.");
  try {
    return await db.$transaction(async (tx) => {
      const p0 = await tx.payout.findFirst({ where: { id: payoutId, tenantId } });
      if (!p0) throw new DomainError("Auszahlung nicht gefunden.");
      // Sperrreihenfolge wie beim Abschluss: erst die Quelle, dann die Auszahlung
      await lockSource(tx, tenantId, refOf(p0));
      await tx.$queryRaw`SELECT "id" FROM "Payout" WHERE "id" = ${payoutId} FOR UPDATE`;
      const p = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
      if (p.status === "CANCELLED") throw new DomainError("Diese Auszahlung ist bereits storniert.");
      const now = new Date();
      const updated = await tx.payout.update({ where: { id: p.id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id, cancelledByName: actor.name, cancellationReason: why } });
      await recordAudit(tx, tenantId, actor, { action: "PAYOUT_CANCELLED", bookingId: p.bookingId, invoiceId: p.invoiceId, depositId: p.securityDepositId, amountCents: p.amountCents, details: auditDetails(updated, { reason: why, wasCompleted: p.status === "COMPLETED" }) });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Prüfsumme einer abgeschlossenen (oder stornierten, vorher abgeschlossenen) Auszahlung nachrechnen. */
export async function verifyPayout(tenantId: string, payoutId: string) {
  const p = await db.payout.findFirst({ where: { id: payoutId, tenantId } });
  if (!p || !p.contentHash) return { sealed: false, intact: false, storedHash: null as string | null, currentHash: null as string | null };
  const currentHash = contentHash(sealedPayoutContent(p));
  return { sealed: true, intact: p.contentHash === currentHash, storedHash: p.contentHash, currentHash };
}

// ---------------------------------------------------------------------------
// Nachweise (Upload) und Belege
// ---------------------------------------------------------------------------

export async function registerPayoutAttachment(tenantId: string, actor: Actor, payoutId: string, input: { fileName: string; storageKey: string; contentType: string; sizeBytes: number; checksum: string }) {
  return db.$transaction(async (tx) => {
    const p = await tx.payout.findFirst({ where: { id: payoutId, tenantId } });
    if (!p) throw new DomainError("Auszahlung nicht gefunden.");
    if (p.status === "CANCELLED") throw new DomainError("Zu einer stornierten Auszahlung werden keine Nachweise mehr hochgeladen.");
    const doc = await registerDocument(tx, tenantId, actor.id, { type: "PAYOUT_ATTACHMENT", bookingId: p.bookingId, payoutId: p.id, storageKey: input.storageKey, fileName: input.fileName.slice(0, 200), contentType: input.contentType, sizeBytes: input.sizeBytes, checksum: input.checksum });
    await recordAudit(tx, tenantId, actor, { action: "PAYOUT_DOCUMENT_UPLOADED", bookingId: p.bookingId, invoiceId: p.invoiceId, depositId: p.securityDepositId, details: { payoutId: p.id, number: p.number, documentId: doc.id, contentType: input.contentType, sizeBytes: input.sizeBytes } });
    return doc;
  }, TX);
}

// ---------------------------------------------------------------------------
// Ansichten, Listen, Kennzahlen
// ---------------------------------------------------------------------------

export type PayoutView = PayoutRow & { documents: { id: string; type: string; fileName: string; contentType: string; sizeBytes: number; checksum: string; createdAt: Date; version: number }[]; emails: { id: string; status: string; recipient: string; sentAt: Date | null; createdAt: Date; error: string | null; attemptNo: number; trigger: string }[]; booking: { id: string; number: string }; invoice: { id: string; number: string | null } | null; customer: { id: string; firstName: string; lastName: string; companyName: string | null; type: string } | null; sourceNow: PayoutSource | null };

export async function getPayout(tenantId: string, payoutId: string): Promise<PayoutView | null> {
  const p = await db.payout.findFirst({ where: { id: payoutId, tenantId }, include: { documents: { orderBy: [{ type: "asc" }, { createdAt: "asc" }], select: { id: true, type: true, fileName: true, contentType: true, sizeBytes: true, checksum: true, createdAt: true, version: true } }, emailLogs: { orderBy: { createdAt: "desc" }, select: { id: true, status: true, recipient: true, sentAt: true, createdAt: true, error: true, attemptNo: true, trigger: true } }, booking: { select: { id: true, number: true } }, invoice: { select: { id: true, number: true } }, customer: { select: { id: true, firstName: true, lastName: true, companyName: true, type: true } } } });
  if (!p) return null;
  const { emailLogs, ...rest } = p;
  let sourceNow: PayoutSource | null = null;
  try { sourceNow = await payoutSource(db, tenantId, refOf(p)); } catch { sourceNow = null; }
  return { ...rest, emails: emailLogs, sourceNow };
}

export type PayoutFilter = { status?: "offen" | "abgeschlossen" | "storniert" | "alle"; source?: "rechnung" | "kaution" | "alle"; method?: string | null; from?: Date | null; to?: Date | null; q?: string | null; customerId?: string | null };

export async function listPayouts(tenantId: string, f: PayoutFilter = {}) {
  const where: Prisma.PayoutWhereInput = { tenantId };
  if (f.status === "offen") where.status = "DRAFT";
  else if (f.status === "abgeschlossen") where.status = "COMPLETED";
  else if (f.status === "storniert") where.status = "CANCELLED";
  if (f.source === "rechnung") where.sourceType = "INVOICE_REFUND";
  else if (f.source === "kaution") where.sourceType = "SECURITY_DEPOSIT_REFUND";
  if (f.method && f.method in PAYOUT_METHODS) where.method = f.method;
  if (f.customerId) where.customerId = f.customerId;
  if (f.from || f.to) where.OR = [{ executedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } }, { executedAt: null, createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } }];
  if (f.q?.trim()) {
    const q = f.q.trim();
    where.AND = [{ OR: [{ number: { contains: q, mode: "insensitive" } }, { recipientName: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }, { invoice: { number: { contains: q, mode: "insensitive" } } }, { booking: { number: { contains: q, mode: "insensitive" } } }] }];
  }
  return db.payout.findMany({ where, orderBy: [{ createdAt: "desc" }], include: { booking: { select: { id: true, number: true } }, invoice: { select: { id: true, number: true } }, customer: { select: { id: true, firstName: true, lastName: true, companyName: true, type: true } } }, take: 500 });
}

export type OpenClaim = { kind: "INVOICE" | "DEPOSIT"; bookingId: string; bookingNumber: string; invoiceId: string | null; number: string; customerName: string; remainingCents: Cents; draftCents: Cents; href: string };

/** Offene Ansprüche: Rechnungen mit noch auszuzahlendem Guthaben und Kautionen mit auszahlbarem Rest – auch ohne Entwurf. */
export async function openPayoutClaims(tenantId: string): Promise<{ invoices: OpenClaim[]; deposits: OpenClaim[] }> {
  const [invRows, depRows, drafts] = await Promise.all([
    db.invoice.findMany({ where: { tenantId, status: "FINALIZED", documentType: "INVOICE", currentVersionId: { not: null }, payments: { some: { status: "CONFIRMED" } } }, select: { id: true, number: true, bookingId: true, booking: { select: { number: true } }, currentVersion: { select: { grossTotal: true, customerSnapshot: true } } } }),
    db.securityDeposit.findMany({ where: { tenantId, events: { some: { type: "RELEASED", status: "CONFIRMED" } } }, select: { id: true, expectedAmountCents: true, bookingId: true, booking: { select: { number: true, contract: { select: { customerSnapshot: true } } } }, events: { select: { type: true, amountCents: true, status: true } } } }),
    db.payout.groupBy({ by: ["invoiceId", "securityDepositId"], where: { tenantId, status: "DRAFT" }, _sum: { amountCents: true } }),
  ]);
  const draftInv = new Map(drafts.filter((d) => d.invoiceId).map((d) => [d.invoiceId!, d._sum.amountCents ?? 0]));
  const draftDep = new Map(drafts.filter((d) => d.securityDepositId).map((d) => [d.securityDepositId!, d._sum.amountCents ?? 0]));
  const fin = await financialsFor(tenantId, invRows.map((i) => ({ id: i.id, grossTotal: i.currentVersion!.grossTotal })));
  const invoices: OpenClaim[] = invRows.filter((i) => (fin.get(i.id)?.refundRemainingCents ?? 0) > 0).map((i) => ({ kind: "INVOICE", bookingId: i.bookingId, bookingNumber: i.booking.number, invoiceId: i.id, number: i.number ?? "", customerName: nameOf(i.currentVersion!.customerSnapshot as Parameters<typeof nameOf>[0]), remainingCents: fin.get(i.id)!.refundRemainingCents, draftCents: draftInv.get(i.id) ?? 0, href: `/buchungen/${i.bookingId}/rechnung?nr=${i.id}` }));
  const depFin = new Map(depRows.map((d) => [d.id, computeDepositFinancials(balanceOf(d.expectedAmountCents, d.events), 0)]));
  const paidOut = depRows.length ? await db.payout.groupBy({ by: ["securityDepositId"], where: { tenantId, securityDepositId: { in: depRows.map((d) => d.id) }, status: "COMPLETED" }, _sum: { amountCents: true } }) : [];
  const paidMap = new Map(paidOut.map((g) => [g.securityDepositId, g._sum.amountCents ?? 0]));
  const deposits: OpenClaim[] = depRows.map((d) => ({ d, f: computeDepositFinancials(depFin.get(d.id)!, paidMap.get(d.id) ?? 0) })).filter(({ f }) => f.payoutRemainingCents > 0).map(({ d, f }) => ({ kind: "DEPOSIT", bookingId: d.bookingId, bookingNumber: d.booking.number, invoiceId: null, number: d.booking.number, customerName: nameOf(d.booking.contract?.customerSnapshot as Parameters<typeof nameOf>[0]), remainingCents: f.payoutRemainingCents, draftCents: draftDep.get(d.id) ?? 0, href: `/buchungen/${d.bookingId}#kaution` }));
  return { invoices, deposits };
}

/** Kennzahlen für das Dashboard: offene Rechnungserstattungen und Kautionsauszahlungen (Anzahl und Summe). */
export async function payoutCounts(tenantId: string) {
  const { invoices, deposits } = await openPayoutClaims(tenantId);
  return { invoiceRefunds: invoices.length, invoiceRefundCents: invoices.reduce((a, c) => a + c.remainingCents, 0), depositPayouts: deposits.length, depositPayoutCents: deposits.reduce((a, c) => a + c.remainingCents, 0) };
}

/** Auszahlungen einer Quelle für die Historie auf Rechnungs- und Kautionsseite. */
export function listSourcePayouts(tenantId: string, ref: { invoiceId?: string | null; securityDepositId?: string | null }) {
  return db.payout.findMany({ where: { tenantId, ...(ref.invoiceId ? { invoiceId: ref.invoiceId } : { securityDepositId: ref.securityDepositId ?? "" }) }, orderBy: [{ createdAt: "desc" }] });
}

export { invoiceFinancials };

// ---------------------------------------------------------------------------
// Auszahlungsbeleg per E-Mail: nur manuell, nur der archivierte Beleg, EmailLog mit Idempotenz je Bestätigung
// ---------------------------------------------------------------------------

export const PAYOUT_MAIL_TEMPLATE = "PAYOUT_RECEIPT";

export function composePayoutMail(f: { recipientName: string; number: string; amount: string; sourceLabel: string; referenceLine: string; landlordName: string; landlordContact: string; historicalEntry: boolean }) {
  const subject = `Auszahlungsbeleg ${f.number}`;
  const intro = `anbei erhalten Sie den Auszahlungsbeleg ${f.number} über ${f.amount} (${f.sourceLabel}: ${f.referenceLine}).`;
  const note = f.historicalEntry ? "Die Auszahlung wurde nachträglich dokumentiert; sie erfolgte bereits vor der Erfassung." : "Der Beleg dokumentiert, dass die Auszahlung bei uns als erfolgt erfasst wurde.";
  const lines = [`Guten Tag ${f.recipientName},`, "", intro, "", note, "", "Im Anhang:", "- Auszahlungsbeleg", "", "Bei Fragen melden Sie sich gern bei uns.", "", "Freundliche Grüße", f.landlordName, ...(f.landlordContact ? [f.landlordContact] : [])];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230"><p>Guten Tag ${esc(f.recipientName)},</p><p>${esc(intro)}</p><p>${esc(note)}</p><p>Im Anhang:</p><ul><li>Auszahlungsbeleg</li></ul><p>Bei Fragen melden Sie sich gern bei uns.</p><p>Freundliche Grüße<br>${esc(f.landlordName)}${f.landlordContact ? `<br><span style="color:#4a5568">${esc(f.landlordContact)}</span>` : ""}</p></div>`;
  return { subject, text: lines.join("\n"), html };
}

export type PayoutSendOptions = { actorId?: string | null; nonce: string; transport?: MailTransport; storage?: StorageDriver };
export type PayoutSendResult = { status: "SENT" | "FAILED" | "DUPLICATE"; log: EmailLogRow };

/** Versendet den archivierten Auszahlungsbeleg an die E-Mail-Adresse aus dem Quellen-Snapshot. Derselbe nonce sendet nie zweimal. */
export async function sendPayoutReceipt(tenantId: string, actor: Actor | null, payoutId: string, opts: PayoutSendOptions): Promise<PayoutSendResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(opts.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const data = await loadPayoutDocumentData(tenantId, payoutId);
  const p = await db.payout.findFirstOrThrow({ where: { id: payoutId, tenantId } });
  if (p.status !== "COMPLETED") throw new DomainError("Ein Auszahlungsbeleg wird nur für erfolgte Auszahlungen versendet.");
  const doc = await db.document.findFirst({ where: { tenantId, type: "PAYOUT_RECEIPT", payoutId }, orderBy: { version: "desc" } });
  if (!doc) throw new DomainError("Es fehlt noch: Auszahlungsbeleg. Bitte zuerst das PDF erzeugen.");
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, phone: true, email: true } });
  const mail = composePayoutMail({ recipientName: data.doc.recipientName, number: data.doc.number, amount: data.doc.amount, sourceLabel: data.doc.sourceLabel, referenceLine: data.doc.referenceLine, landlordName: tenant.name, landlordContact: [tenant.phone, tenant.email].filter(Boolean).join(" · "), historicalEntry: data.doc.historicalEntry });
  const recipient = data.recipientEmail;
  const { log, created } = await claimEmail({ tenantId, bookingId: p.bookingId, invoiceId: p.invoiceId, payoutId: p.id, recipient: recipient ?? "(keine Adresse)", subject: mail.subject, template: PAYOUT_MAIL_TEMPLATE, attachments: [{ documentId: doc.id, fileName: doc.fileName, checksum: doc.checksum, version: doc.version, type: doc.type }], trigger: "MANUAL", createdById: actor?.id ?? null, idempotencyKey: `${PAYOUT_MAIL_TEMPLATE}:${p.id}:${doc.id}v${doc.version}:manual:${opts.nonce}` });
  if (!created) return { status: "DUPLICATE", log };
  const finish = async (status: "SENT" | "FAILED") => ({ status, log: (await db.emailLog.findFirst({ where: { id: log.id, tenantId } })) ?? log });
  try {
    if (!isValidEmail(recipient)) throw new DomainError("Zum Empfänger ist keine gültige E-Mail-Adresse hinterlegt");
    const file = await readDocumentFile(tenantId, doc.id, opts.storage);
    if (!file) throw new DomainError("Der Auszahlungsbeleg wurde im Archiv nicht gefunden");
    const transport = opts.transport ?? getMailTransport();
    const result = await transport.send({ to: recipient.trim(), subject: mail.subject, text: mail.text, html: mail.html, fromName: tenant.name, replyTo: tenant.email, attachments: [{ filename: doc.fileName, content: file.body, contentType: doc.contentType }] });
    await markEmailSent(tenantId, log.id, result.messageId);
    await db.$transaction((tx) => recordAudit(tx, tenantId, actor, { action: "PAYOUT_EMAIL_SENT", bookingId: p.bookingId, invoiceId: p.invoiceId, depositId: p.securityDepositId, details: { payoutId: p.id, number: p.number, emailLogId: log.id } }));
    return finish("SENT");
  } catch (e) {
    const message = e instanceof Error && e.constructor.name === "DocumentIntegrityError" ? "Der Beleg konnte nicht unverändert aus dem Archiv gelesen werden" : safeMailError(e);
    await markEmailFailed(tenantId, log.id, message);
    return finish("FAILED");
  }
}

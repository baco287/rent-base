// Befehl 23: Mahnwesen und Forderungsmanagement.
//
// Grundsätze
// - Keine zweite Finanzlogik: offene Forderung = financialsFor/invoiceFinancials (lib/counter-documents.ts), dieselbe
//   Summierung wie Rechnungsseite, Rechnungsliste, Dashboard und Auszahlungen. Zahlungen, Kautionsverrechnungen,
//   Gutschriften, Stornobelege, Rückführungen und Erstattungen wirken dort – das Mahnwesen liest nur.
// - Fälligkeit = versiegeltes Zahlungsziel der aktuellen Rechnungsfassung (InvoiceVersion.paymentDueDate). Ohne Fälligkeit
//   (Altbelege ohne Zahlungsziel) gibt es keine Mahnstufe; Rent-Base legt nichts rückwirkend fest.
// - Der Stand einer Forderung wird nie gespeichert, sondern aus Saldo, Fälligkeit und Mahnhistorie berechnet. Gespeichert
//   werden nur die bewusst erstellten Mahnschreiben (DunningNotice, unveränderlich) und ihre Übermittlung.
// - Nichts geschieht automatisch: kein Cronjob, keine Mail ohne Klick, keine Eskalation, keine Kautionsverrechnung, keine
//   Verzugszinsen. Stufen laufen nacheinander (Zahlungserinnerung → 1. Mahnung → 2. Mahnung → weitere Bearbeitung).
// - Mahngebühr = eigene Gebührenrechnung (kind DUNNING_FEE) und damit echte Forderung; die gemahnte Rechnung bleibt
//   unverändert. Zahlungen werden wie immer einer konkreten Rechnung zugeordnet – es gibt keine Tilgungsreihenfolge.
// - Sperren: Rechnung FOR UPDATE (dieselbe Sperre wie Zahlung, Kautionsverrechnung, Gegenbeleg, Auszahlung, Rückführung);
//   der erwartete Betrag der Vorschau wird unter der Sperre erneut geprüft. Eindeutigkeit je Stufe sichert der DB-Index.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DUNNING_LEVELS, dunningLevelLabel, RECEIVABLE_STATUS, type DunningLevel, type ReceivableStatus } from "@/lib/constants";
import { financialsFor, type InvoiceFinancials } from "@/lib/counter-documents";
import { DomainError, contentHash } from "@/lib/integrity";
import { ACCIDENT_BILLING_WHERE, assertAccidentInvoiceCaseOpen } from "@/lib/accident-replacement-events";
import { companySnapshotOf, createDunningFeeInvoiceDraft, finalizeInvoiceIn, recipientRoleOf, type CompanySnapshot, type InvoiceCustomerSnapshot } from "@/lib/invoices";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation, nextDunningNumber, withNumberRetry } from "@/lib/numbering";
import { customerSearchWhere } from "@/lib/search";
import { zonedDayStart, zonedDaysBetween } from "@/lib/time";

type Client = Prisma.TransactionClient | typeof db;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Einstellungen (Einstellungen → Geschäftsregeln → Mahnwesen)
// ---------------------------------------------------------------------------

export type DunningSettings = {
  paymentTermDays: number | null; // Standard-Zahlungsziel neuer Rechnungen (bestehende Einstellung Tenant.paymentTermDays)
  reminderDays: number;
  firstDays: number;
  secondDays: number;
  feesEnabled: boolean;
  firstFeeCents: Cents;
  secondFeeCents: Cents;
};

export const DUNNING_LIMITS = { minDays: 1, maxDays: 60, maxFeeCents: 10_000, maxPaymentTermDays: 365 } as const;

export function dunningSettingsOf(t: { paymentTermDays: number | null; dunningReminderDays: number; dunningFirstDays: number; dunningSecondDays: number; dunningFeesEnabled: boolean; dunningFirstFeeCents: number; dunningSecondFeeCents: number }): DunningSettings {
  return { paymentTermDays: t.paymentTermDays, reminderDays: t.dunningReminderDays, firstDays: t.dunningFirstDays, secondDays: t.dunningSecondDays, feesEnabled: t.dunningFeesEnabled, firstFeeCents: t.dunningFirstFeeCents, secondFeeCents: t.dunningSecondFeeCents };
}

/** Gebühr einer Stufe laut Einstellung: Zahlungserinnerung nie, 1./2. Mahnung nur bei eingeschalteten Gebühren. */
export function feeForLevel(s: Pick<DunningSettings, "feesEnabled" | "firstFeeCents" | "secondFeeCents">, level: DunningLevel): Cents {
  if (level === 1 || !s.feesEnabled) return 0;
  return level === 2 ? s.firstFeeCents : s.secondFeeCents;
}

export function deadlineDaysFor(s: Pick<DunningSettings, "reminderDays" | "firstDays" | "secondDays">, level: DunningLevel): number {
  return level === 1 ? s.reminderDays : level === 2 ? s.firstDays : s.secondDays;
}

/** Eingaben prüfen (serverseitig): Fristen 1–60 Tage, Gebühren 0–100 € in Cent, Zahlungsziel 0–365 Tage oder leer. */
export function validateDunningSettings(input: { paymentTermDays: number | null; reminderDays: number; firstDays: number; secondDays: number; feesEnabled: boolean; firstFeeCents: number; secondFeeCents: number }): DunningSettings {
  const days = (v: number, label: string) => {
    if (!Number.isInteger(v) || v < DUNNING_LIMITS.minDays || v > DUNNING_LIMITS.maxDays) throw new DomainError(`${label}: bitte ganze Tage zwischen ${DUNNING_LIMITS.minDays} und ${DUNNING_LIMITS.maxDays}.`);
    return v;
  };
  const fee = (v: number, label: string) => {
    if (!Number.isInteger(v) || v < 0 || v > DUNNING_LIMITS.maxFeeCents) throw new DomainError(`${label}: bitte einen Betrag zwischen 0,00 € und ${fmtCents(DUNNING_LIMITS.maxFeeCents)}.`);
    return v;
  };
  if (input.paymentTermDays != null && !(Number.isInteger(input.paymentTermDays) && input.paymentTermDays >= 0 && input.paymentTermDays <= DUNNING_LIMITS.maxPaymentTermDays)) throw new DomainError("Das Standard-Zahlungsziel liegt zwischen 0 und 365 Tagen (leer = kein Zahlungsziel).");
  return {
    paymentTermDays: input.paymentTermDays,
    reminderDays: days(input.reminderDays, "Frist der Zahlungserinnerung"),
    firstDays: days(input.firstDays, "Frist der 1. Mahnung"),
    secondDays: days(input.secondDays, "Frist der 2. Mahnung"),
    feesEnabled: !!input.feesEnabled,
    firstFeeCents: fee(input.firstFeeCents, "Gebühr der 1. Mahnung"),
    secondFeeCents: fee(input.secondFeeCents, "Gebühr der 2. Mahnung"),
  };
}

/** Speichert die Mahnwesen-Einstellungen. Wirkt nur auf künftige Rechnungen und Mahnschreiben. */
export async function updateDunningSettings(tenantId: string, actor: Actor, input: Parameters<typeof validateDunningSettings>[0]): Promise<DunningSettings> {
  const next = validateDunningSettings(input);
  return db.$transaction(async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const before = dunningSettingsOf(t);
    await tx.tenant.update({ where: { id: tenantId }, data: { paymentTermDays: next.paymentTermDays, dunningReminderDays: next.reminderDays, dunningFirstDays: next.firstDays, dunningSecondDays: next.secondDays, dunningFeesEnabled: next.feesEnabled, dunningFirstFeeCents: next.firstFeeCents, dunningSecondFeeCents: next.secondFeeCents } });
    const changed = (Object.keys(next) as (keyof DunningSettings)[]).filter((k) => before[k] !== next[k]);
    if (changed.length > 0) await recordAudit(tx, tenantId, actor, { action: "DUNNING_SETTINGS_UPDATED", details: { changed: changed.join(", "), before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])) } });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Forderungsstand (abgeleitet)
// ---------------------------------------------------------------------------

export type ReceivableNotice = {
  id: string; level: DunningLevel; label: string; number: string; issuedAt: Date; deadlineAt: Date; deadlineDays: number;
  principalOpenCents: Cents; priorFeesOpenCents: Cents; feeCents: Cents; totalCents: Cents; feeInvoiceId: string | null; feeInvoiceNumber: string | null;
  recipientName: string; recipientEmail: string | null; createdByName: string | null;
  /** erste Übermittlung: erfolgreicher E-Mail-Versand oder manueller Vermerk (Post/persönlich) */
  deliveredAt: Date | null; delivered: boolean; sentAt: Date | null; sentTo: string | null; sendCount: number; manualDeliveredAt: Date | null; manualDeliveredByName: string | null; manualDeliveredNote: string | null;
};

export type FeeClaim = { invoiceId: string; number: string | null; noticeNumber: string; level: DunningLevel; grossCents: Cents; openCents: Cents };

export type NextStep =
  | { kind: "NONE"; label: string }
  | { kind: "NO_DUE_DATE"; label: string }
  | { kind: "WAIT_DUE"; label: string; until: Date }
  | { kind: "CREATE"; label: string; level: DunningLevel }
  | { kind: "DELIVER"; label: string; level: DunningLevel; noticeId: string }
  | { kind: "WAIT_DEADLINE"; label: string; level: DunningLevel; until: Date }
  | { kind: "FURTHER_ACTION"; label: string };

export type Receivable = {
  invoiceId: string; number: string | null; kind: string; bookingId: string | null; bookingNumber: string | null; customerId: string | null; customerName: string; customerNumber: string | null;
  issueDate: Date | null; dueDate: Date | null; invoiceCents: Cents;
  financials: InvoiceFinancials;
  /** offene Forderung der Rechnung (zentrale Summierung, nie negativ) */
  principalOpenCents: Cents;
  feeClaims: FeeClaim[];
  feesOpenCents: Cents;
  totalOpenCents: Cents;
  notices: ReceivableNotice[];
  status: ReceivableStatus;
  statusLabel: string;
  daysOverdue: number;
  next: NextStep;
};

export type DeriveInput = { principalOpenCents: Cents; feesOpenCents: Cents; dueDate: Date | null; notices: Pick<ReceivableNotice, "id" | "level" | "delivered" | "deadlineAt">[] };

/** Reine Ableitung von Status und nächstem Schritt. Tage sind Kalendertage in Europe/Berlin; fällig am Tag X = überfällig ab X+1. */
export function deriveReceivable(input: DeriveInput, now: Date): { status: ReceivableStatus; daysOverdue: number; next: NextStep } {
  const today = zonedDayStart(now);
  const total = input.principalOpenCents + input.feesOpenCents;
  const daysOverdue = input.dueDate && input.dueDate < today ? Math.max(0, zonedDaysBetween(input.dueDate, now)) : 0;
  if (total <= 0) return { status: "SETTLED", daysOverdue: 0, next: { kind: "NONE", label: input.notices.length > 0 ? "Forderung erledigt" : "Nichts offen" } };
  const last = [...input.notices].sort((a, b) => b.level - a.level)[0];
  if (!last) {
    if (!input.dueDate) return { status: "NO_DUE_DATE", daysOverdue: 0, next: { kind: "NO_DUE_DATE", label: "Keine Fälligkeit hinterlegt – keine Mahnstufe" } };
    if (input.dueDate >= today) return { status: "NOT_DUE", daysOverdue: 0, next: { kind: "WAIT_DUE", label: "Noch nicht fällig", until: input.dueDate } };
    return { status: "OVERDUE", daysOverdue, next: { kind: "CREATE", level: 1, label: "Zahlungserinnerung erstellen" } };
  }
  const level = last.level as DunningLevel;
  if (!last.delivered) {
    const status: ReceivableStatus = level === 1 ? "REMINDER_OPEN" : level === 2 ? "FIRST_OPEN" : "SECOND_OPEN";
    return { status, daysOverdue, next: { kind: "DELIVER", level, noticeId: last.id, label: `${dunningLevelLabel(level)} versenden oder Übermittlung vermerken` } };
  }
  const deadlinePassed = last.deadlineAt < today;
  if (level === 3) return deadlinePassed ? { status: "FURTHER_ACTION", daysOverdue, next: { kind: "FURTHER_ACTION", label: "Weitere Bearbeitung erforderlich (Rent-Base leitet nichts automatisch ein)" } } : { status: "SECOND_SENT", daysOverdue, next: { kind: "WAIT_DEADLINE", level, until: last.deadlineAt, label: "Frist der 2. Mahnung läuft" } };
  const status: ReceivableStatus = level === 1 ? "REMINDER_SENT" : "FIRST_SENT";
  if (!deadlinePassed) return { status, daysOverdue, next: { kind: "WAIT_DEADLINE", level, until: last.deadlineAt, label: `Frist der ${dunningLevelLabel(level)} läuft` } };
  const nextLevel = (level + 1) as DunningLevel;
  return { status, daysOverdue, next: { kind: "CREATE", level: nextLevel, label: `${dunningLevelLabel(nextLevel)} erstellen` } };
}

const personName = (c: Partial<InvoiceCustomerSnapshot> | null | undefined) => {
  if (!c) return "–";
  const person = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  return c.type === "COMPANY" && c.companyName ? (person ? `${c.companyName}, ${person}` : c.companyName) : person || "–";
};

const mainSelect = {
  id: true, number: true, kind: true, bookingId: true, customerId: true, contractId: true,
  booking: { select: { number: true } },
  currentVersion: { select: { id: true, versionNo: true, issueDate: true, paymentDueDate: true, grossTotal: true, customerSnapshot: true } },
} satisfies Prisma.InvoiceSelect;
type MainRow = Prisma.InvoiceGetPayload<{ select: typeof mainSelect }>;

/** Gemahnt werden können nur abgeschlossene Rechnungen (keine Gegenbelege, keine Gebührenrechnungen). */
const mainWhere = (tenantId: string): Prisma.InvoiceWhereInput => ({ tenantId, status: "FINALIZED", documentType: "INVOICE", kind: { not: "DUNNING_FEE" }, currentVersionId: { not: null } });

/** Forderungsstand für mehrere Rechnungen: 5 Abfragen unabhängig von der Anzahl (kein N+1). */
async function buildReceivables(client: Client, tenantId: string, rows: MainRow[], now: Date): Promise<Receivable[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const notices = await client.dunningNotice.findMany({ where: { tenantId, invoiceId: { in: ids } }, orderBy: [{ level: "asc" }] });
  const feeIds = notices.map((n) => n.feeInvoiceId).filter((x): x is string => !!x);
  const [feeRows, sent] = await Promise.all([
    feeIds.length ? client.invoice.findMany({ where: { tenantId, id: { in: feeIds } }, select: { id: true, number: true, currentVersion: { select: { grossTotal: true } } } }) : Promise.resolve([]),
    notices.length ? client.emailLog.findMany({ where: { tenantId, dunningNoticeId: { in: notices.map((n) => n.id) }, status: "SENT" }, orderBy: { sentAt: "asc" }, select: { dunningNoticeId: true, sentAt: true, recipient: true } }) : Promise.resolve([]),
  ]);
  const fin = await financialsFor(tenantId, [...rows.map((r) => ({ id: r.id, grossTotal: r.currentVersion!.grossTotal })), ...feeRows.map((f) => ({ id: f.id, grossTotal: f.currentVersion?.grossTotal ?? 0 }))], client);
  const feeById = new Map(feeRows.map((f) => [f.id, f]));
  const sentBy = new Map<string, { at: Date | null; to: string }[]>();
  for (const s of sent) if (s.dunningNoticeId) sentBy.set(s.dunningNoticeId, [...(sentBy.get(s.dunningNoticeId) ?? []), { at: s.sentAt, to: s.recipient }]);
  const byInvoice = new Map<string, typeof notices>();
  for (const n of notices) byInvoice.set(n.invoiceId, [...(byInvoice.get(n.invoiceId) ?? []), n]);

  return rows.map((r) => {
    const f = fin.get(r.id)!;
    const ns: ReceivableNotice[] = (byInvoice.get(r.id) ?? []).map((n) => {
      const mails = sentBy.get(n.id) ?? [];
      const sentAt = mails[0]?.at ?? null;
      const deliveredAt = [sentAt, n.deliveredAt].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      const fee = n.feeInvoiceId ? feeById.get(n.feeInvoiceId) : null;
      return {
        id: n.id, level: n.level as DunningLevel, label: dunningLevelLabel(n.level), number: n.number, issuedAt: n.issuedAt, deadlineAt: n.deadlineAt, deadlineDays: n.deadlineDays,
        principalOpenCents: n.principalOpenCents, priorFeesOpenCents: n.priorFeesOpenCents, feeCents: n.feeCents, totalCents: n.totalCents, feeInvoiceId: n.feeInvoiceId, feeInvoiceNumber: fee?.number ?? null,
        recipientName: n.recipientName, recipientEmail: n.recipientEmail, createdByName: n.createdByName,
        deliveredAt, delivered: !!deliveredAt, sentAt, sentTo: mails[0]?.to ?? null, sendCount: mails.length, manualDeliveredAt: n.deliveredAt, manualDeliveredByName: n.deliveredByName, manualDeliveredNote: n.deliveredNote,
      };
    });
    const feeClaims: FeeClaim[] = ns.filter((n) => n.feeInvoiceId).map((n) => {
      const ff = fin.get(n.feeInvoiceId!);
      return { invoiceId: n.feeInvoiceId!, number: n.feeInvoiceNumber, noticeNumber: n.number, level: n.level, grossCents: ff?.effectiveCents ?? n.feeCents, openCents: ff?.openCents ?? 0 };
    });
    const feesOpenCents = feeClaims.reduce((s, c) => s + c.openCents, 0);
    const c = r.currentVersion!.customerSnapshot as Partial<InvoiceCustomerSnapshot>;
    const d = deriveReceivable({ principalOpenCents: f.openCents, feesOpenCents, dueDate: r.currentVersion!.paymentDueDate, notices: ns }, now);
    return {
      invoiceId: r.id, number: r.number, kind: r.kind, bookingId: r.bookingId, bookingNumber: r.booking?.number ?? null, customerId: r.customerId, customerName: personName(c), customerNumber: c?.number ?? null,
      issueDate: r.currentVersion!.issueDate, dueDate: r.currentVersion!.paymentDueDate, invoiceCents: toCents(r.currentVersion!.grossTotal),
      financials: f, principalOpenCents: f.openCents, feeClaims, feesOpenCents, totalOpenCents: f.openCents + feesOpenCents,
      notices: ns, status: d.status, statusLabel: RECEIVABLE_STATUS[d.status], daysOverdue: d.daysOverdue, next: d.next,
    };
  });
}

/** Forderungsstand einer Rechnung (auch für Gebührenrechnungen: dann null). Mandant wird immer geprüft. */
export async function receivableOf(tenantId: string, invoiceId: string, opts: { now?: Date; client?: Client } = {}): Promise<Receivable | null> {
  const client = opts.client ?? db;
  const row = await client.invoice.findFirst({ where: { ...mainWhere(tenantId), id: invoiceId }, select: mainSelect });
  if (!row) return null;
  return (await buildReceivables(client, tenantId, [row], opts.now ?? new Date()))[0];
}

export const RECEIVABLE_FILTERS = {
  offen: "Alle offenen",
  ueberfaellig: "Überfällig",
  erinnerung: "Zahlungserinnerung",
  mahnung1: "1. Mahnung",
  mahnung2: "2. Mahnung",
  weitere: "Weitere Bearbeitung",
  ohne_faelligkeit: "Ohne Fälligkeit",
  erledigt: "Erledigt (mit Mahnhistorie)",
} as const;
export type ReceivableFilter = keyof typeof RECEIVABLE_FILTERS;
export const RECEIVABLE_SORTS = { faelligkeit: "Fälligkeit (älteste zuerst)", betrag: "Restforderung (höchste zuerst)", kunde: "Kunde", stufe: "Mahnstufe (höchste zuerst)" } as const;
export type ReceivableSort = keyof typeof RECEIVABLE_SORTS;

const FILTER_MATCH: Record<ReceivableFilter, (r: Receivable) => boolean> = {
  offen: (r) => r.totalOpenCents > 0,
  ueberfaellig: (r) => r.totalOpenCents > 0 && r.daysOverdue > 0,
  erinnerung: (r) => r.status === "REMINDER_OPEN" || r.status === "REMINDER_SENT",
  mahnung1: (r) => r.status === "FIRST_OPEN" || r.status === "FIRST_SENT",
  mahnung2: (r) => r.status === "SECOND_OPEN" || r.status === "SECOND_SENT",
  weitere: (r) => r.status === "FURTHER_ACTION",
  ohne_faelligkeit: (r) => r.status === "NO_DUE_DATE",
  erledigt: (r) => r.status === "SETTLED" && r.notices.length > 0,
};
const levelOf = (r: Receivable) => r.notices.reduce((m, n) => Math.max(m, n.level), 0);

export type ReceivableList = { rows: Receivable[]; total: number; page: number; pages: number; sums: { openCents: Cents; overdueCents: Cents } };

/**
 * Forderungsübersicht: serverseitig gesucht, gefiltert, sortiert und seitenweise. Die Suche (Kunde, Kundennummer,
 * Rechnungs- und Buchungsnummer) läuft in der Datenbank; der Status wird aus der zentralen Summierung abgeleitet.
 */
export async function listReceivables(tenantId: string, opts: { filter?: ReceivableFilter; q?: string; sort?: ReceivableSort; page?: number; pageSize?: number; now?: Date; /** Befehl 29 Phase F: Hof-Sicht ohne Unfallersatz-Abrechnung */ hideAccidentBilling?: boolean } = {}): Promise<ReceivableList> {
  const now = opts.now ?? new Date();
  const q = (opts.q ?? "").trim().slice(0, 100);
  const where: Prisma.InvoiceWhereInput = { ...mainWhere(tenantId), ...(opts.hideAccidentBilling ? { NOT: ACCIDENT_BILLING_WHERE } : {}) };
  if (q) where.OR = [{ number: { contains: q, mode: "insensitive" } }, { booking: { number: { contains: q, mode: "insensitive" } } }, { customer: await customerSearchWhere(tenantId, q) }];
  const rows = await db.invoice.findMany({ where, select: mainSelect, orderBy: { finalizedAt: "asc" } });
  const all = await buildReceivables(db, tenantId, rows, now);
  const filter = opts.filter && opts.filter in FILTER_MATCH ? opts.filter : "offen";
  const matched = all.filter(FILTER_MATCH[filter]);
  const sort = opts.sort && opts.sort in RECEIVABLE_SORTS ? opts.sort : "faelligkeit";
  const dueKey = (r: Receivable) => r.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  matched.sort(sort === "betrag" ? (a, b) => b.totalOpenCents - a.totalOpenCents || dueKey(a) - dueKey(b)
    : sort === "kunde" ? (a, b) => a.customerName.localeCompare(b.customerName, "de") || dueKey(a) - dueKey(b)
    : sort === "stufe" ? (a, b) => levelOf(b) - levelOf(a) || dueKey(a) - dueKey(b)
    : (a, b) => dueKey(a) - dueKey(b) || b.totalOpenCents - a.totalOpenCents);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 10), 200);
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const open = all.filter((r) => r.totalOpenCents > 0);
  return { rows: matched.slice((page - 1) * pageSize, page * pageSize), total: matched.length, page, pages, sums: { openCents: open.reduce((s, r) => s + r.totalOpenCents, 0), overdueCents: open.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.totalOpenCents, 0) } };
}

export type ReceivableSummary = {
  openCents: Cents; overdueCents: Cents; open: number; overdue: number; reminder: number; first: number; second: number; further: number; noDueDate: number;
  /** nächster möglicher Schritt je Rechnung (Erstellen oder Versand offen) */
  actionable: { invoiceId: string; bookingId: string | null; kind: string; number: string | null; customerName: string; next: NextStep; totalOpenCents: Cents; daysOverdue: number }[];
};

/** Kennzahlen für Dashboard und „Heute“ – dieselbe Ableitung wie die Forderungsübersicht. */
export async function receivablesSummary(tenantId: string, now = new Date(), opts: { /** Praxistest: Hof-Sicht ohne Unfallersatz-Abrechnung (wie listReceivables) */ hideAccidentBilling?: boolean } = {}): Promise<ReceivableSummary> {
  const rows = await db.invoice.findMany({ where: { ...mainWhere(tenantId), ...(opts.hideAccidentBilling ? { NOT: ACCIDENT_BILLING_WHERE } : {}) }, select: mainSelect });
  const all = (await buildReceivables(db, tenantId, rows, now)).filter((r) => r.totalOpenCents > 0);
  const count = (fn: (r: Receivable) => boolean) => all.filter(fn).length;
  return {
    openCents: all.reduce((s, r) => s + r.totalOpenCents, 0),
    overdueCents: all.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.totalOpenCents, 0),
    open: all.length,
    overdue: count((r) => r.daysOverdue > 0),
    reminder: count(FILTER_MATCH.erinnerung),
    first: count(FILTER_MATCH.mahnung1),
    second: count(FILTER_MATCH.mahnung2),
    further: count(FILTER_MATCH.weitere),
    noDueDate: count(FILTER_MATCH.ohne_faelligkeit),
    actionable: all.filter((r) => r.next.kind === "CREATE" || r.next.kind === "DELIVER").map((r) => ({ invoiceId: r.invoiceId, bookingId: r.bookingId, kind: r.kind, number: r.number, customerName: r.customerName, next: r.next, totalOpenCents: r.totalOpenCents, daysOverdue: r.daysOverdue })),
  };
}

// ---------------------------------------------------------------------------
// Vorschau und Erstellen
// ---------------------------------------------------------------------------

export type DunningPlan = {
  invoiceId: string; invoiceNumber: string | null; level: DunningLevel; levelLabel: string;
  allowed: boolean; reason: string | null;
  principalOpenCents: Cents; priorFeesOpenCents: Cents; feeCents: Cents; totalCents: Cents;
  deadlineDays: number; deadlineAt: Date; recipientName: string; recipientEmail: string | null;
  dueDate: Date | null; daysOverdue: number;
};

async function recipientOf(client: Client, tenantId: string, row: MainRow): Promise<{ name: string; email: string | null }> {
  const c = row.currentVersion!.customerSnapshot as Partial<InvoiceCustomerSnapshot>;
  let email = typeof c?.email === "string" && c.email.trim() ? c.email.trim() : null;
  // wie beim Rechnungsversand: Adresse aus der Rechnungskopie, sonst aus dem Mietvertrag (nie aus später geänderten Stammdaten).
  // Befehl 29: Ist der Empfänger nicht der Mieter (Versicherung, anderer Empfänger), gibt es keinen Rückgriff auf die
  // Vertragsadresse – eine Mahnung an die Versicherung darf nie versehentlich den Mieter erreichen.
  if (!email && row.contractId && recipientRoleOf(c) === "RENTER") {
    const k = await client.rentalContract.findFirst({ where: { id: row.contractId, tenantId }, select: { customerSnapshot: true } });
    const e = (k?.customerSnapshot as { email?: string | null } | null)?.email;
    email = typeof e === "string" && e.trim() ? e.trim() : null;
  }
  return { name: personName(c), email };
}

function planOf(r: Receivable, row: MainRow, settings: DunningSettings, recipient: { name: string; email: string | null }, now: Date, requested?: DunningLevel): DunningPlan {
  const next = r.next;
  const level: DunningLevel = requested ?? (next.kind === "CREATE" ? next.level : ((Math.min(3, r.notices.length + 1)) as DunningLevel));
  let reason: string | null = null;
  const existing = r.notices.find((n) => n.level === level);
  if (existing) reason = `Die ${dunningLevelLabel(level)} ${existing.number} wurde bereits erstellt.`;
  else if (r.financials.hasDraftCounter) reason = "Zu dieser Rechnung ist ein Gutschrift- oder Stornoentwurf offen. Bitte ihn zuerst abschließen oder verwerfen.";
  else if (r.totalOpenCents <= 0) reason = r.financials.customerCreditCents > 0 ? "Es besteht keine Forderung, sondern ein Kundenguthaben." : "Die Forderung ist vollständig ausgeglichen.";
  else if (next.kind === "NO_DUE_DATE") reason = "Die Rechnung hat kein Fälligkeitsdatum. Ohne Fälligkeit wird nicht gemahnt.";
  else if (next.kind === "WAIT_DUE") reason = "Die Rechnung ist noch nicht überfällig.";
  else if (next.kind === "DELIVER") reason = `Die ${dunningLevelLabel(next.level)} ist erstellt, aber noch nicht übermittelt. Bitte zuerst versenden oder die Übermittlung vermerken.`;
  else if (next.kind === "WAIT_DEADLINE") reason = `Die Frist der ${dunningLevelLabel(next.level)} läuft noch.`;
  else if (next.kind === "FURTHER_ACTION") reason = "Alle Mahnstufen sind ausgeschöpft. Weitere Schritte leitet Rent-Base nicht ein.";
  else if (next.kind === "CREATE" && next.level !== level) reason = `Mahnstufen werden nacheinander erstellt: als Nächstes ist die ${dunningLevelLabel(next.level)} möglich.`;
  const feeCents = feeForLevel(settings, level);
  const deadlineDays = deadlineDaysFor(settings, level);
  return {
    invoiceId: r.invoiceId, invoiceNumber: row.number, level, levelLabel: dunningLevelLabel(level), allowed: reason === null, reason,
    principalOpenCents: r.principalOpenCents, priorFeesOpenCents: r.feesOpenCents, feeCents, totalCents: r.principalOpenCents + r.feesOpenCents + feeCents,
    deadlineDays, deadlineAt: new Date(now.getTime() + deadlineDays * DAY), recipientName: recipient.name, recipientEmail: recipient.email,
    dueDate: r.dueDate, daysOverdue: r.daysOverdue,
  };
}

/** Vorschau der nächsten (oder einer bestimmten) Stufe – berechnet, nichts gespeichert. */
export async function previewDunning(tenantId: string, invoiceId: string, opts: { level?: DunningLevel; now?: Date } = {}): Promise<DunningPlan> {
  const now = opts.now ?? new Date();
  const row = await db.invoice.findFirst({ where: { ...mainWhere(tenantId), id: invoiceId }, select: mainSelect });
  if (!row) throw new DomainError("Rechnung nicht gefunden.");
  const [r] = await buildReceivables(db, tenantId, [row], now);
  const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  return planOf(r, row, dunningSettingsOf(t), await recipientOf(db, tenantId, row), now, opts.level);
}

export type DunningSnapshot = {
  v: 1; level: DunningLevel; levelLabel: string; number: string; issuedAt: string; deadlineAt: string; deadlineDays: number;
  company: CompanySnapshot; customer: Partial<InvoiceCustomerSnapshot>; recipient: { name: string; email: string | null };
  invoice: { id: string; number: string; kind: string; versionNo: number; issueDate: string | null; dueDate: string | null; grossCents: Cents };
  bookingNumber: string | null; contractNumber: string | null;
  balance: { invoiceCents: Cents; creditedCents: Cents; cancelledCents: Cents; effectiveCents: Cents; paidCents: Cents; offsetCents: Cents; openCents: Cents };
  priorNotices: { level: DunningLevel; number: string; issuedAt: string; totalCents: Cents }[];
  priorFees: { number: string | null; noticeNumber: string; grossCents: Cents; openCents: Cents }[];
  fee: { cents: Cents; invoiceNumber: string | null };
  principalOpenCents: Cents; priorFeesOpenCents: Cents; feeCents: Cents; totalCents: Cents;
  createdByName: string;
};

export type CreateDunningInput = { invoiceId: string; level: DunningLevel; expectedTotalCents: Cents; idempotencyKey: string };
export type CreateDunningResult = { notice: Prisma.DunningNoticeGetPayload<object>; created: boolean };

/**
 * Erstellt das Mahnschreiben der nächsten Stufe (und ggf. die Gebührenrechnung) in einer Transaktion unter der Sperre der
 * Rechnung. Der Server rechnet den Stand neu; weicht er von der Vorschau ab, wird nichts erstellt (neue Vorschau nötig).
 */
export async function createDunningNotice(tenantId: string, actor: Actor, input: CreateDunningInput, opts: { now?: Date } = {}): Promise<CreateDunningResult> {
  if (!(input.level in DUNNING_LEVELS)) throw new DomainError("Unbekannte Mahnstufe.");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.idempotencyKey ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  if (!Number.isInteger(input.expectedTotalCents) || input.expectedTotalCents <= 0) throw new DomainError("Bitte zuerst die Vorschau aufrufen.");
  const key = `dunning:${input.idempotencyKey}`;
  const existing = await db.dunningNotice.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
  if (existing) return { notice: existing, created: false };
  try {
    return await withNumberRetry(() => db.$transaction(async (tx) => {
      const now = opts.now ?? new Date();
      // Befehl 29 Phase F: keine neue Mahnung zu einer Rechnung eines geschlossenen Unfallersatzfalls
      await assertAccidentInvoiceCaseOpen(tx, tenantId, input.invoiceId);
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${input.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
      const dup = await tx.dunningNotice.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (dup) return { notice: dup, created: false };
      const row = await tx.invoice.findFirst({ where: { ...mainWhere(tenantId), id: input.invoiceId }, select: mainSelect });
      if (!row) throw new DomainError("Gemahnt werden nur abgeschlossene Rechnungen.");
      const [r] = await buildReceivables(tx, tenantId, [row], now);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const recipient = await recipientOf(tx, tenantId, row);
      const plan = planOf(r, row, dunningSettingsOf(tenant), recipient, now, input.level);
      if (!plan.allowed) throw new DomainError(plan.reason!);
      if (plan.totalCents !== input.expectedTotalCents) throw new DomainError(`Der Forderungsstand hat sich seit der Vorschau geändert (jetzt ${fmtCents(plan.totalCents)} statt ${fmtCents(input.expectedTotalCents)}). Es wurde nichts erstellt. Bitte die Vorschau neu laden.`);

      const number = await nextDunningNumber(tx, tenantId, now);
      let feeInvoiceId: string | null = null, feeInvoiceNumber: string | null = null;
      if (plan.feeCents > 0) {
        const draft = await createDunningFeeInvoiceDraft(tx, tenantId, actor, { invoiceId: row.id, invoiceNumber: row.number ?? "", levelLabel: plan.levelLabel, noticeNumber: number, feeCents: plan.feeCents, deadlineDays: plan.deadlineDays });
        await finalizeInvoiceIn(tx, tenantId, draft.id, actor);
        const fee = await tx.invoice.findUniqueOrThrow({ where: { id: draft.id }, select: { id: true, number: true } });
        feeInvoiceId = fee.id; feeInvoiceNumber = fee.number;
      }
      const contract = row.contractId ? await tx.rentalContract.findFirst({ where: { id: row.contractId, tenantId }, select: { number: true } }) : null;
      const f = r.financials;
      const snapshot: DunningSnapshot = {
        v: 1, level: plan.level, levelLabel: plan.levelLabel, number, issuedAt: now.toISOString(), deadlineAt: plan.deadlineAt.toISOString(), deadlineDays: plan.deadlineDays,
        company: companySnapshotOf(tenant), customer: row.currentVersion!.customerSnapshot as Partial<InvoiceCustomerSnapshot>, recipient,
        invoice: { id: row.id, number: row.number ?? "", kind: row.kind, versionNo: row.currentVersion!.versionNo, issueDate: row.currentVersion!.issueDate?.toISOString() ?? null, dueDate: row.currentVersion!.paymentDueDate?.toISOString() ?? null, grossCents: toCents(row.currentVersion!.grossTotal) },
        bookingNumber: row.booking?.number ?? null, contractNumber: contract?.number ?? null,
        balance: { invoiceCents: f.invoiceCents, creditedCents: f.creditedCents, cancelledCents: f.cancelledCents, effectiveCents: f.effectiveCents, paidCents: f.paidCents, offsetCents: f.offsetCents, openCents: f.openCents },
        priorNotices: r.notices.map((n) => ({ level: n.level, number: n.number, issuedAt: n.issuedAt.toISOString(), totalCents: n.totalCents })),
        priorFees: r.feeClaims.map((c) => ({ number: c.number, noticeNumber: c.noticeNumber, grossCents: c.grossCents, openCents: c.openCents })),
        fee: { cents: plan.feeCents, invoiceNumber: feeInvoiceNumber },
        principalOpenCents: plan.principalOpenCents, priorFeesOpenCents: plan.priorFeesOpenCents, feeCents: plan.feeCents, totalCents: plan.totalCents,
        createdByName: actor.name,
      };
      const notice = await tx.dunningNotice.create({
        data: {
          tenantId, invoiceId: row.id, bookingId: row.bookingId, customerId: row.customerId, level: plan.level, number, issuedAt: now,
          deadlineDays: plan.deadlineDays, deadlineAt: plan.deadlineAt, principalOpenCents: plan.principalOpenCents, priorFeesOpenCents: plan.priorFeesOpenCents,
          feeCents: plan.feeCents, totalCents: plan.totalCents, feeInvoiceId, recipientName: recipient.name, recipientEmail: recipient.email,
          snapshot: snapshot as unknown as Prisma.InputJsonValue, contentHash: contentHash(snapshot), idempotencyKey: key, createdById: actor.id, createdByName: actor.name,
        },
      });
      const audit = { bookingId: row.bookingId, invoiceId: row.id, amountCents: plan.totalCents };
      const details = { noticeId: notice.id, number, level: plan.level, levelLabel: plan.levelLabel, invoiceNumber: row.number, customerId: row.customerId, principalOpenCents: plan.principalOpenCents, priorFeesOpenCents: plan.priorFeesOpenCents, feeCents: plan.feeCents, deadlineAt: plan.deadlineAt.toISOString(), feeInvoiceNumber };
      await recordAudit(tx, tenantId, actor, { action: plan.level === 1 ? "DUNNING_REMINDER_CREATED" : plan.level === 2 ? "DUNNING_FIRST_CREATED" : "DUNNING_SECOND_CREATED", ...audit, details });
      if (feeInvoiceId) await recordAudit(tx, tenantId, actor, { action: "DUNNING_FEE_CREATED", bookingId: row.bookingId, invoiceId: feeInvoiceId, amountCents: plan.feeCents, details: { noticeId: notice.id, number, level: plan.level, feeInvoiceNumber, invoiceNumber: row.number, mainInvoiceId: row.id } });
      return { notice, created: true };
    }, { timeout: 30_000, maxWait: 15_000 }));
  } catch (e) {
    if (isUniqueViolation(e, "idempotencyKey")) {
      const winner = await db.dunningNotice.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (winner) return { notice: winner, created: false };
    }
    if (isUniqueViolation(e, "level")) throw new DomainError(`Die ${dunningLevelLabel(input.level)} wurde soeben bereits erstellt. Bitte die Seite neu laden.`);
    throw e;
  }
}

/** Übermittlung außerhalb des E-Mail-Versands (Post, persönlich) einmalig vermerken. */
export async function markDunningDelivered(tenantId: string, actor: Actor, noticeId: string, note: string | null) {
  const clean = note?.trim().slice(0, 300) || null;
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DunningNotice" WHERE "id" = ${noticeId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Mahnschreiben nicht gefunden.");
    const n = await tx.dunningNotice.findUniqueOrThrow({ where: { id: noticeId } });
    if (n.deliveredAt) return n;
    const updated = await tx.dunningNotice.update({ where: { id: noticeId }, data: { deliveredAt: new Date(), deliveredById: actor.id, deliveredByName: actor.name, deliveredNote: clean } });
    await recordAudit(tx, tenantId, actor, { action: "DUNNING_DELIVERED", bookingId: n.bookingId, invoiceId: n.invoiceId, amountCents: n.totalCents, details: { noticeId: n.id, number: n.number, level: n.level, note: clean } });
    return updated;
  });
}

/** Mahnschreiben einer Rechnung (für Historie), älteste zuerst; nur des eigenen Mandanten. */
export function listDunningNotices(tenantId: string, invoiceId: string) {
  return db.dunningNotice.findMany({ where: { tenantId, invoiceId }, orderBy: { level: "asc" } });
}

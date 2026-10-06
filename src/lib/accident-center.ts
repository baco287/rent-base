// Befehl 29 Phase G: Unfallersatz-Zentrale (/unfallersatz) – das tägliche Arbeitscockpit. Aggregiert nur Vorhandenes:
// Hauptzustand aus caseMainStatus, nächste Schritte aus nextSteps (Vollsicht) bzw. operationalNextSteps (Hof/Supportmodus),
// Finanzstand aus caseFinancialsMany (gebündelt, feste Zahl an Abfragen) – keine eigene Status- oder Hinweislogik, kein
// gespeicherter Sammelstatus. Rollen wie in der Fallakte: Vollsicht (Inhaber, Disposition) bzw. operative Sicht (Hof,
// Supportmodus); Versicherung, Schadennummer, Haftung, Beträge, Kürzungen, Kaution und Wiedervorlagen werden für die operative
// Sicht gar nicht abgefragt.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { caseFinancialsMany, followUpDue, followUpTiming, nextSteps, type CaseFinancials, type FollowUpTiming, type NextStep } from "@/lib/accident-replacement";
import { caseMainStatus, operationalNextSteps, type CaseFileAccess, type MainStatus } from "@/lib/accident-case-file";
import { depositFinancialsFor, type DepositFinancials } from "@/lib/deposits";
import { ACCIDENT_LIABILITY_STATUS, type AccidentLiabilityStatus } from "@/lib/constants";
import { customerName } from "@/lib/format";
import { fmtCents, type Cents } from "@/lib/money";
import { rentalDays } from "@/lib/pricing";
import { accidentIdsByDamagedPlate, cleanQuery, customerSearchWhere, SEARCH_MAX, vehicleIdsByPlate } from "@/lib/search";

type Client = typeof db;

// ---------------------------------------------------------------------------
// Schnellfilter (aus echten Zuständen abgeleitet, kein Status-Enum)
// ---------------------------------------------------------------------------

export const CENTER_FILTERS = {
  offen: "Alle offenen",
  laufend: "Laufende Mieten",
  uebergabe: "Reserviert / Übergabe offen",
  abzurechnen: "Abzurechnen",
  rechnung_offen: "Rechnung offen",
  kuerzung: "Kürzung",
  wiedervorlage: "Wiedervorlage fällig",
  abgeschlossen: "Abgeschlossen",
} as const;
export type CenterFilter = keyof typeof CENTER_FILTERS;
/** Filter mit kaufmännischen oder Wiedervorlagen-Daten – nur Vollsicht */
const FULL_ONLY_FILTERS = new Set<CenterFilter>(["abzurechnen", "rechnung_offen", "kuerzung", "wiedervorlage"]);
export const centerFilters = (access: CaseFileAccess) => (Object.keys(CENTER_FILTERS) as CenterFilter[]).filter((k) => access === "FULL" || !FULL_ONLY_FILTERS.has(k));
export function resolveCenterFilter(raw: unknown, access: CaseFileAccess): CenterFilter {
  return typeof raw === "string" && raw in CENTER_FILTERS && centerFilters(access).includes(raw as CenterFilter) ? (raw as CenterFilter) : "offen";
}

// ---------------------------------------------------------------------------
// Nächster Schritt: Kurztext je Code (Darstellung) und Auswahl des wichtigsten – die Schritte selbst kommen aus nextSteps
// ---------------------------------------------------------------------------

/** Reihenfolge = Vorrang des angezeigten Schritts (handlungsrelevant vor informativ) */
const LEAD_ORDER = [
  "FOLLOW_UP_OVERDUE", "OVERDUE", "DOUBLE_CLAIM", "BILLED_BEYOND_RETURN", "BILLING_GAP", "REMAINDER_ORPHAN", "REMAINDER_EXCESS", "REFUND_OPEN",
  "FOLLOW_UP_TODAY", "RETURN_DRAFT", "INVOICE_MISSING", "FINAL_INVOICE_MISSING", "INVOICE_DRAFT", "PICKUP", "CONTRACT", "RETURN_DUE",
  "PARTIALLY_PAID", "INVOICE_OPEN", "REDUCTION_OPEN", "FEES_OPEN", "DEPOSIT_OPEN", "DEPOSIT_PAYOUT_OPEN",
  "CLAIM_NUMBER_MISSING", "INSURER_MISSING", "LIABILITY_OPEN", "OPEN_END", "CANCELLED", "CLOSED",
];
const leadIndex = (code: string) => { const i = LEAD_ORDER.indexOf(code); return i < 0 ? LEAD_ORDER.length : i; };

/** Kompakter Hinweis für Liste/Karte; der vollständige Text der Fallakte steht im Tooltip. */
export function stepShort(s: NextStep, fin: CaseFinancials | null): string {
  switch (s.code) {
    case "INSURER_MISSING": return "Versicherung erfassen";
    case "CLAIM_NUMBER_MISSING": return "Schadennummer ergänzen";
    case "LIABILITY_OPEN": return "Haftung klären";
    case "CONTRACT": return s.href ? "Mietvertrag abschließen" : "Vertrag durch Disposition";
    case "PICKUP": return s.text.startsWith("Übergabe begonnen") ? "Übergabe fortsetzen" : "Übergabe durchführen";
    case "OPEN_END": return "Mietende offen";
    case "OVERDUE": return "Rückgabe oder Mietdauer klären";
    case "RETURN_DUE": return "Rückgabe bald";
    case "RETURN_DRAFT": return "Rückgabe fortsetzen";
    case "INVOICE_MISSING": case "FINAL_INVOICE_MISSING": return "Schlussrechnung erstellen";
    case "INVOICE_DRAFT": return "Rechnungsentwurf abschließen";
    case "INVOICE_OPEN": return fin ? `${fmtCents(fin.economicOpenCents)} offen` : "Rechnung offen";
    case "PARTIALLY_PAID": return fin ? `${fmtCents(fin.economicOpenCents)} offen (teilbezahlt)` : "Teilbezahlt";
    case "DOUBLE_CLAIM": return "Doppelforderung prüfen";
    case "REMAINDER_ORPHAN": case "REMAINDER_EXCESS": return "Restforderung prüfen";
    case "REDUCTION_OPEN": return "Kürzung prüfen";
    case "REFUND_OPEN": return "Guthaben erstatten";
    case "FEES_OPEN": return "Mahngebühren offen";
    case "BILLED_BEYOND_RETURN": case "BILLING_GAP": return "Abrechnung prüfen";
    case "DEPOSIT_OPEN": return "Kaution prüfen";
    case "DEPOSIT_PAYOUT_OPEN": return "Kautionsauszahlung offen";
    case "FOLLOW_UP_OVERDUE": return "Wiedervorlage überfällig";
    case "FOLLOW_UP_TODAY": return "Wiedervorlage heute";
    case "CANCELLED": return "Buchung storniert";
    case "CLOSED": return "Abgeschlossen";
    default: return s.text;
  }
}

/** Wichtigster Schritt zuerst; die übrigen bleiben als Zahl („+2 weitere“). */
export function orderSteps(steps: readonly NextStep[]): NextStep[] {
  return [...steps].sort((a, b) => leadIndex(a.code) - leadIndex(b.code));
}

// ---------------------------------------------------------------------------
// Priorisierung der Liste (operativ, nicht nach Erstellungsdatum)
// 1 überfällige Wiedervorlage / kritischer Handlungsbedarf · 2 Wiedervorlage heute · 3 zurückgegeben, abzurechnen ·
// 4 Rechnung offen/teilbezahlt · 5 Übergabe/Rückgabe anstehend · 6 laufende Miete · 7 reserviert · 8 übrige
// ---------------------------------------------------------------------------

const CRITICAL = new Set(["FOLLOW_UP_OVERDUE", "OVERDUE", "DOUBLE_CLAIM", "BILLED_BEYOND_RETURN", "BILLING_GAP", "REMAINDER_ORPHAN", "REMAINDER_EXCESS", "REFUND_OPEN"]);
const TO_INVOICE = new Set(["INVOICE_MISSING", "FINAL_INVOICE_MISSING", "INVOICE_DRAFT"]);
const DAY = 86_400_000;

export function centerRank(steps: readonly NextStep[], b: { status: string; startAt: Date }, now: Date): number {
  const has = (code: string) => steps.some((s) => s.code === code);
  if (steps.some((s) => CRITICAL.has(s.code))) return 1;
  if (has("FOLLOW_UP_TODAY")) return 2;
  if (b.status === "RETURNED" && steps.some((s) => TO_INVOICE.has(s.code))) return 3;
  if (has("INVOICE_OPEN") || has("PARTIALLY_PAID")) return 4;
  const pickupSoon = (has("PICKUP") || has("CONTRACT")) && b.startAt.getTime() <= now.getTime() + DAY;
  if (pickupSoon || has("RETURN_DUE") || has("RETURN_DRAFT")) return 5;
  if (b.status === "ACTIVE") return 6;
  if (b.status === "RESERVED") return 7;
  return 8;
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

export type CenterRow = {
  id: string; caseNumber: string; status: "OPEN" | "CLOSED"; createdAt: Date; closedAt: Date | null;
  booking: { id: string; number: string; status: string; startAt: Date; endAt: Date | null; actualPickupAt: Date | null; actualReturnAt: Date | null };
  customer: { id: string; name: string };
  vehicle: { plate: string; label: string };
  /** Zeitraum: offenes Ende, geplantes Ende (ggf. überschritten), tatsächlicher Zeitraum; Miettage nach zentraler Tageslogik */
  period: { from: Date; until: Date | null; kind: "OPEN" | "PLANNED" | "PLANNED_EXCEEDED" | "ACTUAL" | "CANCELLED"; days: number | null };
  mainStatus: MainStatus;
  /** wichtigster Schritt und Zahl weiterer */
  lead: (NextStep & { short: string }) | null; more: number; steps: (NextStep & { short: string })[];
  rank: number;
  /** schnelle, sichere Aktion (Link auf vorhandene, serverseitig geschützte Seiten) */
  action: { label: string; href: string } | null;
  /** nur Vollsicht – für den Hof null (nicht geladen) */
  full: null | {
    damagedPlate: string; insurerName: string | null; claimNumber: string | null; liability: { status: AccidentLiabilityStatus; label: string; quotaPercent: number | null };
    billing: { active: number; drafts: number; grossCents: Cents; paidCents: Cents; economicOpenCents: Cents; reducedCents: Cents; doubleClaimCents: Cents; finalBilled: boolean };
    followUps: { overdue: number; today: number; nextDueAt: Date | null };
  };
};

export type CenterKpis = {
  open: number; running: number; reserved: number;
  /** nur Vollsicht, sonst null */
  toInvoice: number | null; receivablesCents: Cents | null; receivablesCases: number | null; followUpsDue: number | null;
};

export type AccidentCenter = {
  access: CaseFileAccess; filter: CenterFilter; q: string;
  kpis: CenterKpis;
  counts: Partial<Record<CenterFilter, number>>;
  rows: CenterRow[]; total: number; page: number; pages: number; pageSize: number;
  /** mehr offene Fälle als geladen (Obergrenze) */
  truncated: boolean;
  /** Mandant hat überhaupt Unfallersatzfälle (Leerzustand) */
  anyCases: boolean;
  /** Phase H: Wiedervorlagen-Arbeitsliste – nur Vollsicht (für Hof und Supportmodus nicht geladen: null) */
  tasks: CenterTasks | null;
};

// ---------------------------------------------------------------------------
// Phase H: Wiedervorlagen als Arbeitsliste (nur Vollsicht) – dieselben CaseFollowUp-Daten wie in der Fallakte, keine eigene
// Aufgabentabelle. Nur offene Wiedervorlagen offener Fälle; erledigte und verworfene erscheinen nicht.
// ---------------------------------------------------------------------------

/** Eigene kleine Filter der Arbeitsliste (Adresse: aufgaben=…), getrennt von den Fallfiltern */
export const TASK_VIEWS = { faellig: "Fällig", ueberfaellig: "Überfällig", heute: "Heute", demnaechst: "Demnächst", meine: "Meine" } as const;
export type TaskViewKey = keyof typeof TASK_VIEWS;
/** null = kompakte Übersicht (überfällig, heute, nächste 7 Tage; begrenzt), "alle" = dieselbe Übersicht vollständig */
export type TaskView = TaskViewKey | "alle";
export function resolveTaskView(raw: unknown): TaskView | null {
  return typeof raw === "string" && (Object.hasOwn(TASK_VIEWS, raw) || raw === "alle") ? (raw as TaskView) : null;
}
export const TASK_GROUP_LABELS: Record<FollowUpTiming["group"], string> = { OVERDUE: "Überfällig", TODAY: "Heute", SOON: "Demnächst (7 Tage)", LATER: "Später" };
/** Einträge der kompakten Übersicht; mehr über „Weitere Wiedervorlagen anzeigen“ */
export const TASK_PREVIEW_LIMIT = 6;
/** Obergrenze einer vollständigen Liste (Rest über die Fallakten) */
export const TASK_LIST_LIMIT = 200;

export type CenterTask = {
  id: string; caseId: string; caseNumber: string; customerName: string;
  title: string; note: string | null; dueAt: Date; group: FollowUpTiming["group"]; dueText: string;
  assigneeName: string | null; mine: boolean;
};
export type CenterTasks = {
  view: TaskView | null;
  items: CenterTask[];
  counts: Record<TaskViewKey | "uebersicht", number>;
  /** nicht angezeigte Einträge der gewählten Liste (Vorschau bzw. Obergrenze) */
  more: number;
  /** offene Wiedervorlagen nach dem Vorschauzeitraum (nur Übersicht; erreichbar über die Fallakte bzw. „Meine“) */
  later: number;
};

function buildTasks(open: LoadedCase[], view: TaskView | null, userId: string | null, now: Date): CenterTasks {
  const all: CenterTask[] = [];
  for (const c of open) {
    for (const f of c.followUps ?? []) {
      const t = followUpTiming(f.dueAt, now);
      all.push({ id: f.id, caseId: c.id, caseNumber: c.caseNumber, customerName: customerName(c.booking.customer), title: f.title, note: f.note, dueAt: f.dueAt, group: t.group, dueText: t.text, assigneeName: f.assigneeName, mine: !!userId && f.assigneeUserId === userId });
    }
  }
  all.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.caseNumber.localeCompare(b.caseNumber) || a.id.localeCompare(b.id));
  const n = (g: CenterTask["group"]) => all.filter((t) => t.group === g).length;
  const counts = { uebersicht: all.filter((t) => t.group !== "LATER").length, faellig: n("OVERDUE") + n("TODAY"), ueberfaellig: n("OVERDUE"), heute: n("TODAY"), demnaechst: n("SOON"), meine: all.filter((t) => t.mine).length };
  const list = view === "faellig" ? all.filter((t) => t.group === "OVERDUE" || t.group === "TODAY")
    : view === "ueberfaellig" ? all.filter((t) => t.group === "OVERDUE")
    : view === "heute" ? all.filter((t) => t.group === "TODAY")
    : view === "demnaechst" ? all.filter((t) => t.group === "SOON")
    : view === "meine" ? all.filter((t) => t.mine)
    : all.filter((t) => t.group !== "LATER");
  const limit = view === null ? TASK_PREVIEW_LIMIT : TASK_LIST_LIMIT;
  return { view, items: list.slice(0, limit), counts, more: Math.max(0, list.length - limit), later: view === null || view === "alle" ? n("LATER") : 0 };
}

export const CENTER_PAGE_SIZE = 25;
/** Obergrenze offener Fälle, die für Priorisierung und Kennzahlen gemeinsam geladen werden */
export const CENTER_OPEN_CAP = 1000;

const BOOKING_SELECT = {
  id: true, number: true, status: true, startAt: true, endAt: true, actualPickupAt: true, actualReturnAt: true,
  contract: { select: { status: true } },
  handovers: { where: { correctsId: null }, select: { type: true, status: true } },
  customer: { select: { id: true, type: true, firstName: true, lastName: true, companyName: true } },
  vehicle: { select: { plate: true, make: true, model: true } },
} as const;
const FULL_BOOKING_SELECT = { ...BOOKING_SELECT, securityDeposit: { select: { id: true, expectedAmountCents: true, events: { select: { type: true, amountCents: true, status: true } } } } } as const;
const FULL_CASE_FIELDS = { damagedPlate: true, insurerName: true, insurerClaimNumber: true, liabilityStatus: true, liabilityQuotaPercent: true } as const;
// Phase H: offene Wiedervorlagen mit Aufgabe, Notiz und Zuständigkeit – Grundlage für Rangfolge und Arbeitsliste (eine Abfrage)
const FOLLOW_UPS = { where: { status: "OPEN" }, orderBy: { dueAt: "asc" }, select: { id: true, dueAt: true, title: true, note: true, assigneeUserId: true, assigneeName: true } } as const;

type LoadedCase = {
  id: string; caseNumber: string; status: string; createdAt: Date; closedAt: Date | null;
  damagedPlate?: string; insurerName?: string | null; insurerClaimNumber?: string | null; liabilityStatus?: string; liabilityQuotaPercent?: number | null;
  followUps?: { id: string; dueAt: Date; title: string; note: string | null; assigneeUserId: string | null; assigneeName: string | null }[];
  booking: {
    id: string; number: string; status: string; startAt: Date; endAt: Date | null; actualPickupAt: Date | null; actualReturnAt: Date | null;
    contract: { status: string } | null; handovers: { type: string; status: string }[];
    customer: { id: string; type: string; firstName: string; lastName: string; companyName: string | null };
    vehicle: { plate: string; make: string; model: string };
    securityDeposit?: { id: string; expectedAmountCents: number; events: { type: string; amountCents: number; status: string }[] } | null;
  };
};

/** Suchbedingung (Fallnummer, Kunde/Firma, Ersatz- und beschädigtes Kennzeichen, Versicherung, Schadennummer). Hof/Supportmodus:
 * keine Treffer über Versicherung, Schadennummer oder beschädigtes Kennzeichen (diese Daten sieht die operative Sicht nicht). */
async function searchWhere(tenantId: string, q: string, access: CaseFileAccess): Promise<Prisma.AccidentReplacementCaseWhereInput | null> {
  const ql = cleanQuery(q).slice(0, SEARCH_MAX);
  if (!ql) return null;
  const ci = { contains: ql, mode: "insensitive" as const };
  const full = access === "FULL";
  const [plateIds, customerWhere, damagedIds] = await Promise.all([
    vehicleIdsByPlate(tenantId, ql),
    customerSearchWhere(tenantId, ql),
    full ? accidentIdsByDamagedPlate(tenantId, ql) : Promise.resolve([] as string[]),
  ]);
  const or: Prisma.AccidentReplacementCaseWhereInput[] = [
    { caseNumber: ci },
    { booking: { number: ci } },
    { booking: { customer: customerWhere } },
    { booking: { vehicle: { plate: ci } } },
    ...(plateIds.length ? [{ booking: { vehicleId: { in: plateIds } } }] : []),
    ...(full ? [{ damagedPlate: ci }, { insurerName: ci }, { insurerClaimNumber: ci }] : []),
    ...(damagedIds.length ? [{ id: { in: damagedIds } }] : []),
  ];
  return { tenantId, OR: or };
}

function periodOf(b: LoadedCase["booking"], now: Date): CenterRow["period"] {
  const from = b.actualPickupAt ?? b.startAt;
  if (b.status === "CANCELLED") return { from: b.startAt, until: b.endAt, kind: "CANCELLED", days: null };
  if (b.actualReturnAt) return { from, until: b.actualReturnAt, kind: "ACTUAL", days: b.actualPickupAt ? rentalDays(b.actualPickupAt, b.actualReturnAt) : null };
  const days = b.status === "ACTIVE" && b.actualPickupAt ? rentalDays(b.actualPickupAt, now) : null;
  if (!b.endAt) return { from, until: null, kind: "OPEN", days };
  return { from, until: b.endAt, kind: b.status === "ACTIVE" && b.endAt < now ? "PLANNED_EXCEEDED" : "PLANNED", days };
}

function actionOf(c: LoadedCase, steps: readonly NextStep[], access: CaseFileAccess): CenterRow["action"] {
  if (c.status !== "OPEN") return null;
  const b = c.booking;
  const has = (code: string) => steps.some((s) => s.code === code);
  if (has("PICKUP")) return { label: "Übergabe", href: `/buchungen/${b.id}/uebergabe` };
  if (has("RETURN_DRAFT") || (b.status === "ACTIVE" && b.contract?.status === "SIGNED" && b.handovers.some((h) => h.type === "PICKUP" && h.status === "FINALIZED"))) return { label: "Rückgabe", href: `/buchungen/${b.id}/rueckgabe` };
  if (access === "FULL" && b.status === "RETURNED") return { label: "Abrechnung", href: `/unfallersatz/${c.id}?tab=abrechnung` };
  return null;
}

function toRow(c: LoadedCase, access: CaseFileAccess, fin: CaseFinancials | null, depositState: Parameters<typeof nextSteps>[1]["depositState"], now: Date): CenterRow {
  const b = c.booking;
  const overdue = b.status === "ACTIVE" && b.endAt !== null && b.endAt < now;
  const stepCase = { id: c.id, status: c.status, bookingId: b.id };
  const raw = access === "FULL"
    ? nextSteps({ ...stepCase, insurerName: c.insurerName ?? null, insurerClaimNumber: c.insurerClaimNumber ?? null, liabilityStatus: c.liabilityStatus ?? "UNKNOWN" }, { status: b.status, endAt: b.endAt, actualReturnAt: b.actualReturnAt, contract: b.contract, handovers: b.handovers, depositState }, fin!, c.followUps ?? [], now)
    : operationalNextSteps(stepCase, b, now);
  const steps = orderSteps(raw).map((s) => ({ ...s, short: stepShort(s, fin) }));
  const returnStarted = b.handovers.some((h) => h.type === "RETURN" && h.status === "DRAFT");
  const mainStatus = caseMainStatus({ caseStatus: c.status, bookingStatus: b.status, contractSigned: b.contract?.status === "SIGNED", overdue, returnedAt: b.actualReturnAt, returnStarted, fin });
  const closed = c.status !== "OPEN";
  const lead = closed ? null : steps.find((s) => s.code !== "CLOSED") ?? null;
  let full: CenterRow["full"] = null;
  if (access === "FULL") {
    const liabilityStatus = (c.liabilityStatus && c.liabilityStatus in ACCIDENT_LIABILITY_STATUS ? c.liabilityStatus : "UNKNOWN") as AccidentLiabilityStatus;
    const due = (c.followUps ?? []).map((f) => followUpDue(f.dueAt, now));
    full = {
      damagedPlate: c.damagedPlate ?? "", insurerName: c.insurerName ?? null, claimNumber: c.insurerClaimNumber ?? null,
      liability: { status: liabilityStatus, label: ACCIDENT_LIABILITY_STATUS[liabilityStatus], quotaPercent: c.liabilityQuotaPercent ?? null },
      billing: fin ? { active: fin.active, drafts: fin.drafts, grossCents: fin.grossCents, paidCents: fin.paidCents, economicOpenCents: fin.economicOpenCents, reducedCents: fin.reducedCents, doubleClaimCents: fin.doubleClaimCents, finalBilled: fin.finalBilled }
        : { active: 0, drafts: 0, grossCents: 0, paidCents: 0, economicOpenCents: 0, reducedCents: 0, doubleClaimCents: 0, finalBilled: false },
      followUps: { overdue: due.filter((d) => d === "OVERDUE").length, today: due.filter((d) => d === "TODAY").length, nextDueAt: c.followUps?.[0]?.dueAt ?? null },
    };
  }
  return {
    id: c.id, caseNumber: c.caseNumber, status: closed ? "CLOSED" : "OPEN", createdAt: c.createdAt, closedAt: c.closedAt,
    booking: { id: b.id, number: b.number, status: b.status, startAt: b.startAt, endAt: b.endAt, actualPickupAt: b.actualPickupAt, actualReturnAt: b.actualReturnAt },
    customer: { id: b.customer.id, name: customerName(b.customer) },
    vehicle: { plate: b.vehicle.plate, label: `${b.vehicle.make} ${b.vehicle.model}` },
    period: periodOf(b, now),
    mainStatus, lead, more: lead ? Math.max(0, steps.filter((s) => s.code !== "CLOSED").length - 1) : 0, steps: closed ? [] : steps,
    rank: closed ? 9 : centerRank(raw, b, now),
    action: actionOf(c, raw, access),
    full,
  };
}

/** Datum, nach dem innerhalb gleicher Priorität sortiert wird (dringendstes zuerst) */
function urgencyAt(r: CenterRow, followUpFirst: Date | null): number {
  const b = r.booking;
  switch (r.rank) {
    case 1: return Math.min(followUpFirst?.getTime() ?? Infinity, r.period.kind === "PLANNED_EXCEEDED" && b.endAt ? b.endAt.getTime() : Infinity, (b.actualReturnAt ?? r.createdAt).getTime());
    case 2: return followUpFirst?.getTime() ?? r.createdAt.getTime();
    case 3: case 4: return (b.actualReturnAt ?? r.createdAt).getTime();
    case 5: return (b.status === "RESERVED" ? b.startAt : b.endAt ?? b.startAt).getTime();
    case 6: return (b.actualPickupAt ?? b.startAt).getTime();
    case 7: return b.startAt.getTime();
    default: return r.createdAt.getTime();
  }
}

/**
 * Zentrale laden. Offene Fälle werden gemeinsam geladen (Obergrenze CENTER_OPEN_CAP), priorisiert und im Speicher geblättert –
 * Kennzahlen gelten für alle offenen Fälle. Abgeschlossene Fälle werden in der Datenbank geblättert. Feste Zahl an Abfragen,
 * unabhängig von der Zahl der Fälle (kein Nachladen je Zeile).
 */
export async function accidentCenter(tenantId: string, opts: { access: CaseFileAccess; filter?: unknown; q?: string | null; page?: number; pageSize?: number; now?: Date; client?: Client; /** Phase H */ tasks?: unknown; userId?: string | null }): Promise<AccidentCenter> {
  const client = opts.client ?? db;
  const now = opts.now ?? new Date();
  const access = opts.access;
  const full = access === "FULL";
  const filter = resolveCenterFilter(opts.filter, access);
  const q = cleanQuery(opts.q ?? "").slice(0, SEARCH_MAX);
  const pageSize = Math.min(Math.max(opts.pageSize ?? CENTER_PAGE_SIZE, 10), 100);
  const select = { id: true, caseNumber: true, status: true, createdAt: true, closedAt: true, ...(full ? { ...FULL_CASE_FIELDS, followUps: FOLLOW_UPS, booking: { select: FULL_BOOKING_SELECT } } : { booking: { select: BOOKING_SELECT } }) };

  const qWhere = q ? await searchWhere(tenantId, q, access) : null;
  const closedWhere: Prisma.AccidentReplacementCaseWhereInput = { tenantId, status: "CLOSED", ...(qWhere ? { AND: [qWhere] } : {}) };
  // Runde 1: alle offenen Fälle (Kennzahlen, Priorisierung), Trefferliste der Suche, Zahl abgeschlossener, Existenz überhaupt
  const [openCases, hitIds, closedTotal, anyCase] = await Promise.all([
    client.accidentReplacementCase.findMany({ where: { tenantId, status: "OPEN" }, orderBy: { createdAt: "asc" }, take: CENTER_OPEN_CAP + 1, select }) as unknown as Promise<LoadedCase[]>,
    qWhere ? client.accidentReplacementCase.findMany({ where: { ...qWhere, status: "OPEN" }, select: { id: true } }).then((r) => new Set(r.map((x) => x.id))) : Promise.resolve(null),
    client.accidentReplacementCase.count({ where: closedWhere }),
    client.accidentReplacementCase.findFirst({ where: { tenantId }, select: { id: true } }),
  ]);
  const truncated = openCases.length > CENTER_OPEN_CAP;
  const open = truncated ? openCases.slice(0, CENTER_OPEN_CAP) : openCases;

  // Runde 2–4 (nur Vollsicht): Finanzstand und Kaution gebündelt
  let fins = new Map<string, CaseFinancials>();
  let depFin = new Map<string, DepositFinancials>();
  if (full && open.length) {
    const deposits = open.map((c) => c.booking.securityDeposit).filter((d): d is NonNullable<typeof d> => !!d);
    [fins, depFin] = await Promise.all([caseFinancialsMany(tenantId, open.map((c) => c.booking), client), depositFinancialsFor(tenantId, deposits, client)]);
  }
  const depositOf = (c: LoadedCase) => (c.booking.securityDeposit ? depFin.get(c.booking.securityDeposit.id) ?? null : null);
  const openRows = open.map((c) => toRow(c, access, full ? fins.get(c.booking.id)! : null, full ? depositOf(c) : null, now));

  // Kennzahlen über alle offenen Fälle (unabhängig von Filter und Suche)
  const kpis: CenterKpis = {
    open: openRows.length,
    running: openRows.filter((r) => r.booking.status === "ACTIVE").length,
    reserved: openRows.filter((r) => r.booking.status === "RESERVED").length,
    toInvoice: full ? openRows.filter((r) => matches(r, "abzurechnen")).length : null,
    receivablesCents: full ? openRows.reduce((s, r) => s + (r.full?.billing.economicOpenCents ?? 0), 0) : null,
    receivablesCases: full ? openRows.filter((r) => (r.full?.billing.economicOpenCents ?? 0) > 0).length : null,
    followUpsDue: full ? openRows.reduce((s, r) => s + (r.full ? r.full.followUps.overdue + r.full.followUps.today : 0), 0) : null,
  };

  // Treffer der Suche (wirkt auf Liste und Filterzähler)
  const searched = hitIds ? openRows.filter((r) => hitIds.has(r.id)) : openRows;
  const counts: Partial<Record<CenterFilter, number>> = {};
  for (const f of centerFilters(access)) counts[f] = f === "abgeschlossen" ? closedTotal : searched.filter((r) => matches(r, f)).length;
  // Phase H: Arbeitsliste aus den bereits geladenen offenen Wiedervorlagen (keine weitere Abfrage); unabhängig von Fallfilter und Suche
  const tasks = full ? buildTasks(open, resolveTaskView(opts.tasks), opts.userId ?? null, now) : null;

  if (filter === "abgeschlossen") {
    const total = closedTotal;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, opts.page ?? 1), pages);
    const closed = (await client.accidentReplacementCase.findMany({ where: closedWhere, orderBy: [{ closedAt: "desc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize, select: { ...select, ...(full ? { followUps: false } : {}) } })) as unknown as LoadedCase[];
    // abgeschlossen: ruhige Darstellung ohne Finanz-/Hinweislogik (kein Nachladen je Zeile)
    const rows = closed.map((c) => toRow({ ...c, followUps: [] }, access, null, null, now));
    return { access, filter, q, kpis, counts, rows, total, page, pages, pageSize, truncated, anyCases: !!anyCase, tasks };
  }

  const firstFollowUp = new Map(open.map((c) => [c.id, c.followUps?.[0]?.dueAt ?? null]));
  const list = searched.filter((r) => matches(r, filter))
    .sort((a, b) => a.rank - b.rank || urgencyAt(a, firstFollowUp.get(a.id) ?? null) - urgencyAt(b, firstFollowUp.get(b.id) ?? null) || a.caseNumber.localeCompare(b.caseNumber));
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  return { access, filter, q, kpis, counts, rows: list.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize, truncated, anyCases: !!anyCase, tasks };
}

/** Schnellfilter auf einer (offenen) Zeile – nur aus den abgeleiteten Zuständen */
function matches(r: CenterRow, f: CenterFilter): boolean {
  const has = (code: string) => r.steps.some((s) => s.code === code);
  switch (f) {
    case "offen": return r.status === "OPEN";
    case "laufend": return r.booking.status === "ACTIVE";
    case "uebergabe": return r.booking.status === "RESERVED";
    case "abzurechnen": return r.booking.status === "RETURNED" && (has("INVOICE_MISSING") || has("FINAL_INVOICE_MISSING") || has("INVOICE_DRAFT"));
    case "rechnung_offen": return has("INVOICE_OPEN") || has("PARTIALLY_PAID");
    case "kuerzung": return (r.full?.billing.reducedCents ?? 0) > 0;
    case "wiedervorlage": return !!r.full && r.full.followUps.overdue + r.full.followUps.today > 0;
    case "abgeschlossen": return r.status === "CLOSED";
  }
}

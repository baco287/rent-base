// Befehl 29 Phase D: Daten der Unfallersatz-Fallakte (/unfallersatz/[id]). Aggregiert nur Vorhandenes (Fall, Buchung, Vertrag,
// Übergabe/Rückgabe, Unfallersatz-Rechnungen, Zahlungen, Kürzungen, Wiedervorlagen, Verlauf) – keine eigene Buchungs-, Vertrags-,
// Rechnungs- oder Übergabelogik und kein gespeicherter Sammelstatus.
//
// Zwei Sichten, serverseitig getrennt geladen (nicht nur ausgeblendet):
// - Vollsicht (OWNER, DISPO): alles.
// - Operative Sicht (YARD, Supportmodus): Ersatzfahrzeug, Zeitraum, Vertrag/Übergabe/Rückgabe, Kunde mit Name und Telefon,
//   unkritische nächste Schritte und Verlauf. Versicherung, Schadennummer, Haftung, Unfall, Gegner, Werkstatt, Anwalt, Tarif,
//   Beträge, Rechnungen, Kürzungen, Wiedervorlagen und Fall-Dokumente werden für sie gar nicht abgefragt.
// Phase E (Entscheidung des Nutzers): Außerhalb der Fallakte bleibt das bestehende Rollenmodell – die Buchungsseite zeigt
//   auch dem Hof Tagessatz und Mietwert (wie bei Standardmieten); der Tarif steht ohnehin im Vertrag, den der Hof sehen darf.

import { db } from "@/lib/db";
import { accidentRentState, contractDailyRateCents, contractTariffItems, rentValue, type RentState, type RentValue } from "@/lib/accident-pricing";
import { loadEffectiveContract } from "@/lib/amendments";
import { caseFinancials, closeWarnings, financeWarnings, finalInvoiceMissing, followUpDue, nextSteps, type CaseFinancials, type CloseWarning, type NextStep } from "@/lib/accident-replacement";
import { accidentInvoiceChain, previewAccidentInvoice, type AccidentInvoicePreview } from "@/lib/invoices";
import { DomainError } from "@/lib/integrity";
import { toDateTimeInputValue } from "@/lib/time";
import { partnerOptions, type PartnerOption } from "@/lib/business-partners";
import { pickupAction, returnAction, type ProcessAction } from "@/lib/booking-status";
import {
  ACCIDENT_BILLING_TYPES, ACCIDENT_CASE_DOCUMENT_TYPES, ACCIDENT_CASE_EVENT_TYPES, ACCIDENT_CASE_STATUS, ACCIDENT_LIABILITY_STATUS, DOCUMENT_TYPES, INVOICE_ADJUSTMENT_REASONS, INVOICE_PAYMENT_STATUS,
  INVOICE_RECIPIENT_ROLES, roleAllows, type AccidentCaseEventType, type AccidentLiabilityStatus,
} from "@/lib/constants";
import { customerName, fmtDate, fmtDateTime } from "@/lib/format";
import { toCents, type Cents } from "@/lib/money";
import { nextRentalDayStart, rentalDays } from "@/lib/pricing";

export type CaseFileAccess = "FULL" | "OPERATIONAL";
/** Vollsicht nur für Inhaber und Disposition; der Supportmodus läuft als YARD und bekommt die operative Sicht. */
export const caseFileAccess = (role: string): CaseFileAccess => (roleAllows(role, ["DISPO"]) ? "FULL" : "OPERATIONAL");

export const CASE_FILE_TABS = { uebersicht: "Übersicht", schadenfall: "Schadenfall", miete: "Miete", dokumente: "Dokumente", abrechnung: "Abrechnung", verlauf: "Verlauf" } as const;
export type CaseFileTab = keyof typeof CASE_FILE_TABS;
const OPERATIONAL_TABS: readonly CaseFileTab[] = ["uebersicht", "miete", "dokumente", "verlauf"];

export function caseFileTabs(access: CaseFileAccess): CaseFileTab[] {
  return access === "FULL" ? (Object.keys(CASE_FILE_TABS) as CaseFileTab[]) : [...OPERATIONAL_TABS];
}
/** ?tab= aus der Adresse; Unbekanntes oder für die Rolle nicht Erlaubtes fällt auf die Übersicht zurück. */
export function resolveCaseFileTab(raw: unknown, access: CaseFileAccess): CaseFileTab {
  return typeof raw === "string" && (caseFileTabs(access) as string[]).includes(raw) ? (raw as CaseFileTab) : "uebersicht";
}

export type Tone = "good" | "amber" | "bad" | "info" | "grey";
export type MainStatus = { label: string; tone: Tone };

/**
 * Hauptstatus für den Kopf – abgeleitet, nie gespeichert. Ein Fall kann zugleich „Miete beendet“, „Rechnung gestellt“ und
 * „Teilbezahlt“ sein; der Kopf zeigt den für die Arbeit wichtigsten Stand, die übrigen Angaben stehen in Kennzahlen und Chips.
 */
export function caseMainStatus(i: { caseStatus: string; bookingStatus: string; contractSigned: boolean; overdue: boolean; returnedAt?: Date | null; fin: Pick<CaseFinancials, "active" | "billedUntil" | "drafts" | "economicOpenCents" | "paidCents"> & Partial<CaseFinancials> | null }): MainStatus {
  if (i.caseStatus === "CLOSED") return { label: "Abgeschlossen", tone: "grey" };
  if (i.bookingStatus === "CANCELLED") return { label: "Storniert", tone: "grey" };
  if (i.bookingStatus === "RESERVED") return i.contractSigned ? { label: "Bereit zur Übergabe", tone: "info" } : { label: "Übergabe ausstehend", tone: "amber" };
  if (i.bookingStatus === "ACTIVE") return i.overdue ? { label: "Rückgabe überfällig", tone: "bad" } : { label: "Miete läuft", tone: "info" };
  // zurückgegeben: ohne Finanzsicht nur „Miete beendet“
  if (!i.fin) return { label: "Miete beendet", tone: "good" };
  // nur wirksame Rechnungen zählen (stornierte bzw. vollständig gutgeschriebene nicht); offene Entwürfe und eine fehlende
  // Schlussrechnung gehen „Bezahlt“ vor
  if (i.fin.active === 0) return i.fin.drafts > 0 ? { label: "Rechnung im Entwurf", tone: "amber" } : { label: "Abzurechnen", tone: "amber" };
  if (i.fin.drafts > 0) return { label: "Rechnung im Entwurf", tone: "amber" };
  if (finalInvoiceMissing(i.fin, i.returnedAt)) return { label: "Schlussrechnung fehlt", tone: "amber" };
  if (i.fin.economicOpenCents === 0) return { label: "Bezahlt", tone: "good" };
  return i.fin.paidCents > 0 ? { label: "Teilbezahlt", tone: "amber" } : { label: "Rechnung offen", tone: "amber" };
}

const HANDOVER_SELECT = { where: { correctsId: null }, select: { type: true, status: true, number: true, finalizedAt: true } } as const;

export type CaseFileHeader = Awaited<ReturnType<typeof caseFileHeader>>;

/** Kopf der Fallakte (alle Tabs). null = nicht vorhanden oder fremder Mandant (die Seite antwortet dann mit 404). */
export async function caseFileHeader(tenantId: string, caseId: string, access: CaseFileAccess, now = new Date()) {
  const c = await db.accidentReplacementCase.findFirst({
    where: { id: caseId, tenantId },
    select: {
      id: true, caseNumber: true, status: true, closedAt: true, closedByName: true, createdAt: true, bookingId: true,
      booking: {
        select: {
          id: true, number: true, status: true, startAt: true, endAt: true, actualPickupAt: true, actualReturnAt: true,
          vehicle: { select: { id: true, plate: true, make: true, model: true } },
          customer: { select: { id: true, type: true, firstName: true, lastName: true, companyName: true, phone: true } },
          contract: { select: { status: true, number: true, wizardStep: true } },
          handovers: HANDOVER_SELECT,
        },
      },
    },
  });
  if (!c) return null;
  const b = c.booking;
  // nur in der Vollsicht: Versicherung, Haftung und Finanzstand (für Kopf und Hauptstatus)
  const full = access === "FULL"
    ? await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: c.id }, select: { insurerName: true, insurerClaimNumber: true, liabilityStatus: true, liabilityQuotaPercent: true, closeReason: true } })
    : null;
  const fin = access === "FULL" ? await caseFinancials(tenantId, b.id) : null;
  const openEnd = b.endAt === null && b.status !== "RETURNED" && b.status !== "CANCELLED";
  const overdue = b.status === "ACTIVE" && b.endAt !== null && b.endAt < now;
  const liability = full ? ((full.liabilityStatus in ACCIDENT_LIABILITY_STATUS ? full.liabilityStatus : "UNKNOWN") as AccidentLiabilityStatus) : null;
  return {
    id: c.id, caseNumber: c.caseNumber, status: c.status as "OPEN" | "CLOSED", statusLabel: ACCIDENT_CASE_STATUS[c.status as keyof typeof ACCIDENT_CASE_STATUS] ?? c.status,
    closedAt: c.closedAt, closedByName: c.closedByName, closeReason: full?.closeReason ?? null, createdAt: c.createdAt,
    booking: { id: b.id, number: b.number, status: b.status, startAt: b.startAt, endAt: b.endAt, actualPickupAt: b.actualPickupAt, actualReturnAt: b.actualReturnAt, contract: b.contract, handovers: b.handovers },
    vehicle: b.vehicle,
    customer: { id: b.customer.id, name: customerName(b.customer), phone: b.customer.phone },
    insurer: full ? { name: full.insurerName, claimNumber: full.insurerClaimNumber, liability: liability!, liabilityLabel: `${ACCIDENT_LIABILITY_STATUS[liability!]}${full.liabilityQuotaPercent != null ? ` ${full.liabilityQuotaPercent} %` : ""}` } : null,
    fin,
    openEnd, overdue,
    mainStatus: caseMainStatus({ caseStatus: c.status, bookingStatus: b.status, contractSigned: b.contract?.status === "SIGNED", overdue, returnedAt: b.actualReturnAt, fin }),
  };
}

type Header = NonNullable<CaseFileHeader>;

export type CaseTariff = { dailyRateCents: Cents; items: { kind: string; label: string; perDay: boolean; unitPriceCents: Cents; quantityHundredths: number }[]; /** true = aus dem unterschriebenen Mietvertrag (eingefroren) */ frozen: boolean };

/**
 * Tarif in Cent – wie die Rechnung: Tagessatz und Positionen aus dem Preis-Schnappschuss des Vertrags (Phase E: dort eingefroren),
 * sonst Buchung bzw. Fall. Nach der Unterschrift ändern weder Fall noch Buchung den Tarif.
 */
const TARIFF_SELECT = { kind: true, label: true, perDay: true, unitPriceCents: true, quantityHundredths: true } as const;
function tariffFrom(dailyRate: unknown, contract: { status: string; priceSnapshot: unknown } | null, live: CaseTariff["items"]): CaseTariff {
  const frozenItems = contractTariffItems(contract?.priceSnapshot ?? null);
  return {
    dailyRateCents: contractDailyRateCents(contract?.priceSnapshot ?? null) ?? toCents(Number(dailyRate).toFixed(2)),
    items: frozenItems ?? live,
    frozen: contract?.status === "SIGNED" && frozenItems !== null,
  };
}
export async function caseTariff(tenantId: string, caseId: string, bookingId: string): Promise<CaseTariff> {
  const [b, live] = await Promise.all([
    db.booking.findFirstOrThrow({ where: { id: bookingId, tenantId }, select: { dailyRate: true, contract: { select: { status: true, priceSnapshot: true } } } }),
    db.accidentReplacementTariffItem.findMany({ where: { tenantId, caseId }, orderBy: { sortOrder: "asc" }, select: TARIFF_SELECT }),
  ]);
  return tariffFrom(b.dailyRate, b.contract, live);
}
/** Dasselbe für mehrere Unfallersatz-Buchungen in einer Abfrage (Listen). */
export async function accidentTariffsFor(tenantId: string, bookingIds: string[]): Promise<Map<string, CaseTariff>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db.booking.findMany({ where: { tenantId, id: { in: bookingIds }, rentalType: "ACCIDENT_REPLACEMENT" }, select: { id: true, dailyRate: true, contract: { select: { status: true, priceSnapshot: true } }, accidentCase: { select: { tariffItems: { orderBy: { sortOrder: "asc" }, select: TARIFF_SELECT } } } } });
  return new Map(rows.map((r) => [r.id, tariffFrom(r.dailyRate, r.contract, r.accidentCase?.tariffItems ?? [])]));
}

/** Mietdauer ab tatsächlicher Übergabe bis Rückgabe bzw. jetzt; vor der Übergabe keine. */
export function rentalDuration(b: { actualPickupAt: Date | null; actualReturnAt: Date | null; status: string }, now = new Date()): { days: number; running: boolean } | null {
  if (!b.actualPickupAt) return null;
  const until = b.actualReturnAt ?? now;
  return { days: until > b.actualPickupAt ? rentalDays(b.actualPickupAt, until) : 0, running: !b.actualReturnAt && b.status === "ACTIVE" };
}

/** Nächste Schritte, die auch der Hof sehen darf (ohne Versicherung, Haftung, Beträge, Wiedervorlagen). */
const OPERATIONAL_STEPS = new Set(["CONTRACT", "PICKUP", "OPEN_END", "OVERDUE", "RETURN_DUE", "RETURN_DRAFT", "CLOSED", "CANCELLED"]);
const EMPTY_FIN: CaseFinancials = { invoices: [], drafts: 0, active: 0, billedUntil: null, finalBilled: false, grossCents: 0, paidCents: 0, openCents: 0, reducedCents: 0, remainderCents: 0, doubleClaimCents: 0, doubleClaimHint: null, economicOpenCents: 0, orphanRemainderCents: 0, remainderExcessCents: 0, unresolvedReductionCents: 0, creditCents: 0, refundOpenCents: 0, feesOpenCents: 0, overbilledDays: 0, gaps: [], pickupAt: null, unbilledChargeCount: 0 };

export type FollowUpView = { id: string; title: string; dueAt: Date; due: "OVERDUE" | "TODAY" | "LATER"; status: string; assigneeName: string | null; note: string | null; createdByName: string | null; doneAt: Date | null; doneByName: string | null; doneNote: string | null };

export async function caseFileOverview(tenantId: string, h: Header, access: CaseFileAccess, now = new Date()) {
  const b = h.booking;
  const duration = rentalDuration(b, now);
  const stepCase = { id: h.id, status: h.status, bookingId: b.id };
  if (access === "OPERATIONAL") {
    // Schritte mit neutralem Platzhalter für Versicherungsangaben berechnen und nur die operativen behalten
    const steps = nextSteps({ ...stepCase, insurerName: "–", insurerClaimNumber: "–", liabilityStatus: "CONFIRMED" }, { status: b.status, endAt: b.endAt, actualReturnAt: b.actualReturnAt, contract: b.contract, handovers: b.handovers }, EMPTY_FIN, [], now)
      .filter((s) => OPERATIONAL_STEPS.has(s.code))
      // Phase E: den Mietvertrag erstellt und schließt die Disposition ab – für den Hof kein Link in den Vertragsassistenten
      .map((s) => (s.code === "CONTRACT" ? { ...s, href: undefined, text: "Der Mietvertrag wird von der Disposition erstellt und abgeschlossen. Danach ist die Übergabe möglich." } : s));
    return { access, duration, rentValue: null as RentValue | null, pricesIncludeTax: null as boolean | null, steps, followUps: [] as FollowUpView[], closeWarnings: [] as CloseWarning[], assignees: [] as { id: string; name: string }[] };
  }
  const [c, tariff, followUps, tenant, assignees] = await Promise.all([
    db.accidentReplacementCase.findUniqueOrThrow({ where: { id: h.id }, select: { insurerName: true, insurerClaimNumber: true, liabilityStatus: true } }),
    caseTariff(tenantId, h.id, b.id),
    // offene ohne Begrenzung (nie abgeschnitten), erledigte/verworfene nur die letzten
    Promise.all([
      db.caseFollowUp.findMany({ where: { tenantId, caseId: h.id, status: "OPEN" }, orderBy: { dueAt: "asc" } }),
      db.caseFollowUp.findMany({ where: { tenantId, caseId: h.id, status: { not: "OPEN" } }, orderBy: { doneAt: "desc" }, take: 50 }),
    ]).then(([openRows, doneRows]) => [...openRows, ...doneRows]),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { pricesIncludeTax: true } }),
    db.user.findMany({ where: { tenantId, active: true, role: { in: ["OWNER", "DISPO"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const value = rentValue({ from: b.actualPickupAt, until: b.actualReturnAt ?? now, dailyRateCents: tariff.dailyRateCents, items: tariff.items });
  const open = followUps.filter((f) => f.status === "OPEN");
  const steps: NextStep[] = nextSteps({ ...stepCase, ...c }, { status: b.status, endAt: b.endAt, actualReturnAt: b.actualReturnAt, contract: b.contract, handovers: b.handovers }, h.fin ?? EMPTY_FIN, open, now);
  return {
    access, duration, rentValue: value, pricesIncludeTax: tenant.pricesIncludeTax !== false, steps,
    followUps: followUps.map((f): FollowUpView => ({ id: f.id, title: f.title, dueAt: f.dueAt, due: followUpDue(f.dueAt, now), status: f.status, assigneeName: f.assigneeName, note: f.note, createdByName: f.createdByName, doneAt: f.doneAt, doneByName: f.doneByName, doneNote: f.doneNote })),
    closeWarnings: h.status === "OPEN" ? await closeWarnings(tenantId, h.id) : [],
    assignees,
  };
}

/** Schadenfall-Tab (nur Vollsicht): die Kopie im Fall und das Adressbuch zur Auswahl. */
export async function caseFileDamage(tenantId: string, caseId: string) {
  const [c, insurers, workshops, lawyers] = await Promise.all([
    db.accidentReplacementCase.findFirstOrThrow({
      where: { id: caseId, tenantId },
      select: {
        damagedPlate: true, damagedMake: true, damagedModel: true, damagedDrivable: true, damagedFirstRegistration: true, damagedVehicleClass: true, damagedLocation: true, damageKind: true,
        accidentAt: true, accidentPlace: true, opponentPlate: true, opponentName: true, policeFileNumber: true, accidentNote: true,
        insurerName: true, insurerClaimNumber: true, insurerContactName: true, insurerPhone: true, insurerEmail: true, insurerStreet: true, insurerZip: true, insurerCity: true,
        liabilityStatus: true, liabilityQuotaPercent: true, liabilityNote: true,
        workshopName: true, workshopContactName: true, workshopPhone: true, workshopEmail: true, repairStartAt: true, repairEndAt: true,
        lawyerFirm: true, lawyerContactName: true, lawyerPhone: true, lawyerEmail: true,
      },
    }),
    partnerOptions(tenantId, "INSURER"), partnerOptions(tenantId, "WORKSHOP"), partnerOptions(tenantId, "LAWYER"),
  ]);
  return { case: c, partners: { insurers, workshops, lawyers } as { insurers: PartnerOption[]; workshops: PartnerOption[]; lawyers: PartnerOption[] } };
}

/**
 * Phase E: Vertragsschritt der Fallakte – je nach Stand vorbereiten, öffnen, unterschreiben oder ansehen; immer im bestehenden
 * Vertragsassistenten (keine zweite Vertragslogik). Geschlossener Fall: nur ansehen.
 */
export type ContractStep = { kind: "PREPARE" | "OPEN" | "SIGN" | "VIEW" | "NONE"; label: string; href: string | null; text: string };
export function contractStep(caseStatus: string, b: { id: string; status: string; contract: { status: string; number: string; wizardStep?: number } | null }): ContractStep {
  const href = `/buchungen/${b.id}/vertrag`;
  const c = b.contract;
  if (!c) {
    if (caseStatus === "CLOSED" || b.status !== "RESERVED") return { kind: "NONE", label: "", href: null, text: "noch nicht angelegt" };
    return { kind: "PREPARE", label: "Vertrag vorbereiten", href, text: "noch nicht angelegt" };
  }
  if (c.status === "SIGNED") return { kind: "VIEW", label: "Vertrag ansehen", href, text: `abgeschlossen (${c.number})` };
  if (c.status === "CANCELLED") return { kind: "VIEW", label: "Vertrag ansehen", href, text: `storniert (${c.number})` };
  if (caseStatus === "CLOSED" || b.status !== "RESERVED") return { kind: "VIEW", label: "Entwurf ansehen", href, text: `Entwurf (${c.number})` };
  return (c.wizardStep ?? 1) >= 7
    ? { kind: "SIGN", label: "Vertrag unterschreiben", href: `${href}?schritt=7`, text: `Entwurf (${c.number}) – bereit zur Unterschrift` }
    : { kind: "OPEN", label: "Vertrag öffnen", href, text: `Entwurf (${c.number}) – Mietende offen, bis zur Rückgabe` };
}

export async function caseFileRental(tenantId: string, h: Header, access: CaseFileAccess, now = new Date()) {
  const b = h.booking;
  const pickup: ProcessAction = pickupAction(b, b.contract, b.handovers);
  const ret: ProcessAction = returnAction(b, b.contract, b.handovers);
  const duration = rentalDuration(b, now);
  const contract = contractStep(h.status, b);
  const canChangeEnd = access === "FULL" && h.status === "OPEN" && (b.status === "RESERVED" || b.status === "ACTIVE");
  if (access === "OPERATIONAL") return { access, pickup, ret, duration, contract, canChangeEnd, tariff: null, pricesIncludeTax: null as boolean | null };
  const [tariff, booking, tenant] = await Promise.all([
    caseTariff(tenantId, h.id, b.id),
    db.booking.findFirstOrThrow({ where: { id: b.id, tenantId }, select: { deposit: true, kmIncludedPerDay: true, extraKmRate: true, contract: true } }),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { pricesIncludeTax: true } }),
  ]);
  const items = tariff.items, rateCents = tariff.dailyRateCents;
  // Kaution und Kilometer: nach der Unterschrift der wirksame Vertragsstand (Vertrag + unterschriebene Nachträge), vorher die Buchung
  const eff = booking.contract && booking.contract.status === "SIGNED" ? await loadEffectiveContract(db, tenantId, booking.contract) : null;
  const terms = eff ? { deposit: eff.deposit, kmIncludedPerDay: eff.kmIncludedPerDay as number | null, extraKmRate: eff.extraKmRate } : booking;
  // Mietwert-Stand: vor der Übergabe keiner, während der Miete bis jetzt, nach der Rückgabe der Endwert (zentrale Formel)
  const rent: RentState = accidentRentState(b, tariff, now);
  const soFar = rent.phase === "NONE" ? null : rent.value;
  // bekanntes, noch nicht erreichtes Ende und Miete nicht beendet: voraussichtlich bis zum geplanten Ende (klar als Planwert);
  // bei überschrittenem Ende keinen Planwert, der kleiner wäre als der bisherige Mietwert
  const overdue = b.status === "ACTIVE" && !b.actualReturnAt && !!b.endAt && b.endAt < now;
  const planned = b.endAt && !b.actualReturnAt && b.status !== "CANCELLED" && !overdue ? rentValue({ from: b.actualPickupAt ?? b.startAt, until: b.endAt, dailyRateCents: rateCents, items }) : null;
  return {
    access, pickup, ret, duration, contract, canChangeEnd, pricesIncludeTax: tenant.pricesIncludeTax !== false,
    tariff: {
      dailyRateCents: rateCents, items, frozen: tariff.frozen,
      perDayCents: rateCents + items.filter((i) => i.perDay).reduce((s, i) => s + i.unitPriceCents, 0),
      depositCents: toCents(Number(terms.deposit).toFixed(2)), kmIncludedPerDay: terms.kmIncludedPerDay, extraKmRateCents: terms.extraKmRate != null ? toCents(Number(terms.extraKmRate).toFixed(2)) : null,
      kmFromContract: !!eff,
      rent, soFar, planned, overdue,
    },
  };
}

/** Dokumente, die der Hof sehen darf (Vertragsunterlagen); Belege mit Beträgen nur in der Vollsicht. */
const OPERATIONAL_DOCUMENTS = new Set(["RENTAL_CONTRACT", "PICKUP_PROTOCOL", "RETURN_PROTOCOL", "CONTRACT_AMENDMENT", "KEY_DROP_CONFIRMATION"]);

export type CaseDocumentView = {
  id: string; type: string; typeLabel: string; fileName: string; note: string | null; createdAt: Date; createdByName: string | null; sizeBytes: number; contentType: string;
  archivedAt: Date | null; archivedByName: string | null; archiveReason: string | null;
  /** verknüpfte Kürzungen (Versichererschreiben) */
  adjustments: { id: string; amountCents: Cents; status: string; reasonLabel: string; invoiceNumber: string | null }[];
};

/**
 * Phase F: Dokumente der Fallakte, gruppiert. Vertragsunterlagen (Mietvertrag, Protokolle, Nachträge) für alle Sichten; in der
 * Vollsicht zusätzlich Rechnungsbelege und die hochgeladenen Unfallersatz-Dokumente (Abtretung/Sonstiges, Versicherung) mit
 * archivierten Einträgen (sichtbar und abrufbar, gekennzeichnet). Fall-Dokumente lädt die operative Sicht gar nicht erst.
 */
export async function caseFileDocuments(tenantId: string, h: Header, access: CaseFileAccess) {
  const docs = await db.document.findMany({ where: { tenantId, bookingId: h.booking.id, ...(access === "OPERATIONAL" ? { type: { in: [...OPERATIONAL_DOCUMENTS] } } : {}) }, orderBy: [{ type: "asc" }, { version: "desc" }], select: { id: true, type: true, version: true, fileName: true, createdAt: true } });
  const caseDocs = access === "FULL" ? await db.accidentReplacementCaseDocument.findMany({
    where: { tenantId, caseId: h.id }, orderBy: { createdAt: "desc" },
    select: { id: true, type: true, fileName: true, note: true, createdAt: true, createdByName: true, sizeBytes: true, contentType: true, archivedAt: true, archivedByName: true, archiveReason: true, adjustments: { orderBy: { createdAt: "asc" }, select: { id: true, amountCents: true, status: true, reasonKind: true, invoice: { select: { number: true } } } } },
  }) : [];
  const view = (d: (typeof caseDocs)[number]): CaseDocumentView => ({
    id: d.id, type: d.type, typeLabel: ACCIDENT_CASE_DOCUMENT_TYPES[d.type as keyof typeof ACCIDENT_CASE_DOCUMENT_TYPES] ?? "Dokument", fileName: d.fileName, note: d.note, createdAt: d.createdAt, createdByName: d.createdByName,
    sizeBytes: d.sizeBytes, contentType: d.contentType, archivedAt: d.archivedAt, archivedByName: d.archivedByName, archiveReason: d.archiveReason,
    adjustments: d.adjustments.map((a) => ({ id: a.id, amountCents: a.amountCents, status: a.status, reasonLabel: INVOICE_ADJUSTMENT_REASONS[a.reasonKind as keyof typeof INVOICE_ADJUSTMENT_REASONS] ?? a.reasonKind, invoiceNumber: a.invoice.number })),
  });
  const all = caseDocs.map(view);
  const active = all.filter((d) => !d.archivedAt);
  const withLabel = docs.map((d) => ({ ...d, typeLabel: DOCUMENT_TYPES[d.type as keyof typeof DOCUMENT_TYPES] ?? "Dokument" }));
  return {
    access, caseOpen: h.status === "OPEN",
    /** Mietvertrag, Übergabe-/Rückgabeprotokoll, Nachträge (und Schlüsselbox-Bestätigung) */
    contract: withLabel.filter((d) => OPERATIONAL_DOCUMENTS.has(d.type)),
    /** Rechnungen, Gutschriften, Mahnungen, Belege – nur Vollsicht */
    billing: withLabel.filter((d) => !OPERATIONAL_DOCUMENTS.has(d.type)),
    /** Abtretung/Zahlungsanweisung und sonstige Fallunterlagen */
    accident: active.filter((d) => d.type !== "INSURER_LETTER"),
    /** Versichererschreiben */
    insurer: active.filter((d) => d.type === "INSURER_LETTER"),
    archived: all.filter((d) => !!d.archivedAt),
    /** alle erzeugten Unterlagen der Buchung bzw. alle Fall-Dokumente (auch archivierte) – für Listen und Tests */
    documents: withLabel,
    caseDocuments: all,
  };
}

export type BillingFlag = { label: string; tone: Tone };

/**
 * Phase F: Abrechnungsstatus aus echten Daten – mehrere Merkmale gleichzeitig möglich (kein gepflegter Status):
 * noch nicht/teilweise abgerechnet bzw. schlussgerechnet, Entwurf, offen/teilbezahlt/bezahlt, Kürzung, Restforderung, Doppelforderung.
 */
export function billingFlags(fin: CaseFinancials, b: { status: string; actualPickupAt: Date | null; actualReturnAt: Date | null }): BillingFlag[] {
  const out: BillingFlag[] = [];
  const service = fin.invoices.filter((i) => !i.neutralized && i.billingType !== "REMAINDER");
  if (service.length === 0) out.push({ label: "Noch nicht abgerechnet", tone: b.status === "RETURNED" ? "amber" : "grey" });
  else if (fin.finalBilled) out.push({ label: "Schlussgerechnet", tone: "good" });
  else if (b.status === "RETURNED" && !finalInvoiceMissing(fin, b.actualReturnAt)) out.push({ label: "Vollständig abgerechnet", tone: "good" });
  else out.push({ label: fin.billedUntil ? `Teilweise abgerechnet (bis ${fmtDate(fin.billedUntil)})` : "Teilweise abgerechnet", tone: "info" });
  if (fin.drafts > 0) out.push({ label: fin.drafts === 1 ? "Entwurf offen" : `${fin.drafts} Entwürfe offen`, tone: "amber" });
  if (fin.active > 0) {
    if (fin.economicOpenCents === 0 && fin.openCents === 0) out.push({ label: "Bezahlt", tone: "good" });
    else if (fin.paidCents > 0) out.push({ label: "Teilbezahlt", tone: "amber" });
    else out.push({ label: "Offen", tone: "amber" });
  }
  if (fin.reducedCents > 0) out.push({ label: "Kürzung dokumentiert", tone: "info" });
  if (fin.remainderCents > 0) out.push({ label: "Restforderung an Mieter", tone: "info" });
  if (fin.doubleClaimCents > 0) out.push({ label: "Doppelt gefordert", tone: "bad" });
  if (fin.orphanRemainderCents > 0 || fin.remainderExcessCents > 0) out.push({ label: "Restforderung prüfen", tone: "bad" });
  if (fin.refundOpenCents > 0) out.push({ label: "Guthaben offen", tone: "bad" });
  if (fin.feesOpenCents > 0) out.push({ label: "Mahngebühren offen", tone: "amber" });
  if (fin.overbilledDays > 0) out.push({ label: "Über die Rückgabe hinaus berechnet", tone: "bad" });
  if (fin.gaps.length > 0) out.push({ label: "Lücke in der Abrechnung", tone: "bad" });
  return out;
}

/**
 * Abrechnung (nur Vollsicht): Finanzübersicht des Falls (zentrale Saldenquelle je Rechnung, keine Verrechnung von Kürzungen),
 * Rechnungen mit Zahlungen, Kürzungen und Restforderungen, Entwürfe und die tatsächlich möglichen Aktionen.
 */
export async function caseFileBilling(tenantId: string, h: Header, now = new Date()) {
  const fin = h.fin ?? (await caseFinancials(tenantId, h.booking.id));
  const b = h.booking;
  const open = h.status === "OPEN";
  const [chain, c, letters, contract, details] = await Promise.all([
    accidentInvoiceChain(db, tenantId, b.id, { pickupAt: b.actualPickupAt }),
    db.accidentReplacementCase.findUniqueOrThrow({ where: { id: h.id }, select: { insurerName: true, insurerEmail: true, insurerStreet: true, insurerZip: true, insurerCity: true, insurerClaimNumber: true } }),
    db.accidentReplacementCaseDocument.findMany({ where: { tenantId, caseId: h.id, type: "INSURER_LETTER", archivedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, fileName: true, createdAt: true } }),
    db.rentalContract.findFirst({ where: { tenantId, bookingId: b.id }, select: { customerSnapshot: true } }),
    Promise.all(fin.invoices.map(async (i) => {
      const [payments, adjustments, version] = await Promise.all([
        db.payment.findMany({ where: { tenantId, invoiceId: i.id }, orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }], select: { id: true, type: true, amountCents: true, paidAt: true, method: true, status: true, reference: true, createdByName: true, cancelledAt: true, cancelledByName: true, cancellationReason: true } }),
        db.invoiceAdjustment.findMany({ where: { tenantId, invoiceId: i.id }, orderBy: { createdAt: "desc" }, select: { id: true, amountCents: true, reasonKind: true, status: true, decidedAt: true, note: true, createdByName: true, createdAt: true, cancelledAt: true, cancelledByName: true, cancellationReason: true, document: { select: { id: true, fileName: true, archivedAt: true } } } }),
        db.invoice.findUniqueOrThrow({ where: { id: i.id }, select: { currentVersion: { select: { customerSnapshot: true } } } }),
      ]);
      const snap = version.currentVersion?.customerSnapshot as { email?: string | null; companyName?: string | null; firstName?: string; lastName?: string; type?: string } | null;
      return { invoiceId: i.id, payments, adjustments, recipientName: snap ? (snap.type === "COMPANY" && snap.companyName ? snap.companyName : `${snap.firstName ?? ""} ${snap.lastName ?? ""}`.trim()) : "", recipientEmail: snap?.email?.trim() || null };
    })),
  ]);
  const hasDraft = chain.drafts.length > 0;
  const pickupDone = !!b.actualPickupAt;
  const returned = b.status === "RETURNED";
  // Zwischenrechnung nur, wenn seit dem zuletzt Abgerechneten ein neuer Miettag begonnen hat und keine Schlüsselbox-Abgabe gemeldet ist
  const priorDays = b.actualPickupAt && fin.billedUntil && fin.billedUntil > b.actualPickupAt ? rentalDays(b.actualPickupAt, fin.billedUntil) : 0;
  const keyDropReported = b.status === "ACTIVE" && (await db.keyDropReturn.count({ where: { tenantId, bookingId: b.id, status: "CUSTOMER_CONFIRMED" } })) > 0;
  const nextBillableAt = b.actualPickupAt && priorDays > 0 ? nextRentalDayStart(b.actualPickupAt, priorDays) : null;
  const interimPossible = b.status === "ACTIVE" && pickupDone && !keyDropReported && (!nextBillableAt || nextBillableAt <= now);
  const canInterim = open && !hasDraft && interimPossible;
  // Schlussrechnung: nach der Rückgabe, solange Miettage oder Zusatzkosten offen sind (nicht, wenn Zwischenrechnungen schon alles abdecken)
  const canFinal = open && !hasDraft && returned && pickupDone && !fin.finalBilled && (chain.service.length === 0 || finalInvoiceMissing(fin, b.actualReturnAt));
  // Vorschau der Schlussrechnung – dieselbe Rechnung wie beim Erstellen (Fehler als Hinweis, nie als Absturz)
  let finalPreview: AccidentInvoicePreview | null = null, finalPreviewError: string | null = null;
  if (canFinal) {
    try { finalPreview = await previewAccidentInvoice(tenantId, { caseId: h.id }); } catch (e) { finalPreviewError = e instanceof DomainError ? e.message : "Die Vorschau konnte nicht berechnet werden."; }
  }
  const renterSnap = contract?.customerSnapshot as { email?: string | null; firstName?: string; lastName?: string; companyName?: string | null; type?: string } | null;
  const reductionsOf = (invoiceId: string) => fin.invoices.find((x) => x.id === invoiceId)?.reducedCents ?? 0;
  const claimedFor = (invoiceId: string) => chain.invoices.filter((x) => x.billing?.type === "REMAINDER" && x.billing.remainderOf?.invoiceId === invoiceId && (x.effective || x.status === "DRAFT")).reduce((s, x) => s + x.grossCents, 0);
  return {
    fin, open, flags: billingFlags(fin, b),
    actions: {
      hasDraft, canInterim, canFinal, fullyBilled: fin.finalBilled || (returned && chain.service.length > 0 && !finalInvoiceMissing(fin, b.actualReturnAt)),
      interimMin: toDateTimeInputValue(nextBillableAt ?? b.actualPickupAt ?? now),
      interimBlockedReason: !open || hasDraft || b.status !== "ACTIVE" || !pickupDone ? null : keyDropReported ? "Die Rückgabe per Schlüsselbox ist gemeldet. Bitte zuerst die Rückgabe kontrollieren und abschließen; abgerechnet wird dann mit der Schlussrechnung." : nextBillableAt && nextBillableAt > now ? `Die Miettage bis ${fmtDateTime(new Date(nextBillableAt.getTime() - 60_000))} sind bereits abgerechnet. Die nächste Zwischenrechnung ist ab ${fmtDateTime(nextBillableAt)} möglich.` : null,
      interimMax: toDateTimeInputValue(now),
      finalPreview, finalPreviewError,
    },
    recipients: {
      insurer: { name: c.insurerName, hasEmail: !!c.insurerEmail?.trim(), hasAddress: !!(c.insurerStreet && c.insurerZip && c.insurerCity), claimNumber: c.insurerClaimNumber },
      renter: { name: renterSnap ? (renterSnap.type === "COMPANY" && renterSnap.companyName ? renterSnap.companyName : `${renterSnap.firstName ?? ""} ${renterSnap.lastName ?? ""}`.trim()) : h.customer.name, hasEmail: !!renterSnap?.email?.trim() },
    },
    letters,
    invoices: fin.invoices.map((i) => {
      const d = details.find((x) => x.invoiceId === i.id)!;
      const remainderAvailableCents = i.recipientRole === "INSURER" && i.billingType !== "REMAINDER" && !i.neutralized ? Math.max(0, Math.min(reductionsOf(i.id), Math.max(0, i.invoiceCents - i.paidCents)) - claimedFor(i.id)) : 0;
      return {
        ...i,
        roleLabel: INVOICE_RECIPIENT_ROLES[i.recipientRole as keyof typeof INVOICE_RECIPIENT_ROLES] ?? INVOICE_RECIPIENT_ROLES.RENTER,
        typeLabel: i.billingType ? ACCIDENT_BILLING_TYPES[i.billingType] : "Rechnung",
        paymentStatusLabel: INVOICE_PAYMENT_STATUS[i.paymentStatus as keyof typeof INVOICE_PAYMENT_STATUS] ?? i.paymentStatus,
        recipientName: d.recipientName, recipientEmail: d.recipientEmail,
        payments: d.payments,
        adjustments: d.adjustments.map((a) => ({ ...a, reasonLabel: INVOICE_ADJUSTMENT_REASONS[a.reasonKind as keyof typeof INVOICE_ADJUSTMENT_REASONS] ?? a.reasonKind })),
        /** Kürzung möglich: Versicherungsrechnung, wirksam, noch nicht vollständig gekürzt */
        adjustableCents: i.recipientRole === "INSURER" && i.billingType !== "REMAINDER" && !i.neutralized ? Math.max(0, i.invoiceCents - i.reducedCents) : 0,
        remainderAvailableCents,
        remainders: fin.invoices.filter((r) => r.remainderOfId === i.id).map((r) => ({ id: r.id, number: r.number, grossCents: r.grossCents, openCents: r.openCents, neutralized: r.neutralized })),
      };
    }),
    drafts: chain.drafts.map((d) => ({ id: d.id, createdAt: d.createdAt, grossCents: d.grossCents, roleLabel: INVOICE_RECIPIENT_ROLES[d.role] ?? INVOICE_RECIPIENT_ROLES.RENTER, typeLabel: d.billing ? ACCIDENT_BILLING_TYPES[d.billing.type] : "Rechnung", periodStart: d.periodStart, periodEnd: d.periodEnd })),
    gaps: fin.gaps,
    /** Hinweise aus dem Finanzstand (dieselben wie Abschluss und nächste Schritte) */
    warnings: financeWarnings(fin),
  };
}

/** Verlaufseinträge, die der Hof sehen darf – ohne Gründe und Notizen (die können Versicherungsinhalte tragen). */
const OPERATIONAL_EVENTS = new Set<AccidentCaseEventType>(["CREATED", "PLANNED_END_CHANGED", "VEHICLE_PICKED_UP", "VEHICLE_RETURNED", "CLOSED", "REOPENED"]);

/** Gespeicherte Schlüssel in alt/neu in Klartext (Dokumenttyp, Kürzungsgrund, Rechnungsempfänger, Fallstatus). */
function valueText(type: string, v: string | null): string | null {
  if (!v) return null;
  if (type === "DOCUMENT_ADDED" || type === "DOCUMENT_ARCHIVED") return ACCIDENT_CASE_DOCUMENT_TYPES[v as keyof typeof ACCIDENT_CASE_DOCUMENT_TYPES] ?? v;
  if (type === "ADJUSTMENT_RECORDED" || type === "ADJUSTMENT_CANCELLED") return INVOICE_ADJUSTMENT_REASONS[v as keyof typeof INVOICE_ADJUSTMENT_REASONS] ?? v;
  if (type === "INVOICE_CREATED") return INVOICE_RECIPIENT_ROLES[v as keyof typeof INVOICE_RECIPIENT_ROLES] ?? v;
  if (type === "CLOSED" || type === "REOPENED" || type === "CREATED") return ACCIDENT_CASE_STATUS[v as keyof typeof ACCIDENT_CASE_STATUS] ?? v;
  return v;
}

/** Ältere Abschluss-Notizen nannten die offenen Punkte als Codes – im Verlauf immer als Klartext. */
const CLOSE_CODE_TEXT: Record<string, string> = {
  RENTAL_RUNNING: "Miete lief noch", NO_RETURN: "kein Rückgabeprotokoll", NO_INVOICE: "keine wirksame Rechnung", INVOICE_DRAFT: "Rechnungsentwurf offen",
  FINAL_INVOICE_MISSING: "Schlussrechnung fehlte", OPEN_AMOUNT: "offener Rechnungsbetrag", FOLLOW_UPS: "offene Wiedervorlagen", LIABILITY_OPEN: "Haftung ungeklärt",
  REDUCTION_OPEN: "Kürzung ohne Gutschrift oder Restforderung", DOUBLE_CLAIM: "Betrag doppelt gestellt", DOUBLE_CLAIM_PAID: "Restforderung bezahlt, Versicherungsrechnung noch offen", BILLING_GAP: "Lücke in der Abrechnung",
};
const closeNoteText = (note: string | null) => (note ? note.replace(/\b[A-Z][A-Z_]{3,}\b/g, (code) => CLOSE_CODE_TEXT[code] ?? code) : null);

export type HistoryEntry ={ id: string; at: Date; label: string; userName: string | null; from: string | null; to: string | null; reason: string | null; note: string | null };

export async function caseFileHistory(tenantId: string, caseId: string, access: CaseFileAccess): Promise<HistoryEntry[]> {
  const events = await db.accidentReplacementCaseEvent.findMany({
    where: { tenantId, caseId, ...(access === "OPERATIONAL" ? { type: { in: [...OPERATIONAL_EVENTS] } } : {}) },
    orderBy: { createdAt: "desc" }, take: 300,
    select: { id: true, type: true, createdAt: true, userName: true, fromValue: true, toValue: true, reason: true, note: true },
  });
  const full = access === "FULL";
  return events.map((e) => ({
    id: e.id, at: e.createdAt, label: ACCIDENT_CASE_EVENT_TYPES[e.type as AccidentCaseEventType] ?? "Eintrag", userName: e.userName,
    // operativ: beim Abschluss keine Codes der offenen Punkte, nur „Offen → Abgeschlossen“
    from: valueText(e.type, e.fromValue), to: valueText(e.type, e.toValue),
    reason: full ? e.reason : null, note: full ? (e.type === "CLOSED" ? closeNoteText(e.note) : e.note) : e.type === "VEHICLE_PICKED_UP" || e.type === "VEHICLE_RETURNED" ? e.note : null,
  }));
}

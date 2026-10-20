// Befehl 29.7: Übergabe- und Rückgabezentrale – zwei Arbeitslisten (/uebergaben, /rueckgaben) über den bestehenden
// Übergabe- und Rückgabeassistenten. Nur Lesen: keine Server Action, keine schreibende Funktion, keine neue Geschäftsregel.
// Alle Bedingungen stehen hier zentral – Liste, Kennzahlen und Menü-Zähler (nav-badges.ts) nutzen dieselben Bausteine.
// Kalendertage gelten in Europe/Berlin, Intervalle sind halboffen [start, end); keine 24-Stunden-Pauschalen.
//
// Festgelegte Entscheidungen (Plan 29.7, Abschnitt 10):
//   E1  Rückgabe überfällig = isOverdue (vereinbarte, noch nicht unterschriebene Verlängerung zählt) ohne gemeldete
//       Schlüsselbox-Rückgabe – gemeinsam für Liste, Kennzahl und Zähler. /heute und Dashboard bleiben unverändert (G1).
//   E2a Unfallersatz ist nie „überfällig“ (Vertrag bis zur Rückgabe); das geplante Ende wirkt als Disposition in Heute/Anstehend,
//       „Offenes Mietende“ zeigt alle laufenden Unfallersatzmieten.
//   E3  Übergabe überfällig = reserviert mit Abholtermin vor dem Berliner Tagesbeginn, ohne Zeitgrenze, Ton Hinweis (amber).
//       Sortierung auf den Auftrag (Abschnitt 8) ausgerichtet: älteste überfällige zuerst (startAt aufsteigend, dann number, id).
//   E4  „Heute geplant“ = der ganze Berliner Tag, auch bereits verstrichene Zeiten (Überschneidung mit „Überfällig“ wie im Dashboard).
//   E5b „Nächste 7 Tage“ = [morgen, morgen + SOON_DAYS) – dieselbe Menge wie „Anstehend“ mit bis = heute + SOON_DAYS.
//   E6  Schlüsselbox gemeldet (CUSTOMER_CONFIRMED) steht immer in „Heute“ (Kontrolle ausstehend), auch bei offenem Ende;
//       vereinbart (AUTHORIZED) ergibt für den Hof keine Startaktion.
//   E7  Abgeschlossene Rückgabe per Schlüsselbox: tatsächliches Datum = actualReturnAt (Kundenabgabe), Sortierung/Filter nach finalizedAt.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { bookingStage, pickupAction, returnAction, type HandoverRef } from "@/lib/booking-status";
import { AGREED_EXTENSION_SELECT, agreedEndOf, isOverdue, operationalEnd, vehicleStatusProblem } from "@/lib/bookings";
import { roleAllows } from "@/lib/constants";
import { SOON_DAYS } from "@/lib/dashboard";
import { pickupDriverCheckStatus, type PickupDriverCheckStatus } from "@/lib/driver-verification";
import { customerName, fmtDate, fmtDateTime, fmtTime } from "@/lib/format";
import { bookingSearchWhere, cleanQuery, customerSearchWhere, SEARCH_MAX } from "@/lib/search";
import { parseLocalDateTime, toDateInputValue, zonedDayRange, zonedDayStartPlus, zonedDaysBetween } from "@/lib/time";

type Client = typeof db;

// ---------------------------------------------------------------------------
// Arten, Filter, Adresse
// ---------------------------------------------------------------------------

export type CenterKind = "PICKUP" | "RETURN";
export const CENTER_PATH: Record<CenterKind, string> = { PICKUP: "/uebergaben", RETURN: "/rueckgaben" };

export const CENTER_FILTERS = {
  heute: "Heute",
  ueberfaellig: "Überfällig",
  anstehend: "Anstehend",
  in_bearbeitung: "In Bearbeitung",
  offenes_ende: "Offenes Mietende",
  abgeschlossen: "Abgeschlossen",
} as const;
export type CenterFilter = keyof typeof CENTER_FILTERS;

const PICKUP_FILTERS: readonly CenterFilter[] = ["heute", "ueberfaellig", "anstehend", "in_bearbeitung", "abgeschlossen"];
const RETURN_FILTERS: readonly CenterFilter[] = ["heute", "ueberfaellig", "anstehend", "in_bearbeitung", "offenes_ende", "abgeschlossen"];

/** Filter der jeweiligen Seite in Anzeigereihenfolge („Offenes Mietende“ nur bei Rückgaben). */
export function centerFilters(kind: CenterKind): readonly CenterFilter[] {
  return kind === "PICKUP" ? PICKUP_FILTERS : RETURN_FILTERS;
}

/** Ungültiger oder fremder Filter (z. B. offenes_ende auf /uebergaben) fällt auf „Heute“ zurück. */
export function resolveFilter(kind: CenterKind, raw: unknown): CenterFilter {
  return typeof raw === "string" && (centerFilters(kind) as readonly string[]).includes(raw) ? (raw as CenterFilter) : "heute";
}

/** Nur „Anstehend“ (Termin) und „Abgeschlossen“ (Protokollabschluss) kennen einen Datumsfilter. */
export const usesDates = (f: CenterFilter) => f === "anstehend" || f === "abgeschlossen";

export const CENTER_PAGE_SIZE = 30;
/** Obergrenze für den Seitenparameter vor jeder Rechnung (danach wird auf die vorhandenen Seiten geklammert). */
export const PAGE_PARAM_MAX = 10_000;
/** Erlaubter Bereich der Datumsfelder (auch als min/max am <input type="date">). */
export const DAY_PARAM_MIN = "2000-01-01";
export const DAY_PARAM_MAX = "2099-12-31";

/** Seite aus der Adresse: Ganzzahl in [1, PAGE_PARAM_MAX]; alles andere ist Seite 1. */
export function parsePageParam(v: unknown): number {
  const n = typeof v === "number" ? Math.trunc(v) : typeof v === "string" ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, PAGE_PARAM_MAX);
}

/** Kalendertag „JJJJ-MM-TT“ (nur 2000–2099) als Beginn dieses Tages in Europe/Berlin; ungültig = null. */
export function parseDayParam(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const d = parseLocalDateTime(`${m[1]}-${m[2]}-${m[3]}T00:00`);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export type DayRange = { von: string; bis: string; from: Date | null; toExclusive: Date | null; invalid: boolean };
const NO_RANGE: DayRange = { von: "", bis: "", from: null, toExclusive: null, invalid: false };

/**
 * von/bis (bis einschließlich) gemeinsam geprüft: bis wird zum Beginn des Folgetags (exklusive Grenze, über Zeitumstellungen
 * hinweg korrekt, ohne 24-h-Rechnung). Ist ein Wert ungültig oder von > bis, wird der Datumsfilter ganz ignoriert (invalid).
 * Leere Werte gelten als nicht gesetzt.
 */
export function resolveDayRange(rawVon: unknown, rawBis: unknown): DayRange {
  const vonS = typeof rawVon === "string" ? rawVon.trim() : "";
  const bisS = typeof rawBis === "string" ? rawBis.trim() : "";
  if (!vonS && !bisS) return NO_RANGE;
  const from = vonS ? parseDayParam(vonS) : null;
  const bisDay = bisS ? parseDayParam(bisS) : null;
  let toExclusive: Date | null = null;
  if (bisDay) {
    try {
      const x = zonedDayStartPlus(bisDay, 1);
      toExclusive = x && !Number.isNaN(x.getTime()) ? x : null;
    } catch {
      toExclusive = null;
    }
  }
  const bad = (vonS !== "" && !from) || (bisS !== "" && !toExclusive) || (from !== null && toExclusive !== null && from >= toExclusive);
  if (bad) return { ...NO_RANGE, invalid: true };
  return { von: from ? vonS : "", bis: toExclusive ? bisS : "", from, toExclusive, invalid: false };
}

export type CenterState = { filter: CenterFilter; q: string; von: string; bis: string };

/**
 * Adresse einer Ansicht (wie qs() der Unfallersatz-Zentrale): Standardwerte entfallen (filter=heute, leere Suche, Seite 1),
 * jede Änderung von Filter, Suche oder Datum beginnt wieder auf Seite 1. Datumswerte gelten nur für ihren Filter.
 */
export function centerHref(kind: CenterKind, state: CenterState, over: Partial<CenterState> & { seite?: number } = {}): string {
  const filter = over.filter ?? state.filter;
  const filterChanged = over.filter !== undefined && over.filter !== state.filter;
  const q = over.q !== undefined ? over.q : state.q;
  const dated = usesDates(filter);
  const von = !dated ? "" : over.von !== undefined ? over.von : filterChanged ? "" : state.von;
  const bis = !dated ? "" : over.bis !== undefined ? over.bis : filterChanged ? "" : state.bis;
  const p = new URLSearchParams();
  if (filter !== "heute") p.set("filter", filter);
  if (q) p.set("q", q);
  if (von) p.set("von", von);
  if (bis) p.set("bis", bis);
  if (over.seite && over.seite > 1) p.set("seite", String(over.seite));
  const s = p.toString();
  return s ? `${CENTER_PATH[kind]}?${s}` : CENTER_PATH[kind];
}

// ---------------------------------------------------------------------------
// Zeitgrenzen
// ---------------------------------------------------------------------------

export type CenterBounds = {
  now: Date;
  /** Berliner Kalendertag von now, halboffen */
  start: Date;
  end: Date;
  /** E5b: Ende des 7-Tage-Fensters [morgen, morgen + SOON_DAYS) */
  soonEnd: Date;
  /** letzter Kalendertag des Fensters (für „bis einschließlich“ in der Adresse) */
  soonUntil: Date;
};

export function centerBounds(now: Date): CenterBounds {
  const { start, end } = zonedDayRange(now);
  return { now, start, end, soonEnd: zonedDayStartPlus(now, SOON_DAYS + 1), soonUntil: zonedDayStartPlus(now, SOON_DAYS) };
}

// ---------------------------------------------------------------------------
// Bedingungen (tenantId in jedem verschachtelten Filter, damit die Indizes greifen)
// ---------------------------------------------------------------------------

const ACCIDENT = "ACCIDENT_REPLACEMENT";
const STANDARD: Prisma.BookingWhereInput = { rentalType: { not: ACCIDENT } };
const agreedEndGte = (T: string, d: Date): Prisma.BookingWhereInput => ({ contractAmendments: { some: { tenantId: T, status: "AGREED", newEndAt: { gte: d } } } });

/**
 * Operatives Ende (operationalEnd: max(endAt, vereinbartes Ende)) im halboffenen Bereich [from, to) – exakt, weil es je Vertrag
 * höchstens eine vereinbarte Änderung gibt (rb_amendment_one_agreed):
 *   max(endAt, agreed) < to  ⇔ endAt < to und keine AGREED-Zeile mit newEndAt ≥ to
 *   max(endAt, agreed) ≥ from ⇔ endAt ≥ from oder agreed ≥ from
 * Offenes Ende (endAt null) liegt in keinem Bereich. Eine Verkürzung wirkt operativ nicht (wie operationalEnd).
 */
export function operationalEndWhere(T: string, from: Date | null, to: Date | null): Prisma.BookingWhereInput {
  return {
    AND: [
      { endAt: { not: null } },
      ...(to ? [{ endAt: { lt: to } }, { contractAmendments: { none: { tenantId: T, status: "AGREED", newEndAt: { gte: to } } } }] : []),
      ...(from ? [{ OR: [{ endAt: { gte: from } }, agreedEndGte(T, from)] }] : []),
    ],
  };
}

/** Vom Kunden gemeldete kontaktlose Rückgabe (Kontrolle ausstehend). */
export const keyDropReported = (T: string): Prisma.BookingWhereInput => ({ keyDropReturns: { some: { tenantId: T, status: "CUSTOMER_CONFIRMED" } } });
export const keyDropNotReported = (T: string): Prisma.BookingWhereInput => ({ keyDropReturns: { none: { tenantId: T, status: "CUSTOMER_CONFIRMED" } } });

type DayWindow = { start: Date; end: Date };

/** Übergaben heute – identisch mit dem Zähler „Abholungen heute“ (nav-badges) und dem Dashboard. */
export const pickupsTodayWhere = (T: string, b: DayWindow): Prisma.BookingWhereInput => ({ tenantId: T, status: "RESERVED", startAt: { gte: b.start, lt: b.end } });
/** E3: reserviert, Abholtermin vor dem Berliner Tagesbeginn – ohne Zeitgrenze. */
export const pickupsOverdueWhere = (T: string, b: DayWindow): Prisma.BookingWhereInput => ({ tenantId: T, status: "RESERVED", startAt: { lt: b.start } });
export const pickupsUpcomingWhere = (T: string, from: Date, to: Date | null): Prisma.BookingWhereInput => ({ tenantId: T, status: "RESERVED", startAt: { gte: from, ...(to ? { lt: to } : {}) } });

/** E4/E6: operatives Ende heute (ganzer Tag) oder Schlüsselbox-Rückgabe gemeldet (unabhängig vom Ende, auch offenes Ende). */
export const returnsTodayWhere = (T: string, b: DayWindow): Prisma.BookingWhereInput => ({ tenantId: T, status: "ACTIVE", OR: [operationalEndWhere(T, b.start, b.end), keyDropReported(T)] });
/** E1/E2a: isOverdue ohne gemeldete Schlüsselbox-Rückgabe und ohne Unfallersatz. */
export const returnsOverdueWhere = (T: string, now: Date): Prisma.BookingWhereInput => ({ tenantId: T, status: "ACTIVE", ...STANDARD, AND: [operationalEndWhere(T, null, now), keyDropNotReported(T)] });
export const returnsUpcomingWhere = (T: string, from: Date, to: Date | null): Prisma.BookingWhereInput => ({ tenantId: T, status: "ACTIVE", AND: [operationalEndWhere(T, from, to), keyDropNotReported(T)] });
/** Alle laufenden Unfallersatzmieten (Vertrag „bis zur Rückgabe“), offenes oder geplantes Ende. */
export const openEndWhere = (T: string): Prisma.BookingWhereInput => ({ tenantId: T, status: "ACTIVE", rentalType: ACCIDENT });

/** Menü-Zähler /rueckgaben: |heute ∪ überfällig| in einer Abfrage. */
export function returnsTodayOrOverdueWhere(T: string, now: Date): Prisma.BookingWhereInput {
  const b = zonedDayRange(now);
  return {
    tenantId: T,
    status: "ACTIVE",
    OR: [
      { OR: [operationalEndWhere(T, b.start, b.end), keyDropReported(T)] },
      { ...STANDARD, AND: [operationalEndWhere(T, null, now), keyDropNotReported(T)] },
    ],
  };
}

/** Begonnene Protokolle (ohne Korrekturprotokolle) einer offenen Buchung. Ein Storno löscht Übergabeentwürfe. */
export const draftsWhere = (T: string, kind: CenterKind): Prisma.HandoverWhereInput => ({
  tenantId: T, type: kind, status: "DRAFT", correctsId: null, booking: { is: { tenantId: T, status: kind === "PICKUP" ? "RESERVED" : "ACTIVE" } },
});
/** Abgeschlossene Protokolle (ohne Korrekturprotokolle), optional nach Abschlusszeitpunkt. */
export const finalizedWhere = (T: string, kind: CenterKind, from: Date | null, to: Date | null): Prisma.HandoverWhereInput => ({
  tenantId: T, type: kind, status: "FINALIZED", correctsId: null,
  ...(from || to ? { finalizedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
});

// ---------------------------------------------------------------------------
// Zeilenstatus, Aktionen, Hinweise (reine Funktionen)
// ---------------------------------------------------------------------------

export type CenterTone = "good" | "amber" | "bad" | "info" | "grey";
export type CenterStatus = { label: string; tone: CenterTone; detail: string | null };
export type CenterHint = { text: string; tone: CenterTone };
export type CenterChip = { label: string; tone: CenterTone };
export type CenterLink = { label: string; href: string };
export type CenterViewer = { role: string; support: boolean };

const days = (n: number) => `${n} ${n === 1 ? "Tag" : "Tagen"}`;
const at = (d: Date) => `${fmtDate(d)} ${fmtTime(d)}`;

/** Geschlossener Unfallersatzfall: Übergabe, Rückgabe und Vertrag sind gesperrt (G14: die Zeile bleibt gelistet). */
export const CASE_LOCKED_CHIP = "Fall abgeschlossen – gesperrt (in der Fallakte wieder öffnen)";

/** Zeilenstatus einer Übergabe (Text, nicht nur Farbe). */
export function pickupRowStatus(i: { startAt: Date; handovers: HandoverRef[]; agreedStartAt?: Date | null }, b: Pick<CenterBounds, "now" | "start" | "end">): CenterStatus {
  if (i.handovers.some((h) => h.type === "PICKUP" && h.status === "FINALIZED")) return { label: "Übergeben", tone: "good", detail: null };
  if (i.startAt < b.start) {
    // G2: ein vereinbarter neuer Beginn steht erst nach der Unterschrift in startAt – die Einordnung bleibt „überfällig“
    if (i.agreedStartAt && i.agreedStartAt >= b.start) return { label: `Neuer Beginn vereinbart (${fmtDateTime(i.agreedStartAt)}) – Unterschrift ausstehend`, tone: "info", detail: null };
    return { label: `Abholtermin verstrichen · seit ${days(Math.max(1, zonedDaysBetween(i.startAt, b.now)))}`, tone: "amber", detail: `geplant ${fmtDateTime(i.startAt)}` };
  }
  if (i.startAt < b.end) {
    const passed = i.startAt < b.now;
    return { label: `Heute ${fmtTime(i.startAt)}${passed ? " · Abholzeit verstrichen" : ""}`, tone: passed ? "amber" : "info", detail: null };
  }
  return { label: `Anstehend · ${at(i.startAt)}`, tone: "grey", detail: null };
}

export type ReturnStatusInput = {
  status: string;
  rentalType: string;
  endAt: Date | null;
  agreedEndAt: Date | null;
  handovers: HandoverRef[];
  keyDrop: { status: string; customerDropOffAt: Date | null } | null;
};

/** Zeilenstatus einer Rückgabe – Reihenfolge wie im Plan 29.7 (1.4). „Überfällig…“ genau für die Menge des Filters „Überfällig“. */
export function returnRowStatus(i: ReturnStatusInput, b: Pick<CenterBounds, "now" | "start" | "end">): CenterStatus {
  if (i.handovers.some((h) => h.type === "RETURN" && h.status === "FINALIZED")) return { label: "Zurückgegeben", tone: "good", detail: null };
  if (i.keyDrop?.status === "CUSTOMER_CONFIRMED") {
    const d = i.keyDrop.customerDropOffAt;
    const detail = d ? `Abgabe laut Kunde ${d >= b.start && d < b.end ? fmtTime(d) : fmtDateTime(d)}` : null;
    return { label: "Kontrolle ausstehend", tone: "amber", detail };
  }
  if (i.rentalType === ACCIDENT) {
    // E2a: Vertrag „bis zur Rückgabe“ – nie „überfällig“; begonnene Rückgabe hat Vorrang (wie die Fallakte)
    if (i.handovers.some((h) => h.type === "RETURN" && h.status === "DRAFT")) return { label: "Rückgabe offen", tone: "amber", detail: null };
    if (i.endAt && i.endAt < b.now) return { label: "Geplantes Mietende überschritten", tone: "bad", detail: `geplant ${fmtDateTime(i.endAt)} (Disposition)` };
    if (!i.endAt) return { label: "Mietende offen", tone: "grey", detail: "Vertrag bis zur Rückgabe" };
    return { label: `geplant ${at(i.endAt)} (Disposition)`, tone: "info", detail: null };
  }
  const end = operationalEnd({ status: i.status, endAt: i.endAt, agreedEndAt: i.agreedEndAt });
  if (isOverdue({ status: i.status, endAt: i.endAt, agreedEndAt: i.agreedEndAt }, b.now)) {
    const d = zonedDaysBetween(end!, b.now);
    // „seit 0 Tagen“ gibt es nicht: am selben Kalendertag die Uhrzeit
    return { label: d <= 0 ? `Überfällig seit ${fmtTime(end!)}` : `Überfällig seit ${days(d)}`, tone: "bad", detail: `geplant ${fmtDateTime(end!)}` };
  }
  if (!end) return { label: "Mietende offen", tone: "grey", detail: null };
  if (end >= b.start && end < b.end) return { label: `Heute ${fmtTime(end)}`, tone: "info", detail: null };
  return { label: `Anstehend · ${at(end)}`, tone: "grey", detail: null };
}

export type ActionInput = {
  bookingId: string;
  status: string;
  contractStatus: string | null;
  handovers: HandoverRef[];
  caseClosed: boolean;
  keyDrop?: { status: string } | null;
};

/**
 * Primäraktion einer Übergabezeile – nur Links auf bestehende Seiten (die prüfen Rolle, Mandant und Stand selbst).
 * Supportmodus: keine (Assistenten und Protokollansicht verlangen requireRole). Gesperrter Unfallersatzfall: kein Start,
 * kein Fortsetzen, kein Vertrag. Vertrag fortsetzen nur Inhaber/Disposition (wie auf der Buchungsseite).
 */
export function pickupRowAction(i: ActionInput, viewer: CenterViewer): CenterLink | null {
  if (viewer.support) return null;
  const contract = i.contractStatus ? { status: i.contractStatus } : null;
  const a = pickupAction({ status: i.status }, contract, i.handovers);
  const href = `/buchungen/${i.bookingId}/uebergabe`;
  if (a.kind === "VIEW") return { label: a.label, href };
  if (i.caseClosed) return null;
  if ((a.kind === "START" || a.kind === "CONTINUE") && roleAllows(viewer.role, ["DISPO", "YARD"])) return { label: a.label, href };
  // Mietvertrag fehlt: der Vertrag wird per Server Action angelegt – hier nur „Buchung öffnen“
  if (a.kind === "NONE" && bookingStage({ status: i.status }, contract) === "CONTRACT_DRAFT" && roleAllows(viewer.role, ["DISPO"])) return { label: "Mietvertrag fortsetzen", href: `/buchungen/${i.bookingId}/vertrag` };
  return null;
}

/**
 * Primäraktion einer Rückgabezeile. Vereinbarte Schlüsselbox ohne Kundenmeldung: Hof ohne Aktion (die Ausnahme mit Pflichtgrund
 * ist Inhaber/Disposition vorbehalten), gemeldete Schlüsselbox: „Schlüsselbox-Rückgabe prüfen“ (auch Hof).
 */
export function returnRowAction(i: ActionInput, viewer: CenterViewer): CenterLink | null {
  if (viewer.support) return null;
  const contract = i.contractStatus ? { status: i.contractStatus } : null;
  const a = returnAction({ status: i.status }, contract, i.handovers);
  const href = `/buchungen/${i.bookingId}/rueckgabe`;
  if (a.kind === "VIEW") return { label: a.label, href };
  if (i.caseClosed) return null;
  if (!roleAllows(viewer.role, ["DISPO", "YARD"])) return null;
  if (a.kind === "START" && i.keyDrop?.status === "CUSTOMER_CONFIRMED") return { label: "Schlüsselbox-Rückgabe prüfen", href };
  if (a.kind === "START" && i.keyDrop?.status === "AUTHORIZED") return roleAllows(viewer.role, ["DISPO"]) ? { label: "Schlüsselbox-Rückgabe öffnen", href } : null;
  if (a.kind === "START" || a.kind === "CONTINUE") return { label: a.label, href };
  return null;
}

type AgreedRow = { newEndAt: Date | null; newStartAt: Date | null };

/** Hinweis je vereinbarter, noch nicht unterschriebener Änderung (AGREED) – die Filterzuordnung ändert sich dadurch nicht (G2, G9). */
export function agreedHints(kind: CenterKind, endAt: Date | null, agreed: readonly AgreedRow[]): CenterHint[] {
  const suffix = kind === "RETURN" ? " – vor Abschluss der Rückgabe unterschreiben lassen" : " – bei der Übergabe unterschreiben lassen";
  return agreed.map((a) => {
    const parts: string[] = [];
    if (a.newStartAt) parts.push(`Neuer Mietbeginn vereinbart (${fmtDateTime(a.newStartAt)})`);
    if (a.newEndAt) {
      if (endAt && a.newEndAt < endAt) parts.push(`Verkürzung vereinbart (bis ${fmtDateTime(a.newEndAt)}) – operativ noch nicht wirksam`);
      else parts.push(`Verlängerung vereinbart bis ${fmtDateTime(a.newEndAt)}`);
    }
    if (parts.length === 0) parts.push("Vertragsänderung vereinbart");
    return { text: `${parts.join(" · ")}${suffix}`, tone: "amber" as const };
  });
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

const HANDOVER_FIELDS = { id: true, type: true, status: true, number: true, wizardStep: true, startedAt: true, finalizedAt: true, employeeName: true, returnMode: true, customerDropOffAt: true, returnTimeOverrideAt: true } as const;

/**
 * Auswahl je Buchungszeile. Prüfbefund Q1: auch die nachgeladenen Relationen (Prisma lädt sie gebündelt per IN) tragen tenantId,
 * damit die Mandanten-Indizes von Handover und ContractAmendment greifen. Gleiche Felder wie AGREED_EXTENSION_SELECT (bookings.ts).
 */
function bookingSelect(T: string) {
  return {
    id: true, number: true, status: true, rentalType: true, startAt: true, endAt: true, actualPickupAt: true, actualReturnAt: true,
    customer: { select: { id: true, type: true, firstName: true, lastName: true, companyName: true } },
    vehicle: { select: { id: true, plate: true, make: true, model: true, status: true } },
    contract: { select: { status: true, number: true } },
    contractAmendments: { where: { tenantId: T, status: "AGREED" }, select: AGREED_EXTENSION_SELECT.select },
    handovers: { where: { tenantId: T, correctsId: null }, orderBy: { createdAt: "desc" as const }, select: HANDOVER_FIELDS },
    keyDropReturns: { where: { tenantId: T, status: { in: ["AUTHORIZED", "CUSTOMER_CONFIRMED"] } }, select: { status: true, expectedReturnAt: true, customerDropOffAt: true } },
    accidentCase: { select: { id: true, status: true } },
  } satisfies Prisma.BookingSelect;
}

type LoadedBooking = Prisma.BookingGetPayload<{ select: ReturnType<typeof bookingSelect> }>;
type LoadedHandover = LoadedBooking["handovers"][number];

export type CenterRow = {
  /** Buchungs- bzw. Protokoll-ID (Protokolllisten) */
  key: string;
  booking: { id: string; number: string; status: string; accident: boolean; href: string };
  customer: string;
  vehicle: { plate: string; label: string };
  /** Geplant: Abholung bzw. operatives Ende; text z. B. „Mietende offen“ (ohne Datum) oder „geplant (Disposition)“ */
  planned: { at: Date | null; text: string | null; before: Date | null };
  /** Tatsächlich: Übergabe, Rückgabe, Abgabe laut Kunde, Kontrolle */
  actual: { label: string; at: Date }[];
  status: CenterStatus;
  chips: CenterChip[];
  hints: CenterHint[];
  /** Primäraktion (Assistent, Protokoll, Vertrag) – null: nur „Buchung öffnen“ */
  action: CenterLink | null;
  open: CenterLink;
};

export type CenterKpis = {
  today: number;
  overdue: number;
  soon: number;
  inProgress: number;
  /** „bis einschließlich“ des 7-Tage-Fensters (JJJJ-MM-TT) – Kachel und Liste zeigen dieselbe Menge */
  soonBis: string;
  soonUntil: Date;
  /** nur Rückgaben */
  openEnd: number | null;
  openEndExceeded: number | null;
  keyDropPending: number | null;
};

export type HandoverCenter = {
  kind: CenterKind;
  path: string;
  filter: CenterFilter;
  filters: readonly CenterFilter[];
  q: string;
  von: string;
  bis: string;
  /** Hinweise zur Eingabe, z. B. „Datum nicht erkannt – Filter ignoriert“ */
  notes: string[];
  /** Datumsfilter wirksam */
  dated: boolean;
  viewer: CenterViewer;
  kpis: CenterKpis;
  rows: CenterRow[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  now: Date;
};

export type CenterOptions = {
  kind: CenterKind;
  filter?: unknown;
  q?: string | null;
  von?: string | null;
  bis?: string | null;
  page?: unknown;
  pageSize?: number;
  now?: Date;
  client?: Client;
  viewer: CenterViewer;
};

/** Suche: Buchungsnummer, Kunde (Name, Nummer, Telefon), Kennzeichen (normalisiert), Fahrzeug, Vertragsnummer – höchstens 2 Raw-Abfragen. */
async function searchWhere(T: string, q: string): Promise<Prisma.BookingWhereInput> {
  const [bookingWhere, customerWhere] = await Promise.all([bookingSearchWhere(T, q), customerSearchWhere(T, q)]);
  return { OR: [bookingWhere, { customer: customerWhere }] };
}

const bookingOrder = (kind: CenterKind, filter: CenterFilter): Prisma.BookingOrderByWithRelationInput[] => {
  // Übergaben: heute und anstehend nach Termin, überfällig älteste zuerst (Auftrag Abschnitt 8) – alle startAt aufsteigend
  if (kind === "PICKUP") return [{ startAt: "asc" }, { number: "asc" }, { id: "asc" }];
  // G6: Sortierung nach endAt (Prisma kennt kein GREATEST); offenes Mietende: überschrittene Planenden zuerst, offene zuletzt
  if (filter === "offenes_ende") return [{ endAt: { sort: "asc", nulls: "last" } }, { startAt: "asc" }, { number: "asc" }, { id: "asc" }];
  return [{ endAt: "asc" }, { number: "asc" }, { id: "asc" }];
};

/**
 * Übersicht laden. Feste Zahl an Datenbankoperationen, unabhängig von der Zahl der Buchungen: Suche ≤ 2 Raw-Abfragen,
 * Runde 1 Kennzahlen + Listenzahl (Übergaben 5, Rückgaben 8), Runde 2 eine Seite (vorher geklammert), Runde 3 nur bei
 * offenen Übergaben für die IDs der Seite (Fahrerprüfung ≤ 3, Fahrzeug noch unterwegs 1). Kennzahlen hängen nicht von
 * Suche und Filter ab. Abrechnungsdaten werden nicht geladen (Hof-Sicht bleibt dicht).
 */
export async function handoverCenter(tenantId: string, opts: CenterOptions): Promise<HandoverCenter> {
  const T = tenantId;
  const client = opts.client ?? db;
  const kind = opts.kind;
  const bounds = centerBounds(opts.now ?? new Date());
  const filter = resolveFilter(kind, opts.filter);
  // Prüfbefund Q2: Steuerzeichen (z. B. ?q=%00) vor der Suche entfernen – Postgres lehnt NUL in Parametern ab (sonst 500).
  // search.ts (cleanQuery) bleibt unverändert, damit sich andere Suchseiten nicht ändern.
  const q = cleanQuery(String(opts.q ?? "").replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, SEARCH_MAX).trim();
  const pageSize = Math.min(Math.max(opts.pageSize ?? CENTER_PAGE_SIZE, 10), 100);
  const requestedPage = parsePageParam(opts.page);
  const range = usesDates(filter) ? resolveDayRange(opts.von, opts.bis) : NO_RANGE;
  const notes: string[] = [];
  if (range.invalid) notes.push("Datum nicht erkannt – Filter ignoriert");

  // Bedingung der Liste
  const S = q ? await searchWhere(T, q) : null;
  let bookingWhere: Prisma.BookingWhereInput | null = null;
  let handoverWhere: Prisma.HandoverWhereInput | null = null;
  switch (filter) {
    case "heute": bookingWhere = kind === "PICKUP" ? pickupsTodayWhere(T, bounds) : returnsTodayWhere(T, bounds); break;
    case "ueberfaellig": bookingWhere = kind === "PICKUP" ? pickupsOverdueWhere(T, bounds) : returnsOverdueWhere(T, bounds.now); break;
    case "anstehend": {
      // Anstehend beginnt frühestens morgen (heute und Vergangenes stehen in „Heute“ bzw. „Überfällig“)
      if (range.from && range.from < bounds.end) notes.push("Anstehend beginnt frühestens morgen");
      const from = range.from && range.from > bounds.end ? range.from : bounds.end;
      bookingWhere = kind === "PICKUP" ? pickupsUpcomingWhere(T, from, range.toExclusive) : returnsUpcomingWhere(T, from, range.toExclusive);
      break;
    }
    case "offenes_ende": bookingWhere = openEndWhere(T); break;
    case "in_bearbeitung": handoverWhere = draftsWhere(T, kind); break;
    case "abgeschlossen": handoverWhere = finalizedWhere(T, kind, range.from, range.toExclusive); break;
  }
  if (bookingWhere && S) bookingWhere = { AND: [bookingWhere, S] };
  if (handoverWhere && q) handoverWhere = { ...handoverWhere, OR: [{ number: { contains: q, mode: "insensitive" } }, { booking: { is: S! } }] };

  // Runde 1: Kennzahlen (unabhängig von Suche und Filter) und Zahl der Liste
  const listCount = bookingWhere ? client.booking.count({ where: bookingWhere }) : client.handover.count({ where: handoverWhere! });
  const kpiCounts = kind === "PICKUP"
    ? [
      client.booking.count({ where: pickupsTodayWhere(T, bounds) }),
      client.booking.count({ where: pickupsOverdueWhere(T, bounds) }),
      client.booking.count({ where: pickupsUpcomingWhere(T, bounds.end, bounds.soonEnd) }),
      client.handover.count({ where: draftsWhere(T, "PICKUP") }),
    ]
    : [
      client.booking.count({ where: returnsTodayWhere(T, bounds) }),
      client.booking.count({ where: returnsOverdueWhere(T, bounds.now) }),
      client.booking.count({ where: returnsUpcomingWhere(T, bounds.end, bounds.soonEnd) }),
      client.handover.count({ where: draftsWhere(T, "RETURN") }),
      client.booking.count({ where: openEndWhere(T) }),
      client.booking.count({ where: { ...openEndWhere(T), endAt: { lt: bounds.now }, ...keyDropNotReported(T) } }),
      client.booking.count({ where: { tenantId: T, status: "ACTIVE", ...keyDropReported(T) } }),
    ];
  const [total, counts] = await Promise.all([listCount, Promise.all(kpiCounts)]);
  const kpis: CenterKpis = {
    today: counts[0], overdue: counts[1], soon: counts[2], inProgress: counts[3],
    soonBis: toDateInputValue(bounds.soonUntil), soonUntil: bounds.soonUntil,
    openEnd: kind === "RETURN" ? counts[4] : null,
    openEndExceeded: kind === "RETURN" ? counts[5] : null,
    keyDropPending: kind === "RETURN" ? counts[6] : null,
  };

  // Runde 2: Seite klammern, dann genau eine Seite laden
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pages);
  const skip = (page - 1) * pageSize;
  let items: { key: string; booking: LoadedBooking; focus: LoadedHandover | null }[] = [];
  if (total > 0) {
    const select = bookingSelect(T);
    if (bookingWhere) {
      const list = await client.booking.findMany({ where: bookingWhere, orderBy: bookingOrder(kind, filter), skip, take: pageSize, select });
      items = list.map((b) => ({ key: b.id, booking: b, focus: null }));
    } else {
      const list = await client.handover.findMany({
        where: handoverWhere!,
        orderBy: filter === "abgeschlossen" ? [{ finalizedAt: "desc" }, { id: "desc" }] : [{ startedAt: "asc" }, { id: "asc" }],
        skip, take: pageSize,
        select: { ...HANDOVER_FIELDS, booking: { select } },
      });
      items = list.map(({ booking, ...h }) => ({ key: h.id, booking, focus: h }));
    }
  }

  // Runde 3 (nur offene Übergaben, nur Buchungen dieser Seite): Fahrerprüfung und „Fahrzeug noch unterwegs“ – reine Hinweise
  const driverChecks = new Map<string, PickupDriverCheckStatus>();
  const vehicleOut = new Map<string, string>();
  const reserved = kind === "PICKUP" && filter !== "abgeschlossen" ? items.map((x) => x.booking).filter((b) => b.status === "RESERVED") : [];
  if (reserved.length > 0) {
    const ids = [...new Set(reserved.map((b) => b.id))];
    const [checks, out] = await Promise.all([
      pickupDriverCheckStatus(T, ids),
      client.booking.findMany({ where: { tenantId: T, status: "ACTIVE", vehicleId: { in: [...new Set(reserved.map((b) => b.vehicle.id))] }, id: { notIn: ids } }, select: { number: true, vehicleId: true }, orderBy: { number: "asc" } }),
    ]);
    for (const [id, c] of checks) driverChecks.set(id, c);
    for (const o of out) if (!vehicleOut.has(o.vehicleId)) vehicleOut.set(o.vehicleId, o.number);
  }

  const rows = items.map((x) => toRow(kind, x.key, x.booking, x.focus, { bounds, viewer: opts.viewer, driverChecks, vehicleOut }));
  return {
    kind, path: CENTER_PATH[kind], filter, filters: centerFilters(kind), q, von: range.von, bis: range.bis, notes,
    dated: range.from !== null || range.toExclusive !== null, viewer: opts.viewer, kpis, rows, total, page, pages, pageSize, now: bounds.now,
  };
}

type RowContext = { bounds: CenterBounds; viewer: CenterViewer; driverChecks: Map<string, PickupDriverCheckStatus>; vehicleOut: Map<string, string> };

function toRow(kind: CenterKind, key: string, b: LoadedBooking, focus: LoadedHandover | null, ctx: RowContext): CenterRow {
  const refs: HandoverRef[] = b.handovers;
  const own = (status: string) => (focus && focus.type === kind && focus.status === status ? focus : b.handovers.find((h) => h.type === kind && h.status === status) ?? null);
  const draft = own("DRAFT");
  const done = own("FINALIZED");
  const keyDrop = b.keyDropReturns.find((k) => k.status === "CUSTOMER_CONFIRMED") ?? b.keyDropReturns.find((k) => k.status === "AUTHORIZED") ?? null;
  const caseClosed = b.accidentCase?.status === "CLOSED";
  const accident = b.rentalType === ACCIDENT;
  const agreedEnd = agreedEndOf(b);
  const agreedStart = b.contractAmendments.find((a) => a.newStartAt)?.newStartAt ?? null;
  const contractStatus = b.contract?.status ?? null;

  const status = kind === "PICKUP"
    ? pickupRowStatus({ startAt: b.startAt, handovers: refs, agreedStartAt: agreedStart }, ctx.bounds)
    : returnRowStatus({ status: b.status, rentalType: b.rentalType, endAt: b.endAt, agreedEndAt: agreedEnd, handovers: refs, keyDrop }, ctx.bounds);
  const actionInput: ActionInput = { bookingId: b.id, status: b.status, contractStatus, handovers: refs, caseClosed, keyDrop };
  const action = kind === "PICKUP" ? pickupRowAction(actionInput, ctx.viewer) : returnRowAction(actionInput, ctx.viewer);

  const chips: CenterChip[] = [];
  if (accident) chips.push({ label: "Unfallersatz", tone: "info" });
  if (draft) chips.push({ label: "Entwurf", tone: "amber" });
  if (caseClosed) chips.push({ label: CASE_LOCKED_CHIP, tone: "grey" });

  const hints: CenterHint[] = [];
  // G10: updatedAt ist unzuverlässig – gezeigt wird nur der Beginn des Entwurfs
  if (draft) hints.push({ text: `${draft.number} · Schritt ${draft.wizardStep} · begonnen ${fmtDateTime(draft.startedAt)} von ${draft.employeeName}`, tone: "info" });
  if (kind === "PICKUP" && b.status === "RESERVED") {
    const stage = bookingStage(b, b.contract);
    if (stage === "NEEDS_CONTRACT") hints.push({ text: "Mietvertrag fehlt", tone: "amber" });
    if (stage === "CONTRACT_DRAFT") hints.push({ text: "Vertrag in Arbeit", tone: "amber" });
    const dc = ctx.driverChecks.get(b.id);
    // G5: gezählt werden alle Vertragsfahrer (wie im Dashboard); gezeigt bei begonnener oder fälliger Übergabe
    if (dc && dc.required > 0 && (draft || b.startAt < ctx.bounds.end)) {
      if (dc.blocked > 0) hints.push({ text: `Fahrerprüfung blockiert (${dc.blocked} von ${dc.required} Fahrern)`, tone: "bad" });
      else hints.push({ text: `Fahrerprüfung ${dc.confirmed} von ${dc.required} bestätigt`, tone: dc.confirmed < dc.required ? "amber" : "good" });
      if (dc.manualReviewOpen > 0) hints.push({ text: "Manuelle Führerscheinprüfung offen", tone: "amber" });
    }
    const out = ctx.vehicleOut.get(b.vehicle.id);
    if (out) hints.push({ text: `Fahrzeug noch unterwegs (Buchung ${out})`, tone: "amber" });
    const problem = vehicleStatusProblem(b.vehicle.status);
    if (problem) hints.push({ text: problem, tone: "amber" });
  }
  if (kind === "RETURN" && !done && !draft && keyDrop?.status === "AUTHORIZED") {
    // Prüfbefund R2: die Rollengrenze nennen (wie rueckgabe/page.tsx) – der Hof bekommt hier bewusst keine Aktion
    const who = ctx.viewer.support ? "" : roleAllows(ctx.viewer.role, ["DISPO"]) ? " (Kontrolle vorher nur mit dokumentiertem Grund)" : " – Kontrolle vor der Kundenmeldung nur durch Inhaber oder Disposition (mit Begründung)";
    hints.push({ text: `Schlüsselbox vereinbart – Kundenmeldung ausstehend${who}`, tone: "info" });
  } else if (kind === "RETURN" && draft?.returnMode === "KEY_DROP" && !draft.customerDropOffAt) {
    // Prüfbefund SL-1: Kontrolle per Ausnahme begonnen – der Kunde kann nichts mehr melden (Link gesperrt), der Grund ist erfasst
    hints.push({ text: "Kontrolle ohne Kundenmeldung begonnen (Ausnahme)", tone: "amber" });
  }
  if (!done && b.contractAmendments.length > 0) hints.push(...agreedHints(kind, b.endAt, b.contractAmendments));
  if (kind === "RETURN" && b.status === "ACTIVE" && !b.handovers.some((h) => h.type === "PICKUP" && h.status === "FINALIZED")) hints.push({ text: "Altfall ohne Übergabeprotokoll", tone: "grey" });

  // Termin
  let planned: CenterRow["planned"];
  const actual: CenterRow["actual"] = [];
  if (kind === "PICKUP") {
    planned = { at: b.startAt, text: null, before: null };
    if (b.actualPickupAt) actual.push({ label: "Übergeben", at: b.actualPickupAt });
  } else {
    if (accident) planned = { at: b.endAt, text: b.endAt ? "geplant (Disposition)" : "Mietende offen", before: null };
    else planned = { at: operationalEnd({ status: b.status, endAt: b.endAt, agreedEndAt: agreedEnd }), text: null, before: agreedEnd && b.endAt && agreedEnd > b.endAt ? b.endAt : null };
    if (done) {
      if (done.returnMode === "KEY_DROP") {
        // E7: maßgeblich ist die Abgabe laut Kunde bzw. deren Korrektur, daneben der Zeitpunkt der Kontrolle. Prüfbefund SL-3:
        // ohne Kundenmeldung und ohne Korrektur ist actualReturnAt der Kontrollzeitpunkt – dann keine „Abgabe laut Kunde“
        if (done.returnTimeOverrideAt) actual.push({ label: "Mietende (korrigiert)", at: b.actualReturnAt ?? done.returnTimeOverrideAt });
        else if (done.customerDropOffAt) actual.push({ label: "Abgabe laut Kunde", at: b.actualReturnAt ?? done.customerDropOffAt });
        if (done.finalizedAt) actual.push({ label: "Kontrolle am", at: done.finalizedAt });
        if (!done.returnTimeOverrideAt && !done.customerDropOffAt) hints.push({ text: "Kontrolle ohne Kundenmeldung (Ausnahme)", tone: "grey" });
      } else {
        const returnedAt = b.actualReturnAt ?? done.finalizedAt;
        if (returnedAt) actual.push({ label: "Zurückgegeben", at: returnedAt });
      }
    } else if (keyDrop?.status === "CUSTOMER_CONFIRMED" && keyDrop.customerDropOffAt) {
      actual.push({ label: "Abgabe laut Kunde", at: keyDrop.customerDropOffAt });
    }
  }

  return {
    key,
    booking: { id: b.id, number: b.number, status: b.status, accident, href: `/buchungen/${b.id}` },
    customer: customerName(b.customer),
    vehicle: { plate: b.vehicle.plate, label: `${b.vehicle.make} ${b.vehicle.model}` },
    planned,
    actual,
    status,
    chips,
    hints,
    action,
    open: { label: "Buchung öffnen", href: `/buchungen/${b.id}` },
  };
}

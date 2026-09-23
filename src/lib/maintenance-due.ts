// Fälligkeitslogik für Wartungspläne: reine Berechnung aus Datum und/oder Kilometern, nie gespeichert.
// Ein Plan ist fällig, sobald eine der beiden Grenzen erreicht ist („was zuerst kommt“). Keine Kilometerprognose:
// „noch 1.500 km“ ist der Abstand zum aktuellen Fahrzeugstand, nicht eine Schätzung, wann er erreicht wird.
// Datei ohne Server-Importe, damit sie auch in Client-Komponenten und Tests nutzbar ist.

import { DUE_LEVELS, type DueLevel } from "@/lib/constants";
import { APP_TIME_ZONE } from "@/lib/time";

export type DueInput = {
  nextDueDate: Date | null | undefined;
  nextDueMileage: number | null | undefined;
  warningDaysBefore: number;
  warningKilometersBefore: number;
  isActive?: boolean;
};

export type DueResult = {
  /** NONE = keine Fälligkeit hinterlegt oder Plan deaktiviert */
  level: DueLevel | "NONE";
  label: string;
  /** Tage bis zur Fälligkeit (negativ = überfällig), null ohne Datum */
  daysLeft: number | null;
  /** Kilometer bis zur Fälligkeit (negativ = überfällig), null ohne Kilometerziel oder ohne Fahrzeugstand */
  kmLeft: number | null;
  /** lesbarer Text, z. B. „in 12 Tagen“, „noch 800 km“, „seit 14 Tagen überfällig“ */
  text: string;
  /** kleiner = dringender (für Sortierung: überfällig zuerst) */
  sortKey: number;
};

const DAY = 86_400_000;

/** Kalendertag (Europe/Berlin) als UTC-Mitternacht, damit Tagesdifferenzen unabhängig von der Uhrzeit sind. */
function dayOf(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"));
}

/** Kalendertage zwischen heute und dem Datum (positiv = in der Zukunft). */
export function daysUntil(date: Date, now = new Date()): number {
  return Math.round((dayOf(date) - dayOf(now)) / DAY);
}

const fmtKm = (n: number) => `${Math.abs(n).toLocaleString("de-DE")} km`;
const fmtDays = (n: number) => `${Math.abs(n)} ${Math.abs(n) === 1 ? "Tag" : "Tagen"}`;

function levelOf(remaining: number, warning: number): DueLevel {
  if (remaining < 0) return "OVERDUE";
  if (remaining === 0) return "DUE";
  if (remaining <= warning) return "SOON";
  return "OK";
}

const RANK: Record<DueLevel | "NONE", number> = { OVERDUE: 0, DUE: 1, SOON: 2, OK: 3, NONE: 4 };

/**
 * Warnstand eines Plans. Bei Datum und Kilometern zählt der dringendere Wert; der Text nennt beide.
 * Ohne Fahrzeugkilometerstand wird das Kilometerziel nur informativ genannt.
 */
export function dueStatus(input: DueInput, currentMileage: number | null | undefined, now = new Date()): DueResult {
  if (input.isActive === false) return { level: "NONE", label: "Deaktiviert", daysLeft: null, kmLeft: null, text: "Plan deaktiviert", sortKey: RANK.NONE * 1_000_000 };
  const daysLeft = input.nextDueDate ? daysUntil(input.nextDueDate, now) : null;
  const kmLeft = input.nextDueMileage != null && currentMileage != null ? input.nextDueMileage - currentMileage : null;
  if (daysLeft == null && kmLeft == null) {
    const hint = input.nextDueMileage != null ? `fällig bei ${fmtKm(input.nextDueMileage)} (kein Fahrzeugkilometerstand)` : "keine Fälligkeit hinterlegt";
    return { level: "NONE", label: "Offen", daysLeft: null, kmLeft: null, text: hint, sortKey: RANK.NONE * 1_000_000 };
  }
  const byDate = daysLeft == null ? null : levelOf(daysLeft, input.warningDaysBefore);
  const byKm = kmLeft == null ? null : levelOf(kmLeft, input.warningKilometersBefore);
  const level = [byDate, byKm].filter((l): l is DueLevel => l !== null).sort((a, b) => RANK[a] - RANK[b])[0];
  const parts: string[] = [];
  if (daysLeft != null) parts.push(daysLeft < 0 ? `seit ${fmtDays(daysLeft)} überfällig` : daysLeft === 0 ? "heute fällig" : `in ${fmtDays(daysLeft)}`);
  if (kmLeft != null) parts.push(kmLeft < 0 ? `seit ${fmtKm(kmLeft)} überfällig` : kmLeft === 0 ? "Kilometerstand erreicht" : `noch ${fmtKm(kmLeft)}`);
  // dringenderen Teil zuerst nennen
  if (byDate && byKm && RANK[byKm] < RANK[byDate]) parts.reverse();
  // Sortierung: Stufe, dann Abstand (Tage bzw. Kilometer/100 als grober Vergleich)
  const distance = Math.min(daysLeft == null ? Infinity : daysLeft, kmLeft == null ? Infinity : kmLeft / 100);
  return { level, label: DUE_LEVELS[level], daysLeft, kmLeft, text: parts.join(" / "), sortKey: RANK[level] * 1_000_000 + Math.max(-999_999, Math.min(999_999, Math.round(distance))) };
}

/** Datum plus Monate (Tag bleibt, bei Monatsende auf den letzten Tag begrenzt). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/** Vorschlag für die nächste Fälligkeit aus dem Intervall des Plans – nur ein Vorschlag, der Mitarbeiter bestätigt. */
export function proposeNextDue(plan: { intervalMonths: number | null; intervalKilometers: number | null }, completedAt: Date, mileage: number | null): { nextDueDate: Date | null; nextDueMileage: number | null } {
  return {
    nextDueDate: plan.intervalMonths ? addMonths(completedAt, plan.intervalMonths) : null,
    nextDueMileage: plan.intervalKilometers && mileage != null ? mileage + plan.intervalKilometers : null,
  };
}

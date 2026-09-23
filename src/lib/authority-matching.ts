// Zuordnungslogik für Behördenvorgänge: Kennzeichen → Fahrzeug, Tatzeit → Vermietung. Reine Funktionen ohne Datenbank,
// damit sie in Tests und Oberfläche gleich rechnen. Halboffenes Intervall [start, end) wie in der Buchungslogik:
// eine Tatzeit exakt zum Rückgabezeitpunkt gehört nicht mehr zur beendeten Vermietung.
// Bei unbekannter Uhrzeit wird der Tattag (Europe/Berlin) als Zeitraum verwendet und die Zuordnung als „tagesgenau“ markiert.

import { APP_TIME_ZONE, zoneOffsetMinutes } from "@/lib/time";

/** Vergleichsschlüssel: nur Buchstaben und Ziffern, groß. „H-AB 1234“, „H AB 1234“ und „HAB1234“ ergeben denselben Schlüssel. */
export function plateKey(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, "");
}

export type VehicleMatchResult = { status: "EXACT_MATCH" | "NO_MATCH" | "AMBIGUOUS"; vehicleIds: string[] };

export function matchVehicles(plateFromNotice: string, vehicles: { id: string; plate: string }[]): VehicleMatchResult {
  const key = plateKey(plateFromNotice);
  if (!key) return { status: "NO_MATCH", vehicleIds: [] };
  const hits = vehicles.filter((v) => plateKey(v.plate) === key).map((v) => v.id);
  if (hits.length === 1) return { status: "EXACT_MATCH", vehicleIds: hits };
  if (hits.length === 0) return { status: "NO_MATCH", vehicleIds: [] };
  return { status: "AMBIGUOUS", vehicleIds: hits };
}

/** Tattag in Europe/Berlin als [Tagesbeginn, Tagesende) in UTC-Zeitpunkten. */
export function offenseDayRange(offenseAt: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(offenseAt);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const localMidnightUtc = Date.UTC(get("year"), get("month") - 1, get("day"));
  const start = new Date(localMidnightUtc - zoneOffsetMinutes(new Date(localMidnightUtc)) * 60_000);
  const nextUtc = localMidnightUtc + 86_400_000;
  const end = new Date(nextUtc - zoneOffsetMinutes(new Date(nextUtc)) * 60_000);
  return { start, end };
}

export type RentalCandidateInput = {
  bookingId: string;
  bookingNumber: string;
  status: string;
  startAt: Date;
  endAt: Date;
  actualPickupAt: Date | null;
  actualReturnAt: Date | null;
  contractId: string | null;
  contractStatus: string | null;
};

export type RentalCandidate = {
  bookingId: string;
  bookingNumber: string;
  contractId: string | null;
  /** ACTUAL = tatsächliche Übergabe-/Rückgabezeit, PLANNED = nur geplante Buchungszeit */
  basis: "ACTUAL" | "PLANNED";
  windowStart: Date;
  /** null = Rückgabe noch nicht erfolgt (laufende Miete) */
  windowEnd: Date | null;
  /** Tatzeit unbekannt: Überschneidung mit dem Tattag statt Punkt-im-Intervall */
  dayOnly: boolean;
  explanation: string;
};

export type RentalMatchResult = { status: "ACTUAL_PERIOD" | "PLANNED_PERIOD" | "AMBIGUOUS" | "NONE"; candidates: RentalCandidate[]; selected: RentalCandidate | null; dayOnly: boolean };

function window(b: RentalCandidateInput): { start: Date; end: Date | null; basis: "ACTUAL" | "PLANNED" } | null {
  if (b.status === "CANCELLED") return null;
  if (b.actualPickupAt) return { start: b.actualPickupAt, end: b.actualReturnAt ?? null, basis: "ACTUAL" };
  if (b.status === "RETURNED") return null; // zurückgegeben ohne tatsächliche Zeiten (Altbestand): keine belastbare Aussage
  return { start: b.startAt, end: b.endAt, basis: "PLANNED" };
}

const contains = (start: Date, end: Date | null, at: Date) => at.getTime() >= start.getTime() && (end == null || at.getTime() < end.getTime());
const overlaps = (start: Date, end: Date | null, from: Date, to: Date) => start.getTime() < to.getTime() && (end == null || end.getTime() > from.getTime());

/**
 * Findet Vermietungen, in die die Tatzeit fällt. Tatsächliche Zeiten (finalisierte Übergabe/Rückgabe) sind stärker als
 * geplante Buchungszeiten; ein tatsächlicher Treffer gewinnt gegen geplante. Mehrere gleichwertige Treffer = AMBIGUOUS,
 * nie automatische Auswahl. Bei unbekannter Uhrzeit zählt der Tattag; das Ergebnis ist dann nur tagesgenau.
 */
export function matchRentals(bookings: RentalCandidateInput[], offenseAt: Date, timeKnown: boolean): RentalMatchResult {
  const day = timeKnown ? null : offenseDayRange(offenseAt);
  const candidates: RentalCandidate[] = [];
  for (const b of bookings) {
    const w = window(b);
    if (!w) continue;
    const hit = day ? overlaps(w.start, w.end, day.start, day.end) : contains(w.start, w.end, offenseAt);
    if (!hit) continue;
    const explanation = w.basis === "ACTUAL"
      ? (day ? "Tattag überschneidet sich mit der tatsächlichen Mietdauer (Uhrzeit unbekannt)" : w.end ? "Tatzeit liegt innerhalb der tatsächlichen Mietdauer" : "Tatzeit liegt in einer laufenden Miete (Rückgabe noch offen)")
      : (day ? "Nur anhand der geplanten Buchungszeit zugeordnet (Uhrzeit unbekannt)" : "Nur anhand geplanter Buchungszeit zugeordnet – keine finalisierte Übergabe");
    candidates.push({ bookingId: b.bookingId, bookingNumber: b.bookingNumber, contractId: b.contractStatus === "SIGNED" ? b.contractId : null, basis: w.basis, windowStart: w.start, windowEnd: w.end, dayOnly: !!day, explanation });
  }
  const actual = candidates.filter((c) => c.basis === "ACTUAL");
  const pool = actual.length > 0 ? actual : candidates;
  if (pool.length === 0) return { status: "NONE", candidates, selected: null, dayOnly: !!day };
  if (pool.length > 1) return { status: "AMBIGUOUS", candidates, selected: null, dayOnly: !!day };
  const sel = pool[0];
  return { status: sel.basis === "ACTUAL" ? "ACTUAL_PERIOD" : "PLANNED_PERIOD", candidates, selected: sel, dayOnly: !!day };
}

/** Fristanzeige: „noch 3 Tage“, „heute fällig“, „seit 2 Tagen überfällig“ – Kalendertage Europe/Berlin. */
export function deadlineInfo(deadline: Date | null, now = new Date()): { daysLeft: number | null; level: "NONE" | "OK" | "SOON" | "DUE" | "OVERDUE"; text: string } {
  if (!deadline) return { daysLeft: null, level: "NONE", text: "keine Frist hinterlegt" };
  const dayOf = (d: Date) => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d); const g = (t: string) => Number(p.find((x) => x.type === t)?.value); return Date.UTC(g("year"), g("month") - 1, g("day")); };
  const days = Math.round((dayOf(deadline) - dayOf(now)) / 86_400_000);
  if (days < 0) return { daysLeft: days, level: "OVERDUE", text: `seit ${-days} ${-days === 1 ? "Tag" : "Tagen"} überfällig` };
  if (days === 0) return { daysLeft: 0, level: "DUE", text: "heute fällig" };
  if (days <= 3) return { daysLeft: days, level: "SOON", text: `noch ${days} ${days === 1 ? "Tag" : "Tage"}` };
  return { daysLeft: days, level: "OK", text: `noch ${days} Tage` };
}

/** Portaladresse prüfen: nur https, sichtbare Domain; sonst keine Verlinkung. */
export function portalUrlInfo(url: string | null | undefined): { ok: boolean; host: string | null; href: string | null } {
  if (!url) return { ok: false, host: null, href: null };
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return { ok: false, host: u.hostname || null, href: null };
    return { ok: true, host: u.hostname, href: u.toString() };
  } catch {
    return { ok: false, host: null, href: null };
  }
}

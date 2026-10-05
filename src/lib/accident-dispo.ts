// Praxistest-Korrekturrunde: Kennzeichnung einer Unfallersatzmiete im Dispo-Kalender – immer textlich („Unfallersatz“ bzw. „UE“),
// nie nur über Farbe. Standardbuchungen bleiben unverändert (diese Helfer werden nur für rentalType ACCIDENT_REPLACEMENT benutzt).
// Keine Versicherungs- oder Finanzdaten – nur Fallnummer, Buchung, Kunde und Zeitraum.
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/format";

export const isAccidentRental = (b: { rentalType?: string | null }) => b.rentalType === "ACCIDENT_REPLACEMENT";

/** Zeitangabe im Balken: „ab 12:15 · Mietende offen“ bzw. „ab 12:15 · geplant bis 08.10.2026, 10:00“; Beginn vor dem Fenster mit Datum. */
export function accidentBarTime(b: { startAt: Date; endAt: Date | null }, windowStart: Date): string {
  const start = b.startAt < windowStart ? fmtDate(b.startAt) : fmtTime(b.startAt);
  return `ab ${start} · ${b.endAt ? `geplant bis ${fmtDateTime(b.endAt)}` : "Mietende offen"}`;
}

/** Tooltip des Balkens: Unfallersatz, Fallnummer, Buchung, Kunde, Beginn und (offenes bzw. geplantes) Mietende. */
export function accidentBarTitle(b: { number: string; startAt: Date; endAt: Date | null }, caseNumber: string | null, customer: string, overdue: boolean): string {
  const end = b.endAt ? `${overdue ? "geplantes Mietende überschritten" : "geplant bis"} ${fmtDateTime(b.endAt)}` : "Mietende offen";
  return `Unfallersatz${caseNumber ? ` ${caseNumber}` : ""} · ${b.number} · ${customer} · ab ${fmtDateTime(b.startAt)} · ${end}`;
}

// Deutsche Formatierung für Datum, Zeit und Beträge. Zeiten immer in der Anwendungszeitzone (lib/time.ts),
// unabhängig davon, wo der Server läuft.

import { APP_TIME_ZONE, toDateInputValue, toDateTimeInputValue } from "@/lib/time";

const dateFmt = new Intl.DateTimeFormat("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", {
  timeZone: APP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("de-DE", { timeZone: APP_TIME_ZONE, hour: "2-digit", minute: "2-digit" });
const eurFmt = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const intFmt = new Intl.NumberFormat("de-DE");

export function fmtDate(d: Date | string | null | undefined) {
  if (!d) return "–";
  return dateFmt.format(new Date(d));
}
export function fmtDateTime(d: Date | string | null | undefined) {
  if (!d) return "–";
  return dateTimeFmt.format(new Date(d));
}
export function fmtTime(d: Date | string | null | undefined) {
  if (!d) return "–";
  return timeFmt.format(new Date(d));
}
export function fmtEur(v: number | string | { toString(): string } | null | undefined) {
  if (v === null || v === undefined) return "–";
  return eurFmt.format(Number(v.toString()));
}
export function fmtInt(v: number | null | undefined) {
  if (v === null || v === undefined) return "–";
  return intFmt.format(v);
}

/** Wert für <input type="date"> in der Anwendungszeitzone. */
export function toDateInput(d: Date | null | undefined) {
  return d ? toDateInputValue(new Date(d)) : "";
}
/** Wert für <input type="datetime-local"> in der Anwendungszeitzone. */
export function toDateTimeInput(d: Date | null | undefined) {
  return d ? toDateTimeInputValue(new Date(d)) : "";
}

// Miettage werden zentral in lib/pricing.ts berechnet.
export { rentalDays } from "@/lib/pricing";

export function customerName(c: { type: string; companyName: string | null; firstName: string; lastName: string }) {
  if (c.type === "COMPANY" && c.companyName) return c.companyName;
  return `${c.firstName} ${c.lastName}`.trim();
}

/** Kennzeichen normalisieren: Großbuchstaben, ein Leerzeichen, keine Bindestrich-Varianten. */
export function normalizePlate(p: string) {
  return p.toUpperCase().replace(/\s+/g, " ").replace(/\s*-\s*/g, "-").trim();
}

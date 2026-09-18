// Deutsche Formatierung für Datum, Zeit und Beträge.

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
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

/** Wert für <input type="date"> (lokale Zeit, ohne Zeitzonenverschiebung). */
export function toDateInput(d: Date | null | undefined) {
  if (!d) return "";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
/** Wert für <input type="datetime-local">. */
export function toDateTimeInput(d: Date | null | undefined) {
  if (!d) return "";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${toDateInput(x)}T${p(x.getHours())}:${p(x.getMinutes())}`;
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

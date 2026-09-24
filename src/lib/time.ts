// Zeitzone der Anwendung. Alle Zeitpunkte liegen in der Datenbank als UTC; angezeigt, eingegeben und in
// Dokumente geschrieben wird in APP_TIME_ZONE. Damit hängt nichts davon ab, in welcher Zeitzone der Server läuft.
// Sommer-/Winterzeit wird über Intl aufgelöst, nicht über feste Offsets.

export const APP_TIME_ZONE = "Europe/Berlin";

const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: APP_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Kalenderbestandteile eines Zeitpunkts in der Anwendungszeitzone. */
export function zonedParts(d: Date) {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFmt.formatToParts(d)) if (type !== "literal") p[type] = Number(value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** Versatz der Anwendungszeitzone zu UTC in Minuten zum gegebenen Zeitpunkt (Berlin: 60 im Winter, 120 im Sommer). */
export function zoneOffsetMinutes(d: Date) {
  const z = zonedParts(d);
  return Math.round((Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - d.getTime()) / 60_000);
}

/**
 * Liest eine Eingabe aus <input type="datetime-local"> (z. B. "2026-09-21T10:00") als Zeitpunkt in der
 * Anwendungszeitzone. Nicht vorhandene Uhrzeiten in der Umstellungslücke werden auf die nächste gültige geschoben.
 */
export function parseLocalDateTime(input: unknown): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input !== "string") return null;
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    // ISO mit Zeitzone (z. B. aus Tests): so übernehmen
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(input.trim()) ? new Date(input.trim()) : null;
    return iso && !Number.isNaN(iso.getTime()) ? iso : null;
  }
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  // Kalenderdaten wie den 30. Februar lehnt Date.UTC nicht ab, sondern rollt weiter; das fangen wir hier ab
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  let guess = new Date(wall - zoneOffsetMinutes(new Date(wall)) * 60_000);
  const second = new Date(wall - zoneOffsetMinutes(guess) * 60_000);
  if (second.getTime() !== guess.getTime()) guess = second;
  return Number.isNaN(guess.getTime()) ? null : guess;
}

const two = (n: number) => String(n).padStart(2, "0");

/** Wert für <input type="date"> in der Anwendungszeitzone. */
export function toDateInputValue(d: Date) {
  const z = zonedParts(d);
  return `${z.year}-${two(z.month)}-${two(z.day)}`;
}

/** Wert für <input type="datetime-local"> in der Anwendungszeitzone. */
export function toDateTimeInputValue(d: Date) {
  const z = zonedParts(d);
  return `${toDateInputValue(d)}T${two(z.hour)}:${two(z.minute)}`;
}

/** Beginn des Kalendertags (00:00 in der Anwendungszeitzone), in dem der Zeitpunkt liegt. */
export function zonedDayStart(d: Date): Date {
  const z = zonedParts(d);
  return parseLocalDateTime(`${z.year}-${two(z.month)}-${two(z.day)}T00:00`)!;
}

/** Kalendertag n Tage nach dem Tagesbeginn von d (in der Anwendungszeitzone; über Zeitumstellungen hinweg korrekt). */
export function zonedDayStartPlus(d: Date, days: number): Date {
  const z = zonedParts(zonedDayStart(d));
  const wall = new Date(Date.UTC(z.year, z.month - 1, z.day + days));
  return parseLocalDateTime(`${wall.getUTCFullYear()}-${two(wall.getUTCMonth() + 1)}-${two(wall.getUTCDate())}T00:00`)!;
}

/** Halboffenes Tagesintervall [start, end) des Kalendertags von d in der Anwendungszeitzone. */
export function zonedDayRange(d: Date): { start: Date; end: Date } {
  return { start: zonedDayStart(d), end: zonedDayStartPlus(d, 1) };
}

/** Ganze Kalendertage zwischen zwei Zeitpunkten in der Anwendungszeitzone (Tag von b minus Tag von a). */
export function zonedDaysBetween(a: Date, b: Date): number {
  const za = zonedParts(a), zb = zonedParts(b);
  return Math.round((Date.UTC(zb.year, zb.month - 1, zb.day) - Date.UTC(za.year, za.month - 1, za.day)) / 86_400_000);
}

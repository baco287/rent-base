// Nummernkreise der Belege (Phase 17): Rechnung, Gutschrift, Stornobeleg. Je Mandant konfigurierbar (nur Präfix),
// Standard RE / GS / ST. Format immer PREFIX-JJJJ-NNNNNN, fortlaufend je Kreis und Jahr, mandantenweit eindeutig
// (Index Invoice.tenantId + number), nie wiederverwendet, nach dem Abschluss unveränderlich. Frei von Server-Importen.

export type InvoiceDocumentType = "INVOICE" | "CREDIT_NOTE" | "CANCELLATION";
export type NumberRangeKey = "invoice" | "creditNote" | "cancellation" | "payout";
export type NumberRanges = Record<NumberRangeKey, { prefix: string }>;

export const DEFAULT_NUMBER_RANGES: NumberRanges = { invoice: { prefix: "RE" }, creditNote: { prefix: "GS" }, cancellation: { prefix: "ST" }, payout: { prefix: "AZ" } };
export const NUMBER_RANGE_LABELS: Record<NumberRangeKey, string> = { invoice: "Rechnungen", creditNote: "Gutschriften", cancellation: "Stornobelege", payout: "Auszahlungen" };
export const RANGE_OF_TYPE: Record<InvoiceDocumentType, NumberRangeKey> = { INVOICE: "invoice", CREDIT_NOTE: "creditNote", CANCELLATION: "cancellation" };

const PREFIX = /^[A-Z]{1,6}$/;
export const NUMBER_FORMAT = /^[A-Z]{1,6}-[0-9]{4}-[0-9]{6}$/;

export class NumberRangeError extends Error {}

/** Gespeicherte Konfiguration lesen; unbekannte oder ungültige Einträge fallen still auf den Standard zurück. */
export function numberRangesOf(stored: unknown): NumberRanges {
  const out: NumberRanges = { invoice: { ...DEFAULT_NUMBER_RANGES.invoice }, creditNote: { ...DEFAULT_NUMBER_RANGES.creditNote }, cancellation: { ...DEFAULT_NUMBER_RANGES.cancellation }, payout: { ...DEFAULT_NUMBER_RANGES.payout } };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  for (const k of Object.keys(out) as NumberRangeKey[]) {
    const v = (stored as Record<string, unknown>)[k];
    const prefix = v && typeof v === "object" ? (v as { prefix?: unknown }).prefix : undefined;
    if (typeof prefix === "string" && PREFIX.test(prefix)) out[k].prefix = prefix;
  }
  return out;
}

/** Eingaben prüfen: Präfix 1–6 Großbuchstaben, alle drei verschieden. Wirft NumberRangeError mit verständlicher Meldung. */
export function validateNumberRanges(input: Record<NumberRangeKey, string>): NumberRanges {
  const out = {} as NumberRanges;
  for (const k of Object.keys(NUMBER_RANGE_LABELS) as NumberRangeKey[]) {
    const p = (input[k] ?? "").trim().toUpperCase();
    if (!PREFIX.test(p)) throw new NumberRangeError(`${NUMBER_RANGE_LABELS[k]}: Das Präfix besteht aus 1 bis 6 Großbuchstaben (A–Z), z. B. „${DEFAULT_NUMBER_RANGES[k].prefix}“.`);
    out[k] = { prefix: p };
  }
  const prefixes = Object.values(out).map((r) => r.prefix);
  if (new Set(prefixes).size !== prefixes.length) throw new NumberRangeError("Die Präfixe der Nummernkreise müssen sich unterscheiden, sonst wären die Belegnummern nicht eindeutig.");
  return out;
}

export const rangePrefix = (ranges: NumberRanges, type: InvoiceDocumentType, year: number) => `${ranges[RANGE_OF_TYPE[type]].prefix}-${year}-`;
export const payoutPrefix = (ranges: NumberRanges, year: number) => `${ranges.payout.prefix}-${year}-`;

/** Nächste Nummer eines Kreises aus der höchsten vergebenen Nummer desselben Präfixes und Jahres. */
export function nextInRange(prefix: string, last: string | null | undefined): string {
  const n = last && last.startsWith(prefix) ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  if (!Number.isFinite(n) || n < 1) throw new NumberRangeError("Die letzte vergebene Nummer dieses Kreises ist nicht lesbar.");
  return `${prefix}${String(n).padStart(6, "0")}`;
}

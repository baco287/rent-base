// Geldbeträge für Rechnungen: ganzzahlige Cent-Arithmetik, keine Gleitkommarechnung.
// Jede Rundung passiert genau hier und ist deterministisch (kaufmännisch, halbe Cent aufwärts).
// Steuersätze werden in Basispunkten geführt (19,00 % = 1900), Mengen in Hundertsteln (28,13 = 2813).

export type Cents = number;

const roundHalfUp = (n: number) => Math.sign(n) * Math.floor(Math.abs(n) + 0.5);

/**
 * Dezimalzahl (Zahl, String mit Komma oder Punkt, Prisma Decimal) als ganze Hundertstel, ohne Gleitkomma-Multiplikation:
 * Die Ziffern werden als Text zerlegt, ab der dritten Nachkommastelle wird kaufmännisch gerundet ("1,005" → 101).
 * Bei Komma als Dezimaltrenner gelten Punkte als Tausenderpunkte ("1.234,56"); sonst ist der Punkt das Dezimalzeichen.
 */
function toScaled(v: unknown, what: string): number {
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`${what}: ${String(v)}`);
  let s = String(v ?? "").trim().replace(/\s|€|%/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`${what}: ${String(v)}`);
  const sign = m[1] === "-" ? -1 : 1;
  const int = m[2] || "0";
  const frac = (m[3] ?? "").padEnd(3, "0");
  const scaled = Number(int) * 100 + Number(frac.slice(0, 2));
  const carry = Number(frac[2]) >= 5 ? 1 : 0;
  const out = sign * (scaled + carry);
  if (!Number.isSafeInteger(out)) throw new Error(`${what}: ${String(v)}`);
  return out;
}

/** Euro-Betrag nach Cent. */
export function toCents(v: unknown): Cents {
  return toScaled(v, "Kein gültiger Betrag");
}

export const fromCents = (c: Cents) => c / 100;
export const centsToDecimalString = (c: Cents) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;
export const fmtCents = (c: Cents) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

/** Menge in Hundertsteln (zwei Nachkommastellen), Steuersatz in Basispunkten. */
export const toHundredths = (v: unknown) => toScaled(v, "Keine gültige Menge");
export const toBasisPoints = (percent: unknown) => toScaled(percent, "Kein gültiger Steuersatz");

export type LineAmounts = { net: Cents; tax: Cents; gross: Cents };

/**
 * Beträge einer Position.
 * Nettomodus: netto = Menge × Einzelpreis, Steuer = netto × Satz, brutto = netto + Steuer.
 * Bruttomodus (Preise enthalten die Steuer): brutto = Menge × Einzelpreis, Steuer wird herausgerechnet, netto = brutto − Steuer.
 * In beiden Fällen gilt exakt brutto = netto + Steuer.
 */
export function lineAmounts(mode: "NET" | "GROSS", quantityHundredths: number, unitPriceCents: Cents, taxRateBp: number): LineAmounts {
  if (quantityHundredths <= 0) throw new Error("Die Menge muss größer als 0 sein.");
  if (unitPriceCents < 0) throw new Error("Der Einzelpreis darf nicht negativ sein.");
  if (taxRateBp < 0 || taxRateBp > 10_000) throw new Error("Der Steuersatz liegt zwischen 0 und 100 Prozent.");
  const base = roundHalfUp((quantityHundredths * unitPriceCents) / 100);
  if (mode === "NET") {
    const tax = roundHalfUp((base * taxRateBp) / 10_000);
    return { net: base, tax, gross: base + tax };
  }
  const tax = roundHalfUp((base * taxRateBp) / (10_000 + taxRateBp));
  return { net: base - tax, tax, gross: base };
}

/** Summen je Steuersatz und gesamt. Summiert werden die bereits gerundeten Positionsbeträge. */
export function summarize(lines: { taxRateBp: number; amounts: LineAmounts }[]) {
  const byRate = new Map<number, LineAmounts>();
  for (const l of lines) {
    const cur = byRate.get(l.taxRateBp) ?? { net: 0, tax: 0, gross: 0 };
    byRate.set(l.taxRateBp, { net: cur.net + l.amounts.net, tax: cur.tax + l.amounts.tax, gross: cur.gross + l.amounts.gross });
  }
  const total = [...byRate.values()].reduce((s, a) => ({ net: s.net + a.net, tax: s.tax + a.tax, gross: s.gross + a.gross }), { net: 0, tax: 0, gross: 0 });
  return { byRate: [...byRate.entries()].sort((a, b) => b[0] - a[0]).map(([taxRateBp, amounts]) => ({ taxRateBp, ...amounts })), total };
}

export const fmtRate = (bp: number) => `${(bp / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;

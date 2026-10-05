// Befehl 29 Phase C: Preisvorschau für den Unfallersatz-Wizard. Rein (kein Server- oder Datenbankzugriff), läuft im
// Browser und in Tests identisch. Alles in ganzen Cent; Miettage aus der zentralen Preislogik (rentalDays, Wandzeit).
// Unfallersatz rechnet je Miettag zum vereinbarten Tagessatz, ohne Kundenrabatt und ohne Wochen-/Monatsstufen.
// Es ist eine Vorschau: keine Aussage zur Erstattungsfähigkeit, kein Ersatz für die Abrechnung nach tatsächlicher Dauer.

import { rentalDays } from "@/lib/pricing";
import type { Cents } from "@/lib/money";

export type PreviewTariffItem = { label: string; perDay: boolean; unitPriceCents: Cents; quantityHundredths: number };
export type PreviewLine = { label: string; detail: string; cents: Cents };

export type AccidentPricePreview =
  | {
      kind: "KNOWN_END";
      days: number;
      dailyRateCents: Cents;
      /** Grundmiete und Tagespositionen (Tage × Satz) sowie Einmalpositionen, in dieser Reihenfolge */
      lines: PreviewLine[];
      /** Summe je Miettag: Tagessatz + Tagespositionen */
      perDayCents: Cents;
      oneOffCents: Cents;
      totalCents: Cents;
    }
  | {
      kind: "OPEN_END";
      dailyRateCents: Cents;
      perDayLines: PreviewLine[];
      oneOffLines: PreviewLine[];
      perDayCents: Cents;
      oneOffCents: Cents;
      /** Nur wenn der Mietbeginn bereits erreicht ist: bisherige Miettage und Zwischenstand bis jetzt */
      elapsed: { days: number; cents: Cents } | null;
    };

export type RentValue = { days: number; perDayCents: Cents; oneOffCents: Cents; cents: Cents };

/**
 * Befehl 29 Phase D: Mietwert ab der tatsächlichen Übergabe bis zur Rückgabe bzw. bis zum Stichtag – dieselbe Rechnung wie die
 * Unfallersatz-Rechnung: Miettage × (Tagessatz + Tagespositionen) + Einmalpositionen (ohne Zusatzkosten aus der Rückgabe).
 * Ohne Beginn (noch nicht übergeben) gibt es keinen Mietwert (null), nie einen erfundenen.
 */
export function rentValue(input: { from: Date | null; until: Date; dailyRateCents: Cents; items: readonly { perDay: boolean; unitPriceCents: Cents; quantityHundredths: number }[] }): RentValue | null {
  if (!input.from) return null;
  const perDayCents = Math.max(0, input.dailyRateCents) + input.items.filter((i) => i.perDay && i.unitPriceCents > 0).reduce((s, i) => s + i.unitPriceCents, 0);
  const oneOffCents = input.items.filter((i) => !i.perDay && i.unitPriceCents > 0 && i.quantityHundredths > 0).reduce((s, i) => s + lineCents(i.quantityHundredths, i.unitPriceCents), 0);
  const days = input.until > input.from ? rentalDays(input.from, input.until) : 0;
  return { days, perDayCents, oneOffCents, cents: days > 0 ? days * perDayCents + oneOffCents : 0 };
}

/**
 * Phase E: Tarif, wie er im Mietvertrag steht. Beim Unfallersatz friert der Preis-Schnappschuss des Vertrags neben dem Tagessatz
 * (rates.dailyRate) auch die Tarifpositionen ein (priceSnapshot.accidentTariff) – unterschrieben, gehasht und danach unveränderlich.
 */
export type ContractTariffItem = { kind: string; label: string; perDay: boolean; unitPriceCents: Cents; quantityHundredths: number };
export type ContractAccidentTariff = { items: ContractTariffItem[] };

export function freezeTariff(items: readonly ContractTariffItem[]): ContractAccidentTariff {
  return { items: items.map((i) => ({ kind: i.kind, label: i.label, perDay: i.perDay, unitPriceCents: i.unitPriceCents, quantityHundredths: i.quantityHundredths })) };
}

/** Eingefrorene Positionen aus dem Preis-Schnappschuss; null, wenn der Vertrag (noch) keinen Unfallersatz-Tarif trägt. */
export function contractTariffItems(priceSnapshot: unknown): ContractTariffItem[] | null {
  const t = (priceSnapshot as { accidentTariff?: { items?: unknown } } | null)?.accidentTariff;
  if (!t || !Array.isArray(t.items)) return null;
  return t.items
    .filter((i): i is ContractTariffItem => !!i && typeof i === "object" && typeof (i as ContractTariffItem).label === "string" && Number.isInteger((i as ContractTariffItem).unitPriceCents))
    .map((i) => ({ kind: String(i.kind ?? "OTHER"), label: i.label, perDay: i.perDay === true, unitPriceCents: i.unitPriceCents, quantityHundredths: Number.isInteger(i.quantityHundredths) ? i.quantityHundredths : 100 }));
}

/** Tagessatz in Cent aus dem Preis-Schnappschuss des Vertrags (rates.dailyRate in Euro), sonst null. */
export function contractDailyRateCents(priceSnapshot: unknown): Cents | null {
  const rate = (priceSnapshot as { rates?: { dailyRate?: unknown } } | null)?.rates?.dailyRate;
  return typeof rate === "number" && rate > 0 ? Math.round(rate * 100) : null;
}

/**
 * Phase E: Mietwert-Stand einer Unfallersatzmiete – eine Ableitung für Fallakte, Buchungsseite und Rückgabe:
 * vor der Übergabe kein Ist-Wert (NONE), während der Miete der Wert bis jetzt (RUNNING), nach der Rückgabe der Endwert (FINAL).
 * Rechnet ausschließlich über rentValue (dieselbe Formel wie die Unfallersatz-Rechnung), nie mit dem geplanten Ende.
 */
export type RentState = { phase: "NONE" } | { phase: "RUNNING" | "FINAL"; value: RentValue; from: Date; until: Date };
export function accidentRentState(b: { status: string; actualPickupAt: Date | null; actualReturnAt: Date | null }, tariff: { dailyRateCents: Cents; items: readonly { perDay: boolean; unitPriceCents: Cents; quantityHundredths: number }[] }, now = new Date()): RentState {
  if (!b.actualPickupAt || b.status === "CANCELLED") return { phase: "NONE" };
  const until = b.actualReturnAt ?? now;
  const value = rentValue({ from: b.actualPickupAt, until, dailyRateCents: tariff.dailyRateCents, items: tariff.items })!;
  return { phase: b.actualReturnAt ? "FINAL" : "RUNNING", value, from: b.actualPickupAt, until };
}

/** Menge (Hundertstel) × Einzelpreis (Cent), kaufmännisch auf Cent gerundet – ganzzahlig. */
export function lineCents(quantityHundredths: number, unitPriceCents: Cents): Cents {
  return Math.floor((quantityHundredths * unitPriceCents + 50) / 100);
}

const fmt = (c: Cents) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const dayWord = (n: number) => (n === 1 ? "Tag" : "Tage");

export function accidentPricePreview(input: { startAt: Date; endAt: Date | null; dailyRateCents: Cents; items: PreviewTariffItem[]; now?: Date }): AccidentPricePreview {
  const daily = Math.max(0, input.dailyRateCents);
  const perDayItems = input.items.filter((i) => i.perDay && i.unitPriceCents > 0);
  const oneOffItems = input.items.filter((i) => !i.perDay && i.unitPriceCents > 0 && i.quantityHundredths > 0);
  const perDayCents = daily + perDayItems.reduce((s, i) => s + i.unitPriceCents, 0);
  const oneOffLines = oneOffItems.map((i) => ({ label: i.label, detail: i.quantityHundredths === 100 ? "einmalig" : `${(i.quantityHundredths / 100).toLocaleString("de-DE")} × ${fmt(i.unitPriceCents)}`, cents: lineCents(i.quantityHundredths, i.unitPriceCents) }));
  const oneOffCents = oneOffLines.reduce((s, l) => s + l.cents, 0);

  if (input.endAt === null) {
    const now = input.now ?? new Date();
    const days = now > input.startAt ? rentalDays(input.startAt, now) : 0;
    return {
      kind: "OPEN_END",
      dailyRateCents: daily,
      perDayLines: [{ label: "Tagessatz", detail: "je Miettag", cents: daily }, ...perDayItems.map((i) => ({ label: i.label, detail: "je Miettag", cents: i.unitPriceCents }))],
      oneOffLines,
      perDayCents,
      oneOffCents,
      elapsed: days > 0 ? { days, cents: days * perDayCents + oneOffCents } : null,
    };
  }
  const days = rentalDays(input.startAt, input.endAt);
  const lines: PreviewLine[] = [
    { label: "Grundmiete", detail: `${days} ${dayWord(days)} × ${fmt(daily)}`, cents: days * daily },
    ...perDayItems.map((i) => ({ label: i.label, detail: `${days} ${dayWord(days)} × ${fmt(i.unitPriceCents)}`, cents: days * i.unitPriceCents })),
    ...oneOffLines,
  ];
  return { kind: "KNOWN_END", days, dailyRateCents: daily, lines, perDayCents, oneOffCents, totalCents: lines.reduce((s, l) => s + l.cents, 0) };
}

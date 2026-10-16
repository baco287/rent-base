// Befehl 29: EIN Weg zum erwarteten Mietpreis einer Buchung vor dem Vertrag (Buchungsliste, Buchungsseite, Mietzahlung,
// Zeitraum ändern, Vertragsentwurf). Tarifbuchungen rechnen ausschließlich aus ihrem eingefrorenen Tarif-Snapshot (nie aus dem
// Live-Tarif), Buchungen ohne Tarif (Altbestand) aus ihren eingefrorenen Altfeldern – beide über dieselbe zentrale Preisfunktion.
// Ein individuell vereinbarter Preis (Booking.agreedPriceCents, 0 € zulässig) ersetzt den regulären Preis, ohne ihn zu verlieren.
// Auslandsfahrt: ein EINMALIGER Aufpreis (Booking.abroadSurchargeCents) kommt zur Grundmiete hinzu – auch zu einem Sonderpreis,
// ohne Kundenrabatt. Er wird nur hier (vor dem Vertrag) bzw. im Vertrag als eigene Position (extras) addiert, nie doppelt.

import { calculateRentalPrice, rateCardFrom, totalCentsOf, type PriceBreakdown } from "@/lib/pricing";
import { readTariffSnapshot, type TariffSnapshot } from "@/lib/tariffs";
import { abroadSurchargeOf } from "@/lib/abroad";

export type BookingPriceSource = {
  dailyRate: unknown;
  workWeekRate?: unknown;
  weeklyRate?: unknown;
  monthlyRate?: unknown;
  tariffSnapshot?: unknown;
  agreedPriceCents?: number | null;
  // Pflicht, damit keine Abfrage den Auslandsfahrt-Aufpreis still weglässt
  rentalType: string;
  abroadAllowed: boolean | null;
  abroadSurchargeCents: number | null;
};

export type BookingQuote = {
  source: "TARIFF" | "LEGACY";
  tariff: TariffSnapshot | null;
  breakdown: PriceBreakdown;
  days: number;
  /** regulärer Preis (Tarif bzw. Altfelder) nach Kundenrabatt */
  regularCents: number;
  /** individuell vereinbarter Preis; null = regulärer Preis gilt */
  agreedCents: number | null;
  /** Grundmiete der Buchung: vereinbart, sonst regulär (ohne Auslandsfahrt-Aufpreis) */
  rentCents: number;
  /** einmaliger Auslandsfahrt-Aufpreis (0 = keiner) */
  abroadSurchargeCents: number;
  /** gilt für die Buchung: Grundmiete + Auslandsfahrt-Aufpreis */
  totalCents: number;
};

export function bookingQuote(b: BookingPriceSource, start: Date, end: Date, discountPercent: number): BookingQuote {
  const tariff = readTariffSnapshot(b.tariffSnapshot);
  const breakdown = tariff ? calculateRentalPrice({ start, end, tiers: tariff.tiers, discountPercent }) : calculateRentalPrice({ start, end, rates: rateCardFrom(b), discountPercent });
  const regularCents = totalCentsOf(breakdown);
  const agreedCents = tariff && b.agreedPriceCents != null ? b.agreedPriceCents : null;
  const rentCents = agreedCents ?? regularCents;
  const abroadSurchargeCents = abroadSurchargeOf(b);
  return { source: tariff ? "TARIFF" : "LEGACY", tariff, breakdown, days: breakdown.days, regularCents, agreedCents, rentCents, abroadSurchargeCents, totalCents: rentCents + abroadSurchargeCents };
}

/** Abweichung eines vereinbarten Preises vom regulären Preis (absolut und in Prozent, Prozent nur bei regulärem Preis > 0). */
export function priceDeviation(regularCents: number, agreedCents: number): { cents: number; percent: number | null } {
  const cents = agreedCents - regularCents;
  return { cents, percent: regularCents > 0 ? Math.round((cents / regularCents) * 1000) / 10 : null };
}

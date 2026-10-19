// Verteilung des wirksamen Vertragspreises auf die Positionen der Mietrechnung (rein, ohne Datenbank). Eine Stelle für
// Mietrechnung (ensureInvoiceDraft), offene Abrechnungen (pendingSettlements) und Nachberechnung (createAmendmentSettlementDraft),
// damit eine bereits verrechnete Erhöhung nie ein zweites Mal angeboten oder berechnet wird.
//
// Regeln: Fahrzeugmiete = Vertragspreis ohne Vertragspositionen. Preiserhöhungen aus Nachträgen und Erhöhungen des
// Auslandsfahrt-Aufpreises sind eigene Positionen; es gibt keine negativen Positionen. Minderungen werden in der Reihenfolge der
// Nachträge verrechnet und mindern nur Positionen, die vor ihnen bestanden:
// - Senkung des Auslandsfahrt-Aufpreises: nur Auslandsfahrt-Positionen (die zuletzt vereinbarte zuerst, die Vertragsposition zuletzt).
// - Allgemeine Preisminderung: Fahrzeugmiete, übrige Vertragspositionen (von hinten), Auslandsfahrt-Aufpreis laut Vertrag, dann
//   Preiserhöhungen und Auslandsfahrt-Positionen aus früheren Nachträgen (zuletzt vereinbarte zuerst). Bis zum Auslandsfahrt-
//   Aufpreis laut Vertrag ist das dieselbe Verteilung wie vor Stufe 2; früher verfiel ein darüber hinausgehender Rest.
// Summe der Positionen = wirksamer Gesamtpreis (jeder Nachtrag hält den Gesamtpreis ≥ 0, daher reichen die Positionen immer).
import { ABROAD_SURCHARGE_KEY } from "@/lib/abroad";

type AllocAmendment = { id: string; number: string | null; priceDeltaCents: number | null; abroadSurchargeDeltaCents?: number | null };
type Pot = { cents: number; reducedBy: string[] };
export type AllocatedItem<A> = Pot & { a: A };
export type RentalAllocation<A> = {
  rentalCents: number;
  /** je Vertragsposition (gleiche Reihenfolge wie priceSnapshot.extras) */
  extras: Pot[];
  /** Preiserhöhungen aus Nachträgen (priceDeltaCents > 0) */
  increases: AllocatedItem<A>[];
  /** Erhöhungen des Auslandsfahrt-Aufpreises (abroadSurchargeDeltaCents > 0) */
  abroad: AllocatedItem<A>[];
  /** Summe der allgemeinen Preisminderungen (≤ 0) */
  reductionTotal: number;
  totalCents: number;
};

/** `amendments`: unterschriebene Nachträge in der Reihenfolge sequenceNo. */
export function allocateRentalItems<A extends AllocAmendment>(originalTotalCents: number, extras: readonly { key?: string; amount: number }[], amendments: readonly A[]): RentalAllocation<A> {
  const extraItems: Pot[] = extras.map((e) => ({ cents: Math.round(e.amount * 100), reducedBy: [] }));
  const otherExtras = [...extraItems.keys()].filter((i) => extras[i].key !== ABROAD_SURCHARGE_KEY).reverse().map((i) => extraItems[i]);
  const abroadExtras = [...extraItems.keys()].filter((i) => extras[i].key === ABROAD_SURCHARGE_KEY).reverse().map((i) => extraItems[i]);
  const rental: Pot = { cents: originalTotalCents - extraItems.reduce((s, x) => s + x.cents, 0), reducedBy: [] };
  const increases: AllocatedItem<A>[] = [];
  const abroad: AllocatedItem<A>[] = [];
  let reductionTotal = 0;

  /** Betrag der Reihe nach von den Töpfen abziehen; vermerkt den Nachtrag nur an Positionen, die er tatsächlich erreicht. */
  const reduce = (amount: number, by: string | null, pots: Pot[]) => {
    let rest = amount;
    for (const p of pots) {
      if (rest <= 0) break;
      const t = Math.min(p.cents, rest);
      if (t > 0) { p.cents -= t; rest -= t; if (by && !p.reducedBy.includes(by)) p.reducedBy.push(by); }
    }
  };
  // Altbestand: Vertragspositionen höher als der Vertragspreis (z. B. individueller Preis) – wie bisher aus den Positionen
  if (rental.cents < 0) { const over = -rental.cents; rental.cents = 0; reduce(over, null, [...otherExtras, ...abroadExtras]); }

  for (const a of amendments) {
    const p = a.priceDeltaCents ?? 0;
    const d = a.abroadSurchargeDeltaCents ?? 0;
    if (p > 0) increases.push({ a, cents: p, reducedBy: [] });
    if (d > 0) abroad.push({ a, cents: d, reducedBy: [] });
    if (d < 0) reduce(-d, a.number, [...[...abroad].reverse(), ...abroadExtras]);
    if (p < 0) {
      reductionTotal += p;
      reduce(-p, a.number, [rental, ...otherExtras, ...abroadExtras, ...[...increases].reverse(), ...[...abroad].reverse()]);
    }
  }
  const sum = (list: Pot[]) => list.reduce((s, x) => s + x.cents, 0);
  return { rentalCents: rental.cents, extras: extraItems, increases, abroad, reductionTotal, totalCents: rental.cents + sum(extraItems) + sum(increases) + sum(abroad) };
}

/** Hinweis an einer geminderten Position. */
export const reducedNote = (by: readonly string[]) => (by.length ? ` (gemindert laut Nachtrag ${by.join(", ")})` : "");

// Zentrale Preisberechnung für Rent-Base.
// Einzige Stelle, an der ein Mietpreis berechnet wird: Buchungsformular, Buchungsliste, Mietvertrag
// und später die Rückgabe rufen alle calculateRentalPrice() auf. Die Funktion ist rein (kein Datenbank-
// oder Serverzugriff) und läuft deshalb identisch im Browser und auf dem Server.
//
// Erweiterbarkeit: neue Regeln (Wochenendpreise, Saison, Mindestmiete) kommen als weitere Strategie
// oder als Schritt in der Pipeline dazu, ohne dass Aufrufer sich ändern.

export type PriceTier = "DAY" | "WORK_WEEK" | "WEEK" | "MONTH";

/** Preisstufen in Euro brutto. Nicht gesetzte Stufen werden ignoriert. */
export type RateCard = {
  dailyRate: number;
  workWeekRate?: number | null; // Woche, 5 Tage
  weeklyRate?: number | null; // Kalenderwoche, 7 Tage
  monthlyRate?: number | null; // Monat, 30 Tage
};

export type PricingStrategy = "CHEAPEST_COMBINATION" | "DAILY_ONLY";

export type PriceLine = {
  tier: PriceTier;
  label: string;
  coversDays: number; // wie viele Miettage ein Block abdeckt
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type PriceBreakdown = {
  strategy: PricingStrategy;
  version: 1; // Version der Rechenregeln, wird im Vertrag mit eingefroren
  days: number;
  rates: Required<{ [K in keyof RateCard]: number | null }>;
  lines: PriceLine[];
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  total: number;
};

const TIER_DAYS: Record<PriceTier, number> = { DAY: 1, WORK_WEEK: 5, WEEK: 7, MONTH: 30 };
const TIER_LABEL: Record<PriceTier, string> = {
  DAY: "Tag",
  WORK_WEEK: "Woche (5 Tage)",
  WEEK: "Kalenderwoche (7 Tage)",
  MONTH: "Monat (30 Tage)",
};

const toCents = (v: number) => Math.round(v * 100);
const fromCents = (c: number) => Math.round(c) / 100;

/** Akzeptiert Zahl, Zahl als Text ("89,50"), Prisma-Decimal oder leer. */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Anzahl Miettage: angefangene 24 Stunden zählen als voller Tag, mindestens 1. */
export function rentalDays(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function normalizeRates(r: RateCard) {
  const pos = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? v : null);
  return {
    dailyRate: Math.max(0, r.dailyRate || 0),
    workWeekRate: pos(r.workWeekRate),
    weeklyRate: pos(r.weeklyRate),
    monthlyRate: pos(r.monthlyRate),
  };
}

/**
 * Günstigste Kombination aus den hinterlegten Stufen.
 * Ein Block darf mehr Tage abdecken als gebraucht: 6 Tage kosten nie mehr als die Kalenderwoche.
 * Beispiel bei 89 / 420 / 540: 4 Tage = 4 × Tag, 5 Tage = Woche, 6 Tage = Woche + Tag (509) statt Kalenderwoche (540).
 */
function cheapestCombination(days: number, rates: ReturnType<typeof normalizeRates>): Map<PriceTier, number> {
  const tiers: { tier: PriceTier; size: number; cents: number }[] = [{ tier: "DAY", size: 1, cents: toCents(rates.dailyRate) }];
  if (rates.workWeekRate) tiers.push({ tier: "WORK_WEEK", size: 5, cents: toCents(rates.workWeekRate) });
  if (rates.weeklyRate) tiers.push({ tier: "WEEK", size: 7, cents: toCents(rates.weeklyRate) });
  if (rates.monthlyRate) tiers.push({ tier: "MONTH", size: 30, cents: toCents(rates.monthlyRate) });

  // cost[n] = günstigster Preis, um mindestens n Tage abzudecken
  const cost: number[] = [0];
  const pick: (typeof tiers)[number][] = [];
  for (let n = 1; n <= days; n++) {
    let best = Infinity;
    let bestTier = tiers[0];
    for (const t of tiers) {
      const c = t.cents + cost[Math.max(0, n - t.size)];
      // Bei Gleichstand den größeren Block nehmen: einfacher zu lesen auf dem Vertrag
      if (c < best || (c === best && t.size > bestTier.size)) {
        best = c;
        bestTier = t;
      }
    }
    cost[n] = best;
    pick[n] = bestTier;
  }

  const counts = new Map<PriceTier, number>();
  for (let n = days; n > 0; ) {
    const t = pick[n];
    counts.set(t.tier, (counts.get(t.tier) ?? 0) + 1);
    n = Math.max(0, n - t.size);
  }
  return counts;
}

export type PriceInput = {
  start: Date;
  end: Date;
  rates: RateCard;
  discountPercent?: number;
  strategy?: PricingStrategy;
};

/** Die eine Preisfunktion. Rundet jede Position auf Cent und gibt die vollständige Aufschlüsselung zurück. */
export function calculateRentalPrice(input: PriceInput): PriceBreakdown {
  const strategy = input.strategy ?? "CHEAPEST_COMBINATION";
  const rates = normalizeRates(input.rates);
  const days = rentalDays(input.start, input.end);
  const discountPercent = Math.min(100, Math.max(0, Math.round(input.discountPercent ?? 0)));

  const counts = days === 0 ? new Map<PriceTier, number>() : strategy === "DAILY_ONLY" ? new Map<PriceTier, number>([["DAY", days]]) : cheapestCombination(days, rates);

  const unit: Record<PriceTier, number> = {
    DAY: rates.dailyRate,
    WORK_WEEK: rates.workWeekRate ?? 0,
    WEEK: rates.weeklyRate ?? 0,
    MONTH: rates.monthlyRate ?? 0,
  };
  const order: PriceTier[] = ["MONTH", "WEEK", "WORK_WEEK", "DAY"];
  const lines: PriceLine[] = order
    .filter((t) => (counts.get(t) ?? 0) > 0)
    .map((t) => {
      const quantity = counts.get(t)!;
      return { tier: t, label: TIER_LABEL[t], coversDays: TIER_DAYS[t], quantity, unitPrice: unit[t], amount: fromCents(quantity * toCents(unit[t])) };
    });

  const subtotalCents = lines.reduce((s, l) => s + toCents(l.amount), 0);
  const discountCents = Math.round((subtotalCents * discountPercent) / 100);
  return {
    strategy,
    version: 1,
    days,
    rates,
    lines,
    subtotal: fromCents(subtotalCents),
    discountPercent,
    discountAmount: fromCents(discountCents),
    total: fromCents(subtotalCents - discountCents),
  };
}

/** Lesbare Kurzform, z. B. "1 × Kalenderwoche + 3 × Tag". */
export function describePrice(b: PriceBreakdown): string {
  if (b.lines.length === 0) return "–";
  return b.lines.map((l) => `${l.quantity} × ${l.label}`).join(" + ");
}

/** Baut die Preisstufen aus Datenbankfeldern (Prisma-Decimal) oder Formularwerten. */
export function rateCardFrom(src: { dailyRate: unknown; workWeekRate?: unknown; weeklyRate?: unknown; monthlyRate?: unknown }): RateCard {
  return {
    dailyRate: toNumber(src.dailyRate) ?? 0,
    workWeekRate: toNumber(src.workWeekRate),
    weeklyRate: toNumber(src.weeklyRate),
    monthlyRate: toNumber(src.monthlyRate),
  };
}

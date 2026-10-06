// Zentrale Preisberechnung für Rent-Base.
// Einzige Stelle, an der ein Mietpreis berechnet wird: Buchungsformular, Buchungsliste, Mietvertrag
// und später die Rückgabe rufen alle calculateRentalPrice() auf. Die Funktion ist rein (kein Datenbank-
// oder Serverzugriff) und läuft deshalb identisch im Browser und auf dem Server.
//
// Befehl 29: Preisstufen sind frei konfigurierbar (Miettarife, beliebige Dauern in ganzen Tagen, Preise in Cent). Die feste
// Altstruktur Tag / 5 / 7 / 30 Tage (RateCard) bleibt als Eingabeform für Buchungen und Verträge ohne Tarif erhalten und
// liefert unverändert dieselbe Aufschlüsselung (version 1). Beide Formen laufen durch DIESELBE Rechnung (günstigste Kombination).
//
// Erweiterbarkeit: neue Regeln (Wochenendpreise, Saison, Mindestmiete) kommen als weitere Strategie
// oder als Schritt in der Pipeline dazu, ohne dass Aufrufer sich ändern.

import { zoneOffsetMinutes } from "@/lib/time";

/** Stufen der Altstruktur (Buchungen/Verträge ohne Tarif). Tarifstufen heißen "D<Tage>", z. B. "D7". */
export type PriceTier = "DAY" | "WORK_WEEK" | "WEEK" | "MONTH";

/** Preisstufen in Euro brutto. Nicht gesetzte Stufen werden ignoriert. */
export type RateCard = {
  dailyRate: number;
  workWeekRate?: number | null; // Woche, 5 Tage
  weeklyRate?: number | null; // Kalenderwoche, 7 Tage
  monthlyRate?: number | null; // Monat, 30 Tage
};

/** Befehl 29: eine Preisstufe eines Tarifs – Dauer in ganzen Miettagen, Preis in Cent (brutto), optional eigene Bezeichnung. */
export type TierDef = { days: number; cents: number; label?: string | null };

export type PricingStrategy = "CHEAPEST_COMBINATION" | "DAILY_ONLY";

export type PriceLine = {
  tier: string; // PriceTier (Altstruktur) oder "D<Tage>" (Tarif)
  label: string;
  coversDays: number; // wie viele Miettage ein Block abdeckt
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type PriceBreakdown = {
  strategy: PricingStrategy;
  version: 1 | 2; // 1 = Altstruktur, 2 = Tarifstufen; wird im Vertrag mit eingefroren
  days: number;
  /** Altstruktur; bei version 2 aus den Stufen 1/5/7/30 abgeleitet (Lesekompatibilität, z. B. Tagessatz bei offenem Ende) */
  rates: Required<{ [K in keyof RateCard]: number | null }>;
  /** Befehl 29 (version 2): die verwendeten Preisstufen, aufsteigend nach Dauer */
  tiers?: TierDef[];
  lines: PriceLine[];
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  total: number;
  /** Befehl 29 (version 2): exakte Centbeträge */
  subtotalCents?: number;
  discountCents?: number;
  totalCents?: number;
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

/** Standardbezeichnung einer Tarifstufe: „Tag“ bzw. „7 Tage“. */
export const tierLabel = (days: number) => (days === 1 ? "Tag" : `${days} Tage`);

/** Akzeptiert Zahl, Zahl als Text ("89,50"), Prisma-Decimal oder leer. */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Anzahl Miettage: angefangene 24 Stunden zählen als voller Tag, mindestens 1.
 * Befehl 27: gezählt wird in Ortszeit (Wandzeit Europe/Berlin), nicht in absoluten Stunden. Samstag 10:00 bis Montag 10:00
 * sind damit immer 2 Tage – auch über die Zeitumstellung (Ende Oktober 49 echte Stunden, Ende März 47). Eine echte
 * Überziehung (z. B. Montag 10:01) beginnt weiterhin einen neuen Tag.
 */
export function rentalDays(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const wallMs = ms + (zoneOffsetMinutes(end) - zoneOffsetMinutes(start)) * 60_000;
  return Math.max(1, Math.ceil(wallMs / (24 * 60 * 60 * 1000)));
}

/**
 * Phase F: Zeitpunkt, ab dem nach `days` vollen Miettagen der nächste Miettag beginnt (eine Minute nach dem Ende von Tag `days`),
 * gezählt wie rentalDays (Wanduhr Europe/Berlin, auch über die Zeitumstellung).
 */
export function nextRentalDayStart(start: Date, days: number): Date {
  let t = new Date(start.getTime() + days * 24 * 60 * 60 * 1000 + 60_000);
  for (let i = 0; i < 3 && rentalDays(start, t) <= days; i++) t = new Date(t.getTime() + 60 * 60 * 1000);
  for (let i = 0; i < 3 && rentalDays(start, new Date(t.getTime() - 60 * 60 * 1000)) > days; i++) t = new Date(t.getTime() - 60 * 60 * 1000);
  return t;
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

/** Ein buchbarer Block der Kombinationsrechnung (Cent, Dauer in Tagen). */
type Block = { key: string; size: number; cents: number; label: string };

/**
 * Günstigste Kombination aus den hinterlegten Stufen – für Altstruktur und Tarifstufen dieselbe Rechnung.
 * Ein Block darf mehr Tage abdecken als gebraucht: 6 Tage kosten nie mehr als die Kalenderwoche.
 * Beispiel bei 89 / 420 / 540: 4 Tage = 4 × Tag, 5 Tage = Woche, 6 Tage = Woche + Tag (509) statt Kalenderwoche (540).
 * Rechnung in ganzen Cent; `blocks` aufsteigend nach Dauer. Bei Gleichstand gewinnt der größere Block (lesbarer im Vertrag).
 */
function cheapestBlocks(days: number, blocks: Block[]): Map<string, number> {
  // cost[n] = günstigster Preis, um mindestens n Tage abzudecken
  const cost: number[] = [0];
  const pick: Block[] = [];
  for (let n = 1; n <= days; n++) {
    let best = Infinity;
    let bestBlock = blocks[0];
    for (const b of blocks) {
      const c = b.cents + cost[Math.max(0, n - b.size)];
      if (c < best || (c === best && b.size > bestBlock.size)) {
        best = c;
        bestBlock = b;
      }
    }
    cost[n] = best;
    pick[n] = bestBlock;
  }
  const counts = new Map<string, number>();
  for (let n = days; n > 0; ) {
    const b = pick[n];
    counts.set(b.key, (counts.get(b.key) ?? 0) + 1);
    n = Math.max(0, n - b.size);
  }
  return counts;
}

export type PriceInput = {
  start: Date;
  end: Date;
  /** Altstruktur (Buchungen/Verträge ohne Tarif). Wird ignoriert, wenn `tiers` gesetzt ist. */
  rates?: RateCard;
  /** Befehl 29: Tarifstufen (Cent). Mindestens eine Stufe. */
  tiers?: TierDef[];
  discountPercent?: number;
  strategy?: PricingStrategy;
};

/** Prüft Tarifstufen: ganze Tage > 0, Cent >= 0, keine doppelte Dauer, mindestens eine Stufe. Gibt sie aufsteigend zurück. */
export function normalizeTiers(tiers: TierDef[]): TierDef[] {
  if (!Array.isArray(tiers) || tiers.length === 0) throw new Error("Mindestens eine Preisstufe ist erforderlich.");
  const seen = new Set<number>();
  for (const t of tiers) {
    if (!Number.isInteger(t.days) || t.days <= 0) throw new Error("Die Dauer einer Preisstufe muss eine ganze Zahl über 0 sein.");
    if (!Number.isInteger(t.cents) || t.cents < 0) throw new Error("Der Preis einer Preisstufe muss ein Centbetrag ab 0 sein.");
    if (seen.has(t.days)) throw new Error(`Die Dauer ${tierLabel(t.days)} ist doppelt vergeben.`);
    seen.add(t.days);
  }
  return [...tiers].sort((a, b) => a.days - b.days).map((t) => ({ days: t.days, cents: t.cents, ...(t.label ? { label: t.label } : {}) }));
}

/** Altstruktur → Stufen (mit den bisherigen Bezeichnungen). 0/leer bei 5/7/30 Tagen bedeutet wie bisher „nicht angeboten“. */
export function tiersFromRateCard(rc: RateCard): TierDef[] {
  const r = normalizeRates(rc);
  const out: TierDef[] = [{ days: 1, cents: toCents(r.dailyRate), label: TIER_LABEL.DAY }];
  if (r.workWeekRate) out.push({ days: 5, cents: toCents(r.workWeekRate), label: TIER_LABEL.WORK_WEEK });
  if (r.weeklyRate) out.push({ days: 7, cents: toCents(r.weeklyRate), label: TIER_LABEL.WEEK });
  if (r.monthlyRate) out.push({ days: 30, cents: toCents(r.monthlyRate), label: TIER_LABEL.MONTH });
  return out;
}

/** Lesekompatible Altfelder aus Tarifstufen (Stufen 1/5/7/30 Tage, sonst null). */
function ratesFromTiers(tiers: TierDef[]): PriceBreakdown["rates"] {
  const at = (d: number) => {
    const t = tiers.find((x) => x.days === d);
    return t ? fromCents(t.cents) : null;
  };
  return { dailyRate: at(1) ?? 0, workWeekRate: at(5), weeklyRate: at(7), monthlyRate: at(30) };
}

/** Die eine Preisfunktion. Rundet jede Position auf Cent und gibt die vollständige Aufschlüsselung zurück. */
export function calculateRentalPrice(input: PriceInput): PriceBreakdown {
  const strategy = input.strategy ?? "CHEAPEST_COMBINATION";
  const days = rentalDays(input.start, input.end);
  const discountPercent = Math.min(100, Math.max(0, Math.round(input.discountPercent ?? 0)));

  // Befehl 29: Tarifstufen (version 2)
  if (input.tiers) {
    const tiers = normalizeTiers(input.tiers);
    const blocks: Block[] = tiers.map((t) => ({ key: `D${t.days}`, size: t.days, cents: t.cents, label: t.label || tierLabel(t.days) }));
    const day = blocks.find((b) => b.size === 1);
    const counts = days === 0 ? new Map<string, number>() : strategy === "DAILY_ONLY" && day ? new Map([[day.key, days]]) : cheapestBlocks(days, blocks);
    const lines: PriceLine[] = [...blocks]
      .reverse()
      .filter((b) => (counts.get(b.key) ?? 0) > 0)
      .map((b) => {
        const quantity = counts.get(b.key)!;
        return { tier: b.key, label: b.label, coversDays: b.size, quantity, unitPrice: fromCents(b.cents), amount: fromCents(quantity * b.cents) };
      });
    const subtotalCents = [...counts].reduce((s, [k, q]) => s + q * blocks.find((b) => b.key === k)!.cents, 0);
    const discountCents = Math.round((subtotalCents * discountPercent) / 100);
    const totalCents = subtotalCents - discountCents;
    return {
      strategy,
      version: 2,
      days,
      rates: ratesFromTiers(tiers),
      tiers,
      lines,
      subtotal: fromCents(subtotalCents),
      discountPercent,
      discountAmount: fromCents(discountCents),
      total: fromCents(totalCents),
      subtotalCents,
      discountCents,
      totalCents,
    };
  }

  // Altstruktur (version 1) – Ausgabe unverändert wie vor Befehl 29
  const rates = normalizeRates(input.rates ?? { dailyRate: 0 });
  const legacy: Block[] = [{ key: "DAY", size: 1, cents: toCents(rates.dailyRate), label: TIER_LABEL.DAY }];
  if (rates.workWeekRate) legacy.push({ key: "WORK_WEEK", size: 5, cents: toCents(rates.workWeekRate), label: TIER_LABEL.WORK_WEEK });
  if (rates.weeklyRate) legacy.push({ key: "WEEK", size: 7, cents: toCents(rates.weeklyRate), label: TIER_LABEL.WEEK });
  if (rates.monthlyRate) legacy.push({ key: "MONTH", size: 30, cents: toCents(rates.monthlyRate), label: TIER_LABEL.MONTH });
  const counts = days === 0 ? new Map<string, number>() : strategy === "DAILY_ONLY" ? new Map<string, number>([["DAY", days]]) : cheapestBlocks(days, legacy);

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

/** Gesamtpreis in Cent – exakt aus den Centbeträgen (version 2) bzw. aus dem gerundeten Eurobetrag (version 1). */
export const totalCentsOf = (b: PriceBreakdown) => b.totalCents ?? toCents(b.total);

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

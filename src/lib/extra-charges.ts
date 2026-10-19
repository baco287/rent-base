// Zusatzkosten der Rückgabe. Jede Position speichert ihre Rechengrundlage, nicht nur den Endbetrag:
// Menge, Einheit, Einzelpreis, lesbare Formel und alle Eingangswerte. Die Preise kommen aus dem
// eingefrorenen Vertrag, nie aus dem aktuellen Fahrzeug.

import type { Prisma } from "@prisma/client";
import type { ExtraChargeType, KmPolicy } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { rentalDays } from "@/lib/pricing";

type Tx = Prisma.TransactionClient;

// Intl setzt ein geschütztes Leerzeichen vor das Eurozeichen; für gespeicherte Formeln ein normales verwenden
const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }).replace(/ /g, " ");
const num = (n: number, digits = 0) => n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;

export type ChargeDraft = {
  type: ExtraChargeType;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  formula: string;
  calculation: Record<string, unknown>;
};

/**
 * Befehl 29 Phase E: Zeitraum, für den Freikilometer gelten. Standardmiete: Vertragszeitraum (inkl. unterschriebener Nachträge),
 * unverändert. Offenes Mietende (Unfallersatz): tatsächliche Übergabe bis tatsächliche Rückgabe – dieselben Miettage wie Fallakte
 * und Rechnung; nie ein geplantes oder erfundenes Ende.
 */
export function mileagePeriod(contract: { startAt: Date; endAt: Date | null }, actualPickupAt: Date | null, actualEnd: Date): { start: Date; end: Date } {
  if (contract.endAt !== null) return { start: contract.startAt, end: contract.endAt };
  return { start: actualPickupAt ?? contract.startAt, end: actualEnd };
}

/** Mehrkilometer: gefahrene km minus Freikilometer (Tage × Frei-km je Tag) × Preis je km. */
export function extraMileageCharge(p: { pickupMileage: number; returnMileage: number; start: Date; end: Date; kmIncludedPerDay: number; extraKmRate: number }): ChargeDraft | null {
  const driven = p.returnMileage - p.pickupMileage;
  const days = rentalDays(p.start, p.end);
  const included = days * p.kmIncludedPerDay;
  const extra = Math.max(0, driven - included);
  if (extra === 0) return null;
  const amount = round2(extra * p.extraKmRate);
  return {
    type: "EXTRA_MILEAGE",
    description: "Mehrkilometer",
    quantity: extra,
    unit: "km",
    unitPrice: p.extraKmRate,
    amount,
    formula: `${num(extra)} km × ${eur(p.extraKmRate)} = ${eur(amount)}`,
    calculation: { pickupMileage: p.pickupMileage, returnMileage: p.returnMileage, drivenKm: driven, rentalDays: days, kmIncludedPerDay: p.kmIncludedPerDay, includedKm: included, extraKm: extra, extraKmRate: p.extraKmRate },
  };
}

// ---------------------------------------------------------------------------
// Mehrkilometer-Kulanz: regulärer Betrag und Entscheidung (individueller Betrag oder Erlass)
// ---------------------------------------------------------------------------

/** CUSTOM = individueller Betrag unter dem regulären, WAIVED = aus Kulanz erlassen (0 €). „Regulär berechnen“ hat keine Entscheidung. */
export type MileageDecisionKind = "CUSTOM" | "WAIVED";
/** Gespeichert in ExtraCharge.calculation.decision, alle Beträge in ganzen Cent. Die Begründung ist intern (nie auf Kundendokumenten). */
export type MileageDecision = {
  kind: MileageDecisionKind;
  regularCents: number;
  agreedCents: number;
  deviationCents: number;
  extraKm: number;
  reason: string;
  decidedById: string;
  decidedByName: string;
  /** ISO-Zeitpunkt */
  decidedAt: string;
  /** Mandant rechnet netto (pricesIncludeTax = false): Beträge im Text mit „netto“ */
  netPrices: boolean;
  /**
   * Steuermodus des Mandanten bei der Entscheidung (brutto true, netto false, nicht festgelegt null) – für die Kennzeichnung der
   * Beträge, unabhängig von einer späteren Änderung der Einstellung. Fehlt bei älteren Entscheidungen (nur JSON, kein Schema).
   */
  pricesIncludeTax?: boolean | null;
};

/** Nur das Vorhandensein des Schlüssels zählt (Hash, Sperren) – bewusst ohne Validierung, damit sich der Hash nie durch eine strengere Prüfung ändert. */
export function hasMileageDecision(calc: unknown): boolean {
  return !!calc && typeof calc === "object" && !Array.isArray(calc) && "decision" in calc;
}

/** Tolerantes Lesen für die Anzeige; unlesbare Angaben ergeben null. */
export function readMileageDecision(calc: unknown): MileageDecision | null {
  if (!hasMileageDecision(calc)) return null;
  const d = (calc as { decision?: unknown }).decision;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const kind = r.kind === "CUSTOM" || r.kind === "WAIVED" ? r.kind : null;
  const regularCents = int(r.regularCents);
  const agreedCents = int(r.agreedCents);
  if (!kind || regularCents == null || agreedCents == null) return null;
  return {
    kind,
    regularCents,
    agreedCents,
    deviationCents: int(r.deviationCents) ?? regularCents - agreedCents,
    extraKm: int(r.extraKm) ?? 0,
    reason: str(r.reason),
    decidedById: str(r.decidedById),
    decidedByName: str(r.decidedByName),
    decidedAt: str(r.decidedAt),
    netPrices: r.netPrices === true,
    // ältere Entscheidungen ohne gespeicherten Steuermodus: Feld bleibt weg (die Anzeige kennt dann nur „netto“ sicher)
    ...(r.pricesIncludeTax === true || r.pricesIncludeTax === false || r.pricesIncludeTax === null ? { pricesIncludeTax: r.pricesIncludeTax } : {}),
  };
}

/**
 * Regulärer Mehrkilometer-Betrag – eine reine Funktion für Vorschlag (returns.ts) und Abschlussprüfung (handovers.ts), damit
 * beide nie auseinanderlaufen. null bei unbegrenzten Kilometern, fehlendem Kilometerstand oder Rückgabe unter dem Übergabestand.
 * Die Kilometerregel übergibt der Aufrufer (wirksamer Vertragsstand), hier kein Import aus amendments.
 */
export function regularExtraMileage(p: {
  kmPolicy: KmPolicy;
  pickupMileage: number | null;
  returnMileage: number | null;
  contract: { startAt: Date; endAt: Date | null; kmIncludedPerDay: number; extraKmRate: number };
  actualPickupAt: Date | null;
  actualEnd: Date;
}): ChargeDraft | null {
  if (p.kmPolicy === "UNLIMITED") return null;
  if (p.pickupMileage == null || p.returnMileage == null || p.returnMileage < p.pickupMileage) return null;
  const period = mileagePeriod(p.contract, p.actualPickupAt, p.actualEnd);
  return extraMileageCharge({ pickupMileage: p.pickupMileage, returnMileage: p.returnMileage, start: period.start, end: period.end, kmIncludedPerDay: p.contract.kmIncludedPerDay, extraKmRate: p.contract.extraKmRate });
}

/**
 * Position mit Entscheidung: eine Pauschale über den vereinbarten Betrag mit Erläuterung (keine eigene Nachlasszeile – negative
 * Beträge gibt es nicht). Die bisherige Rechengrundlage bleibt in calculation erhalten, ergänzt um die reguläre Formel und die Entscheidung.
 */
export function mileageDecisionDraft(regular: ChargeDraft, d: MileageDecision): ChargeDraft {
  const m = (cents: number) => `${eur(cents / 100)}${d.netPrices ? " netto" : ""}`;
  const km = num(d.extraKm);
  const regularPart = `Regulär ${km} km × ${eur(regular.unitPrice)}${d.netPrices ? " netto" : ""} = ${m(d.regularCents)}`;
  const description = d.kind === "WAIVED" ? `${km} km über Freikilometer (regulär ${m(d.regularCents)}), aus Kulanz erlassen` : `${km} km über Freikilometer (regulär ${m(d.regularCents)}), Kulanznachlass ${m(d.deviationCents)}`;
  const formula = d.kind === "WAIVED" ? `${regularPart} · erlassen ${m(d.regularCents)} · berechnet ${m(0)}` : `${regularPart} · Kulanznachlass ${m(d.deviationCents)} · berechnet ${m(d.agreedCents)}`;
  return {
    type: "EXTRA_MILEAGE",
    description,
    quantity: 1,
    unit: "pauschal",
    unitPrice: d.agreedCents / 100,
    amount: d.agreedCents / 100,
    formula,
    calculation: { ...regular.calculation, regularFormula: regular.formula, decision: d },
  };
}

/** Tankfehlbetrag: fehlende Achtel × Tankgröße ÷ 8 × Preis je Liter. */
export function fuelCharge(p: { pickupEighths: number; returnEighths: number; tankCapacityLiters: number; pricePerLiter: number }): ChargeDraft | null {
  const missingEighths = Math.max(0, p.pickupEighths - p.returnEighths);
  if (missingEighths === 0) return null;
  const liters = round2((missingEighths / 8) * p.tankCapacityLiters);
  const amount = round2(liters * p.pricePerLiter);
  return {
    type: "FUEL",
    description: `Kraftstoff, ${missingEighths}/8 Tank fehlen`,
    quantity: liters,
    unit: "l",
    unitPrice: p.pricePerLiter,
    amount,
    formula: `${missingEighths}/8 × ${num(p.tankCapacityLiters)} l = ${num(liters, 2)} l × ${eur(p.pricePerLiter)} = ${eur(amount)}`,
    calculation: { ...p, missingEighths, liters },
  };
}

/** Freie Position, z. B. Reinigung pauschal oder fehlendes Zubehör. */
export function flatCharge(type: ExtraChargeType, description: string, quantity: number, unit: string, unitPrice: number): ChargeDraft {
  const amount = round2(quantity * unitPrice);
  return { type, description, quantity, unit, unitPrice, amount, formula: `${num(quantity, 2)} ${unit} × ${eur(unitPrice)} = ${eur(amount)}`, calculation: { quantity, unit, unitPrice } };
}

/** Speichert eine Position zur Buchung. Gehört sie zu einem Protokoll, muss dieses noch Entwurf sein. */
export type ChargeMeta = { source?: "PROPOSAL" | "MANUAL"; internalNote?: string | null; handoverDamageId?: string | null };

export async function saveExtraCharge(tx: Tx, tenantId: string, actorId: string | null, ref: { bookingId: string; handoverId?: string | null; damageId?: string | null }, charge: ChargeDraft, meta: ChargeMeta = {}) {
  const booking = await tx.booking.count({ where: { id: ref.bookingId, tenantId } });
  if (booking !== 1) throw new DomainError("Buchung nicht gefunden.");
  if (ref.handoverId) {
    const h = await tx.handover.findFirst({ where: { id: ref.handoverId, tenantId, bookingId: ref.bookingId } });
    if (!h) throw new DomainError("Das Protokoll gehört nicht zu dieser Buchung.");
    if (h.status !== "DRAFT") throw new DomainError("Das Protokoll ist finalisiert. Weitere Kosten bitte ohne Protokollbezug erfassen.");
  }
  return tx.extraCharge.create({
    data: {
      tenantId,
      bookingId: ref.bookingId,
      handoverId: ref.handoverId ?? null,
      damageId: ref.damageId ?? null,
      type: charge.type,
      description: charge.description,
      quantity: charge.quantity,
      unit: charge.unit,
      unitPrice: charge.unitPrice,
      amount: charge.amount,
      formula: charge.formula,
      calculation: charge.calculation as Prisma.InputJsonValue,
      source: meta.source ?? "MANUAL",
      internalNote: meta.internalNote ?? null,
      handoverDamageId: meta.handoverDamageId ?? null,
      createdById: actorId,
    },
  });
}

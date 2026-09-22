// Zusatzkosten der Rückgabe. Jede Position speichert ihre Rechengrundlage, nicht nur den Endbetrag:
// Menge, Einheit, Einzelpreis, lesbare Formel und alle Eingangswerte. Die Preise kommen aus dem
// eingefrorenen Vertrag, nie aus dem aktuellen Fahrzeug.

import type { Prisma } from "@prisma/client";
import type { ExtraChargeType } from "@/lib/constants";
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

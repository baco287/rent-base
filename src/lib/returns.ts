// Rückgabe: Vergleich mit dem Übergabezustand, Kostenvorschläge und Zusatzkosten.
//
// Grundsätze:
// - Verglichen wird ausschließlich mit dem finalisierten Übergabeprotokoll dieser Miete und dem eingefrorenen
//   Vertrag. Aktuelle Fahrzeugpreise oder Stammdaten spielen keine Rolle.
// - Ein Vorschlag ist keine Forderung. Erst wenn ein Mitarbeiter ihn bestätigt, entsteht eine Zusatzkostenposition.
// - Für Schäden erzeugt das System nie einen Betrag; eine Position vom Typ DAMAGE legt nur ein Mitarbeiter an,
//   und auch sie bedeutet nur "Kostenposition zu diesem Schaden", keine Haftungsfeststellung.
// - Verspätung wird berechnet und angezeigt. Eine Gebühr dafür ist im Vertrag nicht geregelt, also gibt es keinen Vorschlag.

import { effectiveKeyDropEnd } from "@/lib/key-drop-checks";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { CHARGE_UNITS, EXTRA_CHARGE_TYPES, FUEL_POLICIES, energyRequirements, type ExtraChargeType } from "@/lib/constants";
import { extraMileageCharge, flatCharge, fuelCharge, saveExtraCharge, type ChargeDraft } from "@/lib/extra-charges";
import { touchHandover } from "@/lib/handovers";
import { DomainError, assertHandoverDraft } from "@/lib/integrity";
import { rentalDays } from "@/lib/pricing";
import type { VehicleSnapshot } from "@/lib/contracts";
import { fmtMinutes } from "@/lib/handover-view";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };

export type Proposal = { key: "EXTRA_MILEAGE" | "FUEL"; draft: ChargeDraft; confirmed: boolean; chargeId: string | null };
export type ReturnHint = { code: string; text: string };

export type ReturnComparison = {
  pickup: { id: string; number: string; mileage: number | null; fuelLevelEighths: number | null; batteryPercent: number | null; finalizedAt: Date | null };
  mileage: { pickup: number | null; return: number | null; driven: number | null };
  fuel: { pickup: number | null; return: number | null; diff: number | null } | null;
  battery: { pickup: number | null; return: number | null; diff: number | null } | null;
  time: { start: Date; plannedEnd: Date; actualEnd: Date; lateMinutes: number; rentalDays: number };
  contract: { number: string; kmIncludedPerDay: number; includedKm: number; extraKmRate: number; fuelPolicy: string; fuelPolicyLabel: string; fuelPolicyNote: string | null; fuelPricePerLiter: number | null; deposit: number; deductible: number; tankCapacityLiters: number | null };
  /** Literpreis, der für die Rechnung gilt: aus dem Vertrag, sonst der bei der Rückgabe angegebene */
  effectiveFuelPrice: { value: number; origin: "Vertrag" | "Rückgabe" } | null;
  proposals: Proposal[];
  hints: ReturnHint[];
  charges: ChargeRow[];
  chargesTotal: number;
};

export type ChargeRow = {
  id: string;
  type: string;
  typeLabel: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  formula: string;
  source: string;
  internalNote: string | null;
  handoverDamageId: string | null;
};

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? null : Number(v));

export function chargeRow(c: Prisma.ExtraChargeGetPayload<object>): ChargeRow {
  return {
    id: c.id,
    type: c.type,
    typeLabel: EXTRA_CHARGE_TYPES[c.type as ExtraChargeType] ?? c.type,
    description: c.description,
    quantity: Number(c.quantity),
    unit: c.unit,
    unitPrice: Number(c.unitPrice),
    amount: Number(c.amount),
    formula: c.formula,
    source: c.source,
    internalNote: c.internalNote,
    handoverDamageId: c.handoverDamageId,
  };
}

async function loadReturn(tx: Tx, tenantId: string, handoverId: string) {
  const h = await tx.handover.findFirst({ where: { id: handoverId, tenantId }, include: { extraCharges: { orderBy: { createdAt: "asc" } }, damages: true } });
  if (!h) throw new DomainError("Protokoll nicht gefunden.");
  if (h.type !== "RETURN") throw new DomainError("Dieses Protokoll ist keine Rückgabe.");
  const [booking, contract, pickup] = await Promise.all([
    tx.booking.findFirstOrThrow({ where: { id: h.bookingId, tenantId } }),
    h.contractId ? tx.rentalContract.findFirst({ where: { id: h.contractId, tenantId } }) : null,
    tx.handover.findFirst({ where: { tenantId, bookingId: h.bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" } }),
  ]);
  if (!contract || contract.status !== "SIGNED") throw new DomainError("Zu dieser Miete gibt es keinen abgeschlossenen Mietvertrag.");
  if (!pickup) throw new DomainError("Zu dieser Miete gibt es kein abgeschlossenes Übergabeprotokoll.");
  return { h, booking, contract, pickup };
}

/** Der komplette Vergleich Übergabe/Rückgabe samt Vorschlägen. Rechnet nur mit Snapshots. */
export function buildComparison(input: {
  handover: Prisma.HandoverGetPayload<{ include: { extraCharges: true } }>;
  booking: { startAt: Date; endAt: Date; actualPickupAt: Date | null };
  contract: Prisma.RentalContractGetPayload<object>;
  pickup: Prisma.HandoverGetPayload<object>;
  now?: Date;
}): ReturnComparison {
  const { handover: h, booking, contract, pickup } = input;
  const v = contract.vehicleSnapshot as Partial<VehicleSnapshot>;
  const energy = energyRequirements(h.driveType);
  // Befehl 20.6: kontaktlos zählt die vom Kunden gemeldete Abgabe als Mietende (nicht der spätere Kontrollzeitpunkt)
  const actualEnd = effectiveKeyDropEnd(h) ?? h.finalizedAt ?? input.now ?? new Date();
  const start = booking.actualPickupAt ?? contract.startAt;
  const days = rentalDays(contract.startAt, contract.endAt);
  const lateMinutes = Math.max(0, Math.round((actualEnd.getTime() - contract.endAt.getTime()) / 60_000));

  const driven = h.mileage != null && pickup.mileage != null ? h.mileage - pickup.mileage : null;
  const contractFuelPrice = num(contract.fuelPricePerLiter);
  const returnFuelPrice = num(h.fuelPricePerLiter);
  const effectiveFuelPrice = contractFuelPrice != null && contractFuelPrice > 0 ? { value: contractFuelPrice, origin: "Vertrag" as const } : returnFuelPrice != null && returnFuelPrice > 0 ? { value: returnFuelPrice, origin: "Rückgabe" as const } : null;
  const tank = v.tankCapacityLiters ?? null;

  const proposals: Proposal[] = [];
  const hints: ReturnHint[] = [];
  const confirmedOf = (type: string) => h.extraCharges.find((c) => c.type === type && c.source === "PROPOSAL");

  // Mehrkilometer: Freikilometer je Vertrag × Vertragstage, Preis aus dem Vertrag
  if (driven != null && driven >= 0) {
    const draft = extraMileageCharge({ pickupMileage: pickup.mileage!, returnMileage: h.mileage!, start: contract.startAt, end: contract.endAt, kmIncludedPerDay: contract.kmIncludedPerDay, extraKmRate: Number(contract.extraKmRate) });
    if (draft) { const c = confirmedOf("EXTRA_MILEAGE"); proposals.push({ key: "EXTRA_MILEAGE", draft, confirmed: !!c, chargeId: c?.id ?? null }); }
  }

  // Kraftstoff: nur wenn die Tankregel eine Nachberechnung vorsieht und Preis sowie Tankgröße belastbar vorliegen
  const fuelDiff = energy.fuel && h.fuelLevelEighths != null && pickup.fuelLevelEighths != null ? h.fuelLevelEighths - pickup.fuelLevelEighths : null;
  const batteryDiff = energy.battery && h.batteryPercent != null && pickup.batteryPercent != null ? h.batteryPercent - pickup.batteryPercent : null;
  const refuelPolicy = contract.fuelPolicy === "FULL_TO_FULL" || contract.fuelPolicy === "SAME_LEVEL";
  if (fuelDiff != null && fuelDiff < 0) {
    if (contract.fuelPolicy === "INCLUDED") hints.push({ code: "FUEL_INCLUDED", text: `Der Tank ist um ${-fuelDiff}/8 niedriger als bei der Übergabe. Laut Vertrag ist Kraftstoff inklusive, es wird nichts berechnet.` });
    else if (!refuelPolicy) hints.push({ code: "FUEL_POLICY_OTHER", text: `Der Tank ist um ${-fuelDiff}/8 niedriger als bei der Übergabe. Die Tankregelung ist individuell (${contract.fuelPolicyNote || "ohne Beschreibung"}); bei Bedarf eine Position „Kraftstoff“ manuell erfassen.` });
    else if (!effectiveFuelPrice || !tank) hints.push({ code: "FUEL_NO_BASIS", text: `Der Tank ist um ${-fuelDiff}/8 niedriger als bei der Übergabe. ${!tank ? "Die Tankgröße ist im Vertrag nicht hinterlegt" : "Im Vertrag steht kein Literpreis"}; ohne belastbare Grundlage wird nichts berechnet. Bei Bedarf einen Literpreis für diese Rückgabe angeben oder eine Position manuell erfassen.` });
    else {
      const draft = fuelCharge({ pickupEighths: pickup.fuelLevelEighths!, returnEighths: h.fuelLevelEighths!, tankCapacityLiters: tank, pricePerLiter: effectiveFuelPrice.value });
      if (draft) {
        draft.calculation = { ...draft.calculation, priceOrigin: effectiveFuelPrice.origin, fuelPolicy: contract.fuelPolicy };
        const c = confirmedOf("FUEL");
        proposals.push({ key: "FUEL", draft, confirmed: !!c, chargeId: c?.id ?? null });
      }
    }
  }
  if (batteryDiff != null && batteryDiff < 0) hints.push({ code: "CHARGING_NO_BASIS", text: `Die Batterie ist um ${-batteryDiff} Prozentpunkte niedriger als bei der Übergabe. Ein Ladepreis ist nicht vereinbart; bei Bedarf eine Position „Ladung“ manuell erfassen.` });
  if (lateMinutes > 15) hints.push({ code: "LATE_RETURN", text: `Die Rückgabe erfolgt ${fmtMinutes(lateMinutes)} nach der vereinbarten Zeit. Eine Verspätungsgebühr ist im Vertrag nicht geregelt und wird nicht automatisch berechnet; bei Bedarf eine Position „Verspätete Rückgabe“ manuell erfassen.` });

  const charges = h.extraCharges.map(chargeRow);
  return {
    pickup: { id: pickup.id, number: pickup.number, mileage: pickup.mileage, fuelLevelEighths: pickup.fuelLevelEighths, batteryPercent: pickup.batteryPercent, finalizedAt: pickup.finalizedAt },
    mileage: { pickup: pickup.mileage, return: h.mileage, driven },
    fuel: energy.fuel ? { pickup: pickup.fuelLevelEighths, return: h.fuelLevelEighths, diff: fuelDiff } : null,
    battery: energy.battery ? { pickup: pickup.batteryPercent, return: h.batteryPercent, diff: batteryDiff } : null,
    time: { start, plannedEnd: contract.endAt, actualEnd, lateMinutes, rentalDays: days },
    contract: {
      number: contract.number,
      kmIncludedPerDay: contract.kmIncludedPerDay,
      includedKm: contract.kmIncludedPerDay * days,
      extraKmRate: Number(contract.extraKmRate),
      fuelPolicy: contract.fuelPolicy,
      fuelPolicyLabel: FUEL_POLICIES[contract.fuelPolicy as keyof typeof FUEL_POLICIES] ?? contract.fuelPolicy,
      fuelPolicyNote: contract.fuelPolicyNote,
      fuelPricePerLiter: contractFuelPrice,
      deposit: Number(contract.deposit),
      deductible: Number(contract.deductible),
      tankCapacityLiters: tank,
    },
    effectiveFuelPrice,
    proposals,
    hints,
    charges,
    chargesTotal: Math.round(charges.reduce((s, c) => s + c.amount, 0) * 100) / 100,
  };
}

export { fmtMinutes };

export async function getReturnComparison(tenantId: string, handoverId: string): Promise<ReturnComparison> {
  return db.$transaction(async (tx) => {
    const { h, booking, contract, pickup } = await loadReturn(tx, tenantId, handoverId);
    return buildComparison({ handover: h, booking, contract, pickup });
  }, TX);
}

/** Zusatzkosten gehören zum Inhalt: danach werden Unterschriften verworfen, deren Hash nicht mehr passt. */
const touchAfterCharge = (tx: Tx, tenantId: string, handoverId: string) => touchHandover(tx, tenantId, handoverId);

/** Mitarbeiter bestätigt einen Vorschlag. Der Betrag wird serverseitig neu berechnet, nie aus dem Formular übernommen. */
export async function confirmProposal(tenantId: string, handoverId: string, actorId: string | null, key: Proposal["key"]) {
  return db.$transaction(async (tx) => {
    const { h, booking, contract, pickup } = await loadReturn(tx, tenantId, handoverId);
    assertHandoverDraft(h);
    const cmp = buildComparison({ handover: h, booking, contract, pickup });
    const p = cmp.proposals.find((x) => x.key === key);
    if (!p) throw new DomainError("Für diese Position gibt es derzeit keinen Vorschlag.");
    if (p.confirmed) throw new DomainError("Diese Position wurde bereits bestätigt.");
    const created = await saveExtraCharge(tx, tenantId, actorId, { bookingId: h.bookingId, handoverId: h.id }, p.draft, { source: "PROPOSAL" });
    await touchAfterCharge(tx, tenantId, h.id);
    return created;
  }, TX);
}

export type ManualChargeInput = {
  type: ExtraChargeType;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  internalNote?: string | null;
  /** nur bei Typ DAMAGE: ein bei dieser Rückgabe neu erfasster Schaden */
  handoverDamageId?: string | null;
};

/** Frei erfasste Position. Bei Schäden ist das ausdrücklich nur eine Kostenposition, keine Haftungsfeststellung. */
export async function addManualCharge(tenantId: string, handoverId: string, actorId: string | null, input: ManualChargeInput) {
  if (!(input.type in EXTRA_CHARGE_TYPES)) throw new DomainError("Unbekannte Kostenart.");
  if (input.description.trim().length < 3) throw new DomainError("Bitte die Position kurz beschreiben (für den Mieter sichtbar).");
  if (!(Number.isFinite(input.quantity) && input.quantity > 0 && input.quantity <= 100_000)) throw new DomainError("Die Menge muss größer als 0 sein.");
  if (!(Number.isFinite(input.unitPrice) && input.unitPrice >= 0 && input.unitPrice <= 1_000_000)) throw new DomainError("Der Einzelpreis darf nicht negativ sein.");
  if (!(CHARGE_UNITS as readonly string[]).includes(input.unit)) throw new DomainError("Unbekannte Einheit.");
  return db.$transaction(async (tx) => {
    const { h } = await loadReturn(tx, tenantId, handoverId);
    assertHandoverDraft(h);
    let damageRef: string | null = null;
    if (input.handoverDamageId) {
      if (input.type !== "DAMAGE") throw new DomainError("Nur eine Position vom Typ „Schaden“ kann mit einem Schaden verknüpft werden.");
      const d = h.damages.find((x) => x.id === input.handoverDamageId && x.marker === "NEW");
      if (!d) throw new DomainError("Der Schaden gehört nicht zu den bei dieser Rückgabe neu erfassten Schäden.");
      damageRef = d.id;
    }
    const draft = flatCharge(input.type, input.description.trim(), Math.round(input.quantity * 100) / 100, input.unit, Math.round(input.unitPrice * 100) / 100);
    const created = await saveExtraCharge(tx, tenantId, actorId, { bookingId: h.bookingId, handoverId: h.id }, draft, { source: "MANUAL", internalNote: input.internalNote?.trim() || null, handoverDamageId: damageRef });
    await touchAfterCharge(tx, tenantId, h.id);
    return created;
  }, TX);
}

export async function removeCharge(tenantId: string, handoverId: string, chargeId: string) {
  return db.$transaction(async (tx) => {
    const { h } = await loadReturn(tx, tenantId, handoverId);
    assertHandoverDraft(h);
    const c = h.extraCharges.find((x) => x.id === chargeId);
    if (!c) throw new DomainError("Position nicht gefunden.");
    await tx.extraCharge.delete({ where: { id: c.id } });
    await touchAfterCharge(tx, tenantId, h.id);
  }, TX);
}

/** Vergleich für ein finalisiertes Protokoll (Ansicht und PDF): Rechnet aus denselben Snapshots, ohne "jetzt". */
export async function loadSealedComparison(tx: Tx, tenantId: string, handoverId: string): Promise<ReturnComparison | null> {
  const h = await tx.handover.findFirst({ where: { id: handoverId, tenantId, type: "RETURN" }, include: { extraCharges: { orderBy: { createdAt: "asc" } } } });
  if (!h || !h.contractId) return null;
  const [booking, contract, pickup] = await Promise.all([
    tx.booking.findFirst({ where: { id: h.bookingId, tenantId } }),
    tx.rentalContract.findFirst({ where: { id: h.contractId, tenantId } }),
    tx.handover.findFirst({ where: { tenantId, bookingId: h.bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" } }),
  ]);
  if (!booking || !contract || !pickup) return null;
  return buildComparison({ handover: h, booking, contract, pickup });
}

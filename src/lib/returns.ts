// Rückgabe: Vergleich mit dem Übergabezustand, Kostenvorschläge und Zusatzkosten.
//
// Grundsätze:
// - Verglichen wird ausschließlich mit dem finalisierten Übergabeprotokoll dieser Miete und dem eingefrorenen
//   Vertrag. Aktuelle Fahrzeugpreise oder Stammdaten spielen keine Rolle.
// - Ein Vorschlag ist keine Forderung. Erst wenn ein Mitarbeiter ihn bestätigt, entsteht eine Zusatzkostenposition.
// - Für Schäden erzeugt das System nie einen Betrag; eine Position vom Typ DAMAGE legt nur ein Mitarbeiter an,
//   und auch sie bedeutet nur "Kostenposition zu diesem Schaden", keine Haftungsfeststellung.
// - Verspätung wird berechnet und angezeigt. Seit Befehl 28 entsteht nach der im Vertrag eingefrorenen Verspätungsregel ein
//   Vorschlag (bewusst bestätigen); ohne maschinenlesbare Regel bleibt es beim Hinweis, ein Betrag wird nie erfunden.
// - Mehrkilometer-Kulanz: Mehrkilometer werden immer entschieden – regulär berechnen (jede Rolle) oder, nur Inhaber und
//   Disposition, einen niedrigeren Betrag festlegen bzw. erlassen (Pflichtbegründung, Audit). Die Entscheidung ist die eine
//   EXTRA_MILEAGE-Position mit source PROPOSAL; ein offener Vorschlag > 0 € blockiert den Abschluss (collectIssues).

import { effectiveKeyDropEnd } from "@/lib/key-drop-checks";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { accessoryPrice, accessoryProposalKey, missingAccessories, type ChecklistAnswer } from "@/lib/accessories";
import { readContractRules, resolveRules, type BusinessRules } from "@/lib/business-rules";
import { CHARGE_UNITS, EXTRA_CHARGE_TYPES, FUEL_POLICIES, LATE_RETURN_RULES, energyRequirements, type ExtraChargeType, type LateReturnRule } from "@/lib/constants";
import { fmtDateTime } from "@/lib/format";
import { flatCharge, fuelCharge, hasMileageDecision, mileageDecisionDraft, mileagePeriod, readMileageDecision, regularExtraMileage, saveExtraCharge, type ChargeDraft, type MileageDecision, type MileageDecisionKind } from "@/lib/extra-charges";
import { fmtCents, parseEuroInput, toCents } from "@/lib/money";
import { touchHandover } from "@/lib/handovers";
import { contractKmPolicy, extensionPriceProposal, loadEffectiveContract } from "@/lib/amendments";
import type { KmPolicy } from "@/lib/constants";
import { DomainError, assertHandoverDraft } from "@/lib/integrity";
import { ACCIDENT_CASE_CLOSED_MESSAGE, accidentCaseClosed } from "@/lib/accident-replacement-events";
import { rentalDays } from "@/lib/pricing";
import type { VehicleSnapshot } from "@/lib/contracts";
import { fmtMinutes } from "@/lib/handover-view";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };

/** EXTRA_MILEAGE, FUEL oder ACCESSORY_<Checklistenschlüssel> (Befehl 20.9: fehlendes Zubehör mit Standard-Ersatzpreis) */
export type ProposalKey = "EXTRA_MILEAGE" | "FUEL" | "LATE_RETURN" | `ACCESSORY_${string}`;
/** dismissed (Befehl 20.9): Mitarbeiter hat „Nicht berechnen“ gewählt – dokumentiert, keine Position; facts: Sachverhalt in Kurzform */
export type Proposal = { key: ProposalKey; draft: ChargeDraft; confirmed: boolean; chargeId: string | null; dismissed: boolean; facts?: string[] };
export type ReturnHint = { code: string; text: string };

/** Checklisten-Antworten und Regeln, aus denen die Rückgabe fehlendes Zubehör erkennt (Befehl 20.9). */
export type AccessoryContext = { pickup: ChecklistAnswer[]; ret: ChecklistAnswer[]; contractRules: Partial<BusinessRules> | null; currentRules: Partial<BusinessRules> | null };

export type ReturnComparison = {
  pickup: { id: string; number: string; mileage: number | null; fuelLevelEighths: number | null; batteryPercent: number | null; finalizedAt: Date | null };
  mileage: { pickup: number | null; return: number | null; driven: number | null };
  fuel: { pickup: number | null; return: number | null; diff: number | null } | null;
  battery: { pickup: number | null; return: number | null; diff: number | null } | null;
  /** plannedEnd null = offenes Mietende (Unfallersatz): keine Verspätung, Miettage bis zur tatsächlichen Rückgabe */
  time: { start: Date; plannedEnd: Date | null; actualEnd: Date; lateMinutes: number; rentalDays: number };
  /** Befehl 27: kmPolicy laut wirksamem Vertragsstand; bei UNLIMITED gibt es keine Mehrkilometer (includedKm = null).
   *  Mehrkilometer-Kulanz: kmPolicyNote = Regeltext der individuellen Kilometerregel (nur bei INDIVIDUAL) */
  contract: { number: string; amendmentNumbers: string[]; kmPolicy: KmPolicy; kmPolicyNote: string | null; kmIncludedPerDay: number; includedKm: number | null; extraKmRate: number; fuelPolicy: string; fuelPolicyLabel: string; fuelPolicyNote: string | null; fuelPricePerLiter: number | null; deposit: number; deductible: number; tankCapacityLiters: number | null };
  /** Literpreis, der für die Rechnung gilt: aus dem Vertrag, sonst der bei der Rückgabe angegebene */
  effectiveFuelPrice: { value: number; origin: "Vertrag" | "Rückgabe" } | null;
  proposals: Proposal[];
  hints: ReturnHint[];
  charges: ChargeRow[];
  chargesTotal: number;
  /** Mehrkilometer-Kulanz: Stand der Mehrkilometer-Abrechnung, nur aus vorhandenen Werten abgeleitet (veraltet steht in den issues) */
  mileageBilling: MileageBilling | null;
};

/**
 * Mehrkilometer-Kulanz: Zustand der Mehrkilometer-Abrechnung.
 * UNLIMITED/NO_READING/NONE: keine Forderung möglich · ZERO_RATE: Mehrkilometer, aber Preis je Mehrkilometer 0 € – keine Forderung,
 * nichts zu entscheiden (kein Blocker) · OPEN: Vorschlag > 0 € offen · DISMISSED_LEGACY: früher ohne Begründung „Nicht berechnet“
 * (zählt nicht mehr) · LEGACY_MANUAL: manuell erfasste Position (Altbestand) · REGULAR/CUSTOM/WAIVED: entschieden.
 */
export type MileageBillingState = "UNLIMITED" | "NO_READING" | "NONE" | "ZERO_RATE" | "OPEN" | "DISMISSED_LEGACY" | "LEGACY_MANUAL" | "REGULAR" | "CUSTOM" | "WAIVED";
export type MileageBilling = {
  policy: KmPolicy;
  policyNote: string | null;
  drivenKm: number | null;
  rentalDays: number;
  kmIncludedPerDay: number;
  includedKm: number | null;
  extraKm: number;
  extraKmRate: number;
  /** regulärer Betrag laut aktuellem Stand (Euro); 0 ohne Vorschlag */
  regularAmount: number;
  state: MileageBillingState;
  chargeId: string | null;
  chargedAmount: number | null;
  /**
   * netPrices/pricesIncludeTax: Steuermodus aus dem gespeicherten Entscheidungsstand (Kennzeichnung der Beträge, nicht die heutige
   * Mandanteneinstellung); pricesIncludeTax fehlt bei älteren Entscheidungen ohne gespeicherten Modus.
   */
  decision: { kind: MileageDecisionKind; regularAmount: number; agreedAmount: number; deviation: number; reason: string; decidedByName: string; decidedAt: string; netPrices: boolean; pricesIncludeTax?: boolean | null } | null;
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
  /** Mehrkilometer-Kulanz: individuell festgelegt oder erlassen (Beträge in Euro) */
  decision: { kind: MileageDecisionKind; regularAmount: number; agreedAmount: number } | null;
};

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? null : Number(v));

export function chargeRow(c: Prisma.ExtraChargeGetPayload<object>): ChargeRow {
  const d = c.type === "EXTRA_MILEAGE" ? readMileageDecision(c.calculation) : null;
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
    decision: d ? { kind: d.kind, regularAmount: d.regularCents / 100, agreedAmount: d.agreedCents / 100 } : null,
  };
}

const answerSelect = { select: { itemKey: true, result: true } } as const;

/**
 * Zubehörkontext: Antworten beider Checklisten und die Ersatzpreise. Preise kommen aus dem Vertragsschnappschuss der
 * Geschäftsregeln; nur wenn der Schnappschuss die Regel noch nicht kannte (ältere Verträge), aus den aktuell aufgelösten
 * Regeln von Fahrzeug → Gruppe → Mandant. Feste Standardpreise (Warndreieck usw.) stehen in lib/accessories.ts.
 */
async function accessoryContext(tx: Tx, tenantId: string, h: { vehicleId: string; checklistItems: ChecklistAnswer[] }, contract: { conditions: Prisma.JsonValue }, pickup: { checklistItems: ChecklistAnswer[] }): Promise<AccessoryContext> {
  const [vehicle, tenant] = await Promise.all([
    tx.vehicle.findFirst({ where: { id: h.vehicleId, tenantId }, select: { plate: true, businessRules: true, group: { select: { name: true, businessRules: true } } } }),
    tx.tenant.findUnique({ where: { id: tenantId }, select: { businessRules: true } }),
  ]);
  return {
    pickup: pickup.checklistItems,
    ret: h.checklistItems,
    contractRules: readContractRules(contract.conditions)?.values ?? null,
    currentRules: vehicle ? resolveRules(tenant?.businessRules, vehicle.group, vehicle).values : null,
  };
}

async function loadReturn(tx: Tx, tenantId: string, handoverId: string) {
  const h = await tx.handover.findFirst({ where: { id: handoverId, tenantId }, include: { extraCharges: { orderBy: { createdAt: "asc" } }, damages: true, checklistItems: answerSelect } });
  if (!h) throw new DomainError("Protokoll nicht gefunden.");
  if (h.type !== "RETURN") throw new DomainError("Dieses Protokoll ist keine Rückgabe.");
  const [booking, contract, pickup] = await Promise.all([
    tx.booking.findFirstOrThrow({ where: { id: h.bookingId, tenantId } }),
    h.contractId ? tx.rentalContract.findFirst({ where: { id: h.contractId, tenantId } }) : null,
    tx.handover.findFirst({ where: { tenantId, bookingId: h.bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" }, include: { checklistItems: answerSelect } }),
  ]);
  if (!contract || contract.status !== "SIGNED") throw new DomainError("Zu dieser Miete gibt es keinen abgeschlossenen Mietvertrag.");
  if (!pickup) throw new DomainError("Zu dieser Miete gibt es kein abgeschlossenes Übergabeprotokoll.");
  const accessories = await accessoryContext(tx, tenantId, h, contract, pickup);
  // Befehl 25: die Rückgabe rechnet mit dem wirksamen Vertragsstand (Vertrag + unterschriebene Nachträge), nie mit dem Original allein
  const vehicleTank = await tx.vehicle.findFirst({ where: { id: h.vehicleId, tenantId }, select: { tankCapacityLiters: true } });
  return { h, booking, contract: await loadEffectiveContract(tx, tenantId, contract), pickup, accessories, vehicleTankLiters: vehicleTank?.tankCapacityLiters ?? null };
}

/** Der komplette Vergleich Übergabe/Rückgabe samt Vorschlägen. Rechnet nur mit Snapshots. */
export function buildComparison(input: {
  handover: Prisma.HandoverGetPayload<{ include: { extraCharges: true } }>;
  booking: { startAt: Date; endAt: Date | null; actualPickupAt: Date | null };
  /** wirksamer Vertragsstand (lib/amendments overlayAmendments); der Original-Vertrag allein wäre nach einem Nachtrag falsch */
  contract: Prisma.RentalContractGetPayload<object> & { amended?: { numbers: string[]; kmPolicy?: KmPolicy } };
  pickup: Prisma.HandoverGetPayload<object>;
  /** Befehl 27: Tankgröße des Fahrzeugs, falls der Vertrags-Schnappschuss (ältere Verträge) keine enthält */
  vehicleTankLiters?: number | null;
  /** Befehl 20.9: ohne Kontext werden keine Zubehörvorschläge gebildet */
  accessories?: AccessoryContext | null;
  now?: Date;
}): ReturnComparison {
  const { handover: h, booking, contract, pickup } = input;
  const dismissed = new Set<string>(h.dismissedProposals ?? []);
  const v = contract.vehicleSnapshot as Partial<VehicleSnapshot>;
  const energy = energyRequirements(h.driveType);
  // Befehl 20.6: kontaktlos zählt die vom Kunden gemeldete Abgabe als Mietende (nicht der spätere Kontrollzeitpunkt)
  const actualEnd = effectiveKeyDropEnd(h) ?? h.finalizedAt ?? input.now ?? new Date();
  const start = booking.actualPickupAt ?? contract.startAt;
  // Befehl 29: offenes Vertragsende (Unfallersatz) – Miettage und Freikilometer ab der tatsächlichen Übergabe bis zur tatsächlichen
  // Rückgabe (Phase E: wie Fallakte und Rechnung), keine Verspätung. Standardmiete: Vertragszeitraum wie bisher.
  const contractEnd = contract.endAt;
  const kmPeriod = mileagePeriod(contract, booking.actualPickupAt, actualEnd);
  const days = rentalDays(kmPeriod.start, kmPeriod.end);
  const lateMinutes = contractEnd ? Math.max(0, Math.round((actualEnd.getTime() - contractEnd.getTime()) / 60_000)) : 0;

  const driven = h.mileage != null && pickup.mileage != null ? h.mileage - pickup.mileage : null;
  const contractFuelPrice = num(contract.fuelPricePerLiter);
  const returnFuelPrice = num(h.fuelPricePerLiter);
  const effectiveFuelPrice = contractFuelPrice != null && contractFuelPrice > 0 ? { value: contractFuelPrice, origin: "Vertrag" as const } : returnFuelPrice != null && returnFuelPrice > 0 ? { value: returnFuelPrice, origin: "Rückgabe" as const } : null;
  // Tankgröße: aus dem Vertrags-Schnappschuss; ältere Verträge ohne Angabe nutzen die am Fahrzeug gepflegte Größe (physische
  // Eigenschaft, keine Vertragskondition – ein Vorschlag wird ohnehin erst durch bewusste Bestätigung zur Position)
  const tank = v.tankCapacityLiters ?? input.vehicleTankLiters ?? null;
  const tankOrigin = v.tankCapacityLiters != null ? "Vertrag" : tank != null ? "Fahrzeug" : null;
  // Befehl 27: Kilometerregel aus dem wirksamen Vertragsstand (Vertrag + unterschriebene Nachträge)
  const kmPolicy: KmPolicy = contract.amended?.kmPolicy ?? contractKmPolicy(contract.conditions);

  const proposals: Proposal[] = [];
  const hints: ReturnHint[] = [];
  const confirmedOf = (type: string) => h.extraCharges.find((c) => c.type === type && c.source === "PROPOSAL");

  // Mehrkilometer: Freikilometer je Vertrag × Vertragstage, Preis aus dem Vertrag. Bei „Unbegrenzte Kilometer“ nie.
  // Mehrkilometer-Kulanz: dieselbe reine Rechenfunktion wie die Abschlussprüfung (regularExtraMileage), keine zweite Logik
  if (kmPolicy === "UNLIMITED") hints.push({ code: "KM_UNLIMITED", text: "Unbegrenzte Kilometer vereinbart – es werden keine Mehrkilometer berechnet. Der Kilometerstand wird trotzdem dokumentiert." });
  else {
    const draft = regularExtraMileage({ kmPolicy, pickupMileage: pickup.mileage, returnMileage: h.mileage, contract: { startAt: contract.startAt, endAt: contract.endAt, kmIncludedPerDay: contract.kmIncludedPerDay, extraKmRate: Number(contract.extraKmRate) }, actualPickupAt: booking.actualPickupAt, actualEnd });
    if (draft) { const c = confirmedOf("EXTRA_MILEAGE"); proposals.push({ key: "EXTRA_MILEAGE", draft, confirmed: !!c, chargeId: c?.id ?? null, dismissed: dismissed.has("EXTRA_MILEAGE") }); }
  }
  // Mehrkilometer-Kulanz: Zustand nur aus vorhandenen Werten (Vorschlag, Positionen, „Nicht berechnet“) – „veraltet“ meldet collectIssues
  const kmProposal = proposals.find((p) => p.key === "EXTRA_MILEAGE") ?? null;
  const kmCharge = confirmedOf("EXTRA_MILEAGE") ?? null;
  const kmManual = h.extraCharges.find((c) => c.type === "EXTRA_MILEAGE" && c.source !== "PROPOSAL") ?? null;
  const kmDecision = kmCharge ? readMileageDecision(kmCharge.calculation) : null;
  const kmState: MileageBillingState =
    kmCharge ? (kmDecision?.kind ?? "REGULAR")
    : kmManual ? "LEGACY_MANUAL"
    : kmPolicy === "UNLIMITED" ? "UNLIMITED"
    : driven == null || driven < 0 ? "NO_READING"
    : !kmProposal ? "NONE"
    // Preis je Mehrkilometer 0 €: keine Forderung, nichts zu entscheiden (collectIssues blockiert erst ab regulär > 0 €)
    : toCents(kmProposal.draft.amount) === 0 ? "ZERO_RATE"
    : kmProposal.dismissed ? "DISMISSED_LEGACY"
    : "OPEN";
  const mileageBilling: MileageBilling = {
    policy: kmPolicy,
    policyNote: kmPolicy === "INDIVIDUAL" ? (readContractRules(contract.conditions)?.values.kmPolicyNote ?? null) : null,
    drivenKm: driven,
    rentalDays: days,
    kmIncludedPerDay: contract.kmIncludedPerDay,
    includedKm: kmPolicy === "UNLIMITED" ? null : contract.kmIncludedPerDay * days,
    extraKm: kmProposal?.draft.quantity ?? 0,
    extraKmRate: Number(contract.extraKmRate),
    regularAmount: kmProposal?.draft.amount ?? 0,
    state: kmState,
    chargeId: kmCharge?.id ?? kmManual?.id ?? null,
    chargedAmount: kmCharge ? Number(kmCharge.amount) : kmManual ? Number(kmManual.amount) : null,
    decision: kmDecision ? { kind: kmDecision.kind, regularAmount: kmDecision.regularCents / 100, agreedAmount: kmDecision.agreedCents / 100, deviation: kmDecision.deviationCents / 100, reason: kmDecision.reason, decidedByName: kmDecision.decidedByName, decidedAt: kmDecision.decidedAt, netPrices: kmDecision.netPrices, ...(kmDecision.pricesIncludeTax !== undefined ? { pricesIncludeTax: kmDecision.pricesIncludeTax } : {}) } : null,
  };

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
        draft.calculation = { ...draft.calculation, priceOrigin: effectiveFuelPrice.origin, fuelPolicy: contract.fuelPolicy, tankOrigin };
        const c = confirmedOf("FUEL");
        proposals.push({ key: "FUEL", draft, confirmed: !!c, chargeId: c?.id ?? null, dismissed: dismissed.has("FUEL") });
      }
    }
  }

  // Befehl 20.9: Zubehör, das bei der Übergabe eindeutig vorhanden war und bei der Rückgabe fehlt → Vorschlag, nie Position
  if (input.accessories) {
    const acc = input.accessories;
    for (const f of missingAccessories(acc.pickup, acc.ret, (def) => accessoryPrice(def, acc.contractRules, acc.currentRules))) {
      const key = accessoryProposalKey(f.def.key);
      if (f.price.cents == null) {
        hints.push({ code: `ACCESSORY_NO_PRICE_${f.def.key}`, text: `${f.def.label} fehlt: bei der Übergabe vorhanden, bei der Rückgabe nicht. Für dieses Fahrzeug ist kein Ersatzpreis hinterlegt (Geschäftsregel „Ersatzpreis ${f.def.label}“ am Fahrzeug oder an der Gruppe); es wird kein Betrag vorgeschlagen. Bei Bedarf eine Position „Fehlendes Zubehör“ bewusst manuell erfassen.` });
        continue;
      }
      const draft = flatCharge("MISSING_ACCESSORY", `${f.def.label} fehlt (bei Übergabe vorhanden, bei Rückgabe fehlend)`, 1, "Stk", f.price.cents / 100);
      draft.calculation = { ...draft.calculation, accessoryKey: f.def.key, priceOrigin: f.price.origin };
      const c = h.extraCharges.find((x) => x.type === "MISSING_ACCESSORY" && x.source === "PROPOSAL" && (x.calculation as { accessoryKey?: string } | null)?.accessoryKey === f.def.key);
      proposals.push({ key, draft, confirmed: !!c, chargeId: c?.id ?? null, dismissed: dismissed.has(key), facts: ["Bei Übergabe vorhanden", "Bei Rückgabe fehlend", f.price.origin === "STANDARD" ? "Standard-Ersatzpreis" : f.price.origin === "CONTRACT" ? "Ersatzpreis laut Vertrag (Fahrzeugregel)" : "Ersatzpreis laut Fahrzeugregel"] });
    }
  }
  if (batteryDiff != null && batteryDiff < 0) hints.push({ code: "CHARGING_NO_BASIS", text: `Die Batterie ist um ${-batteryDiff} Prozentpunkte niedriger als bei der Übergabe. Ein Ladepreis ist nicht vereinbart; bei Bedarf eine Position „Ladung“ manuell erfassen.` });
  // Befehl 28: Verspätung nach der im Mietvertrag eingefrorenen Regel – nur ein Vorschlag (bewusst bestätigen), nie automatisch.
  // Ohne maschinenlesbare Regel (manuell/individuell) wird nur die Regel angezeigt, kein Betrag erfunden.
  if (contractEnd && lateMinutes > 15) {
    const rules = readContractRules(contract.conditions)?.values as (Partial<BusinessRules> & { lateReturnRule?: LateReturnRule; lateReturnFeeCents?: number | null }) | undefined;
    const lateRule = rules?.lateReturnRule;
    const ruleText = lateRule && lateRule in LATE_RETURN_RULES ? LATE_RETURN_RULES[lateRule] : null;
    const confirmedLate = confirmedOf("LATE_RETURN");
    let draft: ChargeDraft | null = null;
    if (lateRule === "CONFIGURED_FEE" && rules?.lateReturnFeeCents && rules.lateReturnFeeCents > 0) {
      draft = flatCharge("LATE_RETURN", `Verspätete Rückgabe (${fmtMinutes(lateMinutes)} nach ${fmtDateTime(contractEnd)}) – Richtwert laut Mietvertrag`, 1, "pauschal", rules.lateReturnFeeCents / 100);
      draft.calculation = { ...draft.calculation, rule: lateRule, lateMinutes };
    } else if (lateRule === "ADDITIONAL_RENTAL_TIME") {
      const cents = extensionPriceProposal(contract, contractEnd, actualEnd);
      if (cents != null && cents > 0) {
        draft = flatCharge("LATE_RETURN", `Zusätzliche Mietzeit bis ${fmtDateTime(actualEnd)} nach Vertragspreis (geplant ${fmtDateTime(contractEnd)})`, 1, "pauschal", cents / 100);
        draft.calculation = { ...draft.calculation, rule: lateRule, lateMinutes, plannedEnd: contractEnd.toISOString(), actualEnd: actualEnd.toISOString() };
      }
    }
    if (draft) proposals.push({ key: "LATE_RETURN", draft, confirmed: !!confirmedLate, chargeId: confirmedLate?.id ?? null, dismissed: dismissed.has("LATE_RETURN"), facts: [`Vertragliche Verspätungsregel: ${ruleText}`, `Verspätung: ${fmtMinutes(lateMinutes)}`] });
    else hints.push({ code: "LATE_RETURN", text: `Die Rückgabe erfolgt ${fmtMinutes(lateMinutes)} nach der vereinbarten Zeit. ${ruleText ? `Vertragliche Verspätungsregel: ${ruleText}. ` : "Eine Verspätungsregel ist im Vertrag nicht hinterlegt. "}Es wird kein Betrag vorgeschlagen; bei Bedarf eine Position „Verspätete Rückgabe“ manuell erfassen.` });
  }

  const charges = h.extraCharges.map(chargeRow);
  return {
    pickup: { id: pickup.id, number: pickup.number, mileage: pickup.mileage, fuelLevelEighths: pickup.fuelLevelEighths, batteryPercent: pickup.batteryPercent, finalizedAt: pickup.finalizedAt },
    mileage: { pickup: pickup.mileage, return: h.mileage, driven },
    fuel: energy.fuel ? { pickup: pickup.fuelLevelEighths, return: h.fuelLevelEighths, diff: fuelDiff } : null,
    battery: energy.battery ? { pickup: pickup.batteryPercent, return: h.batteryPercent, diff: batteryDiff } : null,
    time: { start, plannedEnd: contractEnd, actualEnd, lateMinutes, rentalDays: days },
    contract: {
      number: contract.number,
      amendmentNumbers: contract.amended?.numbers ?? [],
      kmPolicy,
      kmPolicyNote: mileageBilling.policyNote,
      kmIncludedPerDay: contract.kmIncludedPerDay,
      includedKm: kmPolicy === "UNLIMITED" ? null : contract.kmIncludedPerDay * days,
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
    mileageBilling,
  };
}

export { fmtMinutes };

export async function getReturnComparison(tenantId: string, handoverId: string): Promise<ReturnComparison> {
  return db.$transaction(async (tx) => {
    const { h, booking, contract, pickup, accessories, vehicleTankLiters } = await loadReturn(tx, tenantId, handoverId);
    return buildComparison({ handover: h, booking, contract, pickup, accessories, vehicleTankLiters });
  }, TX);
}

/** Zusatzkosten gehören zum Inhalt: danach werden Unterschriften verworfen, deren Hash nicht mehr passt. */
const touchAfterCharge = (tx: Tx, tenantId: string, handoverId: string) => touchHandover(tx, tenantId, handoverId);

/**
 * Mitarbeiter bestätigt einen Vorschlag. Der Betrag wird serverseitig neu berechnet, nie aus dem Formular übernommen.
 * Es entsteht genau eine Position: die Protokollsperre serialisiert parallele Klicks, der zweite sieht „bereits bestätigt“.
 */
export async function confirmProposal(tenantId: string, handoverId: string, actorId: string | null, key: Proposal["key"]) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Handover" WHERE "id" = ${handoverId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const { h, booking, contract, pickup, accessories, vehicleTankLiters } = await loadReturn(tx, tenantId, handoverId);
    assertHandoverDraft(h);
    // Befehl 28: dieselben Eingaben wie die Anzeige (inkl. Tankgröße am Fahrzeug als Ersatz) – sonst fehlte der Vorschlag beim Bestätigen
    const cmp = buildComparison({ handover: h, booking, contract, pickup, accessories, vehicleTankLiters });
    const p = cmp.proposals.find((x) => x.key === key);
    if (!p) throw new DomainError("Für diese Position gibt es derzeit keinen Vorschlag.");
    if (p.confirmed) throw new DomainError("Diese Position wurde bereits bestätigt.");
    // Mehrkilometer-Kulanz: eine Mehrkilometer-Position je Rückgabe – eine manuell erfasste (Altbestand) zuerst entfernen
    if (key === "EXTRA_MILEAGE" && h.extraCharges.some((c) => c.type === "EXTRA_MILEAGE")) throw new DomainError("Es ist bereits eine manuelle Mehrkilometer-Position vorhanden – bitte zuerst entfernen und dann in der Mehrkilometer-Abrechnung entscheiden.");
    const created = await saveExtraCharge(tx, tenantId, actorId, { bookingId: h.bookingId, handoverId: h.id }, p.draft, { source: "PROPOSAL" });
    // eine frühere Entscheidung „Nicht berechnen“ ist damit überholt
    if (p.dismissed) await tx.handover.update({ where: { id: h.id }, data: { dismissedProposals: (h.dismissedProposals ?? []).filter((k) => k !== key) } });
    await touchAfterCharge(tx, tenantId, h.id);
    return created;
  }, TX);
}

/**
 * Befehl 20.9: „Nicht berechnen“ – der Mitarbeiter entscheidet bewusst, einen Vorschlag nicht zu übernehmen. Dokumentiert
 * am Protokoll (kein Hash-Bestandteil), erzeugt nie eine Position oder Forderung; mit undo wieder offen.
 */
export async function dismissProposal(tenantId: string, handoverId: string, actor: Actor | null, key: Proposal["key"], undo = false) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Handover" WHERE "id" = ${handoverId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const { h, booking, contract, pickup, accessories, vehicleTankLiters } = await loadReturn(tx, tenantId, handoverId);
    assertHandoverDraft(h);
    // Befehl 29 Phase E: geschlossener Unfallersatzfall – auch „Nicht berechnen“ ist gesperrt (wie jede Änderung am Entwurf)
    if (booking.rentalType === "ACCIDENT_REPLACEMENT" && (await accidentCaseClosed(tx, tenantId, h.bookingId))) throw new DomainError(ACCIDENT_CASE_CLOSED_MESSAGE);
    // Mehrkilometer-Kulanz: kein Erlass ohne Begründung – nach der Sperrprüfung des Falls, damit dort weiterhin dessen Meldung kommt.
    // Das Zurücknehmen (undo) eines alten „Nicht berechnen“ bleibt erlaubt.
    if (key === "EXTRA_MILEAGE" && !undo) throw new DomainError("Mehrkilometer werden nicht über „Nicht berechnen“ erlassen. Bitte in der Mehrkilometer-Abrechnung entscheiden (Erlass mit Begründung durch Inhaber oder Disposition).");
    // Befehl 28: dieselben Eingaben wie die Anzeige (inkl. Tankgröße am Fahrzeug als Ersatz) – sonst fehlte der Vorschlag beim Bestätigen
    const cmp = buildComparison({ handover: h, booking, contract, pickup, accessories, vehicleTankLiters });
    const p = cmp.proposals.find((x) => x.key === key);
    if (!p) throw new DomainError("Für diese Position gibt es derzeit keinen Vorschlag.");
    if (p.confirmed) throw new DomainError("Diese Position wurde bereits als Position übernommen. Bei Bedarf die Position unten entfernen.");
    const current = h.dismissedProposals ?? [];
    const next = undo ? current.filter((k) => k !== key) : current.includes(key) ? current : [...current, key];
    await tx.handover.update({ where: { id: h.id }, data: { dismissedProposals: next } });
    if (!undo && !current.includes(key)) await recordAudit(tx, tenantId, actor, { action: "RETURN_PROPOSAL_DISMISSED", bookingId: h.bookingId, details: { handoverId: h.id, proposal: key, description: p.draft.description, amount: p.draft.amount } });
    return next;
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
  // Mehrkilometer-Kulanz: kein Umweg an Berechnung, Deckel und Begründung vorbei
  if (input.type === "EXTRA_MILEAGE") throw new DomainError("Mehrkilometer werden automatisch berechnet und in der Mehrkilometer-Abrechnung entschieden – bitte keine manuelle Position erfassen.");
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
    // Mehrkilometer-Kulanz: dieselbe Protokollsperre wie Bestätigen und Entscheiden – kein Entfernen mitten in einer Entscheidung
    await tx.$queryRaw`SELECT "id" FROM "Handover" WHERE "id" = ${handoverId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const { h } = await loadReturn(tx, tenantId, handoverId);
    assertHandoverDraft(h);
    const c = h.extraCharges.find((x) => x.id === chargeId);
    if (!c) throw new DomainError("Position nicht gefunden.");
    // Eine individuell festgelegte oder erlassene Mehrkilometer-Position entfernt nur Inhaber/Disposition über die Rücknahme (mit Audit).
    // Eine regulär bestätigte Position darf weiterhin jede Rolle entfernen (z. B. um einen veralteten Betrag neu zu bestätigen).
    if (c.type === "EXTRA_MILEAGE" && hasMileageDecision(c.calculation)) throw new DomainError("Diese Mehrkilometer-Position wurde individuell festgelegt oder erlassen. Entfernen nur durch Inhaber oder Disposition über „Entscheidung zurücknehmen“.");
    await tx.extraCharge.delete({ where: { id: c.id } });
    await touchAfterCharge(tx, tenantId, h.id);
  }, TX);
}

// ---------------------------------------------------------------------------
// Mehrkilometer-Kulanz: individueller Betrag oder Erlass (nur Inhaber und Disposition – die Rolle prüft die Server Action)
// ---------------------------------------------------------------------------

export type MileageDecisionInput = {
  mode: MileageDecisionKind;
  /** nur CUSTOM: Betrag als Formulartext, streng geparst (parseEuroInput) */
  amount?: string | null;
  reason: string;
  /** regulärer Betrag in Cent, den die Seite beim Entscheiden angezeigt hat */
  seenRegularCents: number;
  /** ausdrücklich bestätigt, dass eine vorhandene Mieter-Unterschrift verworfen wird */
  confirmSignatureLoss?: boolean;
};

/** Sperre, Entwurf, offener Unfallersatzfall – gemeinsame Vorbedingungen von Entscheidung und Rücknahme. */
async function lockReturnForMileage(tx: Tx, tenantId: string, handoverId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Handover" WHERE "id" = ${handoverId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const loaded = await loadReturn(tx, tenantId, handoverId);
  assertHandoverDraft(loaded.h);
  if (loaded.booking.rentalType === "ACCIDENT_REPLACEMENT" && (await accidentCaseClosed(tx, tenantId, loaded.h.bookingId))) throw new DomainError(ACCIDENT_CASE_CLOSED_MESSAGE);
  return loaded;
}

/** Nach der Mieter-Unterschrift ändert eine Entscheidung den unterschriebenen Inhalt: nur mit ausdrücklicher Bestätigung (D6). */
async function assertSignatureLossConfirmed(tx: Tx, tenantId: string, handoverId: string, confirmed: boolean | undefined) {
  const renterSignatures = await tx.signature.count({ where: { tenantId, handoverId, role: "RENTER" } });
  if (renterSignatures > 0 && confirmed !== true) throw new DomainError("Der Mieter hat das Protokoll bereits unterschrieben. Die Änderung verwirft seine Unterschrift – bitte ausdrücklich bestätigen; danach muss der Mieter erneut unterschreiben.");
}

/**
 * Mehrkilometer individuell festlegen (CUSTOM, 0 < Betrag < regulär) oder aus Kulanz erlassen (WAIVED, 0 €) – mit Pflichtbegründung.
 * Der reguläre Betrag wird in der Transaktion neu berechnet, nie aus dem Formular übernommen; seenRegularCents muss dazu passen.
 * Es entsteht genau eine Position (source PROPOSAL) mit der Entscheidung in calculation.decision; Audit RETURN_MILEAGE_DECIDED.
 */
export async function decideMileageProposal(tenantId: string, handoverId: string, actor: Actor, input: MileageDecisionInput) {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 10) throw new DomainError("Bitte den Grund für die Abweichung nachvollziehbar angeben (mindestens 10 Zeichen).");
  if (reason.length > 500) throw new DomainError("Die Begründung ist zu lang (höchstens 500 Zeichen).");
  if (input.mode !== "CUSTOM" && input.mode !== "WAIVED") throw new DomainError("Bitte „Individuellen Betrag festlegen“ oder „Aus Kulanz erlassen“ wählen.");
  let agreedCents = 0;
  if (input.mode === "CUSTOM") {
    const parsed = parseEuroInput(String(input.amount ?? ""));
    if (parsed == null) throw new DomainError("Bitte einen gültigen Betrag angeben (z. B. 50,00).");
    if (parsed === 0) throw new DomainError("Für 0 € bitte „Aus Kulanz erlassen“ wählen.");
    agreedCents = parsed;
  }
  return db.$transaction(async (tx) => {
    const { h, booking, contract, pickup, accessories, vehicleTankLiters } = await lockReturnForMileage(tx, tenantId, handoverId);
    // dieselben Eingaben wie Anzeige und „Regulär berechnen“
    const cmp = buildComparison({ handover: h, booking, contract, pickup, accessories, vehicleTankLiters });
    const p = cmp.proposals.find((x) => x.key === "EXTRA_MILEAGE");
    if (!p) throw new DomainError("Es fallen keine Mehrkilometer an – es gibt nichts festzulegen oder zu erlassen.");
    const existing = h.extraCharges.find((c) => c.type === "EXTRA_MILEAGE");
    if (existing) throw new DomainError(existing.source === "PROPOSAL" ? "Über die Mehrkilometer wurde bereits entschieden – zuerst die Entscheidung zurücknehmen." : "Es ist eine manuelle Mehrkilometer-Position vorhanden – bitte zuerst entfernen.");
    const regularCents = toCents(p.draft.amount);
    if (regularCents <= 0) throw new DomainError("Der reguläre Mehrkilometer-Betrag ist 0,00 € – es gibt nichts festzulegen oder zu erlassen.");
    if (regularCents !== input.seenRegularCents) throw new DomainError(`Der reguläre Mehrkilometer-Betrag hat sich geändert (jetzt ${fmtCents(regularCents)}). Bitte die Angaben prüfen und erneut entscheiden.`);
    if (input.mode === "CUSTOM" && agreedCents >= regularCents) throw new DomainError(`Der individuelle Betrag muss unter dem regulären Betrag von ${fmtCents(regularCents)} liegen. Für den vollen Betrag bitte „Regulär berechnen“ wählen.`);
    await assertSignatureLossConfirmed(tx, tenantId, h.id, input.confirmSignatureLoss);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { pricesIncludeTax: true } });
    const decision: MileageDecision = {
      kind: input.mode,
      regularCents,
      agreedCents,
      deviationCents: regularCents - agreedCents,
      extraKm: p.draft.quantity,
      reason,
      decidedById: actor.id,
      decidedByName: actor.name,
      decidedAt: new Date().toISOString(),
      netPrices: tenant.pricesIncludeTax === false,
      // dreiwertig eingefroren (brutto/netto/nicht festgelegt): Kennzeichnung der Beträge auch nach einer späteren Umstellung
      pricesIncludeTax: tenant.pricesIncludeTax,
    };
    const created = await saveExtraCharge(tx, tenantId, actor.id, { bookingId: h.bookingId, handoverId: h.id }, mileageDecisionDraft(p.draft, decision), { source: "PROPOSAL" });
    // ein altes „Nicht berechnen“ ist damit überholt
    if (p.dismissed) await tx.handover.update({ where: { id: h.id }, data: { dismissedProposals: (h.dismissedProposals ?? []).filter((k) => k !== "EXTRA_MILEAGE") } });
    await touchAfterCharge(tx, tenantId, h.id);
    await recordAudit(tx, tenantId, actor, { action: "RETURN_MILEAGE_DECIDED", bookingId: h.bookingId, amountCents: agreedCents, details: { handoverId: h.id, handoverNumber: h.number, decision: input.mode, regularCents, agreedCents, deviationCents: regularCents - agreedCents, extraKm: p.draft.quantity, reason: reason.slice(0, 300) } });
    return created;
  }, TX);
}

/**
 * Entscheidung zurücknehmen – für jede Mehrkilometer-Position aus der Abrechnung (auch „Regulär berechnen“). Danach ist der
 * Vorschlag wieder offen und blockiert den Abschluss, bis neu entschieden ist. Audit RETURN_MILEAGE_DECISION_REVOKED.
 */
export async function revokeMileageDecision(tenantId: string, handoverId: string, actor: Actor, input: { confirmSignatureLoss?: boolean } = {}) {
  return db.$transaction(async (tx) => {
    const { h } = await lockReturnForMileage(tx, tenantId, handoverId);
    const c = h.extraCharges.find((x) => x.type === "EXTRA_MILEAGE" && x.source === "PROPOSAL");
    if (!c) throw new DomainError("Zu den Mehrkilometern liegt keine Entscheidung vor.");
    await assertSignatureLossConfirmed(tx, tenantId, h.id, input.confirmSignatureLoss);
    const d = readMileageDecision(c.calculation);
    const amountCents = toCents(c.amount);
    await tx.extraCharge.delete({ where: { id: c.id } });
    await touchAfterCharge(tx, tenantId, h.id);
    await recordAudit(tx, tenantId, actor, { action: "RETURN_MILEAGE_DECISION_REVOKED", bookingId: h.bookingId, amountCents, details: { handoverId: h.id, handoverNumber: h.number, kind: d?.kind ?? "REGULAR", regularCents: d?.regularCents ?? amountCents, agreedCents: d?.agreedCents ?? amountCents } });
  }, TX);
}

/** Vergleich für ein finalisiertes Protokoll (Ansicht und PDF): Rechnet aus denselben Snapshots, ohne "jetzt". */
export async function loadSealedComparison(tx: Tx, tenantId: string, handoverId: string): Promise<ReturnComparison | null> {
  const h = await tx.handover.findFirst({ where: { id: handoverId, tenantId, type: "RETURN" }, include: { extraCharges: { orderBy: { createdAt: "asc" } }, checklistItems: answerSelect } });
  if (!h || !h.contractId) return null;
  const [booking, contract, pickup] = await Promise.all([
    tx.booking.findFirst({ where: { id: h.bookingId, tenantId } }),
    tx.rentalContract.findFirst({ where: { id: h.contractId, tenantId } }),
    tx.handover.findFirst({ where: { tenantId, bookingId: h.bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" }, include: { checklistItems: answerSelect } }),
  ]);
  if (!booking || !contract || !pickup) return null;
  const vehicleTank = await tx.vehicle.findFirst({ where: { id: h.vehicleId, tenantId }, select: { tankCapacityLiters: true } });
  return buildComparison({ handover: h, booking, contract: await loadEffectiveContract(tx, tenantId, contract), pickup, accessories: await accessoryContext(tx, tenantId, h, contract, pickup), vehicleTankLiters: vehicleTank?.tankCapacityLiters ?? null });
}

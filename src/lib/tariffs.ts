// Befehl 29: Miettarife – Auflösung, Angebot und Buchungs-Snapshot. Die EINE Tarifengine für neue Buchungen.
//
// Grundsätze:
// - Ein Tarif gehört genau einem Mandanten; sein Inhalt steht in unveränderlichen Revisionen (Preisstufen je Fahrzeuggruppe,
//   Kilometerregel, Kaution). Ein Fahrzeug kann einzelne Stufen sowie Kaution/km abweichend haben (VehicleRateOverride).
// - Der Tarif liefert den REGULÄREN Preis. Ob eine Buchung davon abweicht (Sonderpreis, km, Kaution), entscheidet OWNER/DISPO
//   je Buchung mit Pflichtgrund; der Tarif selbst ändert sich dadurch nie.
// - Eine Buchung friert den aufgelösten Stand im tariffSnapshot ein und rechnet danach nur noch daraus (nie aus dem Live-Tarif).
//   Der Vertrag versiegelt den Snapshot im priceSnapshot. Neu aufgelöst wird nur bei bewusster Wahl (anderer Tarif/Fahrzeug).
// - Geld nur in ganzen Cent (lib/pricing.ts rechnet die Stufen in Cent).
// - Sperren: Buchungen lesen den Tarif unter FOR SHARE, Tarifänderungen/Fahrzeugabweichungen sperren FOR UPDATE – eine Buchung
//   bekommt so immer genau eine konsistente Revision samt Abweichungen, nie eine Mischung.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Actor, AuditInput } from "@/lib/audit";
import { TARIFF_KM_POLICIES, type TariffKmPolicy } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";
import { calculateRentalPrice, tierLabel, totalCentsOf, type PriceBreakdown, type TierDef } from "@/lib/pricing";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;

export type KmRule = { policy: TariffKmPolicy; kmIncludedPerDay: number | null; extraKmRateCents: number | null };
/** Herkunft einer Kondition: Tarif (Revision), abweichend für die Fahrzeuggruppe oder für das Fahrzeug */
export type ConditionSource = "TARIFF" | "GROUP" | "VEHICLE";

/** Aufgelöster Tarif für ein Fahrzeug (eine Revision, alle Abweichungen angewendet). */
export type TariffBasis = {
  ratePlanId: string;
  ratePlanName: string;
  ratePlanCode: string | null;
  revisionId: string;
  revision: number;
  groupId: string;
  groupName: string;
  /** wirksame Preisstufen (aufsteigend) */
  tiers: TierDef[];
  /** Dauern, deren Preis vom Fahrzeug stammt (Fahrzeugpreis statt Gruppenpreis) */
  vehicleTierDays: number[];
  vehicleOverrideApplied: boolean;
  km: KmRule;
  kmSource: ConditionSource;
  depositCents: number;
  depositSource: ConditionSource;
};

export type TariffQuote = {
  basis: TariffBasis;
  breakdown: PriceBreakdown;
  days: number;
  /** regulärer Tarifpreis nach Kundenrabatt */
  regularCents: number;
  /** inklusive Kilometer für den Zeitraum; null = unbegrenzt */
  includedKm: number | null;
};

// ---------------------------------------------------------------------------
// Auflösung
// ---------------------------------------------------------------------------

const planInclude = (groupId: string, vehicleId: string) =>
  ({
    currentRevision: { include: { groups: { where: { groupId }, include: { tiers: { orderBy: { durationDays: "asc" } }, group: { select: { name: true } } } } } },
    vehicleOverrides: { where: { vehicleId }, include: { tiers: true } },
  }) satisfies Prisma.RatePlanInclude;
type PlanWithContent = Prisma.RatePlanGetPayload<{ include: ReturnType<typeof planInclude> }>;

/** Wendet Gruppe und Fahrzeugabweichung auf eine Revision an. null, wenn der Tarif für die Gruppe nicht gilt oder keine Stufe bleibt. */
function basisOf(plan: PlanWithContent, groupId: string): TariffBasis | null {
  const rev = plan.currentRevision;
  const gp = rev?.groups.find((g) => g.groupId === groupId);
  if (!rev || !gp) return null;
  const ov = plan.vehicleOverrides[0] ?? null;
  const tiers = new Map<number, TierDef>(gp.tiers.map((t) => [t.durationDays, { days: t.durationDays, cents: t.priceCents, ...(t.label ? { label: t.label } : {}) }]));
  const vehicleTierDays: number[] = [];
  for (const t of ov?.tiers ?? []) {
    vehicleTierDays.push(t.durationDays);
    if (t.priceCents == null) tiers.delete(t.durationDays);
    else tiers.set(t.durationDays, { days: t.durationDays, cents: t.priceCents, ...(tiers.get(t.durationDays)?.label ? { label: tiers.get(t.durationDays)!.label } : {}) });
  }
  if (tiers.size === 0) return null;
  const kmFrom = (src: { kmPolicy: string | null; kmIncludedPerDay: number | null; extraKmRateCents: number | null }): KmRule => ({
    policy: src.kmPolicy as TariffKmPolicy,
    kmIncludedPerDay: src.kmPolicy === "UNLIMITED" ? null : src.kmIncludedPerDay,
    extraKmRateCents: src.kmPolicy === "UNLIMITED" ? null : src.extraKmRateCents,
  });
  const km = ov?.kmPolicy ? { rule: kmFrom(ov), source: "VEHICLE" as const } : gp.kmPolicy ? { rule: kmFrom(gp), source: "GROUP" as const } : { rule: kmFrom(rev), source: "TARIFF" as const };
  const deposit = ov?.depositCents != null ? { cents: ov.depositCents, source: "VEHICLE" as const } : gp.depositCents != null ? { cents: gp.depositCents, source: "GROUP" as const } : { cents: rev.depositCents, source: "TARIFF" as const };
  return {
    ratePlanId: plan.id,
    ratePlanName: plan.name,
    ratePlanCode: plan.code,
    revisionId: rev.id,
    revision: rev.revision,
    groupId,
    groupName: gp.group.name,
    tiers: [...tiers.values()].sort((a, b) => a.days - b.days),
    vehicleTierDays: vehicleTierDays.sort((a, b) => a - b),
    vehicleOverrideApplied: Boolean(ov && (ov.tiers.length > 0 || ov.depositCents != null || ov.kmPolicy)),
    km: km.rule,
    kmSource: km.source,
    depositCents: deposit.cents,
    depositSource: deposit.source,
  };
}

export type VehicleTariffs = {
  vehicle: { id: string; plate: string; groupId: string | null; groupName: string | null };
  /** Standardtarif der Gruppe (nur wenn aktiv und angeboten) */
  defaultRatePlanId: string | null;
  bases: TariffBasis[];
  /** Hinweis, warum keine Tarife angeboten werden (z. B. Fahrzeug ohne Gruppe) */
  problem: string | null;
};

/** Aktive Tarife eines Fahrzeugs (aktuelle Revision der jeweiligen Tarife), sortiert wie in der Tarifverwaltung. */
export async function vehicleTariffs(tenantId: string, vehicleId: string, client: Client = db): Promise<VehicleTariffs> {
  const v = await client.vehicle.findFirst({ where: { id: vehicleId, tenantId }, select: { id: true, plate: true, groupId: true, group: { select: { name: true, defaultRatePlanId: true } } } });
  if (!v) throw new DomainError("Fahrzeug nicht gefunden.");
  const vehicle = { id: v.id, plate: v.plate, groupId: v.groupId, groupName: v.group?.name ?? null };
  if (!v.groupId) return { vehicle, defaultRatePlanId: null, bases: [], problem: "Dem Fahrzeug ist keine Fahrzeuggruppe zugeordnet. Miettarife gelten je Fahrzeuggruppe." };
  const plans = await client.ratePlan.findMany({
    where: { tenantId, active: true, currentRevision: { groups: { some: { groupId: v.groupId } } } },
    include: planInclude(v.groupId, v.id),
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const bases = plans.map((p) => basisOf(p, v.groupId!)).filter((b): b is TariffBasis => b !== null);
  const defaultRatePlanId = bases.some((b) => b.ratePlanId === v.group?.defaultRatePlanId) ? v.group!.defaultRatePlanId : bases.length === 1 ? bases[0].ratePlanId : null;
  return { vehicle, defaultRatePlanId, bases, problem: bases.length === 0 ? `Für die Fahrzeuggruppe „${v.group?.name}“ ist kein aktiver Miettarif hinterlegt.` : null };
}

/**
 * Löst einen Tarif für ein Fahrzeug in einer Transaktion auf und sperrt ihn gegen gleichzeitige Änderung (FOR SHARE).
 * Deaktivierte oder fremde Tarife werden abgelehnt – auch bei direkt übergebener ID.
 */
export async function lockTariffBasis(tx: Tx, tenantId: string, vehicleId: string, ratePlanId: string): Promise<TariffBasis> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "RatePlan" WHERE "id" = ${ratePlanId} AND "tenantId" = ${tenantId} FOR SHARE`;
  if (locked.length === 0) throw new DomainError("Miettarif nicht gefunden.");
  const v = await tx.vehicle.findFirst({ where: { id: vehicleId, tenantId }, select: { groupId: true, group: { select: { name: true } } } });
  if (!v) throw new DomainError("Fahrzeug nicht gefunden.");
  if (!v.groupId) throw new DomainError("Dem Fahrzeug ist keine Fahrzeuggruppe zugeordnet. Miettarife gelten je Fahrzeuggruppe.");
  const plan = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, include: planInclude(v.groupId, vehicleId) });
  if (!plan) throw new DomainError("Miettarif nicht gefunden.");
  if (!plan.active) throw new DomainError(`Der Miettarif „${plan.name}“ ist deaktiviert und wird für neue Buchungen nicht mehr angeboten.`);
  const basis = basisOf(plan, v.groupId);
  if (!basis) throw new DomainError(`Der Miettarif „${plan.name}“ gilt nicht für die Fahrzeuggruppe „${v.group?.name}“.`);
  return basis;
}

/** Regulärer Preis eines aufgelösten Tarifs für einen Zeitraum (zentrale Preisfunktion, Stufen in Cent). */
export function quoteTariff(basis: TariffBasis, start: Date, end: Date, discountPercent = 0): TariffQuote {
  const breakdown = calculateRentalPrice({ start, end, tiers: basis.tiers, discountPercent });
  return {
    basis,
    breakdown,
    days: breakdown.days,
    regularCents: totalCentsOf(breakdown),
    includedKm: basis.km.policy === "UNLIMITED" ? null : breakdown.days * (basis.km.kmIncludedPerDay ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Buchungs-Snapshot und Abweichungen
// ---------------------------------------------------------------------------

type Who = { at: string; byId: string | null; byName: string | null };

/** Eingefrorener Tarif einer Buchung; wird im Vertrag unverändert versiegelt. Keine IDs im Kundendokument (nur intern). */
export type TariffSnapshot = {
  v: 1;
  ratePlanId: string;
  ratePlanName: string;
  ratePlanCode: string | null;
  revisionId: string;
  revision: number;
  groupId: string;
  groupName: string;
  tiers: TierDef[];
  vehicleTierDays: number[];
  vehicleOverrideApplied: boolean;
  km: KmRule & { source: ConditionSource };
  deposit: { cents: number; source: ConditionSource };
  /** Preisstand beim letzten Übernehmen des Tarifs (Zeitraum kann sich vor dem Vertrag noch ändern; dann zählt die Buchung) */
  quotedAt: string;
  /** Abweichungen der Buchung – mit Grund, wer und wann */
  agreed: {
    price: ({ cents: number; regularCents: number; reason: string } & Who) | null;
    km: (KmRule & { reason: string } & Who) | null;
    deposit: ({ cents: number; reason: string } & Who) | null;
  };
};

export function readTariffSnapshot(v: unknown): TariffSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<TariffSnapshot>;
  return s.v === 1 && Array.isArray(s.tiers) && typeof s.ratePlanId === "string" ? (s as TariffSnapshot) : null;
}

/** Der eingefrorene Tarif als Auflösung (für Preisrechnung aus dem Snapshot – nie aus dem Live-Tarif). */
export function basisFromSnapshot(s: TariffSnapshot): TariffBasis {
  return {
    ratePlanId: s.ratePlanId,
    ratePlanName: s.ratePlanName,
    ratePlanCode: s.ratePlanCode,
    revisionId: s.revisionId,
    revision: s.revision,
    groupId: s.groupId,
    groupName: s.groupName,
    tiers: s.tiers,
    vehicleTierDays: s.vehicleTierDays,
    vehicleOverrideApplied: s.vehicleOverrideApplied,
    km: { policy: s.km.policy, kmIncludedPerDay: s.km.kmIncludedPerDay, extraKmRateCents: s.km.extraKmRateCents },
    kmSource: s.km.source,
    depositCents: s.deposit.cents,
    depositSource: s.deposit.source,
  };
}

export type PriceChoice = { mode: "TARIFF" } | { mode: "INDIVIDUAL"; cents: number; reason: string };
export type KmChoice = { mode: "TARIFF" } | ({ mode: "INDIVIDUAL"; reason: string } & KmRule);
export type DepositChoice = { mode: "TARIFF" } | { mode: "INDIVIDUAL"; cents: number; reason: string };
export type TariffChoices = { price: PriceChoice; km: KmChoice; deposit: DepositChoice };

export const OVERRIDE_REASON_MAX = 300;
const MAX_PRICE_CENTS = 100_000_000; // 1 Mio. € als Plausibilitätsgrenze
const MAX_DEPOSIT_CENTS = 10_000_000;

function reasonOf(r: string, what: string): string {
  const t = (r ?? "").trim();
  if (t.length < 3) throw new DomainError(`Bitte den Grund für ${what} angeben (mindestens 3 Zeichen).`);
  if (t.length > OVERRIDE_REASON_MAX) throw new DomainError(`Grund für ${what}: höchstens ${OVERRIDE_REASON_MAX} Zeichen.`);
  return t;
}

/** Prüft eine Kilometerregel (Tarif, Gruppe, Fahrzeug oder Buchung). */
export function checkKmRule(k: KmRule, label = "Kilometer"): KmRule {
  if (!(k.policy in TARIFF_KM_POLICIES)) throw new DomainError(`${label}: bitte „Freikilometer je Miettag“ oder „Unbegrenzte Kilometer“ wählen.`);
  if (k.policy === "UNLIMITED") return { policy: "UNLIMITED", kmIncludedPerDay: null, extraKmRateCents: null };
  if (!Number.isInteger(k.kmIncludedPerDay) || k.kmIncludedPerDay! < 0 || k.kmIncludedPerDay! > 100_000) throw new DomainError(`${label}: Freikilometer je Tag als ganze Zahl ab 0 angeben.`);
  if (!Number.isInteger(k.extraKmRateCents) || k.extraKmRateCents! < 0 || k.extraKmRateCents! > 100_000) throw new DomainError(`${label}: Mehrkilometerpreis als Betrag ab 0 € angeben.`);
  return { policy: "FREE_KILOMETERS", kmIncludedPerDay: k.kmIncludedPerDay, extraKmRateCents: k.extraKmRateCents };
}

const sameKm = (a: KmRule | null | undefined, b: KmRule | null | undefined) => !!a && !!b && a.policy === b.policy && a.kmIncludedPerDay === b.kmIncludedPerDay && a.extraKmRateCents === b.extraKmRateCents;
export const kmRuleText = (k: KmRule) => (k.policy === "UNLIMITED" ? "Unbegrenzte Kilometer" : `${k.kmIncludedPerDay} km je Miettag, ${fmtCents(k.extraKmRateCents ?? 0)} je Mehrkilometer`);

export type BookingTariffResult = {
  /** Felder für Booking create/update (Tarif, Snapshot, Abweichungen, Kilometer/Kaution der Buchung, lesekompatible Altfelder) */
  data: {
    ratePlanId: string;
    ratePlanRevisionId: string;
    tariffSnapshot: Prisma.InputJsonValue;
    regularPriceCents: number;
    agreedPriceCents: number | null;
    priceOverrideReason: string | null;
    kmPolicy: TariffKmPolicy;
    kmIncludedPerDay: number;
    extraKmRate: number;
    kmOverrideReason: string | null;
    deposit: number;
    depositOverrideReason: string | null;
    overrideInfo: Prisma.InputJsonValue;
    dailyRate: number;
    workWeekRate: number | null;
    weeklyRate: number | null;
    monthlyRate: number | null;
  };
  snapshot: TariffSnapshot;
  quote: TariffQuote;
  audits: Omit<AuditInput, "bookingId">[];
};

/**
 * Baut Tarif-Snapshot und Buchungsfelder aus einer Auflösung und den Entscheidungen von OWNER/DISPO.
 * Unveränderte Abweichungen behalten Zeitpunkt und Benutzer der ursprünglichen Vereinbarung (kein neues Audit).
 */
export function buildBookingTariff(input: {
  basis: TariffBasis;
  start: Date;
  end: Date;
  discountPercent: number;
  choices: TariffChoices;
  previous: TariffSnapshot | null;
  actor: Actor;
  now?: Date;
}): BookingTariffResult {
  const { basis, choices, previous, actor } = input;
  const now = (input.now ?? new Date()).toISOString();
  const who: Who = { at: now, byId: actor.id, byName: actor.name };
  const quote = quoteTariff(basis, input.start, input.end, input.discountPercent);
  if (quote.days === 0) throw new DomainError("Die Rückgabe muss nach der Abholung liegen.");
  const audits: Omit<AuditInput, "bookingId">[] = [];

  // Preis
  let price: TariffSnapshot["agreed"]["price"] = null;
  if (choices.price.mode === "INDIVIDUAL") {
    const cents = choices.price.cents;
    if (!Number.isInteger(cents) || cents < 0 || cents > MAX_PRICE_CENTS) throw new DomainError("Vereinbarter Mietpreis: bitte einen Betrag ab 0,00 € angeben.");
    const reason = reasonOf(choices.price.reason, "den individuellen Mietpreis");
    const prev = previous?.agreed.price;
    price = prev && prev.cents === cents && prev.reason === reason && prev.regularCents === quote.regularCents ? prev : { cents, regularCents: quote.regularCents, reason, ...who };
    if (price !== prev) {
      const diff = cents - quote.regularCents;
      audits.push({ action: "BOOKING_PRICE_OVERRIDDEN", amountCents: cents, details: { ratePlan: basis.ratePlanName, regularCents: quote.regularCents, agreedCents: cents, differenceCents: diff, differencePercent: quote.regularCents > 0 ? `${((diff / quote.regularCents) * 100).toFixed(1)} %` : null, reason, previousAgreedCents: prev?.cents ?? null } });
    }
  } else if (previous?.agreed.price) {
    audits.push({ action: "BOOKING_PRICE_OVERRIDE_REMOVED", amountCents: quote.regularCents, details: { ratePlan: basis.ratePlanName, previousAgreedCents: previous.agreed.price.cents, regularCents: quote.regularCents } });
  }

  // Kilometer
  let km: TariffSnapshot["agreed"]["km"] = null;
  if (choices.km.mode === "INDIVIDUAL") {
    const rule = checkKmRule(choices.km, "Kilometervereinbarung");
    const reason = reasonOf(choices.km.reason, "die abweichende Kilometervereinbarung");
    const prev = previous?.agreed.km;
    km = prev && sameKm(prev, rule) && prev.reason === reason ? prev : { ...rule, reason, ...who };
    if (km !== prev) audits.push({ action: "BOOKING_KM_OVERRIDDEN", details: { ratePlan: basis.ratePlanName, tariff: kmRuleText(basis.km), agreed: kmRuleText(rule), reason } });
  } else if (previous?.agreed.km) {
    audits.push({ action: "BOOKING_KM_OVERRIDDEN", details: { ratePlan: basis.ratePlanName, tariff: kmRuleText(basis.km), agreed: "wie Tarif", previous: kmRuleText(previous.agreed.km) } });
  }

  // Kaution
  let deposit: TariffSnapshot["agreed"]["deposit"] = null;
  if (choices.deposit.mode === "INDIVIDUAL") {
    const cents = choices.deposit.cents;
    if (!Number.isInteger(cents) || cents < 0 || cents > MAX_DEPOSIT_CENTS) throw new DomainError("Vereinbarte Kaution: bitte einen Betrag ab 0,00 € angeben.");
    const reason = reasonOf(choices.deposit.reason, "die abweichende Kaution");
    const prev = previous?.agreed.deposit;
    deposit = prev && prev.cents === cents && prev.reason === reason ? prev : { cents, reason, ...who };
    if (deposit !== prev) audits.push({ action: "BOOKING_DEPOSIT_OVERRIDDEN", amountCents: cents, details: { ratePlan: basis.ratePlanName, tariffCents: basis.depositCents, agreedCents: cents, reason } });
  } else if (previous?.agreed.deposit) {
    audits.push({ action: "BOOKING_DEPOSIT_OVERRIDDEN", amountCents: basis.depositCents, details: { ratePlan: basis.ratePlanName, tariffCents: basis.depositCents, agreedCents: basis.depositCents, previousAgreedCents: previous.agreed.deposit.cents } });
  }

  if (!previous || previous.ratePlanId !== basis.ratePlanId || previous.revisionId !== basis.revisionId || previous.groupId !== basis.groupId || previous.vehicleOverrideApplied !== basis.vehicleOverrideApplied || JSON.stringify(previous.tiers) !== JSON.stringify(basis.tiers)) {
    audits.unshift({ action: "BOOKING_TARIFF_CHANGED", amountCents: quote.regularCents, details: { ratePlan: basis.ratePlanName, revision: basis.revision, group: basis.groupName, regularCents: quote.regularCents, vehiclePrice: basis.vehicleOverrideApplied, previousRatePlan: previous?.ratePlanName ?? null, previousRevision: previous?.revision ?? null } });
  }

  const snapshot: TariffSnapshot = {
    v: 1,
    ratePlanId: basis.ratePlanId,
    ratePlanName: basis.ratePlanName,
    ratePlanCode: basis.ratePlanCode,
    revisionId: basis.revisionId,
    revision: basis.revision,
    groupId: basis.groupId,
    groupName: basis.groupName,
    tiers: basis.tiers,
    vehicleTierDays: basis.vehicleTierDays,
    vehicleOverrideApplied: basis.vehicleOverrideApplied,
    km: { ...basis.km, source: basis.kmSource },
    deposit: { cents: basis.depositCents, source: basis.depositSource },
    quotedAt: now,
    agreed: { price, km, deposit },
  };
  const effKm = km ?? basis.km;
  const effDeposit = deposit?.cents ?? basis.depositCents;
  const at = (d: number) => {
    const t = basis.tiers.find((x) => x.days === d);
    return t ? t.cents / 100 : null;
  };
  return {
    data: {
      ratePlanId: basis.ratePlanId,
      ratePlanRevisionId: basis.revisionId,
      tariffSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      regularPriceCents: quote.regularCents,
      agreedPriceCents: price?.cents ?? null,
      priceOverrideReason: price?.reason ?? null,
      kmPolicy: effKm.policy,
      // Unbegrenzt: 0/0 statt leer, damit nie ein Fahrzeugwert nachrückt; die Regel selbst steht in kmPolicy
      kmIncludedPerDay: effKm.policy === "UNLIMITED" ? 0 : effKm.kmIncludedPerDay ?? 0,
      extraKmRate: effKm.policy === "UNLIMITED" ? 0 : (effKm.extraKmRateCents ?? 0) / 100,
      kmOverrideReason: km?.reason ?? null,
      deposit: effDeposit / 100,
      depositOverrideReason: deposit?.reason ?? null,
      overrideInfo: { price: price ? { at: price.at, byId: price.byId, byName: price.byName } : null, km: km ? { at: km.at, byId: km.byId, byName: km.byName } : null, deposit: deposit ? { at: deposit.at, byId: deposit.byId, byName: deposit.byName } : null } as Prisma.InputJsonValue,
      // lesekompatibel (Anzeigen/Unfallersatz-Vorschläge); gerechnet wird nur aus dem Snapshot
      dailyRate: at(1) ?? 0,
      workWeekRate: at(5),
      weeklyRate: at(7),
      monthlyRate: at(30),
    },
    snapshot,
    quote,
    audits,
  };
}

/** Lesbare Herkunft eines Preises für die Oberfläche. */
export const priceSourceText = (b: Pick<TariffBasis, "vehicleOverrideApplied" | "vehicleTierDays">) => (b.vehicleTierDays.length > 0 ? "Individueller Fahrzeugpreis" : "Preis aus Fahrzeuggruppe");
export const tiersText = (tiers: TierDef[]) => tiers.map((t) => `${t.label || tierLabel(t.days)} ${fmtCents(t.cents)}`).join(" · ");

/**
 * Tarif für eine Buchung übernehmen (neue Buchung, anderer Tarif/Fahrzeug oder bewusst „aktuellen Tarifpreis übernehmen“).
 * Löst unter Tarifsperre auf. Wurde der Tarif oder der Preis seit der Vorschau geändert (andere Revision, Fahrzeugpreis), wird
 * nichts gespeichert – keine versteckte Preisänderung, die Vorschau muss neu bestätigt werden.
 */
export async function bookingTariffFor(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  input: { vehicleId: string; ratePlanId: string; startAt: Date; endAt: Date; discountPercent: number; choices: TariffChoices; previous: TariffSnapshot | null; seenRevisionId?: string | null; seenRegularCents?: number | null },
): Promise<BookingTariffResult> {
  const basis = await lockTariffBasis(tx, tenantId, input.vehicleId, input.ratePlanId);
  if (input.seenRevisionId && input.seenRevisionId !== basis.revisionId) throw new DomainError(`Der Miettarif „${basis.ratePlanName}“ wurde gerade geändert (jetzt Revision ${basis.revision}). Bitte die Preisvorschau prüfen und erneut speichern.`);
  const built = buildBookingTariff({ basis, start: input.startAt, end: input.endAt, discountPercent: input.discountPercent, choices: input.choices, previous: input.previous, actor });
  if (input.seenRegularCents != null && input.seenRegularCents !== built.quote.regularCents) throw new DomainError(`Der Tarifpreis hat sich geändert (jetzt ${fmtCents(built.quote.regularCents)}). Bitte die Preisvorschau prüfen und erneut speichern.`);
  return built;
}

/** Eingefrorenen Tarif einer Buchung behalten und nur Abweichungen (Preis/km/Kaution) bzw. den Preisstand aktualisieren. */
export function keepBookingTariff(previous: TariffSnapshot, input: { startAt: Date; endAt: Date; discountPercent: number; choices: TariffChoices; actor: Actor }): BookingTariffResult {
  return buildBookingTariff({ basis: basisFromSnapshot(previous), start: input.startAt, end: input.endAt, discountPercent: input.discountPercent, choices: input.choices, previous, actor: input.actor });
}

/** Bisherige Abweichungen eines Snapshots als Entscheidungen (z. B. bei Fahrzeug- oder Tarifwechsel unverändert weitergeben). */
export function choicesOf(s: TariffSnapshot | null): TariffChoices {
  return {
    price: s?.agreed.price ? { mode: "INDIVIDUAL", cents: s.agreed.price.cents, reason: s.agreed.price.reason } : { mode: "TARIFF" },
    km: s?.agreed.km ? { mode: "INDIVIDUAL", policy: s.agreed.km.policy, kmIncludedPerDay: s.agreed.km.kmIncludedPerDay, extraKmRateCents: s.agreed.km.extraKmRateCents, reason: s.agreed.km.reason } : { mode: "TARIFF" },
    deposit: s?.agreed.deposit ? { mode: "INDIVIDUAL", cents: s.agreed.deposit.cents, reason: s.agreed.deposit.reason } : { mode: "TARIFF" },
  };
}

/**
 * Standardtarif je Fahrzeug in EINER Abfrage (Listen, Vorschläge): Standard der Gruppe bzw. einziger aktiver Tarif der Gruppe,
 * mit Fahrzeugabweichung. null = kein (eindeutiger) Tarif für das Fahrzeug.
 */
export async function defaultTariffsForVehicles(tenantId: string, vehicles: { id: string; groupId: string | null; group: { defaultRatePlanId: string | null } | null }[], client: Client = db): Promise<Map<string, TariffBasis | null>> {
  const out = new Map<string, TariffBasis | null>();
  if (vehicles.length === 0) return out;
  const plans = await client.ratePlan.findMany({
    where: { tenantId, active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      currentRevision: { include: { groups: { include: { tiers: { orderBy: { durationDays: "asc" } }, group: { select: { name: true } } } } } },
      vehicleOverrides: { where: { vehicleId: { in: vehicles.map((v) => v.id) } }, include: { tiers: true } },
    },
  });
  for (const v of vehicles) {
    if (!v.groupId) {
      out.set(v.id, null);
      continue;
    }
    const candidates = plans.filter((p) => p.currentRevision?.groups.some((g) => g.groupId === v.groupId));
    const chosen = candidates.find((p) => p.id === v.group?.defaultRatePlanId) ?? (candidates.length === 1 ? candidates[0] : null);
    if (!chosen) {
      out.set(v.id, null);
      continue;
    }
    const scoped = { ...chosen, currentRevision: { ...chosen.currentRevision!, groups: chosen.currentRevision!.groups.filter((g) => g.groupId === v.groupId) }, vehicleOverrides: chosen.vehicleOverrides.filter((o) => o.vehicleId === v.id) };
    out.set(v.id, basisOf(scoped as PlanWithContent, v.groupId));
  }
  return out;
}

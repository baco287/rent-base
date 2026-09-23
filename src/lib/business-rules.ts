// Geschäftsregeln (Phase 15): operative Standardwerte für neue Mietverträge. Sie ersetzen nicht den juristischen Text
// der Mietbedingungen. Auflösung: Systemvorgabe → Mandantenstandard → Fahrzeuggruppe → Fahrzeug → Vertrag; der konkreteste
// gesetzte Wert gewinnt, und jeder Wert kennt seine Herkunft. Reine Funktionen ohne Datenbank; Geld in Cent.
//
// Grundsatz: Keine Regel erzeugt automatisch Rechnungen, Zusatzkosten, Kautionsbewegungen oder Forderungen. Richtwerte
// (Reinigung, Verspätung, Bearbeitungsentgelt) sind Vorschläge für den bestehenden, bewusst bestätigten ExtraCharge-Prozess.

import { COUNTRIES, type AdditionalDriverFeeType, type KmPolicy, type LateReturnRule, type OutOfHoursReturn, type PetsPolicy, type RuleSource } from "@/lib/constants";
import { contentHash } from "@/lib/integrity";

export type FuelRule = "FULL_TO_FULL" | "SAME_LEVEL" | "MINIMUM_LEVEL" | "INCLUDED" | "OTHER";

export type BusinessRules = {
  // Fahrer
  minimumDriverAge: number;
  minimumLicenseHoldingMonths: number;
  // Zusatzfahrer
  additionalDriversAllowed: boolean;
  additionalDriverFeeType: AdditionalDriverFeeType;
  additionalDriverFeeCents: number;
  // Kaution und Selbstbeteiligung (Kaution: Fahrzeug/Gruppe tragen eigene Spalten; hier nur der Mandantenstandard)
  depositCents: number | null;
  deductibleCents: number | null;
  // Kilometer
  kmPolicy: KmPolicy;
  // Kraftstoff / Ladung
  fuelRule: FuelRule;
  fuelMinimumEighths: number | null;
  batteryMinimumPercent: number | null;
  // Ausland
  abroadAllowed: boolean;
  abroadCountries: string[];
  // Rauchen, Tiere
  smokingAllowed: boolean;
  petsPolicy: PetsPolicy;
  // Rückgabe
  lateReturnRule: LateReturnRule;
  lateReturnFeeCents: number | null;
  outOfHoursReturn: OutOfHoursReturn;
  outOfHoursInstructions: string | null;
  // Reinigung (Richtwerte, keine automatische Belastung)
  cleaningHeavySoilingCents: number | null;
  cleaningSmokingCents: number | null;
  cleaningPetHairCents: number | null;
  cleaningSpecialCents: number | null;
  // Schlüssel und Zubehör
  keysAccessoriesNote: string | null;
  // Behörden (vorbereitet, standardmäßig deaktiviert; erzeugt nie eine Belastung)
  authorityHandlingFeeEnabled: boolean;
  authorityHandlingFeeCents: number;
  // Sondernutzung
  trailerAllowed: boolean;
  towingAllowed: boolean;
  commercialPassengerTransportAllowed: boolean;
  specialUseNote: string | null;
};

export const DEFAULT_BUSINESS_RULES: BusinessRules = {
  minimumDriverAge: 18,
  minimumLicenseHoldingMonths: 0,
  additionalDriversAllowed: true,
  additionalDriverFeeType: "FREE",
  additionalDriverFeeCents: 0,
  depositCents: null,
  deductibleCents: null,
  kmPolicy: "FREE_KILOMETERS",
  fuelRule: "FULL_TO_FULL",
  fuelMinimumEighths: null,
  batteryMinimumPercent: null,
  abroadAllowed: false,
  abroadCountries: [],
  smokingAllowed: false,
  petsPolicy: "BY_APPROVAL",
  lateReturnRule: "MANUAL",
  lateReturnFeeCents: null,
  outOfHoursReturn: "BY_AGREEMENT",
  outOfHoursInstructions: null,
  cleaningHeavySoilingCents: null,
  cleaningSmokingCents: null,
  cleaningPetHairCents: null,
  cleaningSpecialCents: null,
  keysAccessoriesNote: null,
  authorityHandlingFeeEnabled: false,
  authorityHandlingFeeCents: 0,
  trailerAllowed: false,
  towingAllowed: false,
  commercialPassengerTransportAllowed: false,
  specialUseNote: null,
};

export type RuleKey = keyof BusinessRules;
export const RULE_KEYS = Object.keys(DEFAULT_BUSINESS_RULES) as RuleKey[];

/** Schlüssel, die Fahrzeuggruppe und Fahrzeug abweichend setzen dürfen. Alles andere gilt mandantenweit. */
export const OVERRIDABLE_KEYS = ["deductibleCents", "kmPolicy", "fuelRule", "fuelMinimumEighths", "batteryMinimumPercent", "abroadAllowed", "abroadCountries", "smokingAllowed", "petsPolicy", "additionalDriversAllowed", "additionalDriverFeeType", "additionalDriverFeeCents", "trailerAllowed", "towingAllowed"] as const satisfies readonly RuleKey[];
export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];
export type RuleOverrides = Partial<Pick<BusinessRules, OverridableKey>>;

/** Schlüssel, die im einzelnen Vertrag angepasst werden dürfen (innerhalb der erlaubten Grenzen). */
export const CONTRACT_KEYS = ["kmPolicy", "fuelRule", "fuelMinimumEighths", "batteryMinimumPercent", "abroadAllowed", "abroadCountries", "smokingAllowed", "petsPolicy", "additionalDriverFeeType", "additionalDriverFeeCents"] as const satisfies readonly RuleKey[];
export type ContractRuleKey = (typeof CONTRACT_KEYS)[number];

const ENUMS: Partial<Record<RuleKey, readonly string[]>> = {
  additionalDriverFeeType: ["FREE", "FLAT", "PER_DAY"],
  kmPolicy: ["UNLIMITED", "FREE_KILOMETERS", "INDIVIDUAL"],
  fuelRule: ["FULL_TO_FULL", "SAME_LEVEL", "MINIMUM_LEVEL", "INCLUDED", "OTHER"],
  petsPolicy: ["ALLOWED", "NOT_ALLOWED", "BY_APPROVAL"],
  lateReturnRule: ["MANUAL", "ADDITIONAL_RENTAL_TIME", "CONFIGURED_FEE", "INDIVIDUAL"],
  outOfHoursReturn: ["ALLOWED", "NOT_ALLOWED", "BY_AGREEMENT"],
};
const BOOLS: RuleKey[] = ["additionalDriversAllowed", "abroadAllowed", "smokingAllowed", "authorityHandlingFeeEnabled", "trailerAllowed", "towingAllowed", "commercialPassengerTransportAllowed"];
const TEXTS: RuleKey[] = ["outOfHoursInstructions", "keysAccessoriesNote", "specialUseNote"];

export class RuleError extends Error {}

const isCountry = (c: unknown): c is string => typeof c === "string" && c in COUNTRIES && c !== "OTHER";

/**
 * Prüft und normalisiert einen (Teil-)Regelsatz. Unbekannte Schlüssel werden verworfen, Geldwerte müssen ≥ 0 sein,
 * Aufzählungen gültig, Länder aus der bekannten Liste. Liefert nur die übergebenen Schlüssel zurück.
 */
export function sanitizeRules(input: unknown, allowed: readonly RuleKey[] = RULE_KEYS): Partial<BusinessRules> {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === undefined) continue;
    if (v === null) {
      if (["depositCents", "deductibleCents", "fuelMinimumEighths", "batteryMinimumPercent", "lateReturnFeeCents", "cleaningHeavySoilingCents", "cleaningSmokingCents", "cleaningPetHairCents", "cleaningSpecialCents", ...TEXTS].includes(key)) { out[key] = null; continue; }
      throw new RuleError(`${key}: Wert fehlt.`);
    }
    if (key.endsWith("Cents")) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new RuleError(`${labelOf(key)}: bitte einen Betrag ab 0 angeben.`);
      out[key] = v;
    } else if (key === "minimumDriverAge") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 16 || v > 99) throw new RuleError("Mindestalter: bitte ein Alter zwischen 16 und 99 angeben.");
      out[key] = v;
    } else if (key === "minimumLicenseHoldingMonths") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 600) throw new RuleError("Führerscheinbesitz: bitte Monate zwischen 0 und 600 angeben.");
      out[key] = v;
    } else if (key === "fuelMinimumEighths") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 8) throw new RuleError("Mindestfüllstand: bitte 0 bis 8 Achtel angeben.");
      out[key] = v;
    } else if (key === "batteryMinimumPercent") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) throw new RuleError("Mindestladestand: bitte 0 bis 100 Prozent angeben.");
      out[key] = v;
    } else if (key in ENUMS) {
      if (typeof v !== "string" || !ENUMS[key]!.includes(v)) throw new RuleError(`${labelOf(key)}: ungültiger Wert.`);
      out[key] = v;
    } else if (BOOLS.includes(key)) {
      if (typeof v !== "boolean") throw new RuleError(`${labelOf(key)}: ja oder nein.`);
      out[key] = v;
    } else if (key === "abroadCountries") {
      if (!Array.isArray(v) || !v.every(isCountry)) throw new RuleError("Auslandsländer: bitte nur bekannte Länder auswählen.");
      out[key] = [...new Set(v as string[])].sort();
    } else if (TEXTS.includes(key)) {
      if (typeof v !== "string") throw new RuleError(`${labelOf(key)}: bitte Text angeben.`);
      out[key] = v.trim().slice(0, 2000) || null;
    }
  }
  return out as Partial<BusinessRules>;
}

/** Fachliche Widersprüche innerhalb eines vollständigen Regelsatzes. */
export function ruleConsistencyIssues(r: BusinessRules): string[] {
  const issues: string[] = [];
  if (r.additionalDriverFeeType !== "FREE" && !(r.additionalDriverFeeCents > 0)) issues.push("Zusatzfahrer: Bei einer kostenpflichtigen Regel muss ein Betrag über 0 angegeben sein.");
  if (r.additionalDriverFeeType === "FREE" && r.additionalDriverFeeCents > 0) issues.push("Zusatzfahrer: „Kostenlos“ passt nicht zu einem Betrag.");
  if (r.abroadAllowed && r.abroadCountries.length === 0) issues.push("Ausland: Bei erlaubten Auslandsfahrten muss mindestens ein Land freigegeben sein.");
  if (!r.abroadAllowed && r.abroadCountries.length > 0) issues.push("Ausland: Länder sind nur bei erlaubten Auslandsfahrten sinnvoll.");
  if (r.fuelRule === "MINIMUM_LEVEL" && r.fuelMinimumEighths == null && r.batteryMinimumPercent == null) issues.push("Tank-/Laderegel: Bei „Mindestfüllstand“ muss ein Mindestwert angegeben sein.");
  if (r.lateReturnRule === "CONFIGURED_FEE" && !(r.lateReturnFeeCents != null && r.lateReturnFeeCents > 0)) issues.push("Verspätete Rückgabe: Für den hinterlegten Richtwert fehlt der Betrag.");
  if (r.authorityHandlingFeeEnabled && !(r.authorityHandlingFeeCents > 0)) issues.push("Bearbeitungsentgelt Behörden: aktiviert, aber ohne Betrag.");
  return issues;
}

export type ResolvedRules = { values: BusinessRules; sources: Record<RuleKey, RuleSource>; groupName: string | null; vehiclePlate: string | null };

export type ResolvedDeposit = { cents: number; source: RuleSource };
/**
 * Kautionsvorgabe für einen neuen Vertrag: Fahrzeug → Fahrzeuggruppe → Mandantenstandard → 0. Fahrzeug und Gruppe tragen
 * ihre bestehenden Kautionsspalten; 0 bedeutet dort „nicht gesetzt“. Es entsteht nie eine Kautionsbewegung – nur der Vertragswert.
 */
export function resolveDeposit(tenantRules: unknown, group: { deposit: unknown } | null | undefined, vehicle: { deposit: unknown } | null | undefined): ResolvedDeposit {
  const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
  if (vehicle && cents(vehicle.deposit) > 0) return { cents: cents(vehicle.deposit), source: "VEHICLE" };
  if (group && cents(group.deposit) > 0) return { cents: cents(group.deposit), source: "GROUP" };
  const tenant = safe(tenantRules, ["depositCents"]);
  if (tenant.depositCents != null) return { cents: tenant.depositCents, source: "TENANT" };
  return { cents: 0, source: "DEFAULT" };
}

/** Herkunft der Vertragskaution: gleich der Vorgabe → deren Quelle, sonst individuell angepasst. */
export function depositSourceOf(contractDepositCents: number, resolved: ResolvedDeposit): RuleSource {
  return contractDepositCents === resolved.cents ? resolved.source : "CONTRACT";
}

/** Systemvorgabe → Mandant → Gruppe → Fahrzeug. Nur gesetzte (nicht undefined) Schlüssel überschreiben. */
export function resolveRules(tenantRules: unknown, group: { name: string; businessRules: unknown } | null | undefined, vehicle: { plate: string; businessRules: unknown } | null | undefined): ResolvedRules {
  const values: BusinessRules = { ...DEFAULT_BUSINESS_RULES };
  const sources = Object.fromEntries(RULE_KEYS.map((k) => [k, "DEFAULT"])) as Record<RuleKey, RuleSource>;
  const apply = (layer: Partial<BusinessRules>, source: RuleSource) => {
    for (const k of Object.keys(layer) as RuleKey[]) {
      const v = layer[k];
      if (v === undefined) continue;
      (values as Record<string, unknown>)[k] = v;
      sources[k] = source;
    }
  };
  apply(safe(tenantRules, RULE_KEYS), "TENANT");
  if (group) apply(safe(group.businessRules, OVERRIDABLE_KEYS), "GROUP");
  if (vehicle) apply(safe(vehicle.businessRules, OVERRIDABLE_KEYS), "VEHICLE");
  return { values, sources, groupName: group?.name ?? null, vehiclePlate: vehicle?.plate ?? null };
}

function safe(input: unknown, allowed: readonly RuleKey[]): Partial<BusinessRules> {
  try { return sanitizeRules(input, allowed); } catch { return {}; }
}

/** Kurzer Fingerabdruck der aufgelösten Vorgaben: ändert er sich, sind „neuere Standardwerte verfügbar“. */
export function rulesFingerprint(values: BusinessRules, deposit?: ResolvedDeposit): string {
  return contentHash(deposit ? { values, deposit: deposit.cents } : values).slice(0, 16);
}

export function labelOf(key: RuleKey): string {
  const labels: Record<RuleKey, string> = {
    minimumDriverAge: "Mindestalter Fahrer", minimumLicenseHoldingMonths: "Mindestdauer Führerscheinbesitz (Monate)",
    additionalDriversAllowed: "Zusatzfahrer erlaubt", additionalDriverFeeType: "Zusatzfahrer-Preisregel", additionalDriverFeeCents: "Zusatzfahrer-Preis",
    depositCents: "Kaution (Standard)", deductibleCents: "Selbstbeteiligung",
    kmPolicy: "Kilometerregel", fuelRule: "Tank-/Laderegel", fuelMinimumEighths: "Mindestfüllstand Tank", batteryMinimumPercent: "Mindestladestand Batterie",
    abroadAllowed: "Auslandsfahrten erlaubt", abroadCountries: "Freigegebene Länder", smokingAllowed: "Rauchen erlaubt", petsPolicy: "Tiere",
    lateReturnRule: "Verspätete Rückgabe", lateReturnFeeCents: "Richtwert verspätete Rückgabe", outOfHoursReturn: "Rückgabe außerhalb der Öffnungszeiten", outOfHoursInstructions: "Anweisung Rückgabe außerhalb der Öffnungszeiten",
    cleaningHeavySoilingCents: "Richtwert außergewöhnliche Verschmutzung", cleaningSmokingCents: "Richtwert Rauchen", cleaningPetHairCents: "Richtwert Tierhaare", cleaningSpecialCents: "Richtwert Sonderreinigung",
    keysAccessoriesNote: "Hinweis Schlüssel und Zubehör", authorityHandlingFeeEnabled: "Bearbeitungsentgelt Behörden aktiv", authorityHandlingFeeCents: "Bearbeitungsentgelt Behörden",
    trailerAllowed: "Anhängerbetrieb erlaubt", towingAllowed: "Abschleppen erlaubt", commercialPassengerTransportAllowed: "Gewerbliche Personenbeförderung erlaubt", specialUseNote: "Hinweis Sondernutzung",
  };
  return labels[key] ?? key;
}

/** Text der Herkunft für die Oberfläche, z. B. „Fahrzeuggruppe „Transporter““. */
export function sourceText(source: RuleSource, ctx: { groupName?: string | null; vehiclePlate?: string | null }): string {
  switch (source) {
    case "GROUP": return `Fahrzeuggruppe${ctx.groupName ? ` „${ctx.groupName}“` : ""}`;
    case "VEHICLE": return `Fahrzeug${ctx.vehiclePlate ? ` „${ctx.vehiclePlate}“` : ""}`;
    case "TENANT": return "Standard des Vermieters";
    case "BOOKING": return "Buchung";
    case "CONTRACT": return "Individuell angepasst";
    default: return "Systemvorgabe";
  }
}

// ---------------------------------------------------------------------------
// Vertragsschnappschuss: konkrete Werte + Herkunft, eingefroren in RentalContract.conditions
// ---------------------------------------------------------------------------

export type ContractRules = {
  rulesVersion: 1;
  resolvedAt: string;
  /** Fingerabdruck der Vorgaben, aus denen der Schnappschuss entstand; weicht er vom aktuellen ab, gibt es neuere Standardwerte */
  defaultsFingerprint: string;
  values: BusinessRules & { kmPolicyNote: string | null };
  sources: Record<RuleKey, RuleSource>;
  groupName: string | null;
  vehiclePlate: string | null;
  /** aufgelöste Kautionsvorgabe (Fahrzeug → Gruppe → Mandant) zum Zeitpunkt des Schnappschusses; fehlt bei älteren Schnappschüssen */
  depositResolvedCents?: number;
  depositSource?: RuleSource;
};

/** Erster Schnappschuss aus den aufgelösten Vorgaben (keine Vertragsanpassung). */
export function initialContractRules(resolved: ResolvedRules, now = new Date(), deposit?: ResolvedDeposit): ContractRules {
  return { rulesVersion: 1, resolvedAt: now.toISOString(), defaultsFingerprint: rulesFingerprint(resolved.values), values: { ...resolved.values, kmPolicyNote: null }, sources: { ...resolved.sources }, groupName: resolved.groupName, vehiclePlate: resolved.vehiclePlate, ...(deposit ? { depositResolvedCents: deposit.cents, depositSource: deposit.source } : {}) };
}

export function readContractRules(conditions: unknown): ContractRules | null {
  const c = conditions as Partial<ContractRules> | null;
  if (!c || typeof c !== "object" || c.rulesVersion !== 1 || !c.values || !c.sources) return null;
  return c as ContractRules;
}

/** Vertragsanpassung: nur erlaubte Schlüssel, Herkunft wird „Individuell angepasst“, wenn der Wert vom Standard abweicht. */
export function applyContractOverrides(current: ContractRules, resolved: ResolvedRules, input: Partial<Pick<BusinessRules, ContractRuleKey>> & { kmPolicyNote?: string | null }): { rules: ContractRules; changes: { key: string; from: unknown; to: unknown }[] } {
  const clean = sanitizeRules(input, CONTRACT_KEYS) as Partial<Pick<BusinessRules, ContractRuleKey>>;
  const values = { ...current.values } as ContractRules["values"];
  const sources = { ...current.sources };
  const changes: { key: string; from: unknown; to: unknown }[] = [];
  for (const k of CONTRACT_KEYS) {
    if (!(k in clean)) continue;
    const next = clean[k];
    const before = values[k];
    if (JSON.stringify(before) !== JSON.stringify(next)) changes.push({ key: k, from: before, to: next });
    (values as Record<string, unknown>)[k] = next;
    sources[k] = JSON.stringify(next) === JSON.stringify(resolved.values[k]) ? resolved.sources[k] : "CONTRACT";
  }
  if ("kmPolicyNote" in input) values.kmPolicyNote = input.kmPolicyNote?.trim() || null;
  return { rules: { ...current, values, sources }, changes };
}

/** „Aktuelle Standardwerte übernehmen“: nur Werte ohne individuelle Anpassung werden ersetzt. */
export function adoptDefaults(current: ContractRules, resolved: ResolvedRules, now = new Date(), deposit?: ResolvedDeposit): ContractRules {
  const values = { ...current.values };
  const sources = { ...current.sources };
  for (const k of RULE_KEYS) {
    if (sources[k] === "CONTRACT") continue;
    (values as Record<string, unknown>)[k] = resolved.values[k];
    sources[k] = resolved.sources[k];
  }
  return { ...current, resolvedAt: now.toISOString(), defaultsFingerprint: rulesFingerprint(resolved.values), values, sources, groupName: resolved.groupName, vehiclePlate: resolved.vehiclePlate, ...(deposit ? { depositResolvedCents: deposit.cents, depositSource: deposit.source } : {}) };
}

/** Vertragswerte innerhalb der erlaubten Grenzen: Auslandsländer nur aus der Freigabeliste, Zusatzfahrer nur wenn erlaubt. */
export function contractRuleIssues(rules: ContractRules, resolved: ResolvedRules, ctx: { driveClass: "COMBUSTION" | "ELECTRIC" | "PHEV"; additionalDrivers: number }): string[] {
  const v = rules.values;
  const issues: string[] = [];
  if (v.abroadAllowed) {
    if (!resolved.values.abroadAllowed) issues.push("Auslandsfahrten sind nach den Geschäftsregeln nicht vorgesehen. Eine Freigabe im Vertrag braucht zuerst die Einstellung des Vermieters.");
    const outside = v.abroadCountries.filter((c) => !resolved.values.abroadCountries.includes(c));
    if (outside.length) issues.push(`Ausland: ${outside.map((c) => COUNTRIES[c as keyof typeof COUNTRIES] ?? c).join(", ")} ist nicht in der Freigabeliste des Vermieters.`);
    if (v.abroadCountries.length === 0) issues.push("Ausland: Bitte die konkret genehmigten Länder auswählen.");
  }
  if (v.kmPolicy === "INDIVIDUAL" && !v.kmPolicyNote) issues.push("Bitte die individuelle Kilometerregel beschreiben.");
  if (v.fuelRule === "MINIMUM_LEVEL") {
    if (ctx.driveClass !== "ELECTRIC" && v.fuelMinimumEighths == null) issues.push("Tankregel „Mindestfüllstand“: bitte den Mindestfüllstand in Achteln angeben.");
    if (ctx.driveClass !== "COMBUSTION" && v.batteryMinimumPercent == null) issues.push("Laderegel „Mindestladestand“: bitte den Mindestladestand in Prozent angeben.");
  }
  if (ctx.driveClass === "COMBUSTION" && v.batteryMinimumPercent != null) issues.push("Ein Verbrenner hat keinen Ladestand: bitte den Mindestladestand entfernen.");
  if (ctx.driveClass === "ELECTRIC" && v.fuelMinimumEighths != null) issues.push("Ein Elektrofahrzeug hat keinen Tank: bitte den Mindestfüllstand entfernen.");
  if (v.additionalDriverFeeType !== "FREE" && !(v.additionalDriverFeeCents > 0)) issues.push("Zusatzfahrer: Bei einer kostenpflichtigen Regel muss ein Betrag über 0 angegeben sein.");
  if (ctx.additionalDrivers > 0 && !v.additionalDriversAllowed) issues.push("Nach den Geschäftsregeln sind für dieses Fahrzeug keine Zusatzfahrer vorgesehen.");
  return issues;
}

/** Zusatzfahrer-Preis als eigene Position (nie im Basispreis versteckt). */
export function additionalDriverFee(v: Pick<BusinessRules, "additionalDriverFeeType" | "additionalDriverFeeCents">, drivers: number, days: number): { quantity: number; unitCents: number; amountCents: number; label: string } | null {
  if (drivers <= 0 || v.additionalDriverFeeType === "FREE" || !(v.additionalDriverFeeCents > 0)) return null;
  if (v.additionalDriverFeeType === "FLAT") return { quantity: drivers, unitCents: v.additionalDriverFeeCents, amountCents: drivers * v.additionalDriverFeeCents, label: "Zusatzfahrer (pauschal)" };
  const q = drivers * Math.max(1, days);
  return { quantity: q, unitCents: v.additionalDriverFeeCents, amountCents: q * v.additionalDriverFeeCents, label: `Zusatzfahrer (${drivers} × ${Math.max(1, days)} Tage)` };
}

// ---------------------------------------------------------------------------
// Mindestalter: kalendergenau in Europe/Berlin. Geburtstag 29. Februar: in Nicht-Schaltjahren zählt der 1. März
// (§ 187 Abs. 2, § 188 Abs. 3 BGB). Ein Fahrer ist am Tag seines 18. Geburtstags 18 – ab 00:00 Uhr.
// ---------------------------------------------------------------------------

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Kalenderdatum des Geburtsdatums (Datumsfelder werden als UTC-Mitternacht gespeichert). */
export function birthParts(birth: Date): { y: number; m: number; d: number } {
  return { y: birth.getUTCFullYear(), m: birth.getUTCMonth() + 1, d: birth.getUTCDate() };
}

export function localDateParts(at: Date, timeZone = "Europe/Berlin"): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: g("year"), m: g("month"), d: g("day") };
}

/** Vollendete Lebensjahre am (lokalen) Kalendertag von `at`. */
export function ageAt(birth: Date, at: Date): number {
  const b = birthParts(birth);
  const t = localDateParts(at);
  let age = t.y - b.y;
  // Geburtstag im Jahr t.y: 29.02. wird in Nicht-Schaltjahren zum 01.03.
  let bm = b.m, bd = b.d;
  if (bm === 2 && bd === 29 && !isLeap(t.y)) { bm = 3; bd = 1; }
  if (t.m < bm || (t.m === bm && t.d < bd)) age -= 1;
  return age;
}

/** Monate seit Ausstellung des Führerscheins am Kalendertag von `at` (vollendete Monate). */
export function monthsSince(issued: Date, at: Date): number {
  const i = birthParts(issued);
  const t = localDateParts(at);
  let months = (t.y - i.y) * 12 + (t.m - i.m);
  if (t.d < i.d) months -= 1;
  return months;
}

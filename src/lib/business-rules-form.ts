// Formulardaten → Geschäftsregeln (Server-Helfer für Einstellungen, Fahrzeuggruppe und Fahrzeug). Keine Datenbank.
import { COUNTRIES } from "@/lib/constants";
import { DEFAULT_BUSINESS_RULES, OVERRIDABLE_KEYS, RuleError, sanitizeRules, type BusinessRules, type RuleKey, type RuleOverrides } from "@/lib/business-rules";

export const RULE_SECTIONS: Record<string, RuleKey[]> = {
  fahrer: ["minimumDriverAge", "minimumLicenseHoldingMonths"],
  zusatzfahrer: ["additionalDriversAllowed", "additionalDriverFeeType", "additionalDriverFeeCents"],
  kaution: ["depositCents", "deductibleCents"],
  kilometer: ["kmPolicy"],
  tanken: ["fuelRule", "fuelMinimumEighths", "batteryMinimumPercent"],
  ausland: ["abroadAllowed", "abroadCountries"],
  rauchen: ["smokingAllowed", "petsPolicy"],
  rueckgabe: ["lateReturnRule", "lateReturnFeeCents", "outOfHoursReturn", "outOfHoursInstructions"],
  reinigung: ["cleaningHeavySoilingCents", "cleaningSmokingCents", "cleaningPetHairCents", "cleaningSpecialCents", "keysAccessoriesNote"],
  behoerden: ["authorityHandlingFeeEnabled", "authorityHandlingFeeCents"],
  nutzung: ["trailerAllowed", "towingAllowed", "commercialPassengerTransportAllowed", "specialUseNote"],
};

export const cents = (v: FormDataEntryValue | null): number | null => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).trim().replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new RuleError("Bitte einen gültigen Betrag angeben (z. B. 25,00).");
  return Math.round(n * 100);
};
const int = (v: FormDataEntryValue | null): number | null => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v));
  if (!Number.isInteger(n)) throw new RuleError("Bitte eine ganze Zahl angeben.");
  return n;
};
const bool = (v: FormDataEntryValue | null) => v === "1" || v === "on" || v === "true";
const text = (v: FormDataEntryValue | null) => (v == null ? null : String(v).trim() || null);
const BOOL_KEYS = ["additionalDriversAllowed", "abroadAllowed", "smokingAllowed", "authorityHandlingFeeEnabled", "trailerAllowed", "towingAllowed", "commercialPassengerTransportAllowed"];
const TEXT_KEYS = ["outOfHoursInstructions", "keysAccessoriesNote", "specialUseNote"];

/** Vollständige Sektion der Mandantenregeln aus dem Formular. */
export function rulesFromForm(fd: FormData, keys: readonly RuleKey[]): Partial<BusinessRules> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k.endsWith("Cents")) out[k] = k === "additionalDriverFeeCents" || k === "authorityHandlingFeeCents" ? (cents(fd.get(k)) ?? 0) : cents(fd.get(k));
    else if (k === "minimumDriverAge") out[k] = int(fd.get(k)) ?? DEFAULT_BUSINESS_RULES.minimumDriverAge;
    else if (k === "minimumLicenseHoldingMonths") out[k] = int(fd.get(k)) ?? 0;
    else if (k === "fuelMinimumEighths" || k === "batteryMinimumPercent") out[k] = int(fd.get(k));
    else if (k === "abroadCountries") out[k] = fd.getAll(k).map(String).filter((c) => c in COUNTRIES && c !== "OTHER");
    else if (BOOL_KEYS.includes(k)) out[k] = bool(fd.get(k));
    else if (TEXT_KEYS.includes(k)) out[k] = text(fd.get(k));
    else out[k] = String(fd.get(k) ?? "");
  }
  return sanitizeRules(out, keys);
}

/** Abweichungen an Gruppe/Fahrzeug: nur gesetzte Felder; leer = wie Standard. „clear“ entfernt alle. */
export function overridesFromForm(fd: FormData): RuleOverrides | null {
  if (fd.get("clear") === "1") return null;
  const out: Record<string, unknown> = {};
  const tri = (name: string) => { const v = String(fd.get(name) ?? ""); return v === "1" ? true : v === "0" ? false : undefined; };
  const d = cents(fd.get("deductible")); if (d != null) out.deductibleCents = d;
  const km = String(fd.get("kmPolicy") ?? ""); if (km) out.kmPolicy = km;
  const fuel = String(fd.get("fuelRule") ?? ""); if (fuel) { out.fuelRule = fuel; if (fuel === "MINIMUM_LEVEL") { out.fuelMinimumEighths = int(fd.get("fuelMinimumEighths")); out.batteryMinimumPercent = int(fd.get("batteryMinimumPercent")); } }
  const abroad = tri("abroad"); if (abroad !== undefined) { out.abroadAllowed = abroad; const list = fd.getAll("abroadCountries").map(String).filter((c) => c in COUNTRIES && c !== "OTHER"); if (abroad && list.length) out.abroadCountries = list; if (!abroad) out.abroadCountries = []; }
  const smoking = tri("smoking"); if (smoking !== undefined) out.smokingAllowed = smoking;
  const pets = String(fd.get("petsPolicy") ?? ""); if (pets) out.petsPolicy = pets;
  const add = tri("additionalDrivers"); if (add !== undefined) out.additionalDriversAllowed = add;
  const feeType = String(fd.get("additionalDriverFeeType") ?? ""); if (feeType) { out.additionalDriverFeeType = feeType; out.additionalDriverFeeCents = feeType === "FREE" ? 0 : (cents(fd.get("additionalDriverFee")) ?? 0); }
  const trailer = tri("trailer"); if (trailer !== undefined) out.trailerAllowed = trailer;
  const towing = tri("towing"); if (towing !== undefined) out.towingAllowed = towing;
  const clean = sanitizeRules(out, OVERRIDABLE_KEYS) as RuleOverrides;
  if (clean.fuelRule === "MINIMUM_LEVEL" && clean.fuelMinimumEighths == null && clean.batteryMinimumPercent == null) throw new RuleError("Tank-/Laderegel „Mindestfüllstand“: bitte einen Mindestwert angeben.");
  if (clean.additionalDriverFeeType && clean.additionalDriverFeeType !== "FREE" && !((clean.additionalDriverFeeCents ?? 0) > 0)) throw new RuleError("Zusatzfahrer: Bei einer kostenpflichtigen Regel muss ein Betrag über 0 angegeben sein.");
  return Object.keys(clean).length ? clean : null;
}

/** Abweichungen → Formularwerte. */
export function overrideValues(rules: unknown) {
  const o = (() => { try { return sanitizeRules(rules, OVERRIDABLE_KEYS) as RuleOverrides; } catch { return {} as RuleOverrides; } })();
  const tri = (v: boolean | undefined): "" | "1" | "0" => (v === undefined ? "" : v ? "1" : "0");
  const eur = (c: number | undefined | null) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
  return {
    deductible: eur(o.deductibleCents), kmPolicy: o.kmPolicy ?? "", fuelRule: o.fuelRule ?? "", fuelMinimumEighths: o.fuelMinimumEighths != null ? String(o.fuelMinimumEighths) : "", batteryMinimumPercent: o.batteryMinimumPercent != null ? String(o.batteryMinimumPercent) : "",
    abroad: tri(o.abroadAllowed), abroadCountries: o.abroadCountries ?? [], smoking: tri(o.smokingAllowed), petsPolicy: o.petsPolicy ?? "", additionalDrivers: tri(o.additionalDriversAllowed),
    additionalDriverFeeType: o.additionalDriverFeeType ?? "", additionalDriverFee: eur(o.additionalDriverFeeCents), trailer: tri(o.trailerAllowed), towing: tri(o.towingAllowed),
  };
}

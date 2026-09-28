// Befehl 20.9: Zubehör mit Standard-Ersatzpreis. Reine Funktionen, keine Datenbank.
//
// Grundsätze:
// - Ein Zubehörteil gilt nur dann als „fehlt“, wenn die Übergabe-Checkliste es eindeutig als vorhanden (JA) dokumentiert
//   hat UND die Rückgabe-Checkliste denselben Punkt mit NEIN beantwortet. Fehlte es schon bei der Übergabe, war es
//   „Nicht zutreffend“ oder unbeantwortet, entsteht kein Vorschlag.
// - Das Ergebnis ist ein VORSCHLAG (lib/returns.ts). Erst „Übernehmen“ erzeugt über den bestehenden Zusatzkostenprozess
//   genau eine Position vom Typ MISSING_ACCESSORY; das bloße „Nein“ in der Checkliste belastet den Kunden nie.
// - Preise: fester Standard (Warndreieck, Warnweste, Verbandkasten) oder fahrzeugbezogen über die Geschäftsregeln
//   (Hutablage: Regel parcelShelfReplacementCents, Auflösung Fahrzeug → Gruppe → Mandant, im Vertrag eingefroren).
//   Ohne hinterlegten Preis wird das Fehlen erkannt, aber kein Betrag erfunden (Hinweis statt Vorschlag).
// - Neue Zubehörpositionen: ein Eintrag in ACCESSORY_ITEMS (+ ggf. eine Regel in business-rules.ts) genügt.

import type { BusinessRules, RuleKey } from "@/lib/business-rules";

export type AccessoryDef = {
  /** Schlüssel des Checklistenpunkts in Übergabe- und Rückgabe-Checkliste */
  key: string;
  label: string;
  /** fester Standard-Ersatzpreis in Cent; null = fahrzeugabhängig über ruleKey */
  fixedPriceCents: number | null;
  /** Geschäftsregel mit dem fahrzeugbezogenen Ersatzpreis (Cent, nullable) */
  ruleKey?: RuleKey;
};

export const ACCESSORY_ITEMS: readonly AccessoryDef[] = [
  { key: "warning_triangle", label: "Warndreieck", fixedPriceCents: 20_00 },
  { key: "safety_vest", label: "Warnweste", fixedPriceCents: 20_00 },
  { key: "first_aid", label: "Verbandkasten", fixedPriceCents: 20_00 },
  { key: "parcel_shelf", label: "Hutablage", fixedPriceCents: null, ruleKey: "parcelShelfReplacementCents" },
] as const;

export const ACCESSORY_PROPOSAL_PREFIX = "ACCESSORY_";
export const accessoryProposalKey = (key: string): `ACCESSORY_${string}` => `ACCESSORY_${key}`;
export const accessoryOf = (proposalKey: string): AccessoryDef | null => (proposalKey.startsWith(ACCESSORY_PROPOSAL_PREFIX) ? ACCESSORY_ITEMS.find((a) => a.key === proposalKey.slice(ACCESSORY_PROPOSAL_PREFIX.length)) ?? null : null);

export type ChecklistAnswer = { itemKey: string; result: string | null };

export type AccessoryPrice = { cents: number | null; origin: "STANDARD" | "CONTRACT" | "VEHICLE" | "NONE" };

/**
 * Ersatzpreis eines Zubehörteils: fester Standard, sonst aus den Vertragsregeln (Schnappschuss), sonst aus den aktuell
 * aufgelösten Fahrzeugregeln (nur für Verträge, deren Schnappschuss die Regel noch nicht kannte), sonst keiner.
 */
export function accessoryPrice(def: AccessoryDef, contractRules: Partial<BusinessRules> | null, currentRules: Partial<BusinessRules> | null): AccessoryPrice {
  if (def.fixedPriceCents != null) return { cents: def.fixedPriceCents, origin: "STANDARD" };
  if (!def.ruleKey) return { cents: null, origin: "NONE" };
  const fromContract = contractRules && def.ruleKey in contractRules ? (contractRules[def.ruleKey] as number | null | undefined) : undefined;
  if (fromContract !== undefined) return fromContract != null && fromContract > 0 ? { cents: fromContract, origin: "CONTRACT" } : { cents: null, origin: "NONE" };
  const fromVehicle = currentRules ? (currentRules[def.ruleKey] as number | null | undefined) : undefined;
  if (fromVehicle != null && fromVehicle > 0) return { cents: fromVehicle, origin: "VEHICLE" };
  return { cents: null, origin: "NONE" };
}

export type AccessoryFinding = { def: AccessoryDef; price: AccessoryPrice };

/** Zubehör, das bei der Übergabe eindeutig vorhanden war (JA) und bei der Rückgabe fehlt (NEIN). Sonst nichts. */
export function missingAccessories(pickup: ChecklistAnswer[], ret: ChecklistAnswer[], prices: (def: AccessoryDef) => AccessoryPrice): AccessoryFinding[] {
  const out: AccessoryFinding[] = [];
  for (const def of ACCESSORY_ITEMS) {
    const before = pickup.find((i) => i.itemKey === def.key);
    const after = ret.find((i) => i.itemKey === def.key);
    if (before?.result !== "YES" || after?.result !== "NO") continue;
    out.push({ def, price: prices(def) });
  }
  return out;
}

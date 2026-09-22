// Feste Wertelisten. In der Datenbank als String abgelegt (SQLite), hier die erlaubten Werte und Labels.

export const ROLES = {
  OWNER: "Inhaber",
  DISPO: "Disponent",
  YARD: "Hofmitarbeiter",
} as const;
export type Role = keyof typeof ROLES;

export const FUELS = {
  DIESEL: "Diesel",
  BENZIN: "Benzin",
  ELEKTRO: "Elektro",
  HYBRID: "Hybrid",
  PLUGIN_HYBRID: "Plug-in-Hybrid",
} as const;
export type Fuel = keyof typeof FUELS;

export const VEHICLE_STATUS = {
  AVAILABLE: "Verfügbar",
  WORKSHOP: "Werkstatt",
  BLOCKED: "Gesperrt",
  INACTIVE: "Inaktiv",
} as const;
export type VehicleStatus = keyof typeof VEHICLE_STATUS;

export const CUSTOMER_TYPES = {
  PRIVATE: "Privat",
  COMPANY: "Firma",
} as const;
export type CustomerType = keyof typeof CUSTOMER_TYPES;

export const ID_TYPES = {
  PERSONALAUSWEIS: "Personalausweis",
  REISEPASS: "Reisepass",
  AUFENTHALTSTITEL: "Aufenthaltstitel",
  SONSTIGES: "Sonstiges Dokument",
} as const;
export type IdType = keyof typeof ID_TYPES;

export const BOOKING_STATUS = {
  RESERVED: "Reserviert",
  ACTIVE: "Unterwegs",
  RETURNED: "Zurückgegeben",
  CANCELLED: "Storniert",
} as const;
export type BookingStatus = keyof typeof BOOKING_STATUS;

/** Buchungen, die ein Fahrzeug im Zeitraum belegen. */
export const BLOCKING_BOOKING_STATUS: BookingStatus[] = ["RESERVED", "ACTIVE"];

export const SESSION_COOKIE = "rb_session";
export const SESSION_DAYS = 14;

// ---------------------------------------------------------------------------
// Etappe 2: Mietvertrag, Übergabe, Rückgabe, Schäden, Dokumente
// ---------------------------------------------------------------------------

export const BODY_TYPES = { PKW: "PKW", TRANSPORTER: "Transporter" } as const;
export type BodyType = keyof typeof BODY_TYPES;

export const CONTRACT_STATUS = { DRAFT: "Entwurf", SIGNED: "Unterschrieben", CANCELLED: "Storniert" } as const;
export type ContractStatus = keyof typeof CONTRACT_STATUS;

export const FUEL_POLICIES = { FULL_TO_FULL: "Voll/Voll", SAME_LEVEL: "Gleicher Füllstand", INCLUDED: "Kraftstoff inklusive", OTHER: "Individuelle Regelung" } as const;
export type FuelPolicy = keyof typeof FUEL_POLICIES;

export const DRIVER_ROLES = { PRIMARY_DRIVER: "Fahrer", ADDITIONAL_DRIVER: "Zusatzfahrer" } as const;
export type DriverRole = keyof typeof DRIVER_ROLES;

export const DRIVER_MODES = { RENTER: "Mieter fährt selbst", OTHER: "Abweichender Fahrer" } as const;
export type DriverMode = keyof typeof DRIVER_MODES;

/** Abgeleiteter Stand einer Buchung im Ablauf. Kein eigener Datenbankstatus, ergibt sich aus Buchung, Vertrag und Protokollen. */
export const BOOKING_STAGES = {
  NEEDS_CONTRACT: "Mietvertrag fehlt",
  CONTRACT_DRAFT: "Vertrag in Arbeit",
  READY_FOR_PICKUP: "Bereit zur Übergabe",
  ACTIVE: "Unterwegs",
  RETURNED: "Zurückgegeben",
  CANCELLED: "Storniert",
} as const;
export type BookingStage = keyof typeof BOOKING_STAGES;

export const COUNTRIES = { DE: "Deutschland", AT: "Österreich", CH: "Schweiz", NL: "Niederlande", PL: "Polen", TR: "Türkei", FR: "Frankreich", IT: "Italien", ES: "Spanien", OTHER: "Anderes Land" } as const;

export const HANDOVER_TYPES = { PICKUP: "Übergabe", RETURN: "Rückgabe" } as const;
export type HandoverType = keyof typeof HANDOVER_TYPES;

export const HANDOVER_STATUS = { DRAFT: "In Arbeit", FINALIZED: "Finalisiert" } as const;
export type HandoverStatus = keyof typeof HANDOVER_STATUS;

export const DAMAGE_VIEWS = { FRONT: "Vorne", REAR: "Hinten", LEFT: "Links (Fahrerseite)", RIGHT: "Rechts (Beifahrerseite)", TOP: "Dach", INTERIOR: "Innenraum" } as const;
export type DamageView = keyof typeof DAMAGE_VIEWS;

export const DAMAGE_KINDS = {
  SCRATCH: "Kratzer",
  DENT: "Delle",
  CRACK: "Riss",
  CHIP: "Steinschlag",
  BROKEN: "Bruch",
  MISSING_PART: "Fehlendes Teil",
  STAIN: "Fleck / Verschmutzung",
  OTHER: "Sonstiges",
} as const;
export type DamageKind = keyof typeof DAMAGE_KINDS;

export const DAMAGE_SEVERITY = { MINOR: "Leicht", MODERATE: "Mittel", SEVERE: "Schwer" } as const;
export type DamageSeverity = keyof typeof DAMAGE_SEVERITY;

export const DAMAGE_STATUS = {
  OPEN: "Offen",
  DOCUMENTED: "Dokumentiert",
  REPAIR_PLANNED: "Reparatur geplant",
  IN_REPAIR: "In Reparatur",
  REPAIRED: "Repariert",
} as const;
export type DamageStatus = keyof typeof DAMAGE_STATUS;

/** Schäden mit diesen Status sind am Fahrzeug sichtbar und werden in neue Protokolle kopiert. */
export const VISIBLE_DAMAGE_STATUS: DamageStatus[] = ["OPEN", "DOCUMENTED", "REPAIR_PLANNED", "IN_REPAIR"];

/**
 * Einstufung eines Schadens im Protokoll.
 * EXISTING = schon vor dieser Miete in der Akte, PICKUP_NEW = bei der Übergabe dieser Miete als Vorschaden dokumentiert
 * (nur in Rückgabeprotokollen), NEW = in diesem Protokoll neu erfasst.
 */
export const DAMAGE_MARKERS = { EXISTING: "Vorhanden", PICKUP_NEW: "Bei Übergabe dokumentiert", NEW: "Neu" } as const;
export type DamageMarker = keyof typeof DAMAGE_MARKERS;

export const PHOTO_CATEGORIES = {
  FRONT: "Vorne",
  REAR: "Hinten",
  LEFT: "Links",
  RIGHT: "Rechts",
  INTERIOR: "Innenraum",
  ODOMETER: "Kilometerstand",
  FUEL: "Tank / Batterie",
  DAMAGE: "Schaden",
  DOCUMENT: "Dokument",
  OTHER: "Sonstiges",
} as const;
export type PhotoCategory = keyof typeof PHOTO_CATEGORIES;

/** Pflichtansichten bei Übergabe und Rückgabe. */
export const REQUIRED_PHOTO_CATEGORIES: PhotoCategory[] = ["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "FUEL"];

export const SIGNATURE_ROLES = { RENTER: "Mieter", EMPLOYEE: "Mitarbeiter" } as const;
export type SignatureRole = keyof typeof SIGNATURE_ROLES;

export const DOCUMENT_TYPES = {
  RENTAL_CONTRACT: "Mietvertrag",
  PICKUP_PROTOCOL: "Übergabeprotokoll",
  RETURN_PROTOCOL: "Rückgabeprotokoll",
  INVOICE: "Rechnung",
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;

/** Checklistenpunkte, bei denen "Ja" die Auffälligkeit ist (sonst "Nein" bzw. "Nicht in Ordnung"). */
export const RETURN_ATTENTION_ON_YES = new Set(["unusually_dirty"]);

export const CHARGE_UNITS = ["km", "l", "kWh", "h", "Stk", "pauschal"] as const;

export const EXTRA_CHARGE_TYPES = {
  EXTRA_MILEAGE: "Mehrkilometer",
  FUEL: "Kraftstoff",
  CHARGING: "Ladung",
  CLEANING: "Reinigung",
  LATE_RETURN: "Verspätete Rückgabe",
  MISSING_ACCESSORY: "Fehlendes Zubehör",
  DAMAGE: "Schaden",
  OTHER: "Sonstiges",
} as const;
export type ExtraChargeType = keyof typeof EXTRA_CHARGE_TYPES;

export const EMAIL_STATUS = { PENDING: "Wartet", SENT: "Versendet", FAILED: "Fehlgeschlagen" } as const;
export type EmailStatus = keyof typeof EMAIL_STATUS;

export const VEHICLE_EVENT_TYPES = {
  PICKUP: "Übergabe",
  RETURN: "Rückgabe",
  MILEAGE: "Kilometerstand",
  DAMAGE_DISCOVERED: "Schaden festgestellt",
  DAMAGE_REPAIRED: "Schaden repariert",
} as const;
export type VehicleEventType = keyof typeof VEHICLE_EVENT_TYPES;

export const CHECKLIST_ANSWER_TYPES = { OK_NOT_OK: "In Ordnung / Nicht in Ordnung", YES_NO: "Ja / Nein", TEXT: "Freitext" } as const;
export type ChecklistAnswerType = keyof typeof CHECKLIST_ANSWER_TYPES;

/**
 * Was bei Übergabe und Rückgabe je Antrieb erfasst wird:
 * Verbrenner und Hybrid ohne Stecker: Tank in Achteln. Elektro: Batterie in Prozent. Plug-in-Hybrid: beides.
 */
export function energyRequirements(driveType: string): { fuel: boolean; battery: boolean } {
  if (driveType === "ELEKTRO") return { fuel: false, battery: true };
  if (driveType === "PLUGIN_HYBRID") return { fuel: true, battery: true };
  return { fuel: true, battery: false };
}

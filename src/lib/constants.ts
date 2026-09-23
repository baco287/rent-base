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

/** Inhaber darf alles, sonst nur die genannten Rollen. Die Matrix steht in lib/auth.ts. */
export function roleAllows(role: string, allowed: readonly string[]) {
  return role === "OWNER" || allowed.includes(role);
}

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

export const INVOICE_STATUS = { DRAFT: "Entwurf", FINALIZED: "Abgeschlossen", CANCELLED: "Storniert", CREDITED: "Gutgeschrieben" } as const;
export const INVOICE_ITEM_SOURCES = { RENTAL: "Fahrzeugmiete laut Vertrag", EXTRA_CHARGE: "Bestätigte Zusatzkosten der Rückgabe", MANUAL: "Manuell erfasst" } as const;
export const INVOICE_UNITS = ["pauschal", "Tag", "km", "l", "kWh", "h", "Stk"] as const;

// Phase 9: Zahlungen und Kaution. CARD und BANK_TRANSFER heißen nur: außerhalb von Rent-Base ausgeführt und hier dokumentiert.
export const PAYMENT_METHODS = { CASH: "Barzahlung", CARD: "Kartenzahlung (extern)", BANK_TRANSFER: "Überweisung (extern)", OTHER: "Sonstige" } as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;
export const PAYMENT_TYPES = { INVOICE_PAYMENT: "Rechnungszahlung", OTHER_PAYMENT: "Sonstige Zahlung" } as const;
export const PAYMENT_STATUS = { CONFIRMED: "Bestätigt", CANCELLED: "Storniert" } as const;
/** Zahlungsstatus einer Rechnung, abgeleitet aus bestätigten Zahlungen; nie gespeichert. */
export const INVOICE_PAYMENT_STATUS = { OPEN: "Offen", PARTIAL: "Teilbezahlt", PAID: "Bezahlt", OVERPAID: "Überzahlt – Erstattung zu klären" } as const;
export const INVOICE_VERSION_KINDS = { ORIGINAL: "Original", REVISION: "Neufassung", CORRECTION: "Berichtigung" } as const;
export type InvoicePaymentStatus = keyof typeof INVOICE_PAYMENT_STATUS;
export const DEPOSIT_STATUS = { EXPECTED: "Noch nicht erhalten", RECEIVED: "Erhalten", PARTIALLY_RELEASED: "Teilweise freigegeben", RELEASED: "Freigegeben", RETAINED: "Einbehalten" } as const;
export type DepositStatus = keyof typeof DEPOSIT_STATUS;
export const DEPOSIT_EVENT_TYPES = { RECEIVED: "Erhalten", RELEASED: "Freigegeben", RETAINED: "Einbehalten" } as const;
export type DepositEventType = keyof typeof DEPOSIT_EVENT_TYPES;
export const AUDIT_ACTIONS = {
  PAYMENT_RECORDED: "Zahlung erfasst",
  PAYMENT_CANCELLED: "Zahlung storniert",
  DEPOSIT_RECEIVED: "Kaution erhalten",
  DEPOSIT_RELEASED: "Kaution vollständig freigegeben",
  DEPOSIT_PARTIALLY_RELEASED: "Kaution teilweise freigegeben",
  DEPOSIT_RETAINED: "Kaution einbehalten",
  DEPOSIT_CORRECTION: "Kautionsbewegung storniert",
  INVOICE_VERSION_CREATED: "Rechnungsbearbeitung begonnen",
  INVOICE_REVISED: "Rechnung neu gefasst",
  INVOICE_CORRECTED: "Rechnung berichtigt",
  INVOICE_DELIVERED_MANUALLY: "Rechnung als übergeben markiert",
  DAMAGE_CASE_CREATED: "Schadenakte eröffnet",
  DAMAGE_CASE_STATUS_CHANGED: "Schadenakte: Status geändert",
  DAMAGE_LIABILITY_CHANGED: "Schadenakte: Haftung geändert",
  DAMAGE_COST_CHANGED: "Schadenakte: Kosten geändert",
  DAMAGE_PHOTO_ADDED: "Schadenakte: Foto hinzugefügt",
  DAMAGE_DOCUMENT_ADDED: "Schadenakte: Dokument hinzugefügt",
  VEHICLE_BLOCKED_FOR_DAMAGE: "Fahrzeug wegen Schaden gesperrt",
  VEHICLE_RELEASED_AFTER_DAMAGE: "Fahrzeug nach Schaden freigegeben",
  DAMAGE_CUSTOMER_CHARGE_CREATED: "Kundenbelastung festgelegt",
  DAMAGE_INVOICE_CREATED: "Schadenabrechnung erstellt",
  DAMAGE_CASE_CLOSED: "Schadenakte geschlossen",
  DAMAGE_CASE_REOPENED: "Schadenakte wieder geöffnet",
} as const;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

// Phase 12: Schadenmanagement. Fahrzeugschaden ≠ Haftung ≠ Kundenforderung ≠ Rechnung ≠ Zahlung ≠ Kaution.
export const DAMAGE_CASE_STATUS = { OPEN: "Offen", UNDER_REVIEW: "In Prüfung", REPAIR_PLANNED: "Reparatur geplant", IN_REPAIR: "In Reparatur", REPAIRED: "Repariert", CLOSED: "Geschlossen" } as const;
export type DamageCaseStatus = keyof typeof DAMAGE_CASE_STATUS;
export const DAMAGE_CASE_TRANSITIONS: Record<DamageCaseStatus, DamageCaseStatus[]> = {
  OPEN: ["UNDER_REVIEW", "REPAIR_PLANNED", "CLOSED"],
  UNDER_REVIEW: ["OPEN", "REPAIR_PLANNED", "IN_REPAIR", "CLOSED"],
  REPAIR_PLANNED: ["UNDER_REVIEW", "IN_REPAIR", "CLOSED"],
  IN_REPAIR: ["REPAIR_PLANNED", "REPAIRED", "CLOSED"],
  REPAIRED: ["IN_REPAIR", "CLOSED"],
  CLOSED: [], // Wiederöffnen ist eine eigene Aktion mit Grund
};
export const DAMAGE_CASE_PRIORITY = { LOW: "Niedrig", NORMAL: "Normal", HIGH: "Hoch" } as const;
export type DamageCasePriority = keyof typeof DAMAGE_CASE_PRIORITY;
export const LIABILITY_STATUS = {
  UNASSESSED: "Noch nicht bewertet",
  UNCLEAR: "Unklar",
  CUSTOMER_RESPONSIBILITY_CONFIRMED: "Kunde verantwortlich (bestätigt)",
  NOT_CUSTOMER_RESPONSIBILITY: "Kunde nicht verantwortlich",
  THIRD_PARTY: "Dritter verantwortlich",
  INTERNAL: "Intern (eigener Betrieb)",
} as const;
export type LiabilityStatus = keyof typeof LIABILITY_STATUS;
export const DAMAGE_CASE_DOCUMENT_TYPES = { ESTIMATE: "Kostenvoranschlag", REPAIR_INVOICE: "Werkstattrechnung", OTHER: "Sonstiges" } as const;
export type DamageCaseDocumentType = keyof typeof DAMAGE_CASE_DOCUMENT_TYPES;
export const DAMAGE_CASE_EVENT_TYPES = {
  CREATED: "Akte eröffnet", STATUS_CHANGED: "Status geändert", LIABILITY_CHANGED: "Haftung geändert", COST_CHANGED: "Kosten geändert", REPAIR_CHANGED: "Reparatur geändert",
  PHOTO_ADDED: "Foto hinzugefügt", DOCUMENT_ADDED: "Dokument hinzugefügt", NOTE_ADDED: "Notiz ergänzt", VEHICLE_BLOCKED: "Fahrzeug gesperrt", VEHICLE_RELEASED: "Fahrzeug freigegeben",
  CUSTOMER_CHARGE_CREATED: "Kundenbelastung festgelegt", INVOICE_CREATED: "Schadenabrechnung erstellt", CLOSED: "Akte geschlossen", REOPENED: "Akte wieder geöffnet",
} as const;
export const INVOICE_KINDS = { RENTAL: "Mietrechnung", DAMAGE: "Schadenabrechnung" } as const;
export type InvoiceKind = keyof typeof INVOICE_KINDS;
/**
 * Steuerliche Behandlung einer Kundenbelastung – bewusste Auswahl des Mitarbeiters, keine Vorentscheidung durch Rent-Base
 * (Abschn. 1.3 UStAE: Ausgleich für Beschädigung durch nicht vertragsgemäße Nutzung ist echter Schadensersatz und nicht
 * steuerbar; wird dagegen eine Leistung erbracht oder weiterberechnet, liegt ein steuerpflichtiges Entgelt vor).
 */
export const DAMAGE_TAX_TREATMENTS = {
  NON_TAXABLE_DAMAGE_COMPENSATION: "Echter Schadensersatz – nicht steuerbar",
  TAXABLE_SUPPLY: "Steuerpflichtiges Entgelt – mit Umsatzsteuer",
} as const;
export type DamageTaxTreatment = keyof typeof DAMAGE_TAX_TREATMENTS;
/** Längere Erläuterung zur Auswahl (nur Oberfläche, keine Rechtsberatung). */
export const DAMAGE_TAX_TREATMENT_HELP: Record<DamageTaxTreatment, string> = {
  NON_TAXABLE_DAMAGE_COMPENSATION: "Ausgleich für die Beschädigung der Mietsache, kein Entgelt für eine Leistung. Es wird keine Umsatzsteuer ausgewiesen; die Positionen tragen keinen Steuersatz.",
  TAXABLE_SUPPLY: "Entgelt für eine Leistung oder Weiterberechnung (z. B. vereinbarte Reinigung, Bearbeitungspauschale). Die normale Umsatzsteuerlogik mit Steuersatz, Netto, Umsatzsteuer und Brutto gilt.",
};
/** Hinweistext auf der Schadenabrechnung; bei echtem Schadensersatz fester Bestandteil des Dokuments, sonst leer. */
export const DAMAGE_TAX_NOTES: Record<DamageTaxTreatment, string> = {
  NON_TAXABLE_DAMAGE_COMPENSATION: "Steuerliche Behandlung: Echter Schadensersatz – nicht steuerbar. Der Betrag ist kein Entgelt für eine Leistung und unterliegt nicht der Umsatzsteuer (§ 1 Abs. 1 Nr. 1 UStG, Abschn. 1.3 UStAE). Umsatzsteuer wird nicht ausgewiesen.",
  TAXABLE_SUPPLY: "",
};

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
export function energyRequirements(driveType: string): { fuel: boolean; battery: boolean; chargingGear: boolean } {
  const cls = driveClassOf(driveType);
  return { fuel: cls !== "ELECTRIC", battery: cls !== "COMBUSTION", chargingGear: cls !== "COMBUSTION" };
}

/**
 * Antriebsklasse als einzige Grundlage für Energiefelder, Ladezubehör und Checklistenpunkte.
 * COMBUSTION = Diesel, Benzin, Hybrid ohne Stecker (Tank); ELECTRIC = Batterie und Ladezubehör; PHEV = beides.
 */
export const DRIVE_CLASSES = { COMBUSTION: "Verbrenner", ELECTRIC: "Elektro", PHEV: "Plug-in-Hybrid" } as const;
export type DriveClass = keyof typeof DRIVE_CLASSES;
export function driveClassOf(driveType: string): DriveClass {
  if (driveType === "ELEKTRO") return "ELECTRIC";
  if (driveType === "PLUGIN_HYBRID") return "PHEV";
  return "COMBUSTION";
}

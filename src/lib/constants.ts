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

export const FUEL_POLICIES = { FULL_TO_FULL: "Voll/Voll", SAME_LEVEL: "Gleicher Füllstand", MINIMUM_LEVEL: "Mindestfüllstand bei Rückgabe", INCLUDED: "Kraftstoff inklusive", OTHER: "Individuelle Regelung" } as const;
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
  CREDIT_NOTE: "Gutschrift",
  CANCELLATION: "Stornobeleg",
  PAYOUT_RECEIPT: "Auszahlungsbeleg",
  PAYOUT_ATTACHMENT: "Auszahlungsnachweis",
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;

/** Checklistenpunkte, bei denen "Ja" die Auffälligkeit ist (sonst "Nein" bzw. "Nicht in Ordnung"). */
export const RETURN_ATTENTION_ON_YES = new Set(["unusually_dirty"]);

export const INVOICE_STATUS = { DRAFT: "Entwurf", FINALIZED: "Abgeschlossen", CANCELLED: "Storniert", CREDITED: "Gutgeschrieben" } as const;
// Phase 17: Belegarten. Gutschrift und Stornobeleg sind eigene Belege mit eigener Nummer und Wirkung „Minderung“ auf eine Rechnung.
export const INVOICE_DOCUMENT_TYPES = { INVOICE: "Rechnung", CREDIT_NOTE: "Gutschrift", CANCELLATION: "Stornobeleg" } as const;
export type InvoiceDocumentTypeKey = keyof typeof INVOICE_DOCUMENT_TYPES;
// Stand einer Rechnung aus ihrer Belegkette (abgeleitet, nie gespeichert)
export const INVOICE_CHAIN_STATUS = { NONE: "Keine Gegenbelege", PARTIALLY_CREDITED: "Teilweise gutgeschrieben", CREDITED: "Gutgeschrieben", CANCELLED: "Storniert" } as const;
export type InvoiceChainStatus = keyof typeof INVOICE_CHAIN_STATUS;
export const COUNTER_DOCUMENT_HELP = {
  REVISION: "Berichtigen: Die Rechnung war inhaltlich falsch (Empfänger, Text, Beträge) und bekommt unter derselben Nummer eine neue Fassung. Nur möglich, solange es noch keine Gutschrift und keinen Stornobeleg gibt.",
  CREDIT_NOTE: "Gutschrift: Ein Teil der Forderung oder die ganze Forderung wird dem Kunden erlassen. Eigener Beleg mit eigener Nummer; die Rechnung bleibt unverändert. Mehrere Teilgutschriften sind möglich.",
  CANCELLATION: "Stornieren: Die Rechnung soll insgesamt nicht mehr gelten. Ein Stornobeleg mit eigener Nummer hebt den noch offenen Rest vollständig auf; die Rechnung und ihr PDF bleiben archiviert.",
} as const;
export const INVOICE_ITEM_SOURCES = { RENTAL: "Fahrzeugmiete laut Vertrag", EXTRA_CHARGE: "Bestätigte Zusatzkosten der Rückgabe", MANUAL: "Manuell erfasst" } as const;
export const INVOICE_UNITS = ["pauschal", "Tag", "km", "l", "kWh", "h", "Stk"] as const;

// Phase 9: Zahlungen und Kaution. CARD und BANK_TRANSFER heißen nur: außerhalb von Rent-Base ausgeführt und hier dokumentiert.
export const PAYMENT_METHODS = { CASH: "Barzahlung", CARD: "Kartenzahlung (extern)", BANK_TRANSFER: "Überweisung (extern)", OTHER: "Sonstige" } as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;
// RENTAL_PAYMENT: Mietzahlung vor der Rechnung (an der Buchung erfasst), beim Abschluss der Mietrechnung ihr zugeordnet
export const PAYMENT_TYPES = { INVOICE_PAYMENT: "Rechnungszahlung", OTHER_PAYMENT: "Sonstige Zahlung", RENTAL_PAYMENT: "Mietzahlung" } as const;
/** Mietzahlungsstatus einer Buchung, abgeleitet aus den Mietzahlungen; nie gespeichert. */
export const RENTAL_PAYMENT_STATUS = { OPEN: "Offen", PARTIAL: "Teilweise bezahlt", PAID: "Vollständig bezahlt", OVERPAID: "Überzahlt – Erstattung klären" } as const;
/** Auswahl im Buchungsformular. Gespeichert wird nur die Zahlungsbewegung; der Status wird daraus berechnet. */
export const RENTAL_PAYMENT_INTENTS = { NONE: "Offen", PARTIAL: "Teilweise bezahlt", FULL: "Vollständig bezahlt" } as const;
export type RentalPaymentIntent = keyof typeof RENTAL_PAYMENT_INTENTS;
// Phase 18: Auszahlungen (Geld raus). Rent-Base führt keine Überweisung, Karten- oder Providertransaktion aus; es dokumentiert.
export const PAYOUT_SOURCE_TYPES = { INVOICE_REFUND: "Rechnungserstattung", SECURITY_DEPOSIT_REFUND: "Kautionsrückzahlung" } as const;
export type PayoutSourceType = keyof typeof PAYOUT_SOURCE_TYPES;
export const PAYOUT_STATUS = { DRAFT: "Entwurf", COMPLETED: "Ausgezahlt", CANCELLED: "Storniert" } as const;
export type PayoutStatus = keyof typeof PAYOUT_STATUS;
export const PAYOUT_METHODS = { BANK_TRANSFER: "Überweisung (extern ausgeführt)", CASH: "Barauszahlung", CARD: "Kartenrückbuchung (extern ausgeführt)", OTHER: "Sonstiger Weg" } as const;
export type PayoutMethod = keyof typeof PAYOUT_METHODS;
export const PAYOUT_HELP = {
  REVERSAL: "Zahlung stornieren: Eine Zahlung wurde falsch erfasst (z. B. es ist nie Geld geflossen). Die Zahlung zählt danach nicht mehr; es fließt kein Geld.",
  REFUND: "Erstattung erfassen: Der Kunde hat tatsächlich gezahlt und bekommt später Geld zurück (z. B. nach einer Gutschrift). Die Zahlung bleibt unverändert; die Auszahlung wird als eigener Vorgang dokumentiert.",
  DEPOSIT: "Kautionsfreigabe ist die Entscheidung, Kautionsauszahlung der tatsächliche Geldfluss. Beides wird getrennt dokumentiert; Rent-Base verrechnet nichts automatisch.",
} as const;
export const PAYMENT_STATUS = { CONFIRMED: "Bestätigt", CANCELLED: "Storniert" } as const;
/** Zahlungsstatus einer Rechnung, abgeleitet aus bestätigten Zahlungen; nie gespeichert. */
export const INVOICE_PAYMENT_STATUS = { OPEN: "Offen", PARTIAL: "Teilbezahlt", PAID: "Bezahlt", OVERPAID: "Bezahlt – Erstattung erforderlich" } as const;
export const INVOICE_VERSION_KINDS = { ORIGINAL: "Original", REVISION: "Neufassung", CORRECTION: "Berichtigung" } as const;
export type InvoicePaymentStatus = keyof typeof INVOICE_PAYMENT_STATUS;
export const DEPOSIT_STATUS = { EXPECTED: "Noch nicht erhalten", RECEIVED: "Erhalten", PARTIALLY_RELEASED: "Teilweise freigegeben", RELEASED: "Freigegeben", RETAINED: "Einbehalten" } as const;
export type DepositStatus = keyof typeof DEPOSIT_STATUS;
export const DEPOSIT_EVENT_TYPES = { RECEIVED: "Erhalten", RELEASED: "Freigegeben", RETAINED: "Einbehalten" } as const;
export type DepositEventType = keyof typeof DEPOSIT_EVENT_TYPES;
export const AUDIT_ACTIONS = {
  PAYMENT_RECORDED: "Zahlung erfasst",
  PAYMENT_CANCELLED: "Zahlung storniert",
  RENTAL_PAYMENTS_LINKED: "Mietzahlungen der Mietrechnung zugeordnet",
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
  MAINTENANCE_PLAN_CREATED: "Wartungsplan angelegt",
  MAINTENANCE_PLAN_UPDATED: "Wartungsplan geändert",
  MAINTENANCE_CREATED: "Wartungsvorgang angelegt",
  MAINTENANCE_UPDATED: "Wartungsvorgang geändert",
  MAINTENANCE_SCHEDULED: "Werkstatttermin gesetzt",
  MAINTENANCE_STARTED: "Wartungsvorgang begonnen",
  MAINTENANCE_COMPLETED: "Wartungsvorgang erledigt",
  MAINTENANCE_CANCELLED: "Wartungsvorgang abgebrochen",
  MAINTENANCE_DOCUMENT_ADDED: "Wartungsdokument hinzugefügt",
  MAINTENANCE_COST_CHANGED: "Wartungskosten geändert",
  MAINTENANCE_DAMAGE_LINKED: "Wartungsvorgang mit Schadenakte verknüpft",
  VEHICLE_BLOCKED_FOR_MAINTENANCE: "Fahrzeug für Wartung gesperrt",
  VEHICLE_RELEASED_AFTER_MAINTENANCE: "Fahrzeug nach Wartung freigegeben",
  VEHICLE_DOCUMENT_ADDED: "Fahrzeugdokument hinzugefügt",
  VEHICLE_DOCUMENT_ARCHIVED: "Fahrzeugdokument archiviert",
  MAINTENANCE_COSTS_ADOPTED: "Reparaturkosten in Schadenakte übernommen",
  AUTHORITY_CASE_CREATED: "Behördenvorgang angelegt",
  AUTHORITY_CASE_UPDATED: "Behördenvorgang geändert",
  AUTHORITY_DOCUMENT_ADDED: "Behördendokument hinzugefügt",
  AUTHORITY_DOCUMENT_ARCHIVED: "Behördendokument archiviert",
  AUTHORITY_CASE_ASSIGNED_TO_VEHICLE: "Behördenvorgang Fahrzeug zugeordnet",
  AUTHORITY_CASE_ASSIGNED_TO_BOOKING: "Behördenvorgang Vermietung zugeordnet",
  AUTHORITY_DRIVER_SELECTED: "Behördenvorgang Fahrer bestimmt",
  AUTHORITY_DRIVER_CHANGED: "Behördenvorgang Fahrerbestimmung geändert",
  AUTHORITY_RESPONSE_CREATED: "Behördenantwort erstellt",
  AUTHORITY_RESPONSE_APPROVED: "Behördenantwort freigegeben",
  AUTHORITY_RESPONSE_SUBMITTED: "Behördenantwort übermittelt",
  AUTHORITY_SUBMISSION_FAILED: "Behördenübermittlung fehlgeschlagen",
  AUTHORITY_SUBMISSION_RECEIPT_ADDED: "Übermittlungsnachweis hinzugefügt",
  AUTHORITY_CASE_CLOSED: "Behördenvorgang abgeschlossen",
  AUTHORITY_CASE_REOPENED: "Behördenvorgang wieder geöffnet",
  AUTHORITY_CASE_CANCELLED: "Behördenvorgang storniert",
  DAMAGE_CASE_CLOSED: "Schadenakte geschlossen",
  DAMAGE_CASE_REOPENED: "Schadenakte wieder geöffnet",
  RENTAL_TERMS_DRAFT_CREATED: "Mietbedingungen: Entwurf angelegt",
  RENTAL_TERMS_UPDATED: "Mietbedingungen: Entwurf geändert",
  RENTAL_TERMS_PUBLISHED: "Mietbedingungen: Fassung veröffentlicht",
  RENTAL_TERMS_ARCHIVED: "Mietbedingungen: Fassung archiviert",
  RENTAL_TERMS_NEW_VERSION_CREATED: "Mietbedingungen: neue Fassung aus veröffentlichter erstellt",
  RENTAL_TERMS_DRAFT_DISCARDED: "Mietbedingungen: Entwurf verworfen",
  DRIVER_VERIFICATION_STARTED: "Fahrerprüfung begonnen",
  DRIVER_IDENTITY_VERIFIED: "Fahrer: Identität geprüft",
  DRIVER_LICENSE_VERIFIED: "Fahrer: Führerschein geprüft",
  DRIVER_VERIFICATION_COMPLETED: "Fahrerprüfung bestätigt",
  DRIVER_VERIFICATION_BLOCKED: "Fahrerprüfung blockiert",
  DRIVER_VERIFICATION_SUPERSEDED: "Fahrerprüfung: neue Fassung",
  DOCUMENT_COPY_CONSENT_RECORDED: "Dokumentkopie: Zustimmung dokumentiert",
  DRIVER_DOCUMENT_UPLOADED: "Dokumentkopie gespeichert",
  DRIVER_DOCUMENT_VIEWED: "Dokumentkopie angezeigt",
  DRIVER_DOCUMENT_DELETED: "Dokumentkopie gelöscht",
  CUSTOMER_LICENSE_UPDATED_FROM_VERIFICATION: "Kundenstammdaten: Führerschein aus Prüfung übernommen",
  BUSINESS_RULES_UPDATED: "Geschäftsregeln geändert",
  CONTRACT_TERMS_SELECTED: "Vertrag: Mietbedingungen-Fassung zugeordnet",
  CONTRACT_TERMS_ACKNOWLEDGED: "Vertrag: Mietbedingungen zur Kenntnis genommen",
  CONTRACT_BUSINESS_RULE_OVERRIDDEN: "Vertrag: Geschäftsregel individuell angepasst",
  CONTRACT_DEFAULTS_ADOPTED: "Vertrag: aktuelle Standardwerte übernommen",
  CREDIT_NOTE_DRAFT_CREATED: "Gutschrift: Entwurf angelegt",
  CREDIT_NOTE_DRAFT_DISCARDED: "Gutschrift: Entwurf verworfen",
  CREDIT_NOTE_FINALIZED: "Gutschrift abgeschlossen",
  CREDIT_NOTE_SENT: "Gutschrift versendet",
  CANCELLATION_DRAFT_CREATED: "Stornobeleg: Entwurf angelegt",
  CANCELLATION_DRAFT_DISCARDED: "Stornobeleg: Entwurf verworfen",
  CANCELLATION_FINALIZED: "Stornobeleg abgeschlossen",
  CANCELLATION_SENT: "Stornobeleg versendet",
  NUMBER_RANGES_UPDATED: "Nummernkreise geändert",
  PAYOUT_DRAFT_CREATED: "Auszahlung: Entwurf angelegt",
  PAYOUT_UPDATED: "Auszahlung: Entwurf geändert",
  PAYOUT_COMPLETED: "Auszahlung als erfolgt erfasst",
  PAYOUT_CANCELLED: "Auszahlung storniert",
  PAYOUT_DOCUMENT_UPLOADED: "Auszahlung: Nachweis hochgeladen",
  PAYOUT_DOCUMENT_ARCHIVED: "Auszahlung: Beleg archiviert",
  PAYOUT_EMAIL_SENT: "Auszahlungsbeleg versendet",
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
// Phase 19.5: Fahreridentifikation und Führerscheinprüfung bei der Übergabe.
/** Fahrerlaubnisklassen nach § 6 Abs. 1 FeV (Stand 2026). Weitere Klassen sind additiv möglich; keine Rechts-Engine. */
export const LICENSE_CLASSES = { AM: "AM", A1: "A1", A2: "A2", A: "A", B: "B", BE: "BE", C1: "C1", C1E: "C1E", C: "C", CE: "CE", D1: "D1", D1E: "D1E", D: "D", DE: "DE", T: "T", L: "L" } as const;
export type LicenseClass = keyof typeof LICENSE_CLASSES;
/** § 6 Abs. 3 FeV: welche Klasse zusätzlich zum Führen welcher Klassen berechtigt (nur die dort genannten Einschlüsse). */
export const LICENSE_CLASS_IMPLIES: Record<LicenseClass, readonly LicenseClass[]> = {
  AM: [], A1: ["AM"], A2: ["A1", "AM"], A: ["A2", "A1", "AM"], B: ["AM", "L"], BE: [], C1: [], C1E: ["BE"], C: ["C1"], CE: ["C1E", "BE", "T"], D1: [], D1E: ["BE"], D: ["D1"], DE: ["D1E", "BE"], T: ["AM", "L"], L: [],
};
export const IDENTITY_DOCUMENT_TYPES = { PERSONALAUSWEIS: "Personalausweis", REISEPASS: "Reisepass", SONSTIGER_AMTLICHER_LICHTBILDAUSWEIS: "Sonstiger amtlicher Lichtbildausweis" } as const;
export type IdentityDocumentType = keyof typeof IDENTITY_DOCUMENT_TYPES;
export const DRIVER_VERIFICATION_STATUS = { NOT_STARTED: "Nicht geprüft", IN_PROGRESS: "In Prüfung", CONFIRMED: "Bestätigt", BLOCKED: "Blockiert" } as const;
export type DriverVerificationStatus = keyof typeof DRIVER_VERIFICATION_STATUS;
export const DRIVER_DOCUMENT_KINDS = { IDENTITY: "Ausweiskopie", LICENSE: "Führerscheinkopie" } as const;
export type DriverDocumentKind = keyof typeof DRIVER_DOCUMENT_KINDS;
export const DRIVER_DOCUMENT_SIDES = { FRONT: "Vorderseite", BACK: "Rückseite" } as const;
/** EU/EWR-Staaten und Schweiz: Führerscheine dieser Staaten gelten nach § 29 FeV ohne Übersetzung; alle anderen brauchen die bewusste manuelle Prüfung. */
export const EU_EEA_CH_COUNTRIES = ["DE", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "CH"] as const;
export const DRIVER_COPY_PURPOSE = "Nachweis der Fahrer- und Fahrerlaubnisprüfung zum Vermietvorgang (Mietvertrag); keine Weitergabe an Dritte.";
export const DRIVER_VERIFICATION_HELP = {
  ORIGINAL: "Pflicht ist die dokumentierte Prüfung des Originaldokuments. Eine gespeicherte Kopie ersetzt die Prüfung nicht und ist für den Abschluss der Übergabe nicht erforderlich.",
  ID_CONSENT: "Für die Speicherung einer Personalausweiskopie ist die Zustimmung des Ausweisinhabers erforderlich (§ 20 Abs. 2 PAuswG). Die Kopie wird dauerhaft als Kopie gekennzeichnet.",
  LICENSE_COPY: "Eine Führerscheinkopie ist freiwillig. Sie dient nur dem Nachweis der Prüfung zu diesem Vermietvorgang und wird dauerhaft als Kopie gekennzeichnet.",
  FOREIGN: "Rent-Base beurteilt nicht automatisch die rechtliche Gültigkeit ausländischer Fahrerlaubnisse. Ausstellungsstaat, Dokument, Klassen und Gültigkeit werden erfasst; die Freigabe ist eine bewusste manuelle Entscheidung.",
} as const;

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
  MAINTENANCE_COMPLETED: "Wartung / Werkstatt erledigt",
} as const;

// Phase 13: Flotten- und Wartungsmanagement. Warnung ≠ Sperre; Kosten ≠ Kundenforderung.
export const MAINTENANCE_TYPES = {
  INSPECTION: "Inspektion",
  OIL_SERVICE: "Ölservice",
  HU_AU: "HU/AU",
  TIRES: "Reifen",
  BRAKES: "Bremsen",
  REPAIR: "Reparatur",
  DAMAGE_REPAIR: "Schadenreparatur",
  AIR_CONDITIONING: "Klimaservice",
  OTHER: "Sonstiges",
} as const;
export type MaintenanceType = keyof typeof MAINTENANCE_TYPES;
export const MAINTENANCE_STATUS = { PLANNED: "Geplant", SCHEDULED: "Werkstatttermin", IN_PROGRESS: "In Arbeit", COMPLETED: "Erledigt", CANCELLED: "Abgebrochen" } as const;
export type MaintenanceStatus = keyof typeof MAINTENANCE_STATUS;
/** Zentrale Übergänge; Abschluss und Abbruch sind eigene Aktionen mit Pflichtangaben. */
export const MAINTENANCE_TRANSITIONS: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  PLANNED: ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"],
  SCHEDULED: ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["SCHEDULED", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
export const MAINTENANCE_PRIORITY = { LOW: "Niedrig", NORMAL: "Normal", HIGH: "Hoch", CRITICAL: "Kritisch" } as const;
export type MaintenancePriority = keyof typeof MAINTENANCE_PRIORITY;
export const MAINTENANCE_EVENT_TYPES = {
  CREATED: "Vorgang angelegt", UPDATED: "Vorgang geändert", SCHEDULED: "Termin gesetzt", STARTED: "In Arbeit", COMPLETED: "Erledigt", CANCELLED: "Abgebrochen",
  COST_CHANGED: "Kosten geändert", DOCUMENT_ADDED: "Dokument hinzugefügt", DOCUMENT_LINKED: "Dokument aus Schadenakte verknüpft", DOCUMENT_ARCHIVED: "Dokument archiviert",
  DAMAGE_LINKED: "Schadenakte verknüpft", NOTE_ADDED: "Notiz ergänzt", VEHICLE_BLOCKED: "Fahrzeug für Wartung gesperrt", VEHICLE_RELEASED: "Fahrzeug freigegeben", MILEAGE: "Kilometerstand dokumentiert",
} as const;
export const VEHICLE_DOCUMENT_TYPES = {
  REGISTRATION: "Zulassung",
  INSURANCE: "Versicherung",
  HU_REPORT: "HU-Bericht",
  INSPECTION_REPORT: "Inspektionsbericht",
  WORKSHOP_INVOICE: "Werkstattrechnung",
  ESTIMATE: "Kostenvoranschlag",
  REPAIR_REPORT: "Reparaturbericht",
  TIRE_DOCUMENT: "Reifenunterlage",
  OTHER: "Sonstiges",
} as const;
export type VehicleDocumentType = keyof typeof VEHICLE_DOCUMENT_TYPES;
// Phase 14: Behördenvorgänge. Vertraglicher Fahrer ≠ nachgewiesener Fahrzeugführer; Antworten nur nach ausdrücklicher Freigabe.
export const AUTHORITY_CASE_TYPES = {
  SPEEDING: "Geschwindigkeitsverstoß",
  PARKING: "Parkverstoß",
  RED_LIGHT: "Rotlichtverstoß",
  TOLL: "Maut",
  TRAFFIC_VIOLATION: "Sonstiger Verkehrsverstoß",
  DRIVER_IDENTIFICATION: "Fahrerermittlung",
  AUTHORITY_REQUEST: "Behördenanfrage",
  OTHER: "Sonstiges",
} as const;
export type AuthorityCaseType = keyof typeof AUTHORITY_CASE_TYPES;
export const AUTHORITY_CASE_STATUS = {
  RECEIVED: "Neu",
  ASSIGNMENT_REQUIRED: "Zuordnung erforderlich",
  REVIEW_REQUIRED: "Prüfung erforderlich",
  RESPONSE_PREPARED: "Antwort vorbereitet",
  READY_TO_SEND: "Versandbereit",
  SUBMITTED: "Übermittelt",
  CLOSED: "Abgeschlossen",
  CANCELLED: "Storniert",
} as const;
export type AuthorityCaseStatus = keyof typeof AUTHORITY_CASE_STATUS;
export const VEHICLE_MATCH = { UNMATCHED: "Noch nicht geprüft", EXACT_MATCH: "Eindeutig zugeordnet", NO_MATCH: "Kein Fahrzeug in der Flotte", AMBIGUOUS: "Mehrere Fahrzeuge möglich", MANUALLY_ASSIGNED: "Manuell zugeordnet" } as const;
export const RENTAL_MATCH = { UNMATCHED: "Noch nicht geprüft", ACTUAL_PERIOD: "Tatzeit innerhalb der tatsächlichen Mietdauer", PLANNED_PERIOD: "Nur anhand geplanter Buchungszeit zugeordnet", AMBIGUOUS: "Mehrere Vermietungen möglich", NONE: "Keine eindeutige Vermietung gefunden", MANUALLY_ASSIGNED: "Manuell zugeordnet" } as const;
export const ASSIGNMENT_STATUS = { UNASSIGNED: "Nicht zugeordnet", VEHICLE_ONLY: "Nur Fahrzeug zugeordnet", ASSIGNED: "Vermietung zugeordnet", NO_MATCH: "Keine Zuordnung möglich" } as const;
export const DRIVER_DETERMINATION = {
  UNDETERMINED: "Noch nicht bestimmt",
  CONTRACT_DRIVER_SELECTED: "Vertragsfahrer bestimmt",
  OTHER_DRIVER_ENTERED: "Andere Person erfasst",
  NOT_IDENTIFIABLE: "Fahrer nicht eindeutig feststellbar",
  NO_DRIVER_INFORMATION: "Keine Fahrerinformation",
} as const;
export type DriverDetermination = keyof typeof DRIVER_DETERMINATION;
export const AUTHORITY_RESPONSE_TYPES = {
  DRIVER_IDENTIFIED: "Fahrer benannt",
  MULTIPLE_POSSIBLE_DRIVERS: "Mehrere mögliche Fahrer",
  DRIVER_NOT_IDENTIFIABLE: "Fahrer nicht eindeutig feststellbar",
  NO_MATCHING_RENTAL: "Keine passende Vermietung",
  VEHICLE_NOT_IN_FLEET: "Fahrzeug nicht in der Flotte",
  CUSTOM_RESPONSE: "Individuelle Antwort",
} as const;
export type AuthorityResponseType = keyof typeof AUTHORITY_RESPONSE_TYPES;
export const AUTHORITY_RESPONSE_STATUS = { DRAFT: "Entwurf", APPROVED: "Freigegeben", SUBMITTED: "Übermittelt", FAILED: "Übermittlung fehlgeschlagen", SUPERSEDED: "Ersetzt" } as const;
export const SUBMISSION_METHODS = { MANUAL_PORTAL: "Behördenportal (manuell)", POST: "Post", EMAIL: "E-Mail", VERIFIED_API: "Verifizierte Schnittstelle", OTHER: "Sonstiger Weg" } as const;
export type SubmissionMethod = keyof typeof SUBMISSION_METHODS;
export const AUTHORITY_DOCUMENT_TYPES = { INCOMING_NOTICE: "Behördenschreiben", EVIDENCE: "Nachweis/Beweismittel", RESPONSE_DRAFT: "Antwortentwurf", RESPONSE_PDF: "Antwort (PDF)", SUBMISSION_RECEIPT: "Übermittlungsnachweis", CORRESPONDENCE: "Schriftwechsel", OTHER: "Sonstiges" } as const;
export type AuthorityDocumentType = keyof typeof AUTHORITY_DOCUMENT_TYPES;
export const AUTHORITY_EVENT_TYPES = {
  CREATED: "Vorgang angelegt", UPDATED: "Daten geändert", DOCUMENT_ADDED: "Dokument hinzugefügt", DOCUMENT_ARCHIVED: "Dokument archiviert", VEHICLE_MATCHED: "Fahrzeug zugeordnet", RENTAL_MATCHED: "Vermietung zugeordnet",
  DRIVER_SELECTED: "Fahrer bestimmt", DRIVER_CHANGED: "Fahrerbestimmung geändert", RESPONSE_CREATED: "Antwortfassung erstellt", RESPONSE_APPROVED: "Antwort freigegeben", RESPONSE_SUBMITTED: "Antwort übermittelt", SUBMISSION_FAILED: "Übermittlung fehlgeschlagen",
  RECEIPT_ADDED: "Übermittlungsnachweis hinzugefügt", CLOSED: "Vorgang abgeschlossen", REOPENED: "Vorgang wieder geöffnet", CANCELLED: "Vorgang storniert", NOTE_ADDED: "Notiz ergänzt", STATUS_CHANGED: "Status geändert",
} as const;
export const AUTHORITY_DRIVER_NOTICE = "Bitte bestätigen Sie nur eine Person als Fahrer, wenn Ihnen hierfür eine ausreichende Grundlage vorliegt. Die Zuordnung einer Vermietung allein weist nicht nach, wer das Fahrzeug zum Tatzeitpunkt geführt hat.";

/** Berechneter Warnstand einer Fälligkeit – nie gespeichert. */
export const DUE_LEVELS = { OK: "In Ordnung", SOON: "Bald fällig", DUE: "Fällig", OVERDUE: "Überfällig" } as const;
export type DueLevel = keyof typeof DUE_LEVELS;
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

// ---------------------------------------------------------------------------
// Phase 15: Mietbedingungen (versioniert) und Geschäftsregeln
// ---------------------------------------------------------------------------
export const TERMS_STATUS = { DRAFT: "Entwurf", PUBLISHED: "Veröffentlicht", ARCHIVED: "Archiviert" } as const;
export type TermsStatus = keyof typeof TERMS_STATUS;
export const KM_POLICIES = { UNLIMITED: "Unbegrenzte Kilometer", FREE_KILOMETERS: "Freikilometer je Tag, Mehrkilometer nach Preis", INDIVIDUAL: "Individuelle Kilometerregel" } as const;
export type KmPolicy = keyof typeof KM_POLICIES;
export const PETS_POLICIES = { ALLOWED: "Erlaubt", NOT_ALLOWED: "Nicht erlaubt", BY_APPROVAL: "Nur nach Absprache" } as const;
export type PetsPolicy = keyof typeof PETS_POLICIES;
export const LATE_RETURN_RULES = { MANUAL: "Manuelle Bearbeitung durch Mitarbeiter", ADDITIONAL_RENTAL_TIME: "Zusätzliche Mietzeit nach Vertragspreis (manuell bestätigt)", CONFIGURED_FEE: "Hinterlegter Richtwert (manuell bestätigt)", INDIVIDUAL: "Individuelle Regelung" } as const;
export type LateReturnRule = keyof typeof LATE_RETURN_RULES;
export const OUT_OF_HOURS_RETURN = { ALLOWED: "Erlaubt", NOT_ALLOWED: "Nicht erlaubt", BY_AGREEMENT: "Nach Vereinbarung" } as const;
export type OutOfHoursReturn = keyof typeof OUT_OF_HOURS_RETURN;
export const ADDITIONAL_DRIVER_FEE_TYPES = { FREE: "Kostenlos", FLAT: "Pauschal je Zusatzfahrer", PER_DAY: "Je Zusatzfahrer und Miettag" } as const;
export type AdditionalDriverFeeType = keyof typeof ADDITIONAL_DRIVER_FEE_TYPES;
export const RULE_SOURCES = { DEFAULT: "Systemvorgabe", TENANT: "Standard des Vermieters", GROUP: "Fahrzeuggruppe", VEHICLE: "Fahrzeug", BOOKING: "Buchung", CONTRACT: "Individuell angepasst" } as const;
export type RuleSource = keyof typeof RULE_SOURCES;
/** Pflichtformulierung der Kenntnisnahme; {version} wird durch die Fassung ersetzt. */
export const TERMS_ACKNOWLEDGEMENT_TEXT = "Die Mietbedingungen Version {version} wurden zur Kenntnisnahme bereitgestellt und sind Bestandteil dieses Mietvertrags.";
export const TERMS_TEMPLATE_NOTICE = "Mustertext – vor Verwendung rechtlich prüfen";

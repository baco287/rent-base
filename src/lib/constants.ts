// Feste Wertelisten. In der Datenbank als String abgelegt (SQLite), hier die erlaubten Werte und Labels.

export const ROLES = {
  OWNER: "Inhaber",
  DISPO: "Disponent",
  YARD: "Hofmitarbeiter",
} as const;
export type Role = keyof typeof ROLES;

export const VEHICLE_CATEGORIES = {
  TRANSPORTER: "Transporter",
  KOMPAKT: "Kompakt",
  KOMBI: "Kombi",
  LIMOUSINE: "Limousine",
  SUV: "SUV",
  KLEINBUS: "Kleinbus",
  SONSTIGE: "Sonstige",
} as const;
export type VehicleCategory = keyof typeof VEHICLE_CATEGORIES;

export const FUELS = {
  DIESEL: "Diesel",
  BENZIN: "Benzin",
  ELEKTRO: "Elektro",
  HYBRID: "Hybrid",
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

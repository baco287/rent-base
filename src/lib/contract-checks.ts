// Prüfregeln für Mieter, Fahrer und Vertrag. Reine Funktionen ohne Datenbankzugriff.
// Der Server ruft sie beim Anzeigen jedes Schritts und verbindlich beim Finalisieren auf.
// Die Oberfläche zeigt dieselben Ergebnisse nur an; sie entscheidet nichts.

export type Issue = {
  code: string;
  area: "CUSTOMER" | "DRIVER" | "ADDITIONAL_DRIVER" | "VEHICLE" | "PERIOD" | "PRICE" | "CONDITIONS" | "SIGNATURE";
  severity: "error" | "warning";
  message: string;
};

const has = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";
const asDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const fmt = (d: Date) => d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

export type CustomerLike = {
  type?: string | null;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: Date | string | null;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  idType?: string | null;
  idNumber?: string | null;
  idValidUntil?: Date | string | null;
  blocked?: boolean | null;
  blockReason?: string | null;
};

/** Pflichtangaben des Mieters für einen Vertrag. */
export function checkCustomer(c: CustomerLike, startAt: Date): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string) => issues.push({ code, area: "CUSTOMER", severity: "error", message });
  const warn = (code: string, message: string) => issues.push({ code, area: "CUSTOMER", severity: "warning", message });

  if (c.blocked) err("CUSTOMER_BLOCKED", `Der Kunde ist gesperrt${has(c.blockReason) ? `: ${c.blockReason}` : ""}. Ein Vertrag kann erst nach Aufheben der Sperre abgeschlossen werden.`);
  if (c.type === "COMPANY" && !has(c.companyName)) err("CUSTOMER_COMPANY", "Firmenname fehlt.");
  if (!has(c.firstName)) err("CUSTOMER_FIRSTNAME", "Vorname des Mieters fehlt.");
  if (!has(c.lastName)) err("CUSTOMER_LASTNAME", "Nachname des Mieters fehlt.");
  if (!asDate(c.birthDate)) err("CUSTOMER_BIRTHDATE", "Geburtsdatum des Mieters fehlt.");
  if (!has(c.street)) err("CUSTOMER_STREET", "Straße und Hausnummer des Mieters fehlen.");
  if (!has(c.zip)) err("CUSTOMER_ZIP", "Postleitzahl des Mieters fehlt.");
  if (!has(c.city)) err("CUSTOMER_CITY", "Ort des Mieters fehlt.");
  if (!has(c.country)) err("CUSTOMER_COUNTRY", "Land des Mieters fehlt.");
  if (!has(c.phone) && !has(c.email)) err("CUSTOMER_CONTACT", "Telefonnummer oder E-Mail des Mieters fehlt.");
  else {
    if (!has(c.phone)) warn("CUSTOMER_PHONE", "Keine Telefonnummer hinterlegt.");
    if (!has(c.email)) warn("CUSTOMER_EMAIL", "Keine E-Mail hinterlegt. Vertrag und Protokolle können dann nicht per E-Mail zugestellt werden.");
  }
  if (!has(c.idNumber)) err("CUSTOMER_ID", "Ausweisnummer des Mieters fehlt.");
  const idValid = asDate(c.idValidUntil);
  if (has(c.idNumber) && !idValid) warn("CUSTOMER_ID_VALIDITY", "Gültigkeit des Ausweises ist nicht erfasst.");
  if (idValid && idValid < startAt) err("CUSTOMER_ID_EXPIRED", `Der Ausweis ist am Mietbeginn abgelaufen (gültig bis ${fmt(idValid)}).`);
  return issues;
}

export type DriverLike = {
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: Date | string | null;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  licenseNumber?: string | null;
  licenseClass?: string | null;
  licenseIssuedAt?: Date | string | null;
  licenseValidUntil?: Date | string | null;
  licenseCountry?: string | null;
};

/** Führerschein- und Personendaten eines Fahrers. who steht in der Meldung, z. B. "Fahrer" oder "Zusatzfahrer Max Zusatz". */
export function checkDriver(d: DriverLike, startAt: Date, who = "Fahrer", area: Issue["area"] = "DRIVER"): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string) => issues.push({ code, area, severity: "error", message });

  if (!has(d.firstName) || !has(d.lastName)) err("DRIVER_NAME", `${who}: Vor- und Nachname fehlen.`);
  const birth = asDate(d.birthDate);
  if (!birth) err("DRIVER_BIRTHDATE", `${who}: Geburtsdatum fehlt.`);
  if (!has(d.street) || !has(d.zip) || !has(d.city)) err("DRIVER_ADDRESS", `${who}: Adresse ist unvollständig.`);
  if (!has(d.licenseNumber)) err("LICENSE_NUMBER", `${who}: Führerscheinnummer fehlt.`);
  if (!has(d.licenseClass)) err("LICENSE_CLASS", `${who}: Führerscheinklasse fehlt.`);
  const issued = asDate(d.licenseIssuedAt);
  if (!issued) err("LICENSE_ISSUED", `${who}: Ausstellungsdatum des Führerscheins fehlt.`);
  const valid = asDate(d.licenseValidUntil);
  if (!valid) err("LICENSE_VALIDITY", `${who}: Ablaufdatum des Führerscheins fehlt.`);
  if (valid && valid < startAt) err("LICENSE_EXPIRED", `${who}: Der Führerschein ist am Mietbeginn abgelaufen (gültig bis ${fmt(valid)}).`);
  if (issued && issued > startAt) err("LICENSE_NOT_YET_VALID", `${who}: Der Führerschein wurde erst nach dem Mietbeginn ausgestellt.`);
  if (birth && issued && issued < birth) err("LICENSE_BEFORE_BIRTH", `${who}: Ausstellungsdatum liegt vor dem Geburtsdatum.`);
  if (birth) {
    const age = (startAt.getTime() - birth.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 18) err("DRIVER_UNDERAGE", `${who} ist am Mietbeginn noch nicht 18 Jahre alt.`);
  }
  if (!has(d.licenseCountry)) err("LICENSE_COUNTRY", `${who}: Ausstellungsland des Führerscheins fehlt.`);
  return issues;
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === "error");
export const errorsOf = (issues: Issue[]) => issues.filter((i) => i.severity === "error");

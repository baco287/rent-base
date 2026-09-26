// Massenimport von Kundenstammdaten aus einer Alt-Software (CSV/Excel), damit Vermieter beim Wechsel nicht jeden
// Kunden neu anlegen müssen. Läuft ausschließlich serverseitig (Datei-Parsing, Validierung, Anlage). Wiederverwendet
// dieselbe Validierung wie das Kundenformular (customerSchema/customerToData) – eine Kundenerfassung, jetzt auch aus
// einer Tabelle. Jede Zeile wird einzeln und sequenziell angelegt (keine Parallelität), damit die fortlaufende
// Kundennummer nicht kollidiert; withNumberRetry sichert zusätzlich gegen gleichzeitige Anlagen aus der Oberfläche ab.
import { db } from "@/lib/db";
import { customerSchema, customerToData } from "@/lib/customer-schema";
import { nextCustomerNumber, withNumberRetry } from "@/lib/numbering";

export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

export type ImportFieldKey =
  | "legacyNumber" | "type" | "companyName" | "firstName" | "lastName" | "email" | "phone" | "street" | "zip" | "city" | "country"
  | "birthDate" | "birthPlace" | "nationality" | "idType" | "idNumber" | "idIssuedBy" | "idIssuedAt" | "idValidUntil"
  | "licenseNumber" | "licenseClass" | "licenseIssuedBy" | "licenseIssuedAt" | "licenseValidUntil" | "discountPercent" | "notes";

export const IMPORT_FIELDS: { key: ImportFieldKey; label: string; required?: boolean }[] = [
  { key: "firstName", label: "Vorname", required: true },
  { key: "lastName", label: "Nachname", required: true },
  { key: "companyName", label: "Firma" },
  { key: "email", label: "E-Mail" },
  { key: "phone", label: "Telefon" },
  { key: "street", label: "Straße und Hausnummer" },
  { key: "zip", label: "PLZ" },
  { key: "city", label: "Ort" },
  { key: "country", label: "Land" },
  { key: "birthDate", label: "Geburtsdatum" },
  { key: "birthPlace", label: "Geburtsort" },
  { key: "nationality", label: "Staatsangehörigkeit" },
  { key: "idType", label: "Ausweisart" },
  { key: "idNumber", label: "Ausweisnummer" },
  { key: "idIssuedBy", label: "Ausweis ausstellende Behörde" },
  { key: "idIssuedAt", label: "Ausweis ausgestellt am" },
  { key: "idValidUntil", label: "Ausweis gültig bis" },
  { key: "licenseNumber", label: "Führerscheinnummer" },
  { key: "licenseClass", label: "Führerscheinklasse" },
  { key: "licenseIssuedBy", label: "Führerschein ausstellende Behörde" },
  { key: "licenseIssuedAt", label: "Führerschein ausgestellt am" },
  { key: "licenseValidUntil", label: "Führerschein gültig bis" },
  { key: "discountPercent", label: "Rabatt in %" },
  { key: "notes", label: "Notizen" },
  { key: "legacyNumber", label: "Alte Kundennummer (Vorsoftware)" },
];

// ---------------------------------------------------------------------------
// Datei einlesen: CSV oder Excel, immer zu Kopfzeile + Zeilen aus reinen Texten.
// ---------------------------------------------------------------------------

export type ParsedSheet = { headers: string[]; rows: string[][] };

/** Liest CSV oder Excel (erstes Tabellenblatt) in eine einfache Kopf-/Zeilen-Struktur. Wirft bei unbekanntem Format. */
export async function parseImportFile(bytes: Uint8Array, filename: string): Promise<ParsedSheet> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv" || ext === "txt") return parseCsv(Buffer.from(bytes).toString("utf-8"));
  if (ext === "xlsx" || ext === "xls") return parseExcel(bytes);
  throw new Error("Bitte eine CSV- oder Excel-Datei (.csv, .xlsx) hochladen.");
}

async function parseCsv(text: string): Promise<ParsedSheet> {
  const Papa = (await import("papaparse")).default;
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: true });
  const grid = result.data.filter((r) => r.some((c) => (c ?? "").trim() !== ""));
  if (grid.length === 0) return { headers: [], rows: [] };
  return { headers: grid[0].map((h) => (h ?? "").trim()), rows: grid.slice(1) };
}

async function parseExcel(bytes: Uint8Array): Promise<ParsedSheet> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const grid: string[][] = [];
  ws.eachRow((row) => {
    const cells: string[] = [];
    const cellCount = Math.max(row.cellCount, ws.columnCount);
    for (let i = 1; i <= cellCount; i++) cells.push(cellToString(row.getCell(i).value));
    grid.push(cells);
  });
  const nonEmpty = grid.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  return { headers: nonEmpty[0].map((h) => h.trim()), rows: nonEmpty.slice(1) };
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && v !== null) {
    if ("text" in v && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text;
    if ("result" in v) return String((v as { result?: unknown }).result ?? "");
    if ("richText" in v && Array.isArray((v as { richText?: unknown }).richText)) return ((v as { richText: { text: string }[] }).richText).map((r) => r.text).join("");
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Spaltenzuordnung vorschlagen: Kopfzeilen-Text gegen bekannte Synonyme.
// ---------------------------------------------------------------------------

const HEADER_SYNONYMS: Record<ImportFieldKey, string[]> = {
  legacyNumber: ["kundennummer", "kundennr", "kdnr", "kd nr", "customernumber", "customerid", "altekundennummer"],
  type: ["kundenart", "typ", "type"],
  companyName: ["firma", "firmenname", "unternehmen", "company", "companyname"],
  firstName: ["vorname", "firstname", "vname"],
  lastName: ["nachname", "familienname", "lastname", "surname", "nname"],
  email: ["email", "emailadresse", "mail", "e-mail"],
  phone: ["telefon", "handy", "mobil", "phone", "tel", "telefonnummer"],
  street: ["strasse", "straße", "adresse", "street", "anschrift"],
  zip: ["plz", "postleitzahl", "zip", "zipcode"],
  city: ["ort", "stadt", "city", "wohnort"],
  country: ["land", "country", "staat"],
  birthDate: ["geburtsdatum", "geboren", "birthdate", "dob"],
  birthPlace: ["geburtsort", "birthplace"],
  nationality: ["staatsangehoerigkeit", "nationalitaet", "nationality"],
  idType: ["ausweisart", "dokumentart", "idtype"],
  idNumber: ["ausweisnummer", "personalausweisnummer", "idnumber", "ausweisnr"],
  idIssuedBy: ["ausstellendebehoerde", "ausgestelltvon", "issuedby"],
  idIssuedAt: ["ausweisausgestellt", "ausstellungsdatumausweis"],
  idValidUntil: ["ausweisgueltigbis"],
  licenseNumber: ["fuehrerscheinnummer", "fuhrerscheinnummer", "licensenumber"],
  licenseClass: ["fuehrerscheinklasse", "klasse", "licenseclass"],
  licenseIssuedBy: ["fuehrerscheinausstellendebehoerde"],
  licenseIssuedAt: ["fuehrerscheinausgestellt", "ausstellungsdatumfuehrerschein"],
  licenseValidUntil: ["fuehrerscheingueltigbis", "gueltigbis"],
  discountPercent: ["rabatt", "discount", "rabattprozent"],
  notes: ["notiz", "notizen", "bemerkung", "bemerkungen", "notes"],
};

function normalizeHeader(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/** Ordnet jede Kopfzeile automatisch dem wahrscheinlichsten Feld zu (bester Treffer je Feld, jede Spalte höchstens einmal). */
export function suggestColumnMapping(headers: string[]): Partial<Record<ImportFieldKey, number>> {
  const normalized = headers.map(normalizeHeader);
  const mapping: Partial<Record<ImportFieldKey, number>> = {};
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const synonyms = HEADER_SYNONYMS[field.key];
    let bestIndex = -1;
    for (let i = 0; i < normalized.length; i++) {
      if (used.has(i)) continue;
      if (synonyms.some((s) => normalized[i] === s || normalized[i].includes(s))) { bestIndex = i; break; }
    }
    if (bestIndex >= 0) { mapping[field.key] = bestIndex; used.add(bestIndex); }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Zeilenwerte normalisieren (Datum, Land, Ausweisart, Rabatt) und über die bestehende Kundenvalidierung prüfen.
// ---------------------------------------------------------------------------

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  deutschland: "DE", oesterreich: "AT", "österreich": "AT", schweiz: "CH", frankreich: "FR", niederlande: "NL",
  belgien: "BE", polen: "PL", italien: "IT", spanien: "ES", luxemburg: "LU", daenemark: "DK", "dänemark": "DK",
};

const ID_TYPE_LABELS: Record<string, string> = {
  personalausweis: "PERSONALAUSWEIS", ausweis: "PERSONALAUSWEIS", reisepass: "REISEPASS", pass: "REISEPASS",
  aufenthaltstitel: "AUFENTHALTSTITEL",
};

function normalizeDateStr(v: string | undefined): string | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  const m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return s;
}

/** Rohe, per Spaltenzuordnung übernommene Feldwerte (alles Text) in die Form bringen, die customerSchema erwartet. */
export function normalizeImportRow(raw: Partial<Record<ImportFieldKey, string>>): Record<string, unknown> {
  const companyName = raw.companyName?.trim() || undefined;
  const countryRaw = raw.country?.trim();
  const country = countryRaw ? COUNTRY_NAME_TO_CODE[normalizeHeader(countryRaw)] ?? countryRaw : undefined;
  const idTypeRaw = raw.idType?.trim();
  const idType = idTypeRaw ? ID_TYPE_LABELS[normalizeHeader(idTypeRaw)] ?? idTypeRaw.toUpperCase() : undefined;
  return {
    type: raw.type?.trim().toUpperCase() === "COMPANY" || (!raw.type && companyName) ? "COMPANY" : "PRIVATE",
    companyName,
    firstName: raw.firstName?.trim() ?? "",
    lastName: raw.lastName?.trim() ?? "",
    email: raw.email?.trim(),
    phone: raw.phone?.trim(),
    street: raw.street?.trim(),
    zip: raw.zip?.trim(),
    city: raw.city?.trim(),
    country,
    birthDate: normalizeDateStr(raw.birthDate),
    birthPlace: raw.birthPlace?.trim(),
    nationality: raw.nationality?.trim(),
    idType,
    idNumber: raw.idNumber?.trim(),
    idIssuedBy: raw.idIssuedBy?.trim(),
    idIssuedAt: normalizeDateStr(raw.idIssuedAt),
    idValidUntil: normalizeDateStr(raw.idValidUntil),
    licenseNumber: raw.licenseNumber?.trim(),
    licenseClass: raw.licenseClass?.trim(),
    licenseIssuedBy: raw.licenseIssuedBy?.trim(),
    licenseIssuedAt: normalizeDateStr(raw.licenseIssuedAt),
    licenseValidUntil: normalizeDateStr(raw.licenseValidUntil),
    blocked: false,
    discountPercent: raw.discountPercent?.trim().replace("%", ""),
    notes: raw.notes?.trim(),
    legacyNumber: raw.legacyNumber?.trim(),
  };
}

const digitsOnly = (s: string) => s.replace(/\D/g, "");

export type ImportRowInput = { raw: Partial<Record<ImportFieldKey, string>>; force?: boolean };
export type ImportRowResult = {
  row: number; // 1-basiert, ohne Kopfzeile
  ok: boolean;
  errors: string[];
  duplicateOf?: { id: string; number: string | null; name: string } | null;
  preview?: { name: string; companyName: string | null; email: string | null; legacyNumber: string | null };
};

/**
 * Prüft (dryRun) oder legt an (commit) – dieselbe Logik für Vorschau und Ausführung, damit beide nie auseinanderlaufen.
 * Dubletten werden anhand von E-Mail, Telefon (nur Ziffern) oder alter Kundennummer gegen bereits vorhandene Kunden
 * dieses Mandanten erkannt (einmal geladen, nicht pro Zeile) und blockieren nur, wenn die Zeile nicht "force" ist.
 */
export async function processImportRows(
  tenantId: string,
  rows: ImportRowInput[],
  opts: { commit: boolean },
): Promise<{ results: ImportRowResult[]; created: number }> {
  const existing = await db.customer.findMany({
    where: { tenantId },
    select: { id: true, number: true, firstName: true, lastName: true, companyName: true, email: true, phone: true, legacyNumber: true },
  });
  type CustomerLite = (typeof existing)[number];
  const byEmail = new Map<string, CustomerLite>();
  const byPhone = new Map<string, CustomerLite>();
  const byLegacy = new Map<string, CustomerLite>();
  for (const c of existing) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c);
    if (c.phone) { const key = digitsOnly(c.phone); if (key.length >= 6) byPhone.set(key, c); }
    if (c.legacyNumber) byLegacy.set(c.legacyNumber, c);
  }

  const results: ImportRowResult[] = [];
  let created = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = i + 1;
    const normalized = normalizeImportRow(rows[i].raw);
    const parsed = customerSchema.safeParse(normalized);
    if (!parsed.success) {
      results.push({ row, ok: false, errors: [...new Set(parsed.error.issues.map((iss) => iss.message))] });
      continue;
    }
    const data = customerToData(parsed.data);
    const preview = { name: `${data.firstName} ${data.lastName}`.trim(), companyName: data.companyName, email: data.email, legacyNumber: data.legacyNumber };

    let dup = data.email ? byEmail.get(data.email) : undefined;
    if (!dup && data.phone) { const key = digitsOnly(data.phone); if (key.length >= 6) dup = byPhone.get(key); }
    if (!dup && data.legacyNumber) dup = byLegacy.get(data.legacyNumber);

    if (dup && !rows[i].force) {
      results.push({ row, ok: true, errors: [], preview, duplicateOf: { id: dup.id, number: dup.number, name: dup.companyName || `${dup.firstName} ${dup.lastName}` } });
      continue;
    }

    if (!opts.commit) {
      results.push({ row, ok: true, errors: [], preview });
      continue;
    }

    const c = await withNumberRetry(() =>
      db.$transaction(async (tx) => tx.customer.create({ data: { tenantId, number: await nextCustomerNumber(tx, tenantId), ...data } })),
    );
    created++;
    if (data.email) byEmail.set(data.email, c);
    if (data.phone) { const key = digitsOnly(data.phone); if (key.length >= 6) byPhone.set(key, c); }
    if (data.legacyNumber) byLegacy.set(data.legacyNumber, c);
    results.push({ row, ok: true, errors: [], preview });
  }

  return { results, created };
}

// Befehl 29 Phase C: Eingaben des Unfallersatz-Wizards prüfen und in die Anlage-Eingabe übersetzen. Eine Quelle für
// beide Seiten: der Browser prüft je Schritt (Bedienkomfort), der Server prüft alles noch einmal (verbindlich).
// Rein (kein Server- oder Datenbankzugriff). Geld als ganze Cent über money.ts, Zeitpunkte in Europe/Berlin über time.ts.
// Mandanten-, Kunden-, Fahrzeug- und Adressbuch-Zugehörigkeit prüft createAccidentCase serverseitig in der Transaktion.

import type { CreateAccidentCaseInput, TariffItemInput } from "@/lib/accident-replacement";
import { ACCIDENT_DAMAGE_KINDS, ACCIDENT_LIABILITY_STATUS, ACCIDENT_TARIFF_KINDS, type AccidentTariffKind } from "@/lib/constants";
import { customerSchema, type CustomerInput } from "@/lib/customer-schema";
import { toCents, type Cents } from "@/lib/money";
import { parseLocalDateTime } from "@/lib/time";

export const ACCIDENT_WIZARD_STEPS = ["Kunde", "Schadenfall", "Versicherung", "Fahrzeug & Zeitraum", "Tarif", "Prüfen"] as const;
export type WizardData = Record<string, string | undefined>;
export type WizardError = { field: string | null; message: string };

/** Tarifzeilen im Wizard mit sinnvoller Vorgabe „je Tag“ bzw. „einmalig“ (änderbar). */
export const TARIFF_ROWS: readonly { kind: AccidentTariffKind; perDay: boolean }[] = [
  { kind: "LIABILITY_REDUCTION", perDay: true },
  { kind: "DELIVERY", perDay: false },
  { kind: "PICKUP", perDay: false },
  { kind: "ADDITIONAL_DRIVER", perDay: true },
  { kind: "WINTER_TIRES", perDay: true },
  { kind: "OTHER", perDay: false },
];

const MAX_TEXT = 200;
/** Dieselbe Regel wie isValidEmail in mail.ts (dort nicht browsertauglich); tests/accident-wizard.test.ts hält beide gleich. */
export function wizardEmailValid(value: string): boolean {
  const v = value.trim();
  return v.length <= 254 && /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[A-Za-z]{2,}$/.test(v) && !v.includes("..");
}
const str = (d: WizardData, k: string) => (d[k] ?? "").trim();

/** Betrag aus einem Formularfeld als Cent; null bei leer; Fehlertext bei ungültig oder negativ. */
export function moneyField(raw: string, label: string, opts: { required?: boolean; positive?: boolean } = {}): { cents: Cents | null; error: string | null } {
  const v = raw.replace(/[\s€]/g, "");
  if (!v) return { cents: null, error: opts.required ? `${label}: bitte einen Betrag eingeben.` : null };
  let cents: Cents;
  try {
    // „1.500“ ist im Deutschen 1.500 € (Tausenderpunkt), nicht 1,50 €; „0.250“ bleibt 0,25 €; „1.500,00“ und „12,50“ versteht toCents selbst
    cents = toCents(/^[1-9]\d{0,2}(\.\d{3})+$/.test(v) ? v.replace(/\./g, "") : v);
  } catch {
    return { cents: null, error: `${label}: „${v}“ ist kein gültiger Betrag.` };
  }
  if (cents < 0) return { cents: null, error: `${label}: der Betrag darf nicht negativ sein.` };
  if (opts.positive && cents === 0) return { cents: null, error: `${label}: bitte einen Betrag größer als 0,00 € eingeben.` };
  if (cents > 10_000_000) return { cents: null, error: `${label}: der Betrag ist unplausibel hoch.` };
  return { cents, error: null };
}

/** Datum aus <input type="date"> (Mitternacht in Europe/Berlin). */
const dateOnly = (raw: string) => (/^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseLocalDateTime(`${raw}T00:00`) : null);

/** Kundenfelder mit Präfix aus den Formulardaten (wie customerFieldsFromForm, aber für ein einfaches Objekt). */
export function prefixed(d: WizardData, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) if (k.startsWith(prefix) && typeof v === "string") out[k.slice(prefix.length)] = v;
  return out;
}

export type ParsedStep1 = { customerId: string | null; newCustomer: CustomerInput | null };

function step1(d: WizardData, e: WizardError[]): ParsedStep1 {
  if (str(d, "customerMode") === "new") {
    const c = customerSchema.safeParse(prefixed(d, "c_"));
    if (!c.success) {
      const issue = c.error.issues[0];
      e.push({ field: `c_${String(issue.path[0] ?? "")}`, message: `Neuer Kunde: ${issue.message}` });
      return { customerId: null, newCustomer: null };
    }
    return { customerId: null, newCustomer: c.data };
  }
  const id = str(d, "customerId");
  if (!id) e.push({ field: "customerId", message: "Bitte einen Kunden auswählen oder „Neuer Kunde“ wählen." });
  return { customerId: id || null, newCustomer: null };
}

function step2(d: WizardData, e: WizardError[], now: Date) {
  const plate = str(d, "damagedPlate"), make = str(d, "damagedMake"), model = str(d, "damagedModel");
  if (!plate) e.push({ field: "damagedPlate", message: "Bitte das Kennzeichen des beschädigten Fahrzeugs angeben." });
  if (!make) e.push({ field: "damagedMake", message: "Bitte den Hersteller des beschädigten Fahrzeugs angeben." });
  if (!model) e.push({ field: "damagedModel", message: "Bitte das Modell des beschädigten Fahrzeugs angeben." });
  const drivable = str(d, "damagedDrivable");
  if (drivable !== "1" && drivable !== "0") e.push({ field: "damagedDrivable", message: "Bitte angeben, ob das beschädigte Fahrzeug fahrbereit ist." });
  const kind = str(d, "damageKind");
  if (!(kind in ACCIDENT_DAMAGE_KINDS)) e.push({ field: "damageKind", message: "Bitte die Schadenart wählen." });
  const firstRegRaw = str(d, "damagedFirstRegistration");
  const firstReg = firstRegRaw ? dateOnly(firstRegRaw) : null;
  if (firstRegRaw && !firstReg) e.push({ field: "damagedFirstRegistration", message: "Die Erstzulassung ist kein gültiges Datum." });
  if (firstReg && firstReg > now) e.push({ field: "damagedFirstRegistration", message: "Die Erstzulassung liegt in der Zukunft." });
  const accidentRaw = str(d, "accidentDate");
  const accidentAt = accidentRaw ? dateOnly(accidentRaw) : null;
  if (!accidentRaw) e.push({ field: "accidentDate", message: "Bitte das Unfalldatum angeben." });
  else if (!accidentAt) e.push({ field: "accidentDate", message: "Das Unfalldatum ist kein gültiges Datum." });
  else if (accidentAt.getTime() > now.getTime()) e.push({ field: "accidentDate", message: "Das Unfalldatum liegt in der Zukunft." });
  for (const [k, label] of [["damagedPlate", "Kennzeichen"], ["damagedMake", "Hersteller"], ["damagedModel", "Modell"], ["damagedVehicleClass", "Fahrzeugklasse"], ["damagedLocation", "Standort"], ["accidentPlace", "Unfallort"], ["opponentPlate", "Gegnerisches Kennzeichen"], ["opponentName", "Unfallgegner"], ["policeFileNumber", "Aktenzeichen"]] as const) {
    if (str(d, k).length > MAX_TEXT) e.push({ field: k, message: `${label}: höchstens ${MAX_TEXT} Zeichen.` });
  }
  if (str(d, "accidentNote").length > 2000) e.push({ field: "accidentNote", message: "Interne Notiz: höchstens 2.000 Zeichen." });
  return {
    damaged: { plate, make, model, drivable: drivable === "1", firstRegistration: firstReg, vehicleClass: str(d, "damagedVehicleClass") || null, location: str(d, "damagedLocation") || null, damageKind: kind },
    accident: { accidentAt, place: str(d, "accidentPlace") || null, opponentPlate: str(d, "opponentPlate") || null, opponentName: str(d, "opponentName") || null, policeFileNumber: str(d, "policeFileNumber") || null, note: str(d, "accidentNote") || null },
  };
}

function email(d: WizardData, k: string, label: string, e: WizardError[]) {
  const v = str(d, k);
  if (v && !wizardEmailValid(v)) e.push({ field: k, message: `${label}: Die E-Mail-Adresse ist ungültig.` });
  return v || null;
}

/** Haftungsquote: ganze Zahl 0–100 (nur beim Status „Haftungsquote“). */
export function quotaField(raw: string): { value: number | null; error: string | null } {
  const v = raw.trim().replace(/\s*%$/, "");
  if (!/^\d{1,3}$/.test(v)) return { value: null, error: "Bitte die Haftungsquote des Gegners als ganze Zahl von 0 bis 100 angeben." };
  const n = Number(v);
  if (n < 0 || n > 100) return { value: null, error: "Die Haftungsquote liegt zwischen 0 und 100 %." };
  return { value: n, error: null };
}

function step3(d: WizardData, e: WizardError[]) {
  const name = str(d, "insurerName");
  if (!name) e.push({ field: "insurerName", message: "Bitte die gegnerische Versicherung angeben." });
  const insurer = { name, claimNumber: str(d, "insurerClaimNumber") || null, contactName: str(d, "insurerContactName") || null, phone: str(d, "insurerPhone") || null, email: email(d, "insurerEmail", "Versicherung", e), street: str(d, "insurerStreet") || null, zip: str(d, "insurerZip") || null, city: str(d, "insurerCity") || null };
  const status = str(d, "liabilityStatus") || "UNKNOWN";
  if (!(status in ACCIDENT_LIABILITY_STATUS)) e.push({ field: "liabilityStatus", message: "Bitte den Haftungsstatus wählen." });
  let quota: number | null = null;
  if (status === "QUOTA") {
    const q = quotaField(str(d, "liabilityQuotaPercent"));
    if (q.error) e.push({ field: "liabilityQuotaPercent", message: q.error });
    quota = q.value;
  }
  // Werkstatt und Anwalt sind optional; wer etwas einträgt, gibt mindestens den Namen an
  const ws = { name: str(d, "workshopName"), contactName: str(d, "workshopContactName") || null, phone: str(d, "workshopPhone") || null, email: email(d, "workshopEmail", "Werkstatt", e) };
  const repairStartRaw = str(d, "repairStartAt"), repairEndRaw = str(d, "repairEndAt");
  const repairStartAt = repairStartRaw ? dateOnly(repairStartRaw) : null, repairEndAt = repairEndRaw ? dateOnly(repairEndRaw) : null;
  if (repairStartRaw && !repairStartAt) e.push({ field: "repairStartAt", message: "Der Reparaturbeginn ist kein gültiges Datum." });
  if (repairEndRaw && !repairEndAt) e.push({ field: "repairEndAt", message: "Das Reparaturende ist kein gültiges Datum." });
  if (repairStartAt && repairEndAt && repairEndAt < repairStartAt) e.push({ field: "repairEndAt", message: "Das voraussichtliche Reparaturende liegt vor dem Reparaturbeginn." });
  const wsAny = ws.name || ws.contactName || ws.phone || ws.email || repairStartRaw || repairEndRaw || str(d, "workshopPartnerId");
  if (wsAny && !ws.name) e.push({ field: "workshopName", message: "Werkstatt: bitte den Namen angeben oder die Angaben leeren." });
  const lw = { firm: str(d, "lawyerFirm"), contactName: str(d, "lawyerContactName") || null, phone: str(d, "lawyerPhone") || null, email: email(d, "lawyerEmail", "Rechtsanwalt", e) };
  const lwAny = lw.firm || lw.contactName || lw.phone || lw.email || str(d, "lawyerPartnerId");
  if (lwAny && !lw.firm) e.push({ field: "lawyerFirm", message: "Rechtsanwalt: bitte Kanzlei bzw. Firma angeben oder die Angaben leeren." });
  for (const k of ["insurerName", "insurerClaimNumber", "insurerContactName", "insurerStreet", "insurerCity", "workshopName", "workshopContactName", "lawyerFirm", "lawyerContactName"]) if (str(d, k).length > MAX_TEXT) e.push({ field: k, message: `Höchstens ${MAX_TEXT} Zeichen.` });
  return {
    insurer, insurerPartnerId: str(d, "insurerPartnerId") || null,
    liability: { status, quotaPercent: quota },
    workshop: wsAny ? { ...ws, repairStartAt, repairEndAt } : null, workshopPartnerId: str(d, "workshopPartnerId") || null,
    lawyer: lwAny ? lw : null, lawyerPartnerId: str(d, "lawyerPartnerId") || null,
  };
}

function step4(d: WizardData, e: WizardError[]) {
  const vehicleId = str(d, "vehicleId");
  if (!vehicleId) e.push({ field: "vehicleId", message: "Bitte ein Ersatzfahrzeug aus der Flotte wählen." });
  const startAt = parseLocalDateTime(str(d, "startAt"));
  if (!startAt) e.push({ field: "startAt", message: "Bitte den Mietbeginn mit Datum und Uhrzeit angeben." });
  const mode = str(d, "endMode");
  if (mode !== "known" && mode !== "open") e.push({ field: "endMode", message: "Bitte wählen: Datum bekannt oder Mietende offen." });
  let plannedEndAt: Date | null = null;
  if (mode === "known") {
    plannedEndAt = parseLocalDateTime(str(d, "plannedEndAt"));
    if (!plannedEndAt) e.push({ field: "plannedEndAt", message: "Bitte das geplante Mietende mit Datum und Uhrzeit angeben oder „Mietende offen“ wählen." });
    else if (startAt && !(plannedEndAt > startAt)) e.push({ field: "plannedEndAt", message: "Das geplante Mietende muss nach dem Mietbeginn liegen." });
  }
  return { vehicleId, startAt, plannedEndAt: mode === "open" ? null : plannedEndAt };
}

function step5(d: WizardData, e: WizardError[]) {
  const daily = moneyField(str(d, "dailyRate"), "Tagessatz", { required: true, positive: true });
  if (daily.error) e.push({ field: "dailyRate", message: daily.error });
  const deposit = moneyField(str(d, "deposit"), "Kaution");
  if (deposit.error) e.push({ field: "deposit", message: deposit.error });
  const kmRaw = str(d, "kmIncludedPerDay").replace(/\./g, "");
  let km: number | null = null;
  if (kmRaw) {
    if (!/^\d{1,6}$/.test(kmRaw)) e.push({ field: "kmIncludedPerDay", message: "Freikilometer: bitte eine ganze Zahl ab 0 eingeben." });
    else km = Number(kmRaw);
  }
  const extra = moneyField(str(d, "extraKmRate"), "Preis je Mehrkilometer");
  if (extra.error) e.push({ field: "extraKmRate", message: extra.error });
  const tariff: TariffItemInput[] = [];
  for (const row of TARIFF_ROWS) {
    if (str(d, `t_${row.kind}_on`) !== "1") continue;
    const label = row.kind === "OTHER" ? str(d, "t_OTHER_label") : ACCIDENT_TARIFF_KINDS[row.kind];
    if (row.kind === "OTHER" && !label) e.push({ field: "t_OTHER_label", message: "Sonstige Position: bitte eine Bezeichnung angeben." });
    if (label.length > MAX_TEXT) e.push({ field: "t_OTHER_label", message: `Sonstige Position: höchstens ${MAX_TEXT} Zeichen.` });
    const amount = moneyField(str(d, `t_${row.kind}_amount`), ACCIDENT_TARIFF_KINDS[row.kind], { required: true, positive: true });
    if (amount.error) e.push({ field: `t_${row.kind}_amount`, message: amount.error });
    const perDay = (str(d, `t_${row.kind}_mode`) || (row.perDay ? "day" : "once")) === "day";
    if (amount.cents != null && label) tariff.push({ kind: row.kind, label, perDay, unitPriceCents: amount.cents, quantityHundredths: 100 });
  }
  return { dailyRateCents: daily.cents ?? 0, depositCents: deposit.cents ?? 0, kmIncludedPerDay: km, extraKmRateCents: extra.cents, tariff };
}

/** Prüfung eines einzelnen Schritts (Browser vor „Weiter“). Schritt 6 prüft alles. */
export function validateWizardStep(step: number, d: WizardData, now = new Date()): WizardError[] {
  const e: WizardError[] = [];
  if (step === 1) step1(d, e);
  else if (step === 2) step2(d, e, now);
  else if (step === 3) step3(d, e);
  else if (step === 4) step4(d, e);
  else if (step === 5) step5(d, e);
  else for (let s = 1; s <= 5; s++) e.push(...validateWizardStep(s, d, now));
  return e;
}

/** Schritt, zu dem ein Feld gehört (für Fehler vom Server). */
export function stepOfField(field: string | null): number {
  if (!field) return 6;
  if (field === "customerId" || field.startsWith("c_")) return 1;
  if (/^(damaged|damageKind|accident|opponent|police)/.test(field)) return 2;
  if (/^(insurer|liability|workshop|repair|lawyer)/.test(field)) return 3;
  if (/^(vehicleId|startAt|endMode|plannedEndAt)$/.test(field)) return 4;
  return 5;
}

/**
 * Schritt, zu dem eine fachliche Meldung der Anlage gehört (damit der Wizard dorthin springt). Geprüft wird nur der feste
 * Meldungsanfang: Meldungen enthalten Namen (z. B. den Kunden der belegenden Buchung), die sonst falsch zuordnen würden.
 */
export function stepOfCreateMessage(message: string): number {
  if (/^(Doppelbelegung|Mietende offen ist mit|Ersatzfahrzeug nicht gefunden|Das Fahrzeug steht auf|Bitte den Mietbeginn|Bitte das geplante Mietende|Das geplante Mietende)/.test(message)) return 4;
  if (/^(Kunde nicht gefunden|Bitte einen Kunden)/.test(message) || / ist gesperrt[.:]/.test(message)) return 1;
  if (/^(Bitte das Kennzeichen des beschädigten|Bitte Hersteller und Modell|Bitte die Schadenart|Die Erstzulassung|Das Unfalldatum)/.test(message)) return 2;
  if (/^(Die gewählte (Versicherung|Werkstatt|Kanzlei)|(Versicherung|Werkstatt|Rechtsanwalt): Die E-Mail-Adresse|Unbekannter Haftungsstatus|Bitte die Haftungsquote|Eine Haftungsquote|Der Reparaturbeginn|Das Reparaturende|Das voraussichtliche Reparaturende)/.test(message)) return 3;
  if (/^(Bitte den Tagessatz|Kaution:|Freikilometer:|Mehrkilometerpreis:|Tarifposition|Höchstens 30 Tarifpositionen)/.test(message)) return 5;
  return 6;
}

export type ParsedWizard = { ok: true; input: Omit<CreateAccidentCaseInput, "nonce"> } | { ok: false; step: number; errors: WizardError[] };

/** Verbindliche Prüfung aller Schritte (Server). Liefert die Eingabe für createAccidentCase ohne Formularschlüssel. */
export function parseAccidentWizard(d: WizardData, now = new Date()): ParsedWizard {
  const e: WizardError[] = [];
  const s1 = step1(d, e), s2 = step2(d, e, now), s3 = step3(d, e), s4 = step4(d, e), s5 = step5(d, e);
  if (e.length > 0) return { ok: false, step: stepOfField(e[0].field), errors: e };
  return {
    ok: true,
    input: {
      customerId: s1.customerId, newCustomer: s1.newCustomer,
      vehicleId: s4.vehicleId, startAt: s4.startAt!, plannedEndAt: s4.plannedEndAt,
      dailyRateCents: s5.dailyRateCents, depositCents: s5.depositCents, kmIncludedPerDay: s5.kmIncludedPerDay, extraKmRateCents: s5.extraKmRateCents,
      damaged: s2.damaged, accident: s2.accident,
      insurer: s3.insurer, insurerPartnerId: s3.insurerPartnerId, liability: s3.liability,
      workshop: s3.workshop, workshopPartnerId: s3.workshopPartnerId, lawyer: s3.lawyer, lawyerPartnerId: s3.lawyerPartnerId,
      tariff: s5.tariff,
    },
  };
}

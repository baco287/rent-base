// Auslandsfahrt bei der Buchung: Genehmigung, konkret genehmigte Länder und ein EINMALIGER Aufpreis. Reine Funktionen ohne
// Datenbank und ohne Server-Abhängigkeiten – auch im Buchungsformular nutzbar. Der Aufpreis ist eine eigene Vertragsposition (wie
// der Zusatzfahrer): nie Teil von Tarif, Grundmiete oder Kaution, ohne Kundenrabatt, einmalig je Buchung (nicht je Land oder Tag).
// Bis zur Unterschrift ist die Buchung führend, danach der Vertrag. Länder nur aus der Freigabeliste des Vermieters
// (Geschäftsregeln Mandant → Fahrzeuggruppe → Fahrzeug).

import { COUNTRIES } from "@/lib/constants";
import { fmtCents } from "@/lib/money";

export const ABROAD_SURCHARGE_KEY = "ABROAD_SURCHARGE" as const;
/** Obergrenze 100.000 € (wie Kaution und Selbstbeteiligung; auch als DB-Prüfregel rb_booking_abroad). */
export const MAX_ABROAD_SURCHARGE_CENTS = 10_000_000;
export const MAX_ABROAD_COUNTRIES = 20;

export const isAbroadCountry = (c: unknown): c is string => typeof c === "string" && c !== "OTHER" && Object.hasOwn(COUNTRIES, c);
export const countryName = (c: string) => COUNTRIES[c as keyof typeof COUNTRIES] ?? c;
export const countryNames = (list: readonly string[]) => list.map(countryName).join(", ");

/** Bekannte Länder ohne „Anderes Land“, ohne Doppelte, sortiert (stabil für Vertragsinhalt und Prüfsumme). */
export function normalizeCountries(list: readonly unknown[]): string[] {
  return [...new Set(list.filter(isAbroadCountry))].sort();
}

/**
 * Euro-Text → Cent, streng: höchstens zwei Nachkommastellen (keine stille Rundung), nie negativ, Obergrenze. Bei Komma gelten
 * Punkte als Tausenderpunkte („1.234,50“), sonst ist der Punkt das Dezimalzeichen („49.5“). Leer ist ein Fehler – 0,00 € muss
 * bewusst eingegeben werden.
 */
export function parseSurchargeCents(input: string): { cents: number } | { error: string } {
  let s = String(input ?? "").trim().replace(/\s|€/g, "");
  if (!s) return { error: "Bitte den Auslandsfahrt-Aufpreis angeben (0,00 € ist zulässig)." };
  if (s.startsWith("-")) return { error: "Der Auslandsfahrt-Aufpreis darf nicht negativ sein." };
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { error: "Bitte einen gültigen Auslandsfahrt-Aufpreis mit höchstens zwei Nachkommastellen angeben." };
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (cents > MAX_ABROAD_SURCHARGE_CENTS) return { error: `Der Auslandsfahrt-Aufpreis darf höchstens ${fmtCents(MAX_ABROAD_SURCHARGE_CENTS)} betragen.` };
  return { cents };
}

/** Auswahl im Buchungsformular. present=false: Bereich nicht gesendet (z. B. alter Browser-Tab) – dann ändert sich nichts. */
export type AbroadChoice = { present: false } | { present: true; allowed: false } | { present: true; allowed: true; countries: string[]; surchargeCents: number };

export function parseAbroadForm(fd: FormData): AbroadChoice | { error: string } {
  if (fd.get("abroadSection") !== "1") return { present: false };
  if (fd.get("abroadAllowed") !== "1") return { present: true, allowed: false };
  const raw = fd.getAll("abroadCountries");
  if (raw.some((c) => !isAbroadCountry(c))) return { error: "Auslandsfahrt: Unbekanntes Land ausgewählt." };
  const countries = normalizeCountries(raw);
  if (countries.length === 0) return { error: "Auslandsfahrt: Bitte die konkret genehmigten Länder auswählen." };
  if (countries.length > MAX_ABROAD_COUNTRIES) return { error: "Auslandsfahrt: Zu viele Länder ausgewählt." };
  const s = parseSurchargeCents(String(fd.get("abroadSurcharge") ?? ""));
  if ("error" in s) return { error: `Auslandsfahrt: ${s.error}` };
  return { present: true, allowed: true, countries, surchargeCents: s.cents };
}

/** Spaltenwerte der Buchung zu einer Auswahl. */
export function bookingAbroadData(choice: { allowed: false } | { allowed: true; countries: string[]; surchargeCents: number }): { abroadAllowed: boolean; abroadCountries: string[]; abroadSurchargeCents: number | null } {
  return choice.allowed ? { abroadAllowed: true, abroadCountries: normalizeCountries(choice.countries), abroadSurchargeCents: choice.surchargeCents } : { abroadAllowed: false, abroadCountries: [], abroadSurchargeCents: null };
}

type AbroadValues = { abroadAllowed: boolean; abroadCountries: readonly string[] };

/**
 * Grenzen einer Auslandsgenehmigung gegenüber der Freigabeliste des Vermieters. Herkunft CONTRACT: Texte wie bisher im
 * Vertragsassistenten; BOOKING: mit Hinweis, dass die Änderung in der Buchung erfolgt; AMENDMENT: Freigabe per Nachtrag.
 * `kept`: bereits genehmigte Länder mit Bestandsschutz (werden nicht gegen eine inzwischen verkleinerte Liste geprüft).
 */
export function abroadRuleIssues(v: AbroadValues, resolved: AbroadValues, origin: "BOOKING" | "CONTRACT" | "AMENDMENT", kept: readonly string[] = []): string[] {
  if (!v.abroadAllowed) return [];
  const where = origin === "BOOKING" ? " Bitte in der Buchung ändern." : "";
  const fresh = v.abroadCountries.filter((c) => !kept.includes(c));
  const issues: string[] = [];
  if (!resolved.abroadAllowed && (kept.length === 0 || fresh.length > 0)) issues.push(`Auslandsfahrten sind nach den Geschäftsregeln nicht vorgesehen. Eine Freigabe ${origin === "AMENDMENT" ? "per Nachtrag" : "im Vertrag"} braucht zuerst die Einstellung des Vermieters.${where}`);
  const outside = fresh.filter((c) => !resolved.abroadCountries.includes(c));
  if (outside.length) issues.push(`Ausland: ${countryNames(outside)} ist nicht in der Freigabeliste des Vermieters.${where}`);
  if (v.abroadCountries.length === 0) issues.push(`Ausland: Bitte die konkret genehmigten Länder auswählen.${where}`);
  return issues;
}

/** Prüfung bei Anlage/Bearbeitung der Buchung (Server): Meldung oder null. */
export function bookingAbroadIssue(choice: { allowed: boolean; countries?: readonly string[] }, resolved: AbroadValues, ctx: { rentalType: string; plate: string }): string | null {
  if (!choice.allowed) return null;
  if (ctx.rentalType !== "STANDARD") return "Auslandsfahrt: Bei Unfallersatz ist kein Auslandsfahrt-Aufpreis vorgesehen.";
  if (!resolved.abroadAllowed) return `Auslandsfahrt: Für ${ctx.plate} sind nach den Geschäftsregeln des Vermieters keine Auslandsfahrten vorgesehen.`;
  const outside = (choice.countries ?? []).filter((c) => !resolved.abroadCountries.includes(c));
  if (outside.length) return `Auslandsfahrt: ${countryNames(outside)} ist für ${ctx.plate} nicht in der Freigabeliste des Vermieters.`;
  return null;
}

/** Wirksamer Aufpreis einer Buchung vor dem Vertrag (0 bei nicht gestattet, Altbestand oder Unfallersatz). */
export function abroadSurchargeOf(b: { abroadAllowed?: boolean | null; abroadSurchargeCents?: number | null; rentalType?: string | null }): number {
  return b.abroadAllowed === true && b.rentalType !== "ACCIDENT_REPLACEMENT" ? b.abroadSurchargeCents ?? 0 : 0;
}

/** Bezeichnung der Vertrags- und Rechnungsposition. */
export function abroadLabel(countries: readonly string[]): string {
  return `Auslandsfahrt-Aufpreis (einmalig) – ${countryNames(countries)}`;
}

/** Kurztext für Anzeigen: null = Altbestand (der Vertrag bestimmt). */
export function abroadSummary(b: { abroadAllowed?: boolean | null; abroadCountries?: readonly string[] | null; abroadSurchargeCents?: number | null }): string | null {
  if (b.abroadAllowed == null) return null;
  if (!b.abroadAllowed) return "Nicht gestattet";
  const cents = b.abroadSurchargeCents ?? 0;
  return `Gestattet: ${countryNames(b.abroadCountries ?? [])} · ${cents > 0 ? `Aufpreis einmalig ${fmtCents(cents)}` : "ohne Aufpreis"}`;
}

/** Fortsetzen eines Buchungsentwurfs: nur Länder, die für das Fahrzeug weiterhin freigegeben sind. */
export function filterAbroadCountries(countries: readonly string[], allowed: readonly string[] | null): { kept: string[]; removed: string[] } {
  if (!allowed) return { kept: normalizeCountries(countries), removed: [] };
  const norm = normalizeCountries(countries);
  return { kept: norm.filter((c) => allowed.includes(c)), removed: norm.filter((c) => !allowed.includes(c)) };
}

// ---------------------------------------------------------------------------
// Stufe 2: Auslandsfahrt per Nachtrag (wirksamer Stand = Vertrag + unterschriebene Nachträge)
// ---------------------------------------------------------------------------

/** Auslandsstand (Genehmigung, Länder, einmaliger Gesamt-Aufpreis). */
export type AbroadState = { allowed: boolean; countries: string[]; surchargeCents: number };

/**
 * Auslandsstand eines Vertrags aus seinem eingefrorenen Inhalt: Genehmigung und Länder aus den Vertragsregeln (conditions),
 * der Aufpreis aus der Preisposition ABROAD_SURCHARGE. Liest das JSON direkt (ohne business-rules, auch im Browser nutzbar).
 */
export function contractAbroadOf(conditions: unknown, priceSnapshot: unknown): AbroadState {
  const v = ((conditions as { values?: unknown } | null)?.values ?? {}) as { abroadAllowed?: unknown; abroadCountries?: unknown };
  const allowed = v.abroadAllowed === true;
  const countries = allowed && Array.isArray(v.abroadCountries) ? normalizeCountries(v.abroadCountries) : [];
  const extras = ((priceSnapshot as { extras?: unknown } | null)?.extras ?? []) as { key?: unknown; amount?: unknown }[];
  const surchargeCents = Array.isArray(extras) ? extras.filter((e) => e?.key === ABROAD_SURCHARGE_KEY).reduce((a, e) => a + Math.round(Number(e.amount ?? 0) * 100), 0) : 0;
  return { allowed, countries, surchargeCents };
}

/** Kurztext eines Auslandsstands („Gestattet: … · Aufpreis einmalig …“ bzw. „Nicht gestattet“). */
export function abroadStateText(s: AbroadState): string {
  return abroadSummary({ abroadAllowed: s.allowed, abroadCountries: s.countries, abroadSurchargeCents: s.surchargeCents }) ?? "Nicht gestattet";
}

/** Auswahl im Nachtrag „Auslandsfahrten ändern“ (Bereich aktiv). Entzug = keine Länder, Aufpreis 0. */
export type AmendmentAbroadChoice = { allowed: boolean; countries: string[]; surchargeCents: number; reason: string | null };

/** Grund einer Auslandsänderung: leer = keiner; sonst 3 bis 300 Zeichen (wie die Prüfregel der Datenbank). */
export const ABROAD_REASON_MIN = 3;
/** Länge in Zeichen (Codepunkte) – zählt wie PostgreSQL length(), nicht in UTF-16-Einheiten (Emoji = 1 Zeichen). */
export const charCount = (s: string) => [...s].length;
export function abroadReasonIssue(reason: string | null | undefined): string | null {
  const n = charCount((reason ?? "").trim());
  return n > 0 && n < ABROAD_REASON_MIN ? "Auslandsfahrt: Bitte den Grund in mindestens 3 Zeichen angeben." : null;
}

/** Formular des Nachtrags: null = Bereich nicht aktiv (keine Auslandsänderung). */
export function parseAmendmentAbroadForm(fd: FormData): AmendmentAbroadChoice | null | { error: string } {
  if (fd.get("abroadChange") !== "1") return null;
  const reason = [...String(fd.get("abroadReason") ?? "").replace(/<[^>]*>/g, "").trim()].slice(0, 300).join("").trim() || null;
  const reasonIssue = abroadReasonIssue(reason);
  if (reasonIssue) return { error: reasonIssue };
  if (fd.get("abroadAllowed") !== "1") return { allowed: false, countries: [], surchargeCents: 0, reason };
  const raw = fd.getAll("abroadCountries");
  if (raw.some((c) => !isAbroadCountry(c))) return { error: "Auslandsfahrt: Unbekanntes Land ausgewählt." };
  const countries = normalizeCountries(raw);
  if (countries.length === 0) return { error: "Auslandsfahrt: Bitte die konkret genehmigten Länder auswählen." };
  if (countries.length > MAX_ABROAD_COUNTRIES) return { error: "Auslandsfahrt: Zu viele Länder ausgewählt." };
  const s = parseSurchargeCents(String(fd.get("abroadSurcharge") ?? ""));
  if ("error" in s) return { error: `Auslandsfahrt: ${s.error}` };
  return { allowed: true, countries, surchargeCents: s.cents, reason };
}

// Dokumenterkennung für Behördenschreiben. Stufe 1: nur PDFs mit Textebene (die meisten elektronisch erzeugten
// Anhörungsbögen, Zeugenfragebögen und Bescheide) – lokal auf dem eigenen Server, keine externe OCR-Cloud. Fotos und
// Scans ohne Textebene werden gespeichert, aber nicht gelesen. Jedes Ergebnis ist nur ein „erkannter Vorschlag“, den der
// Mitarbeiter im Formular sieht, bestätigt oder korrigiert – nie automatisch verbindlich.

import { plateKey } from "@/lib/authority-matching";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type Detected = { value: string; confidence: Confidence; /** kurzer Hinweis, woher der Wert stammt */ hint?: string };

export const EXTRACTION_FIELDS = [
  "type", "authorityName", "authorityDepartment", "authorityReference", "authorityAddress", "authorityEmail", "authorityPortalUrl",
  "licensePlate", "offenseDate", "offenseTime", "offenseLocation", "offenseType", "responseDeadline", "noticeAmount",
] as const;
export type ExtractionField = (typeof EXTRACTION_FIELDS)[number];
export type ExtractionSuggestion = Partial<Record<ExtractionField, Detected>>;

export type ExtractionContext = {
  /** Kennzeichen der eigenen Flotte – ein im Schreiben gefundenes Flottenkennzeichen hat Vorrang */
  fleetPlates: string[];
  /** bekannte Behörden aus dem Adressbuch */
  contacts: { name: string; department?: string | null; address?: string | null; email?: string | null; portalUrl?: string | null }[];
  /** eigene Firmendaten – werden nie als Behördendaten vorgeschlagen (Empfängerblock im Schreiben) */
  tenant: { name?: string | null; email?: string | null; zip?: string | null; street?: string | null };
};

// ---------------------------------------------------------------------------
// PDF-Text
// ---------------------------------------------------------------------------

/** Text eines PDFs mit Textebene; leer bei Scans/Fotos oder unlesbaren Dateien. Wirft nie. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Auswertung (rein, testbar)
// ---------------------------------------------------------------------------

const DATE = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})\b/;
const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:Uhr|h)?\b/;
const AMOUNT = /(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR|Euro)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https:\/\/[^\s<>"')]+/gi;
// Deutsches Kennzeichen: Unterscheidungszeichen, Erkennungsbuchstaben, Zahl (+ E/H)
const PLATE = /\b([A-ZÄÖÜ]{1,3})[ \t-]{1,3}([A-Z]{1,2})[ \t-]{0,3}([1-9]\d{0,3})([EH])?\b/g;
const AUTHORITY_WORDS = /(Bußgeldstelle|Bussgeldstelle|Bußgeldbehörde|Ordnungsamt|Stadtamt|Straßenverkehrsamt|Straßenverkehrsbehörde|Verkehrsüberwachung|Polizei|Landratsamt|Kreisverwaltung|Stadtverwaltung|Bezirksamt|Regierungspräsidium|Bundesamt für Logistik|Bundesamt für Güterverkehr|Toll Collect|Ordnungsbehörde)/i;

const clean = (s: string) => s.replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();
const pad2 = (n: string | number) => String(n).padStart(2, "0");

function isoDate(m: RegExpExecArray | RegExpMatchArray): string | null {
  const d = Number(m[1]), mo = Number(m[2]);
  let y = Number(m[3]);
  if (m[3].length === 2) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/** Text nach einer Beschriftung bis Zeilenende (bzw. die nächste nicht leere Zeile, wenn danach nichts steht). */
function afterLabel(lines: string[], label: RegExp): { value: string; line: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]);
    if (!m) continue;
    const rest = clean(lines[i].slice(m.index + m[0].length).replace(/^[\s:.\-–]+/, ""));
    if (rest) return { value: rest, line: i };
    const nextIdx = lines.findIndex((l, j) => j > i && clean(l));
    if (nextIdx > 0) return { value: clean(lines[nextIdx]), line: nextIdx };
  }
  return null;
}

/** Fenster ab einer Beschriftung (für Datum/Uhrzeit/Betrag, die auch auf der Folgezeile stehen können). */
function windowAfter(text: string, label: RegExp, size = 120): string | null {
  const m = label.exec(text);
  return m ? text.slice(m.index + m[0].length, m.index + m[0].length + size) : null;
}

function detectPlate(text: string, ctx: ExtractionContext): Detected | undefined {
  const fleet = new Map(ctx.fleetPlates.map((p) => [plateKey(p), p]));
  const found: { raw: string; key: string; nearLabel: boolean }[] = [];
  const labelPos = [...text.matchAll(/Kennzeichen/gi)].map((m) => (m.index ?? 0) + m[0].length);
  for (const m of text.matchAll(PLATE)) {
    const raw = clean(`${m[1]}-${m[2]} ${m[3]}${m[4] ?? ""}`);
    const pos = m.index ?? 0;
    found.push({ raw, key: plateKey(raw), nearLabel: labelPos.some((p) => pos >= p && pos - p < 60) });
  }
  const inFleet = found.filter((f) => fleet.has(f.key));
  const fleetKeys = [...new Set(inFleet.map((f) => f.key))];
  if (fleetKeys.length === 1) return { value: fleet.get(fleetKeys[0])!, confidence: "HIGH", hint: "Kennzeichen eines eigenen Fahrzeugs" };
  if (fleetKeys.length > 1) {
    const labelled = inFleet.find((f) => f.nearLabel);
    if (labelled) return { value: fleet.get(labelled.key)!, confidence: "MEDIUM", hint: "mehrere eigene Kennzeichen im Schreiben – bitte prüfen" };
  }
  const labelled = found.find((f) => f.nearLabel);
  if (labelled) return { value: labelled.raw, confidence: "MEDIUM", hint: "neben „Kennzeichen“ gefunden, aber kein eigenes Fahrzeug" };
  return undefined;
}

function detectOffenseDateTime(text: string): { date?: Detected; time?: Detected } {
  const labels = [/Tat(?:zeit|tag|datum)(?:punkt)?(?:\s*\/\s*-?\s*(?:zeit|uhrzeit|ort))?/i, /Datum\s*\/\s*Uhrzeit/i, /Zeit der Tat|Feststellungszeit/i];
  for (const l of labels) {
    const win = windowAfter(text, l, 90);
    if (!win) continue;
    const d = DATE.exec(win);
    const date = d ? isoDate(d) : null;
    if (!date || !d) continue;
    const t = TIME.exec(win.slice(d.index + d[0].length, d.index + d[0].length + 30));
    return { date: { value: date, confidence: "HIGH", hint: "neben „Tatzeit“ gefunden" }, time: t ? { value: `${pad2(t[1])}:${t[2]}`, confidence: "HIGH" } : undefined };
  }
  const m = /\bam\s+(\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4})\s*(?:,\s*)?(?:um|gegen)\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*Uhr/i.exec(text);
  if (m) {
    const d = DATE.exec(m[1]);
    const date = d ? isoDate(d) : null;
    if (date) return { date: { value: date, confidence: "MEDIUM", hint: "aus „am … um … Uhr“" }, time: { value: `${pad2(m[2])}:${m[3]}`, confidence: "MEDIUM" } };
  }
  return {};
}

function detectReference(lines: string[]): Detected | undefined {
  const labels: [RegExp, Confidence, string][] = [
    [/\b(?:Aktenzeichen|Geschäftszeichen)\b/i, "HIGH", "Aktenzeichen"],
    [/\bAz\.?\s*:?/, "HIGH", "Az."],
    [/\b(?:Unser Zeichen|Vorgangsnummer|Verwarnungsnummer|Kassenzeichen)\b/i, "MEDIUM", "Zeichen/Vorgangsnummer"],
  ];
  for (const [label, confidence, name] of labels) {
    const hit = afterLabel(lines, label);
    if (!hit) continue;
    const m = /^([A-Za-z0-9ÄÖÜäöü][A-Za-z0-9ÄÖÜäöü./\- ]{2,40}?)(?:\s{2,}|$|,|;|\s(?:Datum|vom|Tel|Telefon|Bitte|Kennzeichen)\b)/.exec(hit.value);
    const value = clean((m ? m[1] : hit.value.split(/\s{2,}/)[0]).replace(/[.,;:]$/, ""));
    if (value.length >= 3 && /\d/.test(value)) return { value: value.slice(0, 80), confidence, hint: `hinter „${name}“` };
  }
  return undefined;
}

function letterDate(lines: string[]): string | null {
  for (const l of lines.slice(0, 40)) {
    const m = /(?:^|\s)(?:Datum:?|[A-ZÄÖÜ][a-zäöüß-]+,)\s*(?:den\s*)?(\d{1,2}\.\s?\d{1,2}\.\s?\d{4})\s*$/.exec(clean(l));
    if (m) { const d = DATE.exec(m[1]); if (d) return isoDate(d); }
  }
  return null;
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function detectDeadline(text: string, lines: string[]): Detected | undefined {
  const explicit = /(?:bis\s+(?:zum|spätestens(?:\s+zum)?|einschließlich)|spätestens\s+(?:bis\s+)?(?:zum\s+)?|Frist(?:ende)?\s*:?\s*(?:bis\s*)?(?:zum\s*)?|Rücksendung\s+bis\s+(?:zum\s+)?)\s*(\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4})/i.exec(text);
  if (explicit) {
    const d = DATE.exec(explicit[1]);
    const iso = d ? isoDate(d) : null;
    if (iso) return { value: iso, confidence: "HIGH", hint: "im Schreiben genannt" };
  }
  const rel = /(?:innerhalb|binnen)\s+(?:von\s+)?(einer|zwei|drei|vier|\d{1,2})\s+(Woche|Wochen|Tage|Tagen)/i.exec(text);
  const base = letterDate(lines);
  if (rel && base) {
    const words: Record<string, number> = { einer: 1, zwei: 2, drei: 3, vier: 4 };
    const n = words[rel[1].toLowerCase()] ?? Number(rel[1]);
    const days = /^woche/i.test(rel[2]) ? n * 7 : n;
    return { value: addDays(base, days), confidence: "LOW", hint: `berechnet: Briefdatum + ${rel[1]} ${rel[2]} – bitte prüfen` };
  }
  return undefined;
}

function detectAmount(text: string): Detected | undefined {
  const labels: [RegExp, Confidence][] = [
    [/(?:Gesamtbetrag|zu zahlende[rn]? Betrag|zu zahlen)/gi, "HIGH"],
    [/(?:Verwarnungsgeld|Bußgeld|Geldbuße|Bussgeld)(?!stelle|behörde|verfahren|bescheid)/gi, "MEDIUM"],
  ];
  for (const [label, confidence] of labels) {
    for (const hit of text.matchAll(label)) {
      const start = (hit.index ?? 0) + hit[0].length;
      const m = AMOUNT.exec(text.slice(start, start + 80));
      if (m) return { value: m[1].replace(/\./g, ""), confidence };
    }
  }
  return undefined;
}

function detectType(text: string): Detected | undefined {
  const t = text.toLowerCase();
  if (/rotlicht|lichtzeichenanlage|rote[sn]? (?:ampel|licht)/.test(t)) return { value: "RED_LIGHT", confidence: "MEDIUM" };
  if (/km\/h|geschwindigkeit/.test(t)) return { value: "SPEEDING", confidence: "MEDIUM" };
  if (/parkverstoß|parken|halteverbot|parkschein|parkscheibe|geparkt/.test(t)) return { value: "PARKING", confidence: "MEDIUM" };
  if (/\bmaut|toll collect/.test(t)) return { value: "TOLL", confidence: "MEDIUM" };
  if (/zeugenfragebogen|halteranfrage|fahrerermittlung|fahrzeugführer|auskunft über den fahrer/.test(t)) return { value: "DRIVER_IDENTIFICATION", confidence: "LOW" };
  if (/ordnungswidrigkeit|verkehrsverstoß/.test(t)) return { value: "TRAFFIC_VIOLATION", confidence: "LOW" };
  return undefined;
}

function detectOffenseType(text: string, lines: string[]): Detected | undefined {
  const speed = /(?:um|überschreitung\s*(?:um|von)?)\s*(\d{1,3})\s*km\/h/i.exec(text);
  if (speed) {
    const where = /innerorts|innerhalb geschlossener ortschaften/i.test(text) ? " innerorts" : /außerorts|außerhalb geschlossener ortschaften/i.test(text) ? " außerorts" : "";
    return { value: `${speed[1]} km/h zu schnell${where}`, confidence: "MEDIUM" };
  }
  const hit = afterLabel(lines, /\b(?:Tatvorwurf|Vorwurf|Tatbestand|Verstoß)\s*:/i);
  if (hit) return { value: hit.value.slice(0, 160), confidence: "MEDIUM" };
  return undefined;
}

function detectLocation(lines: string[]): Detected | undefined {
  const hit = afterLabel(lines, /\b(?:Tatort|Ort der Tat|Tatörtlichkeit|Örtlichkeit)\b/i);
  if (!hit) return undefined;
  const value = hit.value.split(/\s{2,}|\s(?:Tatzeit|Tattag|Kennzeichen|Datum)\b/i)[0].replace(/^[:\s]+/, "").trim();
  return value.length >= 3 ? { value: value.slice(0, 200), confidence: "HIGH" } : undefined;
}

function isTenantLine(line: string, ctx: ExtractionContext) {
  const l = line.toLowerCase();
  const name = ctx.tenant.name?.toLowerCase().trim();
  return (!!name && name.length >= 3 && l.includes(name)) || (!!ctx.tenant.zip && l.includes(ctx.tenant.zip)) || (!!ctx.tenant.street && ctx.tenant.street.length >= 5 && l.includes(ctx.tenant.street.toLowerCase()));
}

const normName = (s: string) => s.toLowerCase().replace(/ß/g, "ss").replace(/[\s,.\-–]+/g, " ").trim();
type AuthorityPart = Pick<ExtractionSuggestion, "authorityName" | "authorityDepartment" | "authorityAddress" | "authorityEmail" | "authorityPortalUrl">;

function detectAuthority(text: string, lines: string[], ctx: ExtractionContext): AuthorityPart {
  const out: AuthorityPart = {};
  // 1. bekannte Behörde aus dem Adressbuch (längster Name zuerst) – nur im Fließtext, nicht in E-Mail- oder Webadressen.
  //    Name, Abteilung und Anschrift kommen aus dem Adressbuch (vom Mitarbeiter bestätigt); E-Mail und Portal nur, wenn das
  //    Schreiben selbst keine nennt (Schritt 4) – was im Schreiben steht, hat Vorrang.
  const hay = ` ${normName(text.replace(EMAIL, " ").replace(URL_RE, " ").replace(/\bwww\.\S+/gi, " "))} `;
  const known = [...ctx.contacts].sort((a, b) => b.name.length - a.name.length).find((c) => normName(c.name).length >= 4 && hay.includes(` ${normName(c.name)} `));
  const book = { confidence: "HIGH" as const, hint: "aus dem Behörden-Adressbuch" };
  if (known) {
    out.authorityName = { value: known.name, ...book };
    if (known.department) out.authorityDepartment = { value: known.department, ...book };
    if (known.address) out.authorityAddress = { value: known.address, ...book };
  }
  // 2. Briefkopf: erste Zeile mit typischer Behördenbezeichnung
  const head = lines.slice(0, 40);
  if (!out.authorityName) {
    const idx = head.findIndex((l) => AUTHORITY_WORDS.test(l) && !isTenantLine(l, ctx) && clean(l).length <= 160);
    if (idx >= 0) {
      const line = clean(head[idx]).replace(/\s*[·|•]\s.*$/, "");
      const prev = idx > 0 ? clean(head[idx - 1]) : "";
      // „Freie Hansestadt Bremen“ + „Stadtamt – Bußgeldstelle“ → beides, wenn die Vorzeile der Träger ist
      const carrier = /^(?:Freie(?:\s+und)?\s+Hansestadt|Stadt|Landeshauptstadt|Landkreis|Kreis|Gemeinde|Land)\b/i.test(prev) && prev.length <= 60 && !AUTHORITY_WORDS.test(prev);
      out.authorityName = { value: (carrier ? `${prev}, ${line}` : line).slice(0, 160), confidence: "MEDIUM", hint: "aus dem Briefkopf" };
    }
  }
  // 3. Anschrift: erste PLZ-Zeile im Briefkopf außerhalb des eigenen Empfängerblocks, mit Straße/Postfach davor
  if (!out.authorityAddress) {
    for (let i = 0; i < head.length; i++) {
      const l = clean(head[i]);
      const plz = /\b(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{1,40})$/.exec(l);
      if (!plz || isTenantLine(l, ctx) || (i > 0 && isTenantLine(head[i - 1], ctx)) || (i > 1 && isTenantLine(head[i - 2], ctx))) continue;
      const street = i > 0 ? clean(head[i - 1]) : "";
      const streetOk = /(?:str\.|straße|strasse|weg|platz|allee|ring|damm|ufer|markt|Postfach)\b|\s\d+\s?[a-z]?$/i.test(street) && street.length <= 80 && !AUTHORITY_WORDS.test(street);
      const plzLine = l.slice(plz.index);
      out.authorityAddress = { value: streetOk ? `${street}\n${plzLine}` : plzLine, confidence: streetOk ? "MEDIUM" : "LOW", hint: "aus dem Briefkopf – bitte prüfen" };
      break;
    }
  }
  // 4. E-Mail und Portal (nie die eigene Adresse)
  if (!out.authorityEmail) {
    const own = ctx.tenant.email?.toLowerCase() ?? "";
    const ownDomain = own.split("@")[1] ?? "";
    const email = [...text.matchAll(EMAIL)].map((m) => m[0].replace(/[.,;]$/, "")).find((e) => e.toLowerCase() !== own && (!ownDomain || !e.toLowerCase().endsWith(`@${ownDomain}`)));
    if (email) out.authorityEmail = { value: email, confidence: "MEDIUM", hint: "im Schreiben gefunden – nur übernehmen, wenn die Behörde sie als Antwortweg nennt" };
  }
  if (!out.authorityPortalUrl) {
    const urls = [...text.matchAll(URL_RE)].map((m) => ({ url: m[0].replace(/[.,;]$/, ""), pos: m.index ?? 0 }));
    const near = urls.find((u) => /online|portal|anhörung|internet|elektronisch|webseite|website/i.test(text.slice(Math.max(0, u.pos - 120), u.pos)));
    const pick = near ?? (urls.length === 1 ? urls[0] : undefined);
    if (pick) out.authorityPortalUrl = { value: pick.url.slice(0, 300), confidence: near ? "MEDIUM" : "LOW", hint: "im Schreiben gefunden" };
  }
  // 5. Adressbuch ergänzt, was das Schreiben nicht nennt
  if (known?.email && !out.authorityEmail) out.authorityEmail = { value: known.email, ...book };
  if (known?.portalUrl && !out.authorityPortalUrl) out.authorityPortalUrl = { value: known.portalUrl, ...book };
  return out;
}

/** Erkennt Vorschläge aus dem Text eines Behördenschreibens. Unbekanntes bleibt leer – lieber nichts als etwas Falsches. */
export function parseAuthorityLetter(raw: string, ctx: ExtractionContext): ExtractionSuggestion {
  const text = raw.replace(/\r/g, "").replace(/ /g, " ");
  if (clean(text).length < 20) return {};
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+/g, " "));
  const s: ExtractionSuggestion = {};
  const plate = detectPlate(text, ctx); if (plate) s.licensePlate = plate;
  const { date, time } = detectOffenseDateTime(text);
  if (date) s.offenseDate = date;
  if (time) s.offenseTime = time;
  const ref = detectReference(lines); if (ref) s.authorityReference = ref;
  const loc = detectLocation(lines); if (loc) s.offenseLocation = loc;
  const deadline = detectDeadline(text, lines); if (deadline) s.responseDeadline = deadline;
  const amount = detectAmount(text); if (amount) s.noticeAmount = amount;
  const type = detectType(text); if (type) s.type = type;
  const offenseType = detectOffenseType(text, lines); if (offenseType) s.offenseType = offenseType;
  Object.assign(s, detectAuthority(text, lines, ctx));
  return s;
}

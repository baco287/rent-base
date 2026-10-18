// Befehl 29.6: reine Zuordnungsfunktionen des Mietvertragsassistenten (ohne JSX, ohne Datenbank, testbar).
// Keine Preis- oder Tarifberechnung: Beträge und Texte kommen unverändert aus dem Vertragsdokument (doc) bzw. dem Vertrag;
// hier wird nur ausgewählt, gruppiert und Datumswerte formatiert.
import type { ContractDocument, DocRow } from "@/lib/contract-view";
import type { Issue } from "@/lib/contract-checks";
import type { FieldIssue } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

// ---------------------------------------------------------------- Vertragsübersicht (Schritte 1–5)

export type OverviewLine = { text: string; amount: string };
export type OverviewData = {
  vehicle: { plate: string; title: string };
  period: { from: string; to: string; duration: string };
  tariff: string;
  price: { lines: OverviewLine[]; discount: OverviewLine | null; agreed: OverviewLine | null; extras: OverviewLine[]; total: string; openEnd: boolean; perDay: string | null; totalNote: string | null };
  outside: DocRow[];
};

/** Tarifzeile der Übersicht (nur Anzeige; Name und Revision aus dem eingefrorenen Snapshot der Buchung). */
export function tariffLabel(x: { ratePlanId: string | null; snapshot: { ratePlanName: string; revision: number } | null; accident: boolean }): string {
  if (x.accident) return "Tarif der Fallakte";
  if (x.ratePlanId) return x.snapshot ? `${x.snapshot.ratePlanName} · Rev. ${x.snapshot.revision}` : "Miettarif laut Buchung (Stufen nicht verfügbar)";
  return "ohne Miettarif (Altbuchung)";
}

const KAUTION = new Set(["Kaution", "Vereinbarte Kaution"]);
const SB = new Set(["Selbstbeteiligung", "Vereinbarte Selbstbeteiligung im Schadenfall"]);
const conditionsOf = (doc: ContractDocument) => doc.sections.find((s) => s.key === "conditions")?.rows ?? [];

/** Kaution und Selbstbeteiligung: die Zeilen der Konditionen mit Originallabel und -wert (nicht Teil des Mietpreises). */
export function outsideRows(doc: ContractDocument): DocRow[] {
  const rows = conditionsOf(doc);
  return [rows.find((r) => KAUTION.has(r.label)), rows.find((r) => SB.has(r.label))].filter((r): r is DocRow => !!r);
}

export function buildOverviewData(doc: ContractDocument, contract: { startAt: Date; endAt: Date | null }, extras: { tariff: string }): OverviewData {
  const p = doc.price;
  return {
    vehicle: { plate: doc.plate, title: doc.vehicleTitle },
    period: { from: fmtDateTime(contract.startAt), to: contract.endAt ? fmtDateTime(contract.endAt) : "offen – bis zur Rückgabe", duration: p.durationText },
    tariff: extras.tariff,
    price: {
      lines: p.lines.map((l) => ({ text: l.text, amount: l.amount })),
      discount: p.discount,
      // kurz: der vollständige Text (mit Notiz) steht in Schritt 6
      agreed: p.agreed ? { text: "Abweichend vereinbart", amount: p.agreed.amount } : null,
      extras: p.extras.map((e) => ({ text: e.text, amount: e.amount })),
      total: p.total,
      openEnd: p.openEnd,
      perDay: p.openEnd ? `${p.subtotal} je Miettag` : null,
      totalNote: p.totalNote,
    },
    outside: outsideRows(doc),
  };
}

// ---------------------------------------------------------------- Bereitschaft (Schritte 6 und 7)

export type ReadinessRow = { label: string; text: string; state: "ok" | "open" | "na" };
const errorsIn = (issues: Issue[], areas: Issue["area"][]) => issues.filter((i) => i.severity === "error" && areas.includes(i.area)).length;
const openText = (n: number) => (n === 0 ? "vollständig" : n === 1 ? "1 Punkt offen" : `${n} Punkte offen`);

export function buildReadiness(issues: Issue[], terms: { selected: unknown; acknowledged: unknown }, hasRenterSig: boolean, step = 6): ReadinessRow[] {
  const group = (label: string, areas: Issue["area"][]): ReadinessRow => {
    const n = errorsIn(issues, areas);
    return { label, text: openText(n), state: n === 0 ? "ok" : "open" };
  };
  return [
    group("Mieter", ["CUSTOMER"]),
    group("Fahrer", ["DRIVER", "ADDITIONAL_DRIVER"]),
    group("Fahrzeug & Zeitraum", ["VEHICLE", "PERIOD"]),
    group("Preis & Konditionen", ["PRICE", "CONDITIONS"]),
    terms.acknowledged ? { label: "Kenntnisnahme Mietbedingungen", text: "bestätigt", state: "ok" } : terms.selected ? { label: "Kenntnisnahme Mietbedingungen", text: step >= 7 ? "fehlt" : "folgt in Schritt 7", state: "open" } : { label: "Kenntnisnahme Mietbedingungen", text: "nicht erforderlich", state: "na" },
    hasRenterSig ? { label: "Unterschrift Mieter", text: "erfasst", state: "ok" } : { label: "Unterschrift Mieter", text: "fehlt", state: "open" },
  ];
}

// ---------------------------------------------------------------- Schritt 6: Dokumentzeilen auf Karten verteilen

export type DocCardKey = "renter" | "driver" | "vehicle" | "period" | "price" | "km" | "deposit" | "abroad" | "additional" | "other";
export type RowGroup = { source: "section" | "conditions" | "rules"; title: string; rows: DocRow[] };
export type GroupedDocument = {
  cards: Record<DocCardKey, { subtitle?: string; groups: RowGroup[] }>;
  /** E5: Zeilen der Geschäftsregeln, die mit gleichem Label und Wert bereits bei den Konditionen stehen (nur Selbstbeteiligung, Tankregelung) */
  merged: { row: DocRow; keptAs: string }[];
};
/** E5 – nur diese Labels werden bei gleichem Wert zusammengeführt (die Konditionszeile bleibt). */
export const E5_MERGE_LABELS = ["Selbstbeteiligung", "Tankregelung"] as const;

const CONDITIONS_CARD: Record<string, DocCardKey> = {
  Miettarif: "price",
  Kaution: "deposit", "Vereinbarte Kaution": "deposit",
  Selbstbeteiligung: "deposit", "Vereinbarte Selbstbeteiligung im Schadenfall": "deposit",
  Kilometer: "km", Freikilometer: "km", Mehrkilometer: "km", Tankregelung: "km", "Preis je fehlendem Liter": "km",
};
const RULES_CARD: Record<string, DocCardKey> = {
  Kilometerregel: "km", Tankregelung: "km", Laderegel: "km", "Tank- und Laderegel": "km", "Rauchen im Fahrzeug": "km", "Tiere im Fahrzeug": "km",
  Selbstbeteiligung: "deposit",
  Auslandsfahrten: "abroad",
  Zusatzfahrer: "additional",
};
const SECTION_CARD: Record<string, DocCardKey> = { renter: "renter", driver: "driver", vehicle: "vehicle", period: "period" };

export function groupDocumentRows(doc: ContractDocument): GroupedDocument {
  const keys: DocCardKey[] = ["renter", "driver", "vehicle", "period", "price", "km", "deposit", "abroad", "additional", "other"];
  const cards = Object.fromEntries(keys.map((k) => [k, { groups: [] as RowGroup[] }])) as GroupedDocument["cards"];
  const merged: GroupedDocument["merged"] = [];
  const push = (card: DocCardKey, source: RowGroup["source"], title: string, row: DocRow) => {
    const groups = cards[card].groups;
    let g = groups.find((x) => x.source === source && x.title === title);
    if (!g) groups.push((g = { source, title, rows: [] }));
    g.rows.push(row);
  };
  const conditions = doc.sections.find((s) => s.key === "conditions");
  for (const s of doc.sections) {
    if (s.key === "conditions") continue;
    const card = SECTION_CARD[s.key] ?? "other";
    if (s.key === "driver") cards.driver.subtitle = s.title;
    for (const r of s.rows) push(card, "section", s.title, r);
  }
  for (const r of conditions?.rows ?? []) push(CONDITIONS_CARD[r.label] ?? "other", "conditions", conditions!.title, r);
  if (doc.rules) {
    for (const r of doc.rules.rows) {
      const twin = (E5_MERGE_LABELS as readonly string[]).includes(r.label) ? conditions?.rows.find((c) => c.label === r.label && c.value === r.value) : undefined;
      if (twin) { merged.push({ row: r, keptAs: `${conditions!.title}: ${twin.label}` }); continue; }
      push(RULES_CARD[r.label] ?? "other", "rules", doc.rules.title, r);
    }
  }
  return { cards, merged };
}

// ---------------------------------------------------------------- Schritt 6: Ziele der „Bearbeiten“-Links

export type EditTarget = { href: string; text: "Bearbeiten" | "In der Buchung ändern" | "In der Fallakte ändern" } | null;
export type EditCardKey = DocCardKey | "agreements" | "terms";

/** Ein Link führt dorthin, wo mindestens ein Wert der Karte änderbar ist (Schritt 6 hat keine Eingaben – nichts geht verloren). */
export function editTargets(x: { bookingId: string; tariffLocked: boolean; deductibleLocked: boolean; abroadLocked: boolean; accident: boolean; caseHref: string | null }): Record<EditCardKey, EditTarget> {
  const step = (n: number, anchor?: string): EditTarget => ({ href: `/buchungen/${x.bookingId}/vertrag?schritt=${n}${anchor ? `#${anchor}` : ""}`, text: "Bearbeiten" });
  const booking: EditTarget = { href: `/buchungen/${x.bookingId}`, text: "In der Buchung ändern" };
  const fallakte: EditTarget = x.caseHref ? { href: x.caseHref, text: "In der Fallakte ändern" } : null;
  return {
    renter: step(1),
    driver: step(2),
    vehicle: booking,
    period: step(4, "k4-a"),
    price: x.accident ? fallakte : x.tariffLocked ? booking : step(4, "k4-c"),
    km: step(4, "k4-e"),
    deposit: x.tariffLocked && x.deductibleLocked ? booking : step(4, "k4-d"),
    abroad: x.abroadLocked ? booking : step(4, "k4-f"),
    additional: step(5),
    other: null,
    agreements: step(4, "k4-g"),
    terms: null,
  };
}

// ---------------------------------------------------------------- Feldhinweise aus den vorhandenen Prüfergebnissen (E2)

type Target = { fields?: string[]; card?: string };
const CUSTOMER_TARGETS: Record<string, Target> = {
  CUSTOMER_COMPANY: { fields: ["companyName"] }, CUSTOMER_FIRSTNAME: { fields: ["firstName"] }, CUSTOMER_LASTNAME: { fields: ["lastName"] },
  CUSTOMER_CONTACT: { fields: ["phone", "email"] }, CUSTOMER_PHONE: { fields: ["phone"] }, CUSTOMER_EMAIL: { fields: ["email"] },
  CUSTOMER_STREET: { fields: ["street"] }, CUSTOMER_ZIP: { fields: ["zip"] }, CUSTOMER_CITY: { fields: ["city"] }, CUSTOMER_COUNTRY: { fields: ["country"] },
  CUSTOMER_BIRTHDATE: { fields: ["birthDate"] }, CUSTOMER_ID: { fields: ["idNumber"] },
  CUSTOMER_ID_VALIDITY: { fields: ["idValidUntil"] }, CUSTOMER_ID_EXPIRED: { fields: ["idValidUntil"] },
  // CUSTOMER_BLOCKED: nur Kopf und Hinweis oben
};
const DRIVER_TARGETS: Record<string, Target> = {
  DRIVER_NAME: { fields: ["d_firstName", "d_lastName"] }, DRIVER_BIRTHDATE: { fields: ["d_birthDate"] }, DRIVER_UNDERAGE: { fields: ["d_birthDate"] },
  DRIVER_ADDRESS: { fields: ["d_street", "d_zip", "d_city"] }, LICENSE_NUMBER: { fields: ["d_licenseNumber"] }, LICENSE_CLASS: { fields: ["d_licenseClass"] },
  LICENSE_ISSUED: { fields: ["d_licenseIssuedAt"] }, LICENSE_TOO_NEW: { fields: ["d_licenseIssuedAt"] }, LICENSE_NOT_YET_VALID: { fields: ["d_licenseIssuedAt"] }, LICENSE_BEFORE_BIRTH: { fields: ["d_licenseIssuedAt"] },
  LICENSE_VALIDITY: { fields: ["d_licenseValidUntil"] }, LICENSE_EXPIRED: { fields: ["d_licenseValidUntil"] }, LICENSE_COUNTRY: { fields: ["d_licenseCountry"] },
  DRIVER_MISSING: { card: "fahrer-anders" },
};
function conditionsTarget(i: Issue): Target | null {
  switch (i.code) {
    case "FUEL_NOTE": return { fields: ["fuelPolicyNote"] };
    case "PICKUP_LOCATION": return { fields: ["pickupLocation"] };
    case "NEGATIVE_VALUE": return { card: i.message.startsWith("Mehrkilometerpreis") ? "k4-e" : "k4-d" };
    case "RULES_INCONSISTENT": case "RULES_MISSING": return { card: /Ausland|Länder/.test(i.message) ? "k4-f" : "k4-e" };
    case "ABROAD_MISMATCH": return { card: "k4-f" };
    case "TARIFF_MISSING": return { card: "k4-c" };
    default: return i.code.startsWith("PRICE_") ? { card: "k4-c" } : null; // NUMBER_MISSING, TERMS_*, RULES_NEWER: nur im Banner
  }
}

export type FieldIssueMap = { fields: Record<string, FieldIssue>; cards: Record<string, Issue[]> };

/**
 * Prüfcodes → Feld bzw. Kartenkopf. area: CUSTOMER (Schritt 1), DRIVER (Schritt 2, nur wenn der gespeicherte Modus OTHER ist und
 * kein ?vonKunde vorbelegt – die Prüfung bezieht sich auf den gespeicherten Fahrer), CONDITIONS/PRICE (Schritt 4).
 * Eine Meldung, die mehrere Felder betrifft, steht einmal (am ersten Feld) und ist an allen per aria-describedby verknüpft.
 */
export function fieldIssues(issues: Issue[], area: "CUSTOMER" | "DRIVER" | "CONDITIONS", opts: { enabled?: boolean } = {}): FieldIssueMap {
  const out: FieldIssueMap = { fields: {}, cards: {} };
  if (opts.enabled === false) return out;
  const relevant = issues.filter((i) => (area === "CONDITIONS" ? i.area === "CONDITIONS" || i.area === "PRICE" : i.area === area));
  relevant.forEach((i, n) => {
    const t = area === "CUSTOMER" ? CUSTOMER_TARGETS[i.code] : area === "DRIVER" ? DRIVER_TARGETS[i.code] : conditionsTarget(i);
    if (!t) return;
    if (t.card) (out.cards[t.card] ??= []).push(i);
    const fields = t.fields ?? [];
    const id = `hinweis-${fields[0] ?? t.card}-${n}`;
    const error = i.severity === "error";
    fields.forEach((f, k) => {
      const cur = (out.fields[f] ??= { describedBy: "", error: false, messages: [] });
      cur.describedBy = [cur.describedBy, id].filter(Boolean).join(" ");
      cur.error = cur.error || error;
      if (k === 0) cur.messages.push({ id, text: i.message, error });
    });
  });
  return out;
}

/** Chip „Fahrerprüfung“ in Schritt 2 – nur aus dem gespeicherten Stand, keine eigene Datumslogik. */
export function driverCheckState(x: { savedMode: string; prefill: boolean; issues: Issue[] }): "valid" | "check" | "pending" {
  if (x.prefill || x.savedMode !== "RENTER") return "pending";
  return x.issues.some((i) => i.area === "DRIVER" && i.severity === "error") ? "check" : "valid";
}

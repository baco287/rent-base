// Gemeinsame Protokolldarstellung (ViewModel) für Übergabe und Rückgabe.
// Zusammenfassung im Assistenten, Anzeige des finalisierten Protokolls und später das PDF entstehen alle
// aus dieser einen Struktur. Sie liest ausschließlich die im Protokoll gespeicherten Kopien.

import type { Prisma } from "@prisma/client";
import type { LandlordInfo } from "@/lib/contract-view";
import { APP_TIME_ZONE } from "@/lib/time";
import type { ReturnComparison } from "@/lib/returns";

/** "2 Std. 47 Min." aus Minuten. Liegt hier, weil diese Datei bewusst frei von Server-Abhängigkeiten bleibt. */
export function fmtMinutes(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} Std. ${m} Min.` : `${m} Min.`;
}
import { DAMAGE_KINDS, DAMAGE_SEVERITY, DAMAGE_VIEWS, FUELS, PHOTO_CATEGORIES, RETURN_ATTENTION_ON_YES, energyRequirements, IDENTITY_DOCUMENT_TYPES } from "@/lib/constants";

/** Alle Skizzendateien verwenden ein 1000 Einheiten breites Zeichenfeld; die Rahmen der Ansichten beziehen sich darauf. */
export const SKETCH_CANVAS_WIDTH = 1000;

export type SketchView = { key: string; label: string; box: [number, number, number, number] };
export type SketchInfo = { assetPath: string; version: number; name: string; views: SketchView[] };

/** Symbol des Markers: Kreis = vor der Miete bekannt, Raute = bei Übergabe dokumentierter Vorschaden, Dreieck = bei Rückgabe festgestellt. */
export type DamageSymbol = "circle" | "diamond" | "triangle";

export type DocDamage = {
  id: string;
  index: number; // fortlaufende Nummer auf Skizze und in der Liste
  marker: "EXISTING" | "PICKUP_NEW" | "NEW";
  symbol: DamageSymbol;
  markerLabel: string;
  view: string;
  viewLabel: string;
  posX: number;
  posY: number;
  kind: string;
  kindLabel: string;
  severity: string;
  severityLabel: string;
  size: string | null;
  description: string;
  photos: { id: string; url: string }[];
};

/** Vertrags- und Vermieterbezug des Protokolls. Stammt aus der versiegelten Vertragskopie, nie aus Live-Stammdaten. */
export type HandoverContext = {
  landlord: LandlordInfo;
  contractNumber: string | null;
  bookingNumber: string;
  renterName: string;
  renterNumber: string | null;
  vehicleTitle: string;
  plate: string;
  vehicleGroup: string | null;
};

/** Nur Rückgabe: der Vergleich mit der Übergabe und die bestätigten Zusatzkosten, alles aus Snapshots. */
export type DocComparison = {
  pickupNumber: string;
  rows: { label: string; pickup: string; ret: string; diff: string; attention: boolean }[];
  time: { start: string; plannedEnd: string; actualEnd: string; late: string | null; rentalDays: number };
  mileageBasis: string | null; // z. B. "200 km je Tag, 1.200 km frei"
  fuelPolicy: string;
  hints: string[];
  charges: { typeLabel: string; description: string; quantity: string; unitPrice: string; amount: string; formula: string; damageIndex: number | null; source: string }[];
  chargesTotal: string;
  deposit: string;
  deductible: string;
};

/** Fahrerprüfung für die Dokumentanzeige (Phase 19.5): nie Bilder, nie die volle Führerscheinnummer. */
export type DocDriverCheck = {
  role: string;
  roleLabel: string;
  name: string;
  statusLabel: string;
  identityDocumentLabel: string | null;
  identityOriginalSeen: boolean;
  identityMatched: boolean | null;
  licenseOriginalSeen: boolean;
  licenseValid: boolean | null;
  requiredLicenseClass: string | null;
  licenseClasses: string[];
  licenseClassSatisfied: boolean | null;
  validUntilLabel: string | null;
  checkedAtLabel: string | null;
  checkedByName: string | null;
};

/**
 * Befehl 20.6: Angaben des Kunden bei kontaktloser Rückgabe (versiegelt, aus KeyDropReturn) – im Protokoll getrennt von der
 * nachträglichen Kontrolle durch den Mitarbeiter dargestellt. Der Kunde unterschreibt nie unter die Kontrollfeststellungen.
 */
export type DocKeyDrop = {
  label: string;
  agreedLocation: string;
  customerRows: { label: string; value: string }[];
  confirmedAt: string | null;
  signerName: string | null;
  confirmationText: string | null;
  signatureId: string | null;
  photos: { id: string; url: string; caption: string }[];
  exceptionReason: string | null;
};

export type HandoverDocument = {
  context: HandoverContext | null;
  /** Befehl 20.6: nur bei kontaktloser Rückgabe */
  keyDrop: DocKeyDrop | null;
  returnMode: "IN_PERSON" | "KEY_DROP" | null;
  comparison: DocComparison | null;
  driverChecks: DocDriverCheck[];
  title: string;
  number: string;
  type: "PICKUP" | "RETURN";
  status: string;
  startedAt: string;
  finalizedAt: string | null;
  employeeName: string;
  contentHash: string | null;
  readings: { label: string; value: string; missing: boolean }[];
  notes: string | null;
  sketch: SketchInfo | null;
  damages: DocDamage[];
  checklist: { label: string; result: string; ok: boolean | null; note: string | null; missing: boolean }[];
  photos: { id: string; url: string; category: string; categoryLabel: string }[];
  missingPhotoCategories: string[];
  signatures: { id: string; role: string; roleLabel: string; signerName: string; signedAt: string; imageUrl: string }[];
};

/** Name laut Auftrag: die Dokumentdaten der Übergabe. HTML-Ansicht und PDF lesen ausschließlich diese Struktur. */
export type HandoverDocumentData = HandoverDocument;

const dateTime = (v: Date | null | undefined) => (v ? v.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const label = <T extends Record<string, string>>(map: T, key: string) => (key in map ? map[key as keyof T] : key);

const RESULT_LABEL: Record<string, string> = { OK: "In Ordnung", NOT_OK: "Nicht in Ordnung", YES: "Ja", NO: "Nein", NA: "Nicht zutreffend" };

export function parseSketch(sketch: { assetPath: string; version: number; name: string; views: Prisma.JsonValue } | null): SketchInfo | null {
  if (!sketch || !Array.isArray(sketch.views)) return null;
  const views = (sketch.views as unknown[]).flatMap((v) => {
    const o = v as { key?: unknown; label?: unknown; box?: unknown };
    if (typeof o?.key !== "string" || typeof o.label !== "string" || !Array.isArray(o.box) || o.box.length !== 4) return [];
    return [{ key: o.key, label: o.label, box: o.box.map(Number) as [number, number, number, number] }];
  });
  return { assetPath: sketch.assetPath, version: sketch.version, name: sketch.name, views };
}

type HandoverFull = Prisma.HandoverGetPayload<{ include: { damages: true; checklistItems: true; photos: true } }>;
type SignatureLike = { id: string; role: string; signerName: string; signedAt: Date };

export function symbolFor(marker: string, type: string): DamageSymbol {
  if (marker === "NEW") return type === "PICKUP" ? "diamond" : "triangle";
  if (marker === "PICKUP_NEW") return "diamond";
  return "circle";
}

export function markerLabelFor(marker: string, type: string): string {
  if (marker === "NEW") return type === "PICKUP" ? "Neu entdeckt (Vorschaden)" : "Bei Rückgabe festgestellt";
  if (marker === "PICKUP_NEW") return "Bei Übergabe dokumentierter Vorschaden";
  return type === "PICKUP" ? "Bereits dokumentiert" : "Vor Mietbeginn dokumentiert";
}

const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });

/** Vergleichsteil des Rückgabeprotokolls aus dem serverseitigen Vergleich (returns.ts). */
export function buildDocComparison(c: ReturnComparison, damages: DocDamage[]): DocComparison {
  const fmt = (v: number | null, unit: string) => (v == null ? "–" : `${v.toLocaleString("de-DE")} ${unit}`);
  const sign = (v: number | null, unit: string) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toLocaleString("de-DE")} ${unit}`);
  const rows: DocComparison["rows"] = [
    { label: "Kilometerstand", pickup: fmt(c.mileage.pickup, "km"), ret: fmt(c.mileage.return, "km"), diff: c.mileage.driven == null ? "–" : `${c.mileage.driven.toLocaleString("de-DE")} km gefahren`, attention: c.mileage.driven != null && c.mileage.driven < 0 },
  ];
  if (c.fuel) rows.push({ label: "Tankstand", pickup: c.fuel.pickup == null ? "–" : `${c.fuel.pickup}/8`, ret: c.fuel.return == null ? "–" : `${c.fuel.return}/8`, diff: c.fuel.diff == null ? "–" : `${c.fuel.diff > 0 ? "+" : c.fuel.diff < 0 ? "−" : "±"}${Math.abs(c.fuel.diff)}/8`, attention: (c.fuel.diff ?? 0) < 0 });
  if (c.battery) rows.push({ label: "Batteriestand", pickup: fmt(c.battery.pickup, "%"), ret: fmt(c.battery.return, "%"), diff: c.battery.diff == null ? "–" : `${sign(c.battery.diff, "Prozentpunkte")}`, attention: (c.battery.diff ?? 0) < 0 });
  const indexOf = (handoverDamageId: string | null) => damages.find((d) => d.id === handoverDamageId)?.index ?? null;
  return {
    pickupNumber: c.pickup.number,
    rows,
    time: { start: dateTime(c.time.start), plannedEnd: dateTime(c.time.plannedEnd), actualEnd: dateTime(c.time.actualEnd), late: c.time.lateMinutes > 15 ? fmtMinutes(c.time.lateMinutes) : null, rentalDays: c.time.rentalDays },
    mileageBasis: `${c.contract.kmIncludedPerDay.toLocaleString("de-DE")} km je Tag, ${c.contract.includedKm.toLocaleString("de-DE")} km frei, Mehrkilometer ${eur(c.contract.extraKmRate)} je km`,
    fuelPolicy: c.contract.fuelPolicy === "OTHER" ? `${c.contract.fuelPolicyLabel}: ${c.contract.fuelPolicyNote ?? ""}` : c.contract.fuelPolicyLabel,
    hints: c.hints.map((x) => x.text),
    charges: c.charges.map((x) => ({ typeLabel: x.typeLabel, description: x.description, quantity: `${x.quantity.toLocaleString("de-DE")} ${x.unit}`, unitPrice: eur(x.unitPrice), amount: eur(x.amount), formula: x.formula, damageIndex: indexOf(x.handoverDamageId), source: x.source })),
    chargesTotal: eur(c.chargesTotal),
    deposit: eur(c.contract.deposit),
    deductible: eur(c.contract.deductible),
  };
}

/** Eingabeform der Fahrerprüfungen (siehe lib/driver-verification.ts DriverCheckSummary) – hier lose typisiert, damit diese Datei frei von Server-Abhängigkeiten bleibt. */
type DriverCheckInput = {
  role: string; name: string; status: string; identityDocumentType: string | null; identityOriginalSeen: boolean; identityMatched: boolean | null;
  licenseOriginalSeen: boolean; licenseValid: boolean | null; requiredLicenseClass: string | null; licenseClasses: string[]; licenseClassSatisfied: boolean | null;
  validUntil: string | null; checkedAt: string | null; checkedByName: string | null;
};

export function buildHandoverDocument(h: HandoverFull, sketch: Parameters<typeof parseSketch>[0], signatures: SignatureLike[], requiredPhotoCategories: string[], context: HandoverContext | null = null, comparison: ReturnComparison | null = null, driverChecks: DriverCheckInput[] = [], keyDrop: DocKeyDrop | null = null): HandoverDocument {
  const energy = energyRequirements(h.driveType);
  const readings = [
    { label: "Kilometerstand", value: h.mileage != null ? `${h.mileage.toLocaleString("de-DE")} km` : "", missing: h.mileage == null },
    { label: "Antrieb", value: label(FUELS, h.driveType), missing: false },
    ...(energy.fuel ? [{ label: "Tankstand", value: h.fuelLevelEighths != null ? `${h.fuelLevelEighths}/8` : "", missing: h.fuelLevelEighths == null }] : []),
    ...(energy.battery ? [{ label: "Batteriestand", value: h.batteryPercent != null ? `${h.batteryPercent} %` : "", missing: h.batteryPercent == null }] : []),
  ];

  const photosById = new Map(h.photos.map((p) => [p.id, p]));
  const sorted = [...h.damages].sort((a, b) => a.sortOrder - b.sortOrder);
  const damages: DocDamage[] = sorted.map((d, i) => {
    const refs = Array.isArray(d.photoRefs) ? (d.photoRefs as { photoId?: string }[]) : [];
    return {
      id: d.id,
      index: i + 1,
      marker: d.marker === "NEW" ? "NEW" : d.marker === "PICKUP_NEW" ? "PICKUP_NEW" : "EXISTING",
      symbol: symbolFor(d.marker, h.type),
      markerLabel: markerLabelFor(d.marker, h.type),
      view: d.view,
      viewLabel: label(DAMAGE_VIEWS, d.view),
      posX: d.posX,
      posY: d.posY,
      kind: d.kind,
      kindLabel: label(DAMAGE_KINDS, d.kind),
      severity: d.severity,
      severityLabel: label(DAMAGE_SEVERITY, d.severity),
      size: d.size,
      description: d.description,
      // Fotoverweise stammen aus der Kopie im Protokoll; angezeigt wird über die geschützte Adresse
      photos: refs.flatMap((r) => (r.photoId ? [{ id: r.photoId, url: `/api/photos/${r.photoId}` }] : [])),
    };
  });

  const general = h.photos.filter((p) => !p.handoverDamageId && photosById.has(p.id));
  const have = new Set(general.map((p) => p.category));

  return {
    context,
    keyDrop,
    returnMode: (h.returnMode as "IN_PERSON" | "KEY_DROP" | null) ?? null,
    comparison: comparison ? buildDocComparison(comparison, damages) : null,
    driverChecks: driverChecks.map((d) => ({
      role: d.role,
      roleLabel: d.role === "PRIMARY_DRIVER" ? "Hauptfahrer" : "Zusatzfahrer",
      name: d.name,
      statusLabel: d.status === "CONFIRMED" ? "Bestätigt" : d.status === "BLOCKED" ? "Blockiert" : d.status === "IN_PROGRESS" ? "In Prüfung" : "Nicht geprüft",
      identityDocumentLabel: d.identityDocumentType ? label(IDENTITY_DOCUMENT_TYPES, d.identityDocumentType) : null,
      identityOriginalSeen: d.identityOriginalSeen,
      identityMatched: d.identityMatched,
      licenseOriginalSeen: d.licenseOriginalSeen,
      licenseValid: d.licenseValid,
      requiredLicenseClass: d.requiredLicenseClass,
      licenseClasses: d.licenseClasses,
      licenseClassSatisfied: d.licenseClassSatisfied,
      validUntilLabel: d.validUntil ? dateTime(new Date(d.validUntil)).split(",")[0] : null,
      checkedAtLabel: d.checkedAt ? dateTime(new Date(d.checkedAt)) : null,
      checkedByName: d.checkedByName,
    })),
    title: h.type === "PICKUP" ? "Übergabeprotokoll" : "Rückgabeprotokoll",
    number: h.number,
    type: h.type === "RETURN" ? "RETURN" : "PICKUP",
    status: h.status,
    startedAt: dateTime(h.startedAt),
    finalizedAt: h.finalizedAt ? dateTime(h.finalizedAt) : null,
    employeeName: h.employeeName,
    contentHash: h.contentHash,
    readings,
    notes: h.notes,
    sketch: parseSketch(sketch),
    damages,
    checklist: [...h.checklistItems]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        label: c.label,
        result: c.result ? RESULT_LABEL[c.result] ?? c.result : "",
        // ok = false heißt auffällig; bei "ungewöhnlich verschmutzt" ist das Ja die Auffälligkeit
        ok: RETURN_ATTENTION_ON_YES.has(c.itemKey) ? (c.result === "YES" ? false : c.result === "NO" ? true : null) : c.result === "OK" || c.result === "YES" ? true : c.result === "NOT_OK" || c.result === "NO" ? false : null,
        note: c.note,
        missing: c.required && !c.result,
      })),
    photos: general.map((p) => ({ id: p.id, url: `/api/photos/${p.id}`, category: p.category, categoryLabel: label(PHOTO_CATEGORIES, p.category) })),
    missingPhotoCategories: requiredPhotoCategories.filter((c) => !have.has(c)).map((c) => label(PHOTO_CATEGORIES, c)),
    signatures: signatures.map((s) => ({ id: s.id, role: s.role, roleLabel: s.role === "RENTER" ? "Mieter" : "Vermieter", signerName: s.signerName, signedAt: dateTime(s.signedAt), imageUrl: `/api/signatures/${s.id}` })),
  };
}

// Gemeinsame Protokolldarstellung (ViewModel) für Übergabe und Rückgabe.
// Zusammenfassung im Assistenten, Anzeige des finalisierten Protokolls und später das PDF entstehen alle
// aus dieser einen Struktur. Sie liest ausschließlich die im Protokoll gespeicherten Kopien.

import type { Prisma } from "@prisma/client";
import { DAMAGE_KINDS, DAMAGE_SEVERITY, DAMAGE_VIEWS, FUELS, PHOTO_CATEGORIES, energyRequirements } from "@/lib/constants";

/** Alle Skizzendateien verwenden ein 1000 Einheiten breites Zeichenfeld; die Rahmen der Ansichten beziehen sich darauf. */
export const SKETCH_CANVAS_WIDTH = 1000;

export type SketchView ={ key: string; label: string; box: [number, number, number, number] };
export type SketchInfo = { assetPath: string; version: number; name: string; views: SketchView[] };

export type DocDamage = {
  id: string;
  index: number; // fortlaufende Nummer auf Skizze und in der Liste
  marker: "EXISTING" | "NEW";
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

export type HandoverDocument = {
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
  signatures: { role: string; roleLabel: string; signerName: string; signedAt: string; imageUrl: string }[];
};

const dateTime = (v: Date | null | undefined) => (v ? v.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const label = <T extends Record<string, string>>(map: T, key: string) => (key in map ? map[key as keyof T] : key);

const RESULT_LABEL: Record<string, string> = { OK: "In Ordnung", NOT_OK: "Nicht in Ordnung", YES: "Ja", NO: "Nein" };

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

export function buildHandoverDocument(h: HandoverFull, sketch: Parameters<typeof parseSketch>[0], signatures: SignatureLike[], requiredPhotoCategories: string[]): HandoverDocument {
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
      marker: d.marker === "NEW" ? "NEW" : "EXISTING",
      markerLabel: d.marker === "NEW" ? (h.type === "PICKUP" ? "Neu entdeckt (Vorschaden)" : "Neu bei Rückgabe") : "Bereits dokumentiert",
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
        ok: c.result === "OK" || c.result === "YES" ? true : c.result === "NOT_OK" || c.result === "NO" ? false : null,
        note: c.note,
        missing: c.required && !c.result,
      })),
    photos: general.map((p) => ({ id: p.id, url: `/api/photos/${p.id}`, category: p.category, categoryLabel: label(PHOTO_CATEGORIES, p.category) })),
    missingPhotoCategories: requiredPhotoCategories.filter((c) => !have.has(c)).map((c) => label(PHOTO_CATEGORIES, c)),
    signatures: signatures.map((s) => ({ role: s.role, roleLabel: s.role === "RENTER" ? "Mieter" : "Vermieter", signerName: s.signerName, signedAt: dateTime(s.signedAt), imageUrl: `/api/signatures/${s.id}` })),
  };
}

// Fahrzeugskizzen für die Schadenkarte.
// Reihenfolge: eigene Skizze der Fahrzeuggruppe, sonst Systemskizze passend zur Karosserieart
// (allgemeiner PKW oder allgemeiner Transporter). Jede Version ist eine eigene, feste Zeile.
// Ein Protokoll merkt sich id, Version und Datei-Hash der verwendeten Skizze.

import type { Prisma } from "@prisma/client";
import { DomainError, sha256 } from "@/lib/integrity";

type Tx = Prisma.TransactionClient;

export type SketchView = { key: string; label: string; box: [number, number, number, number] };

const FALLBACK_CODE: Record<string, string> = { PKW: "GENERIC_PKW", TRANSPORTER: "GENERIC_TRANSPORTER" };

export async function resolveSketch(tx: Tx, tenantId: string, group: { sketchId: string | null; bodyType: string } | null) {
  if (group?.sketchId) {
    // Nur eigene oder Systemskizzen zulassen
    const own = await tx.vehicleSketch.findFirst({ where: { id: group.sketchId, active: true, OR: [{ tenantId }, { tenantId: null }] } });
    if (own) return own;
  }
  const code = FALLBACK_CODE[group?.bodyType ?? "PKW"] ?? FALLBACK_CODE.PKW;
  return tx.vehicleSketch.findFirst({ where: { tenantId: null, code, active: true }, orderBy: { version: "desc" } });
}

/**
 * Hinterlegt eine neue Skizzenfassung für einen Mandanten. Bestehende Fassungen bleiben unverändert,
 * die vorherige wird nur deaktiviert. Alte Protokolle zeigen weiter ihre damalige Fassung.
 */
export async function publishSketchVersion(
  tx: Tx,
  tenantId: string,
  input: { code: string; name: string; bodyType: "PKW" | "TRANSPORTER"; assetPath: string; assetContent: string | Uint8Array; views: SketchView[] },
) {
  if (input.views.length === 0) throw new DomainError("Eine Skizze braucht mindestens eine Ansicht.");
  const last = await tx.vehicleSketch.findFirst({ where: { tenantId, code: input.code }, orderBy: { version: "desc" } });
  if (last) await tx.vehicleSketch.update({ where: { id: last.id }, data: { active: false } });
  return tx.vehicleSketch.create({
    data: {
      tenantId,
      code: input.code,
      name: input.name,
      bodyType: input.bodyType,
      version: (last?.version ?? 0) + 1,
      assetPath: input.assetPath,
      assetHash: sha256(input.assetContent),
      views: input.views,
      active: true,
    },
  });
}

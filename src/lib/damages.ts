// Schadenakte des Fahrzeugs. Lebt weiter, wird nie gelöscht, auch reparierte Schäden bleiben erhalten.
// Protokolle halten eigene Kopien (HandoverDamage) und werden von Änderungen hier nicht berührt.

import { db } from "@/lib/db";
import { DAMAGE_STATUS, type DamageStatus } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { recordVehicleEvent } from "@/lib/vehicle-events";

export type DamageInput = {
  vehicleId: string;
  view: string;
  posX: number;
  posY: number;
  kind: string;
  description: string;
  size?: string | null;
  severity?: string;
  bookingId?: string | null;
};

/** Schaden außerhalb eines Protokolls erfassen, z. B. auf dem Hof entdeckt. */
export async function reportDamage(tenantId: string, actor: { id: string; name: string }, input: DamageInput) {
  if (!(input.posX >= 0 && input.posX <= 1 && input.posY >= 0 && input.posY <= 1)) throw new DomainError("Schadenpositionen werden normalisiert gespeichert (0 bis 1).");
  return db.$transaction(async (tx) => {
    const vehicle = await tx.vehicle.findFirst({ where: { id: input.vehicleId, tenantId } });
    if (!vehicle) throw new DomainError("Fahrzeug nicht gefunden.");
    if (input.bookingId) {
      const ok = await tx.booking.count({ where: { id: input.bookingId, tenantId, vehicleId: vehicle.id } });
      if (ok !== 1) throw new DomainError("Die Buchung passt nicht zu diesem Fahrzeug.");
    }
    const damage = await tx.damage.create({
      data: {
        tenantId,
        vehicleId: vehicle.id,
        view: input.view,
        posX: input.posX,
        posY: input.posY,
        kind: input.kind,
        description: input.description,
        size: input.size ?? null,
        severity: input.severity ?? "MINOR",
        bookingId: input.bookingId ?? null,
        reportedById: actor.id,
      },
    });
    await recordVehicleEvent(tx, { tenantId, vehicleId: vehicle.id, type: "DAMAGE_DISCOVERED", mileage: vehicle.mileage, bookingId: input.bookingId ?? null, damageId: damage.id, actor, description: input.description });
    return damage;
  });
}

/**
 * Status der Schadenakte ändern. "Repariert" setzt das Reparaturdatum und schreibt die Historie.
 * Ein reparierter Schaden verschwindet aus künftigen Protokollen, bleibt aber in der Akte und in allen alten Protokollen.
 */
export async function setDamageStatus(tenantId: string, actor: { id: string; name: string }, damageId: string, status: DamageStatus, note?: string | null) {
  if (!(status in DAMAGE_STATUS)) throw new DomainError("Unbekannter Schadenstatus.");
  return db.$transaction(async (tx) => {
    const damage = await tx.damage.findFirst({ where: { id: damageId, tenantId } });
    if (!damage) throw new DomainError("Schaden nicht gefunden.");
    const repairedNow = status === "REPAIRED" && damage.status !== "REPAIRED";
    const updated = await tx.damage.update({
      where: { id: damage.id },
      data: { status, repairedAt: status === "REPAIRED" ? damage.repairedAt ?? new Date() : null, repairNote: note ?? damage.repairNote },
    });
    if (repairedNow) {
      await recordVehicleEvent(tx, { tenantId, vehicleId: damage.vehicleId, type: "DAMAGE_REPAIRED", damageId: damage.id, bookingId: damage.bookingId, actor, description: note ?? damage.description });
    }
    return updated;
  });
}

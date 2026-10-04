// Schadenakte des Fahrzeugs. Lebt weiter, wird nie gelöscht, auch reparierte Schäden bleiben erhalten.
// Protokolle halten eigene Kopien (HandoverDamage) und werden von Änderungen hier nicht berührt.

import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { DAMAGE_KINDS, DAMAGE_SEVERITY, DAMAGE_STATUS, DAMAGE_VIEWS, type DamageStatus } from "@/lib/constants";
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
  /** Befehl 27: Zeitpunkt der Feststellung (Standard: jetzt, nie in der Zukunft) und interne Notiz */
  discoveredAt?: Date | null;
  note?: string | null;
};

/**
 * Schaden außerhalb eines Protokolls erfassen, z. B. auf dem Hof entdeckt (Befehl 27: in der Fahrzeugakte „+ Schaden erfassen“).
 * Herkunft „manuell erfasst“ = kein Protokoll (discoveredInHandoverId leer). Keine Haftung, keine Kundenbelastung, keine
 * Rechnung – der Schaden erscheint in Fahrzeugakte und Historie und wird in künftige Übergaben/Rückgaben übernommen.
 */
export async function reportDamage(tenantId: string, actor: { id: string; name: string }, input: DamageInput) {
  if (!(input.posX >= 0 && input.posX <= 1 && input.posY >= 0 && input.posY <= 1)) throw new DomainError("Schadenpositionen werden normalisiert gespeichert (0 bis 1).");
  if (!(input.view in DAMAGE_VIEWS)) throw new DomainError("Bitte den Fahrzeugbereich wählen.");
  if (!(input.kind in DAMAGE_KINDS)) throw new DomainError("Bitte die Schadenart wählen.");
  if (input.severity && !(input.severity in DAMAGE_SEVERITY)) throw new DomainError("Unbekannter Schweregrad.");
  const description = (input.description ?? "").trim();
  if (description.length < 3) throw new DomainError("Bitte den Schaden kurz beschreiben.");
  if (description.length > 1000) throw new DomainError("Die Beschreibung ist zu lang (höchstens 1000 Zeichen).");
  const note = input.note?.trim() ? input.note.trim().slice(0, 1000) : null;
  const discoveredAt = input.discoveredAt ?? new Date();
  if (discoveredAt.getTime() > Date.now() + 5 * 60_000) throw new DomainError("Der Zeitpunkt der Feststellung liegt in der Zukunft.");
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
        description,
        size: input.size?.trim() ? input.size.trim().slice(0, 60) : null,
        severity: input.severity ?? "MINOR",
        bookingId: input.bookingId ?? null,
        reportedById: actor.id,
        discoveredAt,
        note,
      },
    });
    await recordVehicleEvent(tx, { tenantId, vehicleId: vehicle.id, type: "DAMAGE_DISCOVERED", occurredAt: discoveredAt, mileage: vehicle.mileage, bookingId: input.bookingId ?? null, damageId: damage.id, actor, description: `Manuell erfasst: ${description}` });
    await recordAudit(tx, tenantId, actor, { action: "DAMAGE_REPORTED", bookingId: input.bookingId ?? null, details: { damageId: damage.id, vehicleId: vehicle.id, view: input.view, kind: input.kind, severity: input.severity ?? "MINOR" } });
    return damage;
  });
}

/** Befehl 27: Foto zu einem Schaden ohne Protokoll (gleiche Regeln wie Protokollfotos; Speichern/Prüfen im Aufrufer). */
export async function registerDamagePhoto(tenantId: string, actor: { id: string; name: string }, damageId: string, input: { storageKey: string; contentType: string; sizeBytes: number; checksum: string }) {
  return db.$transaction(async (tx) => {
    const damage = await tx.damage.findFirst({ where: { id: damageId, tenantId }, select: { id: true, discoveredInHandoverId: true } });
    if (!damage) throw new DomainError("Schaden nicht gefunden.");
    if (damage.discoveredInHandoverId) throw new DomainError("Fotos zu Schäden aus einem Protokoll gehören zum Protokoll bzw. zur Schadenakte.");
    return tx.photo.create({ data: { tenantId, damageId: damage.id, category: "DAMAGE", storageKey: input.storageKey, contentType: input.contentType, sizeBytes: input.sizeBytes, checksum: input.checksum, takenAt: new Date(), createdById: actor.id } });
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

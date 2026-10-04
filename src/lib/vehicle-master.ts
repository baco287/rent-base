// Befehl 27: Fahrzeugstammdaten speichern, ohne operative Zustände still zu überschreiben.
// - Tankgröße: nur für Verbrenner/Hybrid, ganze Liter in einem realistischen Bereich; reine Elektrofahrzeuge haben keine.
// - Kilometerstand: nie unbemerkt unter den dokumentierten Stand; eine Korrektur nach unten braucht einen Grund
//   (Fahrzeughistorie + Audit). Höhere Stände werden in der Historie vermerkt.
// - Status: Eine Werkstattsperre aus einem Wartungsvorgang und eine Schadensperre aus einer Schadenakte werden nur dort
//   freigegeben (bestehende Freigabewege). Alle anderen manuellen Wechsel werden in Historie und Audit festgehalten;
//   die Reaktivierung eines inaktiven Fahrzeugs prüft das Fahrzeuglimit des Tarifs.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { VEHICLE_STATUS, type VehicleStatus } from "@/lib/constants";
import { fmtInt } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { assertVehicleLimit } from "@/lib/subscriptions";
import { recordVehicleEvent } from "@/lib/vehicle-events";

type Tx = Prisma.TransactionClient;

export const TANK_MIN_LITERS = 5;
export const TANK_MAX_LITERS = 300;

/** Tankgröße prüfen: Elektro → keine; sonst leer (unbekannt) oder ganze Liter im realistischen Bereich. */
export function normalizeTankCapacity(fuel: string, value: number | null | undefined): number | null {
  if (fuel === "ELEKTRO") return null;
  if (value == null) return null;
  if (!Number.isInteger(value) || value < TANK_MIN_LITERS || value > TANK_MAX_LITERS) throw new DomainError(`Tankgröße: bitte ganze Liter zwischen ${TANK_MIN_LITERS} und ${TANK_MAX_LITERS} angeben.`);
  return value;
}

/** Hält ein laufender Prozess den aktuellen Status? Dann wird nur dort freigegeben. */
export async function vehicleStatusHold(tx: Tx | typeof db, tenantId: string, vehicleId: string, status: string): Promise<string | null> {
  if (status === "WORKSHOP") {
    const ev = await tx.maintenanceEvent.findFirst({ where: { tenantId, type: { in: ["VEHICLE_BLOCKED", "VEHICLE_RELEASED"] }, maintenance: { vehicleId } }, orderBy: { createdAt: "desc" }, select: { type: true, maintenance: { select: { maintenanceNumber: true } } } });
    if (ev?.type === "VEHICLE_BLOCKED") return `Das Fahrzeug ist durch den Wartungsvorgang ${ev.maintenance.maintenanceNumber} für die Werkstatt gesperrt. Die Freigabe erfolgt dort („Fahrzeug freigeben“).`;
  }
  if (status === "BLOCKED") {
    const ev = await tx.damageCaseEvent.findFirst({ where: { tenantId, type: { in: ["VEHICLE_BLOCKED", "VEHICLE_RELEASED"] }, case: { vehicleId } }, orderBy: { createdAt: "desc" }, select: { type: true, case: { select: { caseNumber: true } } } });
    if (ev?.type === "VEHICLE_BLOCKED") return `Das Fahrzeug ist durch die Schadenakte ${ev.case.caseNumber} gesperrt. Die Freigabe erfolgt dort („Fahrzeug wieder freigeben“).`;
  }
  return null;
}

export type VehicleMasterInput = Prisma.VehicleUncheckedUpdateInput & { status: string; mileage: number; fuel: string; tankCapacityLiters?: number | null; huDate?: Date | null };

export async function updateVehicleMasterData(tenantId: string, actor: Actor, vehicleId: string, data: VehicleMasterInput, opts: { mileageCorrectionReason?: string | null } = {}): Promise<{ statusChanged: boolean; mileageCorrected: boolean }> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string; mileage: number }[]>`SELECT "id", "status", "mileage" FROM "Vehicle" WHERE "id" = ${vehicleId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Fahrzeug nicht gefunden.");
    const current = locked[0];
    const tank = normalizeTankCapacity(data.fuel, data.tankCapacityLiters ?? null);

    // Kilometerstand
    let mileageCorrected = false;
    if (!Number.isInteger(data.mileage) || data.mileage < 0) throw new DomainError("Kilometerstand muss eine ganze Zahl ab 0 sein.");
    if (data.mileage < current.mileage) {
      const reason = (opts.mileageCorrectionReason ?? "").trim();
      if (reason.length < 3) throw new DomainError(`Der Kilometerstand kann nicht unter den dokumentierten Stand von ${fmtInt(current.mileage)} km gesetzt werden. Für eine Korrektur bitte den Grund angeben.`);
      await recordVehicleEvent(tx, { tenantId, vehicleId, type: "MILEAGE_CORRECTED", mileage: data.mileage, actor, description: `Korrektur von ${fmtInt(current.mileage)} km auf ${fmtInt(data.mileage)} km: ${reason.slice(0, 300)}` });
      await recordAudit(tx, tenantId, actor, { action: "VEHICLE_MILEAGE_CORRECTED", details: { vehicleId, from: current.mileage, to: data.mileage, reason: reason.slice(0, 300) } });
      mileageCorrected = true;
    } else if (data.mileage > current.mileage) {
      await recordVehicleEvent(tx, { tenantId, vehicleId, type: "MILEAGE", mileage: data.mileage, actor, description: "Kilometerstand in den Stammdaten aktualisiert" });
    }

    // Status
    let statusChanged = false;
    if (!(data.status in VEHICLE_STATUS)) throw new DomainError("Unbekannter Fahrzeugstatus.");
    if (data.status !== current.status) {
      const hold = await vehicleStatusHold(tx, tenantId, vehicleId, current.status);
      if (hold) throw new DomainError(hold);
      if (current.status === "INACTIVE") await assertVehicleLimit(tenantId, tx);
      const label = (s: string) => VEHICLE_STATUS[s as VehicleStatus] ?? s;
      await recordVehicleEvent(tx, { tenantId, vehicleId, type: "STATUS_CHANGED", mileage: data.mileage, actor, description: `Status manuell: ${label(current.status)} → ${label(data.status)}` });
      await recordAudit(tx, tenantId, actor, { action: "VEHICLE_STATUS_CHANGED", details: { vehicleId, from: current.status, to: data.status } });
      statusChanged = true;
    }

    await tx.vehicle.update({ where: { id: vehicleId }, data: { ...data, tankCapacityLiters: tank } });
    // HU/AU-Plan und HU-Datum am Fahrzeug bleiben synchron (der Plan ist die Fälligkeit, das Datum die Stammdatenansicht)
    if (data.huDate !== undefined) await tx.maintenancePlan.updateMany({ where: { tenantId, vehicleId, type: "HU_AU", isActive: true }, data: { nextDueDate: data.huDate ?? null } });
    return { statusChanged, mileageCorrected };
  });
}

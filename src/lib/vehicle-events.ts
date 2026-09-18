// Fahrzeughistorie: nur anfügen, nie ändern (zusätzlich durch Datenbank-Trigger gesichert).
import type { Prisma } from "@prisma/client";
import type { VehicleEventType } from "@/lib/constants";

type Tx = Prisma.TransactionClient;

export type VehicleEventInput = {
  tenantId: string;
  vehicleId: string;
  type: VehicleEventType;
  occurredAt?: Date;
  mileage?: number | null;
  bookingId?: string | null;
  damageId?: string | null;
  handoverId?: string | null;
  actor?: { id: string; name: string } | null;
  description?: string | null;
};

export async function recordVehicleEvent(tx: Tx, e: VehicleEventInput) {
  return tx.vehicleEvent.create({
    data: {
      tenantId: e.tenantId,
      vehicleId: e.vehicleId,
      type: e.type,
      occurredAt: e.occurredAt ?? new Date(),
      mileage: e.mileage ?? null,
      bookingId: e.bookingId ?? null,
      damageId: e.damageId ?? null,
      handoverId: e.handoverId ?? null,
      userId: e.actor?.id ?? null,
      userName: e.actor?.name ?? null,
      description: e.description ?? null,
    },
  });
}

/** Historie eines Fahrzeugs, neueste zuerst. */
export async function listVehicleEvents(tx: Tx, tenantId: string, vehicleId: string, take = 100) {
  return tx.vehicleEvent.findMany({ where: { tenantId, vehicleId }, orderBy: { occurredAt: "desc" }, take });
}

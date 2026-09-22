import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BLOCKING_BOOKING_STATUS, VEHICLE_STATUS, type VehicleStatus } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";

type Tx = Prisma.TransactionClient;

/**
 * Zeiträume sind halboffen: [startAt, endAt). Zwei Buchungen überschneiden sich, wenn
 * A.start < B.end und A.end > B.start. Rückgabe 10:00 und Abholung 10:00 am selben Tag sind damit KEIN Konflikt.
 * Diese Regel gilt überall: hier, im Dispo-Kalender und im Übergabeabschluss.
 */
export async function findConflicts(
  tx: Tx,
  tenantId: string,
  vehicleId: string,
  startAt: Date,
  endAt: Date,
  excludeBookingId?: string,
) {
  return tx.booking.findMany({
    where: {
      tenantId,
      vehicleId,
      status: { in: BLOCKING_BOOKING_STATUS },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: { customer: true },
    orderBy: { startAt: "asc" },
  });
}

/** Fahrzeugstatus, mit denen weder gebucht noch übergeben wird. */
export const NOT_RENTABLE_STATUS: VehicleStatus[] = ["WORKSHOP", "BLOCKED", "INACTIVE"];

export function vehicleStatusProblem(status: string): string | null {
  if (!(NOT_RENTABLE_STATUS as string[]).includes(status)) return null;
  const label = VEHICLE_STATUS[status as VehicleStatus] ?? status;
  return `Das Fahrzeug steht auf „${label}“ und kann in diesem Zustand nicht vermietet werden.`;
}

/**
 * Die eine zentrale Verfügbarkeitsprüfung. Sperrt die Fahrzeugzeile (FOR UPDATE), damit zwei gleichzeitige
 * Buchungen desselben Fahrzeugs nacheinander geprüft werden und keine Doppelbelegung entsteht.
 * Prüft Mandant, Fahrzeugstatus und Überschneidungen. Wirft DomainError mit verständlicher Meldung.
 */
export async function assertVehicleBookable(tx: Tx, tenantId: string, vehicleId: string, startAt: Date, endAt: Date, excludeBookingId?: string) {
  const locked = await tx.$queryRaw<{ id: string; status: string; plate: string }[]>`SELECT "id", "status", "plate" FROM "Vehicle" WHERE "id" = ${vehicleId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Fahrzeug nicht gefunden.");
  const problem = vehicleStatusProblem(locked[0].status);
  if (problem) throw new DomainError(problem);
  if (!(endAt > startAt)) throw new DomainError("Die Rückgabe muss nach der Abholung liegen.");
  const conflicts = await findConflicts(tx, tenantId, vehicleId, startAt, endAt, excludeBookingId);
  return { vehicle: locked[0], conflicts };
}

/** Nächste Buchungsnummer pro Mandant und Jahr, z. B. 2026-0042. Doppelte Nummern verhindert der eindeutige Index; der Aufrufer wiederholt dann. */
export async function nextBookingNumber(tx: Tx, tenantId: string, date = new Date()) {
  const year = date.getFullYear();
  const prefix = `${year}-`;
  const last = await tx.booking.findFirst({
    where: { tenantId, number: { startsWith: prefix } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const n = last ? parseInt(last.number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}

export { db };

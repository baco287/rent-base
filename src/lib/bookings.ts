import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BLOCKING_BOOKING_STATUS } from "@/lib/constants";

type Tx = Prisma.TransactionClient;

/**
 * Findet Buchungen, die sich mit dem Zeitraum überschneiden.
 * Zwei Zeiträume überschneiden sich, wenn A.start < B.end und A.end > B.start.
 * Rückgabe 09:00 und Abholung 09:00 am selben Tag gelten damit NICHT als Konflikt.
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

/** Nächste Buchungsnummer pro Mandant und Jahr, z. B. 2026-0042. */
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

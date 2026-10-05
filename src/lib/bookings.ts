import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BLOCKING_BOOKING_STATUS, VEHICLE_STATUS, type VehicleStatus } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";

type Tx = Prisma.TransactionClient;

/**
 * Befehl 27: Eine laufende Miete (ACTIVE) belegt das Fahrzeug bis zur tatsächlichen Rückgabe. Ist das geplante Ende
 * überschritten (Rückgabe überfällig), gilt sie bis „jetzt“ als belegt. Eine Definition für Konfliktprüfung und Dispo.
 * Befehl 28: Eine vereinbarte, noch nicht unterschriebene Verlängerung (Nachtrag AGREED) reserviert das Fahrzeug sofort bis
 * zum vereinbarten Ende – operativ, nicht vertraglich (der wirksame Vertragsstand liest nur unterschriebene Nachträge).
 */
export type OccupancyLike = { status: string; endAt: Date | null; agreedEndAt?: Date | null };

/**
 * Befehl 29: endAt = null ist das offene Mietende einer Unfallersatzmiete („bis zur Rückgabe“). Operativ belegt eine solche
 * Buchung das Fahrzeug unbegrenzt; sie ist nie überfällig. Alle Ableitungen hier geben dann null („offen“) zurück.
 */
export const isOpenEnd = (b: { endAt: Date | null }) => b.endAt === null;

/** Operatives Ende ohne Überfälligkeit: geplantes Ende bzw. vereinbartes (noch nicht unterschriebenes) Ende, je nachdem was später ist; null = offen. */
export function operationalEnd(b: OccupancyLike): Date | null {
  if (b.endAt === null) return null;
  return b.agreedEndAt && b.agreedEndAt > b.endAt ? b.agreedEndAt : b.endAt;
}
export function isOverdue(b: OccupancyLike, now = new Date()): boolean {
  const end = operationalEnd(b);
  return b.status === "ACTIVE" && end !== null && end < now;
}
/** Bis wann das Fahrzeug belegt ist: bei Überfälligkeit „jetzt“, sonst das operative Ende; null = offen (bis zur Rückgabe). */
export function occupiedUntil(b: OccupancyLike, now = new Date()): Date | null {
  return isOverdue(b, now) ? now : operationalEnd(b);
}
/**
 * Ende für Preis- und Dauerberechnungen einer Buchung: geplantes Ende, bei offenem Ende die tatsächliche Rückgabe, bis
 * dahin „jetzt“ (bisherige Mietdauer). Nie ein erfundenes Datum in der Datenbank – nur eine Rechengröße zum Zeitpunkt des Aufrufs.
 */
export function pricingEnd(b: { endAt: Date | null; actualReturnAt?: Date | null; rentalType?: string; status?: string }, now = new Date()): Date {
  // Unfallersatz rechnet nach tatsächlicher Dauer: zurückgegeben → Rückgabe; laufend → geplantes Ende, frühestens jetzt
  if (b.rentalType === "ACCIDENT_REPLACEMENT") return b.actualReturnAt ?? (b.status === "ACTIVE" ? (b.endAt && b.endAt > now ? b.endAt : now) : b.endAt ?? now);
  return b.endAt ?? b.actualReturnAt ?? now;
}
/** Für Abfragen, die das operative Ende brauchen: vereinbarte Verlängerung der Buchung (höchstens eine je Vertrag). */
export const AGREED_EXTENSION_SELECT = { where: { status: "AGREED" }, select: { id: true, newEndAt: true, newStartAt: true, agreedAt: true, agreedChannel: true } } as const;
export const agreedEndOf = (b: { contractAmendments?: { newEndAt: Date | null }[] }) => b.contractAmendments?.find((a) => a.newEndAt)?.newEndAt ?? null;

/**
 * Filter: Buchungen, die das Fahrzeug im halboffenen Zeitraum [startAt, endAt) belegen – inkl. überfälliger laufender Mieten
 * und vereinbarter Verlängerungen. Befehl 29: eine Buchung mit offenem Ende (endAt null) belegt ab ihrem Beginn unbegrenzt
 * und trifft deshalb jeden Zeitraum, der nach ihrem Beginn liegt; ein gesuchter Zeitraum mit offenem Ende (endAt null)
 * trifft jede Belegung, die nach seinem Beginn noch läuft.
 */
export function occupyingWhere(startAt: Date, endAt: Date | null, now = new Date()): Prisma.BookingWhereInput {
  const ends: Prisma.BookingWhereInput[] = [{ endAt: { gt: startAt } }, { endAt: null }];
  // überfällig: belegt bis jetzt, also überschneidend, sobald der Zeitraum vor „jetzt“ beginnt
  if (now > startAt) ends.push({ status: "ACTIVE" });
  // Befehl 28: vereinbart, Unterschrift ausstehend – belegt bis zum vereinbarten Ende
  ends.push({ contractAmendments: { some: { status: "AGREED", newEndAt: { gt: startAt } } } });
  return { status: { in: BLOCKING_BOOKING_STATUS }, ...(endAt ? { startAt: { lt: endAt } } : {}), OR: ends };
}

/**
 * Zeiträume sind halboffen: [startAt, endAt). Zwei Buchungen überschneiden sich, wenn
 * A.start < B.end und A.end > B.start. Rückgabe 10:00 und Abholung 10:00 am selben Tag sind damit KEIN Konflikt.
 * Diese Regel gilt überall: hier, im Dispo-Kalender und im Übergabeabschluss. Befehl 27: B.end einer überfälligen laufenden
 * Miete ist „jetzt“ (occupiedUntil). Befehl 29: ein offenes Ende (null) zählt als unendlich – auf beiden Seiten.
 */
export async function findConflicts(
  tx: Tx | typeof db,
  tenantId: string,
  vehicleId: string,
  startAt: Date,
  endAt: Date | null,
  excludeBookingId?: string,
  now = new Date(),
) {
  return tx.booking.findMany({
    where: {
      tenantId,
      vehicleId,
      ...occupyingWhere(startAt, endAt, now),
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: { customer: true, contractAmendments: AGREED_EXTENSION_SELECT },
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
export async function assertVehicleBookable(tx: Tx, tenantId: string, vehicleId: string, startAt: Date, endAt: Date | null, excludeBookingId?: string) {
  const locked = await tx.$queryRaw<{ id: string; status: string; plate: string }[]>`SELECT "id", "status", "plate" FROM "Vehicle" WHERE "id" = ${vehicleId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Fahrzeug nicht gefunden.");
  const problem = vehicleStatusProblem(locked[0].status);
  if (problem) throw new DomainError(problem);
  if (endAt !== null && !(endAt > startAt)) throw new DomainError("Die Rückgabe muss nach der Abholung liegen.");
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

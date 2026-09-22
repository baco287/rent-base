// Statuswechsel einer Buchung und der abgeleitete Stand im Ablauf.
//
// Die eine Statusmaschine (ALLOWED_TRANSITIONS):
//   RESERVED  -> ACTIVE     nur durch finalizeHandover (PICKUP)
//   ACTIVE    -> RETURNED   nur durch finalizeHandover (RETURN); Altfälle ohne Übergabeprotokoll per Knopf
//   RESERVED  -> CANCELLED  Storno vor der Übergabe (siehe cancelRules)
// Alles andere ist kein normaler Weg: RESERVED -> RETURNED, ACTIVE -> RESERVED, CANCELLED -> irgendwas,
// RETURNED -> irgendwas. Ein administrativer Sonderprozess dafür existiert bewusst nicht.
//
// Storno nach Phase:
//   A) ohne Vertrag                      erlaubt
//   B) Vertragsentwurf                   erlaubt, Entwurf wird verworfen
//   C) finalisierter Vertrag, keine Übergabe  erlaubt; Vertrag und Dokumente bleiben erhalten (Status CANCELLED)
//   D) Übergabe-Entwurf                  erlaubt, der Entwurf wird verworfen
//   E) unterwegs                         nicht erlaubt (Fahrzeug ist übergeben)
//   F) Rückgabe-Entwurf                  nicht erlaubt
//   G) zurückgegeben                     nicht erlaubt
// Nach einem Storno wird für dieselbe Buchung kein neuer Vertrag angelegt (ensureContractDraft verlangt RESERVED).

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { BookingStage, BookingStatus } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";

type Tx = Prisma.TransactionClient;

export const ALLOWED_TRANSITIONS: Record<BookingStatus, { to: BookingStatus; via: "HANDOVER" | "BUTTON" }[]> = {
  RESERVED: [{ to: "ACTIVE", via: "HANDOVER" }, { to: "CANCELLED", via: "BUTTON" }],
  ACTIVE: [{ to: "RETURNED", via: "HANDOVER" }],
  RETURNED: [],
  CANCELLED: [],
};

export function canTransition(from: string, to: BookingStatus, via: "HANDOVER" | "BUTTON") {
  return (ALLOWED_TRANSITIONS[from as BookingStatus] ?? []).some((t) => t.to === to && t.via === via);
}

/** Stand im Ablauf, abgeleitet aus Buchungsstatus und Vertrag. */
export function bookingStage(booking: { status: string }, contract: { status: string } | null | undefined): BookingStage {
  if (booking.status === "CANCELLED") return "CANCELLED";
  if (booking.status === "RETURNED") return "RETURNED";
  if (booking.status === "ACTIVE") return "ACTIVE";
  if (contract?.status === "SIGNED") return "READY_FOR_PICKUP";
  if (contract?.status === "DRAFT") return "CONTRACT_DRAFT";
  return "NEEDS_CONTRACT";
}

/** Darf diese Buchung per Knopf storniert werden? Dieselbe Regel für Oberfläche und Server. */
export function canCancel(booking: { status: string }) {
  return canTransition(booking.status, "CANCELLED", "BUTTON");
}

async function cancelContractOf(tx: Tx, tenantId: string, bookingId: string) {
  const contract = await tx.rentalContract.findFirst({ where: { tenantId, bookingId } });
  if (!contract) return;
  if (contract.status === "DRAFT") {
    await tx.signature.deleteMany({ where: { tenantId, contractId: contract.id } });
    await tx.contractDriver.deleteMany({ where: { tenantId, contractId: contract.id } });
    await tx.rentalContract.delete({ where: { id: contract.id } });
  } else if (contract.status === "SIGNED") {
    // Inhalt, Unterschriften und Dokumente bleiben als Historie erhalten; nur der Status wechselt
    await tx.rentalContract.update({ where: { id: contract.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  }
}

/** Übergabe-Entwürfe verwerfen. Finalisierte Protokolle gibt es bei RESERVED nicht (sonst wäre die Buchung ACTIVE). */
async function discardHandoverDrafts(tx: Tx, tenantId: string, bookingId: string): Promise<string[]> {
  const drafts = await tx.handover.findMany({ where: { tenantId, bookingId, status: "DRAFT" }, select: { id: true } });
  const keys: string[] = [];
  for (const d of drafts) {
    const photos = await tx.photo.findMany({ where: { tenantId, handoverId: d.id }, select: { id: true, storageKey: true } });
    keys.push(...photos.map((p) => p.storageKey));
    await tx.photo.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.signature.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.extraCharge.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.handoverChecklistItem.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.handoverDamage.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.handover.delete({ where: { id: d.id } });
  }
  return keys;
}

/**
 * Statuswechsel per Knopf. Gibt die Speicherschlüssel verworfener Entwurfsfotos zurück (Aufräumen durch den Aufrufer).
 * Die Zeile wird gesperrt, damit ein gleichzeitiger Übergabeabschluss und ein Storno nacheinander laufen.
 */
export async function changeBookingStatus(tenantId: string, bookingId: string, target: "ACTIVE" | "RETURNED" | "CANCELLED"): Promise<{ orphanedStorageKeys: string[] }> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const booking = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId } });

    if (target === "ACTIVE") {
      throw new DomainError("Ein Fahrzeug geht nur über Mietvertrag und Übergabeprotokoll auf „Unterwegs“. Bitte zuerst den Mietvertrag abschließen und dann die Übergabe starten.");
    }
    if (target === "CANCELLED") {
      if (!canCancel(booking)) {
        throw new DomainError(
          booking.status === "ACTIVE" ? "Das Fahrzeug ist bereits übergeben. Eine laufende Miete wird über die Rückgabe beendet, nicht storniert." : booking.status === "RETURNED" ? "Diese Miete ist abgeschlossen und kann nicht mehr storniert werden." : "Diese Buchung ist bereits storniert.",
        );
      }
      await cancelContractOf(tx, tenantId, booking.id);
      const orphanedStorageKeys = await discardHandoverDrafts(tx, tenantId, booking.id);
      await tx.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
      return { orphanedStorageKeys };
    }
    // RETURNED per Knopf: nur Altfälle ohne Übergabeprotokoll
    if (!canTransition(booking.status, "RETURNED", "HANDOVER")) throw new DomainError("Nur laufende Mieten können zurückgenommen werden.");
    const pickup = await tx.handover.count({ where: { tenantId, bookingId: booking.id, type: "PICKUP", status: "FINALIZED" } });
    if (pickup > 0) throw new DomainError("Zu dieser Miete gibt es ein Übergabeprotokoll. Die Rücknahme läuft deshalb über das Rückgabeprotokoll.");
    await tx.booking.update({ where: { id: booking.id }, data: { status: "RETURNED", actualReturnAt: new Date() } });
    return { orphanedStorageKeys: [] };
  });
}

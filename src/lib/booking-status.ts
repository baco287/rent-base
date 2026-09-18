// Statuswechsel einer Buchung und der abgeleitete Stand im Ablauf.
//
// Regeln ab Phase 3:
// - "Unterwegs" (ACTIVE) entsteht ausschließlich durch ein finalisiertes Übergabeprotokoll (finalizeHandover).
//   Der frühere direkte Knopf ist gesperrt, damit niemand Vertrag und Übergabe umgeht.
// - Stornieren ist für reservierte Buchungen möglich. Ein Vertragsentwurf wird dabei verworfen,
//   ein unterschriebener Vertrag auf "storniert" gesetzt (der Inhalt bleibt unverändert erhalten).
// - "Zurückgegeben" per Knopf bleibt nur für Altfälle ohne Übergabeprotokoll erlaubt.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { BookingStage } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";

type Tx = Prisma.TransactionClient;

/** Stand im Ablauf, abgeleitet aus Buchungsstatus und Vertrag. */
export function bookingStage(booking: { status: string }, contract: { status: string } | null | undefined): BookingStage {
  if (booking.status === "CANCELLED") return "CANCELLED";
  if (booking.status === "RETURNED") return "RETURNED";
  if (booking.status === "ACTIVE") return "ACTIVE";
  if (contract?.status === "SIGNED") return "READY_FOR_PICKUP";
  if (contract?.status === "DRAFT") return "CONTRACT_DRAFT";
  return "NEEDS_CONTRACT";
}

async function cancelContractOf(tx: Tx, tenantId: string, bookingId: string) {
  const contract = await tx.rentalContract.findFirst({ where: { tenantId, bookingId } });
  if (!contract) return;
  if (contract.status === "DRAFT") {
    await tx.signature.deleteMany({ where: { tenantId, contractId: contract.id } });
    await tx.rentalContract.delete({ where: { id: contract.id } });
  } else if (contract.status === "SIGNED") {
    await tx.rentalContract.update({ where: { id: contract.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  }
}

export async function changeBookingStatus(tenantId: string, bookingId: string, target: "ACTIVE" | "RETURNED" | "CANCELLED") {
  return db.$transaction(async (tx) => {
    const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId } });
    if (!booking) throw new DomainError("Buchung nicht gefunden.");

    if (target === "ACTIVE") {
      throw new DomainError("Ein Fahrzeug geht nur über Mietvertrag und Übergabeprotokoll auf „Unterwegs“. Bitte zuerst den Mietvertrag abschließen und dann die Übergabe starten.");
    }
    if (target === "CANCELLED") {
      if (booking.status !== "RESERVED") throw new DomainError("Nur reservierte Buchungen können storniert werden.");
      await cancelContractOf(tx, tenantId, booking.id);
      return tx.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
    }
    // RETURNED
    if (booking.status !== "ACTIVE") throw new DomainError("Nur laufende Mieten können zurückgenommen werden.");
    const pickup = await tx.handover.count({ where: { tenantId, bookingId: booking.id, type: "PICKUP", status: "FINALIZED" } });
    if (pickup > 0) throw new DomainError("Zu dieser Miete gibt es ein Übergabeprotokoll. Die Rücknahme läuft deshalb über das Rückgabeprotokoll.");
    return tx.booking.update({ where: { id: booking.id }, data: { status: "RETURNED", actualReturnAt: new Date() } });
  });
}

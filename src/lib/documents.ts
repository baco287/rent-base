// Archiv erzeugter Dokumente (PDF). Ein Dokument wird einmal erzeugt und nie überschrieben.
// Eine neue Fassung bekommt eine neue Versionsnummer und einen neuen Storage Key.
// Änderungen und Löschen blockiert zusätzlich ein Datenbank-Trigger.

import type { Prisma } from "@prisma/client";
import type { DocumentType } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { assertKeyBelongsToTenant } from "@/lib/storage";

type Tx = Prisma.TransactionClient;

export type DocumentInput = {
  bookingId: string;
  contractId?: string | null;
  handoverId?: string | null;
  type: DocumentType;
  storageKey: string;
  fileName: string;
  contentType?: string;
  sizeBytes: number;
  checksum: string;
};

export async function registerDocument(tx: Tx, tenantId: string, actorId: string | null, input: DocumentInput) {
  assertKeyBelongsToTenant(input.storageKey, tenantId);
  if (!/^[a-f0-9]{64}$/.test(input.checksum)) throw new DomainError("Die Prüfsumme des Dokuments fehlt oder ist ungültig.");
  const booking = await tx.booking.count({ where: { id: input.bookingId, tenantId } });
  if (booking !== 1) throw new DomainError("Buchung nicht gefunden.");
  if (input.contractId && (await tx.rentalContract.count({ where: { id: input.contractId, tenantId, bookingId: input.bookingId } })) !== 1) throw new DomainError("Der Vertrag gehört nicht zu dieser Buchung.");
  if (input.handoverId && (await tx.handover.count({ where: { id: input.handoverId, tenantId, bookingId: input.bookingId } })) !== 1) throw new DomainError("Das Protokoll gehört nicht zu dieser Buchung.");

  const last = await tx.document.findFirst({
    where: { tenantId, bookingId: input.bookingId, type: input.type, contractId: input.contractId ?? null, handoverId: input.handoverId ?? null },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return tx.document.create({
    data: {
      tenantId,
      bookingId: input.bookingId,
      contractId: input.contractId ?? null,
      handoverId: input.handoverId ?? null,
      type: input.type,
      storageKey: input.storageKey,
      fileName: input.fileName,
      contentType: input.contentType ?? "application/pdf",
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      version: (last?.version ?? 0) + 1,
      createdById: actorId,
    },
  });
}

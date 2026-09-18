// E-Mail-Protokoll und Warteschlange. In dieser Phase wird noch nichts versendet.
// Grundsätze:
// - Eine E-Mail wird immer NACH dem fachlichen Vorgang eingereiht, in einer eigenen Transaktion.
//   Ein Fehler beim Versand macht deshalb nie eine Übergabe oder Rückgabe rückgängig.
// - idempotencyKey verhindert Doppelversand: derselbe Vorgang erzeugt nur einen Eintrag.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type EmailAttachmentRef = { documentId: string; fileName: string; checksum: string };

export type EnqueueEmailInput = {
  tenantId: string;
  bookingId?: string | null;
  recipient: string;
  subject: string;
  template: string;
  attachments?: EmailAttachmentRef[];
  /** z. B. "PICKUP_PROTOCOL:<handoverId>:v1". Gleicher Schlüssel ergibt denselben Eintrag. */
  idempotencyKey: string;
};

/** Reiht eine E-Mail ein. Gibt bei wiederholtem Aufruf den vorhandenen Eintrag zurück. */
export async function enqueueEmail(input: EnqueueEmailInput) {
  const existing = await db.emailLog.findUnique({ where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } } });
  if (existing) return existing;
  return db.emailLog.create({
    data: {
      tenantId: input.tenantId,
      bookingId: input.bookingId ?? null,
      recipient: input.recipient.trim().toLowerCase(),
      subject: input.subject,
      template: input.template,
      attachments: (input.attachments ?? []) as unknown as Prisma.InputJsonValue,
      idempotencyKey: input.idempotencyKey,
    },
  });
}

export async function markEmailSent(tenantId: string, id: string, providerMessageId: string | null) {
  const now = new Date();
  return db.emailLog.updateMany({ where: { id, tenantId }, data: { status: "SENT", providerMessageId, sentAt: now, lastAttemptAt: now, error: null, attempts: { increment: 1 } } });
}

export async function markEmailFailed(tenantId: string, id: string, error: string) {
  return db.emailLog.updateMany({ where: { id, tenantId }, data: { status: "FAILED", error: error.slice(0, 1000), lastAttemptAt: new Date(), attempts: { increment: 1 } } });
}

/** Erneut senden: setzt einen fehlgeschlagenen Eintrag zurück auf "wartet". Das Dokument bleibt dasselbe. */
export async function retryEmail(tenantId: string, id: string) {
  return db.emailLog.updateMany({ where: { id, tenantId, status: "FAILED" }, data: { status: "PENDING", error: null } });
}

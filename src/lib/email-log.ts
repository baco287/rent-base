// E-Mail-Protokoll. Jeder Versandversuch ist eine eigene Zeile.
// Grundsätze:
// - Eine E-Mail entsteht immer NACH dem fachlichen Vorgang, in einer eigenen Transaktion.
//   Ein Fehler beim Versand macht deshalb nie eine Übergabe oder Rückgabe rückgängig.
// - idempotencyKey verhindert Doppelversand: Wer die Zeile anlegt, darf senden. Jeder weitere Aufruf mit
//   demselben Schlüssel (Doppelklick, Neuladen, paralleler Request) bekommt die vorhandene Zeile und sendet nicht.
// - "Erneut senden" ist ein neuer Versuch mit eigenem Schlüssel und eigener Zeile.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/numbering";

export type EmailAttachmentRef = { documentId: string; fileName: string; checksum: string; version?: number; type?: string };

export type EnqueueEmailInput = {
  tenantId: string;
  bookingId?: string | null;
  handoverId?: string | null;
  invoiceId?: string | null;
  invoiceVersionId?: string | null;
  payoutId?: string | null;
  recipient: string;
  subject: string;
  template: string;
  attachments?: EmailAttachmentRef[];
  trigger?: "AUTO" | "MANUAL";
  createdById?: string | null;
  /** z. B. "PICKUP_DOCUMENTS:<handoverId>:<Dokumentfassungen>". Gleicher Schlüssel ergibt denselben Eintrag. */
  idempotencyKey: string;
};

export type EmailLogRow = Prisma.EmailLogGetPayload<object>;

/** Legt den Versandversuch an. created = false heißt: Diesen Versuch gibt es schon, nicht noch einmal senden. */
export async function claimEmail(input: EnqueueEmailInput): Promise<{ log: EmailLogRow; created: boolean }> {
  const where = { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } };
  const existing = await db.emailLog.findUnique({ where });
  if (existing) return { log: existing, created: false };
  try {
    const earlier = await db.emailLog.count({ where: { tenantId: input.tenantId, bookingId: input.bookingId ?? null, template: input.template } });
    const log = await db.emailLog.create({
      data: {
        tenantId: input.tenantId,
        bookingId: input.bookingId ?? null,
        handoverId: input.handoverId ?? null,
        invoiceId: input.invoiceId ?? null,
        invoiceVersionId: input.invoiceVersionId ?? null,
        payoutId: input.payoutId ?? null,
        recipient: input.recipient.trim().toLowerCase().slice(0, 320),
        subject: input.subject,
        template: input.template,
        attachments: (input.attachments ?? []) as unknown as Prisma.InputJsonValue,
        trigger: input.trigger ?? "AUTO",
        attemptNo: earlier + 1,
        createdById: input.createdById ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return { log, created: true };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // ein paralleler Request war schneller: dessen Eintrag gilt
    const winner = await db.emailLog.findUnique({ where });
    if (!winner) throw e;
    return { log: winner, created: false };
  }
}

/** Reiht eine E-Mail ein. Gibt bei wiederholtem Aufruf den vorhandenen Eintrag zurück. */
export async function enqueueEmail(input: EnqueueEmailInput) {
  return (await claimEmail(input)).log;
}

export async function markEmailSent(tenantId: string, id: string, providerMessageId: string | null) {
  const now = new Date();
  return db.emailLog.updateMany({ where: { id, tenantId }, data: { status: "SENT", providerMessageId, sentAt: now, lastAttemptAt: now, error: null, attempts: { increment: 1 } } });
}

export async function markEmailFailed(tenantId: string, id: string, error: string) {
  return db.emailLog.updateMany({ where: { id, tenantId }, data: { status: "FAILED", error: error.slice(0, 500), lastAttemptAt: new Date(), attempts: { increment: 1 } } });
}

/** Versandhistorie einer Buchung, neueste zuerst. */
export function listBookingEmails(tenantId: string, bookingId: string, take = 10) {
  return db.emailLog.findMany({ where: { tenantId, bookingId }, orderBy: { createdAt: "desc" }, take });
}

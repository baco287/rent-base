// Protokoll kritischer Geldaktionen. Wird in derselben Transaktion wie die Aktion geschrieben, damit Aktion und
// Eintrag nur gemeinsam existieren. Keine Kundendaten, nur Bezug (Buchung, Rechnung, Zahlung, Kaution), Betrag, Benutzer.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { AuditAction } from "@/lib/constants";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; name: string };

export type AuditInput = {
  action: AuditAction;
  bookingId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  depositId?: string | null;
  amountCents?: number | null;
  details?: Record<string, string | number | boolean | null>;
};

export function recordAudit(tx: Tx, tenantId: string, actor: Actor | null, input: AuditInput) {
  return tx.auditLog.create({
    data: {
      tenantId,
      action: input.action,
      bookingId: input.bookingId ?? null,
      invoiceId: input.invoiceId ?? null,
      paymentId: input.paymentId ?? null,
      depositId: input.depositId ?? null,
      amountCents: input.amountCents ?? null,
      details: (input.details ?? {}) as Prisma.InputJsonValue,
      userId: actor?.id ?? null,
      userName: actor?.name ?? null,
    },
  });
}

/** Geldaktionen einer Buchung, neueste zuerst. */
export function listBookingAudit(tenantId: string, bookingId: string, take = 30) {
  return db.auditLog.findMany({ where: { tenantId, bookingId }, orderBy: { createdAt: "desc" }, take });
}

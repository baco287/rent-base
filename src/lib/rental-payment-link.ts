// Übergang Mietzahlung → Mietrechnung. Eine Mietzahlung (Payment.type RENTAL_PAYMENT) hängt vor der Rechnung nur an
// der Buchung. Beim Abschluss der ersten Fassung der Mietrechnung werden alle bestätigten, noch nicht zugeordneten
// Mietzahlungen der Buchung einmalig mit dieser Rechnung verknüpft (DB-Trigger erlaubt nur diesen einen Übergang).
// Ab dann zählen Saldo, Überzahlung, Erstattung und Gutschrift sie wie jede Rechnungszahlung.
// Eigenes Modul ohne Abhängigkeit zu payments.ts/invoices.ts, damit invoices.ts es ohne Importkreis nutzen kann.

import type { Prisma } from "@prisma/client";
import { recordAudit, type Actor } from "@/lib/audit";
import type { Cents } from "@/lib/money";

type Tx = Prisma.TransactionClient;

/**
 * Sperrt die Buchung (serialisiert mit dem Erfassen von Mietzahlungen) und liefert die Summe der bestätigten,
 * noch keiner Rechnung zugeordneten Mietzahlungen.
 */
export async function lockUnlinkedRentalPayments(tx: Tx, tenantId: string, bookingId: string): Promise<Cents> {
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const sum = await tx.payment.aggregate({ where: { tenantId, bookingId, type: "RENTAL_PAYMENT", invoiceId: null, status: "CONFIRMED" }, _sum: { amountCents: true } });
  return sum._sum.amountCents ?? 0;
}

/** Ordnet die offenen Mietzahlungen der gerade abgeschlossenen Mietrechnung zu. Erwartet die Sperre aus lockUnlinkedRentalPayments. */
export async function linkRentalPaymentsToInvoice(tx: Tx, tenantId: string, actor: Actor, invoice: { id: string; bookingId: string; number: string | null }): Promise<number> {
  const rows = await tx.payment.findMany({ where: { tenantId, bookingId: invoice.bookingId, type: "RENTAL_PAYMENT", invoiceId: null, status: "CONFIRMED" }, select: { id: true, amountCents: true } });
  if (rows.length === 0) return 0;
  await tx.payment.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { invoiceId: invoice.id } });
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  await recordAudit(tx, tenantId, actor, { action: "RENTAL_PAYMENTS_LINKED", bookingId: invoice.bookingId, invoiceId: invoice.id, amountCents: total, details: { invoiceNumber: invoice.number, count: rows.length } });
  return rows.length;
}

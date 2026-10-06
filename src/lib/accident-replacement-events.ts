// Befehl 29: Verlaufseinträge der Unfallersatz-Fallakte (nur anfügen) und die Sperre geschlossener Fälle. Ohne weitere
// Abhängigkeiten, damit Vertrag, Übergabe/Rückgabe, Storno und Nachträge sie nutzen können, ohne die Fallakten-Bibliothek zu importieren.

import type { Prisma } from "@prisma/client";
import type { AccidentCaseEventType } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string } | null;
export type CaseEventData = { type: AccidentCaseEventType; fromValue?: string | null; toValue?: string | null; reason?: string | null; note?: string | null };

/** Phase E: eine Meldung für jede Sperre eines geschlossenen Unfallersatzfalls (Fallakte, Vertrag, Übergabe, Rückgabe, Storno …). */
export const ACCIDENT_CASE_CLOSED_MESSAGE = "Der Unfallersatzfall ist abgeschlossen und kann nicht mehr bearbeitet werden.";

/**
 * Phase E: Domänensperre für geschlossene Unfallersatzfälle in Prozessen, die nur die Buchung kennen (Vertrag, Übergabe, Rückgabe,
 * Schlüsselbox, Statuswechsel, Storno, Nachtrag). Nicht nur Knöpfe verstecken – jede dieser Server-Funktionen ruft dies auf.
 * FOR SHARE reiht sich hinter Abschließen/Wiederöffnen (FOR NO KEY UPDATE) ein, sodass der Fall während des Vorgangs nicht
 * geschlossen werden kann. Aufruf VOR jeder Sperre auf Buchung oder Vertrag (Reihenfolge Fall → Buchung/Vertrag wie
 * updatePlannedEnd/setTariff, sonst Deadlock). Standardmieten haben keine Fallakte: dann geschieht nichts.
 */
export async function assertAccidentCaseOpen(tx: Tx, tenantId: string, bookingId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "AccidentReplacementCase" WHERE "bookingId" = ${bookingId} AND "tenantId" = ${tenantId} FOR SHARE`;
  if (rows[0]?.status === "CLOSED") throw new DomainError(ACCIDENT_CASE_CLOSED_MESSAGE);
}

/**
 * Phase F: Finanzvorgänge an Unfallersatz-Rechnungen (Entwurf, Abschluss, Zahlung, Gegenbeleg, Mahnung, Kürzung) – gesperrt bei
 * geschlossenem Fall. Buchung über die Rechnung bzw. den Gegenbeleg (der die Art seines Originals übernimmt). Andere Rechnungsarten:
 * nichts. Aufruf vor Sperren auf Buchung oder Kaution (Reihenfolge Fall → Buchung); eine vorher gehaltene Rechnungssperre ist
 * unkritisch, weil kein Fallvorgang Rechnungen sperrt.
 */
export async function assertAccidentInvoiceCaseOpen(tx: Tx, tenantId: string, invoiceId: string | null | undefined): Promise<void> {
  const acc = await accidentInvoiceOf(tx, tenantId, invoiceId);
  if (acc) await assertAccidentCaseOpen(tx, tenantId, acc.bookingId);
}

/**
 * Befehl 29 Phase F: Abfragebedingung „Beleg der Unfallersatz-Abrechnung“ – Unfallersatz-Rechnung und ihre Gegenbelege (übernehmen
 * die Art), Mahngebühr-Rechnung zu einer Unfallersatz-Rechnung und deren Gegenbelege. Für die Hof-Sicht in globalen Listen
 * (`{ NOT: ACCIDENT_BILLING_WHERE }`); Gegenstück zu accidentInvoiceOf.
 */
export const ACCIDENT_BILLING_WHERE: Prisma.InvoiceWhereInput = {
  OR: [
    { kind: "ACCIDENT_REPLACEMENT" },
    { dunningFeeOf: { is: { invoice: { is: { kind: "ACCIDENT_REPLACEMENT" } } } } },
    { original: { is: { dunningFeeOf: { is: { invoice: { is: { kind: "ACCIDENT_REPLACEMENT" } } } } } } },
  ],
};

/**
 * Gehört ein Beleg zur Unfallersatz-Abrechnung? Unfallersatz-Rechnung selbst, ihr Gegenbeleg (übernimmt die Art), eine
 * Mahngebühr-Rechnung zu einer Unfallersatz-Rechnung sowie deren Gegenbelege. Liefert die Buchung der Unfallersatz-Rechnung
 * (für Fallsperre und Hof-Sicht); andere Belege (Miete, Schaden, Behörde, frei): null. Ohne Sperre.
 */
export async function accidentInvoiceOf(client: Pick<Tx, "invoice" | "dunningNotice">, tenantId: string, invoiceId: string | null | undefined): Promise<{ invoiceId: string; bookingId: string } | null> {
  let id = invoiceId ?? null;
  for (let step = 0; id && step < 4; step++) {
    const inv = await client.invoice.findFirst({ where: { id, tenantId }, select: { id: true, kind: true, bookingId: true, originalInvoiceId: true } });
    if (!inv) return null;
    if (inv.kind === "ACCIDENT_REPLACEMENT") return inv.bookingId ? { invoiceId: inv.originalInvoiceId ?? inv.id, bookingId: inv.bookingId } : null;
    if (inv.kind !== "DUNNING_FEE") return null;
    // Gegenbeleg einer Mahngebühr → die Gebührenrechnung; Gebührenrechnung → die gemahnte Rechnung
    if (inv.originalInvoiceId) { id = inv.originalInvoiceId; continue; }
    id = (await client.dunningNotice.findFirst({ where: { tenantId, feeInvoiceId: inv.id }, select: { invoiceId: true } }))?.invoiceId ?? null;
  }
  return null;
}

/**
 * Phase F: Gehört ein archiviertes Dokument (Rechnungs-PDF, Gutschrift, Stornobeleg, Mahnschreiben) zur Unfallersatz-Abrechnung?
 * Für die Hof-Sicht: Die Abrechnung sehen nur Inhaber und Disposition – auch nicht über die allgemeine Dokument-Adresse.
 */
export async function isAccidentBillingDocument(client: Pick<Tx, "invoice" | "dunningNotice" | "invoiceVersion" | "payout">, tenantId: string, d: { invoiceId?: string | null; invoiceVersionId?: string | null; dunningNoticeId?: string | null; payoutId?: string | null }): Promise<boolean> {
  let invoiceId = d.invoiceId ?? null;
  // Befehl 30 Phase I: Auszahlungsbeleg/-nachweis einer Erstattung zu einer Unfallersatz-Rechnung
  if (!invoiceId && d.payoutId) invoiceId = (await client.payout.findFirst({ where: { id: d.payoutId, tenantId }, select: { invoiceId: true } }))?.invoiceId ?? null;
  if (!invoiceId && d.invoiceVersionId) invoiceId = (await client.invoiceVersion.findFirst({ where: { id: d.invoiceVersionId, tenantId }, select: { invoiceId: true } }))?.invoiceId ?? null;
  if (!invoiceId && d.dunningNoticeId) invoiceId = (await client.dunningNotice.findFirst({ where: { id: d.dunningNoticeId, tenantId }, select: { invoiceId: true } }))?.invoiceId ?? null;
  return !!(await accidentInvoiceOf(client, tenantId, invoiceId));
}

/** Ohne Sperre, für Prüflisten und Anzeigen (Assistenten zeigen den Grund, bevor jemand auf „Abschließen“ drückt). */
export async function accidentCaseClosed(client: Pick<Tx, "accidentReplacementCase">, tenantId: string, bookingId: string): Promise<boolean> {
  return (await client.accidentReplacementCase.count({ where: { tenantId, bookingId, status: "CLOSED" } })) > 0;
}

export function accidentCaseEvent(tx: Tx, tenantId: string, caseId: string, actor: Actor, data: CaseEventData) {
  return tx.accidentReplacementCaseEvent.create({ data: { tenantId, caseId, type: data.type, fromValue: data.fromValue ?? null, toValue: data.toValue ?? null, reason: data.reason ?? null, note: data.note ?? null, userId: actor?.id ?? null, userName: actor?.name ?? null } });
}

/** Für Prozesse, die nur die Buchung kennen (Übergabe, Rückgabe, Rechnung): Eintrag nur, wenn zur Buchung eine Fallakte existiert. */
export async function accidentCaseEventForBooking(tx: Tx, tenantId: string, bookingId: string, actor: Actor, data: CaseEventData): Promise<boolean> {
  const c = await tx.accidentReplacementCase.findFirst({ where: { tenantId, bookingId }, select: { id: true } });
  if (!c) return false;
  await accidentCaseEvent(tx, tenantId, c.id, actor, data);
  return true;
}

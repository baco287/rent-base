// Befehl 21: Rechnungsabschluss mit bewusst bestätigter Kautionsverrechnung – EIN atomarer Vorgang.
//
// Grundsätze:
// - Keine automatische Kautionsverrechnung. Rent-Base schlägt min(offene Forderung, verfügbare Kaution) nur vor; gebucht
//   wird ausschließlich der Betrag, den der Vermieter vor dem Abschluss ausdrücklich ausgewählt und bestätigt hat.
// - Die Auswahl in der Oberfläche erzeugt nichts. Erst der Abschluss bucht – und zwar Rechnungsabschluss UND Verrechnung
//   in derselben Transaktion: scheitert eines von beiden (z. B. Betrag über der offenen Forderung, Kaution inzwischen
//   freigegeben, Rechnung nicht abschließbar), bleibt die Rechnung Entwurf und es gibt keine Kautionsbewegung.
// - Keine zweite Verrechnungslogik: gebucht wird über applyDepositOffsetIn (deposit-offset.ts, Befehl 20.7) – Zahlung vom
//   Typ DEPOSIT_OFFSET zur Rechnung + Kautionsbewegung OFFSET, mit denselben Prüfungen, demselben Audit.
// - Die Rechnung selbst bleibt unverändert: Positionen, Netto, Steuer und Brutto sind die Forderung. Die Verrechnung ist
//   Ausgleichsebene (wie eine Zahlung), keine Rechnungsposition, kein Mietumsatz, kein Geldeingang.
// - Die verbleibende Kaution wird dadurch weder freigegeben noch ausgezahlt; das bleiben eigene, bewusste Vorgänge.
// - Sperr-Reihenfolge wie überall (deposits.ts): Booking → SecurityDeposit → Invoice → Payment.

import { db } from "@/lib/db";
import type { Actor } from "@/lib/audit";
import { applyDepositOffsetIn, type DepositOffsetResult } from "@/lib/deposit-offset";
import { checkDate, checkKey, domainFromDb, lockOrCreateDeposit, parseAmount } from "@/lib/deposits";
import { DomainError } from "@/lib/integrity";
import { assertAccidentInvoiceCaseOpen } from "@/lib/accident-replacement-events";
import { finalizeErrorOf, finalizeInvoiceIn, type FinalizeOptions, type VersionWithItems } from "@/lib/invoices";
import { isUniqueViolation, withNumberRetry } from "@/lib/numbering";

const TX = { timeout: 30_000, maxWait: 10_000 };

export type ConfirmedDepositOffset = {
  /** vom Vermieter ausdrücklich bestätigter Betrag (Pflicht – nie „leer = Vorschlag“) */
  amount: string | number;
  occurredAt: Date;
  note?: string | null;
  /** einmaliger Schlüssel des Abschlussformulars: Doppelklick/Reload bucht nie doppelt */
  idempotencyKey: string;
};

export type SettlementResult = { version: VersionWithItems; offset: DepositOffsetResult; created: boolean };

const offsetByKey = (tenantId: string, key: string) => db.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } }, include: { depositOffsetEvent: true } });

async function alreadySettled(tenantId: string, invoiceId: string, key: string): Promise<SettlementResult | null> {
  const payment = await offsetByKey(tenantId, key);
  if (!payment) return null;
  if (payment.invoiceId !== invoiceId || payment.type !== "DEPOSIT_OFFSET") throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const inv = await db.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { currentVersionId: true } });
  if (!inv?.currentVersionId) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const version = await db.invoiceVersion.findFirstOrThrow({ where: { id: inv.currentVersionId, tenantId }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  return { version, offset: { payment, event: payment.depositOffsetEvent, created: false }, created: false };
}

/**
 * Schließt den offenen Rechnungsentwurf ab und verrechnet den bestätigten Betrag aus der verfügbaren Kaution – gemeinsam
 * oder gar nicht. Gleicher Schlüssel liefert den bereits gebuchten Vorgang zurück.
 */
export async function finalizeInvoiceWithDepositOffset(tenantId: string, invoiceId: string, actor: Actor, opts: FinalizeOptions, offset: ConfirmedDepositOffset): Promise<SettlementResult> {
  const key = checkKey(offset.idempotencyKey);
  if (!key) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  checkDate(offset.occurredAt, "den Zeitpunkt");
  if (parseAmount(offset.amount, "Der Verrechnungsbetrag") <= 0) throw new DomainError("Der Verrechnungsbetrag muss größer als 0,00 € sein.");
  const done = await alreadySettled(tenantId, invoiceId, key);
  if (done) return done;
  const head = await db.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { bookingId: true, documentType: true } });
  if (!head) throw new DomainError("Rechnung nicht gefunden.");
  if (head.documentType !== "INVOICE") throw new DomainError("Verrechnet wird nur mit Rechnungen, nicht mit Gutschriften oder Stornobelegen.");
  // Befehl 23.1: eine Kaution gehört zu ihrer Buchung – ohne Buchungsbezug keine Kautionsverrechnung
  const bookingId = head.bookingId;
  if (!bookingId) throw new DomainError("Diese Rechnung hat keinen Buchungsbezug und damit keine Kaution.");
  try {
    return await withNumberRetry(() =>
      db.$transaction(async (tx) => {
        // Befehl 29 Phase F: geschlossener Unfallersatzfall zuerst (Fall → Buchung)
        await assertAccidentInvoiceCaseOpen(tx, tenantId, invoiceId);
        // Reihenfolge der Sperren: zuerst Buchung und Kaution, dann (im Abschluss) die Rechnung
        await lockOrCreateDeposit(tx, tenantId, bookingId, actor);
        const version = await finalizeInvoiceIn(tx, tenantId, invoiceId, actor, opts);
        const result = await applyDepositOffsetIn(tx, tenantId, actor, { bookingId, invoiceId, amount: offset.amount, occurredAt: offset.occurredAt, note: offset.note ?? "Bei Rechnungsabschluss ausdrücklich bestätigt", idempotencyKey: key }, key);
        return { version, offset: result, created: true };
      }, TX),
    );
  } catch (e) {
    if (isUniqueViolation(e, "idempotencyKey")) {
      const winner = await alreadySettled(tenantId, invoiceId, key);
      if (winner) return winner;
    }
    try {
      return finalizeErrorOf(e);
    } catch (mapped) {
      return domainFromDb(mapped);
    }
  }
}

/** Ausgangslage der bewussten Kautionsverrechnung für einen Rechnungsentwurf (nur Zahlen – es wird nichts gebucht). */
export type DepositOffsetStart = { grossCents: number; paidCents: number; openCents: number; receivedCents: number; usedCents: number; availableCents: number; suggestedCents: number };

/**
 * Vorschlag = min(offene Forderung nach Abschluss, tatsächlich verfügbare Kaution). null, wenn nichts zu verrechnen ist:
 * Miete nicht zurückgegeben/storniert, keine Kaution erhalten, nichts verfügbar oder nichts offen. Dieselben Summen wie
 * überall: Kautionsseite aus depositView, Forderungsseite aus dem Entwurfsbetrag und den dokumentierten Zahlungen.
 */
export function depositOffsetStart(input: { bookingStatus: string; grossCents: number; paidCents: number; receivedCents: number; remainingCents: number }): DepositOffsetStart | null {
  const openCents = Math.max(0, input.grossCents - input.paidCents);
  const availableCents = Math.max(0, input.remainingCents);
  if (input.bookingStatus !== "RETURNED" && input.bookingStatus !== "CANCELLED") return null;
  if (input.receivedCents <= 0 || availableCents <= 0 || openCents <= 0) return null;
  return { grossCents: input.grossCents, paidCents: input.paidCents, openCents, receivedCents: input.receivedCents, usedCents: input.receivedCents - availableCents, availableCents, suggestedCents: Math.min(openCents, availableCents) };
}

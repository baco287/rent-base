// Fortlaufende Nummern je Mandant und Jahr: Präfix-JJJJ-NNNN.
// Gleiche Logik wie die Buchungsnummer, für Verträge und Protokolle wiederverwendet.
import type { Prisma } from "@prisma/client";
import { amendmentPrefix, dunningPrefix, nextInRange, numberRangesOf, payoutPrefix, rangePrefix, type InvoiceDocumentType, type NumberRanges } from "@/lib/number-ranges";

type Tx = Prisma.TransactionClient;

function nextFrom(last: string | undefined, prefix: string) {
  const n = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}

export async function nextContractNumber(tx: Tx, tenantId: string, date = new Date()) {
  const prefix = `MV-${date.getFullYear()}-`;
  const last = await tx.rentalContract.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  return nextFrom(last?.number, prefix);
}

export async function nextHandoverNumber(tx: Tx, tenantId: string, type: "PICKUP" | "RETURN", date = new Date()) {
  const prefix = `${type === "PICKUP" ? "UP" : "RP"}-${date.getFullYear()}-`;
  const last = await tx.handover.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  return nextFrom(last?.number, prefix);
}

export async function nextCustomerNumber(tx: Tx, tenantId: string) {
  const prefix = "K-";
  const last = await tx.customer.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  const n = last?.number ? parseInt(last.number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(5, "0")}`;
}

/** true, wenn ein Prisma-Fehler eine verletzte Eindeutigkeit meldet; optional für ein bestimmtes Feld. */
export function isUniqueViolation(e: unknown, field?: string): boolean {
  if (!e || typeof e !== "object" || (e as { code?: string }).code !== "P2002") return false;
  if (!field) return true;
  const target = (e as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(target) ? target.includes(field) : String(target ?? "").includes(field);
}

/** Felder, in denen fortlaufende Nummern je Mandant vergeben werden (eindeutiger Index zusammen mit tenantId). */
export type NumberField = "number" | "caseNumber" | "maintenanceNumber";

/**
 * Führt eine Anlage mit fortlaufender Nummer aus und wiederholt sie, wenn zwei gleichzeitige Anfragen
 * dieselbe Nummer gezogen haben. Die Eindeutigkeit selbst sichert der Datenbank-Index. Wiederholt wird nur bei einer
 * Kollision auf dem Nummernfeld, das die Anlage vergibt (Standard "number"); jede andere Eindeutigkeit geht an den Aufrufer.
 */
export async function withNumberRetry<T>(fn: () => Promise<T>, field: NumberField = "number", attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isUniqueViolation(e, field)) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 15 * (i + 1) + Math.random() * 25));
    }
  }
  throw lastError;
}

/**
 * Belegnummer PREFIX-JJJJ-NNNNNN je Nummernkreis (Rechnung / Gutschrift / Stornobeleg, Präfix je Mandant konfigurierbar,
 * Standard RE / GS / ST). Wird erst beim Abschluss vergeben; der eindeutige Index (tenantId, number) verhindert Doppelte,
 * der Aufrufer wiederholt (withNumberRetry). Nummern werden nie wiederverwendet: Grundlage ist die höchste vergebene Nummer.
 */
export async function nextDocumentNumber(tx: Tx, tenantId: string, type: InvoiceDocumentType, date = new Date()) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { numberRanges: true } });
  const prefix = rangePrefix(numberRangesOf(tenant.numberRanges), type, date.getFullYear());
  const last = await tx.invoice.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  return nextInRange(prefix, last?.number);
}

/** Rechnungsnummer (Kreis „Rechnungen“, Standard RE-JJJJ-NNNNNN). */
export async function nextInvoiceNumber(tx: Tx, tenantId: string, date = new Date()) {
  return nextDocumentNumber(tx, tenantId, "INVOICE", date);
}

/** Auszahlungsnummer (Kreis „Auszahlungen“, Standard AZ-JJJJ-NNNNNN), erst beim Abschluss; eindeutiger Index + withNumberRetry. */
export async function nextPayoutNumber(tx: Tx, tenantId: string, date = new Date()) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { numberRanges: true } });
  const prefix = payoutPrefix(numberRangesOf(tenant.numberRanges), date.getFullYear());
  const last = await tx.payout.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  return nextInRange(prefix, last?.number);
}

/** Mahnschreiben (Kreis „Mahnungen“, Standard MA-JJJJ-NNNNNN), beim Erstellen; eindeutiger Index + withNumberRetry. */
export async function nextDunningNumber(tx: Tx, tenantId: string, date = new Date()) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { numberRanges: true } });
  const prefix = dunningPrefix(numberRangesOf(tenant.numberRanges), date.getFullYear());
  const last = await tx.dunningNotice.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  return nextInRange(prefix, last?.number);
}

/** Befehl 25: Nachtrag zum Mietvertrag (Kreis „Nachträge“, Standard NT-JJJJ-NNNNNN), erst bei Unterschrift; Index + withNumberRetry. */
export async function nextAmendmentNumber(tx: Tx, tenantId: string, date = new Date()) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { numberRanges: true } });
  const prefix = amendmentPrefix(numberRangesOf(tenant.numberRanges), date.getFullYear());
  const last = await tx.contractAmendment.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  return nextInRange(prefix, last?.number);
}

/** Vorschau der nächsten Nummer je Kreis (Einstellungen); vergibt nichts. */
export async function previewNextNumbers(client: Tx, tenantId: string, ranges: NumberRanges, date = new Date()) {
  const out: Record<InvoiceDocumentType | "PAYOUT" | "DUNNING" | "AMENDMENT", string> = { INVOICE: "", CREDIT_NOTE: "", CANCELLATION: "", PAYOUT: "", DUNNING: "", AMENDMENT: "" };
  for (const type of ["INVOICE", "CREDIT_NOTE", "CANCELLATION"] as InvoiceDocumentType[]) {
    const prefix = rangePrefix(ranges, type, date.getFullYear());
    const last = await client.invoice.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
    out[type] = nextInRange(prefix, last?.number);
  }
  const pp = payoutPrefix(ranges, date.getFullYear());
  const lastPayout = await client.payout.findFirst({ where: { tenantId, number: { startsWith: pp } }, orderBy: { number: "desc" }, select: { number: true } });
  out.PAYOUT = nextInRange(pp, lastPayout?.number);
  const dp = dunningPrefix(ranges, date.getFullYear());
  const lastDunning = await client.dunningNotice.findFirst({ where: { tenantId, number: { startsWith: dp } }, orderBy: { number: "desc" }, select: { number: true } });
  out.DUNNING = nextInRange(dp, lastDunning?.number);
  const ap = amendmentPrefix(ranges, date.getFullYear());
  const lastAmendment = await client.contractAmendment.findFirst({ where: { tenantId, number: { startsWith: ap } }, orderBy: { number: "desc" }, select: { number: true } });
  out.AMENDMENT = nextInRange(ap, lastAmendment?.number);
  return out;
}

/** Schadenaktennummer SCH-JJJJ-NNNNNN, je Mandant fortlaufend; Eindeutigkeit über den Index, Kollision → withNumberRetry. */
export async function nextDamageCaseNumber(tx: Tx, tenantId: string, date = new Date()) {
  const prefix = `SCH-${date.getFullYear()}-`;
  const last = await tx.damageCase.findFirst({ where: { tenantId, caseNumber: { startsWith: prefix } }, orderBy: { caseNumber: "desc" }, select: { caseNumber: true } });
  const n = last?.caseNumber ? parseInt(last.caseNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(6, "0")}`;
}

/** Wartungsvorgang: WA-JJJJ-NNNNNN, mandantenweit eindeutig; mit withNumberRetry verwenden. */
export async function nextMaintenanceNumber(tx: Tx, tenantId: string, date = new Date()) {
  const prefix = `WA-${date.getFullYear()}-`;
  const last = await tx.maintenanceRecord.findFirst({ where: { tenantId, maintenanceNumber: { startsWith: prefix } }, orderBy: { maintenanceNumber: "desc" }, select: { maintenanceNumber: true } });
  const n = last?.maintenanceNumber ? parseInt(last.maintenanceNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(6, "0")}`;
}

/** Befehl 29: Unfallersatzfall UE-JJJJ-NNNNNN, je Mandant fortlaufend; Eindeutigkeit über den Index (tenantId, caseNumber), Kollision → erneut ziehen. */
export async function nextAccidentCaseNumber(tx: Tx, tenantId: string, date = new Date()) {
  const prefix = `UE-${date.getFullYear()}-`;
  const last = await tx.accidentReplacementCase.findFirst({ where: { tenantId, caseNumber: { startsWith: prefix } }, orderBy: { caseNumber: "desc" }, select: { caseNumber: true } });
  const n = last?.caseNumber ? parseInt(last.caseNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(6, "0")}`;
}

/** Behördenvorgang: BH-JJJJ-NNNNNN, mandantenweit eindeutig; mit withNumberRetry verwenden. */
export async function nextAuthorityCaseNumber(tx: Tx, tenantId: string, date = new Date()) {
  const prefix = `BH-${date.getFullYear()}-`;
  const last = await tx.authorityCase.findFirst({ where: { tenantId, caseNumber: { startsWith: prefix } }, orderBy: { caseNumber: "desc" }, select: { caseNumber: true } });
  const n = last?.caseNumber ? parseInt(last.caseNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(6, "0")}`;
}

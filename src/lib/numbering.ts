// Fortlaufende Nummern je Mandant und Jahr: Präfix-JJJJ-NNNN.
// Gleiche Logik wie die Buchungsnummer, für Verträge und Protokolle wiederverwendet.
import type { Prisma } from "@prisma/client";

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

/**
 * Führt eine Anlage mit fortlaufender Nummer aus und wiederholt sie, wenn zwei gleichzeitige Anfragen
 * dieselbe Nummer gezogen haben. Die Eindeutigkeit selbst sichert der Datenbank-Index.
 */
export async function withNumberRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isUniqueViolation(e, "number")) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 15 * (i + 1) + Math.random() * 25));
    }
  }
  throw lastError;
}

/** Rechnungsnummer RE-JJJJ-NNNNNN. Wird erst beim Abschluss vergeben; der eindeutige Index verhindert Doppelte, der Aufrufer wiederholt. */
export async function nextInvoiceNumber(tx: Tx, tenantId: string, date = new Date()) {
  const prefix = `RE-${date.getFullYear()}-`;
  const last = await tx.invoice.findFirst({ where: { tenantId, number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  const n = last?.number ? parseInt(last.number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(6, "0")}`;
}

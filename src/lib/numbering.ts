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

// Befehl 29.7: zählender Prisma-Client für Tests auf eine feste Zahl an Datenbankoperationen. Muss VOR jedem Import von
// src/lib/db geladen werden (erster Import der Testdatei): db.ts übernimmt einen vorhandenen globalThis.prisma. Damit zählen
// auch Abfragen, die Bibliotheken über das globale db stellen (Suchhelfer mit $queryRaw, pickupDriverCheckStatus).
// $allOperations auf oberster Ebene erfasst Modell- und Raw-Operationen (Selbstprüfung im Test; sonst siehe Plan R16).
// Kein *.test.ts – wird nur importiert.
import { PrismaClient } from "@prisma/client";

const ms = (v: string | undefined) => (v && /^\d{1,6}$/.test(v) && Number(v) > 0 ? Number(v) : undefined);
const txMaxWait = ms(process.env.RB_TX_MAX_WAIT_MS);
const txTimeout = ms(process.env.RB_TX_TIMEOUT_MS);

export const dbOps = { count: 0, log: [] as string[] };

/** Zähler zurücksetzen (vor einer Messung). */
export function resetDbOps() {
  dbOps.count = 0;
  dbOps.log = [];
}

const counted = new PrismaClient({
  log: ["error"],
  ...(txMaxWait || txTimeout ? { transactionOptions: { ...(txMaxWait ? { maxWait: txMaxWait } : {}), ...(txTimeout ? { timeout: txTimeout } : {}) } } : {}),
}).$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      dbOps.count++;
      dbOps.log.push(`${model ?? "raw"}.${operation}`);
      return query(args);
    },
  },
});

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
globalForPrisma.prisma = counted as unknown as PrismaClient;

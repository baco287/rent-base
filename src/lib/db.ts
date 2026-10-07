import { PrismaClient } from "@prisma/client";

// Im Dev-Modus lädt Next.js Module mehrfach neu; ein globaler Client verhindert zu viele Verbindungen.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Lokale Testläufe gegen PGlite (`prisma dev` bedient Verbindungen nacheinander): Wartezeit auf den Beginn und
// Laufzeit interaktiver Transaktionen per Umgebungsvariable verlängerbar, damit Rauchtest und Entwicklungsserver
// sich nicht gegenseitig in P2028 treiben. In Produktion nicht gesetzt → Prisma-Standard (2 s / 5 s);
// Optionen einzelner Transaktionen haben Vorrang.
const ms = (v: string | undefined) => (v && /^\d{1,6}$/.test(v) && Number(v) > 0 ? Number(v) : undefined);
const txMaxWait = ms(process.env.RB_TX_MAX_WAIT_MS);
const txTimeout = ms(process.env.RB_TX_TIMEOUT_MS);

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    ...(txMaxWait || txTimeout ? { transactionOptions: { ...(txMaxWait ? { maxWait: txMaxWait } : {}), ...(txTimeout ? { timeout: txTimeout } : {}) } } : {}),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

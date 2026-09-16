import { PrismaClient } from "@prisma/client";

// Im Dev-Modus lädt Next.js Module mehrfach neu; ein globaler Client verhindert zu viele Verbindungen.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

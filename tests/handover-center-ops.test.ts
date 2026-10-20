// Befehl 29.7 (Testpunkt 24): kein N+1 – die Übergabe- und Rückgabezentrale stellt eine feste Zahl an Datenbankoperationen,
// unabhängig von der Zahl der Buchungen (5 gegen 60), mit und ohne Suche. Obergrenzen: Übergaben 12, Rückgaben 11.
// Prüfbefund T1: jede Liste hat in beiden Welten Einträge (auch Protokolllisten und Übergabeentwürfe), sodass alle Runden
// (Seite laden, Fahrerprüfung mit Prüfvermerken, „Fahrzeug unterwegs“) gemessen werden und die Obergrenze 12 erreicht wird.
// Erster Import: der zählende Client (muss vor src/lib/db geladen sein, damit auch Raw-Abfragen und Helfer über das globale db zählen).
import { dbOps, resetDbOps } from "./db-op-counter";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { centerFilters, handoverCenter, type CenterFilter, type CenterKind } from "../src/lib/handover-center";
import { parseLocalDateTime } from "../src/lib/time";
import { createWorld, purgeTenants, type World } from "./helpers";

process.env.MAIL_DEV_OUTBOX = "";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const DAY = 86_400_000;
/** 20.10.2026, 10:00 Berliner Zeit */
const NOW = new Date("2026-10-20T08:00:00Z");
const B = (s: string) => parseLocalDateTime(s)!;
const LIMIT: Record<CenterKind, number> = { PICKUP: 12, RETURN: 11 };

/**
 * Je i (eigenes Fahrzeug, Testdaten ohne Geschäftslogik, per createMany):
 *   P   Abholung heute (reserviert) mit Übergabeentwurf          → Übergaben heute / in Bearbeitung
 *   R   Rückgabe heute (laufend), Vertrag, Übergabe abgeschlossen, Rückgabeentwurf → Rückgaben heute / in Bearbeitung,
 *       Übergaben abgeschlossen
 *   PO  Abholung gestern (reserviert)                            → Übergaben überfällig
 *   RO  Rückgabe gestern (laufend)                               → Rückgaben überfällig
 *   RA  Rückgabe übermorgen (laufend)                            → Rückgaben anstehend
 *   UE  Unfallersatz mit offenem Ende (laufend)                  → Offenes Mietende
 *   RD  zurückgegeben mit beiden Protokollen                     → Rückgaben/Übergaben abgeschlossen
 * Übergaben „anstehend“: die Buchung von createWorld (+60 Tage). „Heute“ bleibt bei genau n Übergaben und n Rückgaben.
 */
async function world(label: string, n: number): Promise<World> {
  const w = await createWorld(label, { startInDays: 60 });
  tenants.push(w.tenantId);
  const T = w.tenantId;
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const id = (k: string, i: number) => `op-${run}-${k}-${i}`;
  const nr = (k: string, i: number) => `${k}-${String(i).padStart(3, "0")}`;
  const at = (s: string, i: number) => new Date(B(s).getTime() + i * 60_000);
  const range = Array.from({ length: n }, (_, i) => i);

  await db.vehicle.createMany({ data: range.map((i) => ({ id: id("v", i), tenantId: T, plate: `HB-OP ${String(i).padStart(3, "0")}`, make: "VW", model: "Golf", groupId: w.groupId, dailyRate: 49, deposit: 0 })) });
  const base = { tenantId: T, customerId: w.customerId, dailyRate: 49, deposit: 0 };
  const bookings: Prisma.BookingCreateManyInput[] = range.flatMap((i): Prisma.BookingCreateManyInput[] => {
    const vehicleId = id("v", i);
    const pickupAt = at("2026-10-20T11:00", i);
    return [
      { ...base, id: id("p", i), number: nr("OP-P", i), vehicleId, startAt: pickupAt, endAt: new Date(pickupAt.getTime() + 2 * DAY) },
      { ...base, id: id("r", i), number: nr("OP-R", i), vehicleId, status: "ACTIVE", startAt: B("2026-10-15T10:00"), endAt: at("2026-10-20T12:00", i), actualPickupAt: B("2026-10-15T10:00") },
      { ...base, id: id("po", i), number: nr("OP-PO", i), vehicleId, startAt: at("2026-10-19T10:00", i), endAt: at("2026-10-21T10:00", i) },
      { ...base, id: id("ro", i), number: nr("OP-RO", i), vehicleId, status: "ACTIVE", startAt: B("2026-10-12T10:00"), endAt: at("2026-10-19T12:00", i), actualPickupAt: B("2026-10-12T10:00") },
      { ...base, id: id("ra", i), number: nr("OP-RA", i), vehicleId, status: "ACTIVE", startAt: B("2026-10-14T10:00"), endAt: at("2026-10-22T12:00", i), actualPickupAt: B("2026-10-14T10:00") },
      { ...base, id: id("ue", i), number: nr("OP-UE", i), vehicleId, status: "ACTIVE", rentalType: "ACCIDENT_REPLACEMENT", startAt: B("2026-10-13T10:00"), endAt: null, actualPickupAt: B("2026-10-13T10:00") },
      { ...base, id: id("rd", i), number: nr("OP-RD", i), vehicleId, status: "RETURNED", startAt: B("2026-10-05T10:00"), endAt: B("2026-10-08T10:00"), actualPickupAt: B("2026-10-05T10:00"), actualReturnAt: at("2026-10-08T09:00", i) },
    ];
  });
  await db.booking.createMany({ data: bookings });
  await db.rentalContract.createMany({
    data: range.map((i): Prisma.RentalContractCreateManyInput => ({ id: id("c", i), tenantId: T, bookingId: id("r", i), number: nr("MV-OP", i), status: "SIGNED", customerId: w.customerId, vehicleId: id("v", i), customerSnapshot: {}, vehicleSnapshot: {}, priceSnapshot: {}, startAt: B("2026-10-15T10:00"), endAt: at("2026-10-20T12:00", i), signedAt: B("2026-10-15T09:00") })),
  });
  const handovers: Prisma.HandoverCreateManyInput[] = range.flatMap((i): Prisma.HandoverCreateManyInput[] => {
    const h = (key: string, number: string, bookingKey: string, type: "PICKUP" | "RETURN", status: "DRAFT" | "FINALIZED", finalizedAt: Date | null = null): Prisma.HandoverCreateManyInput => ({
      id: id(key, i), tenantId: T, bookingId: id(bookingKey, i), vehicleId: id("v", i), type, status, number: nr(number, i), employeeName: "Hof Test", driveType: "DIESEL", finalizedAt,
    });
    return [
      h("hpd", "UP-OPD", "p", "PICKUP", "DRAFT"),
      h("hrp", "UP-OPR", "r", "PICKUP", "FINALIZED", B("2026-10-15T10:05")),
      h("hrd", "RP-OPR", "r", "RETURN", "DRAFT"),
      h("hdp", "UP-OPF", "rd", "PICKUP", "FINALIZED", B("2026-10-05T10:05")),
      h("hdr", "RP-OPF", "rd", "RETURN", "FINALIZED", at("2026-10-08T09:30", i)),
    ];
  });
  await db.handover.createMany({ data: handovers });
  return w;
}

async function measure(tenantId: string, kind: CenterKind, filter: CenterFilter, q: string) {
  resetDbOps();
  const c = await handoverCenter(tenantId, { kind, filter, q, now: NOW, viewer: { role: "OWNER", support: false } });
  return { ops: dbOps.count, log: [...dbOps.log], rows: c.rows.length, total: c.total };
}

test("24 Selbstprüfung: der zählende Client erfasst Modell- und Raw-Operationen über das globale db", async () => {
  resetDbOps();
  await db.$queryRaw`SELECT 1`;
  assert.equal(dbOps.count, 1, `Raw-Abfrage gezählt (${dbOps.log.join(", ")})`);
  resetDbOps();
  await db.tenant.count();
  assert.equal(dbOps.count, 1);
});

test("24 Kein N+1: gleiche Zahl an Operationen bei 5 und 60 Buchungen in jeder Liste, mit und ohne Suche; Übergaben ≤ 12, Rückgaben ≤ 11", async () => {
  const small = await world("uz-ops-5", 5);
  const large = await world("uz-ops-60", 60);
  // Suchbegriffe: ohne, Name (eine Raw-Abfrage über Kennzeichen), Telefon (Kennzeichen und Telefonziffern: zwei Raw-Abfragen)
  for (const q of ["", "Muster", "0421 12345"]) {
    for (const kind of ["PICKUP", "RETURN"] as CenterKind[]) {
      for (const filter of centerFilters(kind)) {
        const a = await measure(small.tenantId, kind, filter, q);
        const b = await measure(large.tenantId, kind, filter, q);
        assert.ok(a.total > 0 && b.total > 0, `${kind}/${filter}/„${q}“: Liste leer (${a.total}/${b.total}) – Pfad nicht gemessen`);
        assert.equal(b.ops, a.ops, `${kind}/${filter}/„${q}“: 5 Buchungen ${a.ops} (${a.log.join(", ")}), 60 Buchungen ${b.ops} (${b.log.join(", ")})`);
        assert.ok(b.ops <= LIMIT[kind], `${kind}/${filter}/„${q}“: ${b.ops} Operationen (${b.log.join(", ")})`);
        if (filter === "heute") assert.ok(a.rows === 5 && b.rows === 30 && b.total === 60, `${kind}/heute/„${q}“: ${a.rows}/${b.rows}/${b.total}`);
      }
    }
  }
  // Obergrenze tatsächlich erreicht: 2 Raw (Kennzeichen, Telefon) + 5 (Kennzahlen, Liste) + 1 (Seite) + 3 Fahrerprüfung (Verträge,
  // Entwürfe, Prüfvermerke) + 1 „Fahrzeug unterwegs“ = 12
  const full = await measure(large.tenantId, "PICKUP", "heute", "0421 12345");
  assert.equal(full.log.filter((x) => x.startsWith("raw.")).length, 2, full.log.join(", "));
  assert.equal(full.ops, LIMIT.PICKUP, full.log.join(", "));
  const fullReturn = await measure(large.tenantId, "RETURN", "heute", "0421 12345");
  assert.equal(fullReturn.ops, LIMIT.RETURN, fullReturn.log.join(", "));
});

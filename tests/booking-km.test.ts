// Befehl 20.7 (1): Kilometervereinbarung auf der Buchung. Eine Quelle bis zur Rückgabe: Buchung → Vertrags-Snapshot
// (ensureContractDraft/refreshContractDraft) → Rückgabe rechnet mit dem Vertrag. Konditionen-Schritt schreibt zurück.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { ensureContractDraft, refreshContractDraft, saveConditions } from "../src/lib/contracts";
import { createWorld, purgeTenants } from "./helpers";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

test("Ohne Angabe auf der Buchung gilt das Fahrzeug (bisheriges Verhalten)", async () => {
  const w = await createWorld("km-default");
  tenants.push(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.deepEqual([c.kmIncludedPerDay, Number(c.extraKmRate)], [200, 0.25]);
});

test("Buchung führt die Vereinbarung: Vertrag übernimmt sie, Konditionen schreiben zurück, Fahrzeugwechsel überschreibt sie nicht", async () => {
  const w = await createWorld("km-booking");
  tenants.push(w.tenantId);
  await db.booking.update({ where: { id: w.bookingId }, data: { kmIncludedPerDay: 150, extraKmRate: 0.3 } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.deepEqual([c.kmIncludedPerDay, Number(c.extraKmRate)], [150, 0.3], "Vertragsentwurf aus der Buchung, nicht aus dem Fahrzeug");

  // Buchung vor Vertragsabschluss geändert → Entwurf folgt der Buchung
  await db.booking.update({ where: { id: w.bookingId }, data: { kmIncludedPerDay: 120 } });
  const r1 = await db.$transaction((tx) => refreshContractDraft(tx, w.tenantId, c.id));
  assert.deepEqual([r1.kmIncludedPerDay, Number(r1.extraKmRate)], [120, 0.3]);

  // Konditionen im Vertrag geändert → Buchung trägt dieselben Werte
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 180, extraKmRate: 0.35, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: null, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  const after1 = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const c1 = await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual([after1.kmIncludedPerDay, Number(after1.extraKmRate), c1.kmIncludedPerDay, Number(c1.extraKmRate)], [180, 0.35, 180, 0.35]);

  // Fahrzeugwechsel: Fahrzeugwerte (200/0,25) gelten nur, wenn die Buchung keine eigene Vereinbarung hat
  const other = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-KM 2", make: "VW", model: "Caddy", groupId: w.groupId, fuel: "DIESEL", mileage: 10_000, dailyRate: 59, kmIncludedPerDay: 300, extraKmRate: 0.2, deposit: 300 } });
  await db.booking.update({ where: { id: w.bookingId }, data: { vehicleId: other.id } });
  const r2 = await db.$transaction((tx) => refreshContractDraft(tx, w.tenantId, c.id));
  assert.deepEqual([r2.kmIncludedPerDay, Number(r2.extraKmRate)], [180, 0.35], "Vereinbarung der Buchung bleibt beim Fahrzeugwechsel");
  await db.booking.update({ where: { id: w.bookingId }, data: { kmIncludedPerDay: null, extraKmRate: null, vehicleId: w.vehicleId } });
  const r3 = await db.$transaction((tx) => refreshContractDraft(tx, w.tenantId, c.id));
  assert.deepEqual([r3.kmIncludedPerDay, Number(r3.extraKmRate)], [200, 0.25], "ohne eigene Vereinbarung: Werte des (neuen) Fahrzeugs");
});

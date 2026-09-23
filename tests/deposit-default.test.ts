// Kautionsvorgabe (Hotfix Phase 15): Mandantenstandard → Fahrzeuggruppe → Fahrzeug → Vertrag als echte Fallback-Kette für
// neue Buchungen und Vertragsentwürfe. Nie eine Kautionsbewegung; das Kautionssystem (SecurityDeposit) bleibt unberührt.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { depositSourceOf, resolveDeposit } from "../src/lib/business-rules";
import { adoptContractDefaults, ensureContractDraft, getContractState, saveConditions } from "../src/lib/contracts";
import { createWorld, purgeTenants, type World } from "./helpers";

const tenants: string[] = [];
async function world(label: string): Promise<World> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  return w;
}
after(async () => { await purgeTenants(tenants); await db.$disconnect(); });

test("Kette rein: Fahrzeug vor Gruppe vor Mandant vor 0; 0 an Fahrzeug/Gruppe heißt „nicht gesetzt“; Herkunft", () => {
  assert.deepEqual(resolveDeposit(null, null, null), { cents: 0, source: "DEFAULT" });
  assert.deepEqual(resolveDeposit({ depositCents: 75000 }, { deposit: 0 }, { deposit: 0 }), { cents: 75000, source: "TENANT" });
  assert.deepEqual(resolveDeposit({ depositCents: 75000 }, { deposit: "600" }, { deposit: 0 }), { cents: 60000, source: "GROUP" });
  assert.deepEqual(resolveDeposit({ depositCents: 75000 }, { deposit: 600 }, { deposit: 500 }), { cents: 50000, source: "VEHICLE" });
  assert.deepEqual(resolveDeposit({ depositCents: -1 }, null, null), { cents: 0, source: "DEFAULT" }, "ungültige Regel wird ignoriert");
  assert.equal(depositSourceOf(75000, { cents: 75000, source: "TENANT" }), "TENANT");
  assert.equal(depositSourceOf(30000, { cents: 75000, source: "TENANT" }), "CONTRACT");
});

test("Vertragsentwurf: ohne Kaution an Buchung, Fahrzeug und Gruppe greift der Mandantenstandard; Gruppe und Fahrzeug gehen vor; Buchungswert bleibt; keine Kautionsbewegung", async () => {
  const w = await world("deposit-fallback");
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { depositCents: 75000 } } });
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { deposit: 0 } });
  await db.vehicleGroup.update({ where: { id: w.groupId }, data: { deposit: 0 } });
  await db.booking.update({ where: { id: w.bookingId }, data: { deposit: 0 } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(Number(c.deposit), 750, "Mandantenstandard als Vorgabe");
  const s = await getContractState(w.tenantId, c.id);
  assert.equal(s.rules.depositSource, "TENANT");
  assert.equal(s.rules.snapshot?.depositResolvedCents, 75000);
  assert.equal(s.rules.newerDefaults, false);
  assert.equal(await db.securityDeposit.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }), 0);
  // Mandantenstandard ändert sich: Hinweis, keine stille Änderung, Übernahme setzt Kaution und Buchung
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { depositCents: 90000 } } });
  const s2 = await getContractState(w.tenantId, c.id);
  assert.equal(Number(s2.contract.deposit), 750);
  assert.equal(s2.rules.newerDefaults, true);
  await adoptContractDefaults(w.tenantId, c.id, w.actor);
  const s3 = await getContractState(w.tenantId, c.id);
  assert.equal(Number(s3.contract.deposit), 900);
  assert.equal(Number((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).deposit), 900);
  assert.equal(s3.rules.newerDefaults, false);
  // individuell angepasst: Übernahme neuer Standards lässt die Kaution stehen
  await saveConditions(w.tenantId, c.id, { startAt: c.startAt, endAt: c.endAt, deposit: 300, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 0, fuelPolicy: "FULL_TO_FULL" }, w.actor);
  assert.equal((await getContractState(w.tenantId, c.id)).rules.depositSource, "CONTRACT");
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { depositCents: 95000 } } });
  await adoptContractDefaults(w.tenantId, c.id, w.actor);
  assert.equal(Number((await getContractState(w.tenantId, c.id)).contract.deposit), 300);
  // Gruppe geht vor Mandant, Fahrzeug vor Gruppe (neue Buchungen)
  await db.vehicleGroup.update({ where: { id: w.groupId }, data: { deposit: 600 } });
  const b2 = await db.booking.create({ data: { tenantId: w.tenantId, number: "DEP-2", vehicleId: w.vehicleId, customerId: w.customerId, startAt: new Date(Date.now() + 20 * 86_400_000), endAt: new Date(Date.now() + 22 * 86_400_000), dailyRate: 89, deposit: 0 } });
  const c2 = await ensureContractDraft(w.tenantId, b2.id, w.actor);
  assert.equal(Number(c2.deposit), 600);
  assert.equal((await getContractState(w.tenantId, c2.id)).rules.depositSource, "GROUP");
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { deposit: 500 } });
  const b3 = await db.booking.create({ data: { tenantId: w.tenantId, number: "DEP-3", vehicleId: w.vehicleId, customerId: w.customerId, startAt: new Date(Date.now() + 30 * 86_400_000), endAt: new Date(Date.now() + 32 * 86_400_000), dailyRate: 89, deposit: 0 } });
  const c3 = await ensureContractDraft(w.tenantId, b3.id, w.actor);
  assert.equal(Number(c3.deposit), 500);
  assert.equal((await getContractState(w.tenantId, c3.id)).rules.depositSource, "VEHICLE");
  // eine bewusst in der Buchung gesetzte Kaution gilt
  const b4 = await db.booking.create({ data: { tenantId: w.tenantId, number: "DEP-4", vehicleId: w.vehicleId, customerId: w.customerId, startAt: new Date(Date.now() + 40 * 86_400_000), endAt: new Date(Date.now() + 42 * 86_400_000), dailyRate: 89, deposit: 250 } });
  const c4 = await ensureContractDraft(w.tenantId, b4.id, w.actor);
  assert.equal(Number(c4.deposit), 250);
  assert.equal((await getContractState(w.tenantId, c4.id)).rules.depositSource, "CONTRACT");
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }), 0, "keine Kautionsbewegung");
});

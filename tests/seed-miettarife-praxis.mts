// Befehl 29: lokale Praxisprüfung der Miettarife (Praxis A–F) – Testmandant mit Inhaber-Sitzung, Kompaktklasse und den
// Tarifen BASIC / PLUS / UNLIMITED, einer Altbuchung ohne Tarif (mit Vertrag und Rückgabe) sowie zwei laufenden Tarifmieten
// (PLUS für Tarifänderung und Verlängerung, UNLIMITED für die Rückgabe). Nur lokale Entwicklungsdatenbank.
// Aufruf: npx tsx tests/seed-miettarife-praxis.mts   ·   Aufräumen: npx tsx tests/purge-test-tenants.mts
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { recordAudit } from "../src/lib/audit";
import { createRatePlan, setGroupDefaultRatePlan, type TariffContent } from "../src/lib/tariff-admin";
import { bookingTariffFor, readTariffSnapshot, type TariffChoices } from "../src/lib/tariffs";
import { createWorld, type World } from "./helpers";
import { pickedUpWorld, returnedWorld } from "./rental-flow";

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Nur gegen eine lokale Datenbank.");
const DAY = 86_400_000;
const w = await createWorld("praxis-tarife");
await db.tenant.update({ where: { id: w.tenantId }, data: { name: "Praxis Miettarife", defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
await db.vehicleGroup.update({ where: { id: w.groupId }, data: { name: "Kompaktklasse", bodyType: "PKW", requiredLicenseClass: "B" } });
await db.vehicle.update({ where: { id: w.vehicleId }, data: { make: "VW", model: "Golf", fuel: "BENZIN", mileage: 45_000 } });
await db.customer.update({ where: { id: w.customerId }, data: { discountPercent: 0 } });
const owner = await db.user.create({ data: { tenantId: w.tenantId, email: `praxis-owner-${Date.now().toString(36)}@example.test`, name: "Inhaberin Praxis", passwordHash: "x", role: "OWNER" } });
const actor = { id: owner.id, name: owner.name };
const sid = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: sid, userId: owner.id, expiresAt: new Date(Date.now() + 12 * 3600_000) } });

const tiers = (...c: [number, number, number, number]) => [{ days: 1, cents: c[0] }, { days: 5, cents: c[1] }, { days: 7, cents: c[2] }, { days: 30, cents: c[3] }];
const content = (t: ReturnType<typeof tiers>, km: TariffContent["km"], depositCents: number): TariffContent => ({ km, depositCents, groups: [{ groupId: w.groupId, tiers: t, depositCents: null, km: null }] });
const plan = async (name: string, c: TariffContent) => (await createRatePlan(w.tenantId, actor, { meta: { name, code: null, description: null, sortOrder: 0 }, content: c, active: true, createKey: randomUUID() })).id;
await plan("BASIC", content(tiers(4900, 21900, 27900, 89900), { policy: "FREE_KILOMETERS", kmIncludedPerDay: 100, extraKmRateCents: 35 }, 50000));
const plus = await plan("PLUS", content(tiers(5900, 25900, 32900, 99900), { policy: "FREE_KILOMETERS", kmIncludedPerDay: 250, extraKmRateCents: 25 }, 50000));
const unlimited = await plan("UNLIMITED", content(tiers(6900, 31900, 44900, 129900), { policy: "UNLIMITED", kmIncludedPerDay: null, extraKmRateCents: null }, 75000));
await setGroupDefaultRatePlan(w.tenantId, actor, w.groupId, plus);

const TARIFF: TariffChoices = { price: { mode: "TARIFF" }, km: { mode: "TARIFF" }, deposit: { mode: "TARIFF" } };
async function onTariff(x: World, ratePlanId: string, days: number) {
  const b = await db.booking.findUniqueOrThrow({ where: { id: x.bookingId } });
  const endAt = new Date(b.startAt.getTime() + days * DAY);
  await db.$transaction(async (tx) => {
    const r = await bookingTariffFor(tx, x.tenantId, actor, { vehicleId: b.vehicleId, ratePlanId, startAt: b.startAt, endAt, discountPercent: 0, choices: TARIFF, previous: readTariffSnapshot(b.tariffSnapshot) });
    await tx.booking.update({ where: { id: x.bookingId }, data: { ...r.data, endAt } });
    for (const a of r.audits) await recordAudit(tx, x.tenantId, actor, { ...a, bookingId: x.bookingId });
  });
}
// Praxis F: Altbuchung ohne Tarif mit Vertrag, Übergabe und Rückgabe
const legacy = await returnedWorld("praxis-alt", { within: w });
// Praxis D/E: laufende Miete auf PLUS Revision 1 (7 Tage)
const running = await pickedUpWorld("praxis-plus", { within: w, beforeContract: (x) => onTariff(x, plus, 7) });
// Praxis C: laufende Miete auf UNLIMITED (7 Tage)
const unl = await pickedUpWorld("praxis-unl", { within: w, beforeContract: (x) => onTariff(x, unlimited, 7) });

const num = async (id: string) => (await db.booking.findUniqueOrThrow({ where: { id } })).number;
console.log(`SITZUNG=${sid}`);
console.log(`MANDANT=${w.tenantId}`);
console.log(`ALT=${legacy.bookingId} (${await num(legacy.bookingId)})`);
console.log(`PLUS=${running.bookingId} (${await num(running.bookingId)}) VERTRAG=${running.contractId}`);
console.log(`UNLIMITED=${unl.bookingId} (${await num(unl.bookingId)})`);
console.log(`TARIF_PLUS=${plus}`);
await db.$disconnect();

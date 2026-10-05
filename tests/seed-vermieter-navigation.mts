// Lokale Sichtprüfung der Vermieter-Navigation (Vorschlag 4): Testmandant mit Inhaber (bekanntes Passwort), heutiger
// Abholung, überfälliger Rückgabe und drei Schadenakten in verschiedenen Stadien. Nur lokale Entwicklungsdatenbank.
// Aufruf: npx tsx tests/seed-vermieter-navigation.mts   ·   Aufräumen: npx tsx tests/purge-test-tenants.mts
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { openDamageCase, setLiability, setCaseCosts, changeCaseStatus } from "../src/lib/damage-cases";
import { reportDamage } from "../src/lib/damages";
import { createWorld } from "./helpers";

const w = await createWorld("ui-nav", { startInDays: 0 });
await db.tenant.update({ where: { id: w.tenantId }, data: { name: "Test JetRent Sicht", city: "Bremen" } });
const stamp = Date.now().toString(36);
const owner = await db.user.create({ data: { tenantId: w.tenantId, email: `ui-owner-${stamp}@example.test`, name: "Inhaber Sicht", passwordHash: await hashPassword("vermieter-test-1"), role: "OWNER" } });
const actor = { id: owner.id, name: owner.name };
const now = Date.now();
await db.booking.update({ where: { id: w.bookingId }, data: { startAt: new Date(now + 2 * 3600_000), endAt: new Date(now + 5 * 86_400_000) } });
await db.booking.create({ data: { tenantId: w.tenantId, number: `UI-${stamp}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: new Date(now - 6 * 86_400_000), endAt: new Date(now - 2 * 3600_000), status: "ACTIVE", dailyRate: 89, deposit: 0 } });

const d1 = await reportDamage(w.tenantId, actor, { vehicleId: w.vehicleId, view: "FRONT", posX: 0.3, posY: 0.4, kind: "SCRATCH", description: "Kratzer Stoßstange vorne" });
const d2 = await reportDamage(w.tenantId, actor, { vehicleId: w.vehicleId, view: "REAR", posX: 0.5, posY: 0.5, kind: "DENT", description: "Delle Heckklappe" });
const d3 = await reportDamage(w.tenantId, actor, { vehicleId: w.vehicleId, view: "LEFT", posX: 0.6, posY: 0.5, kind: "CRACK", description: "Riss Außenspiegel" });
const { damageCase: c1 } = await openDamageCase(w.tenantId, d1.id, actor);
const { damageCase: c2 } = await openDamageCase(w.tenantId, d2.id, actor);
const { damageCase: c3 } = await openDamageCase(w.tenantId, d3.id, actor);
await db.damageCase.update({ where: { id: c1.id }, data: { reportedAt: new Date(now - 11 * 86_400_000) } });
await setLiability(w.tenantId, c2.id, actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "Mieter hat Schaden bestätigt");
await setLiability(w.tenantId, c3.id, actor, "INTERNAL", "Hofschaden");
await setCaseCosts(w.tenantId, c3.id, actor, { estimated: "180" });
await changeCaseStatus(w.tenantId, c3.id, actor, "REPAIR_PLANNED");

console.log(`Login: ${owner.email} / vermieter-test-1`);
await db.$disconnect();

// Rauchtest der bestehenden Seiten gegen den laufenden Dev-Server (npm run dev) und die lokale Datenbank.
// Legt einen Testmandanten mit Sitzung an, ruft jede Seite auf und räumt danach auf.
// Aufruf: npx tsx tests/smoke-pages.mts [http://localhost:3000]
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";

const base = process.argv[2] ?? "http://localhost:3000";
const run = `s${Date.now()}`;

const tenant = await db.tenant.create({ data: { name: `Rauchtest ${run}`, slug: `smoke-${run}`, city: "Bremen" } });
const user = await db.user.create({ data: { tenantId: tenant.id, email: `smoke-${run}@example.test`, name: "Rauch Test", passwordHash: "x", role: "OWNER" } });
const sessionId = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: sessionId, userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } });
const group = await db.vehicleGroup.create({ data: { tenantId: tenant.id, name: "Transporter", bodyType: "TRANSPORTER", dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: 1790, deposit: 500 } });
const vehicle = await db.vehicle.create({ data: { tenantId: tenant.id, plate: "HB-RT 100", make: "VW", model: "Crafter", groupId: group.id, dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: 1790, deposit: 500, mileage: 1000 } });
const customer = await db.customer.create({ data: { tenantId: tenant.id, firstName: "Erika", lastName: "Muster", city: "Bremen", discountPercent: 10 } });
const start = new Date(Date.now() + 24 * 3600_000);
const end = new Date(start.getTime() + 10 * 24 * 3600_000);
// Buchung ohne Stufen (wie alle Buchungen vor dieser Phase) und eine mit Stufen
const oldStyle = await db.booking.create({ data: { tenantId: tenant.id, number: `${run}-1`, vehicleId: vehicle.id, customerId: customer.id, startAt: new Date(start.getTime() - 40 * 24 * 3600_000), endAt: new Date(start.getTime() - 30 * 24 * 3600_000), dailyRate: 89, deposit: 500, status: "RETURNED" } });
const booking = await db.booking.create({ data: { tenantId: tenant.id, number: `${run}-2`, vehicleId: vehicle.id, customerId: customer.id, startAt: start, endAt: end, dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: 1790, deposit: 500 } });

const pages: [string, string][] = [
  ["/heute", "Abholungen heute"],
  ["/dispo", "Dispo-Kalender"],
  ["/fahrzeuge", "HB-RT 100"],
  ["/fahrzeuge/gruppen", "Kalenderwoche"],
  ["/fahrzeuge/neu", "Fahrzeuggruppe"],
  [`/fahrzeuge/${vehicle.id}`, "Crafter"],
  ["/kunden", "Muster"],
  ["/kunden/neu", "Ausweisnummer"],
  [`/kunden/${customer.id}`, "Führerschein"],
  ["/buchungen", `${run}-2`],
  ["/buchungen?filter=alle", `${run}-1`],
  ["/buchungen/neu", "Neuer Kunde"],
  // 10 Tage mit Stufen: Kalenderwoche + 3 Tage = 807 €, 10 % Rabatt = 726,30 €
  [`/buchungen/${booking.id}`, "726,30"],
  // alte Buchung ohne Stufen: 10 × 89 € = 890 €, 10 % Rabatt = 801,00 €
  [`/buchungen/${oldStyle.id}`, "Muster"],
  ["/einstellungen", "Mitarbeiter"],
];

let failed = 0;
for (const [path, expect] of pages) {
  const res = await fetch(base + path, { headers: { cookie: `rb_session=${sessionId}` }, redirect: "manual" });
  const body = res.status === 200 ? await res.text() : "";
  const ok = res.status === 200 && body.includes(expect);
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FEHL"} ${res.status} ${path}${ok ? "" : `  (erwartet: "${expect}")`}`);
}
const anon = await fetch(base + "/heute", { redirect: "manual" });
const anonOk = anon.status === 307 && (anon.headers.get("location") ?? "").includes("/login");
if (!anonOk) failed++;
console.log(`${anonOk ? "OK  " : "FEHL"} ${anon.status} /heute ohne Sitzung leitet zum Login`);

// Aufräumen
await db.booking.deleteMany({ where: { tenantId: tenant.id } });
await db.customer.deleteMany({ where: { tenantId: tenant.id } });
await db.vehicle.deleteMany({ where: { tenantId: tenant.id } });
await db.vehicleGroup.deleteMany({ where: { tenantId: tenant.id } });
await db.session.deleteMany({ where: { userId: user.id } });
await db.user.deleteMany({ where: { tenantId: tenant.id } });
await db.tenant.delete({ where: { id: tenant.id } });
await db.$disconnect();

console.log(failed === 0 ? "\nAlle Seiten in Ordnung." : `\n${failed} Seite(n) fehlerhaft.`);
process.exit(failed === 0 ? 0 : 1);

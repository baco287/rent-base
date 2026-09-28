// Lokale Sichtprüfung des Control Centers: legt Testmandanten mit Fahrzeugen/Buchungen (createWorld), einen SUPER_ADMIN
// mit bekanntem Passwort sowie je einen Mandanten mit Tarif und mit gesperrtem Feature an. Nur für die lokale
// Entwicklungsdatenbank – nie gegen Produktion. Aufruf: npx tsx tests/seed-control-center.mts
// Aufräumen: npx tsx tests/purge-test-tenants.mts (Testmandanten heißen "Test …")
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { setTenantFeature } from "../src/lib/features";
import { upsertSubscription } from "../src/lib/subscriptions";
import { suspendTenant } from "../src/lib/platform-tenants";
import { createWorld } from "./helpers";

const stamp = Date.now().toString(36);
const w1 = await createWorld("cc-jetrent");
const w2 = await createWorld("cc-volt");
const w3 = await createWorld("cc-alt");
await db.tenant.update({ where: { id: w1.tenantId }, data: { name: "Test Muster Autovermietung GmbH", city: "Bremen", email: "info@muster-vermietung.test", legalForm: "GmbH" } });
await db.tenant.update({ where: { id: w2.tenantId }, data: { name: "Test Volt Mobil UG", city: "Hamburg", status: "PENDING_SETUP" } });
await db.tenant.update({ where: { id: w3.tenantId }, data: { name: "Test Altkunde Transporter", city: "Oldenburg" } });

const admin = await db.user.create({ data: { tenantId: w1.tenantId, email: `cc-admin-${stamp}@example.test`, name: "Control Admin", passwordHash: await hashPassword("controlcenter-test-1"), role: "OWNER" } });
await db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
  await tx.user.update({ where: { id: admin.id }, data: { platformRole: "SUPER_ADMIN" } });
});
const support = await db.user.create({ data: { tenantId: w1.tenantId, email: `cc-support-${stamp}@example.test`, name: "Support Kollegin", passwordHash: await hashPassword("controlcenter-test-1"), role: "DISPO" } });
await db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
  await tx.user.update({ where: { id: support.id }, data: { platformRole: "SUPPORT_ADMIN" } });
});
await db.user.update({ where: { id: w1.userId }, data: { lastLoginAt: new Date(Date.now() - 2 * 24 * 3600_000) } });
await db.user.update({ where: { id: w2.userId }, data: { lastLoginAt: new Date(Date.now() - 40 * 24 * 3600_000) } });

const actor = { id: admin.id, name: admin.name };
await upsertSubscription(actor, w1.tenantId, { plan: "BUSINESS", status: "ACTIVE", monthlyPriceCents: 14900, maxVehicles: 25 });
await upsertSubscription(actor, w2.tenantId, { plan: "TRIAL", status: "TRIAL", trialEndsAt: new Date(Date.now() + 5 * 24 * 3600_000), maxUsers: 3, maxVehicles: 5 });
await setTenantFeature(actor, w2.tenantId, "AUTHORITIES", false, "Testphase ohne Behördenmodul");
await setTenantFeature(actor, w2.tenantId, "PAYOUTS", false);
await suspendTenant(actor, w3.tenantId, "Zahlungsrückstand seit zwei Monaten (Testdaten)");
await db.emailLog.create({ data: { tenantId: w1.tenantId, recipient: "kunde@example.test", subject: "Rechnung RE-2026-0001", template: "INVOICE", status: "FAILED", error: "Versand fehlgeschlagen", errorCode: "AUTH_FAILED", channel: "TENANT_SMTP", category: "TENANT_BUSINESS", attempts: 1, idempotencyKey: `seed-${stamp}` } });

console.log(`Login: ${admin.email} / controlcenter-test-1 (SUPER_ADMIN)`);
console.log(`Login: ${support.email} / controlcenter-test-1 (SUPPORT_ADMIN)`);
console.log(`Mandanten: ${w1.tenantId} (Business), ${w2.tenantId} (Trial, Features gesperrt), ${w3.tenantId} (gesperrt)`);
await db.$disconnect();

// RentBase Control Center: interne Rollen und Berechtigungsmatrix, Feature-Freischaltungen je Mandant, interne
// Tarif-/Abo-Verwaltung mit Limits, mandantenübergreifende Benutzerverwaltung, zentrales Audit. Deckt die
// sicherheitskritischen Pfade ab: Matrix statt UI-Rechten, Schutzregeln der Rollenvergabe (eigenes Konto, letzter
// SUPER_ADMIN, DB-Regel), Standardverhalten ohne Feature-Zeile, Audit mit vorher/nachher, Mandanten-Isolation.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { DomainError } from "../src/lib/integrity";
import { FEATURE_KEYS, INTERNAL_PLATFORM_ROLES, PLATFORM_PERMISSIONS, isInternalRole, platformAllows, type PlatformPermission } from "../src/lib/constants";
import { assertFeature, defaultFeatureState, featureMatrix, hiddenNavPaths, isFeatureEnabled, setTenantFeature, tenantFeatures } from "../src/lib/features";
import { assertUserLimit, assertVehicleLimit, billingOverview, getSubscription, upsertSubscription } from "../src/lib/subscriptions";
import { listInternalAdmins, listUsersForPlatform, platformActivateUser, platformDeactivateUser, setPlatformRole, userDetailForPlatform } from "../src/lib/platform-users";
import { auditDetailsView, listPlatformAudit, recentPlatformAudit } from "../src/lib/platform-audit";
import { listTenantsForPlatform, platformDashboardStats, tenantDetailForPlatform } from "../src/lib/platform-tenants";
import { createInvitation } from "../src/lib/invitations";
import { startSupportSession } from "../src/lib/support-sessions";
import { setMailTransport, type MailMessage, type MailTransport } from "../src/lib/mail";
import { purgeTenants } from "./helpers";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

class FakeTransport implements MailTransport {
  readonly name = "fake";
  sent: MailMessage[] = [];
  async send(m: MailMessage) { this.sent.push(m); return { messageId: `<fake-${this.sent.length}@test>` }; }
}
setMailTransport(new FakeTransport());

async function readyTenant(label: string) {
  const run = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const tenant = await db.tenant.create({ data: { name: `CC ${run}`, slug: `cc-${run}`, status: "ACTIVE" } });
  tenants.push(tenant.id);
  const owner = await db.user.create({ data: { tenantId: tenant.id, email: `owner-${run}@example.test`, name: `Inhaber ${run}`, passwordHash: await hashPassword("ownerpasswort1"), role: "OWNER" } });
  return { tenant, owner, run };
}
async function grant(userId: string, role: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
    await tx.user.update({ where: { id: userId }, data: { platformRole: role } });
  });
}
const actorOf = (u: { id: string; name: string }) => ({ id: u.id, name: u.name });
const rejectsDomain = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof DomainError && re.test(e.message));

test("Berechtigungsmatrix: NONE nie, READ_ONLY nur ansehen, SUPPORT ohne Systemeingriffe, BILLING nur Abo, SUPER_ADMIN alles", () => {
  const perms = Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[];
  for (const p of perms) {
    assert.equal(platformAllows("NONE", p), false, `NONE: ${p}`);
    assert.equal(platformAllows("OWNER", p), false, `Mandantenrolle OWNER zählt nicht: ${p}`);
    assert.equal(platformAllows("", p), false);
    assert.equal(platformAllows("SUPER_ADMIN", p), true, `SUPER_ADMIN: ${p}`);
  }
  const mutating: PlatformPermission[] = ["TENANT_CREATE", "TENANT_SUSPEND", "SUPPORT_SESSION", "USER_MANAGE", "BILLING_MANAGE", "FEATURE_MANAGE", "PLATFORM_ROLE_MANAGE"];
  for (const p of mutating) assert.equal(platformAllows("READ_ONLY_ADMIN", p), false, `READ_ONLY_ADMIN darf nicht: ${p}`);
  for (const p of perms.filter((x) => !mutating.includes(x))) assert.equal(platformAllows("READ_ONLY_ADMIN", p), true, `READ_ONLY_ADMIN sieht: ${p}`);
  assert.equal(platformAllows("SUPPORT_ADMIN", "SUPPORT_SESSION"), true);
  assert.equal(platformAllows("SUPPORT_ADMIN", "USER_MANAGE"), true);
  for (const p of ["TENANT_SUSPEND", "TENANT_CREATE", "FEATURE_MANAGE", "BILLING_MANAGE", "PLATFORM_ROLE_MANAGE"] as PlatformPermission[]) assert.equal(platformAllows("SUPPORT_ADMIN", p), false, `SUPPORT_ADMIN darf nicht: ${p}`);
  assert.equal(platformAllows("BILLING_ADMIN", "BILLING_MANAGE"), true);
  for (const p of ["SUPPORT_SESSION", "USER_MANAGE", "USERS_VIEW", "FEATURE_MANAGE", "TENANT_SUSPEND", "SYSTEM_VIEW"] as PlatformPermission[]) assert.equal(platformAllows("BILLING_ADMIN", p), false, `BILLING_ADMIN darf nicht: ${p}`);
  assert.deepEqual([...INTERNAL_PLATFORM_ROLES].sort(), ["BILLING_ADMIN", "READ_ONLY_ADMIN", "SUPER_ADMIN", "SUPPORT_ADMIN"]);
  assert.equal(isInternalRole("NONE"), false);
  assert.equal(isInternalRole("SUPPORT_ADMIN"), true);
});

test("Interne Rollen: Vergabe nur mit Freigabe in der Transaktion, nie das eigene Konto, letzter SUPER_ADMIN bleibt, Audit mit vorher/nachher", async () => {
  const { tenant, owner: admin, run } = await readyTenant("rollen");
  await grant(admin.id, "SUPER_ADMIN");
  const colleague = await db.user.create({ data: { tenantId: tenant.id, email: `kollege-${run}@example.test`, name: "Kollege", passwordHash: "x", role: "DISPO" } });

  // DB-Regel: ohne SET LOCAL keine Änderung, unbekannter Wert wird abgelehnt
  await assert.rejects(db.user.update({ where: { id: colleague.id }, data: { platformRole: "SUPPORT_ADMIN" } }), /RB_IMMUTABLE/);
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
    await tx.user.update({ where: { id: colleague.id }, data: { platformRole: "GOD_MODE" } });
  }));

  const { changed } = await setPlatformRole(actorOf(admin), colleague.id, "SUPPORT_ADMIN");
  assert.equal(changed, true);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: colleague.id } })).platformRole, "SUPPORT_ADMIN");
  const audit = await db.auditLog.findFirst({ where: { tenantId: tenant.id, action: "PLATFORM_ROLE_CHANGED" }, orderBy: { createdAt: "desc" } });
  assert.ok(audit);
  const d = audit.details as { before: { platformRole: string }; after: { platformRole: string }; email: string };
  assert.equal(d.before.platformRole, "NONE");
  assert.equal(d.after.platformRole, "SUPPORT_ADMIN");
  assert.equal(audit.userId, admin.id);
  assert.ok(!JSON.stringify(audit.details).includes("passwordHash"));
  assert.equal((await setPlatformRole(actorOf(admin), colleague.id, "SUPPORT_ADMIN")).changed, false, "unverändert: kein zweiter Eintrag");

  await rejectsDomain(setPlatformRole(actorOf(admin), admin.id, "NONE"), /eigene Plattformrolle/);
  // Kollege ist SUPPORT_ADMIN und kann den letzten SUPER_ADMIN nicht herabstufen (Matrix wird in requirePlatform geprüft;
  // die Bibliothek schützt zusätzlich den letzten aktiven SUPER_ADMIN)
  const otherSupers = await db.user.count({ where: { platformRole: "SUPER_ADMIN", active: true, id: { not: admin.id } } });
  if (otherSupers === 0) await rejectsDomain(setPlatformRole(actorOf(colleague), admin.id, "NONE"), /letzte aktive SUPER_ADMIN/);

  // laufende Supportsession endet, wenn die Rolle das Recht verliert
  const support = await startSupportSession(actorOf(colleague), tenant.id, "Rollen-Test Supportzugriff");
  await setPlatformRole(actorOf(admin), colleague.id, "READ_ONLY_ADMIN");
  assert.ok((await db.supportSession.findUniqueOrThrow({ where: { id: support.id } })).endedAt, "Supportsession beendet");

  // deaktiviertes Konto bekommt keine Rolle; Entzug (NONE) geht immer
  await setPlatformRole(actorOf(admin), colleague.id, "NONE");
  await db.user.update({ where: { id: colleague.id }, data: { active: false } });
  await rejectsDomain(setPlatformRole(actorOf(admin), colleague.id, "BILLING_ADMIN"), /deaktivierten Konto/);
  await db.user.update({ where: { id: colleague.id }, data: { active: true } });

  const internal = await listInternalAdmins();
  assert.ok(internal.some((u) => u.id === admin.id));
  assert.ok(!internal.some((u) => u.id === colleague.id));
});

test("Feature-Flags: ohne Zeile Standard (alles an), Sperren/Freischalten protokolliert vorher/nachher, Mandanten getrennt", async () => {
  const { tenant, owner: admin } = await readyTenant("features");
  const { tenant: other } = await readyTenant("features-other");
  await grant(admin.id, "SUPER_ADMIN");

  assert.deepEqual(await tenantFeatures(tenant.id), defaultFeatureState());
  for (const k of FEATURE_KEYS) assert.equal(await isFeatureEnabled(tenant.id, k), true, `${k} Standard an`);
  assert.deepEqual(hiddenNavPaths(defaultFeatureState()), []);

  assert.equal((await setTenantFeature(actorOf(admin), tenant.id, "AUTHORITIES", false, "Testsperre")).changed, true);
  assert.equal(await isFeatureEnabled(tenant.id, "AUTHORITIES"), false);
  assert.equal(await isFeatureEnabled(other.id, "AUTHORITIES"), true, "anderer Mandant unberührt");
  await rejectsDomain(assertFeature(tenant.id, "AUTHORITIES"), /nicht freigeschaltet/);
  await assertFeature(tenant.id, "DAMAGE_CASES");
  assert.deepEqual(hiddenNavPaths(await tenantFeatures(tenant.id)), ["/behoerden"]);

  const audit = await db.auditLog.findMany({ where: { tenantId: tenant.id, action: { in: ["FEATURE_ENABLED", "FEATURE_DISABLED"] } }, orderBy: { createdAt: "asc" } });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "FEATURE_DISABLED");
  const d = audit[0].details as { feature: string; note: string; before: { enabled: boolean }; after: { enabled: boolean } };
  assert.equal(d.feature, "AUTHORITIES");
  assert.equal(d.note, "Testsperre");
  assert.equal(d.before.enabled, true);
  assert.equal(d.after.enabled, false);

  assert.equal((await setTenantFeature(actorOf(admin), tenant.id, "AUTHORITIES", false)).changed, false, "unverändert: kein Audit");
  assert.equal(await db.auditLog.count({ where: { tenantId: tenant.id, action: "FEATURE_DISABLED" } }), 1);
  assert.equal((await setTenantFeature(actorOf(admin), tenant.id, "AUTHORITIES", true)).changed, true);
  assert.equal(await isFeatureEnabled(tenant.id, "AUTHORITIES"), true);
  assert.equal(await db.auditLog.count({ where: { tenantId: tenant.id, action: "FEATURE_ENABLED" } }), 1);

  await setTenantFeature(actorOf(admin), tenant.id, "KEY_DROP", false);
  const matrix = await featureMatrix({ query: tenant.slug });
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].state.KEY_DROP, false);
  assert.equal(matrix.rows[0].state.AUTHORITIES, true);
  assert.ok(matrix.rows[0].overrides.KEY_DROP);
  assert.equal(matrix.counts.KEY_DROP.disabled, 1);

  await rejectsDomain(setTenantFeature(actorOf(admin), "gibt-es-nicht", "KEY_DROP", false), /nicht gefunden/);
  // DB: ein Mandant kann je Feature nur eine Zeile haben
  await assert.rejects(db.tenantFeatureFlag.create({ data: { tenantId: tenant.id, key: "KEY_DROP", enabled: true } }));
});

test("Tarif/Abo: Anlage und Änderung protokolliert nur geänderte Felder, Validierung, DB-Regeln, Limits für Benutzer und Fahrzeuge, MRR nur aus erfassten Preisen", async () => {
  const { tenant, owner: admin, run } = await readyTenant("abo");
  await grant(admin.id, "SUPER_ADMIN");
  assert.equal(await getSubscription(tenant.id), null);

  await rejectsDomain(upsertSubscription(actorOf(admin), tenant.id, { plan: "TRIAL", status: "TRIAL" }), /Enddatum/);
  await rejectsDomain(upsertSubscription(actorOf(admin), tenant.id, { plan: "STARTER", status: "CANCELLED" }), /Kündigungsdatum/);
  await rejectsDomain(upsertSubscription(actorOf(admin), tenant.id, { plan: "STARTER", status: "ACTIVE", maxUsers: 0 }), /Benutzerlimit/);

  const trialEnd = new Date(Date.now() + 14 * 24 * 3600_000);
  const created = await upsertSubscription(actorOf(admin), tenant.id, { plan: "TRIAL", status: "TRIAL", trialEndsAt: trialEnd, maxUsers: 1, maxVehicles: 1 });
  assert.equal(created.plan, "TRIAL");
  assert.equal(created.monthlyPriceCents, null);
  const createdAudit = await db.auditLog.findFirst({ where: { tenantId: tenant.id, action: "SUBSCRIPTION_CREATED" } });
  assert.ok(createdAudit);

  // Benutzerlimit 1: Inhaber ist aktiv → keine weitere Einladung; Fahrzeuglimit 1
  await rejectsDomain(assertUserLimit(tenant.id), /Benutzerlimit/);
  await rejectsDomain(createInvitation(tenant.id, actorOf(admin), { email: `neu-${run}@example.test`, role: "DISPO", baseUrl: "https://rent-base.de" }), /Benutzerlimit/);
  assert.equal(await db.invitation.count({ where: { tenantId: tenant.id } }), 0, "keine Einladung trotz Fehler");
  await assertVehicleLimit(tenant.id);
  const group = await db.vehicleGroup.create({ data: { tenantId: tenant.id, name: "PKW", bodyType: "PKW", dailyRate: 49 } });
  await db.vehicle.create({ data: { tenantId: tenant.id, plate: `HB-CC ${run.slice(-4)}`, make: "VW", model: "Polo", groupId: group.id, fuel: "PETROL", mileage: 1000, dailyRate: 49 } });
  await rejectsDomain(assertVehicleLimit(tenant.id), /Fahrzeuglimit/);

  // Wechsel auf bezahlten Tarif: Audit enthält nur die geänderten Felder mit vorher/nachher
  const updated = await upsertSubscription(actorOf(admin), tenant.id, { plan: "BUSINESS", status: "ACTIVE", monthlyPriceCents: 14900, maxUsers: null, maxVehicles: 25 });
  assert.equal(updated.trialEndsAt, null);
  const updatedAudit = await db.auditLog.findFirst({ where: { tenantId: tenant.id, action: "SUBSCRIPTION_UPDATED" }, orderBy: { createdAt: "desc" } });
  assert.ok(updatedAudit);
  const d = updatedAudit.details as { before: Record<string, unknown>; after: Record<string, unknown> };
  assert.deepEqual(Object.keys(d.after).sort(), ["maxUsers", "maxVehicles", "monthlyPriceCents", "plan", "status", "trialEndsAt"]);
  assert.equal(d.before.plan, "TRIAL");
  assert.equal(d.after.plan, "BUSINESS");
  assert.equal(d.before.maxUsers, 1);
  assert.equal(d.after.maxUsers, null);
  assert.equal(d.after.monthlyPriceCents, 14900);
  await assertUserLimit(tenant.id);
  await assertVehicleLimit(tenant.id);
  const before = await db.auditLog.count({ where: { tenantId: tenant.id, action: "SUBSCRIPTION_UPDATED" } });
  await upsertSubscription(actorOf(admin), tenant.id, { plan: "BUSINESS", status: "ACTIVE", monthlyPriceCents: 14900, maxVehicles: 25 });
  assert.equal(await db.auditLog.count({ where: { tenantId: tenant.id, action: "SUBSCRIPTION_UPDATED" } }), before, "unverändert: kein Audit");

  // DB-Regeln auch an der Anwendung vorbei
  await assert.rejects(db.tenantSubscription.update({ where: { tenantId: tenant.id }, data: { plan: "GOLD" } }));
  await assert.rejects(db.tenantSubscription.update({ where: { tenantId: tenant.id }, data: { status: "PAID" } }));
  await assert.rejects(db.tenantSubscription.update({ where: { tenantId: tenant.id }, data: { maxUsers: 0 } }));
  await assert.rejects(db.tenantSubscription.update({ where: { tenantId: tenant.id }, data: { monthlyPriceCents: -1 } }));

  const overview = await billingOverview({ query: tenant.slug });
  assert.equal(overview.rows.length, 1);
  assert.equal(overview.rows[0].subscription?.plan, "BUSINESS");
  assert.equal(overview.rows[0].vehicles, 1);
  assert.ok(overview.totals.mrrCents != null && overview.totals.mrrCents >= 14900);
  assert.equal(overview.totals.arrCents, overview.totals.mrrCents! * 12);
  const stats = await platformDashboardStats();
  assert.ok(stats.mrrCents != null && stats.mrrCents >= 14900);
  assert.ok(stats.vehiclesTotal >= 1);
  assert.ok(stats.tenantsTotal >= 1);
  assert.equal(typeof stats.bookingsTotal, "number");
});

test("Benutzerverwaltung: Suche über Mandanten, Sperren/Entsperren mit denselben Schutzregeln, interne Konten nicht über die Liste sperren", async () => {
  const { tenant, owner: admin, run } = await readyTenant("benutzer");
  const { tenant: other, owner: otherOwner } = await readyTenant("benutzer-other");
  await grant(admin.id, "SUPER_ADMIN");
  const dispo = await db.user.create({ data: { tenantId: tenant.id, email: `dispo-${run}@example.test`, name: "Dispo Test", passwordHash: "x", role: "DISPO" } });
  await db.session.create({ data: { id: `sess-${run}`, userId: dispo.id, expiresAt: new Date(Date.now() + 3600_000) } });

  const byMail = await listUsersForPlatform({ query: `dispo-${run}`, page: 1, pageSize: 10 });
  assert.equal(byMail.total, 1);
  assert.equal(byMail.rows[0].tenant.id, tenant.id);
  const byTenant = await listUsersForPlatform({ tenantId: other.id, page: 1, pageSize: 10 });
  assert.deepEqual(byTenant.rows.map((u) => u.id), [otherOwner.id]);
  const internal = await listUsersForPlatform({ internal: true, query: tenant.slug.replace("cc-", "CC "), page: 1, pageSize: 10 });
  assert.ok(internal.rows.every((u) => u.platformRole !== "NONE"));

  await platformDeactivateUser(actorOf(admin), dispo.id);
  const locked = await db.user.findUniqueOrThrow({ where: { id: dispo.id } });
  assert.equal(locked.active, false);
  assert.equal(await db.session.count({ where: { userId: dispo.id } }), 0, "Sitzungen beendet");
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: tenant.id, action: "USER_DEACTIVATED", userId: admin.id } }));
  await platformActivateUser(actorOf(admin), dispo.id);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: dispo.id } })).active, true);

  await rejectsDomain(platformDeactivateUser(actorOf(admin), admin.id), /interner Plattformrolle|eigene Konto/);
  await rejectsDomain(platformDeactivateUser(actorOf(admin), otherOwner.id), /letzte aktive Inhaber/);
  await rejectsDomain(platformDeactivateUser(actorOf(admin), "unbekannt"), /nicht gefunden/);

  const detail = await userDetailForPlatform(dispo.id);
  assert.ok(detail);
  assert.equal(detail.user.tenant.id, tenant.id);
  assert.ok(!("passwordHash" in detail.user), "kein Passwort-Hash in der Detailansicht");
  assert.ok(detail.audit.some((a) => a.action === "USER_DEACTIVATED"));
});

test("Audit-Bereich: Plattform-Aktionen mandantenübergreifend, Filter nach Aktion/Mandant/Akteur, Geheimnisse werden nie angezeigt", async () => {
  const { tenant, owner: admin } = await readyTenant("audit");
  await grant(admin.id, "SUPER_ADMIN");
  await setTenantFeature(actorOf(admin), tenant.id, "PAYOUTS", false);
  await upsertSubscription(actorOf(admin), tenant.id, { plan: "INTERNAL", status: "ACTIVE" });

  const all = await listPlatformAudit({ tenantId: tenant.id, page: 1, pageSize: 50 });
  assert.deepEqual(all.rows.map((r) => r.action).sort(), ["FEATURE_DISABLED", "SUBSCRIPTION_CREATED"]);
  assert.equal(all.rows[0].tenant.name, tenant.name);
  const onlyFeature = await listPlatformAudit({ tenantId: tenant.id, action: "FEATURE_DISABLED", page: 1, pageSize: 50 });
  assert.equal(onlyFeature.total, 1);
  const byActor = await listPlatformAudit({ tenantId: tenant.id, actorId: admin.id, page: 1, pageSize: 50 });
  assert.equal(byActor.total, 2);
  const none = await listPlatformAudit({ tenantId: tenant.id, from: new Date(Date.now() + 3600_000), page: 1, pageSize: 50 });
  assert.equal(none.total, 0);
  const recent = await recentPlatformAudit(5);
  assert.ok(recent.length >= 1 && recent.length <= 5);

  const view = auditDetailsView({ email: "a@b.test", passwordHash: "geheim", token: "geheim", smtpPassword: "geheim", before: { plan: "TRIAL", secretKey: "x" }, after: { plan: "BUSINESS", secretKey: "y" } });
  assert.deepEqual(view.fields, [["email", "a@b.test"]]);
  assert.deepEqual(view.before, [["plan", "TRIAL"]]);
  assert.deepEqual(view.after, [["plan", "BUSINESS"]]);
  assert.ok(!JSON.stringify(view).includes("geheim"));

  // Kundenliste und Detail liefern Tarif/Feature-Informationen mit
  const list = await listTenantsForPlatform({ query: tenant.slug, plan: "INTERNAL", page: 1, pageSize: 10 });
  assert.equal(list.total, 1);
  assert.equal(list.rows[0].plan, "INTERNAL");
  assert.equal((await listTenantsForPlatform({ query: tenant.slug, plan: "NONE", page: 1, pageSize: 10 })).total, 0);
  const detail = await tenantDetailForPlatform(tenant.id);
  assert.ok(detail);
  assert.equal(detail.features.PAYOUTS, false);
  assert.equal(detail.tenant.subscription?.plan, "INTERNAL");
  assert.equal(detail.usage.customers, 0);
});

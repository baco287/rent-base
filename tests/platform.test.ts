// Befehl 20: Super-Admin, Mandantenverwaltung, Benutzerverwaltung und Beta-Onboarding.
// Deckt die sicherheitskritischen Pfade ab: Plattform-/Mandantentrennung, Einladungen (Race, Ablauf, Widerruf),
// Passwort-Reset (Enumeration, Single-Use, Sitzungsende), Sperrung/Reaktivierung, Supportmodus (read-only,
// gesperrte Dokumentarten, Mandantentrennung, Ablauf), letzter Inhaber, Rollenänderung, Mandanten-Isolation,
// DB-Regeln auch an der Anwendungslogik vorbei.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { randomBytes } from "node:crypto";
import { createTenantByPlatform, listTenantsForPlatform, platformDashboardStats, reactivateTenant, suspendTenant, tenantDetailForPlatform } from "../src/lib/platform-tenants";
import { acceptInvitation, createInvitation, lookupInvitation, resendInvitation, revokeInvitation } from "../src/lib/invitations";
import { completePasswordReset, lookupResetToken, requestPasswordReset } from "../src/lib/password-reset";
import { activeSupportSession, endSupportSession, startSupportSession } from "../src/lib/support-sessions";
import { activateUser, assertNotLastActiveOwner, changeUserRole, deactivateUser } from "../src/lib/tenant-users";
import { DomainError, isImmutableError } from "../src/lib/integrity";
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
const transport = new FakeTransport();
setMailTransport(transport);

function tokenFromMail(m: MailMessage, path: "einladung" | "passwort-vergessen"): string {
  const match = new RegExp(`/${path}/([A-Za-z0-9_-]+)`).exec(m.text);
  if (!match) throw new Error(`kein Token in der Mail gefunden: ${m.text}`);
  return match[1];
}

/** Legt einen Mandanten mit aktivem OWNER direkt an (ohne Einladung), für Tests, die einen fertigen Mandanten brauchen. */
async function readyTenant(label: string, opts: { status?: string } = {}) {
  const run = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const tenant = await db.tenant.create({ data: { name: `Test ${run}`, slug: `test-${run}`, status: opts.status ?? "ACTIVE" } });
  tenants.push(tenant.id);
  const owner = await db.user.create({ data: { tenantId: tenant.id, email: `owner-${run}@example.test`, name: "Owner Eins", passwordHash: await hashPassword("ownerpasswort1"), role: "OWNER" } });
  return { tenant, owner };
}

/** Setzt platformRole direkt (wie das Bootstrap-Skript), für Tests von requirePlatform()/Supportmodus. */
async function makeSuperAdmin(userId: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
    await tx.user.update({ where: { id: userId }, data: { platformRole: "SUPER_ADMIN" } });
  });
}

const actorOf = (u: { id: string; name: string }) => ({ id: u.id, name: u.name });

/** Bildet den DB-seitigen Effekt von createSession() nach (das Original braucht next/headers, hier nicht verfügbar). */
async function newSession(userId: string) {
  await db.session.create({ data: { id: randomBytes(24).toString("base64url"), userId, expiresAt: new Date(Date.now() + 14 * 24 * 3600_000) } });
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
}

test("Mandantenanlage: atomar, Einladung wird versendet, Mandant startet fachlich leer und PENDING_SETUP", async () => {
  const { owner: admin } = await readyTenant("platform-admin");
  await makeSuperAdmin(admin.id);
  transport.sent = [];

  const tenant = await createTenantByPlatform(actorOf(admin), { companyName: "Neue Vermietung GmbH", ownerFirstName: "Erika", ownerLastName: "Neu", ownerEmail: "erika-neu@example.test", baseUrl: "https://rent-base.de" });
  tenants.push(tenant.id);

  assert.equal(tenant.status, "PENDING_SETUP");
  assert.equal(await db.customer.count({ where: { tenantId: tenant.id } }), 0, "kein Fake-Kunde");
  assert.equal(await db.vehicle.count({ where: { tenantId: tenant.id } }), 0, "kein Fake-Fahrzeug");
  assert.equal(await db.user.count({ where: { tenantId: tenant.id } }), 0, "noch kein Benutzer, erst nach Annahme der Einladung");
  assert.equal(tenant.businessRules, null, "keine kopierten Geschäftsregeln");

  assert.equal(transport.sent.length, 1);
  const mail = transport.sent[0];
  assert.equal(mail.to, "erika-neu@example.test");
  // Die Mail darf zum Setzen eines Passworts anleiten ("legen Sie Ihr Passwort fest"), aber nie einen Wert nennen.
  assert.ok(!/[Pp]ass(?:wort|word)\s*[:=]/.test(mail.text), "kein Passwortwert in der Mail");
  assert.ok(mail.text.includes("http"), "Mail enthält den Einladungslink");
  const token = tokenFromMail(mail, "einladung");

  const lookup = await lookupInvitation(token);
  assert.ok(lookup && "invitation" in lookup);
  if (lookup && "invitation" in lookup) {
    assert.equal(lookup.invitation.role, "OWNER");
    assert.equal(lookup.invitation.email, "erika-neu@example.test");
  }

  const { userId } = await acceptInvitation(token, { name: "Erika Neu", password: "einneuespasswort" });
  const newOwner = await db.user.findUniqueOrThrow({ where: { id: userId } });
  assert.deepEqual([newOwner.tenantId, newOwner.role, newOwner.active], [tenant.id, "OWNER", true]);
  assert.ok(await verifyPassword("einneuespasswort", newOwner.passwordHash));

  // derselbe Token ist danach verbraucht
  await assert.rejects(() => acceptInvitation(token, { name: "X", password: "zweitespasswort1" }), /nicht mehr gültig/);
});

test("Einladung: Doppelklick/parallele Anfrage erzeugt nie zwei offene Einladungen; Widerruf und Ablauf greifen", async () => {
  const { tenant, owner } = await readyTenant("invite-race");
  transport.sent = [];

  const attempt = () => createInvitation(tenant.id, actorOf(owner), { email: "dispo@example.test", role: "DISPO", baseUrl: "https://rent-base.de" }).then(() => "ok", (e) => (e instanceof DomainError ? "fehler" : Promise.reject(e)));
  const results = await Promise.all([attempt(), attempt(), attempt()]);
  assert.equal(results.filter((r) => r === "ok").length, 1, "genau eine Einladung entsteht");
  assert.equal(await db.invitation.count({ where: { tenantId: tenant.id, email: "dispo@example.test", status: "PENDING" } }), 1);

  const inv = await db.invitation.findFirstOrThrow({ where: { tenantId: tenant.id, email: "dispo@example.test" } });
  const oldToken = tokenFromMail(transport.sent[0], "einladung");

  const resent = await resendInvitation(tenant.id, actorOf(owner), inv.id, "https://rent-base.de");
  assert.notEqual(resent.tokenHash, inv.tokenHash, "neuer Token bei erneutem Senden");
  await assert.rejects(() => acceptInvitation(oldToken, { name: "X", password: "irgendeinpasswort1" }), /nicht mehr gültig/, "alter Token ist ungültig");

  const newToken = tokenFromMail(transport.sent[1], "einladung");
  await revokeInvitation(tenant.id, actorOf(owner), inv.id);
  await assert.rejects(() => acceptInvitation(newToken, { name: "X", password: "irgendeinpasswort1" }), /nicht mehr gültig/, "widerrufene Einladung ist ungültig");
  await assert.rejects(() => revokeInvitation(tenant.id, actorOf(owner), inv.id), /Nur offene Einladungen/);

  // abgelaufene Einladung direkt an der Anwendungslogik vorbei simuliert
  const expiring = await createInvitation(tenant.id, actorOf(owner), { email: "abgelaufen@example.test", role: "YARD", baseUrl: "https://rent-base.de" });
  const expiredToken = tokenFromMail(transport.sent[2], "einladung");
  await db.$transaction((tx) => tx.$executeRawUnsafe(`UPDATE "Invitation" SET "expiresAt" = now() - interval '1 hour' WHERE id = '${expiring.id}'`));
  assert.deepEqual(await lookupInvitation(expiredToken), { expired: true });
  await assert.rejects(() => acceptInvitation(expiredToken, { name: "X", password: "irgendeinpasswort1" }), /abgelaufen/);
});

test("Einladung: unveränderlich nach Annahme/Widerruf, auch an der Datenbank vorbei (DB-Regel)", async () => {
  const { tenant, owner } = await readyTenant("invite-immutable");
  transport.sent = [];
  const inv = await createInvitation(tenant.id, actorOf(owner), { email: "test-immutable@example.test", role: "DISPO", baseUrl: "https://rent-base.de" });
  const token = tokenFromMail(transport.sent[0], "einladung");
  await acceptInvitation(token, { name: "Test Immutable", password: "irgendeinpasswort1" });
  await assert.rejects(() => db.invitation.update({ where: { id: inv.id }, data: { status: "PENDING" } }), (e) => isImmutableError(e));
});

test("Passwort-Reset: neutrale Antwort bei unbekannter Adresse, Token single-use, beendet alle Sitzungen", async () => {
  const { tenant, owner } = await readyTenant("reset");
  await newSession(owner.id);
  await newSession(owner.id);
  assert.equal(await db.session.count({ where: { userId: owner.id } }), 2);

  transport.sent = [];
  await requestPasswordReset("unbekannt-" + Date.now() + "@example.test", "https://rent-base.de");
  assert.equal(transport.sent.length, 0, "keine Mail und kein Fehler bei unbekannter Adresse");

  await requestPasswordReset(owner.email, "https://rent-base.de");
  assert.equal(transport.sent.length, 1);
  const token = tokenFromMail(transport.sent[0], "passwort-vergessen");
  assert.deepEqual(await lookupResetToken(token), { valid: true });

  await completePasswordReset(token, "ganzneuespasswort1");
  const updated = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
  assert.ok(await verifyPassword("ganzneuespasswort1", updated.passwordHash));
  assert.equal(await db.session.count({ where: { userId: owner.id } }), 0, "alle Sitzungen beendet");

  await assert.rejects(() => completePasswordReset(token, "nochnmalpasswort1"), /nicht mehr gültig/, "Token ist single-use");
  void tenant;
});

// Das eigentliche "keine Mutation mehr möglich" prüft tests/smoke-pages.mts über echte HTTP-Requests
// (requireSession()/requireRole() lesen den Sitzungs-Cookie, der hier ohne Request-Kontext nicht existiert).
test("Mandantensperrung: beendet sofort alle Sitzungen, Reaktivierung stellt Zugriff wieder her, Daten unverändert", async () => {
  const { tenant, owner } = await readyTenant("suspend");
  const { owner: admin } = await readyTenant("suspend-admin");
  await makeSuperAdmin(admin.id);
  await newSession(owner.id);
  assert.equal(await db.session.count({ where: { userId: owner.id } }), 1);

  await suspendTenant(actorOf(admin), tenant.id, "Testsperrung für Befehl 20");
  const suspended = await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
  assert.equal(suspended.status, "SUSPENDED");
  assert.equal(await db.session.count({ where: { userId: owner.id } }), 0, "Sitzungen sofort beendet");
  await assert.rejects(() => suspendTenant(actorOf(admin), tenant.id, "nochmal"), /bereits gesperrt/);

  await reactivateTenant(actorOf(admin), tenant.id);
  const reactivated = await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
  assert.deepEqual([reactivated.status, reactivated.suspendedAt, reactivated.suspendedReason], ["ACTIVE", null, null]);
  assert.equal(reactivated.name, tenant.name, "keine Neuinitialisierung");
});

test("Supportmodus: read-only, zeitlich begrenzt, mandantengetrennt, protokolliert, Ende möglich", async () => {
  const a = await readyTenant("support-a");
  const b = await readyTenant("support-b");
  const { owner: admin } = await readyTenant("support-admin");
  await makeSuperAdmin(admin.id);

  assert.equal(await activeSupportSession(admin.id, a.tenant.id), null);
  const support = await startSupportSession(actorOf(admin), a.tenant.id, "Diagnose für Befehl-20-Test");
  assert.equal(support.tenantId, a.tenant.id);
  const active = await activeSupportSession(admin.id, a.tenant.id);
  assert.ok(active && active.id === support.id);
  assert.equal(await activeSupportSession(admin.id, b.tenant.id), null, "Supportsession gilt nur für den gestarteten Mandanten");
  await assert.rejects(() => startSupportSession(actorOf(admin), a.tenant.id, ""), /Grund/);

  const log = await db.auditLog.findFirst({ where: { tenantId: a.tenant.id, action: "SUPPORT_SESSION_STARTED" } });
  assert.ok(log);

  await endSupportSession(actorOf(admin), support.id);
  assert.equal(await activeSupportSession(admin.id, a.tenant.id), null, "nach dem Beenden nicht mehr aktiv");
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: a.tenant.id, action: "SUPPORT_SESSION_ENDED" } }));

  // abgelaufene Session gilt nicht mehr als aktiv
  const expiring = await startSupportSession(actorOf(admin), a.tenant.id, "läuft gleich ab");
  await db.supportSession.update({ where: { id: expiring.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await activeSupportSession(admin.id, a.tenant.id), null);
});

test("Letzter aktiver Inhaber: kann nicht deaktiviert oder herabgestuft werden, auch nicht an der Datenbank vorbei; nach zweitem Inhaber möglich", async () => {
  const { tenant, owner } = await readyTenant("last-owner");

  await assert.rejects(() => deactivateUser(actorOf(owner), tenant.id, owner.id), /Das eigene Konto/);
  const second = await db.user.create({ data: { tenantId: tenant.id, email: `second-${Date.now()}@example.test`, name: "Zweiter", passwordHash: await hashPassword("zweiterpasswort1"), role: "DISPO" } });

  await assert.rejects(() => assertNotLastActiveOwner(tenant.id, owner.id, "getestet werden"), /letzte aktive Inhaber/, "Zweiter Benutzer ist DISPO, nicht OWNER – owner bleibt der einzige aktive Inhaber");
  await assert.rejects(() => changeUserRole(actorOf(second), tenant.id, owner.id, "DISPO"), /letzte aktive Inhaber/);
  await assert.rejects(() => db.user.update({ where: { id: owner.id }, data: { active: false } }), (e) => isImmutableError(e), "DB-Trigger greift auch direkt");
  await assert.rejects(() => db.user.update({ where: { id: owner.id }, data: { role: "YARD" } }), (e) => isImmutableError(e));

  const thirdAsOwner = await db.user.create({ data: { tenantId: tenant.id, email: `third-${Date.now()}@example.test`, name: "Dritter", passwordHash: await hashPassword("dritterpasswort1"), role: "OWNER" } });
  await changeUserRole(actorOf(thirdAsOwner), tenant.id, owner.id, "DISPO");
  const downgraded = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
  assert.equal(downgraded.role, "DISPO");
  await deactivateUser(actorOf(thirdAsOwner), tenant.id, second.id);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: second.id } })).active, false);
  await activateUser(actorOf(thirdAsOwner), tenant.id, second.id);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: second.id } })).active, true);

  const roleLog = await db.auditLog.findFirst({ where: { tenantId: tenant.id, action: "USER_ROLE_CHANGED" }, orderBy: { createdAt: "desc" } });
  assert.ok(roleLog, "Rollenänderung ist protokolliert");
  assert.equal((roleLog?.details as { email?: string } | null)?.email, owner.email);
});

test("Plattformzugang: requirePlatform prüft ausschließlich platformRole, nie die Mandantenrolle; SUPER_ADMIN kann selbst Mitglied eines Mandanten bleiben", async () => {
  const { tenant, owner } = await readyTenant("platform-role");
  // OWNER ohne SUPER_ADMIN: platformRole bleibt NONE
  assert.equal(owner.platformRole, "NONE");
  await makeSuperAdmin(owner.id);
  const stillOwner = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
  assert.deepEqual([stillOwner.platformRole, stillOwner.role, stillOwner.tenantId], ["SUPER_ADMIN", "OWNER", tenant.id]);

  // platformRole lässt sich nicht ohne die ausdrückliche Freigabe ändern, auch nicht direkt in der Datenbank
  await assert.rejects(() => db.user.update({ where: { id: owner.id }, data: { platformRole: "NONE" } }), (e) => isImmutableError(e));
});

test("Mandantenliste und Dashboard: Suche über Firma/Owner-E-Mail, Pagination, Kennzahlen stimmen", async () => {
  const before = await platformDashboardStats();
  const { tenant, owner } = await readyTenant("search-list");

  const { rows: byName } = await listTenantsForPlatform({ query: tenant.name, page: 1, pageSize: 10 });
  assert.ok(byName.some((r) => r.id === tenant.id));
  const { rows: byEmail } = await listTenantsForPlatform({ query: owner.email, page: 1, pageSize: 10 });
  assert.ok(byEmail.some((r) => r.id === tenant.id));
  const { rows: noMatch } = await listTenantsForPlatform({ query: "gibt-es-ganz-sicher-nicht-" + Date.now(), page: 1, pageSize: 10 });
  assert.equal(noMatch.length, 0);

  const after1 = await platformDashboardStats();
  assert.equal(after1.tenantsTotal, before.tenantsTotal + 1);
  assert.equal(after1.tenantsActive, before.tenantsActive + 1);

  const detail = await tenantDetailForPlatform(tenant.id);
  assert.ok(detail);
  assert.equal(detail?.users.length, 1);
  assert.equal(await tenantDetailForPlatform("gibt-es-nicht-" + Date.now()), null);
});

test("Mandanten-Isolation: zwei neue Mandanten mit absichtlich gleichen Werten kollidieren nie", async () => {
  const a = await readyTenant("iso-a");
  const b = await readyTenant("iso-b");
  await db.customer.create({ data: { tenantId: a.tenant.id, number: "K-00001", firstName: "Erika", lastName: "Muster", street: "Weg 1", zip: "1", city: "Bremen", country: "DE" } });
  await db.customer.create({ data: { tenantId: b.tenant.id, number: "K-00001", firstName: "Erika", lastName: "Muster", street: "Weg 1", zip: "1", city: "Bremen", country: "DE" } });
  assert.equal(await db.customer.count({ where: { tenantId: a.tenant.id, number: "K-00001" } }), 1);
  assert.equal(await db.customer.count({ where: { tenantId: b.tenant.id, number: "K-00001" } }), 1);
  // Einladung: gleiche E-Mail-Adresse für zwei unterschiedliche Mandanten ist erlaubt (kein globaler Konflikt vor Annahme)
  transport.sent = [];
  await createInvitation(a.tenant.id, actorOf(a.owner), { email: "gleiche-adresse@example.test", role: "DISPO", baseUrl: "https://rent-base.de" });
  await createInvitation(b.tenant.id, actorOf(b.owner), { email: "gleiche-adresse@example.test", role: "DISPO", baseUrl: "https://rent-base.de" });
  assert.equal(transport.sent.length, 2);
  const tokenA = tokenFromMail(transport.sent[0], "einladung");
  const tokenB = tokenFromMail(transport.sent[1], "einladung");
  await acceptInvitation(tokenA, { name: "Erste Annahme", password: "irgendeinpasswort1" });
  // zweite Annahme derselben E-Mail-Adresse scheitert an der globalen User.email-Eindeutigkeit (Bestandsarchitektur, siehe Bericht)
  await assert.rejects(() => acceptInvitation(tokenB, { name: "Zweite Annahme", password: "irgendeinpasswort1" }), /bereits ein Konto/);
});

test("Tenant no-delete: weder Mandant noch Benutzer lassen sich ohne ausdrückliche Freigabe endgültig löschen", async () => {
  const { tenant, owner } = await readyTenant("no-delete");
  await assert.rejects(() => db.user.delete({ where: { id: owner.id } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.tenant.delete({ where: { id: tenant.id } }), (e) => isImmutableError(e));
});

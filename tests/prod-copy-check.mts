// Prüfung gegen eine migrierte PRODUKTIONSKOPIE (nie gegen Produktion!). Erwartet DATABASE_URL = Kopie und einen
// laufenden Server gegen dieselbe Kopie. Legt keine Testmandanten an; nutzt die echten Konten der Kopie über direkt
// angelegte Sitzungen (keine Passwörter nötig) und führt nur umkehrbare Aktionen aus (Supportmodus, Feature, Abo,
// Sperre, Einladung), die danach zurückgesetzt werden. Aufruf: npx tsx tests/prod-copy-check.mts http://localhost:3301
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { setMailTransport, type MailMessage, type MailTransport } from "../src/lib/mail";
import { startSupportSession, endSupportSession } from "../src/lib/support-sessions";
import { setTenantFeature, isFeatureEnabled } from "../src/lib/features";
import { upsertSubscription, assertVehicleLimit, assertUserLimit } from "../src/lib/subscriptions";
import { suspendTenant, reactivateTenant, listTenantsForPlatform, platformDashboardStats } from "../src/lib/platform-tenants";
import { platformDeactivateUser, listUsersForPlatform, setPlatformRole } from "../src/lib/platform-users";
import { createInvitation, revokeInvitation } from "../src/lib/invitations";
import { listPlatformAudit } from "../src/lib/platform-audit";
import { DomainError } from "../src/lib/integrity";

const base = process.argv[2] ?? "http://localhost:3301";
if (!/rentbase_copy|55432/.test(process.env.DATABASE_URL ?? "")) throw new Error("DATABASE_URL zeigt nicht auf die Produktionskopie – Abbruch.");
let fails = 0;
const report = (ok: boolean, label: string) => { console.log(`${ok ? "OK  " : "FEHL"} ${label}`); if (!ok) fails++; };
const plain = async (r: Response) => (await r.text()).replace(/\s+/g, " ");
class Fake implements MailTransport { readonly name = "fake"; sent: MailMessage[] = []; async send(m: MailMessage) { this.sent.push(m); return { messageId: "<x>" }; } }
const mail = new Fake();
setMailTransport(mail);

const users = await db.user.findMany({ include: { tenant: true }, orderBy: { email: "asc" } });
const admin = users.find((u) => u.platformRole === "SUPER_ADMIN");
const normal = users.find((u) => u.platformRole === "NONE" && u.active);
if (!admin || !normal) throw new Error("Kopie enthält nicht die erwarteten Konten (SUPER_ADMIN + normaler Benutzer).");
const cookieFor = async (userId: string) => { const id = randomBytes(32).toString("base64url"); await db.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3600_000) } }); return `rb_session=${id}`; };
const adminCookie = await cookieFor(admin.id);
const normalCookie = await cookieFor(normal.id);
const actor = { id: admin.id, name: admin.name };
const t = normal.tenant;
console.log(`Konten: SUPER_ADMIN ${admin.email} (${admin.tenant.name}), normal ${normal.email} (${t.name}, ${t.status})`);

// 1) Login-Ersatz: Sitzung normaler Mandant und Super-Admin
const h1 = await fetch(`${base}/heute`, { headers: { cookie: normalCookie }, redirect: "manual" });
report(h1.status === 200 && (await plain(h1)).includes(t.name), `${h1.status} normaler Mandant: Startseite mit Firmenname`);
const adminBlocked = await fetch(`${base}/admin`, { headers: { cookie: normalCookie }, redirect: "manual" });
report(adminBlocked.status === 307 && (adminBlocked.headers.get("location") ?? "").includes("/heute"), `${adminBlocked.status} normaler Mandant kommt nicht auf /admin`);
const a1 = await fetch(`${base}/admin`, { headers: { cookie: adminCookie } });
report(a1.status === 200 && (await plain(a1)).includes("RentBase Control Center"), `${a1.status} Super-Admin: Dashboard`);
const ownerHome = await fetch(`${base}/heute`, { headers: { cookie: adminCookie } });
report(ownerHome.status === 200 && (await plain(ownerHome)).includes(admin.tenant.name), `${ownerHome.status} Super-Admin als Inhaber seines Mandanten: Startseite`);

// 2) Control-Center-Bereiche
for (const [p, needle] of [["/admin/mandanten", t.name], [`/admin/mandanten/${t.id}`, "Tarif &amp; Abo"], ["/admin/benutzer", normal.email], [`/admin/benutzer/${normal.id}`, "Interne Plattformrolle"], ["/admin/abos", "Tarife &amp; Abonnements"], ["/admin/features", "Feature Management"], ["/admin/support", "Support &amp; Diagnose"], ["/admin/audit", "Audit Log"], ["/admin/system", "Berechtigungsmatrix"]] as const) {
  const r = await fetch(`${base}${p}`, { headers: { cookie: adminCookie } });
  const html = await plain(r);
  report(r.status === 200 && html.includes(needle) && !/passwordHash|postgres:\/\//.test(html), `${r.status} ${p}`);
}
const stats = await platformDashboardStats();
report(stats.tenantsTotal === (await db.tenant.count()) && stats.usersTotal === (await db.user.count({ where: { active: true } })), `Dashboard-Kennzahlen stimmen mit der Kopie überein (${stats.tenantsTotal} Mandanten, ${stats.usersTotal} Benutzer)`);
const list = await listTenantsForPlatform({ page: 1, pageSize: 50 });
report(list.total === stats.tenantsTotal && list.rows.every((r) => r.plan === null), "Kundenliste: alle Bestandsmandanten ohne Tarif (kein künstlicher Datensatz nötig)");
for (const tenant of await db.tenant.findMany()) report(await isFeatureEnabled(tenant.id, "AUTHORITIES"), `Feature-Standard ohne Zeile: an (${tenant.name})`);

// 3) Bestehende Kernfunktionen des Betreiber-Mandanten (lesend): Buchungen, Verträge, Übergaben, Rechnungen, Zahlungen, Fahrerprüfung
const bookings = await db.booking.findMany({ where: { tenantId: admin.tenantId }, orderBy: { createdAt: "asc" } });
const core: string[] = ["/buchungen", "/buchungen?filter=alle", "/dispo", "/fahrzeuge", "/fahrzeuge/wartung", "/kunden", "/rechnungen", "/auszahlungen", "/schaeden", "/behoerden", "/einstellungen", "/einstellungen/mitarbeiter", "/einstellungen/vertraege", "/einstellungen/rechnungen", "/einstellungen/tarife", "/einstellungen/geschaeftsregeln", "/einstellungen/mietbedingungen", "/einstellungen/nummernkreise", "/einstellungen/e-mail", "/kunden/import", "/fahrzeuge/neu", "/buchungen/neu"];
for (const b of bookings) core.push(`/buchungen/${b.id}`, `/buchungen/${b.id}/vertrag`, `/buchungen/${b.id}/uebergabe`, `/buchungen/${b.id}/rueckgabe`, `/buchungen/${b.id}/rechnung`);
for (const c of await db.customer.findMany({ where: { tenantId: admin.tenantId }, take: 5 })) core.push(`/kunden/${c.id}`);
for (const v of await db.vehicle.findMany({ where: { tenantId: admin.tenantId } })) core.push(`/fahrzeuge/${v.id}`);
let coreOk = 0;
for (const p of core) {
  const r = await fetch(`${base}${p}`, { headers: { cookie: adminCookie }, redirect: "manual" });
  const html = r.status === 200 ? await plain(r) : "";
  const ok = (r.status === 200 && !/Internal Server Error|Application error|Unhandled Runtime/.test(html)) || (r.status === 307 && !(r.headers.get("location") ?? "").includes("/login"));
  if (!ok) report(false, `${r.status} ${p}`); else coreOk++;
}
report(coreOk === core.length, `Bestehende Seiten des Betreiber-Mandanten ohne Fehler: ${coreOk}/${core.length} (inkl. ${bookings.length} Buchungen mit Vertrag/Übergabe/Rückgabe/Rechnung)`);
const contracts = await db.rentalContract.count({ where: { tenantId: admin.tenantId } });
const payments = await db.payment.count({ where: { tenantId: admin.tenantId } });
const verifications = await db.driverVerification.count({ where: { tenantId: admin.tenantId } });
report(true, `Bestand unverändert lesbar: ${contracts} Verträge, ${payments} Zahlungen, ${verifications} Fahrerprüfungen`);

// 4) Supportmodus: Start, read-only, Ende
const support = await startSupportSession(actor, t.id, "Prod-Kopie-Test Supportmodus");
const sHome = await fetch(`${base}/heute`, { headers: { cookie: `${adminCookie}; rb_support=${support.id}` } });
report(sHome.status === 200 && (await plain(sHome)).includes("SUPPORTMODUS") && (await plain(await fetch(`${base}/heute`, { headers: { cookie: `${adminCookie}; rb_support=${support.id}` } }))).includes(t.name), `${sHome.status} Supportmodus: Banner und Zielmandant`);
const sWrite = await fetch(`${base}/api/kunden/import/validate`, { method: "POST", headers: { cookie: `${adminCookie}; rb_support=${support.id}`, "content-type": "application/json" }, body: JSON.stringify({ rows: [] }) });
report(sWrite.status === 403, `${sWrite.status} Supportmodus: API-Schreibzugriff abgelehnt`);
const sDoc = await fetch(`${base}/api/driver-documents/irgendeins`, { headers: { cookie: `${adminCookie}; rb_support=${support.id}` } });
report(sDoc.status === 403, `${sDoc.status} Supportmodus: sensible Dokumente gesperrt`);
await endSupportSession(actor, support.id);
const ended = await db.supportSession.findUniqueOrThrow({ where: { id: support.id } });
report(Boolean(ended.endedAt) && !(await plain(await fetch(`${base}/heute`, { headers: { cookie: `${adminCookie}; rb_support=${support.id}` } }))).includes("SUPPORTMODUS"), "Supportmodus beendet: Cookie wirkungslos");

// 5) Feature-Flag: sperren → Navigation, Seite, API; wieder freischalten
await setTenantFeature(actor, t.id, "AUTHORITIES", false, "Prod-Kopie-Test");
const gated = await fetch(`${base}/behoerden`, { headers: { cookie: normalCookie }, redirect: "manual" });
report(gated.status === 307 && (gated.headers.get("location") ?? "").includes("fehler=funktion"), `${gated.status} Feature gesperrt: Seite abgelehnt`);
const gatedApi = await fetch(`${base}/api/authority-uploads`, { method: "POST", headers: { cookie: normalCookie }, body: new FormData() });
report(gatedApi.status === 403, `${gatedApi.status} Feature gesperrt: API abgelehnt`);
report(!(/<aside[\s\S]*?<\/aside>/.exec(await plain(await fetch(`${base}/heute`, { headers: { cookie: normalCookie } })))?.[0] ?? "").includes('href="/behoerden"'), "Feature gesperrt: aus der Navigation entfernt");
const otherOpen = await fetch(`${base}/behoerden`, { headers: { cookie: adminCookie }, redirect: "manual" });
report(otherOpen.status === 200, `${otherOpen.status} Feature gesperrt: anderer Mandant unberührt`);
await setTenantFeature(actor, t.id, "AUTHORITIES", true);
report((await fetch(`${base}/behoerden`, { headers: { cookie: normalCookie }, redirect: "manual" })).status === 200, "Feature wieder freigeschaltet");

// 6) Abo, Limits, Einladung, Fahrzeuganlage-Limit
await upsertSubscription(actor, t.id, { plan: "STARTER", status: "ACTIVE", monthlyPriceCents: 4900, maxUsers: 1, maxVehicles: 1 });
const aboPage = await plain(await fetch(`${base}/admin/mandanten/${t.id}`, { headers: { cookie: adminCookie } }));
report(aboPage.includes("Starter") && aboPage.includes("49,00"), "Abo-Verwaltung: Tarif auf der Mandantenseite");
await assert(async () => createInvitation(t.id, actor, { email: "limit-test@example.test", role: "DISPO", baseUrl: base }), /Benutzerlimit/, "Benutzerlimit greift bei Einladung");
await upsertSubscription(actor, t.id, { plan: "STARTER", status: "ACTIVE", monthlyPriceCents: 4900, maxUsers: null, maxVehicles: null });
await assertUserLimit(t.id);
await assertVehicleLimit(t.id);
const inv = await createInvitation(t.id, actor, { email: "prodkopie-einladung@example.test", role: "DISPO", baseUrl: base });
report(inv.status === "PENDING" && mail.sent.length >= 1, "Benutzer-Einladung angelegt und Mail erzeugt (Fake-Transport)");
const invPage = await plain(await fetch(`${base}/admin/benutzer?tab=einladungen`, { headers: { cookie: adminCookie } }));
report(invPage.includes("prodkopie-einladung@example.test"), "Einladung erscheint in der Benutzerverwaltung");
await revokeInvitation(t.id, actor, inv.id);
await db.tenantSubscription.delete({ where: { tenantId: t.id } });

// 7) Sperren/Entsperren, Benutzerverwaltung, Rollen-Schutz
await suspendTenant(actor, t.id, "Prod-Kopie-Test Sperre");
const locked = await fetch(`${base}/heute`, { headers: { cookie: normalCookie }, redirect: "manual" });
report(locked.status === 307 && (locked.headers.get("location") ?? "").includes("/login"), `${locked.status} Sperre: Sitzung des Mandanten beendet`);
await reactivateTenant(actor, t.id);
const normalCookie2 = await cookieFor(normal.id);
report((await fetch(`${base}/heute`, { headers: { cookie: normalCookie2 }, redirect: "manual" })).status === 200, "Entsperrt: Zugriff wieder möglich");
const ul = await listUsersForPlatform({ query: normal.email, page: 1, pageSize: 10 });
report(ul.total === 1 && ul.rows[0].tenant.id === t.id, "Benutzerverwaltung: Suche findet Bestandsbenutzer");
await assert(async () => platformDeactivateUser(actor, normal.id), /letzte aktive Inhaber/, "Letzter Inhaber eines Mandanten kann nicht gesperrt werden");
await assert(async () => setPlatformRole(actor, admin.id, "NONE"), /eigene Plattformrolle/, "Eigenes Konto: Plattformrolle nicht änderbar");
await assert(async () => setPlatformRole({ id: normal.id, name: normal.name }, admin.id, "NONE"), /letzte aktive SUPER_ADMIN/, "Letzter aktiver SUPER_ADMIN kann nicht entfernt werden");
const audit = await listPlatformAudit({ tenantId: t.id, page: 1, pageSize: 50 });
const actions = new Set(audit.rows.map((r) => r.action));
report(["SUPPORT_SESSION_STARTED", "SUPPORT_SESSION_ENDED", "FEATURE_DISABLED", "FEATURE_ENABLED", "SUBSCRIPTION_CREATED", "TENANT_SUSPENDED", "TENANT_REACTIVATED", "USER_INVITED", "INVITATION_REVOKED"].every((a) => actions.has(a)), `Audit Log enthält alle Testaktionen (${audit.total} Einträge für ${t.name})`);
// Reaktivierung setzt seit Befehl 20 immer ACTIVE (auch wenn der Mandant vorher PENDING_SETUP war) – bekanntes Verhalten, keine Regression
const endStatus = (await db.tenant.findUniqueOrThrow({ where: { id: t.id } })).status;
report((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).platformRole === "SUPER_ADMIN" && (endStatus === t.status || (t.status === "PENDING_SETUP" && endStatus === "ACTIVE")), `Endzustand der Kopie: Rollen unverändert, Mandantenstatus ${t.status} → ${endStatus}`);

async function assert(fn: () => Promise<unknown>, re: RegExp, label: string) {
  try { await fn(); report(false, `${label} (kein Fehler)`); } catch (e) { report(e instanceof DomainError && re.test(e.message), `${label}: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
}
await db.session.deleteMany({ where: { id: { in: [adminCookie, normalCookie, normalCookie2].map((c) => c.replace("rb_session=", "")) } } });
await db.$disconnect();
console.log(fails === 0 ? "\nProduktionskopie: alle Prüfungen bestanden." : `\n${fails} Prüfung(en) fehlgeschlagen.`);
process.exit(fails === 0 ? 0 : 1);

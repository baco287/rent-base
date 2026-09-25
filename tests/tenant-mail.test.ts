// Befehl 20.5: mandanteneigener E-Mail-Versand, SMTP-Geheimnisse, Branding.
// Gegen einen echten lokalen SMTP-Testserver (STARTTLS, Anmeldung, Absenderprüfung) auf 127.0.0.1 – nichts verlässt den
// Rechner. Der Testserver nutzt ein selbst signiertes Zertifikat; nur in diesem Testprozess wird es akzeptiert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.RENTBASE_SECRET_KEY = Buffer.from("rentbase-testschluessel-32-bytes").toString("base64");
delete process.env.RENTBASE_SECRET_KEY_PREVIOUS;

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import { db } from "../src/lib/db";
import { createWorld, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";
import { decryptSecret, encryptSecret, SecretDecryptError, SecretKeyMissingError, secretKeyIdOf } from "../src/lib/secret-box";
import { setMailTransport, SmtpTransport, type MailMessage, type MailTransport } from "../src/lib/mail";
import { clearAllRateLimits } from "../src/lib/rate-limit";
import {
  disableTenantSmtp, enableTenantSmtp, getMailSettingsView, saveMailSettings, sendBusinessMail, sendSmtpTestMail, setTenantSmtpHooks, testMailConnection,
  type SaveMailSettingsInput,
} from "../src/lib/tenant-mail";
import { createInvitation } from "../src/lib/invitations";
import { requestPasswordReset } from "../src/lib/password-reset";
import { DomainError, sha256 } from "../src/lib/integrity";
import { currentLogo, loadLogo, normalizeLogo, removeTenantLogo, uploadTenantLogo } from "../src/lib/branding";
import { logoRefOf } from "../src/lib/branding-ref";
import { assertKeyBelongsToTenant, getStorage } from "../src/lib/storage";
import { ensureContractDocument, ensurePickupDocument } from "../src/lib/documents";
import { loadContractDocumentData } from "../src/lib/document-data";
import { renderContractPdf } from "../src/lib/pdf/contract-pdf";
import { sendHandoverDocuments } from "../src/lib/rental-mail";

const tenants: string[] = [];
const PASSWORD = "App-Passwort-sehr-geheim-4711";

// ---------------------------------------------------------------------------
// lokaler SMTP-Server des „Vermieters“: nur Benutzer vermietung@volt.test/PASSWORD, nur Absender vermietung@volt.test
// ---------------------------------------------------------------------------
const received: { mail: ParsedMail; authUser: string | undefined; mailFrom: string | undefined }[] = [];
let server: SMTPServer;
let port = 0;

before(async () => {
  server = new SMTPServer({
    authOptional: false,
    onAuth(auth, _s, cb) {
      if (auth.username === "vermietung@volt.test" && auth.password === PASSWORD) return cb(null, { user: auth.username });
      return cb(Object.assign(new Error("Invalid login"), { responseCode: 535 }));
    },
    onMailFrom(address, _s, cb) {
      if (address.address !== "vermietung@volt.test") return cb(Object.assign(new Error("Sender address rejected: not owned by user"), { responseCode: 553 }));
      cb();
    },
    onData(stream, session, cb) {
      simpleParser(stream, { keepCidLinks: true }).then((mail) => { received.push({ mail, authUser: session.user as string | undefined, mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined }); cb(); }, cb);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setTenantSmtpHooks(null);
  setMailTransport(null);
  await purgeTenants(tenants);
  await db.$disconnect();
});

class FakePlatform implements MailTransport {
  readonly name = "fake-platform";
  sent: MailMessage[] = [];
  async send(m: MailMessage) { this.sent.push(m); return { messageId: `<platform-${this.sent.length}@test>` }; }
}
const platform = new FakePlatform();

/** Verbindungen des Vermieters gehen an den lokalen Testserver; aufgezeichnet wird, was tatsächlich verwendet wurde. */
const usedConfigs: { host: string; user: string; pass: string; fromEmail: string; secure: boolean }[] = [];
beforeEach(() => {
  clearAllRateLimits();
  setMailTransport(platform);
  setTenantSmtpHooks({
    resolveHost: async (host) => (host.endsWith(".test") ? "127.0.0.1" : Promise.reject(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))),
    factory: (cfg) => { usedConfigs.push({ host: cfg.host, user: cfg.user, pass: cfg.pass, fromEmail: cfg.fromEmail, secure: cfg.secure }); return new SmtpTransport({ ...cfg, port }); },
  });
});

async function tenantWithOwner(label: string) {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  const owner = await db.user.findUniqueOrThrow({ where: { id: w.userId } });
  return { w, owner, actor: { id: owner.id, name: owner.name, email: owner.email } };
}

const good = (over: Partial<SaveMailSettingsInput> = {}): SaveMailSettingsInput => ({ host: "smtp.volt.test", port: 587, security: "STARTTLS", username: "vermietung@volt.test", newPassword: PASSWORD, fromName: "Volt Gas UG", fromEmail: "vermietung@volt.test", replyTo: null, ...over });
const nonce = () => `n-${Math.random().toString(36).slice(2, 12)}`;

async function allAuditAndLogs(tenantId: string) {
  const [audit, logs, settings] = await Promise.all([db.auditLog.findMany({ where: { tenantId } }), db.emailLog.findMany({ where: { tenantId } }), db.tenantMailSettings.findUnique({ where: { tenantId } })]);
  return { text: JSON.stringify({ audit, logs }), ciphertext: settings?.passwordCiphertext ?? "" };
}

// ---------------------------------------------------------------------------
// Verschlüsselung
// ---------------------------------------------------------------------------

test("Secret-Box: AES-256-GCM, zufälliger IV, an Mandant und Zweck gebunden, falscher Schlüssel/veränderter Wert werfen statt Klartext", () => {
  const a = encryptSecret(PASSWORD, { purpose: "smtp-password", tenantId: "tenant-a" });
  const b = encryptSecret(PASSWORD, { purpose: "smtp-password", tenantId: "tenant-a" });
  assert.notEqual(a, b, "jeder Wert mit eigenem IV");
  assert.ok(!a.includes(PASSWORD) && !Buffer.from(a).toString("base64").includes(Buffer.from(PASSWORD).toString("base64")));
  assert.match(a, /^v1\.[0-9a-f]{12}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(decryptSecret(a, { purpose: "smtp-password", tenantId: "tenant-a" }), PASSWORD);
  assert.throws(() => decryptSecret(a, { purpose: "smtp-password", tenantId: "tenant-b" }), SecretDecryptError, "kopierter Wert bei anderem Mandanten unbrauchbar");
  assert.throws(() => decryptSecret(a, { purpose: "anderer-zweck", tenantId: "tenant-a" }), SecretDecryptError);
  const parts = a.split(".");
  const tampered = [...parts.slice(0, 4), Buffer.from("x" + Buffer.from(parts[4], "base64url").toString("latin1").slice(1), "latin1").toString("base64url")].join(".");
  assert.throws(() => decryptSecret(tampered, { purpose: "smtp-password", tenantId: "tenant-a" }), SecretDecryptError);
  const otherKey = { ...process.env, RENTBASE_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") } as NodeJS.ProcessEnv;
  assert.throws(() => decryptSecret(a, { purpose: "smtp-password", tenantId: "tenant-a" }, otherKey), SecretDecryptError, "falscher Schlüssel liefert nie still Daten");
  // Schlüsselwechsel: alter Schlüssel als PREVIOUS entschlüsselt weiter, neue Werte bekommen den neuen Schlüssel
  const rotated = { ...otherKey, RENTBASE_SECRET_KEY_PREVIOUS: process.env.RENTBASE_SECRET_KEY } as NodeJS.ProcessEnv;
  assert.equal(decryptSecret(a, { purpose: "smtp-password", tenantId: "tenant-a" }, rotated), PASSWORD);
  assert.notEqual(secretKeyIdOf(encryptSecret("x", { purpose: "p", tenantId: "t" }, rotated)), secretKeyIdOf(a));
  const noKey = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => encryptSecret("x", { purpose: "p", tenantId: "t" }, noKey), SecretKeyMissingError, "ohne Schlüssel keine unsichere Speicherung");
  assert.throws(() => decryptSecret(a, { purpose: "smtp-password", tenantId: "tenant-a" }, noKey), SecretKeyMissingError);
});

test("Speichern: Passwort nur verschlüsselt in der DB, Ansicht ohne Passwort/Chiffrat, Klartext scheitert an der DB, ohne Schlüssel keine Aktivierung", async () => {
  const { w, actor } = await tenantWithOwner("smtp-save");
  const view = await saveMailSettings(w.tenantId, actor, good());
  assert.equal(view.status, "CONFIGURED");
  assert.equal(view.mode, "PLATFORM", "Speichern schaltet nie automatisch um");
  assert.equal(view.hasPassword, true);
  const row = await db.tenantMailSettings.findUniqueOrThrow({ where: { tenantId: w.tenantId } });
  assert.ok(row.passwordCiphertext && !row.passwordCiphertext.includes(PASSWORD));
  const json = JSON.stringify(view);
  assert.ok(!json.includes(PASSWORD) && !json.includes(row.passwordCiphertext) && !("passwordCiphertext" in view), "Ansicht ohne Passwort und ohne Chiffrat");
  await assert.rejects(db.tenantMailSettings.update({ where: { id: row.id }, data: { passwordCiphertext: "klartext-passwort" } }), /rb_mail_settings_secret_encrypted/);
  // Speichern ohne neues Passwort behält das gespeicherte
  await saveMailSettings(w.tenantId, actor, good({ newPassword: "", fromName: "Volt Gas UG Vermietung" }));
  assert.equal((await db.tenantMailSettings.findUniqueOrThrow({ where: { tenantId: w.tenantId } })).passwordCiphertext, row.passwordCiphertext);
  // Eingaben werden geprüft: kein Portscanner, keine URLs
  await assert.rejects(saveMailSettings(w.tenantId, actor, good({ port: 5432 })), DomainError);
  await assert.rejects(saveMailSettings(w.tenantId, actor, good({ host: "https://smtp.volt.test" })), DomainError);
  // ohne Schlüssel: verständlicher Fehler, nichts gespeichert
  const saved = process.env.RENTBASE_SECRET_KEY;
  delete process.env.RENTBASE_SECRET_KEY;
  try {
    const other = await tenantWithOwner("smtp-nokey");
    await assert.rejects(saveMailSettings(other.w.tenantId, other.actor, good()), (e: Error) => e instanceof DomainError && /nicht freigeschaltet/.test(e.message));
    assert.equal(await db.tenantMailSettings.count({ where: { tenantId: other.w.tenantId } }), 0);
    assert.equal((await getMailSettingsView(other.w.tenantId)).keyConfigured, false);
  } finally {
    process.env.RENTBASE_SECRET_KEY = saved;
  }
  const { text, ciphertext } = await allAuditAndLogs(w.tenantId);
  assert.ok(!text.includes(PASSWORD) && !text.includes(ciphertext) && !text.includes(saved!), "Audit ohne Passwort, Chiffrat oder Schlüssel");
});

test("Verbindungstest: echter STARTTLS-Login gegen den Server → VERIFIED; falsches Passwort → ERROR/AUTH; Änderung setzt VERIFIED zurück (auch am Code vorbei)", async () => {
  const { w, actor } = await tenantWithOwner("smtp-verify");
  await saveMailSettings(w.tenantId, actor, good({ newPassword: "falsch-und-geheim" }));
  const bad = await testMailConnection(w.tenantId, actor);
  assert.deepEqual([bad.ok, !bad.ok && bad.code], [false, "AUTH"]);
  assert.equal(bad.message, "Anmeldung abgelehnt");
  assert.equal((await getMailSettingsView(w.tenantId)).status, "ERROR");

  await saveMailSettings(w.tenantId, actor, good());
  const ok = await testMailConnection(w.tenantId, actor);
  assert.equal(ok.ok, true, ok.message);
  const verified = await getMailSettingsView(w.tenantId);
  assert.deepEqual([verified.status, verified.verifiedByName], ["VERIFIED", actor.name]);
  assert.equal(usedConfigs.at(-1)!.pass, PASSWORD, "tatsächlich das gespeicherte (entschlüsselte) Passwort verwendet");
  assert.equal(usedConfigs.at(-1)!.secure, false, "STARTTLS");

  // Absendername/Reply-To ändern: bleibt geprüft. Server/Benutzer/Adresse ändern: nicht mehr geprüft.
  await saveMailSettings(w.tenantId, actor, good({ newPassword: "", fromName: "Volt Vermietung", replyTo: "info@volt.test" }));
  assert.equal((await getMailSettingsView(w.tenantId)).status, "VERIFIED");
  await saveMailSettings(w.tenantId, actor, good({ newPassword: "", fromEmail: "andere@volt.test" }));
  const changed = await getMailSettingsView(w.tenantId);
  assert.deepEqual([changed.status, changed.verifiedAt], ["CONFIGURED", null]);
  // Direkt in der DB (an der Anwendung vorbei): Trigger setzt VERIFIED trotzdem zurück
  await saveMailSettings(w.tenantId, actor, good({ newPassword: "" }));
  assert.equal((await testMailConnection(w.tenantId, actor)).ok, true);
  await db.tenantMailSettings.update({ where: { tenantId: w.tenantId }, data: { host: "smtp2.volt.test" } });
  assert.equal((await db.tenantMailSettings.findUniqueOrThrow({ where: { tenantId: w.tenantId } })).status, "CONFIGURED");
  // VERIFIED kann nie direkt gesetzt oder beim Anlegen behauptet werden, Umschalten nur aus VERIFIED
  await assert.rejects(db.tenantMailSettings.update({ where: { tenantId: w.tenantId }, data: { mode: "TENANT_SMTP" } }), /erst nach einem erfolgreichen Test/);
  await assert.rejects(enableTenantSmtp(w.tenantId, actor), DomainError);
  const { text, ciphertext } = await allAuditAndLogs(w.tenantId);
  assert.ok(!text.includes(PASSWORD) && !text.includes("falsch-und-geheim") && !text.includes(ciphertext), "keine Zugangsdaten im Audit");
  assert.ok((await db.auditLog.count({ where: { tenantId: w.tenantId, action: "SMTP_SETTINGS_VERIFIED" } })) >= 1);
});

test("Verbindungstest: interne Adressen und nicht auflösbare Server werden abstrakt abgelehnt, TLS-Fehler als TLS", async () => {
  const { w, actor } = await tenantWithOwner("smtp-ssrf");
  setTenantSmtpHooks({ factory: (cfg) => new SmtpTransport({ ...cfg, port }) }); // echte Namensauflösung
  await saveMailSettings(w.tenantId, actor, good({ host: "127.0.0.1" }));
  const blocked = await testMailConnection(w.tenantId, actor);
  assert.deepEqual([blocked.ok, !blocked.ok && blocked.code], [false, "HOST_BLOCKED"]);
  await saveMailSettings(w.tenantId, actor, good({ host: "10.0.0.5", newPassword: "" }));
  assert.equal((await testMailConnection(w.tenantId, actor)).ok, false);
  setTenantSmtpHooks({ resolveHost: async () => "127.0.0.1", factory: (cfg) => new SmtpTransport({ ...cfg, port }) });
  await saveMailSettings(w.tenantId, actor, good({ security: "SSL_TLS", port: 465, newPassword: "" }));
  const tls = await testMailConnection(w.tenantId, actor);
  assert.deepEqual([tls.ok, !tls.ok && tls.code], [false, "TLS"], "SSL/TLS gegen STARTTLS-Server");
});

test("Testmail: nur nach Prüfung, nur an das eigene Konto, wirklich über den Vermieter-SMTP mit dessen Absender; abgelehnter Absender → ERROR", async () => {
  const { w, actor } = await tenantWithOwner("smtp-testmail");
  await saveMailSettings(w.tenantId, actor, good());
  const early = await sendSmtpTestMail(w.tenantId, actor, nonce());
  assert.deepEqual([early.ok, !early.ok && early.code], [false, "NOT_VERIFIED"]);
  assert.equal((await testMailConnection(w.tenantId, actor)).ok, true);
  const before = received.length;
  const platformBefore = platform.sent.length;
  const res = await sendSmtpTestMail(w.tenantId, actor, nonce());
  assert.equal(res.ok, true, res.message);
  const got = received.at(-1)!;
  assert.equal(received.length, before + 1);
  assert.equal(platform.sent.length, platformBefore, "nicht über RentBase");
  assert.deepEqual([got.authUser, got.mailFrom, got.mail.from?.value[0].address, got.mail.from?.value[0].name], ["vermietung@volt.test", "vermietung@volt.test", "vermietung@volt.test", "Volt Gas UG"]);
  assert.equal(got.mail.to && !Array.isArray(got.mail.to) ? got.mail.to.value[0].address : null, actor.email, "Empfänger = angemeldeter Inhaber");
  assert.equal(got.mail.subject, "RentBase – E-Mail-Versand erfolgreich eingerichtet");
  const log = await db.emailLog.findFirstOrThrow({ where: { tenantId: w.tenantId, template: "SMTP_TEST", status: "SENT" } });
  assert.deepEqual([log.category, log.channel, log.fromAddress, log.recipient], ["TENANT_BUSINESS", "TENANT_SMTP", "vermietung@volt.test", actor.email]);
  // Absenderadresse, die der Anbieter nicht erlaubt: sauberer Fehlschlag, Konfiguration nicht mehr als geprüft geführt
  await saveMailSettings(w.tenantId, actor, good({ newPassword: "", fromEmail: "chef@volt.test" }));
  assert.equal((await testMailConnection(w.tenantId, actor)).ok, true, "Anmeldung klappt – der Absender wird erst beim Senden geprüft");
  const rejected = await sendSmtpTestMail(w.tenantId, actor, nonce());
  assert.deepEqual([rejected.ok, !rejected.ok && rejected.code], [false, "SENDER_REJECTED"]);
  assert.equal((await getMailSettingsView(w.tenantId)).status, "ERROR");
  const failed = await db.emailLog.findFirstOrThrow({ where: { tenantId: w.tenantId, template: "SMTP_TEST", status: "FAILED" } });
  assert.deepEqual([failed.errorCode, failed.channel, failed.error], ["SENDER_REJECTED", "TENANT_SMTP", "Absenderadresse vom Mailserver nicht erlaubt"]);
  const { text, ciphertext } = await allAuditAndLogs(w.tenantId);
  assert.ok(!text.includes(PASSWORD) && !text.includes(ciphertext), "keine Zugangsdaten in EmailLog/Audit");
});

test("Geschäftsmail: PLATFORM = RentBase-Versand; TENANT_SMTP = Vermieter-SMTP; nicht geprüft/defekt = FAILED ohne stillen Rückfall", async () => {
  const { w, actor } = await tenantWithOwner("smtp-business");
  const msg = (): MailMessage => ({ to: "kunde@example.test", subject: "Ihre Rechnung", text: "Guten Tag", html: "<p>Guten Tag</p>", fromName: "Test", replyTo: "info@volt.test", attachments: [] });
  const p0 = platform.sent.length;
  const viaPlatform = await sendBusinessMail(w.tenantId, msg());
  assert.equal(viaPlatform.meta.channel, "PLATFORM_SMTP");
  assert.equal(platform.sent.length, p0 + 1, "ohne Konfiguration: bisheriger Versand");
  assert.match(platform.sent.at(-1)!.text, /Versendet mit RentBase/);

  await saveMailSettings(w.tenantId, actor, good({ replyTo: "antwort@volt.test" }));
  assert.equal((await sendBusinessMail(w.tenantId, msg())).meta.channel, "PLATFORM_SMTP", "gespeichert, aber nicht aktiviert: weiter Plattform");
  assert.equal((await testMailConnection(w.tenantId, actor)).ok, true);
  await enableTenantSmtp(w.tenantId, actor);
  const r0 = received.length;
  const p1 = platform.sent.length;
  const viaTenant = await sendBusinessMail(w.tenantId, msg());
  assert.deepEqual(viaTenant.meta, { channel: "TENANT_SMTP", fromAddress: "vermietung@volt.test" });
  assert.equal(received.length, r0 + 1);
  assert.equal(platform.sent.length, p1, "nichts über RentBase");
  const got = received.at(-1)!.mail;
  assert.equal(got.from?.value[0].address, "vermietung@volt.test", "Absender ist der Vermieter selbst, nicht nur Reply-To");
  assert.equal(got.replyTo?.value[0].address, "antwort@volt.test");

  // geprüft, aber Server beim Versand nicht erreichbar → Fehlerart CONNECT, letzter Fehler gemerkt, kein Rückfall
  setTenantSmtpHooks({ resolveHost: async () => "127.0.0.1", factory: (cfg) => new SmtpTransport({ ...cfg, port: 1 }) });
  await assert.rejects(sendBusinessMail(w.tenantId, msg()), (e: Error & { code?: string; publicMessage?: string }) => e.code === "CONNECT" && e.publicMessage === "Server nicht erreichbar (eigener E-Mail-Versand)");
  assert.equal((await getMailSettingsView(w.tenantId)).lastErrorCode, "CONNECT");
  assert.equal(platform.sent.length, p1, "kein stiller Rückfall");
  setTenantSmtpHooks({ resolveHost: async () => "127.0.0.1", factory: (cfg) => new SmtpTransport({ ...cfg, port }) });
  // Konfiguration geändert → nicht mehr geprüft → Versand schlägt fehl, kein Rückfall auf RentBase
  await saveMailSettings(w.tenantId, actor, good({ newPassword: "anderes-passwort" }));
  await assert.rejects(sendBusinessMail(w.tenantId, msg()), (e: Error & { code?: string }) => e.code === "NOT_VERIFIED");
  assert.equal(platform.sent.length, p1, "kein stiller Rückfall");
  // Deaktivieren: wieder RentBase
  await disableTenantSmtp(w.tenantId, actor);
  assert.equal((await sendBusinessMail(w.tenantId, msg())).meta.channel, "PLATFORM_SMTP");
  assert.deepEqual((await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["SMTP_MODE_CHANGED", "SMTP_SETTINGS_DISABLED"] } }, orderBy: { createdAt: "asc" } })).map((a) => a.action), ["SMTP_MODE_CHANGED", "SMTP_SETTINGS_DISABLED"]);
});

test("Systemmails (Einladung, Passwort-Reset) laufen immer über den Plattform-SMTP – auch bei fehlendem, defektem oder aktivem Vermieter-SMTP", async () => {
  const { w, owner, actor } = await tenantWithOwner("smtp-system");
  const check = async (label: string) => {
    const r0 = received.length;
    const p0 = platform.sent.length;
    await createInvitation(w.tenantId, actor, { email: `neu-${label}-${Date.now()}@example.test`, role: "DISPO", baseUrl: "http://localhost:3000" });
    await requestPasswordReset(owner.email, "http://localhost:3000");
    assert.equal(platform.sent.length, p0 + 2, `${label}: Einladung und Reset über RentBase`);
    assert.equal(received.length, r0, `${label}: nie über den Vermieter-SMTP`);
    const logs = await db.emailLog.findMany({ where: { tenantId: w.tenantId, template: { in: ["USER_INVITATION", "PASSWORD_RESET"] } }, orderBy: { createdAt: "desc" }, take: 2 });
    for (const l of logs) assert.deepEqual([l.status, l.category, l.channel], ["SENT", "PLATFORM_SYSTEM", "PLATFORM_SMTP"], `${label}: ${l.template}`);
  };
  await check("ohne");
  await saveMailSettings(w.tenantId, actor, good({ newPassword: "falsch" }));
  await testMailConnection(w.tenantId, actor);
  await check("defekt");
  await saveMailSettings(w.tenantId, actor, good());
  await testMailConnection(w.tenantId, actor);
  await enableTenantSmtp(w.tenantId, actor);
  await check("aktiv");
  await disableTenantSmtp(w.tenantId, actor);
  await check("deaktiviert");
});

test("Mandanten-Isolation: A sieht/ändert/nutzt nie SMTP-Daten von B; kopiertes Chiffrat ist bei A unbrauchbar", async () => {
  const a = await tenantWithOwner("smtp-iso-a");
  const b = await tenantWithOwner("smtp-iso-b");
  await saveMailSettings(b.w.tenantId, b.actor, good({ host: "smtp.b-geheim.test" }));
  assert.equal((await testMailConnection(b.w.tenantId, b.actor)).ok, true);
  const viewA = await getMailSettingsView(a.w.tenantId);
  assert.deepEqual([viewA.status, viewA.host, viewA.username, viewA.hasPassword], ["NOT_CONFIGURED", null, null, false]);
  assert.ok(!JSON.stringify(viewA).includes("b-geheim"));
  await assert.rejects(testMailConnection(a.w.tenantId, a.actor), DomainError, "A hat keine Konfiguration – nie die von B");
  await assert.rejects(sendSmtpTestMail(a.w.tenantId, a.actor, nonce()), DomainError);
  await saveMailSettings(a.w.tenantId, a.actor, good({ host: "smtp.a.test", username: "a@volt.test" }));
  const bRow = await db.tenantMailSettings.findUniqueOrThrow({ where: { tenantId: b.w.tenantId } });
  assert.deepEqual([bRow.host, bRow.status], ["smtp.b-geheim.test", "VERIFIED"], "B unverändert");
  // Chiffrat von B in A kopiert: wegen Mandantenbindung nicht entschlüsselbar
  await db.tenantMailSettings.update({ where: { tenantId: a.w.tenantId }, data: { passwordCiphertext: bRow.passwordCiphertext } });
  const stolen = await testMailConnection(a.w.tenantId, a.actor);
  assert.deepEqual([stolen.ok, !stolen.ok && stolen.code], [false, "KEY_MISSING"]);
  // Geschäftsmail von A nutzt nie die Konfiguration von B
  const before = usedConfigs.length;
  await sendBusinessMail(a.w.tenantId, { to: "k@example.test", subject: "x", text: "x", attachments: [] });
  assert.ok(usedConfigs.slice(before).every((c) => c.host !== "smtp.b-geheim.test"));
});

test("Rollen/Supportmodus/Isolation im Code: nur Inhaber ändert, Mandant nur aus der Sitzung, kein Passwort an die Oberfläche", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const actions = read("src/app/(app)/einstellungen/e-mail/actions.ts");
  const exported = [...actions.matchAll(/export async function (\w+)[\s\S]*?\n}/g)];
  assert.equal(exported.length, 5);
  for (const m of exported) {
    assert.match(m[0], /requireRole\("OWNER"\)/, `${m[1]}: nur Inhaber (im Supportmodus lehnt requireRole ab)`);
    assert.match(m[0], /tenant\.id/, `${m[1]}: Mandant aus der Sitzung`);
    assert.ok(!/fd\.get\("tenant/.test(m[0]), `${m[1]}: keine Mandanten-ID aus dem Formular`);
  }
  assert.match(actions, /email: user\.email/, "Testmail-Ziel ist das eigene Konto");
  const page = read("src/app/(app)/einstellungen/e-mail/page.tsx");
  assert.match(page, /user\.role === "YARD" \|\| supportSession/, "Hofmitarbeiter und Supportmodus sehen die Seite nicht");
  for (const f of ["src/app/(app)/einstellungen/e-mail/page.tsx", "src/app/(app)/einstellungen/e-mail/forms.tsx", "src/app/(app)/einstellungen/page.tsx"]) {
    assert.ok(!/passwordCiphertext|decryptSecret/.test(read(f)), `${f}: kein Chiffrat, keine Entschlüsselung`);
  }
  const route = read("src/app/api/branding/logo/route.ts");
  assert.match(route, /export async function POST[\s\S]*?apiSession\("write"\)[\s\S]*?role !== "OWNER"/);
  assert.match(route, /export async function DELETE[\s\S]*?apiSession\("write"\)[\s\S]*?role !== "OWNER"/);
  assert.ok(!/storageKey|tenantId/.test(route.replace(/session\.tenant\.id/g, "")), "keine fremden Schlüssel/Mandanten-IDs angenommen");
  // es gibt keine Funktion, die ein gespeichertes SMTP-Passwort zurückgibt
  const lib = read("src/lib/tenant-mail.ts");
  assert.ok(!/export (async )?function \w*(reveal|Password|Secret)\w*\(/i.test(lib));
});

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

async function sampleLogo(format: "png" | "jpeg" = "png", withExif = false) {
  const sharp = (await import("sharp")).default;
  let img = sharp({ create: { width: 600, height: 200, channels: 3, background: { r: 22, g: 50, b: 92 } } });
  if (withExif) img = img.withExif({ IFD0: { Copyright: "GPS-Geheimnis", Artist: "Geheim" } });
  return new Uint8Array(format === "png" ? await img.png().toBuffer() : await img.jpeg().toBuffer());
}

test("Logo: nur Rasterbilder, Metadaten entfernt, privat unter dem eigenen Mandanten, fremde Schlüssel werden nicht gelesen", async () => {
  await assert.rejects(normalizeLogo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), DomainError);
  await assert.rejects(normalizeLogo(new TextEncoder().encode("%PDF-1.7")), DomainError);
  await assert.rejects(normalizeLogo(new Uint8Array(3 * 1024 * 1024).fill(0xff)), DomainError);
  const sharp = (await import("sharp")).default;
  const withExif = await sampleLogo("jpeg", true);
  assert.ok((await sharp(withExif).metadata()).exif, "Vorlage hat EXIF");
  const clean = await normalizeLogo(withExif);
  const meta = await sharp(clean.png).metadata();
  assert.deepEqual([meta.format, meta.exif, clean.png.includes(Buffer.from("GPS-Geheimnis"))], ["png", undefined, false]);

  const a = await tenantWithOwner("logo-a");
  const b = await tenantWithOwner("logo-b");
  const refA = await uploadTenantLogo(a.w.tenantId, a.actor, await sampleLogo());
  assert.ok(refA.key.startsWith(`t/${a.w.tenantId}/branding/`));
  assert.ok(await currentLogo(a.w.tenantId));
  assert.equal(await currentLogo(b.w.tenantId), null, "B hat kein Logo");
  assert.equal(await loadLogo(b.w.tenantId, refA), null, "Schlüssel von A ist für B nicht lesbar");
  assert.throws(() => assertKeyBelongsToTenant(refA.key, b.w.tenantId));
  assert.equal(await loadLogo(a.w.tenantId, { key: refA.key, checksum: "0".repeat(64) }), null, "falsche Prüfsumme: nicht verwendet");
  // Ersetzen: neue Datei, alte bleibt (Snapshots); Entfernen: Datei bleibt, Mandant ohne Logo
  const refA2 = await uploadTenantLogo(a.w.tenantId, a.actor, await sampleLogo("jpeg"));
  assert.notEqual(refA2.key, refA.key);
  assert.ok(await getStorage().get(refA.key), "alte Logo-Datei bleibt für eingefrorene Dokumente");
  await removeTenantLogo(a.w.tenantId, a.actor);
  assert.equal(await currentLogo(a.w.tenantId), null);
  assert.ok(await loadLogo(a.w.tenantId, refA2), "entferntes Logo bleibt für bestehende Snapshots lesbar");
  assert.deepEqual((await db.auditLog.findMany({ where: { tenantId: a.w.tenantId, action: { in: ["TENANT_LOGO_UPDATED", "TENANT_LOGO_REMOVED"] } }, orderBy: { createdAt: "asc" } })).map((x) => x.action), ["TENANT_LOGO_UPDATED", "TENANT_LOGO_UPDATED", "TENANT_LOGO_REMOVED"]);
});

test("PDF/Mail-Branding: bestehende Dokumente bleiben unverändert; neue Verträge frieren das Logo ein; Unterlagen-Mail über Vermieter-SMTP mit Logo", async () => {
  // Miete 1 abgeschlossen OHNE Logo, Dokument archiviert
  const old = await returnedWorld("brand-old");
  tenants.push(old.tenantId);
  const oldDoc = (await ensureContractDocument(old.tenantId, old.contractId, null)).document;
  const oldRow = await db.rentalContract.findUniqueOrThrow({ where: { id: old.contractId } });
  // jetzt Logo hochladen
  const owner = await db.user.findUniqueOrThrow({ where: { id: old.userId } });
  const ref = await uploadTenantLogo(old.tenantId, { id: owner.id, name: owner.name }, await sampleLogo());
  const again = await ensureContractDocument(old.tenantId, old.contractId, null);
  assert.deepEqual([again.created, again.document.id, again.document.checksum], [false, oldDoc.id, oldDoc.checksum], "kein neues PDF, Archiv unverändert");
  assert.deepEqual((await db.rentalContract.findUniqueOrThrow({ where: { id: old.contractId } })).landlordSnapshot, oldRow.landlordSnapshot, "Snapshot unverändert");
  const oldData = await loadContractDocumentData(old.tenantId, old.contractId);
  assert.equal(oldData.doc.landlord.logo, null, "alter Vertrag bleibt ohne Logo, auch bei Neuerzeugung");

  // Miete 2 im selben Mandanten, abgeschlossen NACH dem Logo: Snapshot enthält den Logo-Verweis
  const neu = await returnedWorld("brand-new", { within: old });
  const newData = await loadContractDocumentData(old.tenantId, neu.contractId);
  assert.deepEqual(newData.doc.landlord.logo, ref);
  const withLogo = await renderContractPdf(newData.doc, newData.signatureImages, await loadLogo(old.tenantId, newData.doc.landlord.logo ?? null));
  const without = await renderContractPdf(oldData.doc, oldData.signatureImages, await loadLogo(old.tenantId, oldData.doc.landlord.logo ?? null));
  assert.equal(withLogo.trace.images.filter((i) => i.kind === "logo").length, 1);
  assert.equal(without.trace.images.filter((i) => i.kind === "logo").length, 0);
  assert.ok(withLogo.trace.boxes.every((b) => !b.overflow) && without.trace.boxes.every((b) => !b.overflow), "Layout ohne Überlauf");
  // späteres Entfernen/Ersetzen ändert das eingefrorene Logo des neuen Vertrags nicht
  await uploadTenantLogo(old.tenantId, { id: owner.id, name: owner.name }, await sampleLogo("jpeg"));
  assert.deepEqual((await loadContractDocumentData(old.tenantId, neu.contractId)).doc.landlord.logo, ref);
  assert.deepEqual(logoRefOf(await db.tenant.findUniqueOrThrow({ where: { id: old.tenantId } }))!.key !== ref.key, true);

  // Unterlagen-Mail über den eigenen SMTP: Absender Vermieter, Logo eingebettet, PDFs angehängt, Kanal protokolliert
  await ensureContractDocument(old.tenantId, neu.contractId, null);
  await ensurePickupDocument(old.tenantId, neu.pickupId, null);
  const actor = { id: owner.id, name: owner.name };
  await saveMailSettings(old.tenantId, actor, good());
  assert.equal((await testMailConnection(old.tenantId, actor)).ok, true);
  await enableTenantSmtp(old.tenantId, actor);
  const r0 = received.length;
  const res = await sendHandoverDocuments(old.tenantId, neu.pickupId, { trigger: "MANUAL", nonce: nonce() });
  assert.equal(res.status, "SENT", res.log.error ?? "");
  assert.equal(received.length, r0 + 1);
  const mail = received.at(-1)!.mail;
  assert.equal(mail.from?.value[0].address, "vermietung@volt.test");
  const logoPart = mail.attachments.find((a) => a.cid === "vermieter-logo@rentbase");
  assert.ok(logoPart && mail.html && String(mail.html).includes("cid:vermieter-logo@rentbase"), "Logo im HTML eingebettet");
  assert.equal(mail.attachments.filter((a) => a.contentType === "application/pdf").length, 2, "Mietvertrag und Übergabeprotokoll");
  assert.match(String(mail.text), /Versendet mit RentBase/);
  assert.deepEqual([res.log.channel, res.log.fromAddress, res.log.category], ["TENANT_SMTP", "vermietung@volt.test", "TENANT_BUSINESS"]);

  // Defekter Vermieter-SMTP: Versand FAILED, Dokumente und Übergabe bleiben unverändert, erneutes Senden möglich
  await db.tenantMailSettings.update({ where: { tenantId: old.tenantId }, data: { status: "ERROR", lastErrorCode: "AUTH" } });
  const docsBefore = await db.document.findMany({ where: { tenantId: old.tenantId }, select: { id: true, checksum: true }, orderBy: { id: "asc" } });
  const failed = await sendHandoverDocuments(old.tenantId, neu.pickupId, { trigger: "MANUAL", nonce: nonce() });
  assert.equal(failed.status, "FAILED");
  assert.deepEqual([failed.log.errorCode, failed.log.channel], ["NOT_VERIFIED", "TENANT_SMTP"]);
  assert.match(failed.log.error ?? "", /eigener E-Mail-Versand/);
  assert.deepEqual(await db.document.findMany({ where: { tenantId: old.tenantId }, select: { id: true, checksum: true }, orderBy: { id: "asc" } }), docsBefore, "Dokumente unberührt");
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: neu.pickupId } })).status, "FINALIZED");
  assert.ok(!JSON.stringify(await db.emailLog.findMany({ where: { tenantId: old.tenantId } })).includes(PASSWORD));
  assert.equal(sha256(Buffer.from("x")).length, 64);
});

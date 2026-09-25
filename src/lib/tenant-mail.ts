// Mandanteneigener E-Mail-Versand (Befehl 20.5).
//
// Zwei getrennte Wege:
// - PLATFORM_SYSTEM (Einladungen, Passwort-Reset, interne Erinnerungen): immer zentraler RentBase-SMTP,
//   sendPlatformSystemMail(). Hängt nie von der Konfiguration eines Vermieters ab.
// - TENANT_BUSINESS (Unterlagen, Rechnungen, Belege, Behördenantworten, Testmail): sendBusinessMail().
//   mode PLATFORM (Standard, auch ohne Zeile) = wie bisher über RentBase, Absendername = Vermieter, Antworten an den
//   Vermieter. mode TENANT_SMTP = tatsächlich über den SMTP-Server des Vermieters mit dessen Absenderadresse – aber nur,
//   solange die Konfiguration VERIFIED ist. Sonst schlägt der Versand sichtbar fehl (NOT_VERIFIED): kein stiller
//   Rückfall auf eine andere Absenderidentität.
//
// Geheimnisse: Das SMTP-Passwort wird nur verschlüsselt gespeichert (lib/secret-box.ts), nur für einen einzelnen
// Verbindungsaufbau im Speicher entschlüsselt und nie zurückgegeben – weder an Oberfläche, Protokoll, Audit noch Fehler.
// Verbindungen gehen nur an öffentliche Adressen auf üblichen SMTP-Ports (kein Zugriff auf interne Dienste des Servers).

import { lookup } from "node:dns/promises";
import net from "node:net";
import type { TenantMailSettings } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { claimEmail, markEmailFailed, markEmailSent, type EmailDeliveryMeta } from "@/lib/email-log";
import { DomainError } from "@/lib/integrity";
import {
  classifySmtpError, getPlatformTransport, isValidEmail, MailDeliveryError, platformFromAddress, safeMailError, SmtpTransport,
  type MailMessage, type MailTransport, type SmtpConfig,
} from "@/lib/mail";
import { consume } from "@/lib/rate-limit";
import { decryptSecret, encryptSecret, SecretDecryptError, SecretKeyMissingError, secretKeyStatus } from "@/lib/secret-box";
import { currentLogo } from "@/lib/branding";
import {
  SMTP_ALLOWED_PORTS, SMTP_ERROR_CODES, SMTP_SECURITY,
  type SmtpErrorCode, type SmtpMode, type SmtpSecurity, type SmtpStatus,
} from "@/lib/constants";
import type { StorageDriver } from "@/lib/storage";

const SECRET_PURPOSE = "smtp-password";
export const SMTP_TEST_TEMPLATE = "SMTP_TEST";

// ---------------------------------------------------------------------------
// Test-Haken (nur Tests): Verbindung ohne Netzwerk, Namensauflösung ohne DNS
// ---------------------------------------------------------------------------

export interface TenantSmtpTransport extends MailTransport {
  verify(): Promise<void>;
}
type Hooks = { factory?: (cfg: SmtpConfig) => TenantSmtpTransport; resolveHost?: (host: string) => Promise<string> };
let hooks: Hooks = {};
export function setTenantSmtpHooks(h: Hooks | null) {
  hooks = h ?? {};
}

// ---------------------------------------------------------------------------
// Ansicht (ohne Geheimnis)
// ---------------------------------------------------------------------------

/** Alles, was die Oberfläche über den Versand wissen darf. Das Passwort selbst ist nie enthalten, nur „gespeichert ja/nein“. */
export type MailSettingsView = {
  mode: SmtpMode;
  status: SmtpStatus;
  host: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  username: string | null;
  hasPassword: boolean;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  verifiedAt: Date | null;
  verifiedByName: string | null;
  lastErrorCode: SmtpErrorCode | null;
  lastErrorAt: Date | null;
  keyConfigured: boolean;
};

export async function getMailSettingsView(tenantId: string): Promise<MailSettingsView> {
  const s = await db.tenantMailSettings.findUnique({ where: { tenantId } });
  const keyConfigured = secretKeyStatus().configured;
  if (!s) return { mode: "PLATFORM", status: "NOT_CONFIGURED", host: null, port: null, security: null, username: null, hasPassword: false, fromName: null, fromEmail: null, replyTo: null, verifiedAt: null, verifiedByName: null, lastErrorCode: null, lastErrorAt: null, keyConfigured };
  return {
    mode: s.mode as SmtpMode,
    status: s.status as SmtpStatus,
    host: s.host,
    port: s.port,
    security: s.security as SmtpSecurity | null,
    username: s.username,
    hasPassword: Boolean(s.passwordCiphertext),
    fromName: s.fromName,
    fromEmail: s.fromEmail,
    replyTo: s.replyTo,
    verifiedAt: s.verifiedAt,
    verifiedByName: s.verifiedByName,
    lastErrorCode: (s.lastErrorCode as SmtpErrorCode | null) ?? null,
    lastErrorAt: s.lastErrorAt,
    keyConfigured,
  };
}

/** Nur der Zustand (für Dashboard/Onboarding/andere Rollen). */
export async function mailStatusOf(tenantId: string): Promise<{ mode: SmtpMode; status: SmtpStatus }> {
  const s = await db.tenantMailSettings.findUnique({ where: { tenantId }, select: { mode: true, status: true } });
  return { mode: (s?.mode as SmtpMode) ?? "PLATFORM", status: (s?.status as SmtpStatus) ?? "NOT_CONFIGURED" };
}

// ---------------------------------------------------------------------------
// Speichern
// ---------------------------------------------------------------------------

export type SaveMailSettingsInput = {
  host: string;
  port: number;
  security: string;
  username: string;
  /** leer/undefiniert = gespeichertes Passwort unverändert lassen */
  newPassword?: string | null;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
};

const HOSTNAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

function validate(input: SaveMailSettingsInput) {
  const host = input.host.trim().toLowerCase();
  if (!HOSTNAME.test(host) && !net.isIP(host)) throw new DomainError("Bitte den SMTP-Server als Hostnamen angeben, z. B. smtp.ihre-firma.de (ohne https:// und ohne Port).");
  const port = Number(input.port);
  if (!(SMTP_ALLOWED_PORTS as readonly number[]).includes(port)) throw new DomainError(`Bitte einen üblichen SMTP-Port wählen (${SMTP_ALLOWED_PORTS.join(", ")}).`);
  if (!(input.security in SMTP_SECURITY)) throw new DomainError("Bitte die Verschlüsselung wählen.");
  const username = input.username.trim();
  if (!username || username.length > 320) throw new DomainError("Bitte den SMTP-Benutzernamen angeben.");
  const fromName = input.fromName.replace(/[\r\n"<>]/g, " ").trim();
  if (!fromName || fromName.length > 120) throw new DomainError("Bitte einen Absendernamen angeben (höchstens 120 Zeichen).");
  const fromEmail = input.fromEmail.trim().toLowerCase();
  if (!isValidEmail(fromEmail)) throw new DomainError("Bitte eine gültige Absenderadresse angeben.");
  const replyTo = input.replyTo?.trim().toLowerCase() || null;
  if (replyTo && !isValidEmail(replyTo)) throw new DomainError("Die Antwortadresse (Reply-To) ist ungültig.");
  const newPassword = input.newPassword ?? "";
  if (newPassword.length > 512) throw new DomainError("Das Passwort ist zu lang.");
  return { host, port, security: input.security as SmtpSecurity, username, fromName, fromEmail, replyTo, newPassword: newPassword.length > 0 ? newPassword : null };
}

const CONNECTION_FIELDS = ["host", "port", "security", "username", "fromEmail"] as const;

/** Speichert die Verbindungsdaten. Jede Änderung an Verbindung oder Absenderadresse verlangt einen neuen Test. */
export async function saveMailSettings(tenantId: string, actor: Actor, input: SaveMailSettingsInput): Promise<MailSettingsView> {
  const d = validate(input);
  let ciphertext: string | null = null;
  if (d.newPassword) {
    try {
      ciphertext = encryptSecret(d.newPassword, { purpose: SECRET_PURPOSE, tenantId });
    } catch (e) {
      if (e instanceof SecretKeyMissingError) throw new DomainError("Der eigene E-Mail-Versand ist auf diesem Server noch nicht freigeschaltet (Verschlüsselung für Zugangsdaten fehlt). Bitte wenden Sie sich an RentBase.");
      throw e;
    }
  }
  await db.$transaction(async (tx) => {
    const before = await tx.tenantMailSettings.findUnique({ where: { tenantId } });
    if (!before?.passwordCiphertext && !ciphertext) throw new DomainError("Bitte das SMTP-Passwort bzw. App-Passwort angeben.");
    const changed = [
      ...CONNECTION_FIELDS.filter((f) => String(before?.[f] ?? "") !== String(d[f] ?? "")),
      ...(ciphertext ? ["password"] : []),
      ...(before?.fromName !== d.fromName ? ["fromName"] : []),
      ...((before?.replyTo ?? null) !== d.replyTo ? ["replyTo"] : []),
    ];
    const connectionChanged = changed.some((f) => f !== "fromName" && f !== "replyTo");
    const data = {
      host: d.host, port: d.port, security: d.security, username: d.username, fromName: d.fromName, fromEmail: d.fromEmail, replyTo: d.replyTo,
      ...(ciphertext ? { passwordCiphertext: ciphertext } : {}),
      updatedById: actor.id, updatedByName: actor.name,
    };
    if (!before) {
      await tx.tenantMailSettings.create({ data: { tenantId, ...data, passwordCiphertext: ciphertext!, status: "CONFIGURED" } });
      await recordAudit(tx, tenantId, actor, { action: "SMTP_SETTINGS_CREATED", details: { host: d.host, port: d.port, security: d.security, fromEmail: d.fromEmail } });
      return;
    }
    if (changed.length === 0) return;
    // Der DB-Trigger setzt VERIFIED bei Verbindungsänderungen ohnehin zurück; hier zusätzlich ausdrücklich.
    await tx.tenantMailSettings.update({ where: { tenantId }, data: { ...data, ...(connectionChanged ? { status: "CONFIGURED", lastErrorCode: null, lastErrorAt: null } : {}) } });
    await recordAudit(tx, tenantId, actor, { action: "SMTP_SETTINGS_UPDATED", details: { changed: changed.join(","), host: d.host, port: d.port, security: d.security, fromEmail: d.fromEmail, passwordChanged: Boolean(ciphertext), needsNewTest: connectionChanged } });
  });
  return getMailSettingsView(tenantId);
}

// ---------------------------------------------------------------------------
// Verbindung aufbauen (nur serverseitig)
// ---------------------------------------------------------------------------

function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isBlockedAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

/** Löst den Hostnamen auf und akzeptiert nur öffentliche Adressen. Liefert die zu verwendende IP. */
async function resolvePublicHost(host: string): Promise<string> {
  if (hooks.resolveHost) return hooks.resolveHost(host);
  const allowPrivate = process.env.NODE_ENV !== "production" && process.env.SMTP_ALLOW_PRIVATE_HOSTS === "true";
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch (e) {
      throw Object.assign(new Error("dns"), { code: (e as { code?: string }).code === "ENOTFOUND" ? "ENOTFOUND" : "EDNS" });
    }
  }
  if (addresses.length === 0) throw Object.assign(new Error("dns"), { code: "ENOTFOUND" });
  if (!allowPrivate && addresses.some(isBlockedAddress)) throw new MailDeliveryError("HOST_BLOCKED", SMTP_ERROR_CODES.HOST_BLOCKED, { channel: "TENANT_SMTP", fromAddress: null });
  return addresses[0];
}

/** Baut die Verbindung für genau einen Vorgang. Wirft MailDeliveryError mit abstrakter Fehlerart. */
async function tenantTransport(s: TenantMailSettings): Promise<TenantSmtpTransport> {
  const fail = (code: SmtpErrorCode) => new MailDeliveryError(code, SMTP_ERROR_CODES[code], { channel: "TENANT_SMTP", fromAddress: s.fromEmail });
  if (!s.host || !s.port || !s.security || !s.username || !s.passwordCiphertext || !s.fromEmail) throw fail("INCOMPLETE");
  let pass: string;
  try {
    pass = decryptSecret(s.passwordCiphertext, { purpose: SECRET_PURPOSE, tenantId: s.tenantId });
  } catch (e) {
    if (e instanceof SecretKeyMissingError || e instanceof SecretDecryptError) throw fail("KEY_MISSING");
    throw e;
  }
  let connectHost: string;
  try {
    connectHost = await resolvePublicHost(s.host);
  } catch (e) {
    if (e instanceof MailDeliveryError) throw fail(e.code);
    throw fail(classifySmtpError(e));
  }
  const cfg: SmtpConfig = { host: s.host, connectHost, port: s.port, secure: s.security === "SSL_TLS", user: s.username, pass, fromEmail: s.fromEmail, fixedFromName: s.fromName };
  return hooks.factory ? hooks.factory(cfg) : new SmtpTransport(cfg);
}

async function loadSettings(tenantId: string): Promise<TenantMailSettings> {
  const s = await db.tenantMailSettings.findUnique({ where: { tenantId } });
  if (!s) throw new DomainError("Es ist noch kein eigener E-Mail-Versand eingerichtet.");
  return s;
}

/** Test-Ergebnis setzen – nur, wenn die Einstellungen seit dem Lesen unverändert sind (nie „geprüft“ für andere Daten). */
async function recordTestResult(s: TenantMailSettings, actor: Actor, ok: boolean, code: SmtpErrorCode | null): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const res = await tx.tenantMailSettings.updateMany({
      where: { id: s.id, tenantId: s.tenantId, updatedAt: s.updatedAt },
      data: ok ? { status: "VERIFIED", verifiedAt: new Date(), verifiedById: actor.id, verifiedByName: actor.name, lastErrorCode: null, lastErrorAt: null } : { status: "ERROR", lastErrorCode: code, lastErrorAt: new Date() },
    });
    if (res.count === 0) return false;
    await recordAudit(tx, s.tenantId, actor, ok ? { action: "SMTP_SETTINGS_VERIFIED", details: { host: s.host, port: s.port, security: s.security, fromEmail: s.fromEmail } } : { action: "SMTP_TEST_FAILED", details: { errorCode: code, host: s.host, port: s.port } });
    return true;
  });
}

const TEST_LIMIT = { limit: 10, windowMs: 10 * 60_000 };

export type SmtpTestResult = { ok: true; message: string } | { ok: false; code: SmtpErrorCode; message: string };

/** „Verbindung testen“: DNS, Verbindung, TLS/STARTTLS, Anmeldung. Es wird nichts versendet. */
export async function testMailConnection(tenantId: string, actor: Actor): Promise<SmtpTestResult> {
  if (!consume(`smtp-test:${tenantId}`, TEST_LIMIT).allowed) return { ok: false, code: "UNKNOWN", message: "Zu viele Tests in kurzer Zeit. Bitte in einigen Minuten erneut versuchen." };
  const s = await loadSettings(tenantId);
  let code: SmtpErrorCode | null = null;
  try {
    const t = await tenantTransport(s);
    await t.verify();
  } catch (e) {
    code = e instanceof MailDeliveryError ? e.code : classifySmtpError(e);
  }
  const recorded = await recordTestResult(s, actor, code === null, code);
  if (!recorded) return { ok: false, code: "UNKNOWN", message: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte erneut testen." };
  return code === null ? { ok: true, message: "Verbindung erfolgreich geprüft." } : { ok: false, code, message: SMTP_ERROR_CODES[code] };
}

/** Echte Testmail über den eigenen SMTP an das eigene Postfach des angemeldeten Benutzers (kein offenes Relay). */
export async function sendSmtpTestMail(tenantId: string, actor: Actor & { email: string }, nonce: string, opts: { storage?: StorageDriver } = {}): Promise<SmtpTestResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  if (!consume(`smtp-test:${tenantId}`, TEST_LIMIT).allowed) return { ok: false, code: "UNKNOWN", message: "Zu viele Tests in kurzer Zeit. Bitte in einigen Minuten erneut versuchen." };
  const s = await loadSettings(tenantId);
  if (s.status !== "VERIFIED") return { ok: false, code: "NOT_VERIFIED", message: "Bitte zuerst „Verbindung testen“ erfolgreich ausführen." };
  if (!isValidEmail(actor.email)) throw new DomainError("Für Ihr Benutzerkonto ist keine gültige E-Mail-Adresse hinterlegt.");
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  const subject = "RentBase – E-Mail-Versand erfolgreich eingerichtet";
  const text = [`Guten Tag ${actor.name},`, "", `diese Testmail wurde über die E-Mail-Konfiguration von ${tenant.name} versendet.`, `Absender: ${s.fromName ?? tenant.name} <${s.fromEmail}>`, "", "Sie müssen nichts weiter tun."].join("\n");
  const { log, created } = await claimEmail({ tenantId, recipient: actor.email, subject, template: SMTP_TEST_TEMPLATE, trigger: "MANUAL", createdById: actor.id, idempotencyKey: `${SMTP_TEST_TEMPLATE}:${nonce}` });
  if (!created) return log.status === "SENT" ? { ok: true, message: "Diese Testmail wurde bereits versendet." } : { ok: false, code: "UNKNOWN", message: "Dieser Test wurde bereits ausgeführt. Bitte die Seite neu laden." };
  const meta: EmailDeliveryMeta = { channel: "TENANT_SMTP", fromAddress: s.fromEmail };
  try {
    const t = await tenantTransport(s);
    const message = await brandBusinessMessage(tenantId, { to: actor.email, subject, text, html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`, attachments: [] }, opts.storage);
    const res = await t.send(message);
    await markEmailSent(tenantId, log.id, res.messageId, meta);
    await db.$transaction((tx) => recordAudit(tx, tenantId, actor, { action: "SMTP_TEST_MAIL_SENT", details: { emailLogId: log.id, toOwnAccount: true } }));
    return { ok: true, message: `Testmail an ${actor.email} versendet.` };
  } catch (e) {
    const code = e instanceof MailDeliveryError ? e.code : classifySmtpError(e);
    await markEmailFailed(tenantId, log.id, SMTP_ERROR_CODES[code], { ...meta, errorCode: code });
    // Anmeldung/Absender/Verbindung abgelehnt: Konfiguration taugt nicht – nicht weiter als geprüft führen
    if (["AUTH", "SENDER_REJECTED", "TLS", "CONNECT", "DNS", "HOST_BLOCKED", "KEY_MISSING"].includes(code)) await recordTestResult(s, actor, false, code);
    return { ok: false, code, message: SMTP_ERROR_CODES[code] };
  }
}

/** Eigenen Versand aktivieren. Nur aus VERIFIED heraus (zusätzlich durch DB-Trigger erzwungen). */
export async function enableTenantSmtp(tenantId: string, actor: Actor): Promise<void> {
  await db.$transaction(async (tx) => {
    const s = await tx.tenantMailSettings.findUnique({ where: { tenantId } });
    if (!s || s.status !== "VERIFIED") throw new DomainError("Der eigene E-Mail-Versand kann erst nach einem erfolgreichen Verbindungstest aktiviert werden.");
    if (s.mode === "TENANT_SMTP") return;
    await tx.tenantMailSettings.update({ where: { tenantId }, data: { mode: "TENANT_SMTP", updatedById: actor.id, updatedByName: actor.name } });
    await recordAudit(tx, tenantId, actor, { action: "SMTP_MODE_CHANGED", details: { from: s.mode, to: "TENANT_SMTP", fromEmail: s.fromEmail } });
  });
}

/** Eigenen Versand deaktivieren: geschäftliche Mails laufen wieder über RentBase. Zugangsdaten bleiben (verschlüsselt) gespeichert. */
export async function disableTenantSmtp(tenantId: string, actor: Actor): Promise<void> {
  await db.$transaction(async (tx) => {
    const s = await tx.tenantMailSettings.findUnique({ where: { tenantId } });
    if (!s || s.mode === "PLATFORM") return;
    await tx.tenantMailSettings.update({ where: { tenantId }, data: { mode: "PLATFORM", updatedById: actor.id, updatedByName: actor.name } });
    await recordAudit(tx, tenantId, actor, { action: "SMTP_SETTINGS_DISABLED", details: { from: "TENANT_SMTP", to: "PLATFORM" } });
  });
}

// ---------------------------------------------------------------------------
// Versand
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const LOGO_CID = "vermieter-logo@rentbase";

/**
 * Branding geschäftlicher Mails: Logo des Vermieters (falls vorhanden) oben, dezenter technischer Hinweis unten.
 * Der Hinweis stellt klar, dass RentBase nur das Werkzeug ist – Vertragspartner bleibt der Vermieter.
 */
export async function brandBusinessMessage(tenantId: string, message: MailMessage, storage?: StorageDriver): Promise<MailMessage> {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  const logo = await currentLogo(tenantId, storage);
  const footerText = `Diese Nachricht stammt von ${tenant.name}. Versendet mit RentBase.`;
  const html = message.html
    ? `${logo ? `<div style="margin:0 0 16px"><img src="cid:${LOGO_CID}" alt="${escapeHtml(tenant.name)}" style="max-height:56px;max-width:220px"></div>` : ""}${message.html}<p style="margin-top:24px;color:#98a2b3;font-family:Arial,Helvetica,sans-serif;font-size:11px">${escapeHtml(footerText)}</p>`
    : undefined;
  return {
    ...message,
    text: `${message.text}\n\n--\n${footerText}`,
    html,
    attachments: [...message.attachments, ...(logo && html ? [{ filename: "logo.png", content: logo, contentType: "image/png", cid: LOGO_CID }] : [])],
  };
}

export type BusinessSendOptions = {
  /** Ersatz für den Plattform-Versand (Tests). Bei eigenem SMTP wird er nicht verwendet. */
  transport?: MailTransport;
  storage?: StorageDriver;
};

/**
 * Versendet eine geschäftliche Mail über den richtigen Kanal. Rückgabe enthält den tatsächlichen Versandweg fürs
 * Protokoll. Fehler kommen als MailDeliveryError (abstrakte Fehlerart, Kanal, Absender) – nie mit Rohmeldung.
 */
export async function sendBusinessMail(tenantId: string, message: MailMessage, opts: BusinessSendOptions = {}): Promise<{ messageId: string | null; meta: EmailDeliveryMeta }> {
  const s = await db.tenantMailSettings.findUnique({ where: { tenantId } });
  if (!s || s.mode !== "TENANT_SMTP") {
    const meta: EmailDeliveryMeta = { channel: "PLATFORM_SMTP", fromAddress: opts.transport ? "test@platform.invalid" : platformFromAddress() };
    try {
      const transport = opts.transport ?? getPlatformTransport();
      const res = await transport.send(await brandBusinessMessage(tenantId, message, opts.storage));
      return { messageId: res.messageId, meta };
    } catch (e) {
      if (e instanceof MailDeliveryError) throw e;
      throw new MailDeliveryError(classifySmtpError(e), safeMailError(e), { channel: "PLATFORM_SMTP", fromAddress: meta.fromAddress });
    }
  }
  const meta: EmailDeliveryMeta = { channel: "TENANT_SMTP", fromAddress: s.fromEmail };
  const fail = async (code: SmtpErrorCode) => {
    await db.tenantMailSettings.updateMany({ where: { id: s.id }, data: { lastErrorCode: code, lastErrorAt: new Date() } }).catch(() => {});
    return new MailDeliveryError(code, `${SMTP_ERROR_CODES[code]} (eigener E-Mail-Versand)`, { channel: "TENANT_SMTP", fromAddress: s.fromEmail });
  };
  if (s.status !== "VERIFIED") throw await fail("NOT_VERIFIED");
  try {
    const transport = await tenantTransport(s);
    // Absender = Vermieter selbst (Name und Adresse aus der Konfiguration); Antworten an Reply-To, falls hinterlegt
    const res = await transport.send(await brandBusinessMessage(tenantId, { ...message, replyTo: s.replyTo ?? null }, opts.storage));
    return { messageId: res.messageId, meta };
  } catch (e) {
    throw await fail(e instanceof MailDeliveryError ? e.code : classifySmtpError(e));
  }
}

/** Systemmail von RentBase (Einladung, Passwort-Reset, Erinnerung): immer Plattform-SMTP, unabhängig vom Vermieter. */
export async function sendPlatformSystemMail(message: MailMessage, opts: { transport?: MailTransport } = {}): Promise<{ messageId: string | null; meta: EmailDeliveryMeta }> {
  const meta: EmailDeliveryMeta = { channel: "PLATFORM_SMTP", fromAddress: opts.transport ? "test@platform.invalid" : platformFromAddress() };
  try {
    const res = await (opts.transport ?? getPlatformTransport()).send(message);
    return { messageId: res.messageId, meta };
  } catch (e) {
    throw new MailDeliveryError(classifySmtpError(e), safeMailError(e), { channel: "PLATFORM_SMTP", fromAddress: meta.fromAddress });
  }
}

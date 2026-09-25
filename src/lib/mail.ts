// E-Mail-Versand hinter einer austauschbaren Schnittstelle. Der Rest der Anwendung kennt nur MailTransport;
// SMTP ist der erste Treiber. Zugangsdaten kommen ausschließlich aus Environment Variables und werden nie
// geloggt oder in Fehlermeldungen übernommen.

import { isIP } from "node:net";
import { DomainError } from "@/lib/integrity";
import type { SmtpErrorCode } from "@/lib/constants";

/** cid: eingebettetes Bild (z. B. Logo im HTML-Teil), wird nicht als Anhang angezeigt */
export type MailAttachment = { filename: string; content: Uint8Array; contentType: string; cid?: string };
export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Anzeigename des Absenders, in der Regel der Name der Vermietung */
  fromName?: string | null;
  /** Antworten gehen an die Vermietung, nicht an das technische Postfach */
  replyTo?: string | null;
  attachments: MailAttachment[];
};
export type MailResult = { messageId: string | null };

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<MailResult>;
}

const REQUIRED = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM_EMAIL"] as const;

/** Nur Entwicklung: MAIL_DEV_OUTBOX=<Ordner> legt E-Mails als .eml-Datei ab, statt sie zu versenden. In Produktion wirkungslos. */
const devOutbox = (env: NodeJS.ProcessEnv) => (env.NODE_ENV !== "production" && env.MAIL_DEV_OUTBOX?.trim() ? env.MAIL_DEV_OUTBOX.trim() : null);

/** Zustand der Versandkonfiguration für Oberfläche und Diagnose, ohne Werte preiszugeben. */
export function mailStatus(env: NodeJS.ProcessEnv = process.env): { configured: boolean; driver: "smtp" | "outbox" | "none"; missing: string[] } {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length === 0) return { configured: true, driver: "smtp", missing: [] };
  if (devOutbox(env)) return { configured: true, driver: "outbox", missing: [...missing] };
  return { configured: false, driver: "none", missing: [...missing] };
}

/** Bewusst streng und einfach: genau eine Adresse, keine Zeilenumbrüche, keine Listen. */
export function isValidEmail(value: string | null | undefined): value is string {
  if (!value) return false;
  const v = value.trim();
  return v.length <= 254 && /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[A-Za-z]{2,}$/.test(v) && !v.includes("..");
}

const headerSafe = (s: string) => s.replace(/[\r\n"<>]/g, " ").trim().slice(0, 120);

/**
 * Eine SMTP-Verbindung: Plattform (aus der Umgebung) oder Vermieter (aus TenantMailSettings, Passwort entschlüsselt
 * nur für diesen Aufruf im Speicher). connectHost ist die vorab geprüfte IP-Adresse; servername der echte Hostname
 * für die TLS-Zertifikatsprüfung (verhindert DNS-Rebinding zwischen Prüfung und Verbindung).
 */
export type SmtpConfig = {
  host: string;
  connectHost?: string;
  port: number;
  /** true = SSL/TLS ab Verbindungsbeginn (465); false = STARTTLS, verpflichtend */
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  /** Rückfall-Anzeigename, wenn die Nachricht keinen mitbringt */
  fromName?: string | null;
  /** fester Anzeigename, überschreibt message.fromName (eigener Versand: Absender stammt aus der Konfiguration) */
  fixedFromName?: string | null;
};

function nodemailerOptions(cfg: SmtpConfig) {
  return {
    host: cfg.connectHost ?? cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    requireTLS: !cfg.secure,
    // Hostname für die Zertifikatsprüfung (auch wenn über die vorab geprüfte IP verbunden wird); eine IP als Servername ist in TLS nicht zulässig
    tls: { ...(isIP(cfg.host) ? {} : { servername: cfg.host }), minVersion: "TLSv1.2" as const },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
    logger: false,
    debug: false,
  };
}

export class SmtpTransport implements MailTransport {
  readonly name = "smtp";
  constructor(private cfg: SmtpConfig) {}

  get fromAddress() { return this.cfg.fromEmail; }

  async send(message: MailMessage): Promise<MailResult> {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(nodemailerOptions(this.cfg));
    try {
      const name = headerSafe(this.cfg.fixedFromName || message.fromName || this.cfg.fromName || "");
      const info = await transport.sendMail({
        from: name ? { name, address: this.cfg.fromEmail } : this.cfg.fromEmail,
        to: message.to,
        replyTo: isValidEmail(message.replyTo) ? message.replyTo : undefined,
        subject: headerSafe(message.subject),
        text: message.text,
        html: message.html,
        attachments: message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType, ...(a.cid ? { cid: a.cid, contentDisposition: "inline" as const } : {}) })),
      });
      if (info.rejected && info.rejected.length > 0) throw Object.assign(new Error("rejected"), { code: "EENVELOPE", command: "RCPT TO" });
      return { messageId: info.messageId ?? null };
    } finally {
      transport.close();
    }
  }

  /** Verbindungstest: DNS, Verbindung, TLS/STARTTLS und Anmeldung – es wird nichts versendet. */
  async verify(): Promise<void> {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(nodemailerOptions(this.cfg));
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  }
}

/** Plattform-SMTP aus der Umgebung (unverändertes Verhalten wie vor Befehl 20.5). */
export function platformSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const port = Number(env.SMTP_PORT || 587);
  return {
    host: env.SMTP_HOST!,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
    user: env.SMTP_USER!,
    pass: env.SMTP_PASSWORD!,
    fromEmail: env.SMTP_FROM_EMAIL!,
    fromName: env.SMTP_FROM_NAME || null,
  };
}

/** Absenderadresse des Plattform-Versands für das Protokoll (keine Zugangsdaten). */
export function platformFromAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  if (override) return "test@platform.invalid";
  const status = mailStatus(env);
  if (status.driver === "outbox") return "entwicklung@localhost";
  return env.SMTP_FROM_EMAIL?.trim() || null;
}

/** Entwicklungs-Postausgang: schreibt die fertige E-Mail als Datei. Es wird nichts versendet. */
class OutboxTransport implements MailTransport {
  readonly name = "outbox";
  constructor(private dir: string) {}

  async send(message: MailMessage): Promise<MailResult> {
    const nodemailer = await import("nodemailer");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const info = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
      from: { name: headerSafe(message.fromName || "Rent-Base"), address: "entwicklung@localhost" },
      to: message.to,
      replyTo: isValidEmail(message.replyTo) ? message.replyTo : undefined,
      subject: headerSafe(message.subject),
      text: message.text,
      html: message.html,
      attachments: message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) })),
    });
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.eml`), info.message as Buffer);
    return { messageId: info.messageId ?? null };
  }
}

let override: MailTransport | null = null;

/** Nur für Tests und lokale Probeläufe: ersetzt den Versand durch eine Attrappe. */
export function setMailTransport(transport: MailTransport | null) {
  override = transport;
}

export function getMailTransport(env: NodeJS.ProcessEnv = process.env): MailTransport {
  if (override) return override;
  const status = mailStatus(env);
  if (status.driver === "outbox") return new OutboxTransport(devOutbox(env)!);
  if (!status.configured) throw new DomainError("Der E-Mail-Versand ist noch nicht eingerichtet (SMTP-Zugang fehlt in den Servereinstellungen).");
  return new SmtpTransport(platformSmtpConfig(env));
}

/**
 * Befehl 20.5: Versandfehler mit bekanntem Versandweg. publicMessage ist bereits unbedenklich (keine Rohmeldung),
 * meta landet im E-Mail-Protokoll (Kanal, Absender-Snapshot, abstrakte Fehlerart).
 */
export class MailDeliveryError extends Error {
  constructor(
    readonly code: SmtpErrorCode,
    readonly publicMessage: string,
    readonly meta: { channel: "PLATFORM_SMTP" | "TENANT_SMTP"; fromAddress: string | null },
  ) {
    super(publicMessage);
  }
}

/** Versandweg eines fehlgeschlagenen Versuchs fürs Protokoll, falls bekannt. */
export function deliveryMetaOf(e: unknown): { channel: "PLATFORM_SMTP" | "TENANT_SMTP"; fromAddress: string | null; errorCode: SmtpErrorCode } | null {
  return e instanceof MailDeliveryError ? { ...e.meta, errorCode: e.code } : null;
}

/** Befehl 20.5: ausdrücklich der zentrale RentBase-Versand (Systemmails). Nie von einem Vermieter-SMTP abhängig. */
export const getPlatformTransport = getMailTransport;

/**
 * Ordnet einen Versand-/Verbindungsfehler einer abstrakten Fehlerart zu. Die Rohmeldung wird nur zur Einordnung
 * gelesen, nie gespeichert oder angezeigt (kann Serverantworten, Adressen oder Zugangsdaten enthalten).
 */
export function classifySmtpError(e: unknown): SmtpErrorCode {
  const err = e as { code?: unknown; responseCode?: unknown; command?: unknown; message?: unknown };
  const code = String(err?.code ?? "");
  const responseCode = Number(err?.responseCode ?? 0);
  const command = String(err?.command ?? "").toUpperCase();
  const msg = String(err?.message ?? "");
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534 || command === "AUTH PLAIN" || command === "AUTH LOGIN") return "AUTH";
  if (command.startsWith("MAIL FROM") || (responseCode >= 550 && responseCode <= 553 && /sender|from|absender/i.test(msg))) return "SENDER_REJECTED";
  if (command.startsWith("RCPT TO") || code === "EENVELOPE") return "RECIPIENT_REJECTED";
  if (["ENOTFOUND", "EDNS", "EAI_AGAIN"].includes(code)) return "DNS";
  if (code === "ETLS" || /certificate|ssl|tls|wrong version number|self.signed/i.test(msg)) return "TLS";
  if (["ECONNREFUSED", "ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "CONNECT";
  return "UNKNOWN";
}

/**
 * Macht aus einem Versandfehler einen kurzen, unbedenklichen Text für Protokoll und Oberfläche.
 * Die Originalmeldung wird nie übernommen: Sie kann Serverantworten, Adressen oder Zugangsdaten enthalten.
 */
export function safeMailError(e: unknown): string {
  if (e instanceof MailDeliveryError) return e.publicMessage;
  if (e instanceof DomainError) return e.message;
  const code = String((e as { code?: unknown })?.code ?? "");
  const responseCode = Number((e as { responseCode?: unknown })?.responseCode ?? 0);
  if (["ECONNREFUSED", "ECONNECTION", "ETIMEDOUT", "ENOTFOUND", "ESOCKET", "EDNS", "ECONNRESET", "EAI_AGAIN"].includes(code)) return "SMTP-Verbindung fehlgeschlagen";
  if (code === "EAUTH" || responseCode === 535) return "SMTP-Anmeldung wurde abgelehnt";
  if (code === "EENVELOPE" || (responseCode >= 550 && responseCode <= 553)) return "Empfängeradresse wurde vom Mailserver abgelehnt";
  if (code === "EMESSAGE" || responseCode === 552) return "Nachricht wurde vom Mailserver abgelehnt (zum Beispiel zu groß)";
  if (code === "ETLS") return "Verschlüsselte SMTP-Verbindung kam nicht zustande";
  return responseCode ? `Versand fehlgeschlagen (Mailserver-Antwort ${responseCode})` : "Versand fehlgeschlagen";
}

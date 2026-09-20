// E-Mail-Versand hinter einer austauschbaren Schnittstelle. Der Rest der Anwendung kennt nur MailTransport;
// SMTP ist der erste Treiber. Zugangsdaten kommen ausschließlich aus Environment Variables und werden nie
// geloggt oder in Fehlermeldungen übernommen.

import { DomainError } from "@/lib/integrity";

export type MailAttachment = { filename: string; content: Uint8Array; contentType: string };
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

class SmtpTransport implements MailTransport {
  readonly name = "smtp";
  constructor(private env: NodeJS.ProcessEnv) {}

  async send(message: MailMessage): Promise<MailResult> {
    const nodemailer = await import("nodemailer");
    const port = Number(this.env.SMTP_PORT || 587);
    const transport = nodemailer.createTransport({
      host: this.env.SMTP_HOST,
      port,
      secure: this.env.SMTP_SECURE ? this.env.SMTP_SECURE === "true" : port === 465,
      auth: { user: this.env.SMTP_USER, pass: this.env.SMTP_PASSWORD },
      requireTLS: port !== 465,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 45_000,
    });
    try {
      const name = headerSafe(message.fromName || this.env.SMTP_FROM_NAME || "");
      const info = await transport.sendMail({
        from: name ? { name, address: this.env.SMTP_FROM_EMAIL! } : this.env.SMTP_FROM_EMAIL!,
        to: message.to,
        replyTo: isValidEmail(message.replyTo) ? message.replyTo : undefined,
        subject: headerSafe(message.subject),
        text: message.text,
        html: message.html,
        attachments: message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })),
      });
      if (info.rejected && info.rejected.length > 0) throw Object.assign(new Error("rejected"), { code: "EENVELOPE" });
      return { messageId: info.messageId ?? null };
    } finally {
      transport.close();
    }
  }
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
      attachments: message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })),
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
  return new SmtpTransport(env);
}

/**
 * Macht aus einem Versandfehler einen kurzen, unbedenklichen Text für Protokoll und Oberfläche.
 * Die Originalmeldung wird nie übernommen: Sie kann Serverantworten, Adressen oder Zugangsdaten enthalten.
 */
export function safeMailError(e: unknown): string {
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

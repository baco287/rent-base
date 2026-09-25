// Befehl 20: "Passwort vergessen". Token nur gehasht gespeichert, single-use, zeitlich begrenzt. Antwort nach
// außen immer neutral (item 22: keine E-Mail-Enumeration) – ob die Adresse existiert, verrät weder die
// Anfrage- noch die Reset-Seite.
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { recordAudit } from "@/lib/audit";
import { DomainError, sha256 } from "@/lib/integrity";
import { PASSWORD_RESET_EXPIRY_MINUTES } from "@/lib/constants";
import { claimEmail, markEmailFailed, markEmailSent } from "@/lib/email-log";
import { getMailTransport } from "@/lib/mail";

function newToken() {
  return randomBytes(32).toString("base64url");
}

/** Fordert einen Reset an. Existiert die Adresse nicht oder das Konto ist deaktiviert, passiert nach außen nichts Sichtbares. */
export async function requestPasswordReset(email: string, baseUrl: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() }, include: { tenant: { select: { id: true, name: true, email: true } } } });
  if (!user || !user.active) return; // neutrale Antwort: kein Hinweis, ob das Konto existiert

  const rawToken = newToken();
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60_000);

  await db.$transaction(async (tx) => {
    await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } });
    await recordAudit(tx, user.tenantId, { id: user.id, name: user.name }, { action: "PASSWORD_RESET_REQUESTED" });
  });

  const resetUrl = `${baseUrl}/passwort-vergessen/${rawToken}`;
  const { log, created } = await claimEmail({ tenantId: user.tenantId, recipient: user.email, subject: "Passwort zurücksetzen", template: "PASSWORD_RESET", trigger: "AUTO", idempotencyKey: `PASSWORD_RESET:${tokenHash.slice(0, 16)}` });
  if (!created) return;
  const text = `Für Ihr RentBase-Konto wurde ein Passwort-Reset angefordert.\n\nÜber den folgenden Link legen Sie ein neues Passwort fest:\n${resetUrl}\n\nDer Link ist ${PASSWORD_RESET_EXPIRY_MINUTES} Minuten gültig.\n\nWenn Sie das nicht waren, können Sie diese E-Mail ignorieren – Ihr Passwort bleibt unverändert.`;
  const html = `<p>Für Ihr RentBase-Konto wurde ein Passwort-Reset angefordert.</p><p><a href="${resetUrl}">Neues Passwort festlegen</a></p><p>Der Link ist ${PASSWORD_RESET_EXPIRY_MINUTES} Minuten gültig.</p><p>Wenn Sie das nicht waren, können Sie diese E-Mail ignorieren – Ihr Passwort bleibt unverändert.</p>`;
  try {
    const result = await getMailTransport().send({ to: user.email, subject: log.subject, text, html, fromName: user.tenant.name, replyTo: user.tenant.email, attachments: [] });
    await markEmailSent(user.tenantId, log.id, result.messageId);
  } catch {
    await markEmailFailed(user.tenantId, log.id, "Versand fehlgeschlagen");
  }
}

export type ResetTokenLookup = { valid: true } | { valid: false; expired: boolean };

/** Nur für die Reset-Seite: existiert der Token (noch) und ist er gültig? Verrät sonst nichts. */
export async function lookupResetToken(rawToken: string): Promise<ResetTokenLookup> {
  const row = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!row || row.usedAt) return { valid: false, expired: false };
  if (row.expiresAt < new Date()) return { valid: false, expired: true };
  return { valid: true };
}

/** Setzt das neue Passwort, verbraucht den Token und beendet alle bestehenden Sitzungen des Kontos (item 21/23). */
export async function completePasswordReset(rawToken: string, newPassword: string): Promise<{ userId: string }> {
  const tokenHash = sha256(rawToken);
  return db.$transaction(async (tx) => {
    const row = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!row || row.usedAt) throw new DomainError("Dieser Link ist nicht mehr gültig.");
    if (row.expiresAt < new Date()) throw new DomainError("Dieser Link ist abgelaufen. Bitte fordern Sie einen neuen an.");
    const user = await tx.user.findUniqueOrThrow({ where: { id: row.userId } });
    const passwordHash = await hashPassword(newPassword);
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await tx.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    await tx.session.deleteMany({ where: { userId: user.id } }); // bestehende Sitzungen beenden, auch die eigene
    await recordAudit(tx, user.tenantId, { id: user.id, name: user.name }, { action: "PASSWORD_RESET_COMPLETED" });
    return { userId: user.id };
  });
}

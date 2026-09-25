// Befehl 20: Einladungen zu einem Mandanten. Dieselbe Mechanik bedient zwei Fälle:
// (1) SUPER_ADMIN lädt den ersten OWNER eines neuen Mandanten ein (Mandantenanlage, lib/platform-tenants.ts),
// (2) ein OWNER lädt weitere Mitarbeiter (DISPO/YARD/weiterer OWNER) im eigenen Mandanten ein.
// Kein Passwort per E-Mail: der Token ist der einzige Nachweis, serverseitig nur gehasht gespeichert (sha256),
// zufällig (32 Byte), single-use, zeitlich begrenzt (INVITATION_EXPIRY_HOURS). Der Rohtoken existiert nur
// im laufenden Prozess und im E-Mail-Link, nie in der Datenbank oder im Audit-Log.
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError, sha256 } from "@/lib/integrity";
import { isUniqueViolation } from "@/lib/numbering";
import { INVITATION_EXPIRY_HOURS, ROLES, type Role } from "@/lib/constants";
import { claimEmail, markEmailFailed, markEmailSent } from "@/lib/email-log";
import { deliveryMetaOf, isValidEmail } from "@/lib/mail";
import { sendPlatformSystemMail } from "@/lib/tenant-mail";

function newToken() {
  return randomBytes(32).toString("base64url");
}
function tokenHashOf(rawToken: string) {
  return sha256(rawToken);
}

function inviteText(opts: { tenantName: string; inviterName: string; acceptUrl: string; role: Role; isFirstOwner: boolean }) {
  const roleLabel = ROLES[opts.role] ?? opts.role;
  const intro = opts.isFirstOwner
    ? `Sie wurden eingeladen, RentBase für „${opts.tenantName}“ einzurichten.`
    : `${opts.inviterName} hat Sie zu „${opts.tenantName}“ auf RentBase eingeladen (Rolle: ${roleLabel}).`;
  const text = `${intro}\n\nÜber den folgenden Link legen Sie Ihr Passwort fest und richten Ihr Konto ein:\n${opts.acceptUrl}\n\nDer Link ist ${INVITATION_EXPIRY_HOURS} Stunden gültig.\n\nWenn Sie diese Einladung nicht erwarten, können Sie diese E-Mail ignorieren.`;
  const html = `<p>${intro}</p><p><a href="${opts.acceptUrl}">Account einrichten</a></p><p>Der Link ist ${INVITATION_EXPIRY_HOURS} Stunden gültig.</p><p>Wenn Sie diese Einladung nicht erwarten, können Sie diese E-Mail ignorieren.</p>`;
  return { text, html };
}

async function sendInvitationMail(opts: { tenantId: string; tenantName: string; tenantEmail: string | null; email: string; role: Role; inviterName: string; isFirstOwner: boolean; idempotencyKey: string; baseUrl: string; rawToken: string }) {
  const { log, created } = await claimEmail({ tenantId: opts.tenantId, recipient: opts.email, subject: opts.isFirstOwner ? `Einrichtung von RentBase für ${opts.tenantName}` : `Einladung zu ${opts.tenantName} auf RentBase`, template: opts.isFirstOwner ? "OWNER_INVITATION" : "USER_INVITATION", trigger: "AUTO", idempotencyKey: opts.idempotencyKey });
  if (!created) return log;
  const acceptUrl = `${opts.baseUrl}/einladung/${opts.rawToken}`;
  const { text, html } = inviteText({ tenantName: opts.tenantName, inviterName: opts.inviterName, acceptUrl, role: opts.role, isFirstOwner: opts.isFirstOwner });
  try {
    // Befehl 20.5: Systemmail – immer Plattform-SMTP, auch wenn der Mandant noch keinen (oder einen defekten) eigenen SMTP hat
    const result = await sendPlatformSystemMail({ to: opts.email, subject: log.subject, text, html, fromName: opts.tenantName, replyTo: opts.tenantEmail, attachments: [] });
    await markEmailSent(opts.tenantId, log.id, result.messageId, result.meta);
  } catch (e) {
    // Mailversand darf die Mandanten-/Einladungsanlage nicht rückgängig machen (item 14): Zeile bleibt FAILED,
    // die Einladung kann über "erneut senden" wiederholt werden.
    await markEmailFailed(opts.tenantId, log.id, "Versand fehlgeschlagen", deliveryMetaOf(e));
  }
  return log;
}

export type InvitationRow = Prisma.InvitationGetPayload<object>;

/** Legt eine Einladung an und versendet sie. Wirft bei bereits offener Einladung derselben Adresse (rb_invitation_one_pending). */
export async function createInvitation(tenantId: string, actor: Actor | null, input: { email: string; role: Role; isFirstOwner?: boolean; baseUrl: string }): Promise<InvitationRow> {
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) throw new DomainError("Bitte eine gültige E-Mail-Adresse angeben.");
  const rawToken = newToken();
  const tokenHash = tokenHashOf(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_HOURS * 3600_000);

  const { invitation, tenant } = await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    let invitation: InvitationRow;
    try {
      invitation = await tx.invitation.create({ data: { tenantId, email, role: input.role, tokenHash, expiresAt, invitedById: actor?.id ?? null, invitedByName: actor?.name ?? null } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("Es gibt bereits eine offene Einladung für diese Adresse. Bitte zuerst widerrufen oder erneut senden.");
      throw e;
    }
    await recordAudit(tx, tenantId, actor, { action: input.isFirstOwner ? "OWNER_INVITED" : "USER_INVITED", details: { email, role: input.role } });
    return { invitation, tenant };
  });

  await sendInvitationMail({ tenantId, tenantName: tenant.name, tenantEmail: tenant.email, email, role: input.role, inviterName: actor?.name ?? "RentBase", isFirstOwner: Boolean(input.isFirstOwner), idempotencyKey: `INVITATION:${invitation.id}:${invitation.createdAt.toISOString()}`, baseUrl: input.baseUrl, rawToken });
  return invitation;
}

/** Erneut senden: neuer Token, alter wird ungültig (item 17); nur für offene Einladungen. */
export async function resendInvitation(tenantId: string, actor: Actor | null, invitationId: string, baseUrl: string): Promise<InvitationRow> {
  const rawToken = newToken();
  const tokenHash = tokenHashOf(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_HOURS * 3600_000);

  const { invitation, tenant } = await db.$transaction(async (tx) => {
    const existing = await tx.invitation.findFirst({ where: { id: invitationId, tenantId } });
    if (!existing) throw new DomainError("Einladung nicht gefunden.");
    if (existing.status !== "PENDING") throw new DomainError(`Diese Einladung ist bereits ${existing.status === "ACCEPTED" ? "angenommen" : existing.status === "REVOKED" ? "widerrufen" : "abgelaufen"}.`);
    const invitation = await tx.invitation.update({ where: { id: invitationId }, data: { tokenHash, expiresAt } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    await recordAudit(tx, tenantId, actor, { action: "INVITATION_RESENT", details: { email: existing.email } });
    return { invitation, tenant };
  });

  await sendInvitationMail({ tenantId, tenantName: tenant.name, tenantEmail: tenant.email, email: invitation.email, role: invitation.role as Role, inviterName: actor?.name ?? "RentBase", isFirstOwner: invitation.invitedById === null, idempotencyKey: `INVITATION:${invitation.id}:${tokenHash.slice(0, 16)}`, baseUrl, rawToken });
  return invitation;
}

/** Widerruft eine offene Einladung. Der Token wird sofort ungültig. */
export async function revokeInvitation(tenantId: string, actor: Actor | null, invitationId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await tx.invitation.findFirst({ where: { id: invitationId, tenantId } });
    if (!existing) throw new DomainError("Einladung nicht gefunden.");
    if (existing.status !== "PENDING") throw new DomainError("Nur offene Einladungen können widerrufen werden.");
    await tx.invitation.update({ where: { id: invitationId }, data: { status: "REVOKED", revokedAt: new Date() } });
    await recordAudit(tx, tenantId, actor, { action: "INVITATION_REVOKED", details: { email: existing.email } });
  });
}

export type InvitationLookup = { invitation: InvitationRow; tenantName: string } | { expired: true } | null;

/** Liest eine Einladung anhand des Rohtokens für die Annahmeseite. Verrät nie, ob eine E-Mail existiert. */
export async function lookupInvitation(rawToken: string): Promise<InvitationLookup> {
  const tokenHash = tokenHashOf(rawToken);
  const invitation = await db.invitation.findUnique({ where: { tokenHash }, include: { tenant: { select: { name: true } } } });
  if (!invitation) return null;
  if (invitation.status !== "PENDING") return null;
  if (invitation.expiresAt < new Date()) return { expired: true };
  return { invitation, tenantName: invitation.tenant.name };
}

/** Nimmt eine Einladung an: legt das Benutzerkonto an, versiegelt die Einladung. Gibt die neue User-ID zurück. */
export async function acceptInvitation(rawToken: string, input: { name: string; password: string }): Promise<{ userId: string; tenantId: string }> {
  const tokenHash = tokenHashOf(rawToken);
  return db.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({ where: { tokenHash } });
    if (!invitation || invitation.status !== "PENDING") throw new DomainError("Diese Einladung ist nicht mehr gültig.");
    if (invitation.expiresAt < new Date()) throw new DomainError("Diese Einladung ist abgelaufen.");
    const passwordHash = await hashPassword(input.password);
    let user;
    try {
      user = await tx.user.create({ data: { tenantId: invitation.tenantId, email: invitation.email, name: input.name.trim(), passwordHash, role: invitation.role, active: true } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("Für diese E-Mail-Adresse besteht bereits ein Konto.");
      throw e;
    }
    await tx.invitation.update({ where: { id: invitation.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedUserId: user.id } });
    await recordAudit(tx, invitation.tenantId, { id: user.id, name: user.name }, { action: "INVITATION_ACCEPTED", details: { email: invitation.email, role: invitation.role } });
    return { userId: user.id, tenantId: invitation.tenantId };
  });
}

/** Offene und historische Einladungen eines Mandanten, für die Benutzerverwaltung. */
export function listInvitations(tenantId: string) {
  return db.invitation.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
}

// Control Center: mandantenübergreifende Benutzerverwaltung und interne Rollen. Nur für requirePlatform()-geschützte
// Aufrufer (Berechtigung: USERS_VIEW zum Ansehen, USER_MANAGE für Sperren/Entsperren/Einladung erneut senden,
// PLATFORM_ROLE_MANAGE für interne Rollen). Keine Passwörter, keine Passwort-Hashes, keine Tokens – weder lesen noch setzen.
// Sperren/Entsperren nutzt dieselben Funktionen wie der Inhaber in den Einstellungen (lib/tenant-users.ts): dieselben
// Schutzregeln (letzter aktiver Inhaber, eigenes Konto) gelten auch für RentBase-Mitarbeiter.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError } from "@/lib/integrity";
import { activateUser, deactivateUser } from "@/lib/tenant-users";
import { INTERNAL_PLATFORM_ROLES, PLATFORM_ROLES, isInternalRole, platformAllows, type PlatformRole } from "@/lib/constants";

export type PlatformUserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  platformRole: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  tenant: { id: string; name: string; status: string };
};

export type UserListFilter = {
  query?: string;
  tenantId?: string;
  status?: "active" | "inactive" | "";
  role?: string;
  internal?: boolean;
  page: number;
  pageSize: number;
};

/** Benutzerliste über alle Mandanten: Suche nach Name, E-Mail und Firma; Filter Status, Rolle, interne Rollen. */
export async function listUsersForPlatform(f: UserListFilter): Promise<{ rows: PlatformUserRow[]; total: number }> {
  const q = f.query?.trim();
  const where: Prisma.UserWhereInput = {
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { tenant: { name: { contains: q, mode: "insensitive" } } }] } : {}),
    ...(f.tenantId ? { tenantId: f.tenantId } : {}),
    ...(f.status === "active" ? { active: true } : f.status === "inactive" ? { active: false } : {}),
    ...(f.role ? { role: f.role } : {}),
    ...(f.internal ? { platformRole: { in: [...INTERNAL_PLATFORM_ROLES] } } : {}),
  };
  const [users, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: [{ tenant: { name: "asc" } }, { active: "desc" }, { name: "asc" }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
      select: { id: true, name: true, email: true, role: true, active: true, platformRole: true, lastLoginAt: true, createdAt: true, tenant: { select: { id: true, name: true, status: true } } },
    }),
    db.user.count({ where }),
  ]);
  return { rows: users, total };
}

/** Einzelner Benutzer mit Kontext für /admin/benutzer/[id] – ohne Passwort-Hash. */
export async function userDetailForPlatform(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, active: true, platformRole: true, lastLoginAt: true, createdAt: true, updatedAt: true, tenant: { select: { id: true, name: true, status: true, slug: true } } },
  });
  if (!user) return null;
  const [sessions, audit, invitations, supportSessions] = await Promise.all([
    db.session.count({ where: { userId, expiresAt: { gt: new Date() } } }),
    db.auditLog.findMany({ where: { OR: [{ userId }, { tenantId: user.tenant.id, details: { path: ["email"], equals: user.email } }] }, orderBy: { createdAt: "desc" }, take: 15 }),
    db.invitation.findMany({ where: { tenantId: user.tenant.id, email: user.email }, orderBy: { createdAt: "desc" }, take: 5 }),
    isInternalRole(user.platformRole) ? db.supportSession.findMany({ where: { superAdminId: userId }, orderBy: { startedAt: "desc" }, take: 10, include: { tenant: { select: { name: true } } } }) : Promise.resolve([]),
  ]);
  return { user, activeSessions: sessions, audit, invitations, supportSessions };
}

/** Benutzer sperren (deaktivieren): beendet alle Sitzungen. Dieselben Regeln wie für den Inhaber. */
export async function platformDeactivateUser(actor: Actor, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { tenantId: true, platformRole: true } });
  if (!user) throw new DomainError("Benutzer nicht gefunden.");
  if (isInternalRole(user.platformRole)) throw new DomainError("Konten mit interner Plattformrolle werden nicht über die Benutzerverwaltung gesperrt. Bitte zuerst die Plattformrolle entziehen.");
  await deactivateUser(actor, user.tenantId, userId);
}

/** Benutzer entsperren (aktivieren). */
export async function platformActivateUser(actor: Actor, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!user) throw new DomainError("Benutzer nicht gefunden.");
  await activateUser(actor, user.tenantId, userId);
}

/** Offene Einladungen über alle Mandanten (für /admin/benutzer, Reiter Einladungen). */
export async function listPendingInvitationsForPlatform(opts: { query?: string; page: number; pageSize: number }) {
  const q = opts.query?.trim();
  const where: Prisma.InvitationWhereInput = {
    status: "PENDING",
    ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { tenant: { name: { contains: q, mode: "insensitive" } } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.invitation.findMany({ where, orderBy: { createdAt: "desc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, include: { tenant: { select: { id: true, name: true } } } }),
    db.invitation.count({ where }),
  ]);
  return { rows, total };
}

/** Alle Konten mit interner Plattformrolle (für /admin/system und /admin/benutzer). */
export function listInternalAdmins() {
  return db.user.findMany({
    where: { platformRole: { in: [...INTERNAL_PLATFORM_ROLES] } },
    orderBy: [{ platformRole: "asc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, active: true, platformRole: true, lastLoginAt: true, tenant: { select: { id: true, name: true } } },
  });
}

/**
 * Interne Plattformrolle setzen oder entziehen (NONE). Nur SUPER_ADMIN (PLATFORM_ROLE_MANAGE). Schutzregeln:
 * nie das eigene Konto, nie den letzten aktiven SUPER_ADMIN herabstufen, nur aktive Konten. Der DB-Trigger
 * rb_guard_platform_role verlangt die ausdrückliche Freigabe in derselben Transaktion – kein anderer Codepfad kann
 * die Rolle „nebenbei“ ändern. Verliert das Konto das Recht auf Supportsessions, werden laufende Sessions beendet.
 */
export async function setPlatformRole(actor: Actor, userId: string, role: PlatformRole): Promise<{ changed: boolean }> {
  if (!(role in PLATFORM_ROLES)) throw new DomainError("Unbekannte Plattformrolle.");
  if (userId === actor.id) throw new DomainError("Die eigene Plattformrolle kann nicht selbst geändert werden.");
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, active: true, platformRole: true, tenantId: true } });
    if (!user) throw new DomainError("Benutzer nicht gefunden.");
    if (!user.active && role !== "NONE") throw new DomainError("Einem deaktivierten Konto kann keine Plattformrolle gegeben werden.");
    if (user.platformRole === role) return { changed: false };
    if (user.platformRole === "SUPER_ADMIN") {
      const others = await tx.user.count({ where: { platformRole: "SUPER_ADMIN", active: true, id: { not: userId } } });
      if (others === 0) throw new DomainError("Der letzte aktive SUPER_ADMIN kann nicht herabgestuft werden.");
    }
    await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
    await tx.user.update({ where: { id: userId }, data: { platformRole: role } });
    if (!platformAllows(role, "SUPPORT_SESSION")) await tx.supportSession.updateMany({ where: { superAdminId: userId, endedAt: null }, data: { endedAt: new Date() } });
    await recordAudit(tx, user.tenantId, actor, { action: "PLATFORM_ROLE_CHANGED", details: { email: user.email, targetUserId: user.id, before: { platformRole: user.platformRole }, after: { platformRole: role } } });
    return { changed: true };
  });
}

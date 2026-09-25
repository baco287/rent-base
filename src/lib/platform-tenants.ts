// Befehl 20: Mandantenverwaltung auf Plattformebene. Nur für requirePlatform()-geschützte Aufrufer.
// Legt bewusst keine Fachdaten (Kunden, Fahrzeuge, Verträge ...) an – ein neuer Mandant beginnt fachlich leer
// (item 57), der OWNER richtet alles über die Einladung und den Onboarding-Assistenten selbst ein.
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError } from "@/lib/integrity";
import { slugify } from "@/lib/slug";
import { createInvitation } from "@/lib/invitations";
import { isValidEmail } from "@/lib/mail";

/** Eindeutigen Slug aus dem Firmennamen ableiten; bei Kollision einen Zähler anhängen. */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    const existing = await db.tenant.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
}

export type CreateTenantInput = { companyName: string; ownerFirstName: string; ownerLastName: string; ownerEmail: string; note?: string; baseUrl: string };

/**
 * Legt einen neuen Mandanten an und lädt den ersten OWNER ein (item 13/14). Atomar: Mandant + Einladung entstehen
 * zusammen oder gar nicht. Schlägt der Mailversand fehl, bleibt der Mandant bestehen (createInvitation kümmert
 * sich selbst darum, siehe dort) – die Einladung kann jederzeit erneut gesendet werden.
 */
export async function createTenantByPlatform(actor: Actor, input: CreateTenantInput) {
  const companyName = input.companyName.trim();
  if (companyName.length < 2) throw new DomainError("Bitte den Firmennamen der Autovermietung angeben.");
  const ownerName = `${input.ownerFirstName.trim()} ${input.ownerLastName.trim()}`.trim();
  if (ownerName.length < 2) throw new DomainError("Bitte Vor- und Nachnamen des Inhabers angeben.");
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (!isValidEmail(ownerEmail)) throw new DomainError("Bitte eine gültige E-Mail-Adresse des Inhabers angeben.");
  if (await db.user.findUnique({ where: { email: ownerEmail }, select: { id: true } })) throw new DomainError("Für diese E-Mail-Adresse besteht bereits ein Konto.");

  const slug = await uniqueSlug(companyName);
  const tenant = await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: companyName, slug, status: "PENDING_SETUP" } });
    await recordAudit(tx, tenant.id, actor, { action: "TENANT_CREATED", details: { companyName, ownerEmail, note: input.note?.trim() || null } });
    return tenant;
  });

  await createInvitation(tenant.id, actor, { email: ownerEmail, role: "OWNER", isFirstOwner: true, baseUrl: input.baseUrl });
  return tenant;
}

/** Sperrt einen Mandanten: Pflichtgrund, beendet sofort alle aktiven Sitzungen seiner Benutzer (item 11). */
export async function suspendTenant(actor: Actor, tenantId: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (trimmed.length < 5) throw new DomainError("Bitte einen Grund für die Sperrung angeben.");
  await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new DomainError("Mandant nicht gefunden.");
    if (tenant.status === "SUSPENDED") throw new DomainError("Dieser Mandant ist bereits gesperrt.");
    await tx.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedReason: trimmed, suspendedById: actor.id, suspendedByName: actor.name } });
    await tx.session.deleteMany({ where: { user: { tenantId } } });
    await recordAudit(tx, tenantId, actor, { action: "TENANT_SUSPENDED", details: { reason: trimmed } });
  });
}

/** Reaktiviert einen gesperrten Mandanten. Daten und Nummernkreise bleiben unverändert (item 12). */
export async function reactivateTenant(actor: Actor, tenantId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new DomainError("Mandant nicht gefunden.");
    if (tenant.status !== "SUSPENDED") throw new DomainError("Dieser Mandant ist nicht gesperrt.");
    await tx.tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE", suspendedAt: null, suspendedReason: null, suspendedById: null, suspendedByName: null } });
    await recordAudit(tx, tenantId, actor, { action: "TENANT_REACTIVATED", details: {} });
  });
}

export type PlatformTenantRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  userCount: number;
  vehicleCount: number;
  owner: { name: string; email: string } | null;
  pendingOwnerInvite: { email: string; expiresAt: Date } | null;
};

/** Mandantenliste für /admin/mandanten: Suche über Firmenname, Slug und Owner-E-Mail, mit Pagination (item 8). */
export async function listTenantsForPlatform(opts: { query?: string; page: number; pageSize: number }): Promise<{ rows: PlatformTenantRow[]; total: number }> {
  const q = opts.query?.trim();
  const where = q
    ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { slug: { contains: q, mode: "insensitive" as const } }, { users: { some: { email: { contains: q, mode: "insensitive" as const } } } }] }
    : {};
  const [tenants, total] = await Promise.all([
    db.tenant.findMany({ where, orderBy: { createdAt: "desc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, include: { _count: { select: { users: true, vehicles: true } }, users: { where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" }, take: 1, select: { name: true, email: true } }, invitations: { where: { role: "OWNER", status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 1, select: { email: true, expiresAt: true } } } }),
    db.tenant.count({ where }),
  ]);
  return {
    rows: tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status, createdAt: t.createdAt, userCount: t._count.users, vehicleCount: t._count.vehicles, owner: t.users[0] ?? null, pendingOwnerInvite: t.invitations[0] ?? null })),
    total,
  };
}

/** Kompakte Plattformübersicht für das Super-Admin-Dashboard (item 7). */
export async function platformDashboardStats() {
  const [tenantsTotal, tenantsActive, tenantsSuspended, tenantsPending, usersTotal, invitationsPending, invitationsFailedMail] = await Promise.all([
    db.tenant.count(),
    db.tenant.count({ where: { status: "ACTIVE" } }),
    db.tenant.count({ where: { status: "SUSPENDED" } }),
    db.tenant.count({ where: { status: "PENDING_SETUP" } }),
    db.user.count({ where: { active: true } }),
    db.invitation.count({ where: { status: "PENDING" } }),
    db.emailLog.count({ where: { template: { in: ["OWNER_INVITATION", "USER_INVITATION"] }, status: "FAILED" } }),
  ]);
  return { tenantsTotal, tenantsActive, tenantsSuspended, tenantsPending, usersTotal, invitationsPending, invitationsFailedMail };
}

/** Vollständige Mandantenansicht für /admin/mandanten/[id]: Benutzer, Einladungen, Supporthistorie. */
export async function tenantDetailForPlatform(tenantId: string) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return null;
  const [users, invitations, supportSessions, vehicleCount] = await Promise.all([
    db.user.findMany({ where: { tenantId }, orderBy: [{ active: "desc" }, { role: "asc" }, { name: "asc" }] }),
    db.invitation.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.supportSession.findMany({ where: { tenantId }, orderBy: { startedAt: "desc" }, take: 10 }),
    db.vehicle.count({ where: { tenantId } }),
  ]);
  return { tenant, users, invitations, supportSessions, vehicleCount };
}

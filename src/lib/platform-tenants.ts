// Befehl 20: Mandantenverwaltung auf Plattformebene. Nur für requirePlatform()-geschützte Aufrufer.
// Legt bewusst keine Fachdaten (Kunden, Fahrzeuge, Verträge ...) an – ein neuer Mandant beginnt fachlich leer
// (item 57), der OWNER richtet alles über die Einladung und den Onboarding-Assistenten selbst ein.
// Control Center: Kundenliste mit Filtern und Kennzahlen, Dashboard-Kennzahlen, vollständige Mandantenansicht.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError } from "@/lib/integrity";
import { slugify } from "@/lib/slug";
import { createInvitation } from "@/lib/invitations";
import { isValidEmail } from "@/lib/mail";
import { BILLABLE_SUBSCRIPTION_STATUS } from "@/lib/constants";
import { tenantFeatures } from "@/lib/features";

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
    await recordAudit(tx, tenantId, actor, { action: "TENANT_SUSPENDED", details: { reason: trimmed, before: { status: tenant.status }, after: { status: "SUSPENDED" } } });
  });
}

/** Reaktiviert einen gesperrten Mandanten. Daten und Nummernkreise bleiben unverändert (item 12). */
export async function reactivateTenant(actor: Actor, tenantId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new DomainError("Mandant nicht gefunden.");
    if (tenant.status !== "SUSPENDED") throw new DomainError("Dieser Mandant ist nicht gesperrt.");
    await tx.tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE", suspendedAt: null, suspendedReason: null, suspendedById: null, suspendedByName: null } });
    await recordAudit(tx, tenantId, actor, { action: "TENANT_REACTIVATED", details: { before: { status: "SUSPENDED" }, after: { status: "ACTIVE" } } });
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
  bookingCount: number;
  customerCount: number;
  owner: { name: string; email: string } | null;
  pendingOwnerInvite: { email: string; expiresAt: Date } | null;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  lastActivityAt: Date | null;
};

export type TenantListFilter = {
  query?: string;
  status?: string; // TenantStatus
  plan?: string; // PlanKey oder "NONE" (kein Tarif hinterlegt)
  subscriptionStatus?: string; // SubscriptionStatus oder "NONE"
  sort?: "newest" | "name" | "activity";
  page: number;
  pageSize: number;
};

/**
 * Kundenliste für das Control Center: Suche über Firmenname, Kurzname und Benutzer-E-Mail; Filter nach Status, Tarif
 * und Abo-Status; Kennzahlen je Mandant (aktive Benutzer, Fahrzeuge außer INACTIVE, Buchungen, Kunden) und letzte
 * Aktivität (jüngste Anmeldung eines Benutzers des Mandanten).
 */
export async function listTenantsForPlatform(opts: TenantListFilter): Promise<{ rows: PlatformTenantRow[]; total: number }> {
  const q = opts.query?.trim();
  const noSubscription = opts.plan === "NONE" || opts.subscriptionStatus === "NONE";
  const subscriptionWhere: Prisma.TenantSubscriptionWhereInput = {
    ...(opts.plan && opts.plan !== "NONE" ? { plan: opts.plan } : {}),
    ...(opts.subscriptionStatus && opts.subscriptionStatus !== "NONE" ? { status: opts.subscriptionStatus } : {}),
  };
  const where: Prisma.TenantWhereInput = {
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }, { users: { some: { email: { contains: q, mode: "insensitive" } } } }] } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(noSubscription ? { subscription: { is: null } } : Object.keys(subscriptionWhere).length ? { subscription: subscriptionWhere } : {}),
  };
  const orderBy: Prisma.TenantOrderByWithRelationInput = opts.sort === "name" ? { name: "asc" } : { createdAt: "desc" };
  const [tenants, total] = await Promise.all([
    db.tenant.findMany({
      where,
      orderBy,
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: {
        _count: { select: { users: { where: { active: true } }, vehicles: { where: { status: { not: "INACTIVE" } } }, bookings: true, customers: true } },
        users: { where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" }, take: 1, select: { name: true, email: true } },
        invitations: { where: { role: "OWNER", status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 1, select: { email: true, expiresAt: true } },
        subscription: { select: { plan: true, status: true, trialEndsAt: true } },
      },
    }),
    db.tenant.count({ where }),
  ]);
  const activity = tenants.length ? await db.user.groupBy({ by: ["tenantId"], where: { tenantId: { in: tenants.map((t) => t.id) } }, _max: { lastLoginAt: true } }) : [];
  const lastActivity = new Map(activity.map((a) => [a.tenantId, a._max.lastLoginAt]));
  const rows: PlatformTenantRow[] = tenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    createdAt: t.createdAt,
    userCount: t._count.users,
    vehicleCount: t._count.vehicles,
    bookingCount: t._count.bookings,
    customerCount: t._count.customers,
    owner: t.users[0] ?? null,
    pendingOwnerInvite: t.invitations[0] ?? null,
    plan: t.subscription?.plan ?? null,
    subscriptionStatus: t.subscription?.status ?? null,
    trialEndsAt: t.subscription?.trialEndsAt ?? null,
    lastActivityAt: lastActivity.get(t.id) ?? null,
  }));
  if (opts.sort === "activity") rows.sort((a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0));
  return { rows, total };
}

/** Kennzahlen für das Control-Center-Dashboard. Nur echte Daten; MRR nur, wenn Preise erfasst sind (sonst null). */
export async function platformDashboardStats() {
  const now = new Date();
  const days30 = new Date(now.getTime() - 30 * 24 * 3600_000);
  const hours24 = new Date(now.getTime() - 24 * 3600_000);
  const soon = new Date(now.getTime() + 7 * 24 * 3600_000);
  const [
    tenantsTotal, tenantsActive, tenantsSuspended, tenantsPending, tenantsNew30d,
    usersTotal, usersLoggedIn30d, invitationsPending, invitationsFailedMail,
    vehiclesTotal, bookingsTotal, bookingsActive, bookingsNew30d, customersTotal,
    trialTenants, trialsEndingSoon, priced, subscriptionsTotal,
    failedMails24h, activeSupportSessions, internalAdmins,
  ] = await db.$transaction([ // eine Verbindung, sequenziell: schont den Pool (lokal PGlite, produktiv Postgres)
    db.tenant.count(),
    db.tenant.count({ where: { status: "ACTIVE" } }),
    db.tenant.count({ where: { status: "SUSPENDED" } }),
    db.tenant.count({ where: { status: "PENDING_SETUP" } }),
    db.tenant.count({ where: { createdAt: { gte: days30 } } }),
    db.user.count({ where: { active: true } }),
    db.user.count({ where: { active: true, lastLoginAt: { gte: days30 } } }),
    db.invitation.count({ where: { status: "PENDING" } }),
    db.emailLog.count({ where: { template: { in: ["OWNER_INVITATION", "USER_INVITATION"] }, status: "FAILED" } }),
    db.vehicle.count({ where: { status: { not: "INACTIVE" } } }),
    db.booking.count(),
    db.booking.count({ where: { status: "ACTIVE" } }),
    db.booking.count({ where: { createdAt: { gte: days30 } } }),
    db.customer.count(),
    db.tenantSubscription.count({ where: { status: "TRIAL" } }),
    db.tenantSubscription.count({ where: { status: "TRIAL", trialEndsAt: { lte: soon } } }),
    db.tenantSubscription.aggregate({ where: { status: { in: BILLABLE_SUBSCRIPTION_STATUS }, monthlyPriceCents: { not: null } }, _sum: { monthlyPriceCents: true }, _count: { _all: true } }),
    db.tenantSubscription.count(),
    db.emailLog.count({ where: { status: "FAILED", createdAt: { gte: hours24 } } }),
    db.supportSession.count({ where: { endedAt: null, expiresAt: { gt: now } } }),
    db.user.count({ where: { platformRole: { not: "NONE" }, active: true } }),
  ]);
  const mrrCents = priced._count._all > 0 ? (priced._sum.monthlyPriceCents ?? 0) : null;
  return {
    tenantsTotal, tenantsActive, tenantsSuspended, tenantsPending, tenantsNew30d,
    usersTotal, usersLoggedIn30d, invitationsPending, invitationsFailedMail,
    vehiclesTotal, bookingsTotal, bookingsActive, bookingsNew30d, customersTotal,
    trialTenants, trialsEndingSoon, subscriptionsTotal, pricedSubscriptions: priced._count._all,
    mrrCents, arrCents: mrrCents == null ? null : mrrCents * 12,
    failedMails24h, activeSupportSessions, internalAdmins,
  };
}

/** Vollständige Mandantenansicht für /admin/mandanten/[id]: Stammdaten, Benutzer, Einladungen, Nutzung, Abo, Features, Support. */
export async function tenantDetailForPlatform(tenantId: string) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, include: { subscription: true, mailSettings: { select: { mode: true, status: true, verifiedAt: true, lastErrorCode: true } } } });
  if (!tenant) return null;
  const now = new Date();
  const [users, invitations, supportSessions, vehicleCount, vehiclesActive, bookingCount, bookingsActive, customerCount, invoiceCount, damageCaseCount, authorityCaseCount, lastActivity] = await db.$transaction([
    db.user.findMany({ where: { tenantId }, orderBy: [{ active: "desc" }, { role: "asc" }, { name: "asc" }], select: { id: true, name: true, email: true, role: true, active: true, platformRole: true, lastLoginAt: true, createdAt: true } }),
    db.invitation.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.supportSession.findMany({ where: { tenantId }, orderBy: { startedAt: "desc" }, take: 10 }),
    db.vehicle.count({ where: { tenantId } }),
    db.vehicle.count({ where: { tenantId, status: { not: "INACTIVE" } } }),
    db.booking.count({ where: { tenantId } }),
    db.booking.count({ where: { tenantId, status: "ACTIVE" } }),
    db.customer.count({ where: { tenantId } }),
    db.invoice.count({ where: { tenantId } }),
    db.damageCase.count({ where: { tenantId } }),
    db.authorityCase.count({ where: { tenantId } }),
    db.user.aggregate({ where: { tenantId }, _max: { lastLoginAt: true } }),
  ]);
  const features = await tenantFeatures(tenantId);
  return {
    tenant,
    users,
    invitations,
    supportSessions,
    vehicleCount,
    features,
    usage: {
      vehicles: vehicleCount,
      vehiclesActive,
      bookings: bookingCount,
      bookingsActive,
      customers: customerCount,
      invoices: invoiceCount,
      damageCases: damageCaseCount,
      authorityCases: authorityCaseCount,
      lastActivityAt: lastActivity._max.lastLoginAt,
      activeSupportSessions: supportSessions.filter((s) => !s.endedAt && s.expiresAt > now).length,
    },
  };
}

/** Kleine Auswahlliste (ID + Name + Status) für Filter im Control Center. */
export function tenantOptions() {
  return db.tenant.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, status: true } });
}

// Control Center: interne Tarif-/Abo-Verwaltung. RentBase hat (Stand Control Center) keine externe Abrechnung –
// diese Datei ist deshalb ausdrücklich KEINE Billing-Logik, sondern die Buchführung des Betreibers: welcher Tarif,
// welcher Status, welche Limits, welcher vereinbarte Monatspreis. MRR/ARR werden nur aus erfassten Preisen berechnet.
// Limits (maxUsers/maxVehicles) werden an genau zwei Stellen durchgesetzt: createInvitation (lib/invitations.ts) und
// createVehicleAction (fahrzeuge/actions.ts). null = unbegrenzt, damit Bestandsmandanten unverändert weiterarbeiten.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor, type AuditDetails, type AuditDetailValue } from "@/lib/audit";
import { DomainError } from "@/lib/integrity";
import { BILLABLE_SUBSCRIPTION_STATUS, PLANS, SUBSCRIPTION_STATUS, type PlanKey, type SubscriptionStatus } from "@/lib/constants";

type Db = Prisma.TransactionClient | typeof db;
export type SubscriptionRow = Prisma.TenantSubscriptionGetPayload<object>;

export type SubscriptionInput = {
  plan: PlanKey;
  status: SubscriptionStatus;
  startedAt?: Date | null;
  trialEndsAt?: Date | null;
  cancelledAt?: Date | null;
  endsAt?: Date | null;
  monthlyPriceCents?: number | null;
  maxUsers?: number | null;
  maxVehicles?: number | null;
  note?: string | null;
};

export function getSubscription(tenantId: string, client: Db = db) {
  return client.tenantSubscription.findUnique({ where: { tenantId } });
}

function validate(input: SubscriptionInput) {
  if (!(input.plan in PLANS)) throw new DomainError("Unbekannter Tarif.");
  if (!(input.status in SUBSCRIPTION_STATUS)) throw new DomainError("Unbekannter Abo-Status.");
  if (input.status === "TRIAL" && !input.trialEndsAt) throw new DomainError("Für die Testphase bitte das Enddatum angeben.");
  if ((input.status === "CANCELLED" || input.status === "ENDED") && !input.cancelledAt) throw new DomainError("Für eine Kündigung bitte das Kündigungsdatum angeben.");
  if (input.monthlyPriceCents != null && (!Number.isInteger(input.monthlyPriceCents) || input.monthlyPriceCents < 0)) throw new DomainError("Monatspreis: bitte einen Betrag ab 0 angeben oder leer lassen.");
  if (input.maxUsers != null && (!Number.isInteger(input.maxUsers) || input.maxUsers < 1)) throw new DomainError("Benutzerlimit: bitte eine ganze Zahl ab 1 angeben oder leer lassen.");
  if (input.maxVehicles != null && (!Number.isInteger(input.maxVehicles) || input.maxVehicles < 1)) throw new DomainError("Fahrzeuglimit: bitte eine ganze Zahl ab 1 angeben oder leer lassen.");
}

const TRACKED = ["plan", "status", "startedAt", "trialEndsAt", "cancelledAt", "endsAt", "monthlyPriceCents", "maxUsers", "maxVehicles", "note"] as const;
const plain = (v: unknown): AuditDetailValue => (v instanceof Date ? v.toISOString() : v == null ? null : (v as AuditDetailValue));

/** Tarif/Abo anlegen oder ändern. Protokolliert nur tatsächlich geänderte Felder mit vorher/nachher. */
export async function upsertSubscription(actor: Actor, tenantId: string, input: SubscriptionInput): Promise<SubscriptionRow> {
  validate(input);
  const data = {
    plan: input.plan,
    status: input.status,
    trialEndsAt: input.trialEndsAt ?? null,
    cancelledAt: input.cancelledAt ?? null,
    endsAt: input.endsAt ?? null,
    monthlyPriceCents: input.monthlyPriceCents ?? null,
    maxUsers: input.maxUsers ?? null,
    maxVehicles: input.maxVehicles ?? null,
    note: input.note?.trim() || null,
    updatedById: actor.id,
    updatedByName: actor.name,
  };
  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw new DomainError("Mandant nicht gefunden.");
    const before = await tx.tenantSubscription.findUnique({ where: { tenantId } });
    const row = before
      ? await tx.tenantSubscription.update({ where: { tenantId }, data: { ...data, ...(input.startedAt ? { startedAt: input.startedAt } : {}) } })
      : await tx.tenantSubscription.create({ data: { tenantId, ...data, ...(input.startedAt ? { startedAt: input.startedAt } : {}) } });
    const changedBefore: Record<string, AuditDetailValue> = {};
    const changedAfter: Record<string, AuditDetailValue> = {};
    for (const f of TRACKED) {
      const b = plain(before ? before[f] : null);
      const a = plain(row[f]);
      if (b !== a) {
        changedBefore[f] = b;
        changedAfter[f] = a;
      }
    }
    if (before && Object.keys(changedAfter).length === 0) return row;
    const details: AuditDetails = { plan: row.plan, status: row.status, before: changedBefore, after: changedAfter };
    await recordAudit(tx, tenantId, actor, { action: before ? "SUBSCRIPTION_UPDATED" : "SUBSCRIPTION_CREATED", details });
    return row;
  });
}

/** Benutzerlimit: aktive Benutzer + offene Einladungen. Ohne Abo oder ohne Limit: nichts zu prüfen. */
export async function assertUserLimit(tenantId: string, client: Db = db): Promise<void> {
  const sub = await client.tenantSubscription.findUnique({ where: { tenantId }, select: { maxUsers: true } });
  if (!sub?.maxUsers) return;
  const [users, pending] = await Promise.all([
    client.user.count({ where: { tenantId, active: true } }),
    client.invitation.count({ where: { tenantId, status: "PENDING", expiresAt: { gt: new Date() } } }),
  ]);
  if (users + pending >= sub.maxUsers) throw new DomainError(`Das Benutzerlimit des Tarifs (${sub.maxUsers}) ist erreicht – aktive Benutzer und offene Einladungen zusammen. Bitte an RentBase wenden, um den Tarif zu erweitern.`);
}

/** Fahrzeuglimit: alle Fahrzeuge außer INACTIVE. */
export async function assertVehicleLimit(tenantId: string, client: Db = db): Promise<void> {
  const sub = await client.tenantSubscription.findUnique({ where: { tenantId }, select: { maxVehicles: true } });
  if (!sub?.maxVehicles) return;
  const vehicles = await client.vehicle.count({ where: { tenantId, status: { not: "INACTIVE" } } });
  if (vehicles >= sub.maxVehicles) throw new DomainError(`Das Fahrzeuglimit des Tarifs (${sub.maxVehicles}) ist erreicht. Bitte an RentBase wenden, um den Tarif zu erweitern.`);
}

export type BillingRow = { tenantId: string; tenantName: string; tenantStatus: string; subscription: SubscriptionRow | null; activeUsers: number; vehicles: number };
export type BillingTotals = {
  mrrCents: number | null;
  arrCents: number | null;
  pricedCount: number;
  byStatus: Record<SubscriptionStatus, number>;
  byPlan: Record<PlanKey, number>;
  withoutSubscription: number;
  trialsEndingSoon: number;
};

/** Übersicht für /admin/abos: alle Mandanten mit oder ohne Abo-Zeile; Summen nur aus erfassten Werten. */
export async function billingOverview(opts: { query?: string; status?: string; plan?: string } = {}): Promise<{ rows: BillingRow[]; totals: BillingTotals }> {
  const q = opts.query?.trim();
  const tenants = await db.tenant.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }] } : {},
    orderBy: { name: "asc" },
    select: { id: true, name: true, status: true, subscription: true, _count: { select: { users: { where: { active: true } }, vehicles: { where: { status: { not: "INACTIVE" } } } } } },
  });
  const totals: BillingTotals = {
    mrrCents: null,
    arrCents: null,
    pricedCount: 0,
    byStatus: Object.fromEntries(Object.keys(SUBSCRIPTION_STATUS).map((k) => [k, 0])) as Record<SubscriptionStatus, number>,
    byPlan: Object.fromEntries(Object.keys(PLANS).map((k) => [k, 0])) as Record<PlanKey, number>,
    withoutSubscription: 0,
    trialsEndingSoon: 0,
  };
  const soon = Date.now() + 7 * 24 * 3600_000;
  let mrr = 0;
  for (const t of tenants) {
    const s = t.subscription;
    if (!s) {
      totals.withoutSubscription++;
      continue;
    }
    if (s.status in totals.byStatus) totals.byStatus[s.status as SubscriptionStatus]++;
    if (s.plan in totals.byPlan) totals.byPlan[s.plan as PlanKey]++;
    if (s.status === "TRIAL" && s.trialEndsAt && s.trialEndsAt.getTime() <= soon) totals.trialsEndingSoon++;
    if (s.monthlyPriceCents != null && (BILLABLE_SUBSCRIPTION_STATUS as string[]).includes(s.status)) {
      mrr += s.monthlyPriceCents;
      totals.pricedCount++;
    }
  }
  if (totals.pricedCount > 0) {
    totals.mrrCents = mrr;
    totals.arrCents = mrr * 12;
  }
  const rows = tenants
    .filter((t) => (!opts.status || (opts.status === "NONE" ? !t.subscription : t.subscription?.status === opts.status)) && (!opts.plan || t.subscription?.plan === opts.plan))
    .map((t) => ({ tenantId: t.id, tenantName: t.name, tenantStatus: t.status, subscription: t.subscription, activeUsers: t._count.users, vehicles: t._count.vehicles }));
  return { rows, totals };
}

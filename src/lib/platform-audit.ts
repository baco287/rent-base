// Control Center: mandantenübergreifender Audit-Bereich. Liest das bestehende AuditLog (ein Eintrag je Aktion,
// in derselben Transaktion wie die Aktion geschrieben) – keine zweite Protokolltabelle. Standardansicht sind die
// Plattform-Aktionen (Mandant gesperrt, Feature geändert, Tarif geändert, Benutzerstatus, Supportmodus, Rollen …);
// auf Wunsch lassen sich alle Aktionen eines Mandanten zeigen. Es werden nur Actor, Aktion, Ziel, Zeitpunkt und die
// fachlichen Details (before/after) angezeigt – Passwörter, Tokens oder Verbindungsdaten stehen nie im Protokoll.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AUDIT_ACTIONS, type AuditAction } from "@/lib/constants";
import { fmtDateTime } from "@/lib/format";

export const PLATFORM_AUDIT_ACTIONS = [
  "TENANT_CREATED", "TENANT_SUSPENDED", "TENANT_REACTIVATED",
  "OWNER_INVITED", "USER_INVITED", "INVITATION_RESENT", "INVITATION_REVOKED", "INVITATION_ACCEPTED",
  "USER_ACTIVATED", "USER_DEACTIVATED", "USER_ROLE_CHANGED", "USER_EMAIL_CHANGED",
  "PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_COMPLETED",
  "SUPPORT_SESSION_STARTED", "SUPPORT_SESSION_ENDED",
  "SUPER_ADMIN_GRANTED", "PLATFORM_ROLE_CHANGED",
  "FEATURE_ENABLED", "FEATURE_DISABLED",
  "SUBSCRIPTION_CREATED", "SUBSCRIPTION_UPDATED",
  "SMTP_MODE_CHANGED", "SMTP_SETTINGS_DISABLED", "KEY_DROP_ENABLED", "KEY_DROP_DISABLED",
] as const satisfies readonly AuditAction[];
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];
export const isPlatformAuditAction = (a: string): a is PlatformAuditAction => (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(a);

export type AuditFilter = {
  tenantId?: string;
  action?: string;
  actorId?: string;
  query?: string; // Actor-Name oder Firmenname
  from?: Date;
  to?: Date;
  scope?: "platform" | "all";
  page: number;
  pageSize: number;
};

export type PlatformAuditRow = Prisma.AuditLogGetPayload<{ include: { tenant: { select: { id: true; name: true } } } }>;

export async function listPlatformAudit(f: AuditFilter): Promise<{ rows: PlatformAuditRow[]; total: number }> {
  const q = f.query?.trim();
  const where: Prisma.AuditLogWhereInput = {
    ...(f.tenantId ? { tenantId: f.tenantId } : {}),
    ...(f.action ? { action: f.action } : f.scope === "all" ? {} : { action: { in: [...PLATFORM_AUDIT_ACTIONS] } }),
    ...(f.actorId ? { userId: f.actorId } : {}),
    ...(q ? { OR: [{ userName: { contains: q, mode: "insensitive" } }, { tenant: { name: { contains: q, mode: "insensitive" } } }] } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (f.page - 1) * f.pageSize, take: f.pageSize, include: { tenant: { select: { id: true, name: true } } } }),
    db.auditLog.count({ where }),
  ]);
  return { rows, total };
}

/** Neueste Plattform-Aktionen (Dashboard). */
export function recentPlatformAudit(take = 10) {
  return db.auditLog.findMany({ where: { action: { in: [...PLATFORM_AUDIT_ACTIONS] } }, orderBy: { createdAt: "desc" }, take, include: { tenant: { select: { id: true, name: true } } } });
}

/** Actors, die bereits Plattform-Aktionen ausgeführt haben (Filterliste). */
export async function platformAuditActors(): Promise<{ id: string; name: string }[]> {
  const groups = await db.auditLog.groupBy({ by: ["userId", "userName"], where: { action: { in: [...PLATFORM_AUDIT_ACTIONS] }, userId: { not: null } }, _count: { _all: true } });
  return groups
    .filter((g) => g.userId)
    .map((g) => ({ id: g.userId!, name: g.userName ?? g.userId! }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTIONS as Record<string, string>)[action] ?? action;
}

type Plain = string | number | boolean | null;
/**
 * Details lesbar machen: primitive Felder als „schlüssel: wert“, before/after getrennt. Schlüssel, die Geheimnisse
 * tragen könnten, werden nie ausgegeben – zusätzliche Sicherheit, falls ein künftiger Aufrufer sie doch mitgibt.
 */
const HIDDEN_KEYS = /pass|token|secret|hash|cipher|key$/i;
export function auditDetailsView(details: unknown): { fields: [string, string][]; before: [string, string][]; after: [string, string][] } {
  const out = { fields: [] as [string, string][], before: [] as [string, string][], after: [] as [string, string][] };
  if (!details || typeof details !== "object") return out;
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const fmt = (v: unknown): string => (v == null ? "–" : typeof v === "boolean" ? (v ? "ja" : "nein") : typeof v === "object" ? JSON.stringify(v) : typeof v === "string" && iso.test(v) ? fmtDateTime(v) : String(v as Plain));
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (HIDDEN_KEYS.test(k) && k !== "feature") continue;
    if ((k === "before" || k === "after") && v && typeof v === "object") {
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) if (!HIDDEN_KEYS.test(ik)) out[k].push([ik, fmt(iv)]);
      continue;
    }
    out.fields.push([k, fmt(v)]);
  }
  return out;
}

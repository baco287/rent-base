// Control Center: Systemstatus und Support-Diagnose aus der vorhandenen Infrastruktur. Keine neue Monitoring-Plattform:
// es werden ausschließlich Daten gezeigt, die RentBase ohnehin schreibt (EmailLog, AuditLog, SupportSession,
// TenantMailSettings, AuthorityResponse, Invitation, _prisma_migrations) plus Konfigurationsstatus der Umgebung.
// Sicherheitsregel: nur „gesetzt / fehlt“ je Variable, nie Werte – keine Verbindungszeichenfolgen, Schlüssel oder Passwörter.
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { mailStatus } from "@/lib/mail";
import { storageStatus } from "@/lib/storage";
import { secretKeyStatus } from "@/lib/secret-box";
import { INVITATION_STATUS } from "@/lib/constants";

export type SystemStatus = {
  app: { version: string | null; commit: string | null; nodeVersion: string; env: string; timeZone: string; uptimeSeconds: number; startedAt: Date };
  db: { ok: boolean; latencyMs: number | null; lastMigration: { name: string; finishedAt: Date | null } | null; migrationsApplied: number | null; migrationsPending: number | null };
  mail: { configured: boolean; driver: string; missing: string[] };
  storage: { configured: boolean; driver: string; missing: string[] };
  secretKey: { configured: boolean; invalid: boolean };
  authorityReminders: { enabled: boolean; source: string };
  optional: { name: string; set: boolean; purpose: string }[];
};

function readVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Gesamtstatus für /admin/system. */
export async function systemStatus(): Promise<SystemStatus> {
  const env = process.env;
  const started = Date.now();
  let dbOk = false;
  let latency: number | null = null;
  let lastMigration: SystemStatus["db"]["lastMigration"] = null;
  let migrationsApplied: number | null = null;
  let migrationsPending: number | null = null;
  try {
    await db.$queryRaw`SELECT 1`;
    latency = Date.now() - started;
    dbOk = true;
    const rows = await db.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC`;
    migrationsApplied = rows.filter((r) => r.finished_at && !r.rolled_back_at).length;
    migrationsPending = rows.filter((r) => !r.finished_at && !r.rolled_back_at).length;
    const last = rows.find((r) => r.finished_at && !r.rolled_back_at);
    if (last) lastMigration = { name: last.migration_name, finishedAt: last.finished_at };
  } catch {
    dbOk = false;
  }
  const flag = env.AUTHORITY_REMINDERS?.trim().toLowerCase();
  const remindersEnabled = env.NODE_ENV === "production" ? flag !== "off" : flag === "on";
  const commit = env.SOURCE_COMMIT || env.COMMIT_SHA || env.GIT_COMMIT || null;
  return {
    app: {
      version: readVersion(),
      commit: commit ? commit.slice(0, 12) : null,
      nodeVersion: process.version,
      env: env.NODE_ENV ?? "unbekannt",
      timeZone: env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000),
    },
    db: { ok: dbOk, latencyMs: latency, lastMigration, migrationsApplied, migrationsPending },
    mail: mailStatus(env),
    storage: storageStatus(env),
    secretKey: secretKeyStatus(env),
    authorityReminders: { enabled: remindersEnabled, source: flag ? `AUTHORITY_REMINDERS=${flag}` : env.NODE_ENV === "production" ? "Standard (Produktion: an)" : "Standard (Entwicklung: aus)" },
    optional: [
      { name: "APP_URL", set: Boolean(env.APP_URL), purpose: "Links in Systemmails (Standard https://app.rent-base.de)" },
      { name: "SETUP_KEY", set: Boolean(env.SETUP_KEY), purpose: "Schutz der Ersteinrichtung (/setup)" },
      { name: "RENTBASE_SECRET_KEY_PREVIOUS", set: Boolean(env.RENTBASE_SECRET_KEY_PREVIOUS), purpose: "Schlüsselrotation für verschlüsselte SMTP-Passwörter" },
      { name: "SMTP_ALLOW_PRIVATE_HOSTS", set: Boolean(env.SMTP_ALLOW_PRIVATE_HOSTS), purpose: "Nur Entwicklung: private SMTP-Hosts zulassen" },
    ],
  };
}

export type PlatformDiagnostics = Awaited<ReturnType<typeof platformDiagnostics>>;

/** Plattformweite Auffälligkeiten für /admin/support (Zeitraum in Tagen). */
export async function platformDiagnostics(days = 7) {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const now = new Date();
  const [failedMails, failedMailCount, smtpErrorTenants, failedSubmissions, expiredInvitations, activeSupport, suspended, staleTenants] = await db.$transaction([
    db.emailLog.findMany({ where: { status: "FAILED", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, createdAt: true, template: true, category: true, channel: true, errorCode: true, attempts: true, tenant: { select: { id: true, name: true } } } }),
    db.emailLog.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
    db.tenantMailSettings.findMany({ where: { OR: [{ status: "ERROR" }, { mode: "TENANT_SMTP", status: { not: "VERIFIED" } }] }, select: { tenantId: true, mode: true, status: true, lastErrorCode: true, lastErrorAt: true, tenant: { select: { name: true } } } }),
    db.authorityResponse.findMany({ where: { status: "FAILED", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 25, select: { id: true, createdAt: true, caseId: true, tenant: { select: { id: true, name: true } } } }),
    db.invitation.findMany({ where: { status: "PENDING", expiresAt: { lt: now } }, orderBy: { expiresAt: "desc" }, take: 50, include: { tenant: { select: { id: true, name: true } } } }),
    db.supportSession.findMany({ where: { endedAt: null, expiresAt: { gt: now } }, orderBy: { startedAt: "desc" }, include: { tenant: { select: { id: true, name: true } } } }),
    db.tenant.findMany({ where: { status: "SUSPENDED" }, select: { id: true, name: true, suspendedAt: true, suspendedReason: true, suspendedByName: true }, orderBy: { suspendedAt: "desc" } }),
    // Aktive Mandanten ohne jede Anmeldung in den letzten 30 Tagen (Hinweis auf Abwanderung oder Einrichtungsprobleme)
    db.tenant.findMany({ where: { status: "ACTIVE", users: { none: { lastLoginAt: { gte: new Date(Date.now() - 30 * 24 * 3600_000) } } } }, select: { id: true, name: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 50 }),
  ]);
  return { days, failedMails, failedMailCount, smtpErrorTenants, failedSubmissions, expiredInvitations, activeSupport, suspended, staleTenants };
}

export type TenantDiagnostics = Awaited<ReturnType<typeof tenantDiagnostics>>;

/** Technische Informationen eines einzelnen Mandanten für die Detailseite (Reiter Support/Diagnose). */
export async function tenantDiagnostics(tenantId: string) {
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const now = new Date();
  const [lastLogin, lastAudit, recentAudit, failedMails, mailSent30, mailFailed30, mailPending30, mailSettings, failedSubmissions, pendingInvitations, expiredInvitations, supportSessions, photoCount, documentCount, signatureCount, driverCopyCount, reminderSettings] = await db.$transaction([
    db.user.findFirst({ where: { tenantId, lastLoginAt: { not: null } }, orderBy: { lastLoginAt: "desc" }, select: { lastLoginAt: true, name: true } }),
    db.auditLog.findFirst({ where: { tenantId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, action: true, userName: true } }),
    db.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 15 }),
    db.emailLog.findMany({ where: { tenantId, status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, createdAt: true, template: true, category: true, channel: true, errorCode: true, attempts: true } }),
    db.emailLog.count({ where: { tenantId, status: "SENT", createdAt: { gte: since } } }),
    db.emailLog.count({ where: { tenantId, status: "FAILED", createdAt: { gte: since } } }),
    db.emailLog.count({ where: { tenantId, status: "PENDING", createdAt: { gte: since } } }),
    db.tenantMailSettings.findUnique({ where: { tenantId }, select: { mode: true, status: true, host: true, verifiedAt: true, lastErrorCode: true, lastErrorAt: true } }),
    db.authorityResponse.findMany({ where: { tenantId, status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, createdAt: true, caseId: true } }),
    db.invitation.count({ where: { tenantId, status: "PENDING", expiresAt: { gt: now } } }),
    db.invitation.count({ where: { tenantId, status: "PENDING", expiresAt: { lte: now } } }),
    db.supportSession.findMany({ where: { tenantId }, orderBy: { startedAt: "desc" }, take: 10 }),
    db.photo.count({ where: { tenantId } }),
    db.document.count({ where: { tenantId } }),
    db.signature.count({ where: { tenantId } }),
    db.driverDocumentCopy.count({ where: { tenantId } }),
    db.tenant.findUnique({ where: { id: tenantId }, select: { authorityReminderDays: true, authorityReminderEmail: true, keyDropEnabled: true, logoStorageKey: true, logoUpdatedAt: true } }),
  ]);
  return {
    lastLogin,
    lastAudit,
    recentAudit,
    failedMails,
    mail30: { sent: mailSent30, failed: mailFailed30, pending: mailPending30 },
    mailSettings,
    failedSubmissions,
    invitations: { pending: pendingInvitations, expired: expiredInvitations, expiredLabel: INVITATION_STATUS.EXPIRED },
    supportSessions,
    storage: { photos: photoCount, documents: documentCount, signatures: signatureCount, driverDocumentCopies: driverCopyCount },
    settings: reminderSettings,
  };
}

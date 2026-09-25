// Befehl 20: kontrollierter, zeitlich begrenzter, read-only Supportzugriff eines SUPER_ADMIN auf einen Mandanten.
// Kein automatisches "SUPER_ADMIN darf alles" (item 32/65): Fachdaten eines Mandanten sind nur innerhalb einer
// ausdrücklich gestarteten, protokollierten Supportsession erreichbar. Schreibzugriffe bleiben in Befehl 20
// vollständig gesperrt (item 35), auch innerhalb der Session.
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError } from "@/lib/integrity";
import { SUPPORT_SESSION_MAX_MINUTES, type SupportBlockedKind } from "@/lib/constants";

export type ActiveSupportSession = { id: string; tenantId: string; tenantName: string; reason: string; startedAt: Date; expiresAt: Date };

/** Startet eine Supportsession. Pflichtgrund, feste Höchstdauer, sofort protokolliert. */
export async function startSupportSession(actor: Actor, tenantId: string, reason: string): Promise<ActiveSupportSession> {
  const trimmed = reason.trim();
  if (trimmed.length < 5) throw new DomainError("Bitte einen Grund für den Supportzugriff angeben.");
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
  if (!tenant) throw new DomainError("Mandant nicht gefunden.");
  const expiresAt = new Date(Date.now() + SUPPORT_SESSION_MAX_MINUTES * 60_000);
  const session = await db.$transaction(async (tx) => {
    const session = await tx.supportSession.create({ data: { tenantId, superAdminId: actor.id, superAdminName: actor.name, reason: trimmed, expiresAt } });
    await recordAudit(tx, tenantId, actor, { action: "SUPPORT_SESSION_STARTED", details: { reason: trimmed, supportSessionId: session.id } });
    return session;
  });
  return { id: session.id, tenantId, tenantName: tenant.name, reason: trimmed, startedAt: session.startedAt, expiresAt: session.expiresAt };
}

/** Beendet eine Supportsession vorzeitig (oder markiert eine abgelaufene als beendet). */
export async function endSupportSession(actor: Actor, supportSessionId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const session = await tx.supportSession.findFirst({ where: { id: supportSessionId, superAdminId: actor.id, endedAt: null } });
    if (!session) return; // bereits beendet oder abgelaufen: nichts zu tun, kein Fehler
    await tx.supportSession.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    await recordAudit(tx, session.tenantId, actor, { action: "SUPPORT_SESSION_ENDED", details: { supportSessionId: session.id } });
  });
}

/** Aktive (nicht beendete, nicht abgelaufene) Supportsession des SUPER_ADMIN für genau diesen Mandanten, falls vorhanden. */
export async function activeSupportSession(superAdminId: string, tenantId: string): Promise<ActiveSupportSession | null> {
  const session = await db.supportSession.findFirst({
    where: { superAdminId, tenantId, endedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { startedAt: "desc" },
    include: { tenant: { select: { name: true } } },
  });
  if (!session) return null;
  return { id: session.id, tenantId, tenantName: session.tenant.name, reason: session.reason, startedAt: session.startedAt, expiresAt: session.expiresAt };
}

/** Verlangt eine aktive Supportsession für diesen Mandanten; sonst Fehler statt stillem Zugriff. */
export async function requireSupportSession(superAdminId: string, tenantId: string): Promise<ActiveSupportSession> {
  const session = await activeSupportSession(superAdminId, tenantId);
  if (!session) throw new DomainError("Kein aktiver Supportzugriff für diesen Mandanten. Bitte zuerst eine Supportsession starten.");
  return session;
}

/**
 * Besonders sensible Dokumentarten bleiben auch im Supportmodus gesperrt (item 36): Ausweis-/Führerscheinkopien,
 * Behördendokumente, Schadendokumente. Jede Ausliefer-Route, die im Supportmodus erreichbar ist, ruft dies für
 * die betroffenen Dokumentarten auf – die Funktion lehnt immer ab, sie entscheidet nicht fallweise.
 */
export function blockSensitiveDocumentInSupportMode(kind: SupportBlockedKind): never {
  throw new DomainError(supportBlockedMessage(kind));
}

export function supportBlockedMessage(kind: SupportBlockedKind): string {
  const label = kind === "DRIVER_DOCUMENT_COPY" ? "Ausweis- und Führerscheinkopien" : kind === "AUTHORITY_DOCUMENT" ? "Behördendokumente" : "Schadendokumente";
  return `${label} sind im Supportmodus nicht einsehbar.`;
}

/** Vom SUPER_ADMIN aktuell einsehbare Supportsessions eines Mandanten (Historie für die Mandantenseite). */
export function listSupportSessions(tenantId: string, take = 20) {
  return db.supportSession.findMany({ where: { tenantId }, orderBy: { startedAt: "desc" }, take });
}

import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { SESSION_COOKIE, SESSION_DAYS, SUPPORT_COOKIE, roleAllows, type Role } from "@/lib/constants";

export { hashPassword, verifyPassword } from "@/lib/password";

/** Legt eine Sitzung an und setzt das Cookie. */
export async function createSession(userId: string) {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.session.create({ data: { id, userId, expiresAt } });
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  const id = cookieStore.get(SESSION_COOKIE)?.value;
  if (id) {
    await db.session.deleteMany({ where: { id } });
  }
  cookieStore.delete(SESSION_COOKIE);
}

export type SupportSessionInfo = { id: string; tenantId: string; reason: string; startedAt: Date; expiresAt: Date };

/**
 * Liest die aktuelle Sitzung. Pro Request nur einmal aus der Datenbank (React cache).
 * Gibt null zurück, wenn nicht angemeldet oder die Sitzung abgelaufen ist.
 *
 * Befehl 20 – Supportmodus: ein SUPER_ADMIN mit aktiver Supportsession (zweiter Cookie, serverseitig gegen
 * SupportSession geprüft) sieht denselben `tenant`, den auch die Mitarbeiter dieses Mandanten sehen würden,
 * damit die gesamte bestehende Mandanten-Oberfläche unverändert wiederverwendet werden kann (item 32/56).
 * Die zurückgegebene Rolle wird dabei auf "YARD" (die am wenigsten berechtigte Mandantenrolle) begrenzt, damit
 * überall im bestehenden Code eigenständig weniger Aktionen sichtbar sind. Der eigentliche Schreibschutz ist
 * aber requireRole() selbst (siehe dort) – nie nur die UI. `user.id`/`platformRole`/`realTenantId` bleiben die
 * echten Werte des SUPER_ADMIN, für Audit und für requirePlatform().
 */
export const getSession = cache(async () => {
  const cookieStore = await cookies();
  const id = cookieStore.get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const session = await db.session.findUnique({
    where: { id },
    include: { user: { include: { tenant: true } } },
  });
  if (!session) return null;
  if (session.expiresAt < new Date() || !session.user.active) {
    await db.session.delete({ where: { id } }).catch(() => {});
    return null;
  }
  const { tenant: realTenant, ...user } = session.user;

  const supportCookie = cookieStore.get(SUPPORT_COOKIE)?.value;
  if (supportCookie && user.platformRole === "SUPER_ADMIN") {
    const support = await db.supportSession.findFirst({ where: { id: supportCookie, superAdminId: user.id, endedAt: null, expiresAt: { gt: new Date() } }, include: { tenant: true } });
    if (support) {
      const supportSession: SupportSessionInfo = { id: support.id, tenantId: support.tenantId, reason: support.reason, startedAt: support.startedAt, expiresAt: support.expiresAt };
      return { user: { ...user, role: "YARD" as const }, tenant: support.tenant, supportSession, realUser: user, realTenant };
    }
  }
  return { user, tenant: realTenant, supportSession: null as SupportSessionInfo | null, realUser: user, realTenant };
});

/**
 * Für geschützte Seiten: leitet zum Login um, wenn keine Sitzung besteht. Ist der Mandant gesperrt (Befehl 20,
 * item 11), führt keine bestehende Sitzung mehr zu einer Mutation oder Fachseite – auch nicht heimlich weiter:
 * jeder Aufruf leitet auf /gesperrt um. Die Sperrseite selbst und requirePlatform() (Plattformebene, unabhängig
 * vom Mandantenstatus) übergeben skipSuspensionCheck, sonst gäbe es eine Umleitungsschleife.
 */
export async function requireSession(opts: { skipSuspensionCheck?: boolean } = {}) {
  const session = await getSession();
  if (!session) redirect("/login?abgelaufen=1");
  // Supportsessions dürfen auch einen gesperrten Mandanten lesend zeigen (sonst ließe sich ein gesperrter
  // Mandant nicht mehr diagnostizieren); requireRole() bleibt trotzdem read-only, siehe dort.
  if (!opts.skipSuspensionCheck && !session.supportSession && session.tenant.status === "SUSPENDED") redirect("/gesperrt");
  return session;
}

/**
 * Rollenmatrix (nur hier und in den Aufrufen von requireRole):
 *   OWNER  alles
 *   DISPO  Buchungen anlegen/ändern/stornieren, Fahrzeuge und Gruppen, Mietverträge erstellen/bearbeiten/abschließen,
 *          Übergabe und Rückgabe, Kunden, Dokumente, E-Mail erneut senden
 *   YARD   Kunden anlegen und ergänzen, Übergabe und Rückgabe (Kilometer, Tank, Schäden, Fotos, Checkliste,
 *          Unterschriften, Zusatzkosten), Verträge und Protokolle ansehen, Dokumente, E-Mail erneut senden.
 *          Keine Buchungen, keine Vertragsänderungen, kein Vertragsabschluss, keine Einstellungen.
 *   Schadenakten (Phase 12): OWNER und DISPO alle Aktenvorgänge (Status, Haftung, Kosten, Reparatur, Sperren/Freigeben,
 *          Kundenbelastung, Schadenabrechnung, Schließen/Wiederöffnen). YARD sieht Akten, eröffnet sie, ergänzt Fotos,
 *          Dokumente und operative Notizen – keine Haftung, keine Kosten, keine Belastung, kein Fahrzeugstatus, kein Abschluss.
 */
/**
 * Zusätzlich Rollenprüfung. Inhaber darf alles. Jede Server Action und jede geschützte Seite ruft dies als Erstes auf.
 * Befehl 20: eine aktive Supportsession ist immer read-only (item 35) – unabhängig davon, welche Rolle sonst
 * zutreffen würde. Das ist der eigentliche Schreibschutz, nicht nur die auf "YARD" begrenzte Anzeige in getSession().
 */
export async function requireRole(...roles: Role[]) {
  const session = await requireSession();
  if (session.supportSession) redirect("/heute?fehler=support");
  if (!roleAllows(session.user.role, roles)) redirect("/heute?fehler=rechte");
  return session;
}

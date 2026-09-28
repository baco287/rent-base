import "server-only";
import { redirect } from "next/navigation";
import { requireSession, type AppSession } from "@/lib/auth";
import { isInternalRole, platformAllows, type PlatformPermission } from "@/lib/constants";

/**
 * Plattformebene (Befehl 20 / Control Center): interne RentBase-Rollen sind keine Mandantenrollen und kein "stärkerer
 * OWNER" – sie gehören zur RentBase-Plattform, nicht zu einem Autovermietungsmandanten. requirePlatform() prüft
 * ausschließlich user.platformRole, nie user.role. Jede /admin-Seite und jede Plattform-Server-Action ruft dies zuerst
 * auf – mit der konkret benötigten Berechtigung aus PLATFORM_PERMISSIONS (Matrix in lib/constants.ts):
 *   requirePlatform()                  Zugang zum Control Center (jede interne Rolle)
 *   requirePlatform("TENANT_SUSPEND")  nur Rollen, die laut Matrix sperren dürfen
 * Ohne interne Rolle: zurück zur Mandantenoberfläche. Mit interner Rolle, aber ohne die Berechtigung: Hinweis im
 * Control Center. Eine interne Rolle darf dadurch NICHT automatisch normale Mandanten-Server-Actions ausführen
 * (item 32/65): Fachdaten eines Mandanten sind nur über eine ausdrücklich gestartete Supportsession erreichbar.
 */
export async function requirePlatform(permission?: PlatformPermission) {
  const session = await requireSession({ skipSuspensionCheck: true });
  if (!isInternalRole(session.user.platformRole)) redirect("/heute?fehler=rechte");
  if (permission && !platformAllows(session.user.platformRole, permission)) redirect("/admin?fehler=rechte");
  return session;
}

/** Für die Oberfläche: darf die angemeldete interne Rolle das? Entscheidend bleibt immer requirePlatform(permission) serverseitig. */
export function can(session: Pick<AppSession, "user">, permission: PlatformPermission): boolean {
  return platformAllows(session.user.platformRole, permission);
}

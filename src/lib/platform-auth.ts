import "server-only";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";

/**
 * Plattformebene (Befehl 20): SUPER_ADMIN ist keine Mandantenrolle und kein "stärkerer OWNER" – er gehört zur
 * RentBase-Plattform, nicht zu einem Autovermietungsmandanten. requirePlatform() prüft ausschließlich
 * user.platformRole, nie user.role. Jede /admin-Seite und jede Plattform-Server-Action ruft dies zuerst auf.
 * Ein SUPER_ADMIN darf dadurch NICHT automatisch normale Mandanten-Server-Actions ausführen (item 32/65):
 * Fachdaten eines Mandanten sind nur über eine ausdrücklich gestartete Supportsession erreichbar (lib/support-sessions.ts).
 */
export async function requirePlatform() {
  const session = await requireSession({ skipSuspensionCheck: true });
  if (session.user.platformRole !== "SUPER_ADMIN") redirect("/heute?fehler=rechte");
  return session;
}

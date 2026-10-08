// Befehl 29.3.1: Rahmen des Einstellungscenters – helle Kategorienavigation neben dem Inhalt der gewählten Kategorie.
// Die Navigation zeigt nur erlaubte Bereiche; jede Seite prüft ihre Rechte weiterhin selbst (dieses Layout ersetzt
// keine Prüfung, es kennt nur Rolle, Supportmodus und Modulfreischaltung für die Anzeige).
import { requireSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { settingsNav } from "@/lib/settings-nav";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { tenant, user, supportSession } = await requireSession();
  const groups = settingsNav({ role: user.role, supportSession: Boolean(supportSession), smtpFeature: await isFeatureEnabled(tenant.id, "TENANT_SMTP") });
  return (
    <div className="flex-1 min-w-0 flex flex-col md:flex-row">
      <SettingsNav groups={groups} tenantName={tenant.name} />
      <div className="flex-1 min-w-0 flex flex-col">{children}</div>
    </div>
  );
}

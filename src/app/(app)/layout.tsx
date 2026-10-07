import Link from "next/link";
import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { ROLES, type Role } from "@/lib/constants";
import { AppShell } from "@/components/app-shell";
import { logoutAction } from "@/app/(auth)/actions";
import { endSupportSessionAction } from "@/app/admin/actions";
import { hiddenNavPaths, tenantFeatures } from "@/lib/features";
import { navBadges } from "@/lib/nav-badges";
import { NAV_COLLAPSED_COOKIE, isoWeekBerlin, quickActionsFor, todayLabelBerlin } from "@/lib/navigation";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, tenant, supportSession } = await requireSession();
  // Control Center: gesperrte Module verschwinden aus der Navigation; die eigentliche Sperre ist requireFeature() serverseitig
  const hiddenPaths = hiddenNavPaths(await tenantFeatures(tenant.id));
  // Vorschlag 4: offene Arbeit direkt am Menüpunkt
  const badges = await navBadges(tenant.id, hiddenPaths);
  // Befehl 29.2: Schnellaktionen in der Kopfleiste – gleiche Regeln wie vorher, im Supportmodus (read-only) keine
  const quick = quickActionsFor(user.role, !!supportSession);
  // Befehl 29.2: eingeklappte Seitenleiste als Nutzerwahl (Cookie), damit der Server gleich die richtige Breite rendert
  const collapsed = (await cookies()).get(NAV_COLLAPSED_COOKIE)?.value === "1";
  const now = new Date();

  return (
    <AppShell
      tenantName={tenant.name}
      tenantCity={tenant.city}
      // Befehl 20.8: dieselbe Logoquelle wie PDFs und Geschäftsmails (Befehl 20.5), geschützt ausgeliefert je Sitzung/Mandant
      logoVersion={tenant.logoStorageKey && tenant.logoChecksum ? (tenant.logoUpdatedAt?.toISOString() ?? "0") : null}
      userName={user.name}
      userRole={ROLES[user.role as Role] ?? user.role}
      logoutAction={logoutAction}
      hiddenPaths={hiddenPaths}
      badges={badges}
      quick={quick}
      initialCollapsed={collapsed}
      todayLabel={todayLabelBerlin(now)}
      kw={isoWeekBerlin(now)}
      banners={
        <>
          {supportSession && (
            <div className="bg-amber text-white text-sm px-4 py-2 flex items-center justify-between gap-3">
              <span>SUPPORTMODUS – {tenant.name} · read-only · „{supportSession.reason}“</span>
              <form action={endSupportSessionAction}><button type="submit" className="underline underline-offset-2">Supportmodus verlassen</button></form>
            </div>
          )}
          {!supportSession && tenant.status === "PENDING_SETUP" && user.role === "OWNER" && (
            <div className="bg-brand-soft text-brand text-sm px-4 py-2 flex items-center justify-between gap-3">
              <span>Die Einrichtung von {tenant.name} ist noch nicht abgeschlossen.</span>
              <Link href="/einrichtung" className="underline underline-offset-2">Einrichtung fortsetzen</Link>
            </div>
          )}
        </>
      }
    >
      {children}
    </AppShell>
  );
}

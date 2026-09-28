import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { ROLES, type Role } from "@/lib/constants";
import { Sidebar } from "@/components/sidebar";
import { logoutAction } from "@/app/(auth)/actions";
import { endSupportSessionAction } from "@/app/admin/actions";
import { hiddenNavPaths, tenantFeatures } from "@/lib/features";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, tenant, supportSession } = await requireSession();
  // Control Center: gesperrte Module verschwinden aus der Navigation; die eigentliche Sperre ist requireFeature() serverseitig
  const hiddenPaths = hiddenNavPaths(await tenantFeatures(tenant.id));

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-[220px_1fr] min-h-screen">
      <Sidebar
        tenantName={tenant.name}
        tenantCity={tenant.city}
        // Befehl 20.8: dieselbe Logoquelle wie PDFs und Geschäftsmails (Befehl 20.5), geschützt ausgeliefert je Sitzung/Mandant
        logoVersion={tenant.logoStorageKey && tenant.logoChecksum ? (tenant.logoUpdatedAt?.toISOString() ?? "0") : null}
        userName={user.name}
        userRole={ROLES[user.role as Role] ?? user.role}
        logoutAction={logoutAction}
        hiddenPaths={hiddenPaths}
      />
      <main className="min-w-0 flex flex-col">
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
        {children}
      </main>
    </div>
  );
}

import Link from "next/link";
import { can, requirePlatform } from "@/lib/platform-auth";
import { logoutAction } from "@/app/(auth)/actions";
import { endSupportSessionAction } from "@/app/admin/actions";
import { PLATFORM_ROLES, type PlatformPermission, type PlatformRole } from "@/lib/constants";
import { AdminNav, type AdminNavItem } from "./admin-nav";

/**
 * RentBase Control Center (Befehl 20 / Ausbau): eigener interner Bereich, bewusst optisch von der Mandantenoberfläche
 * abgesetzt (dunkle Leiste, „Intern“-Kennung) und nicht mit der normalen Navigation vermischt. requirePlatform() prüft
 * ausschließlich platformRole – ein Tenant-User (auch OWNER) kommt hier nie hinein. Die Navigation zeigt nur, was die
 * interne Rolle laut Matrix darf; die eigentliche Sperre ist requirePlatform(permission) in jeder Seite und Aktion.
 */
const NAV: (AdminNavItem & { permission: PlatformPermission })[] = [
  { href: "/admin", label: "Dashboard", hint: "Plattformübersicht", permission: "PLATFORM_VIEW" },
  { href: "/admin/mandanten", label: "Kunden", hint: "Mandanten", permission: "PLATFORM_VIEW" },
  { href: "/admin/benutzer", label: "Benutzer", hint: "mandantenübergreifend", permission: "USERS_VIEW" },
  { href: "/admin/abos", label: "Abos", hint: "Tarife & Limits", permission: "BILLING_VIEW" },
  { href: "/admin/features", label: "Features", hint: "Freischaltungen", permission: "FEATURES_VIEW" },
  { href: "/admin/support", label: "Support", hint: "Diagnose", permission: "SUPPORT_VIEW" },
  { href: "/admin/audit", label: "Audit Log", permission: "AUDIT_VIEW" },
  { href: "/admin/system", label: "System", hint: "Status & interne Rollen", permission: "SYSTEM_VIEW" },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const session = await requirePlatform();
  const { user, supportSession } = session;
  const items = NAV.filter((n) => can(session, n.permission)).map(({ href, label, hint }) => ({ href, label, hint }));

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-[240px_1fr] min-h-screen">
      <aside className="bg-ink text-white flex flex-col p-4 gap-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-display text-lg font-bold leading-tight">RentBase</div>
            <div className="text-xs text-white/60">Control Center</div>
          </div>
          <span className="chip bg-amber text-white text-[10px] tracking-wide uppercase">Intern</span>
        </div>
        <AdminNav items={items} />
        <div className="mt-auto text-xs text-white/70 flex flex-col gap-2 border-t border-white/15 pt-3">
          <div className="truncate" title={user.email}>{user.name}</div>
          <div className="text-white/50">{PLATFORM_ROLES[user.platformRole as PlatformRole] ?? user.platformRole}</div>
          <div className="flex items-center gap-3">
            <Link href="/heute" className="hover:text-white underline-offset-2 hover:underline">Zur Mandantenoberfläche</Link>
            <form action={logoutAction}><button type="submit" className="text-white/80 hover:text-white">Abmelden</button></form>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex flex-col">
        {supportSession && (
          <div className="bg-amber text-white text-sm px-4 py-2 flex items-center justify-between gap-3">
            <span>Supportmodus aktiv für „{session.tenant.name}“ (read-only). Die Mandantenoberfläche zeigt diesen Mandanten.</span>
            <form action={endSupportSessionAction}><button type="submit" className="underline underline-offset-2">Supportmodus beenden</button></form>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

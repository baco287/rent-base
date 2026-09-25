import Link from "next/link";
import { requirePlatform } from "@/lib/platform-auth";
import { logoutAction } from "@/app/(auth)/actions";

/**
 * Befehl 20, item 6: eigener Bereich, bewusst nicht mit der normalen Mandanten-Navigation vermischt.
 * requirePlatform() prüft ausschließlich platformRole – ein Tenant-User (auch OWNER) kommt hier nie hinein.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const { user } = await requirePlatform();

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-[220px_1fr] min-h-screen">
      <aside className="bg-ink text-white flex flex-col p-4 gap-4">
        <div>
          <div className="font-display text-lg font-bold">RentBase</div>
          <div className="text-xs text-white/60">Administration</div>
        </div>
        <nav className="flex flex-col gap-1 text-sm">
          <Link href="/admin" className="rounded-md px-3 py-2 hover:bg-white/10">Übersicht</Link>
          <Link href="/admin/mandanten" className="rounded-md px-3 py-2 hover:bg-white/10">Mandanten</Link>
        </nav>
        <div className="mt-auto text-xs text-white/60 flex flex-col gap-2">
          <div>{user.name}</div>
          <form action={logoutAction}><button type="submit" className="text-white/80 hover:text-white">Abmelden</button></form>
        </div>
      </aside>
      <main className="min-w-0 flex flex-col">{children}</main>
    </div>
  );
}

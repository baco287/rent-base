"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type AdminNavItem = { href: string; label: string; hint?: string };

/** Navigation des Control Centers. Sichtbarkeit je Rolle entscheidet das Layout (Matrix), die Sperre requirePlatform(permission). */
export function AdminNav({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname();
  const matches = items.filter((x) => pathname === x.href || pathname.startsWith(x.href + "/")).sort((a, b) => b.href.length - a.href.length);
  const activeHref = matches[0]?.href;
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Control Center">
      {items.map((n) => {
        const active = n.href === activeHref;
        return (
          <Link key={n.href} href={n.href} className={`flex flex-col px-3 py-2 rounded-md text-[13.5px] transition-colors ${active ? "bg-white/15 font-semibold" : "text-white/85 hover:bg-white/10 hover:text-white"}`}>
            <span>{n.label}</span>
            {n.hint && <span className="text-[11px] text-white/50 font-normal">{n.hint}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

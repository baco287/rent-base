"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV = [
  { href: "/heute", label: "Heute", icon: "grid" },
  { href: "/dispo", label: "Dispo-Kalender", icon: "calendar" },
  { href: "/fahrzeuge", label: "Fahrzeuge", icon: "car" },
  { href: "/fahrzeuge/wartung", label: "Wartung", icon: "wrench" },
  { href: "/kunden", label: "Kunden", icon: "user" },
  { href: "/buchungen", label: "Buchungen", icon: "doc" },
  { href: "/rechnungen", label: "Rechnungen", icon: "euro" },
  { href: "/schaeden", label: "Schäden", icon: "warn" },
  { href: "/einstellungen", label: "Einstellungen", icon: "cog" },
] as const;

function Icon({ name }: { name: (typeof NAV)[number]["icon"] }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "grid": return <svg {...p}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>;
    case "calendar": return <svg {...p}><rect x="2" y="3" width="12" height="11" rx="1.5" /><path d="M2 7h12M5 2v2M11 2v2" /></svg>;
    case "car": return <svg {...p}><path d="M2 10l1.5-4h9L14 10v3H2z" /><circle cx="5" cy="12" r="1" /><circle cx="11" cy="12" r="1" /></svg>;
    case "user": return <svg {...p}><circle cx="8" cy="5.5" r="3" /><path d="M2.5 14c.5-3 2.5-4.5 5.5-4.5s5 1.5 5.5 4.5" /></svg>;
    case "doc": return <svg {...p}><path d="M4 2h6l3 3v9H4z" /><path d="M6 8h4M6 11h4" /></svg>;
    case "euro": return <svg {...p}><path d="M12 3.5A5 5 0 0 0 4.5 8a5 5 0 0 0 7.5 4.5M2.5 6.5h7M2.5 9.5h7" /></svg>;
    case "wrench": return <svg {...p}><path d="M10.5 2.5a3.5 3.5 0 0 0-3.3 4.6L2.5 11.8l1.7 1.7 4.7-4.7a3.5 3.5 0 0 0 4.6-3.3l-2 2-1.7-.4-.4-1.7z" /></svg>;
    case "warn": return <svg {...p}><path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3M8 11.2v.3" /></svg>;
    case "cog": return <svg {...p}><circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></svg>;
  }
}

export function Sidebar(props: {
  tenantName: string;
  tenantCity: string | null;
  userName: string;
  userRole: string;
  logoutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const matches = NAV.filter((x) => pathname === x.href || pathname.startsWith(x.href + "/")).sort((a, b) => b.href.length - a.href.length);
        const active = matches[0]?.href === n.href;
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={() => setOpen(false)}
            className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13.5px] transition-colors ${
              active ? "bg-white/15 font-semibold" : "opacity-85 hover:bg-white/10 hover:opacity-100"
            }`}
          >
            <Icon name={n.icon} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Mobile-Kopfzeile */}
      <div className="md:hidden bg-brand text-brand-ink flex items-center justify-between px-4 py-3">
        <div className="font-display font-semibold text-lg">{props.tenantName}</div>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Menü" className="px-2 py-1 rounded border border-white/30">
          ☰
        </button>
      </div>
      <aside className={`${open ? "block" : "hidden"} md:flex bg-brand text-brand-ink p-3.5 md:min-h-screen flex-col gap-1`}>
        <div className="hidden md:block px-2.5 pt-1.5 pb-4 mb-2.5 border-b border-white/20">
          <div className="font-display text-lg font-semibold leading-tight">{props.tenantName}</div>
          {props.tenantCity && <div className="text-xs opacity-75">{props.tenantCity}</div>}
        </div>
        {nav}
        <div className="mt-auto pt-4 px-2.5 text-xs opacity-75 flex items-center justify-between gap-2">
          <span className="truncate">{props.userName} · {props.userRole}</span>
          <form action={props.logoutAction}>
            <button type="submit" className="underline-offset-2 hover:underline">Abmelden</button>
          </form>
        </div>
      </aside>
    </>
  );
}

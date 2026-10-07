"use client";

// Befehl 29.2: dunkle, gruppierte Seitenleiste. Ein einziges <aside> für alle Breiten:
//  · < 768 px: Menü als Drawer von links (Öffnen über die Kopfleiste)
//  · 768–1023 px: schmale Icon-Leiste mit Tooltip
//  · ab 1024 px: volle Leiste, einklappbar zur Icon-Leiste
// Die Einträge kommen aus src/lib/navigation.ts; gesperrte Module blendet hiddenPaths aus (Control Center),
// die eigentliche Rechteprüfung bleibt serverseitig auf jeder Seite.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { activeNavHref, initialsOf, visibleNavGroups, visibleSystemItems, type NavItem } from "@/lib/navigation";
import type { NavBadges } from "@/lib/nav-badges";
import { ShellIcon } from "@/components/shell-icons";

// Zähler (Vorschlag 4): Ton aus nav-badges.ts unverändert – Rot nur bei „bad“ (überfällig/ungeklärt), sonst Hinweis
const BADGE_TONE = { info: "bg-white/12 text-shell-ink", warn: "bg-shell-warn text-[#2b1700]", bad: "bg-shell-bad text-white" } as const;

export type SidebarProps = {
  id: string;
  tenantName: string;
  tenantCity: string | null;
  /** Mandantenlogo (geschützte Route je Sitzung) oder null – dann nur Name und Ort */
  logoSrc: string | null;
  userName: string;
  userRole: string;
  logoutAction: () => Promise<void>;
  hiddenPaths: readonly string[];
  badges?: NavBadges;
  /** Leiste ab 1024 px eingeklappt (Nutzerwahl, Cookie) */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Icon-Leiste aktiv (768–1023 px oder eingeklappt) – steuert nur die Tooltips */
  rail: boolean;
  /** Drawer unter 768 px offen */
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onHint: (hint: { text: string; x: number; y: number } | null) => void;
};

export function AppSidebar(p: SidebarProps) {
  const pathname = usePathname();
  const asideRef = useRef<HTMLElement>(null);
  const groups = visibleNavGroups(p.hiddenPaths);
  const system = visibleSystemItems(p.hiddenPaths);
  const active = activeNavHref(pathname, [...groups.flatMap((g) => g.items), ...system]);

  // Darstellung je Modus – statische Klassen, damit Tailwind sie findet
  const c = p.collapsed;
  const wideBlock = c ? "md:hidden" : "md:hidden lg:block";
  const railBlock = c ? "hidden md:block" : "hidden md:block lg:hidden";
  const labelCls = c ? "md:sr-only" : "md:sr-only lg:not-sr-only";
  const itemLayout = c ? "md:justify-center md:px-0" : "md:justify-center md:px-0 lg:justify-start lg:px-2.5";
  const badgeLayout = c
    ? "md:absolute md:-top-0.5 md:right-1 md:min-w-4 md:h-4 md:px-1 md:text-[10px] md:leading-4 md:ml-0"
    : "md:absolute md:-top-0.5 md:right-1 md:min-w-4 md:h-4 md:px-1 md:text-[10px] md:leading-4 md:ml-0 lg:static lg:min-w-[18px] lg:h-[18px] lg:px-1.5 lg:text-[11px] lg:leading-[18px] lg:ml-auto";

  const hint = (e: { currentTarget: HTMLElement }, text: string) => {
    if (!p.rail) return;
    const r = e.currentTarget.getBoundingClientRect();
    p.onHint({ text, x: r.right + 10, y: r.top + r.height / 2 });
  };
  const unhint = () => p.onHint(null);

  // Fokus im offenen Drawer halten (Tab/Umschalt+Tab), Escape schließt
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!p.mobileOpen) return;
    if (e.key === "Escape") { e.preventDefault(); p.onCloseMobile(); return; }
    if (e.key !== "Tab") return;
    const f = Array.from(asideRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []).filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const item = (n: NavItem) => {
    const on = active === n.href;
    const b = p.badges?.[n.href];
    return (
      <li key={n.href}>
        <Link
          href={n.href}
          aria-current={on ? "page" : undefined}
          onClick={p.onCloseMobile}
          onMouseEnter={(e) => hint(e, b ? `${n.label} · ${b.title}` : n.label)}
          onMouseLeave={unhint}
          onFocus={(e) => hint(e, b ? `${n.label} · ${b.title}` : n.label)}
          onBlur={unhint}
          className={`group/item relative flex items-center gap-3 h-9 px-2.5 rounded-md text-[13.5px] outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-shell-accent ${itemLayout} ${
            on ? "bg-shell-active text-white font-medium" : "text-shell-ink-2 hover:bg-white/[0.06] hover:text-shell-ink"
          }`}
        >
          <ShellIcon name={n.icon} className={`shrink-0 ${on ? "text-shell-accent" : "text-shell-ink-3 group-hover/item:text-shell-ink-2"}`} />
          <span className={`truncate ${labelCls}`}>{n.label}</span>
          {b && (
            <span title={b.title} className={`ml-auto shrink-0 min-w-[18px] h-[18px] px-1.5 rounded-full text-center text-[11px] font-semibold leading-[18px] tnum ${BADGE_TONE[b.tone]} ${badgeLayout}`}>
              <span aria-hidden="true">{b.count > 99 ? "99+" : b.count}</span>
              <span className="sr-only">, {b.title}</span>
            </span>
          )}
        </Link>
      </li>
    );
  };

  return (
    <aside
      ref={asideRef}
      id={p.id}
      aria-label="Hauptnavigation"
      onKeyDown={onKeyDown}
      className={`print:hidden bg-shell text-shell-ink flex flex-col fixed inset-y-0 left-0 z-40 w-[280px] max-w-[86vw] shadow-2xl duration-200 motion-reduce:transition-none ${
        // Öffnen: sofort sichtbar (Fokus kann hinein), nur die Bewegung animiert; Schließen: erst am Ende unsichtbar
        p.mobileOpen ? "translate-x-0 visible transition-[translate]" : "-translate-x-full invisible transition-[translate,visibility]"
      } md:visible md:translate-none md:shadow-none md:sticky md:top-0 md:self-start md:h-dvh md:z-auto md:max-w-none md:transition-[width] md:motion-reduce:transition-none md:w-[68px] ${c ? "" : "lg:w-[232px]"}`}
    >
      {/* Als Drawer (unter 768 px) ein modaler Dialog – die Rolle sitzt innen, weil <aside> keine Dialog-Rolle tragen darf */}
      <div role={p.mobileOpen ? "dialog" : undefined} aria-modal={p.mobileOpen ? true : undefined} aria-label={p.mobileOpen ? "Navigation" : undefined} className="flex flex-col h-full min-h-0">
        {/* Produkt und Mandant */}
        <div className={`flex items-center h-14 shrink-0 px-4 border-b border-shell-line ${c ? "md:justify-center md:px-0" : "md:justify-center md:px-0 lg:justify-start lg:px-4"}`}>
          <span className={`font-display text-[19px] font-semibold tracking-[0.01em] text-white ${wideBlock}`}>RentBase</span>
          <span className={`font-display text-[17px] font-semibold text-white ${railBlock}`} aria-hidden="true">RB</span>
          <button type="button" onClick={p.onCloseMobile} aria-label="Menü schließen" className="md:hidden ml-auto grid place-items-center h-9 w-9 rounded-md text-shell-ink-2 hover:bg-white/[0.08] hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-shell-accent">
            <ShellIcon name="close" />
          </button>
        </div>
        <div className={`shrink-0 px-4 py-3 flex items-center gap-2.5 min-w-0 ${c ? "md:justify-center md:px-0" : "md:justify-center md:px-0 lg:justify-start lg:px-4"}`} title={p.rail ? [p.tenantName, p.tenantCity].filter(Boolean).join(" · ") : undefined}>
          {p.logoSrc ? (
            // Mandantenlogo proportional in einer hellen Kachel (Logos sind meist für hellen Grund gestaltet)
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.logoSrc} alt={`Logo ${p.tenantName}`} className="h-9 w-9 shrink-0 rounded-md bg-white object-contain p-1" />
          ) : (
            <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white/[0.08] text-[13px] font-semibold text-shell-ink">{initialsOf(p.tenantName)}</span>
          )}
          <span className={`min-w-0 ${labelCls}`}>
            <span className="block truncate text-[13.5px] font-medium text-shell-ink">{p.tenantName}</span>
            {p.tenantCity && <span className="block truncate text-[11.5px] text-shell-ink-3">{p.tenantCity}</span>}
          </span>
        </div>

        <nav aria-label="Bereiche" onScroll={unhint} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2.5 pt-1 pb-3 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.14)_transparent]">
          {groups.map((g, i) => (
            <div key={g.key} className={i === 0 ? "" : "mt-3"}>
              {g.label && (
                <>
                  <p id={`nav-g-${g.key}`} className={`px-2.5 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-shell-ink-3 ${wideBlock}`}>{g.label}</p>
                  <div aria-hidden="true" className={`mx-3 mb-2 border-t border-shell-line ${railBlock}`} />
                </>
              )}
              <ul className="flex flex-col gap-0.5" aria-labelledby={g.label ? `nav-g-${g.key}` : undefined}>{g.items.map(item)}</ul>
            </div>
          ))}
        </nav>

        {/* System und Konto */}
        <div className="shrink-0 border-t border-shell-line px-2.5 py-2.5 flex flex-col gap-0.5">
          <ul className="flex flex-col gap-0.5">{system.map(item)}</ul>
          <button
            type="button"
            onClick={() => { p.onToggleCollapsed(); unhint(); }}
            aria-label={c ? "Seitenleiste ausklappen" : "Seitenleiste einklappen"}
            aria-controls={p.id}
            aria-expanded={!c}
            onMouseEnter={(e) => hint(e, c ? "Seitenleiste ausklappen" : "Seitenleiste einklappen")}
            onMouseLeave={unhint}
            className={`hidden lg:flex items-center gap-3 h-9 px-2.5 rounded-md text-[13px] text-shell-ink-3 hover:bg-white/[0.06] hover:text-shell-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-shell-accent ${c ? "lg:justify-center lg:px-0" : ""}`}
          >
            <ShellIcon name={c ? "expand" : "collapse"} className="shrink-0" />
            <span className={c ? "sr-only" : ""}>Einklappen</span>
          </button>
          <div className={`mt-1.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 ${c ? "md:flex-col md:px-0 md:gap-1.5" : "md:flex-col md:px-0 md:gap-1.5 lg:flex-row lg:px-2 lg:gap-2.5"}`}>
            <span aria-hidden="true" title={p.rail ? `${p.userName} · ${p.userRole}` : undefined} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.1] text-[12px] font-semibold text-shell-ink">{initialsOf(p.userName)}</span>
            <span className={`min-w-0 flex-1 ${labelCls}`}>
              <span className="block truncate text-[13px] text-shell-ink">{p.userName}</span>
              <span className="block truncate text-[11.5px] text-shell-ink-3">{p.userRole}</span>
            </span>
            <form action={p.logoutAction}>
              <button
                type="submit"
                aria-label="Abmelden"
                onMouseEnter={(e) => hint(e, "Abmelden")}
                onMouseLeave={unhint}
                className="grid h-8 w-8 place-items-center rounded-md text-shell-ink-3 hover:bg-white/[0.08] hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-shell-accent"
              >
                <ShellIcon name="logout" size={17} />
              </button>
            </form>
          </div>
        </div>
      </div>
    </aside>
  );
}

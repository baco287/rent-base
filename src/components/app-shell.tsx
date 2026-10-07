"use client";

// Befehl 29.2: App-Shell der Vermieter-Oberfläche – Seitenleiste, Kopfleiste, globale Suche (einmalig, Strg/Cmd+K)
// und Tooltips der Icon-Leiste. Reine Darstellung: Daten, Rechte und Zähler liefert das Server-Layout.
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { SearchDialog, useGlobalSearchShortcut } from "@/components/global-search";
import { NAV_COLLAPSED_COOKIE } from "@/lib/navigation";
import type { NavBadges } from "@/lib/nav-badges";

function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function AppShell(p: {
  tenantName: string;
  tenantCity: string | null;
  logoVersion: string | null;
  userName: string;
  userRole: string;
  logoutAction: () => Promise<void>;
  hiddenPaths: readonly string[];
  badges?: NavBadges;
  quick: { booking: boolean; customer: boolean };
  initialCollapsed: boolean;
  todayLabel: string;
  kw: number;
  /** Hinweisbalken (Supportmodus, Einrichtung) über der Kopfleiste */
  banners?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const navId = useId();
  const [collapsed, setCollapsed] = useState(p.initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hint, setHint] = useState<{ text: string; x: number; y: number } | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const searchReturn = useRef<HTMLElement | null>(null);
  // dieselben Grenzen wie Tailwind (md 48rem, lg 64rem) – in rem, damit sie bei größerer Browserschrift mitwandern
  const isMd = useMedia("(min-width: 48rem)");
  const isLg = useMedia("(min-width: 64rem)");
  const rail = isMd && (collapsed || !isLg);
  const logoSrc = p.logoVersion != null ? `/api/branding/logo?v=${encodeURIComponent(p.logoVersion)}` : null;

  // Drawer: bei Seitenwechsel schließen (Zustand beim Rendern angleichen, kein Effekt); ab 768 px gibt es keinen Drawer
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setMobileOpen(false);
    setHint(null);
  }
  if (isMd && mobileOpen) setMobileOpen(false);
  const drawerOpen = mobileOpen && !isMd;
  const shownHint = rail ? hint : null;

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  // Drawer war offen (für die Fokus-Rückgabe an den Menü-Knopf)
  const wasOpen = useRef(false);
  const searchOpenRef = useRef(false);
  const openSearch = useCallback(() => {
    // Rücksprungziel nur beim ersten Öffnen merken; aus dem Drawer heraus zurück auf den sichtbaren Menü-Knopf
    if (!searchOpenRef.current) {
      const a = document.activeElement;
      searchReturn.current = wasOpen.current ? menuButton.current : a instanceof HTMLElement && a !== document.body ? a : null;
    }
    searchOpenRef.current = true;
    wasOpen.current = false; // der Drawer-Effekt soll dem Suchfeld den Fokus nicht wieder wegnehmen
    setMobileOpen(false);
    setSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => { searchOpenRef.current = false; setSearchOpen(false); }, []);
  useGlobalSearchShortcut(openSearch);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      document.cookie = `${NAV_COLLAPSED_COOKIE}=${next ? "1" : "0"}; Path=/; Max-Age=31536000; SameSite=Lax`;
      return next;
    });
  }, []);

  // Drawer offen: Hintergrund sperren, Fokus hinein, Escape schließt (auch wenn der Fokus gerade nirgends liegt);
  // beim Schließen zurück auf den Menü-Knopf
  useEffect(() => {
    if (drawerOpen) {
      wasOpen.current = true;
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
      document.addEventListener("keydown", onKey);
      const t = window.setTimeout(() => document.getElementById(navId)?.querySelector<HTMLElement>("button, a[href]")?.focus(), 0);
      return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); window.clearTimeout(t); };
    }
    if (wasOpen.current) { wasOpen.current = false; if (!isMd) menuButton.current?.focus(); }
  }, [drawerOpen, navId, isMd]);

  // Tooltip der Icon-Leiste per Escape schließbar (WCAG 1.4.13)
  const hintShown = shownHint != null;
  useEffect(() => {
    if (!hintShown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setHint(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hintShown]);

  return (
    <div className="flex-1 flex min-h-screen">
      <a href="#inhalt" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-panel focus:px-3 focus:py-2 focus:text-ink focus:shadow-lg focus:outline-2 focus:outline-info">Zum Inhalt springen</a>
      <AppSidebar
        id={navId}
        tenantName={p.tenantName}
        tenantCity={p.tenantCity}
        logoSrc={logoSrc}
        userName={p.userName}
        userRole={p.userRole}
        logoutAction={p.logoutAction}
        hiddenPaths={p.hiddenPaths}
        badges={p.badges}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        rail={rail}
        mobileOpen={drawerOpen}
        onCloseMobile={closeMobile}
        onHint={setHint}
      />
      {drawerOpen && <div aria-hidden="true" onClick={closeMobile} className="md:hidden fixed inset-0 z-30 bg-ink/50" />}
      <div className="flex-1 min-w-0 flex flex-col" inert={drawerOpen || undefined}>
        {p.banners}
        <AppHeader
          navId={navId}
          mobileOpen={drawerOpen}
          onOpenMobile={() => setMobileOpen(true)}
          menuButtonRef={menuButton}
          tenantName={p.tenantName}
          todayLabel={p.todayLabel}
          kw={p.kw}
          quick={p.quick}
          onOpenSearch={openSearch}
        />
        <main id="inhalt" tabIndex={-1} className="flex-1 min-w-0 flex flex-col outline-none">{p.children}</main>
      </div>
      {shownHint && (
        <div aria-hidden="true" style={{ left: shownHint.x, top: shownHint.y }} className="fixed z-50 -translate-y-1/2 pointer-events-none whitespace-nowrap rounded-md bg-ink px-2.5 py-1.5 text-[12px] font-medium text-white shadow-lg">
          {shownHint.text}
        </div>
      )}
      <SearchDialog open={searchOpen} onClose={closeSearch} returnFocusTo={searchReturn} />
    </div>
  );
}

"use client";

// Befehl 29.2: helle Kopfleiste über jeder Seite der Vermieter-Oberfläche. Links Datum und KW, rechts die globale Suche
// (Strg K) und die Schnellaktionen – vorher teils in der Seitenleiste, teils nur im Kopf von „Heute“. Rollenregeln
// unverändert (quickActionsFor in src/lib/navigation.ts); die Zielseiten prüfen ihre Rechte weiterhin selbst.
// Unter 768 px: Menü-Knopf, Mandant, Suche und ein kompaktes „+“-Menü statt dreier Knöpfe.
import Link from "next/link";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { isoWeekBerlin, todayLabelBerlin } from "@/lib/navigation";
import { ShellIcon } from "@/components/shell-icons";

export type HeaderProps = {
  navId: string;
  mobileOpen: boolean;
  onOpenMobile: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  tenantName: string;
  /** vom Server berechnet (Berlin), wird im Browser minütlich nachgezogen – z. B. über Mitternacht */
  todayLabel: string;
  kw: number;
  quick: { booking: boolean; customer: boolean };
  onOpenSearch: () => void;
};

function useToday(initial: { label: string; kw: number }) {
  const [today, setToday] = useState(initial);
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const next = { label: todayLabelBerlin(now), kw: isoWeekBerlin(now) };
      setToday((t) => (t.label === next.label && t.kw === next.kw ? t : next));
    };
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return today;
}

export function AppHeader({ navId, mobileOpen, onOpenMobile, menuButtonRef, tenantName, todayLabel, kw, quick, onOpenSearch }: HeaderProps) {
  const today = useToday({ label: todayLabel, kw });
  const [newOpen, setNewOpen] = useState(false);
  const newRef = useRef<HTMLDivElement>(null);
  const newBtn = useRef<HTMLButtonElement>(null);
  const newId = useId();

  // „+“-Menü (nur mobil): schließt per Escape, Klick daneben oder Auswahl
  useEffect(() => {
    if (!newOpen) return;
    const onDown = (e: MouseEvent) => { if (!newRef.current?.contains(e.target as Node)) setNewOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setNewOpen(false); newBtn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [newOpen]);

  const anyQuick = quick.booking || quick.customer;

  return (
    <header className="print:hidden shrink-0 bg-panel">
      <div className="flex items-center gap-2 md:gap-2.5 h-14 px-3 sm:px-4 md:px-6">
        {/* Mobil: Menü + Mandant */}
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => { setNewOpen(false); onOpenMobile(); }}
          aria-label="Menü öffnen"
          aria-expanded={mobileOpen}
          aria-controls={navId}
          className="md:hidden grid place-items-center h-9 w-9 shrink-0 rounded-md text-ink-2 hover:bg-panel-2 outline-none focus-visible:ring-2 focus-visible:ring-info"
        >
          <ShellIcon name="menu" size={20} />
        </button>
        <span className="md:hidden min-w-0 flex-1 truncate font-display text-[17px] font-semibold text-ink">{tenantName}</span>

        {/* Desktop: Datum und Kalenderwoche */}
        <p className="hidden md:flex items-baseline gap-2 min-w-0 flex-1">
          <span className="truncate text-[14px] font-medium text-ink">{today.label}</span>
          <span className="shrink-0 text-[12.5px] text-ink-3 tnum">KW {today.kw}</span>
        </p>

        {/* Globale Suche – dieselbe Suche wie bisher (Dialog, Strg/Cmd+K überall) */}
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label="Suchen (Strg+K)"
          aria-keyshortcuts="Control+K Meta+K"
          className="inline-flex items-center gap-2 h-9 shrink-0 rounded-md border border-line bg-panel px-2.5 text-[13px] text-ink-3 hover:bg-panel-2 hover:text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-info lg:w-56 lg:px-3"
        >
          <ShellIcon name="search" size={16} className="shrink-0" />
          <span className="hidden lg:inline flex-1 text-left text-ink-2">Suchen …</span>
          <kbd className="hidden lg:inline rounded border border-line-soft bg-panel-2 px-1.5 font-mono text-[10.5px] leading-[18px] text-ink-2">Strg K</kbd>
        </button>

        {/* Desktop/Tablet: Fahrzeug suchen und Schnellaktionen */}
        <Link href="/fahrzeuge" className="btn !h-9 !py-0 hidden md:inline-flex" aria-label="Fahrzeug suchen">
          <ShellIcon name="car" size={16} className="shrink-0 xl:hidden" />
          <span className="hidden xl:inline">Fahrzeug suchen</span>
        </Link>
        {quick.customer && <Link href="/kunden/neu" className="btn !h-9 !py-0 hidden md:inline-flex">+ Neuer Kunde</Link>}
        {quick.booking && <Link href="/buchungen/neu" className="btn btn-primary !h-9 !py-0 hidden md:inline-flex">+ Neue Buchung</Link>}

        {/* Mobil: kompaktes „+“-Menü */}
        <div ref={newRef} className="md:hidden relative shrink-0">
          <button
            ref={newBtn}
            type="button"
            onClick={() => setNewOpen((o) => !o)}
            aria-expanded={newOpen}
            aria-controls={newId}
            aria-label={anyQuick ? "Neu anlegen oder Fahrzeug suchen" : "Fahrzeug suchen"}
            className={`grid place-items-center h-9 w-9 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-info ${anyQuick ? "bg-brand text-brand-ink hover:bg-[#16315a]" : "border border-line text-ink-2"}`}
          >
            <ShellIcon name={anyQuick ? "plus" : "car"} size={18} />
          </button>
          {newOpen && (
            <ul id={newId} className="absolute right-0 top-full z-40 mt-2 w-56 card shadow-lg py-1.5 text-[14px]">
              {quick.booking && <li><Link href="/buchungen/neu" onClick={() => setNewOpen(false)} className="flex items-center gap-2.5 px-3.5 py-2.5 font-medium text-brand hover:bg-panel-2"><ShellIcon name="plus" size={16} />Neue Buchung</Link></li>}
              {quick.customer && <li><Link href="/kunden/neu" onClick={() => setNewOpen(false)} className="flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-panel-2"><ShellIcon name="customer" size={16} />Neuer Kunde</Link></li>}
              <li><Link href="/fahrzeuge" onClick={() => setNewOpen(false)} className="flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-panel-2"><ShellIcon name="car" size={16} />Fahrzeug suchen</Link></li>
            </ul>
          )}
        </div>
      </div>
    </header>
  );
}

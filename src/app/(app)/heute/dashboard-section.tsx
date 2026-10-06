"use client";

import { useSyncExternalStore, type ReactNode } from "react";

export type Stored = { open: boolean; urgentAtChoice: boolean };
const KEY = (id: string) => `rb.heute.bereich.${id}`;
const EVENT = "rb-heute-bereich";

function readRaw(id: string): string | null {
  try {
    return window.localStorage.getItem(KEY(id));
  } catch {
    return null; // privates Fenster / gesperrter Speicher: dann gilt nur der Standard
  }
}

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    return typeof v.open === "boolean" ? { open: v.open, urgentAtChoice: Boolean(v.urgentAtChoice) } : null;
  } catch {
    return null;
  }
}

/** Offen oder zu? Eigene Wahl gilt, außer der Bereich ist dringend geworden, nachdem er zugeklappt wurde. */
export function resolveOpen(stored: Stored | null, urgent: boolean): boolean {
  return stored && (!urgent || stored.urgentAtChoice) ? stored.open : urgent;
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/**
 * Aufklappbarer Bereich der Startseite. Standard: zugeklappt, außer `urgent` (etwas ist überfällig oder dringend).
 * Die eigene Wahl merkt sich der Browser je Bereich. Wurde ein Bereich zugeklappt, während er bereits dringend war,
 * bleibt er zu; wird er erst danach dringend, klappt er wieder auf – so geht nichts Neues unter.
 * Rein clientseitig, keine Daten werden gespeichert; die Zahlen kommen vollständig vom Server.
 */
export function DashboardSection({ id, title, summary, urgent, children }: { id: string; title: string; summary: ReactNode; urgent: boolean; children: ReactNode }) {
  const raw = useSyncExternalStore(subscribe, () => readRaw(id), () => null);
  const stored = parse(raw);
  const open = resolveOpen(stored, urgent);

  const toggle = () => {
    try {
      window.localStorage.setItem(KEY(id), JSON.stringify({ open: !open, urgentAtChoice: urgent } satisfies Stored));
    } catch {
      // ohne Speicher bleibt die Wahl nur bis zum Neuladen nicht erhalten
    }
    window.dispatchEvent(new Event(EVENT));
  };

  // Gut erkennbar: runder Pfeil-Knopf links, deutliche Schaltfläche „Anzeigen/Ausblenden“ rechts, farbige Leiste bei
  // dringenden Bereichen, geöffnete Bereiche mit hinterlegter Kopfzeile und Trennlinie zum Inhalt
  const chevron = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
  return (
    <section className={`rounded-lg border bg-panel overflow-hidden ${urgent ? "border-amber/50 border-l-4 border-l-amber" : "border-line"} ${open ? "shadow-sm" : ""}`} aria-labelledby={`bereich-${id}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`bereich-${id}-inhalt`}
        title={open ? "Bereich zuklappen" : "Bereich aufklappen"}
        className={`group w-full flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left cursor-pointer transition-colors ${open ? "bg-panel-2 border-b border-line-soft" : "hover:bg-brand-soft/60"}`}
      >
        <span className={`shrink-0 grid place-items-center w-7 h-7 rounded-full border transition-colors ${open ? "bg-brand text-brand-ink border-brand" : "bg-brand-soft text-brand border-brand/20 group-hover:bg-brand group-hover:text-brand-ink"}`}>{chevron}</span>
        <h2 id={`bereich-${id}`} className="text-base font-semibold">{title}</h2>
        <span className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 text-sm text-ink-2">{summary}</span>
        <span className={`shrink-0 inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-[13px] font-medium transition-colors ${open ? "border-line bg-panel text-ink-2 group-hover:bg-panel-2" : "border-brand bg-brand text-brand-ink group-hover:bg-[#16315a]"}`}>
          {open ? "Ausblenden" : "Anzeigen"} {chevron}
        </span>
      </button>
      <div id={`bereich-${id}-inhalt`} hidden={!open} className="px-3 pb-3 pt-3">
        {children}
      </div>
    </section>
  );
}

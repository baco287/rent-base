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

  return (
    <section className={`rounded-lg border ${urgent ? "border-amber/40" : "border-line-soft"} bg-panel`} aria-labelledby={`bereich-${id}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`bereich-${id}-inhalt`}
        className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-panel-2/60 rounded-lg"
      >
        <span aria-hidden className={`inline-block w-3 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        <h2 id={`bereich-${id}`} className="text-base font-semibold">{title}</h2>
        <span className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 text-sm text-ink-2">{summary}</span>
        <span className="text-xs text-ink-3">{open ? "Zuklappen" : "Aufklappen"}</span>
      </button>
      <div id={`bereich-${id}-inhalt`} hidden={!open} className="px-3 pb-3 pt-1">
        {children}
      </div>
    </section>
  );
}

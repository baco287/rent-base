// Befehl 29.3.1: Symbole der Einstellungskategorien – gleiches 24er-Raster, Kontur 1.75 und runde Enden wie
// src/components/shell-icons.tsx (eigene Datei, damit der gemeinsame Icon-Satz der App-Shell unverändert bleibt).
import type { ReactNode } from "react";
import type { SettingsIcon as SettingsIconName } from "@/lib/settings-nav";

const PATHS: Record<SettingsIconName | "chevron-down" | "check", ReactNode> = {
  building: <><rect x="4.5" y="3.5" width="10" height="17" rx="1.5" /><path d="M14.5 9.5h4a1 1 0 0 1 1 1v10M3 20.5h18M8 7.5h3M8 11h3M8 14.5h3" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="m16 11.5 1.6 1.6 3.2-3.3" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 16.5h4" /></>,
  tag: <><path d="M3.5 12.2V5a1.5 1.5 0 0 1 1.5-1.5h7.2l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-7.2 7.2a1.5 1.5 0 0 1-2.1 0z" /><circle cx="8.5" cy="8.5" r="1.6" /></>,
  invoice: <><path d="M6 2.8h12v18.4l-3-1.8-3 1.8-3-1.8-3 1.8z" /><path d="M9 8h6M9 11.5h6M9 15h3.5" /></>,
  mail: <><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" /></>,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
};

export function SettingsIcon({ name, size = 18, className = "" }: { name: SettingsIconName | "chevron-down" | "check"; size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {PATHS[name]}
    </svg>
  );
}

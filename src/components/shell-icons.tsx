// Befehl 29.2: ein einheitlicher Icon-Satz für App-Shell, Seitenleiste und Kopfleiste (keine Icon-Bibliothek im Projekt).
// Alle Symbole auf demselben 24er-Raster, Kontur 1.75, runde Enden – Größe nur über `size`.
import type { ReactNode } from "react";
import type { NavIcon } from "@/lib/navigation";

export type ShellIconName = NavIcon | "search" | "plus" | "menu" | "close" | "logout" | "collapse" | "expand" | "chevron-down";

const PATHS: Record<ShellIconName, ReactNode> = {
  today: <><rect x="3.5" y="3.5" width="7" height="8" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="5" rx="1.5" /><rect x="13.5" y="11.5" width="7" height="9" rx="1.5" /><rect x="3.5" y="14.5" width="7" height="6" rx="1.5" /></>,
  booking: <><rect x="5" y="4.5" width="14" height="16.5" rx="2" /><path d="M9 4.5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M8.5 10.5h7M8.5 14h7M8.5 17.5h4" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 9.5h17M8 3v4M16 3v4M7.5 13.5h3M13.5 13.5h3M7.5 17h3" /></>,
  customer: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M15.5 4.7a3.3 3.3 0 0 1 0 6.4M18 14.9c1.9.7 3.1 2.4 3.5 5.1" /></>,
  car: <><path d="M5 16.5H3.5v-4.2l1.9-5a2 2 0 0 1 1.9-1.3h9.4a2 2 0 0 1 1.9 1.3l1.9 5v4.2H19" /><path d="M3.5 12.3h17M9.5 16.5h5" /><circle cx="7.3" cy="16.5" r="2" /><circle cx="16.7" cy="16.5" r="2" /></>,
  wrench: <path d="M14.6 6.4a4.2 4.2 0 0 0-5.5 5.5l-5.6 5.6a1.5 1.5 0 0 0 0 2.1l.9.9a1.5 1.5 0 0 0 2.1 0l5.6-5.6a4.2 4.2 0 0 0 5.5-5.5l-2.7 2.7-2.4-.6-.6-2.4z" />,
  invoice: <><path d="M6 2.8h12v18.4l-3-1.8-3 1.8-3-1.8-3 1.8z" /><path d="M9 8h6M9 11.5h6M9 15h3.5" /></>,
  receivable: <><circle cx="12" cy="12" r="8.5" /><path d="M14.8 8.9a3.6 3.6 0 1 0 0 6.2M8.4 11h4.8M8.4 13.2h4.8" /></>,
  payout: <><rect x="2.5" y="6.5" width="19" height="11" rx="2" /><circle cx="12" cy="12" r="2.4" /><path d="M6 9.8v.01M18 14.2v.01" /></>,
  damage: <><path d="M10.3 4 2.6 17.4a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4M12 16.9v.01" /></>,
  shield: <><path d="M12 2.8 19.5 5.6v5.6c0 4.6-3.2 8.2-7.5 9.9-4.3-1.7-7.5-5.3-7.5-9.9V5.6z" /><path d="m8.8 12 2.2 2.2 4.3-4.4" /></>,
  authority: <><path d="M3.5 9.5h17v-1.6L12 3.5 3.5 7.9z" /><path d="M6.5 9.5v7.5M10.2 9.5v7.5M13.8 9.5v7.5M17.5 9.5v7.5M4.5 17h15M3 20.5h18" /></>,
  settings: <><path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20" /><circle cx="15" cy="7" r="2.5" /><circle cx="9" cy="17" r="2.5" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  logout: <><path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5" /><path d="m9.5 16.5 4.5-4.5-4.5-4.5M14 12H3.5" /></>,
  collapse: <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />,
  expand: <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
};

export function ShellIcon({ name, size = 18, className }: { name: ShellIconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      {PATHS[name]}
    </svg>
  );
}

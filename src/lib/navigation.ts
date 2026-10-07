// Befehl 29.2: zentrale Navigationskonfiguration der Vermieter-Oberfläche. Eine Quelle für Seitenleiste, eingeklappte
// Leiste und mobiles Menü. Sie ordnet nur die Darstellung – welche Module ein Mandant hat, entscheidet
// hiddenNavPaths() (Control Center), und jede Seite prüft ihre Rechte weiterhin selbst serverseitig
// (requireSession/requireRole/requireFeature). Ein ausgeblendeter Menüpunkt ersetzt nie diese Prüfung.
import { zonedParts } from "@/lib/time";

export type NavIcon =
  | "today" | "booking" | "calendar" | "customer" | "car" | "wrench"
  | "invoice" | "receivable" | "payout" | "damage" | "shield" | "authority" | "settings";

export type NavItem = { href: string; label: string; icon: NavIcon };
export type NavGroup = { key: string; label: string | null; items: readonly NavItem[] };

/** Reihenfolge und Gruppen der Hauptnavigation. Routen unverändert – nur gruppiert. */
export const NAV_GROUPS: readonly NavGroup[] = [
  { key: "start", label: null, items: [{ href: "/heute", label: "Heute", icon: "today" }] },
  {
    key: "vermietung",
    label: "Vermietung",
    items: [
      { href: "/buchungen", label: "Buchungen", icon: "booking" },
      { href: "/dispo", label: "Dispo-Kalender", icon: "calendar" },
      { href: "/kunden", label: "Kunden", icon: "customer" },
    ],
  },
  {
    key: "flotte",
    label: "Flotte",
    items: [
      { href: "/fahrzeuge", label: "Fahrzeuge", icon: "car" },
      { href: "/fahrzeuge/wartung", label: "Wartung", icon: "wrench" },
    ],
  },
  {
    key: "finanzen",
    label: "Finanzen",
    items: [
      { href: "/rechnungen", label: "Rechnungen", icon: "invoice" },
      { href: "/forderungen", label: "Forderungen", icon: "receivable" },
      { href: "/auszahlungen", label: "Auszahlungen", icon: "payout" },
    ],
  },
  {
    key: "faelle",
    label: "Fälle",
    items: [
      { href: "/schaeden", label: "Schäden", icon: "damage" },
      // Befehl 29 Phase G: Unfallersatz-Zentrale – ohne freigeschaltetes Modul ausgeblendet (hiddenPaths aus FEATURES.nav)
      { href: "/unfallersatz", label: "Unfallersatz", icon: "shield" },
      { href: "/behoerden", label: "Behörden", icon: "authority" },
    ],
  },
];

/** Systembereich unten in der Seitenleiste, über dem Konto. */
export const NAV_SYSTEM: readonly NavItem[] = [{ href: "/einstellungen", label: "Einstellungen", icon: "settings" }];

/** Alle Menüpunkte in Anzeigereihenfolge. */
export const NAV_ITEMS: readonly NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), ...NAV_SYSTEM];

/** Gruppen ohne die gesperrten Module; leere Gruppen entfallen ganz (keine Überschrift ohne Einträge). */
export function visibleNavGroups(hiddenPaths: readonly string[] = []): NavGroup[] {
  const hidden = new Set(hiddenPaths);
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !hidden.has(i.href)) })).filter((g) => g.items.length > 0);
}

export function visibleSystemItems(hiddenPaths: readonly string[] = []): NavItem[] {
  const hidden = new Set(hiddenPaths);
  return NAV_SYSTEM.filter((i) => !hidden.has(i.href));
}

/**
 * Aktiver Menüpunkt: der sichtbare Eintrag mit dem längsten passenden Pfad (wie bisher). /fahrzeuge/wartung/… markiert
 * also „Wartung“, /fahrzeuge/gruppen „Fahrzeuge“, /einstellungen/tarife „Einstellungen“. Ohne Treffer (z. B. /suche): null.
 */
export function activeNavHref(pathname: string, items: readonly Pick<NavItem, "href">[]): string | null {
  let best: string | null = null;
  for (const { href } of items) {
    if ((pathname === href || pathname.startsWith(href + "/")) && (!best || href.length > best.length)) best = href;
  }
  return best;
}

/**
 * Schnellaktionen in der Kopfleiste – dieselben Regeln wie bisher in der Seitenleiste (Vorschlag 4):
 * „+ Neue Buchung“ nur für Rollen, die Buchungen anlegen dürfen (/buchungen/neu verlangt DISPO, Inhaber eingeschlossen),
 * „+ Neuer Kunde“ für alle Mandantenrollen (/kunden/neu verlangt DISPO oder YARD), im Supportmodus (read-only) keine.
 */
export function quickActionsFor(role: string, supportMode: boolean): { booking: boolean; customer: boolean } {
  if (supportMode) return { booking: false, customer: false };
  return { booking: role !== "YARD", customer: true };
}

/** Kalenderwoche nach ISO 8601 für das Datum in Berlin (nicht in der Serverzeitzone). */
export function isoWeekBerlin(now: Date): number {
  const z = zonedParts(now);
  const x = new Date(Date.UTC(z.year, z.month - 1, z.day));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x.getTime() - y0.getTime()) / 86_400_000 + 1) / 7);
}

/** „Mittwoch, 7. Oktober“ in Berlin. */
export function todayLabelBerlin(now: Date): string {
  return now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" });
}

/** Initialen für den Kontobereich, z. B. „Sezer Karakuş“ → „SK“. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Cookie für die eingeklappte Seitenleiste (nur Darstellung, keine Sicherheitsrelevanz). */
export const NAV_COLLAPSED_COOKIE = "rb_nav";

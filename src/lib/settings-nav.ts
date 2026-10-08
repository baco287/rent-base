// Befehl 29.3.1: Kategorienavigation des Einstellungscenters. Eine Quelle für die helle Spalte (ab 768 px) und die
// Kategorieauswahl auf dem Smartphone. Sie zeigt nur Bereiche, die die Rolle öffnen darf – die eigentliche
// Rechteprüfung bleibt auf jeder Seite serverseitig (requireSession/requireRole/requireFeature).

export type SettingsIcon = "building" | "users" | "file" | "tag" | "invoice" | "mail";
export type SettingsLink = { href: string; label: string };
export type SettingsItem = SettingsLink & { icon: SettingsIcon; children?: readonly SettingsLink[] };
export type SettingsGroup = { key: string; label: string; items: readonly SettingsItem[] };
export type SettingsAccess = { role: string; supportSession: boolean; smtpFeature: boolean };

/** Kategorien in Anzeigereihenfolge. Alle Routen bestehen bereits oder sind reine Darstellungsseiten ohne eigene Speicherlogik. */
export function settingsNav(a: SettingsAccess): SettingsGroup[] {
  // E-Mail-Versand: Modul freigeschaltet (Layout requireFeature) und nicht Hof/Supportmodus (Seite leitet sonst um)
  const mail = a.smtpFeature && a.role !== "YARD" && !a.supportSession;
  const groups: SettingsGroup[] = [
    {
      key: "allgemein",
      label: "Allgemein",
      items: [
        { href: "/einstellungen", label: "Unternehmen", icon: "building" },
        { href: "/einstellungen/mitarbeiter", label: "Mitarbeiter & Berechtigungen", icon: "users" },
      ],
    },
    {
      key: "vermietung",
      label: "Vermietung",
      items: [
        {
          href: "/einstellungen/vertraege",
          label: "Verträge & Dokumente",
          icon: "file",
          children: [
            { href: "/einstellungen/mietbedingungen", label: "Mietbedingungen" },
            { href: "/einstellungen/geschaeftsregeln", label: "Geschäftsregeln" },
          ],
        },
        { href: "/einstellungen/tarife", label: "Miettarife", icon: "tag" },
      ],
    },
    {
      key: "finanzen",
      label: "Finanzen",
      items: [
        {
          href: "/einstellungen/rechnungen",
          label: "Rechnungen & Belege",
          icon: "invoice",
          children: [
            { href: "/einstellungen/rechnungen", label: "Rechnungsdaten & Mahnwesen" },
            { href: "/einstellungen/nummernkreise", label: "Nummernkreise" },
          ],
        },
      ],
    },
    { key: "kommunikation", label: "Kommunikation", items: mail ? [{ href: "/einstellungen/e-mail", label: "E-Mail & Versand", icon: "mail" }] : [] },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Alle Ziele (Kategorien und Unterpunkte) – z. B. für Prüfungen auf funktionslose Links. */
export function settingsHrefs(groups: readonly SettingsGroup[]): string[] {
  return [...new Set(groups.flatMap((g) => g.items.flatMap((i) => [i.href, ...(i.children ?? []).map((c) => c.href)])))];
}

const matches = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + "/");

/**
 * Aktive Kategorie und aktiver Unterpunkt: der Eintrag mit dem längsten passenden Pfad. /einstellungen/mietbedingungen/…
 * markiert „Verträge & Dokumente“ und darunter „Mietbedingungen“; /einstellungen/tarife/neu „Miettarife“.
 */
export function activeSettings(pathname: string, groups: readonly SettingsGroup[]): { item: SettingsItem | null; child: string | null } {
  let best: { item: SettingsItem; href: string; child: boolean } | null = null;
  for (const g of groups) {
    for (const item of g.items) {
      const candidates = [{ href: item.href, child: false }, ...(item.children ?? []).map((c) => ({ href: c.href, child: true }))];
      for (const c of candidates) {
        if (matches(pathname, c.href) && (!best || c.href.length > best.href.length || (c.href.length === best.href.length && c.child && !best.child))) best = { item, href: c.href, child: c.child };
      }
    }
  }
  if (!best) return { item: null, child: null };
  return { item: best.item, child: best.child ? best.href : null };
}

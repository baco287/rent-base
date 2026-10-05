import Link from "next/link";

/**
 * Befehl 29 Phase C: Mietart beim Anlegen einer Buchung. „Standardvermietung“ ist das bestehende Buchungsformular,
 * „Unfallersatz“ der geführte Wizard. Nur sichtbar, wenn das Modul für den Mandanten freigeschaltet ist. Übergebene
 * Vorbelegungen (Kunde, Fahrzeug, Tag) bleiben beim Wechsel erhalten.
 */
export function RentalTypeSwitch({ current, query = "" }: { current: "STANDARD" | "ACCIDENT_REPLACEMENT"; query?: string }) {
  const q = query ? `?${query}` : "";
  const items = [
    { key: "STANDARD", href: `/buchungen/neu${q}`, label: "Standardvermietung", hint: "Zeitraum, Preis aus dem Fahrzeug" },
    { key: "ACCIDENT_REPLACEMENT", href: `/unfallersatz/neu${q}`, label: "Unfallersatz", hint: "Schadenfall, Versicherung, Tarif" },
  ] as const;
  return (
    <nav aria-label="Mietart" className="card p-1.5 grid grid-cols-2 gap-1.5 max-w-3xl">
      {items.map((i) => {
        const active = i.key === current;
        return (
          <Link key={i.key} href={i.href} aria-current={active ? "page" : undefined} className={`rounded-md px-3 py-2 flex flex-col min-w-0 ${active ? "bg-brand text-brand-ink" : "text-ink-2 hover:bg-panel-2"}`}>
            <span className="font-semibold text-sm">{i.label}</span>
            <span className={`text-xs truncate ${active ? "opacity-90" : "text-ink-3"}`}>{i.hint}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Vorbelegungen aus der Adresszeile, die beim Wechsel der Mietart mitgenommen werden. */
export function carryQuery(sp: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const k of ["kunde", "fahrzeug", "tag"]) {
    const v = sp[k];
    if (typeof v === "string" && /^[A-Za-z0-9-]{1,40}$/.test(v)) p.set(k, v);
  }
  return p.toString();
}

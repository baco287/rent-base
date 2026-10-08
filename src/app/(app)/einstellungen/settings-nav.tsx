"use client";

// Befehl 29.3.1: helle Kategorienavigation des Einstellungscenters neben der dunklen Hauptleiste.
//  · ab 768 px: eigene Spalte (bis 1279 px kompakt, ab 1280 px breiter), beim Scrollen mitlaufend
//  · unter 768 px: keine zweite Leiste – eine Kategorieauswahl über dem Inhalt
// Unterpunkte erscheinen nur in der aktiven Kategorie. Welche Einträge es gibt, entscheidet der Server (settingsNav).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { activeSettings, type SettingsGroup } from "@/lib/settings-nav";
import { SettingsIcon } from "./settings-icons";

export function SettingsNav({ groups, tenantName }: { groups: SettingsGroup[]; tenantName: string }) {
  const pathname = usePathname();
  const { item: active, child } = activeSettings(pathname, groups);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // Auswahl (mobil): schließt per Escape oder Klick daneben
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const list = (mobile: boolean) =>
    groups.map((g) => (
      <div key={g.key} className={mobile ? "" : "mt-4 first:mt-0"}>
        <p id={`${listId}-${mobile ? "m" : "d"}-${g.key}`} className={`px-2.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3 ${mobile ? "pt-2.5" : ""}`}>{g.label}</p>
        <ul className="flex flex-col gap-0.5" aria-labelledby={`${listId}-${mobile ? "m" : "d"}-${g.key}`}>
          {g.items.map((it) => {
            const on = active?.href === it.href;
            const self = on && !child;
            return (
              <li key={it.href}>
                <Link
                  href={it.href}
                  onClick={() => setOpen(false)}
                  aria-current={self || (on && child === it.href) ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-info ${mobile ? "min-h-11 text-[14.5px]" : "min-h-9 py-1.5 text-[13.5px] leading-snug"} ${
                    on ? "bg-brand-soft text-brand font-medium" : "text-ink-2 hover:bg-panel-2 hover:text-ink"
                  }`}
                >
                  <SettingsIcon name={it.icon} className={`shrink-0 ${on ? "text-brand" : "text-ink-3"}`} />
                  <span className="min-w-0 flex-1">{it.label}</span>
                  {mobile && on && <SettingsIcon name="check" size={16} className="shrink-0 text-brand" />}
                </Link>
                {on && it.children && it.children.length > 0 && (
                  <ul className="mt-0.5 mb-1 flex flex-col gap-0.5">
                    {it.children.map((c) => {
                      const cOn = child === c.href;
                      return (
                        <li key={c.href + c.label}>
                          <Link
                            href={c.href}
                            onClick={() => setOpen(false)}
                            aria-current={cOn ? "page" : undefined}
                            className={`flex items-center gap-2 rounded-md pl-[38px] pr-2.5 outline-none focus-visible:ring-2 focus-visible:ring-info ${mobile ? "min-h-10 text-[13.5px]" : "h-8 text-[13px]"} ${
                              cOn ? "text-brand font-medium" : "text-ink-3 hover:bg-panel-2 hover:text-ink-2"
                            }`}
                          >
                            {cOn && <span aria-hidden="true" className="-ml-[13px] size-[5px] shrink-0 rounded-full bg-brand" />}
                            <span className="truncate">{c.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    ));

  const current = active ? (child && active.children?.find((c) => c.href === child && c.href !== active.href)?.label) : null;

  return (
    <>
      {/* ab 768 px: eigene, helle Spalte */}
      <div className="print:hidden hidden md:block shrink-0 w-[220px] xl:w-[264px] bg-panel border-r border-line-soft">
        <nav aria-label="Einstellungen" className="sticky top-0 max-h-dvh overflow-y-auto overscroll-contain px-3 py-5 [scrollbar-width:thin]">
          <div className="px-2.5 pb-4">
            <p className="font-display text-[21px] font-semibold leading-tight text-ink">Einstellungen</p>
            <p className="mt-0.5 truncate text-[12px] text-ink-3">{tenantName}</p>
          </div>
          {list(false)}
        </nav>
      </div>

      {/* unter 768 px: Kategorieauswahl über dem Inhalt */}
      <div ref={boxRef} className="print:hidden md:hidden relative px-4 pt-4">
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`Einstellungen: ${active?.label ?? "Kategorie wählen"}${current ? ` · ${current}` : ""} – Kategorie wechseln`}
          className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-panel px-3.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-info"
        >
          {active && <SettingsIcon name={active.icon} className="shrink-0 text-brand" />}
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3">Einstellungen</span>
            <span className="block truncate text-[14.5px] font-medium text-ink">{active?.label ?? "Kategorie wählen"}{current ? ` · ${current}` : ""}</span>
          </span>
          <SettingsIcon name="chevron-down" className={`shrink-0 text-ink-3 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <nav id={listId} aria-label="Einstellungen" className="absolute left-4 right-4 top-full z-30 mt-2 max-h-[70dvh] overflow-y-auto rounded-xl border border-line bg-panel p-1.5 shadow-lg">
            {list(true)}
          </nav>
        )}
      </div>
    </>
  );
}

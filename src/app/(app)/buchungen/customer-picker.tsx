"use client";

// Befehl 20.7: Kundenauswahl als Suchfeld statt Dropdown. Serverseitige Suche (searchCustomersAction), Debounce,
// Tastaturbedienung (↑ ↓ Enter Esc), eindeutige Treffer (Kundennummer + Name/Firma + Kontakt), gesperrte Kunden nicht
// wählbar. Mobile: volle Breite, große Zeilen. „Neuer Kunde“ bleibt über den Umschalter im Buchungsformular erreichbar.
import { useEffect, useId, useRef, useState } from "react";
import { searchCustomersAction } from "./customer-search-actions";
import type { CustomerOption } from "./booking-form";

const MIN = 2;
const DEBOUNCE_MS = 220;

export function CustomerPicker({ value, onChange, inputId = "customerId" }: { value: CustomerOption | null; onChange: (c: CustomerOption | null) => void; inputId?: string }) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerOption[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const search = (value: string) => {
    setQ(value);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    const term = value.trim();
    const mine = ++seq.current;
    if (term.length < MIN) { setHits([]); setMore(false); setError(null); setPending(false); return; }
    setPending(true);
    timer.current = setTimeout(async () => {
      const res = await searchCustomersAction(term);
      if (mine !== seq.current) return;
      setPending(false);
      if ("error" in res) { setError(res.error); setHits([]); setMore(false); } else { setError(null); setHits(res.hits); setMore(res.more); setActive(0); }
    }, DEBOUNCE_MS);
  };

  const pick = (c: CustomerOption) => {
    if (c.blocked) return;
    onChange(c);
    setOpen(false);
    setQ("");
    setHits([]);
  };

  const clear = () => {
    onChange(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { if (open && hits[active]) { e.preventDefault(); pick(hits[active]); } else if (q.trim().length >= MIN) e.preventDefault(); }
    else if (e.key === "Escape") { if (open) { e.preventDefault(); setOpen(false); } }
  };

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel-2 px-3 py-2 min-h-[44px]">
        <input type="hidden" name={inputId} value={value.id} />
        <span className="font-medium">{value.label}</span>
        {value.number && <span className="font-mono tnum text-xs text-ink-3">{value.number}</span>}
        {value.context && <span className="text-xs text-ink-3 min-w-0 truncate">{value.context}</span>}
        {value.discountPercent > 0 && <span className="chip bg-info-soft text-info">{value.discountPercent} % Rabatt</span>}
        <button type="button" onClick={clear} className="ml-auto btn !py-1 !px-2.5 text-xs">Ändern</button>
      </div>
    );
  }

  const activeId = hits[active] ? `${listId}-${hits[active].id}` : undefined;
  return (
    <div className="relative" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <input type="hidden" name={inputId} value="" />
      <input
        ref={inputRef}
        id={inputId}
        value={q}
        onChange={(e) => search(e.target.value)}
        onFocus={() => q.trim().length >= MIN && setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls={`${listId}-list`}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        maxLength={80}
        required
        placeholder="Kundennummer, Name, Firma, E-Mail oder Telefon…"
        className="input !min-h-[44px]"
      />
      {open && (q.trim().length >= MIN || error) && (
        <div id={`${listId}-list`} role="listbox" aria-label="Kunden" className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto card shadow-xl text-ink">
          {error && <p role="alert" className="m-2 rounded-md bg-bad-soft text-bad px-3 py-2 text-sm">{error}</p>}
          {pending && <p role="status" className="px-3 pt-2 text-xs text-ink-3">Suche läuft …</p>}
          {!pending && !error && hits.length === 0 && <p className="p-3 text-sm text-ink-3">Kein Kunde gefunden. Über „Neuer Kunde“ kann er direkt mit der Buchung angelegt werden.</p>}
          <ul>
            {hits.map((c, i) => {
              const on = i === active;
              return (
                <li key={c.id} id={`${listId}-${c.id}`} role="option" aria-selected={on} aria-disabled={c.blocked}>
                  <button type="button" tabIndex={-1} disabled={c.blocked} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)} className={`w-full text-left px-3 py-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 min-h-[44px] ${on ? "bg-brand-soft" : "hover:bg-panel-2/60"} ${c.blocked ? "opacity-60 cursor-not-allowed" : ""}`}>
                    {c.number && <span className="font-mono tnum text-xs text-ink-3">{c.number}</span>}
                    <span className="font-medium">{c.label}</span>
                    {c.blocked && <span className="chip bg-bad-soft text-bad">Gesperrt</span>}
                    {!c.blocked && c.discountPercent > 0 && <span className="chip bg-info-soft text-info">{c.discountPercent} % Rabatt</span>}
                    {c.context && <span className="text-xs text-ink-3 min-w-0 truncate basis-full">{c.context}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {more && <p className="px-3 py-2 border-t border-line-soft text-xs text-ink-3">Weitere Treffer vorhanden – bitte genauer eingeben (z. B. Kundennummer oder E-Mail).</p>}
          {hits.length > 0 && <p className="px-3 py-2 border-t border-line-soft text-xs text-ink-3">↑↓ wählen · Enter übernehmen · Esc schließen</p>}
        </div>
      )}
    </div>
  );
}

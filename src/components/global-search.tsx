"use client";

// Globale Suche als Befehlsfeld: überall erreichbar (Seitenleiste, mobile Kopfzeile, Strg/Cmd+K). Ohne Zusatzbibliothek:
// Dialog mit Fokusführung, Pfeiltasten, Enter, Escape; Ergebnisse gruppiert und serverseitig gerankt. Der Suchbegriff
// bleibt im Browser und in der Server Action – er wird nicht protokolliert.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { globalSearchAction } from "@/app/(app)/suche/actions";
import type { SearchHit, SearchResult } from "@/lib/search";

const MIN = 2;
const DEBOUNCE_MS = 220;
const toneClass: Record<string, string> = { good: "bg-good-soft text-good", amber: "bg-amber-soft text-amber", bad: "bg-bad-soft text-bad", info: "bg-info-soft text-info", grey: "bg-panel-2 text-ink-2" };

export function useGlobalSearchShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); open(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

export function SearchDialog({ open, onClose, returnFocusTo }: { open: boolean; onClose: () => void; returnFocusTo?: React.RefObject<HTMLElement | null> }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flat: SearchHit[] = result ? result.groups.flatMap((g) => g.hits) : [];

  // Fokus in das Eingabefeld, sobald der Dialog erscheint
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    onClose();
    const el = returnFocusTo?.current;
    if (el) setTimeout(() => el.focus(), 0);
  };

  const onChange = (value: string) => {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    const term = value.trim();
    const mine = ++seq.current;
    if (term.length < MIN) { setResult(null); setError(null); setPending(false); return; }
    setPending(true);
    timer.current = setTimeout(async () => {
      const res = await globalSearchAction(term);
      if (mine !== seq.current) return;
      setPending(false);
      if ("error" in res) { setError(res.error); setResult(null); } else { setError(null); setResult(res); setActive(0); }
    }, DEBOUNCE_MS);
  };

  const go = (h: SearchHit) => { close(); router.push(h.href); };
  const toFullList = () => { const term = q.trim(); if (term.length >= MIN) { close(); router.push(`/suche?q=${encodeURIComponent(term)}`); } };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (flat[active]) go(flat[active]); else toFullList(); }
  };
  const activeId = flat[active] ? `${listId}-${flat[active].type}-${flat[active].id}` : undefined;
  let idx = -1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-3 md:p-6 md:pt-[10vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}>
      <div role="dialog" aria-modal="true" aria-label="Suche" className="w-full max-w-2xl card shadow-xl flex flex-col max-h-[85vh] text-ink">
        <form role="search" action="/suche" onSubmit={(e) => { e.preventDefault(); toFullList(); }} className="p-3 border-b border-line-soft flex gap-2 items-center">
          <label htmlFor={`${listId}-input`} className="sr-only">Suchbegriff</label>
          <input
            ref={inputRef}
            id={`${listId}-input`}
            name="q"
            value={q}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={`${listId}-list`}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            maxLength={80}
            placeholder="Kunde, Buchung, Kennzeichen, RE-/GS-/AZ-/SCH-/WA-/BH-Nummer …"
            className="input !min-h-[42px] text-base"
          />
          <button type="button" onClick={close} className="btn !py-1.5" aria-label="Suche schließen">Esc</button>
        </form>
        <div id={`${listId}-list`} role="listbox" aria-label="Suchergebnisse" className="overflow-y-auto flex-1">
          {q.trim().length < MIN && <p className="p-4 text-sm text-ink-3">Mindestens {MIN} Zeichen. Nummern, Namen, Kennzeichen (auch ohne Leerzeichen), E-Mail, Telefon.</p>}
          {error && <p role="alert" className="m-3 rounded-md bg-bad-soft text-bad px-3 py-2 text-sm">{error}</p>}
          {pending && q.trim().length >= MIN && <p role="status" className="px-4 pt-3 text-xs text-ink-3">Suche läuft …</p>}
          {result && result.groups.length === 0 && !pending && <p className="p-4 text-sm text-ink-3">Nichts gefunden für „{result.q}“.</p>}
          {result?.groups.map((g) => (
            <div key={g.type} className="py-1">
              <div className="label-xs px-4 pt-2 pb-1 flex items-center gap-2">{g.label}{g.more && g.moreHref && <Link href={g.moreHref} onClick={close} className="normal-case tracking-normal font-normal underline">alle</Link>}</div>
              <ul>
                {g.hits.map((h) => {
                  idx++;
                  const i = idx;
                  const on = i === active;
                  return (
                    <li key={h.id} id={`${listId}-${h.type}-${h.id}`} role="option" aria-selected={on}>
                      <button type="button" tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => go(h)} className={`w-full text-left px-4 py-2 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 ${on ? "bg-brand-soft" : "hover:bg-panel-2/60"}`}>
                        <span className="font-medium">{h.label}</span>
                        {h.status && <span className={`chip ${toneClass[h.status.tone] ?? toneClass.grey}`}>{h.status.text}</span>}
                        <span className="text-xs text-ink-3 min-w-0 truncate basis-full md:basis-auto">{h.context}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {result && result.groups.length > 0 && <div className="px-4 py-3 border-t border-line-soft text-xs text-ink-3">↑↓ wählen · Enter öffnen · Esc schließen · <Link href={`/suche?q=${encodeURIComponent(result.q)}`} onClick={close} className="underline">alle Ergebnisse</Link></div>}
        </div>
      </div>
    </div>
  );
}

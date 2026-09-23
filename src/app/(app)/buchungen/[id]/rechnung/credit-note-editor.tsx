"use client";

// Entwurf einer Gutschrift: je Originalposition ganz (Rest), nach Menge oder nach Betrag – nie über den Rest hinaus –
// plus manuelle Positionen mit Grund. Der Server rechnet alle Beträge; hier stehen nur Eingaben und die Serverwerte.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { INVOICE_UNITS } from "@/lib/constants";
import type { CounterState } from "./counter-actions";

export type SourceRow = { itemId: string; description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; original: string; credited: string; remaining: string; remainingCents: number; selected: boolean; mode: "REMAINING" | "QUANTITY" | "AMOUNT"; quantityInput: string; amountInput: string; current: string | null };
export type ManualRow = { key: string; description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; reason: string; current: string | null };

type Props = {
  version: number;
  sources: SourceRow[];
  manual: ManualRow[];
  rateOptions: string[];
  nonTaxable: boolean;
  reason: string;
  customerNote: string;
  notes: string;
  totalGross: string;
  remainingGross: string;
  save: (payload: unknown) => Promise<CounterState>;
};

export function CreditNoteEditor(props: Props) {
  const [message, setMessage] = useState<CounterState>(undefined);
  return (
    <div className="flex flex-col gap-3">
      <Body key={props.version} {...props} onSaved={setMessage} />
      {message?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{message.error}</p>}
      {message?.ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{message.ok}</p>}
    </div>
  );
}

function Body({ sources: initialSources, manual: initialManual, rateOptions, nonTaxable, reason: r0, customerNote: c0, notes: n0, totalGross, remainingGross, save, onSaved }: Props & { onSaved: (s: CounterState) => void }) {
  const router = useRouter();
  const [sources, setSources] = useState(initialSources.map((s) => ({ ...s })));
  const [manual, setManual] = useState(initialManual.map((m) => ({ ...m })));
  const [reason, setReason] = useState(r0);
  const [customerNote, setCustomerNote] = useState(c0);
  const [notes, setNotes] = useState(n0);
  const [dirty, setDirty] = useState(false);
  const [pending, start] = useTransition();
  const upd = (i: number, patch: Partial<SourceRow>) => { setSources((xs) => xs.map((x, k) => (k === i ? { ...x, ...patch } : x))); setDirty(true); };
  const updM = (i: number, patch: Partial<ManualRow>) => { setManual((xs) => xs.map((x, k) => (k === i ? { ...x, ...patch } : x))); setDirty(true); };
  const addManual = () => { setManual((xs) => [...xs, { key: `m${Date.now()}`, description: "", quantity: "1", unit: "pauschal", unitPrice: "", taxRate: rateOptions[0] ?? "0,00", reason: "", current: null }]); setDirty(true); };
  const removeManual = (i: number) => { setManual((xs) => xs.filter((_, k) => k !== i)); setDirty(true); };
  const allRemaining = () => { setSources((xs) => xs.map((x) => (x.remainingCents > 0 ? { ...x, selected: true, mode: "REMAINING" } : x))); setDirty(true); };
  const submit = () => {
    onSaved(undefined);
    start(async () => {
      const items = [
        ...sources.filter((s) => s.selected).map((s) => (s.mode === "REMAINING" ? { sourceItemId: s.itemId, mode: "REMAINING" } : s.mode === "QUANTITY" ? { sourceItemId: s.itemId, mode: "QUANTITY", quantity: s.quantityInput } : { sourceItemId: s.itemId, mode: "AMOUNT", grossAmount: s.amountInput })),
        ...manual.map((m) => ({ manual: true, description: m.description, quantity: m.quantity, unit: m.unit, unitPrice: m.unitPrice, taxRate: m.taxRate.replace(" %", ""), reason: m.reason })),
      ];
      const res = await save({ items, reason, customerNote, notes });
      onSaved(res);
      if (!res?.error) { setDirty(false); router.refresh(); }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="card p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-sm">Positionen der Rechnung</div>
          <button type="button" className="btn !py-1.5" onClick={allRemaining}>Restbetrag vollständig gutschreiben</button>
        </div>
        <p className="text-xs text-ink-3">Je Position: den gesamten noch offenen Rest, eine Teilmenge oder einen Teilbetrag (brutto). Mehr als der Rest ist nicht möglich; der Steuersatz wird aus der Rechnungsposition übernommen.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead><tr className="text-left text-xs text-ink-3 border-b border-line-soft"><th className="px-2 py-2 font-medium w-8"></th><th className="px-2 py-2 font-medium">Position</th><th className="px-2 py-2 font-medium text-right">Rechnung</th><th className="px-2 py-2 font-medium text-right">bereits gutgeschrieben</th><th className="px-2 py-2 font-medium text-right">Rest</th><th className="px-2 py-2 font-medium">Gutschrift</th><th className="px-2 py-2 font-medium text-right">Betrag</th></tr></thead>
            <tbody>
              {sources.map((s, i) => (
                <tr key={s.itemId} className={`border-b border-line-soft align-top ${s.remainingCents <= 0 ? "opacity-60" : ""}`}>
                  <td className="px-2 py-2"><input type="checkbox" checked={s.selected} disabled={s.remainingCents <= 0} onChange={(e) => upd(i, { selected: e.target.checked })} aria-label={`Position ${s.description} gutschreiben`} /></td>
                  <td className="px-2 py-2"><div className="whitespace-pre-line">{s.description}</div><div className="text-xs text-ink-3">{s.quantity} {s.unit} × {s.unitPrice} · {s.taxRate}</div></td>
                  <td className="px-2 py-2 text-right font-mono tnum">{s.original}</td>
                  <td className="px-2 py-2 text-right font-mono tnum">{s.credited}</td>
                  <td className="px-2 py-2 text-right font-mono tnum font-semibold">{s.remaining}</td>
                  <td className="px-2 py-2">
                    {s.selected && s.remainingCents > 0 && (
                      <div className="flex flex-col gap-1">
                        <select value={s.mode} onChange={(e) => upd(i, { mode: e.target.value as SourceRow["mode"] })} className="input !py-1">
                          <option value="REMAINING">gesamter Rest</option>
                          <option value="QUANTITY">Teilmenge</option>
                          <option value="AMOUNT">Teilbetrag (brutto)</option>
                        </select>
                        {s.mode === "QUANTITY" && <input value={s.quantityInput} onChange={(e) => upd(i, { quantityInput: e.target.value })} className="input !py-1" placeholder={`Menge in ${s.unit}`} inputMode="decimal" />}
                        {s.mode === "AMOUNT" && <input value={s.amountInput} onChange={(e) => upd(i, { amountInput: e.target.value })} className="input !py-1" placeholder={`bis ${s.remaining}`} inputMode="decimal" />}
                      </div>
                    )}
                    {s.remainingCents <= 0 && <span className="text-xs text-ink-3">vollständig gutgeschrieben</span>}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tnum">{s.selected ? s.current ?? "–" : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-sm">Manuelle Gutschriftpositionen</div>
          <button type="button" className="btn !py-1.5" onClick={addManual}>Position hinzufügen</button>
        </div>
        <p className="text-xs text-ink-3">Für Beträge ohne Bezug auf eine bestimmte Rechnungsposition (z. B. Kulanz). Jede manuelle Position braucht einen Grund; sie erhöht nie den gutschreibbaren Gesamtbetrag über den Rest der Rechnung hinaus.{nonTaxable ? " Echter Schadensersatz: ohne Steuersatz." : ""}</p>
        {manual.length === 0 && <div className="text-sm text-ink-3">Keine manuellen Positionen.</div>}
        {manual.map((m, i) => (
          <div key={m.key} className="grid grid-cols-2 md:grid-cols-[1fr_90px_100px_120px_110px_1fr_auto] gap-2 items-end border-b border-line-soft pb-3 last:border-0">
            <label className="flex flex-col gap-1 col-span-2 md:col-span-1"><span className="label-xs">Beschreibung</span><input value={m.description} onChange={(e) => updM(i, { description: e.target.value })} className="input" maxLength={500} /></label>
            <label className="flex flex-col gap-1"><span className="label-xs">Menge</span><input value={m.quantity} onChange={(e) => updM(i, { quantity: e.target.value })} className="input" inputMode="decimal" /></label>
            <label className="flex flex-col gap-1"><span className="label-xs">Einheit</span><select value={m.unit} onChange={(e) => updM(i, { unit: e.target.value })} className="input">{INVOICE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>
            <label className="flex flex-col gap-1"><span className="label-xs">Einzelbetrag</span><input value={m.unitPrice} onChange={(e) => updM(i, { unitPrice: e.target.value })} className="input" inputMode="decimal" /></label>
            <label className="flex flex-col gap-1"><span className="label-xs">USt.</span>{nonTaxable ? <span className="input bg-panel-2">nicht steuerbar</span> : <select value={m.taxRate} onChange={(e) => updM(i, { taxRate: e.target.value })} className="input">{rateOptions.map((r) => <option key={r} value={r}>{r} %</option>)}</select>}</label>
            <label className="flex flex-col gap-1 col-span-2 md:col-span-1"><span className="label-xs">Grund (Pflicht)</span><input value={m.reason} onChange={(e) => updM(i, { reason: e.target.value })} className="input" maxLength={300} /></label>
            <div className="flex items-center gap-2"><span className="font-mono tnum text-sm">{m.current ?? "–"}</span><button type="button" className="btn !py-1.5" onClick={() => removeManual(i)}>Entfernen</button></div>
          </div>
        ))}
      </div>

      <div className="card p-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="label-xs">Grund der Gutschrift (Pflicht, erscheint auf dem Beleg)</span>
          <input value={reason} onChange={(e) => { setReason(e.target.value); setDirty(true); }} maxLength={500} className="input" placeholder="z. B. Reinigungspauschale zu Unrecht berechnet" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-xs">Text auf dem Beleg (optional)</span>
          <textarea value={customerNote} onChange={(e) => { setCustomerNote(e.target.value); setDirty(true); }} rows={2} maxLength={2000} className="input" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-xs">Interne Notiz (nicht auf dem Beleg)</span>
          <textarea value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={2} maxLength={2000} className="input" />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">Gespeicherter Gutschriftbetrag: <span className="font-mono tnum font-semibold">{totalGross}</span> <span className="text-ink-3">· noch gutschreibbar laut Rechnung: {remainingGross}</span></div>
          <button type="button" onClick={submit} disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : dirty ? "Entwurf speichern und Beträge rechnen" : "Entwurf speichern"}</button>
        </div>
      </div>
    </div>
  );
}

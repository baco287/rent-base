"use client";

// Rechnungsentwurf bearbeiten. Zeigt die vom Server gerechneten Beträge; beim Speichern gehen nur Eingaben zum Server,
// der rechnet neu. Nichts hier ist eine Betragsquelle.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { INVOICE_UNITS } from "@/lib/constants";
import type { InvoiceDocumentData } from "@/lib/invoice-view";
import { FinalizeForm } from "../vertrag/wizard-ui";
import type { InvoiceState } from "./actions";

export type EditableItem = { id: string; description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; source: string; sourceLabel: string; net: string; tax: string; gross: string };

type Props = {
  /** Stand des Entwurfs auf dem Server; ändert er sich (nach dem Speichern), werden die Felder neu befüllt */
  version: number;
  doc: InvoiceDocumentData;
  items: EditableItem[];
  allowedRates: number[];
  draft: { customerNote: string; taxNote: string; notes: string; paymentTermDays: number | null };
  blocking: boolean;
  blockingReason?: string;
  save: (payload: unknown) => Promise<InvoiceState>;
  finalize: (prev: InvoiceState, fd: FormData) => Promise<InvoiceState>;
};

const eur = (s: string) => s;

/**
 * Nach dem Speichern liefert der Server die neu gerechneten Beträge. Der Editor wird dann über den Schlüssel (version)
 * neu aufgebaut, damit alle Felder den gespeicherten Stand zeigen; die Rückmeldung bleibt außerhalb erhalten.
 */
export function InvoiceEditor(props: Props) {
  const [message, setMessage] = useState<InvoiceState>(undefined);
  const [dirty, setDirty] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <EditorBody key={props.version} {...props} onSaved={setMessage} onDirty={setDirty} />
      {message?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{message.error}</p>}
      {message?.ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{message.ok}</p>}
      <FinalizeCard {...props} blocking={props.blocking || dirty} blockingReason={dirty ? "Bitte zuerst den Entwurf speichern." : props.blockingReason} />
    </div>
  );
}

function FinalizeCard({ finalize, blocking, blockingReason }: Props) {
  return (
    <div className="card p-4 flex flex-col gap-3">
      <p className="text-sm text-ink-2">Mit dem Abschluss vergibt das System die Rechnungsnummer, friert Empfänger, Firmendaten und Beträge ein, erzeugt das PDF und sendet es an den Rechnungsempfänger. Danach ist die Rechnung unveränderlich.</p>
      <FinalizeForm action={finalize} disabled={blocking} reason={blockingReason} label="Rechnung finalisieren" pendingLabel="Rechnung wird abgeschlossen…" />
    </div>
  );
}

function EditorBody({ doc, items: initial, allowedRates, draft, save, onSaved, onDirty }: Props & { onSaved: (s: InvoiceState) => void; onDirty: (d: boolean) => void }) {
  const router = useRouter();
  const [items, setItems] = useState(initial.map((i) => ({ ...i })));
  const [customerNote, setCustomerNote] = useState(draft.customerNote);
  const [taxNote, setTaxNote] = useState(draft.taxNote);
  const [notes, setNotes] = useState(draft.notes);
  const [paymentTermDays, setPaymentTermDays] = useState(draft.paymentTermDays == null ? "" : String(draft.paymentTermDays));
  const [pending, start] = useTransition();
  const [dirty, setDirtyState] = useState(false);
  const setDirty = (d: boolean) => { setDirtyState(d); onDirty(d); };
  const rateOptions = allowedRates.map((r) => r.toLocaleString("de-DE", { minimumFractionDigits: 2 }));

  const update = (idx: number, patch: Partial<EditableItem>) => { setItems((xs) => xs.map((x, i) => (i === idx ? { ...x, ...patch } : x))); setDirty(true); };
  const remove = (idx: number) => { setItems((xs) => xs.filter((_, i) => i !== idx)); setDirty(true); };
  const add = () => { setItems((xs) => [...xs, { id: "", description: "", quantity: "1", unit: "pauschal", unitPrice: "", taxRate: rateOptions[0] ?? "0,00", source: "MANUAL", sourceLabel: "Manuell erfasst", net: "–", tax: "–", gross: "–" }]); setDirty(true); };
  const submit = () => {
    onSaved(undefined);
    start(async () => {
      const res = await save({ items: items.map((i) => ({ id: i.id || undefined, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, taxRate: i.taxRate.replace(" %", "") })), customerNote, taxNote, notes, paymentTermDays });
      onSaved(res);
      if (!res?.error) {
        setDirty(false);
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2"><span className="font-semibold text-sm">Positionen</span><span className="text-xs text-ink-3">{doc.pricesIncludeTax ? "Einzelpreise sind Bruttobeträge, die Steuer wird herausgerechnet" : "Einzelpreise sind Nettobeträge, die Steuer kommt hinzu"}</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead><tr className="text-left text-xs text-ink-3 border-b border-line-soft"><th className="px-3 py-2 font-medium">Beschreibung</th><th className="px-2 py-2 font-medium w-20">Menge</th><th className="px-2 py-2 font-medium w-24">Einheit</th><th className="px-2 py-2 font-medium w-28 text-right">{doc.pricesIncludeTax ? "Einzelpreis brutto" : "Einzelpreis netto"}</th><th className="px-2 py-2 font-medium w-24">Steuer</th><th className="px-2 py-2 font-medium text-right">Netto</th><th className="px-2 py-2 font-medium text-right">Steuer</th><th className="px-2 py-2 font-medium text-right">Brutto</th><th className="w-10" /></tr></thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={it.id || `new-${idx}`} className="border-b border-line-soft align-top">
                  <td className="px-3 py-2">
                    <textarea value={it.description} onChange={(e) => update(idx, { description: e.target.value })} rows={2} className="input !py-1.5 text-sm" aria-label={`Beschreibung Position ${idx + 1}`} />
                    <div className="text-[11px] text-ink-3 mt-0.5">{it.sourceLabel}</div>
                  </td>
                  <td className="px-2 py-2"><input value={it.quantity} onChange={(e) => update(idx, { quantity: e.target.value })} inputMode="decimal" className="input !py-1.5 tnum" aria-label={`Menge Position ${idx + 1}`} /></td>
                  <td className="px-2 py-2"><select value={it.unit} onChange={(e) => update(idx, { unit: e.target.value })} className="input !py-1.5" aria-label={`Einheit Position ${idx + 1}`}>{INVOICE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select></td>
                  <td className="px-2 py-2"><input value={it.unitPrice} onChange={(e) => update(idx, { unitPrice: e.target.value })} inputMode="decimal" className="input !py-1.5 tnum text-right" aria-label={`Einzelpreis Position ${idx + 1}`} /></td>
                  <td className="px-2 py-2"><select value={it.taxRate} onChange={(e) => update(idx, { taxRate: e.target.value })} className="input !py-1.5" aria-label={`Steuersatz Position ${idx + 1}`}>{[...new Set([...rateOptions, it.taxRate])].map((r) => <option key={r} value={r}>{r} %</option>)}</select></td>
                  <td className="px-2 py-2 text-right font-mono tnum">{eur(it.net)}</td>
                  <td className="px-2 py-2 text-right font-mono tnum">{eur(it.tax)}</td>
                  <td className="px-2 py-2 text-right font-mono tnum font-semibold">{eur(it.gross)}</td>
                  <td className="px-2 py-2"><button type="button" onClick={() => remove(idx)} className="text-bad text-xs underline" aria-label={`Position ${idx + 1} entfernen`}>entfernen</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 flex flex-wrap items-center gap-3 border-t border-line-soft">
          <button type="button" className="btn" onClick={add}>Position hinzufügen</button>
          {dirty && <span className="text-xs text-amber">Beträge werden beim Speichern vom Server neu berechnet.</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <div className="card p-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1"><span className="label-xs">Zahlungsziel in Tagen (leer = keins)</span><input value={paymentTermDays} onChange={(e) => { setPaymentTermDays(e.target.value); setDirty(true); }} type="number" min={0} max={365} className="input tnum max-w-[10rem]" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Text auf der Rechnung (optional)</span><textarea value={customerNote} onChange={(e) => { setCustomerNote(e.target.value); setDirty(true); }} rows={2} className="input" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Steuerhinweis (erscheint bei Positionen mit 0 %)</span><input value={taxNote} onChange={(e) => { setTaxNote(e.target.value); setDirty(true); }} className="input" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Interne Notiz (nicht auf der Rechnung)</span><textarea value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={2} className="input" /></label>
        </div>
        <div className="card p-4 flex flex-col gap-2 text-sm">
          <div className="font-semibold">Steuerzusammenfassung</div>
          {doc.taxSummary.map((t) => <div key={t.rate} className="flex justify-between"><span className="text-ink-3">{t.rate} auf {t.net}</span><span className="font-mono tnum">{t.tax}</span></div>)}
          <div className="flex justify-between border-t border-line-soft pt-2"><span className="text-ink-3">Netto</span><span className="font-mono tnum">{doc.totals.net}</span></div>
          <div className="flex justify-between"><span className="text-ink-3">Steuer</span><span className="font-mono tnum">{doc.totals.tax}</span></div>
          <div className="flex justify-between text-base font-semibold border-t-2 border-ink pt-2"><span>Gesamt</span><span className="font-mono tnum">{doc.totals.gross}</span></div>
          {dirty && <div className="text-xs text-amber">Ungespeicherte Änderungen: Die Summen zeigen den gespeicherten Stand.</div>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending} className="btn btn-primary" onClick={submit}>{pending ? "Wird gespeichert…" : "Entwurf speichern"}</button>
        <span className="text-xs text-ink-3">„Rechnung prüfen“ passiert beim Speichern und beim Laden automatisch, siehe Prüfliste oben.{dirty ? " Vor dem Abschluss bitte speichern." : ""}</span>
      </div>
    </div>
  );
}

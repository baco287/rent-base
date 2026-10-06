"use client";

// Befehl 28: „Zeitraum ändern“ vor der Vertragsunterschrift – alt/neu mit Preisvorschlag und Verfügbarkeitsprüfung (Server),
// Pflichtgrund. Kein freies Bearbeiten im Buchungsformular mehr; nach der Unterschrift läuft jede Änderung über einen Nachtrag.

import { useActionState, useRef, useState } from "react";
import { FormError } from "@/components/ui";
import type { CancelState, PeriodPreviewResult } from "./actions";

export function PeriodChangeDialog({ action, preview, startAt, endAt }: { action: (prev: CancelState, fd: FormData) => Promise<CancelState>; preview: (fd: FormData) => Promise<PeriodPreviewResult>; startAt: string; endAt: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, undefined);
  const [result, setResult] = useState<PeriodPreviewResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [reason, setReason] = useState("");
  // Befehl 29: Entscheidung über einen individuell vereinbarten Preis (nie still überschreiben)
  const [decision, setDecision] = useState<"" | "KEEP" | "TARIFF" | "INDIVIDUAL">("");
  const [newPrice, setNewPrice] = useState("");
  const [newPriceReason, setNewPriceReason] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  async function check() {
    if (!formRef.current) return;
    setChecking(true);
    try { setResult(await preview(new FormData(formRef.current))); } finally { setChecking(false); }
  }
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>Zeitraum ändern</button>;
  const decided = !result?.agreed || decision === "KEEP" || decision === "TARIFF" || (decision === "INDIVIDUAL" && newPrice.trim() !== "" && newPriceReason.trim().length >= 3);
  const ready = !!result && !result.error && !!result.after && reason.trim().length >= 3 && decided;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="period-title" className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onKeyDown={(e) => { if (e.key === "Escape" && !pending) setOpen(false); }}>
      <div className="w-full sm:max-w-lg max-h-[94vh] overflow-y-auto rounded-t-xl sm:rounded-xl bg-panel shadow-xl p-4 sm:p-5 flex flex-col gap-4">
        <h2 id="period-title" className="text-lg font-semibold">Zeitraum ändern</h2>
        <p className="text-sm text-ink-2">Nur vor der Vertragsunterschrift. Zahlungen und Kaution bleiben an dieser Buchung; der voraussichtliche Mietpreis folgt dem neuen Zeitraum.</p>
        <form ref={formRef} action={formAction} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1"><span className="label-xs">Neue Abholung</span><input name="startAt" type="datetime-local" defaultValue={startAt} onChange={() => setResult(null)} required className="input tnum" /></label>
            <label className="flex flex-col gap-1"><span className="label-xs">Neue Rückgabe</span><input name="endAt" type="datetime-local" defaultValue={endAt} onChange={() => setResult(null)} required className="input tnum" /></label>
          </div>
          <label className="flex flex-col gap-1"><span className="label-xs">Grund der Änderung (Pflicht)</span><textarea name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} rows={2} className="input" placeholder="z. B. Kunde kommt erst um 15:00" /></label>
          <button type="button" className="btn justify-center" onClick={check} disabled={checking || pending}>{checking ? "Wird geprüft…" : "Verfügbarkeit und Preis prüfen"}</button>
          {result && (
            <div className={`rounded-md p-3 text-sm flex flex-col gap-1 ${result.error ? "bg-bad-soft text-bad" : "border-2 border-brand bg-panel"}`}>
              {result.error ? <p role="alert">{result.error}</p> : null}
              <div className="flex justify-between gap-3"><span className="text-ink-2">Bisher</span><span className="font-mono tnum text-right">{result.before.range}<span className="block text-xs">{result.before.days} Tage · {result.before.price}</span></span></div>
              {result.after && <div className="flex justify-between gap-3"><span className="text-ink-2">Neu</span><span className="font-mono tnum text-right font-semibold">{result.after.range}<span className="block text-xs font-normal">{result.after.days} Tage · {result.agreed ? "neuer regulärer Tarifpreis" : "Preisvorschlag"} {result.after.price}{result.agreed ? "" : ` (${result.after.diff})`}</span></span></div>}
              {result.after && result.agreed && (
                <div role="group" aria-label="Preisentscheidung" className="mt-1 rounded-md bg-amber-soft text-ink px-3 py-2 flex flex-col gap-1.5">
                  <span className="text-amber font-medium">Für diese Buchung wurde ein individueller Preis vereinbart: {result.agreed.price} („{result.agreed.reason}“). Bitte bewusst entscheiden:</span>
                  <label className="flex items-center gap-2"><input type="radio" name="priceDecision" value="KEEP" checked={decision === "KEEP"} onChange={() => setDecision("KEEP")} /> Individuellen Preis beibehalten ({result.agreed.price})</label>
                  <label className="flex items-center gap-2"><input type="radio" name="priceDecision" value="TARIFF" checked={decision === "TARIFF"} onChange={() => setDecision("TARIFF")} /> Neuen Tarifpreis übernehmen ({result.after.price})</label>
                  <label className="flex items-center gap-2"><input type="radio" name="priceDecision" value="INDIVIDUAL" checked={decision === "INDIVIDUAL"} onChange={() => setDecision("INDIVIDUAL")} /> Neuen individuellen Preis festlegen</label>
                  {decision === "INDIVIDUAL" && (
                    <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-2 pl-6">
                      <input name="newPrice" inputMode="decimal" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="0,00" aria-label="Neuer Mietpreis in Euro" className="input tnum" />
                      <input name="newPriceReason" value={newPriceReason} onChange={(e) => setNewPriceReason(e.target.value)} placeholder="Grund (Pflicht)" aria-label="Grund für den neuen Preis" maxLength={300} className="input" />
                    </div>
                  )}
                </div>
              )}
              {result.overpaid && <p className="text-amber text-xs">Bereits gezahlt: {result.paid}. Das ist mehr als der neue Preis; ein Guthaben wird mit der Mietrechnung ausgewiesen und kann dann erstattet werden.</p>}
            </div>
          )}
          <FormError error={state?.error} />
          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <button type="button" className="btn justify-center" onClick={() => setOpen(false)} disabled={pending}>Abbrechen</button>
            <button type="submit" className="btn btn-primary justify-center" disabled={pending || !ready}>{pending ? "Wird gespeichert…" : "Zeitraum ändern"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

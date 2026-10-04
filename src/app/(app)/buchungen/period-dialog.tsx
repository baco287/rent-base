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
  const formRef = useRef<HTMLFormElement>(null);
  async function check() {
    if (!formRef.current) return;
    setChecking(true);
    try { setResult(await preview(new FormData(formRef.current))); } finally { setChecking(false); }
  }
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>Zeitraum ändern</button>;
  const ready = !!result && !result.error && !!result.after && reason.trim().length >= 3;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="period-title" className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onKeyDown={(e) => { if (e.key === "Escape" && !pending) setOpen(false); }}>
      <div className="w-full sm:max-w-lg max-h-[94vh] overflow-y-auto rounded-t-xl sm:rounded-xl bg-panel shadow-xl p-4 sm:p-5 flex flex-col gap-4">
        <h2 id="period-title" className="text-lg font-semibold">Zeitraum ändern</h2>
        <p className="text-sm text-ink-2">Nur vor der Vertragsunterschrift. Zahlungen und Kaution bleiben an dieser Buchung; der voraussichtliche Mietpreis folgt dem neuen Zeitraum.</p>
        <form ref={formRef} action={formAction} onChange={() => setResult(null)} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1"><span className="label-xs">Neue Abholung</span><input name="startAt" type="datetime-local" defaultValue={startAt} required className="input tnum" /></label>
            <label className="flex flex-col gap-1"><span className="label-xs">Neue Rückgabe</span><input name="endAt" type="datetime-local" defaultValue={endAt} required className="input tnum" /></label>
          </div>
          <label className="flex flex-col gap-1"><span className="label-xs">Grund der Änderung (Pflicht)</span><textarea name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} rows={2} className="input" placeholder="z. B. Kunde kommt erst um 15:00" /></label>
          <button type="button" className="btn justify-center" onClick={check} disabled={checking || pending}>{checking ? "Wird geprüft…" : "Verfügbarkeit und Preis prüfen"}</button>
          {result && (
            <div className={`rounded-md p-3 text-sm flex flex-col gap-1 ${result.error ? "bg-bad-soft text-bad" : "border-2 border-brand bg-panel"}`}>
              {result.error ? <p role="alert">{result.error}</p> : null}
              <div className="flex justify-between gap-3"><span className="text-ink-2">Bisher</span><span className="font-mono tnum text-right">{result.before.range}<span className="block text-xs">{result.before.days} Tage · {result.before.price}</span></span></div>
              {result.after && <div className="flex justify-between gap-3"><span className="text-ink-2">Neu</span><span className="font-mono tnum text-right font-semibold">{result.after.range}<span className="block text-xs font-normal">{result.after.days} Tage · Preisvorschlag {result.after.price} ({result.after.diff})</span></span></div>}
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

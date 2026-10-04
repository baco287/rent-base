"use client";

// Befehl 27: Storno nur nach ausdrücklicher Bestätigung mit Pflichtgrund. Die Prüfung, was an der Buchung hängt, kommt vom
// Server (cancellationCheck) und wird beim Absenden unter der Buchungssperre wiederholt – der Dialog zeigt sie nur an.

import { useActionState, useState } from "react";
import { FormError } from "@/components/ui";
import type { CancelState } from "./actions";

type Check = {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  booking: { number: string; customerName: string; vehicle: string; plate: string; period: string };
};

export function CancelBookingDialog({ action, check }: { action: (prev: CancelState, fd: FormData) => Promise<CancelState>; check: Check }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, undefined);
  const [reason, setReason] = useState("");
  if (!open) return <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>Stornieren…</button>;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cancel-title" className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onKeyDown={(e) => { if (e.key === "Escape" && !pending) setOpen(false); }}>
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-xl sm:rounded-xl bg-panel shadow-xl p-4 sm:p-5 flex flex-col gap-3">
        <h2 id="cancel-title" className="text-lg font-semibold">Buchung {check.booking.number} stornieren?</h2>
        <dl className="grid grid-cols-[minmax(90px,30%)_1fr] gap-x-3 gap-y-1 text-sm rounded-md bg-panel-2 p-3">
          <dt className="text-ink-3">Buchung</dt><dd className="font-mono tnum">{check.booking.number}</dd>
          <dt className="text-ink-3">Kunde</dt><dd>{check.booking.customerName}</dd>
          <dt className="text-ink-3">Fahrzeug</dt><dd>{check.booking.vehicle} · <span className="font-mono">{check.booking.plate}</span></dd>
          <dt className="text-ink-3">Zeitraum</dt><dd className="font-mono tnum">{check.booking.period}</dd>
        </dl>
        {check.blockers.length > 0 && (
          <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm flex flex-col gap-1.5">
            <div className="font-semibold">Storno derzeit nicht möglich</div>
            {check.blockers.map((b) => <p key={b}>{b}</p>)}
          </div>
        )}
        {check.warnings.length > 0 && (
          <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm flex flex-col gap-1.5">
            <div className="font-semibold">Bitte beachten</div>
            <ul className="list-disc pl-5 flex flex-col gap-1">{check.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
        {check.allowed ? (
          <form action={formAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="cancel-reason" className="label-xs">Grund der Stornierung (Pflicht)</label>
              <textarea id="cancel-reason" name="reason" required minLength={3} maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="input" placeholder="z. B. Kunde hat telefonisch abgesagt" />
            </div>
            <FormError error={state?.error} />
            <p className="text-xs text-ink-3">Das Storno kann nicht rückgängig gemacht werden. Grund, Zeitpunkt und Benutzer werden dauerhaft dokumentiert.</p>
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button type="button" className="btn justify-center" disabled={pending} onClick={() => setOpen(false)}>Abbrechen</button>
              <button type="submit" className="btn btn-danger justify-center" disabled={pending || reason.trim().length < 3}>{pending ? "Wird storniert…" : "Buchung verbindlich stornieren"}</button>
            </div>
          </form>
        ) : (
          <div className="flex justify-end"><button type="button" className="btn" onClick={() => setOpen(false)}>Schließen</button></div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useActionState } from "react";
import { startKeyDropExceptionAction, type StepState } from "./actions";

/** Befehl 20.6: Kontrolle ohne Kundenmeldung – nur Inhaber/Disposition, mit Pflichtgrund. */
export function KeyDropExceptionForm({ bookingId }: { bookingId: string }) {
  const [state, action, pending] = useActionState<StepState, FormData>(startKeyDropExceptionAction.bind(null, bookingId), undefined);
  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-3">
      <label htmlFor="kd-reason" className="label-xs">Ausnahme: Kontrolle ohne Kundenmeldung starten</label>
      <textarea id="kd-reason" name="reason" required minLength={10} rows={3} className="input" placeholder="Grund, z. B. Kunde telefonisch erreicht, Link funktioniert nicht; Fahrzeug steht seit … auf dem Hof" />
      <p className="text-xs text-ink-3">Der Grund wird im Protokoll und im Audit festgehalten. Der Rückgabelink des Kunden wird dabei sofort ungültig.</p>
      {state?.error && <p className="text-sm text-bad bg-bad-soft rounded-md px-3 py-2">{state.error}</p>}
      <div><button disabled={pending} className="btn">{pending ? "Wird gestartet…" : "Kontrolle ohne Kundenmeldung starten"}</button></div>
    </form>
  );
}

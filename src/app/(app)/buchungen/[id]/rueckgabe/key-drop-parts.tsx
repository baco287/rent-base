"use client";

import { useActionState } from "react";
import { setReturnTimeOverrideAction, startKeyDropExceptionAction, type StepState } from "./actions";

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

/** Befehl 20.6: maßgebliches Mietende korrigieren (Inhaber/Disposition, Pflichtgrund) oder die Korrektur zurücknehmen. */
export function ReturnTimeOverrideForm({ bookingId, defaultAt, hasOverride }: { bookingId: string; defaultAt: string; hasOverride: boolean }) {
  const [state, action, pending] = useActionState<StepState, FormData>(setReturnTimeOverrideAction.bind(null, bookingId), undefined);
  return (
    <details className="rounded-md border border-line">
      <summary className="cursor-pointer px-3 py-2">{hasOverride ? "Korrektur ändern oder zurücknehmen" : "Mietende abweichend festlegen"}</summary>
      <form action={action} className="p-3 flex flex-col gap-2">
        <label className="flex flex-col gap-1"><span className="label-xs">Maßgebliches Mietende</span><input name="at" type="datetime-local" defaultValue={defaultAt} className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Grund (Pflicht)</span><textarea name="reason" required minLength={10} rows={2} maxLength={500} className="input" placeholder="z. B. Fotos und Meldung erst um 23:40, Nachbar bestätigt Abstellen gegen 23:30" /></label>
        {state?.error && <p className="text-sm text-bad bg-bad-soft rounded-md px-3 py-2">{state.error}</p>}
        <div className="flex flex-wrap gap-2">
          <button disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Mietende festlegen"}</button>
          {hasOverride && <button name="reset" value="1" disabled={pending} className="btn">Korrektur zurücknehmen (Abgabe laut Kunde)</button>}
        </div>
        <p className="text-xs text-ink-3">Die Änderung wird mit Grund im Protokoll und im Audit festgehalten. Eine vorhandene Unterschrift des Mitarbeiters muss danach erneut geleistet werden.</p>
      </form>
    </details>
  );
}

"use client";

import { useActionState, useState } from "react";
import type { DocState } from "./actions";

type Action = (prev: DocState, formData: FormData) => Promise<DocState>;

function Feedback({ state }: { state: DocState }) {
  if (state?.error) return <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>;
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  return null;
}

/** Einzelne Schaltfläche mit Wartezustand und Rückmeldung, z. B. "PDF erzeugen". */
export function DocActionButton({ action, label, pendingLabel, primary = false }: { action: Action; label: string; pendingLabel: string; primary?: boolean }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div><button type="submit" disabled={pending} className={`btn ${primary ? "btn-primary" : ""}`}>{pending ? pendingLabel : label}</button></div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * "Unterlagen erneut senden": erst die Empfängeradresse zeigen, dann bestätigen lassen.
 * Eine Erfolgsmeldung erscheint erst, wenn der Server den Versand bestätigt hat.
 */
export function ResendForm({ action, recipient, nonce, label, disabledReason }: { action: Action; recipient: string | null; nonce: string; label: string; disabledReason?: string | null }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [open, setOpen] = useState(false);
  if (disabledReason) return <p className="text-sm text-ink-3">{disabledReason}</p>;
  return (
    <div className="flex flex-col gap-2">
      {!open ? (
        <div><button type="button" className="btn" onClick={() => setOpen(true)}>{label}</button></div>
      ) : (
        <form action={formAction} className="rounded-md border border-line bg-panel-2 p-3 flex flex-col gap-2.5">
          <input type="hidden" name="nonce" value={nonce} readOnly />
          <div className="text-sm">
            <div className="label-xs">Empfänger laut Mietvertrag</div>
            <div className="font-medium break-all">{recipient || "keine E-Mail-Adresse hinterlegt"}</div>
          </div>
          <p className="text-xs text-ink-3">Versendet werden die archivierten PDFs von Mietvertrag und Übergabeprotokoll. Es wird nichts neu erzeugt.</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gesendet…" : "Jetzt senden"}</button>
            <button type="button" disabled={pending} className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
          </div>
        </form>
      )}
      <Feedback state={state} />
    </div>
  );
}

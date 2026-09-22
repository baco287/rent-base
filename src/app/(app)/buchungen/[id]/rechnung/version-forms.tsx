"use client";

// Übergabemarkierung einer Rechnungsfassung mit ausdrücklicher Bestätigung. Ein PDF-Download ist keine Übergabe.
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import type { InvoiceState } from "./actions";

type Action = (prev: InvoiceState, fd: FormData) => Promise<InvoiceState>;

export function MarkDeliveredForm({ action, versionId, versionNo }: { action: Action; versionId: string; versionNo: number }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: InvoiceState, fd: FormData) => { const r = await action(prev, fd); if (r?.ok) router.refresh(); return r; }, undefined);
  const [open, setOpen] = useState(false);
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  if (!open) return <button type="button" className="btn !py-1.5" onClick={() => setOpen(true)}>Als an Kunden übergeben markieren</button>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2 rounded-md border border-line-soft bg-panel-2 p-3 text-sm">
      <input type="hidden" name="versionId" value={versionId} />
      <div className="font-medium">Bestätigen Sie, dass Fassung {versionNo} dieser Rechnung dem Kunden außerhalb des Rent-Base-E-Mail-Versands übergeben wurde (z. B. ausgedruckt oder persönlich).</div>
      <label className="flex flex-col gap-1"><span className="label-xs">Hinweis (optional)</span><input name="note" maxLength={300} className="input" placeholder="z. B. ausgedruckt bei der Rückgabe mitgegeben" /></label>
      <p className="text-xs text-ink-3">Danach gilt diese Fassung als übermittelt: Spätere Änderungen erzeugen eine berichtigte Rechnungsfassung mit Pflichtgrund. Die Markierung wird nicht wieder entfernt.</p>
      {state?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Ja, als übergeben markieren"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
    </form>
  );
}

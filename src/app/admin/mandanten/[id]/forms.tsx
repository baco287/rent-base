"use client";

import { useActionState, useState } from "react";
import { reactivateTenantAction, startSupportSessionAction, suspendTenantAction } from "@/app/admin/actions";
import { FormError } from "@/components/ui";

/** Mandant sperren: Pflichtgrund + Tippbestätigung „SPERREN“. Keine Daten werden gelöscht; Sitzungen enden sofort. */
export function SuspendTenantForm({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const [state, formAction, pending] = useActionState(suspendTenantAction, undefined);
  const [open, setOpen] = useState(false);

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="btn btn-danger">Mandant sperren</button>;

  return (
    <form action={formAction} className="flex flex-col gap-2 max-w-md">
      <input type="hidden" name="tenantId" value={tenantId} />
      <p className="rounded-md bg-bad-soft text-bad px-3 py-2 text-xs">Alle Benutzer von „{tenantName}“ werden sofort abgemeldet und sehen nur noch die Sperrseite. Daten, Belege und Nummernkreise bleiben unverändert. Die Aktion wird protokolliert.</p>
      <label htmlFor="reason" className="label-xs">Grund für die Sperrung</label>
      <textarea id="reason" name="reason" required rows={2} className="input" autoFocus />
      <label htmlFor="confirm" className="label-xs">Zur Bestätigung SPERREN eintippen</label>
      <input id="confirm" name="confirm" required autoComplete="off" className="input font-mono" placeholder="SPERREN" />
      <FormError error={state?.error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn btn-danger">{pending ? "Wird gesperrt…" : "Sperrung bestätigen"}</button>
        <button type="button" onClick={() => setOpen(false)} className="btn">Abbrechen</button>
      </div>
    </form>
  );
}

export function ReactivateTenantForm({ tenantId }: { tenantId: string }) {
  const [state, formAction, pending] = useActionState(reactivateTenantAction, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2" onSubmit={(e) => { if (!window.confirm("Mandant wieder freigeben? Benutzer können sich danach erneut anmelden.")) e.preventDefault(); }}>
      <input type="hidden" name="tenantId" value={tenantId} />
      <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird freigegeben…" : "Mandant freigeben"}</button>
      <FormError error={state?.error} />
    </form>
  );
}

/** „Als Kunde öffnen“: Supportmodus (read-only) mit Pflichtgrund und ausdrücklicher Bestätigung. */
export function StartSupportForm({ tenantId }: { tenantId: string }) {
  const [state, formAction, pending] = useActionState(startSupportSessionAction, undefined);
  const [open, setOpen] = useState(false);

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="btn btn-primary">Als Kunde öffnen (Supportmodus)</button>;

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="tenantId" value={tenantId} />
      <p className="rounded-md bg-amber-soft text-amber px-3 py-2 text-xs">Sie sehen die Mandantenoberfläche aus Kundensicht – schreibgeschützt, 60 Minuten, mit Banner. Start, Ende und Grund werden mit Ihrem Namen protokolliert. Ihre Admin-Sitzung bleibt bestehen.</p>
      <label htmlFor="support-reason" className="label-xs">Grund (z. B. Ticketnummer)</label>
      <textarea id="support-reason" name="reason" required rows={2} className="input" autoFocus />
      <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" name="confirm" required /> Ich habe einen konkreten Supportanlass; der Zugriff wird protokolliert.</label>
      <FormError error={state?.error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gestartet…" : "Supportmodus öffnen"}</button>
        <button type="button" onClick={() => setOpen(false)} className="btn">Abbrechen</button>
      </div>
    </form>
  );
}

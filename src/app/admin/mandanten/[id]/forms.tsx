"use client";

import { useActionState, useState } from "react";
import { suspendTenantAction, startSupportSessionAction } from "@/app/admin/actions";
import { FormError } from "@/components/ui";

export function SuspendTenantForm({ tenantId }: { tenantId: string }) {
  const [state, formAction, pending] = useActionState(suspendTenantAction, undefined);
  const [open, setOpen] = useState(false);

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="btn">Mandant sperren</button>;

  return (
    <form action={formAction} className="flex flex-col gap-2 max-w-md">
      <input type="hidden" name="tenantId" value={tenantId} />
      <label htmlFor="reason" className="label-xs">Grund für die Sperrung</label>
      <textarea id="reason" name="reason" required rows={2} className="input" autoFocus />
      <FormError error={state?.error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn btn-danger">{pending ? "Wird gesperrt…" : "Sperrung bestätigen"}</button>
        <button type="button" onClick={() => setOpen(false)} className="btn">Abbrechen</button>
      </div>
    </form>
  );
}

export function StartSupportForm({ tenantId }: { tenantId: string }) {
  const [state, formAction, pending] = useActionState(startSupportSessionAction, undefined);
  const [open, setOpen] = useState(false);

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="btn">Supportzugriff starten</button>;

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="tenantId" value={tenantId} />
      <p className="rounded-md bg-amber-soft text-amber px-3 py-2 text-xs">Sie öffnen jetzt den Mandanten im Supportmodus. Zugriffe werden protokolliert.</p>
      <label htmlFor="support-reason" className="label-xs">Grund</label>
      <textarea id="support-reason" name="reason" required rows={2} className="input" autoFocus />
      <FormError error={state?.error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gestartet…" : "Supportmodus öffnen"}</button>
        <button type="button" onClick={() => setOpen(false)} className="btn">Abbrechen</button>
      </div>
    </form>
  );
}

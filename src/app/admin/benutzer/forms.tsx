"use client";

import { useActionState, useState } from "react";
import { resendInvitationPlatformAction, toggleUserActiveAction } from "@/app/admin/actions";
import { FormError } from "@/components/ui";

/** Benutzer sperren (mit Bestätigung, beendet Sitzungen) oder entsperren. Ohne USER_MANAGE: nichts. */
export function UserActiveButton({ userId, active, canManage }: { userId: string; active: boolean; canManage: boolean }) {
  const [state, formAction, pending] = useActionState(toggleUserActiveAction, undefined);
  const [open, setOpen] = useState(false);
  if (!canManage) return null;
  if (active && !open) return <button type="button" onClick={() => setOpen(true)} className="btn !py-1">Sperren</button>;
  return (
    <form action={formAction} className="flex flex-col gap-1.5 items-end">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="active" value={active ? "0" : "1"} />
      {active ? (
        <>
          <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" name="confirm" required /> Benutzer sperren und alle Sitzungen beenden</label>
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="btn btn-danger !py-1">{pending ? "Wird gesperrt…" : "Sperrung bestätigen"}</button>
            <button type="button" onClick={() => setOpen(false)} className="btn !py-1">Abbrechen</button>
          </div>
        </>
      ) : (
        <button type="submit" disabled={pending} className="btn !py-1">{pending ? "…" : "Entsperren"}</button>
      )}
      <FormError error={state?.error} />
    </form>
  );
}

export function ResendInvitationButton({ tenantId, invitationId, canManage }: { tenantId: string; invitationId: string; canManage: boolean }) {
  const [state, formAction, pending] = useActionState(resendInvitationPlatformAction, undefined);
  if (!canManage) return null;
  return (
    <form action={formAction} className="flex flex-col gap-1 items-end">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="invitationId" value={invitationId} />
      <button type="submit" disabled={pending} className="btn !py-1">{pending ? "Wird gesendet…" : "Erneut senden"}</button>
      {state?.ok && <span className="text-xs text-good">{state.ok}</span>}
      <FormError error={state?.error} />
    </form>
  );
}

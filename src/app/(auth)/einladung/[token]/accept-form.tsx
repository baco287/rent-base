"use client";

import { useActionState } from "react";
import { acceptInvitationAction } from "@/app/(auth)/actions";

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(acceptInvitationAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <div className="flex flex-col gap-1">
        <label htmlFor="name" className="label-xs">Ihr Name</label>
        <input id="name" name="name" autoComplete="name" required className="input" autoFocus />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="label-xs">Passwort</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required className="input" />
        <p className="text-xs text-ink-3">Mindestens 10 Zeichen.</p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="passwordRepeat" className="label-xs">Passwort wiederholen</label>
        <input id="passwordRepeat" name="passwordRepeat" type="password" autoComplete="new-password" minLength={10} required className="input" />
      </div>
      {state?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>}
      <button type="submit" disabled={pending} className="btn btn-primary justify-center mt-1">
        {pending ? "Wird eingerichtet…" : "Account einrichten"}
      </button>
    </form>
  );
}

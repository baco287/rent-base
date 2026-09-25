"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordResetAction, type RequestResetState } from "@/app/(auth)/actions";

export function RequestResetForm() {
  const [state, formAction, pending] = useActionState<RequestResetState, FormData>(requestPasswordResetAction, undefined);

  if (state && "ok" in state) {
    return <p className="rounded-md bg-good-soft text-good px-3 py-2 text-sm">Wenn diese Adresse existiert, wurde eine E-Mail mit einem Link zum Zurücksetzen gesendet.</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="label-xs">E-Mail</label>
        <input id="email" name="email" type="email" autoComplete="email" required className="input" autoFocus />
      </div>
      {state?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>}
      <button type="submit" disabled={pending} className="btn btn-primary justify-center mt-1">
        {pending ? "Wird gesendet…" : "Link senden"}
      </button>
      <Link href="/login" className="text-sm text-ink-3 hover:text-ink text-center">Zurück zur Anmeldung</Link>
    </form>
  );
}

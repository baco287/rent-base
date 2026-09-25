"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction } from "../actions";

export function LoginForm({ weiter }: { weiter?: string }) {
  const [state, formAction, pending] = useActionState(loginAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {weiter && <input type="hidden" name="weiter" value={weiter} />}
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="label-xs">E-Mail</label>
        <input id="email" name="email" type="email" autoComplete="email" required className="input" autoFocus />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="label-xs">Passwort</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
        <Link href="/passwort-vergessen" className="text-xs text-ink-3 hover:text-ink self-end">Passwort vergessen?</Link>
      </div>
      {state?.error && (
        <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>
      )}
      <button type="submit" disabled={pending} className="btn btn-primary justify-center mt-1">
        {pending ? "Wird geprüft…" : "Anmelden"}
      </button>
    </form>
  );
}

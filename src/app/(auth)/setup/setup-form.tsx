"use client";

import { useActionState } from "react";
import { setupAction } from "../actions";

export function SetupForm({ needsKey }: { needsKey: boolean }) {
  const [state, formAction, pending] = useActionState(setupAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-3">
        <legend className="font-display text-lg font-semibold mb-1">Vermietung</legend>
        <div className="flex flex-col gap-1">
          <label htmlFor="tenantName" className="label-xs">Firmenname</label>
          <input id="tenantName" name="tenantName" required className="input" placeholder="z. B. Karakuş Autovermietung" autoFocus />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="city" className="label-xs">Ort</label>
          <input id="city" name="city" className="input" placeholder="Hannover" />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-display text-lg font-semibold mb-1">Inhaber-Konto</legend>
        <div className="flex flex-col gap-1">
          <label htmlFor="name" className="label-xs">Dein Name</label>
          <input id="name" name="name" required className="input" autoComplete="name" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="email" className="label-xs">E-Mail</label>
          <input id="email" name="email" type="email" required className="input" autoComplete="email" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="password" className="label-xs">Passwort, mindestens 10 Zeichen</label>
          <input id="password" name="password" type="password" required minLength={10} className="input" autoComplete="new-password" />
        </div>
      </fieldset>

      {needsKey && (
        <div className="flex flex-col gap-1">
          <label htmlFor="setupKey" className="label-xs">Einrichtungsschlüssel</label>
          <input id="setupKey" name="setupKey" type="password" required className="input font-mono" autoComplete="off" />
          <span className="text-xs text-ink-3">Steht in den Server-Einstellungen (SETUP_KEY). Nur der Betreiber kennt ihn.</span>
        </div>
      )}
      {state?.error && (
        <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>
      )}
      <button type="submit" disabled={pending} className="btn btn-primary justify-center mt-1">
        {pending ? "Wird angelegt…" : "Einrichtung abschließen"}
      </button>
    </form>
  );
}

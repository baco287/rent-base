"use client";

import { useActionState } from "react";
import { FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import type { TariffFormState } from "./actions";

/** Tarif duplizieren: neuer Name, Kopie ist zunächst deaktiviert. */
export function DuplicateForm({ action, createKey, suggestion }: { action: (prev: TariffFormState, fd: FormData) => Promise<TariffFormState>; createKey: string; suggestion: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2">
      <input type="hidden" name="createKey" value={createKey} />
      <label className="flex flex-col gap-1"><span className="label-xs">Name der Kopie</span><input name="name" defaultValue={suggestion} required maxLength={60} className="input" /></label>
      <FormError error={state?.error} />
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird kopiert…" : "Tarif duplizieren"}</button></div>
      <p className="text-xs text-ink-3">Die Kopie ist zunächst deaktiviert und wird erst nach Prüfung angeboten.</p>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { Field, FormError } from "@/components/ui";
import { NUMBER_RANGE_LABELS, type NumberRangeKey } from "@/lib/number-ranges";
import { updateNumberRangesAction } from "./actions";

export function NumberRangesForm({ prefixes, next }: { prefixes: Record<NumberRangeKey, string>; next: Record<NumberRangeKey, string> }) {
  const [state, formAction, pending] = useActionState(updateNumberRangesAction, undefined);
  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-x-4 gap-y-3.5 p-5">
      {(Object.keys(NUMBER_RANGE_LABELS) as NumberRangeKey[]).map((k) => (
        <Field key={k} label={`Präfix ${NUMBER_RANGE_LABELS[k]}`} htmlFor={`range-${k}`} hint={`Nächste Nummer: ${next[k]}`}>
          <input id={`range-${k}`} name={k} defaultValue={prefixes[k]} maxLength={6} pattern="[A-Za-z]{1,6}" required className="input font-mono uppercase" autoComplete="off" />
        </Field>
      ))}
      <FormError error={state?.error} />
      {state?.ok && <p className="md:col-span-2 xl:col-span-4 text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>}
      <div className="md:col-span-2 xl:col-span-4"><button disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Nummernkreise speichern"}</button></div>
    </form>
  );
}

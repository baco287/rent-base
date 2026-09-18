"use client";

import { useActionState } from "react";
import Link from "next/link";
import { FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import type { FormState } from "./actions";
import { CustomerFields, type CustomerFormValues } from "./customer-fields";

export { emptyCustomer, type CustomerFormValues } from "./customer-fields";

export function CustomerForm({
  action,
  values,
  submitLabel,
  cancelHref,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values: CustomerFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);

  return (
    <form onSubmit={submitWithoutReset(formAction)} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      <CustomerFields values={values} />
      <FormError error={state?.error} />
      <div className="md:col-span-2 flex items-center gap-2 mt-1">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : submitLabel}</button>
        <Link href={cancelHref} className="btn">Abbrechen</Link>
      </div>
    </form>
  );
}

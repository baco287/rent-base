"use client";

import { useActionState } from "react";
import { createTenantAction } from "@/app/admin/actions";
import { Field, FormError } from "@/components/ui";

export function CreateTenantForm() {
  const [state, formAction, pending] = useActionState(createTenantAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Firmenname der Autovermietung" htmlFor="companyName" full>
        <input id="companyName" name="companyName" required className="input" autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Vorname des Inhabers" htmlFor="ownerFirstName">
          <input id="ownerFirstName" name="ownerFirstName" required className="input" />
        </Field>
        <Field label="Nachname des Inhabers" htmlFor="ownerLastName">
          <input id="ownerLastName" name="ownerLastName" required className="input" />
        </Field>
      </div>
      <Field label="E-Mail-Adresse des Inhabers" htmlFor="ownerEmail" full hint="Er erhält eine Einladung mit einem Link zur Kontoeinrichtung – kein Passwort per E-Mail.">
        <input id="ownerEmail" name="ownerEmail" type="email" required className="input" />
      </Field>
      <Field label="Interne Notiz (optional)" htmlFor="note" full>
        <textarea id="note" name="note" rows={2} className="input" />
      </Field>
      <FormError error={state?.error} />
      <button type="submit" disabled={pending} className="btn btn-primary justify-center">
        {pending ? "Wird angelegt…" : "Mandant anlegen und Inhaber einladen"}
      </button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { ROLES } from "@/lib/constants";
import { Field, FormError } from "@/components/ui";
import { createUserAction, updateTenantAction, type FormState } from "./actions";

function Ok({ state }: { state: FormState }) {
  if (!state?.ok) return null;
  return <p className="md:col-span-2 text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
}

export function TenantForm({ t }: { t: { name: string; street: string | null; zip: string | null; city: string | null; phone: string | null; email: string | null } }) {
  const [state, formAction, pending] = useActionState(updateTenantAction, undefined);
  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 p-5">
      <Field label="Firmenname" htmlFor="name" full><input id="name" name="name" defaultValue={t.name} required className="input" /></Field>
      <Field label="Straße und Hausnummer" htmlFor="street" full><input id="street" name="street" defaultValue={t.street ?? ""} className="input" /></Field>
      <Field label="PLZ" htmlFor="zip"><input id="zip" name="zip" defaultValue={t.zip ?? ""} className="input" /></Field>
      <Field label="Ort" htmlFor="city"><input id="city" name="city" defaultValue={t.city ?? ""} className="input" /></Field>
      <Field label="Telefon" htmlFor="phone"><input id="phone" name="phone" defaultValue={t.phone ?? ""} className="input" /></Field>
      <Field label="E-Mail" htmlFor="email"><input id="email" name="email" type="email" defaultValue={t.email ?? ""} className="input" /></Field>
      <FormError error={state?.error} />
      <Ok state={state} />
      <div className="md:col-span-2"><button disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Speichern"}</button></div>
    </form>
  );
}

export function NewUserForm() {
  const [state, formAction, pending] = useActionState(createUserAction, undefined);
  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 p-5" key={state?.ok}>
      <Field label="Name" htmlFor="u-name"><input id="u-name" name="name" required className="input" autoComplete="off" /></Field>
      <Field label="E-Mail" htmlFor="u-email"><input id="u-email" name="email" type="email" required className="input" autoComplete="off" /></Field>
      <Field label="Rolle" htmlFor="u-role" hint="Inhaber: alles. Disponent: Buchungen und Stammdaten. Hofmitarbeiter: Übergaben und Kunden.">
        <select id="u-role" name="role" defaultValue="DISPO" className="input">
          {Object.entries(ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Startpasswort, mindestens 10 Zeichen" htmlFor="u-password" hint="Dem Mitarbeiter persönlich mitteilen">
        <input id="u-password" name="password" type="password" required minLength={10} className="input" autoComplete="new-password" />
      </Field>
      <FormError error={state?.error} />
      <Ok state={state} />
      <div className="md:col-span-2"><button disabled={pending} className="btn btn-primary">{pending ? "Wird angelegt…" : "Mitarbeiter anlegen"}</button></div>
    </form>
  );
}

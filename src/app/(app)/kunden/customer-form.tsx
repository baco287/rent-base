"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { CUSTOMER_TYPES } from "@/lib/constants";
import { Field, FormError } from "@/components/ui";
import type { FormState } from "./actions";

export type CustomerFormValues = {
  type: string;
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  zip: string;
  city: string;
  birthDate: string;
  licenseNumber: string;
  licenseClass: string;
  licenseIssuedAt: string;
  licenseValidUntil: string;
  blocked: boolean;
  blockReason: string;
  discountPercent: string;
  notes: string;
};

export const emptyCustomer: CustomerFormValues = {
  type: "PRIVATE", companyName: "", firstName: "", lastName: "", email: "", phone: "", street: "", zip: "", city: "",
  birthDate: "", licenseNumber: "", licenseClass: "B", licenseIssuedAt: "", licenseValidUntil: "",
  blocked: false, blockReason: "", discountPercent: "0", notes: "",
};

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
  const [type, setType] = useState(values.type);
  const [blocked, setBlocked] = useState(values.blocked);
  const v = values;

  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      <h2 className="md:col-span-2 text-base font-semibold mt-1">Kunde</h2>
      <Field label="Kundenart" htmlFor="type">
        <select id="type" name="type" value={type} onChange={(e) => setType(e.target.value)} className="input">
          {Object.entries(CUSTOMER_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      {type === "COMPANY" ? (
        <Field label="Firmenname" htmlFor="companyName">
          <input id="companyName" name="companyName" defaultValue={v.companyName} required className="input" autoFocus />
        </Field>
      ) : (
        <div className="hidden md:block" />
      )}
      <Field label={type === "COMPANY" ? "Ansprechpartner Vorname" : "Vorname"} htmlFor="firstName">
        <input id="firstName" name="firstName" defaultValue={v.firstName} required className="input" autoComplete="off" autoFocus={type !== "COMPANY"} />
      </Field>
      <Field label={type === "COMPANY" ? "Ansprechpartner Nachname" : "Nachname"} htmlFor="lastName">
        <input id="lastName" name="lastName" defaultValue={v.lastName} required className="input" autoComplete="off" />
      </Field>
      <Field label="Telefon" htmlFor="phone">
        <input id="phone" name="phone" type="tel" defaultValue={v.phone} className="input" />
      </Field>
      <Field label="E-Mail" htmlFor="email">
        <input id="email" name="email" type="email" defaultValue={v.email} className="input" />
      </Field>
      <Field label="Straße und Hausnummer" htmlFor="street" full>
        <input id="street" name="street" defaultValue={v.street} className="input" />
      </Field>
      <Field label="PLZ" htmlFor="zip">
        <input id="zip" name="zip" defaultValue={v.zip} className="input" inputMode="numeric" />
      </Field>
      <Field label="Ort" htmlFor="city">
        <input id="city" name="city" defaultValue={v.city} className="input" />
      </Field>
      <Field label="Geburtsdatum" htmlFor="birthDate">
        <input id="birthDate" name="birthDate" type="date" defaultValue={v.birthDate} className="input" />
      </Field>
      <Field label="Rabatt in %" htmlFor="discountPercent" hint="Für Stammkunden, wird bei Buchungen vorgeschlagen">
        <input id="discountPercent" name="discountPercent" type="number" min={0} max={100} defaultValue={v.discountPercent} className="input tnum" />
      </Field>

      <h2 className="md:col-span-2 text-base font-semibold mt-2">Führerschein</h2>
      <Field label="Führerscheinnummer" htmlFor="licenseNumber">
        <input id="licenseNumber" name="licenseNumber" defaultValue={v.licenseNumber} className="input font-mono" />
      </Field>
      <Field label="Klasse" htmlFor="licenseClass">
        <input id="licenseClass" name="licenseClass" defaultValue={v.licenseClass} className="input" placeholder="B" />
      </Field>
      <Field label="Ausgestellt am" htmlFor="licenseIssuedAt" hint="Wichtig für Fahranfänger-Regeln">
        <input id="licenseIssuedAt" name="licenseIssuedAt" type="date" defaultValue={v.licenseIssuedAt} className="input" />
      </Field>
      <Field label="Gültig bis" htmlFor="licenseValidUntil">
        <input id="licenseValidUntil" name="licenseValidUntil" type="date" defaultValue={v.licenseValidUntil} className="input" />
      </Field>

      <h2 className="md:col-span-2 text-base font-semibold mt-2">Sperre und Notizen</h2>
      <div className="md:col-span-2 flex items-center gap-2">
        <input id="blocked" name="blocked" type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} className="size-4" />
        <label htmlFor="blocked" className="font-medium">Kunde gesperrt, keine neuen Buchungen möglich</label>
      </div>
      {blocked && (
        <Field label="Grund der Sperre" htmlFor="blockReason" full>
          <input id="blockReason" name="blockReason" defaultValue={v.blockReason} className="input" placeholder="z. B. Schaden nicht bezahlt" />
        </Field>
      )}
      <Field label="Notizen" htmlFor="notes" full>
        <textarea id="notes" name="notes" defaultValue={v.notes} rows={3} className="input" />
      </Field>

      <FormError error={state?.error} />
      <div className="md:col-span-2 flex items-center gap-2 mt-1">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : submitLabel}</button>
        <Link href={cancelHref} className="btn">Abbrechen</Link>
      </div>
    </form>
  );
}

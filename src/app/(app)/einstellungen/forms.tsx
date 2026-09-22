"use client";

import { useActionState } from "react";
import { ROLES } from "@/lib/constants";
import { Field, FormError } from "@/components/ui";
import { createUserAction, updateInvoiceSettingsAction, updateTenantAction, updateTermsAction, type FormState } from "./actions";

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

export function TermsForm({ version, text }: { version: string | null; text: string | null }) {
  const [state, formAction, pending] = useActionState(updateTermsAction, undefined);
  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 p-5">
      <Field label="Fassung" htmlFor="rentalTermsVersion" hint="z. B. 2026-09. Steht auf jedem Vertrag."><input id="rentalTermsVersion" name="rentalTermsVersion" defaultValue={version ?? ""} className="input" /></Field>
      <div className="hidden md:block" />
      <Field label="Text der Mietbedingungen" htmlFor="rentalTermsText" full hint="Bitte von einem Anwalt prüfen lassen. Abgeschlossene Verträge behalten ihre damalige Fassung.">
        <textarea id="rentalTermsText" name="rentalTermsText" defaultValue={text ?? ""} rows={12} className="input" />
      </Field>
      <FormError error={state?.error} />
      <Ok state={state} />
      <div className="md:col-span-2"><button disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Mietbedingungen speichern"}</button></div>
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

export type InvoiceSettings = { legalForm: string | null; country: string; vatId: string | null; taxNumber: string | null; bankName: string | null; iban: string | null; bic: string | null; invoiceFooter: string | null; paymentTermDays: number | null; defaultTaxRate: string | null; pricesIncludeTax: boolean | null; taxNote: string | null };

/** Rechnungsdaten. Steuerliche Angaben werden bewusst nicht vorbelegt: Der Inhaber entscheidet, das System rät nicht. */
export function InvoiceSettingsForm({ t }: { t: InvoiceSettings }) {
  const [state, formAction, pending] = useActionState(updateInvoiceSettingsAction, undefined);
  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 p-5">
      <Field label="Rechtsform" htmlFor="legalForm" hint="z. B. GmbH, e. K. oder leer. Wird hinter dem Firmennamen geführt."><input id="legalForm" name="legalForm" defaultValue={t.legalForm ?? ""} className="input" /></Field>
      <Field label="Land" htmlFor="country" hint="Zweibuchstaben-Kürzel"><input id="country" name="country" defaultValue={t.country} maxLength={2} className="input" /></Field>
      <Field label="Umsatzsteuer-ID" htmlFor="vatId"><input id="vatId" name="vatId" defaultValue={t.vatId ?? ""} className="input" placeholder="DE123456789" /></Field>
      <Field label="Steuernummer" htmlFor="taxNumber"><input id="taxNumber" name="taxNumber" defaultValue={t.taxNumber ?? ""} className="input" /></Field>
      <Field label="Steuersatz für Rechnungspositionen in %" htmlFor="defaultTaxRate" hint="Leer = Rechnungen sind gesperrt, bis der Satz feststeht. Der Satz wird je Position gespeichert."><input id="defaultTaxRate" name="defaultTaxRate" inputMode="decimal" defaultValue={t.defaultTaxRate ?? ""} className="input tnum" placeholder="z. B. 19" /></Field>
      <Field label="Miet- und Zusatzkostenpreise sind" htmlFor="pricesIncludeTax" hint="Entscheidet, ob aus den Vertragsbeträgen die Steuer herausgerechnet oder aufgeschlagen wird.">
        <select id="pricesIncludeTax" name="pricesIncludeTax" defaultValue={t.pricesIncludeTax == null ? "" : t.pricesIncludeTax ? "true" : "false"} className="input">
          <option value="">noch nicht festgelegt</option>
          <option value="true">Bruttobeträge (Steuer enthalten)</option>
          <option value="false">Nettobeträge (Steuer kommt hinzu)</option>
        </select>
      </Field>
      <Field label="Steuerhinweis bei Positionen mit 0 %" htmlFor="taxNote" full hint="Erscheint nur, wenn eine Rechnung Positionen mit 0 % enthält. Den Text legt der Inhaber fest, das System macht keine steuerliche Aussage."><input id="taxNote" name="taxNote" defaultValue={t.taxNote ?? ""} className="input" /></Field>
      <Field label="Zahlungsziel in Tagen" htmlFor="paymentTermDays" hint="Leer = kein Zahlungsziel auf der Rechnung"><input id="paymentTermDays" name="paymentTermDays" type="number" min={0} max={365} defaultValue={t.paymentTermDays ?? ""} className="input tnum" /></Field>
      <Field label="Bank" htmlFor="bankName"><input id="bankName" name="bankName" defaultValue={t.bankName ?? ""} className="input" /></Field>
      <Field label="IBAN" htmlFor="iban"><input id="iban" name="iban" defaultValue={t.iban ?? ""} className="input font-mono" /></Field>
      <Field label="BIC" htmlFor="bic"><input id="bic" name="bic" defaultValue={t.bic ?? ""} className="input font-mono" /></Field>
      <Field label="Fußtext auf Rechnungen" htmlFor="invoiceFooter" full><textarea id="invoiceFooter" name="invoiceFooter" defaultValue={t.invoiceFooter ?? ""} rows={3} className="input" /></Field>
      <FormError error={state?.error} />
      <Ok state={state} />
      <div className="md:col-span-2"><button disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Rechnungsdaten speichern"}</button></div>
    </form>
  );
}

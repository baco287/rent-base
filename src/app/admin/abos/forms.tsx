"use client";

import { useActionState } from "react";
import { saveSubscriptionAction } from "@/app/admin/actions";
import { Field, FormError } from "@/components/ui";
import { PLANS, SUBSCRIPTION_STATUS } from "@/lib/constants";

export type SubscriptionFormValues = {
  plan: string;
  status: string;
  startedAt: string;
  trialEndsAt: string;
  cancelledAt: string;
  endsAt: string;
  monthlyPriceEur: string;
  maxUsers: string;
  maxVehicles: string;
  note: string;
} | null;

/** Tarif/Abo eines Mandanten pflegen (BILLING_MANAGE). Keine Zahlungsabwicklung – reine interne Erfassung. */
export function SubscriptionForm({ tenantId, values, canManage }: { tenantId: string; values: SubscriptionFormValues; canManage: boolean }) {
  const [state, formAction, pending] = useActionState(saveSubscriptionAction, undefined);
  const v = values ?? { plan: "TRIAL", status: "TRIAL", startedAt: "", trialEndsAt: "", cancelledAt: "", endsAt: "", monthlyPriceEur: "", maxUsers: "", maxVehicles: "", note: "" };
  const ro = !canManage;
  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <Field label="Tarif" htmlFor="plan">
        <select id="plan" name="plan" defaultValue={v.plan} className="input" disabled={ro}>
          {Object.entries(PLANS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Abo-Status" htmlFor="status">
        <select id="status" name="status" defaultValue={v.status} className="input" disabled={ro}>
          {Object.entries(SUBSCRIPTION_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Startdatum" htmlFor="startedAt" hint="leer = heute bzw. unverändert"><input id="startedAt" name="startedAt" type="date" defaultValue={v.startedAt} className="input" disabled={ro} /></Field>
      <Field label="Testphase endet am" htmlFor="trialEndsAt" hint="Pflicht bei Status Testphase"><input id="trialEndsAt" name="trialEndsAt" type="date" defaultValue={v.trialEndsAt} className="input" disabled={ro} /></Field>
      <Field label="Kündigungsdatum" htmlFor="cancelledAt" hint="Pflicht bei Gekündigt/Beendet"><input id="cancelledAt" name="cancelledAt" type="date" defaultValue={v.cancelledAt} className="input" disabled={ro} /></Field>
      <Field label="Laufzeitende" htmlFor="endsAt"><input id="endsAt" name="endsAt" type="date" defaultValue={v.endsAt} className="input" disabled={ro} /></Field>
      <Field label="Monatspreis netto (EUR)" htmlFor="monthlyPriceEur" hint="leer = nicht erfasst; Basis für MRR"><input id="monthlyPriceEur" name="monthlyPriceEur" inputMode="decimal" defaultValue={v.monthlyPriceEur} className="input" disabled={ro} placeholder="z. B. 149,00" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max. Benutzer" htmlFor="maxUsers" hint="leer = unbegrenzt"><input id="maxUsers" name="maxUsers" inputMode="numeric" defaultValue={v.maxUsers} className="input" disabled={ro} /></Field>
        <Field label="Max. Fahrzeuge" htmlFor="maxVehicles" hint="leer = unbegrenzt"><input id="maxVehicles" name="maxVehicles" inputMode="numeric" defaultValue={v.maxVehicles} className="input" disabled={ro} /></Field>
      </div>
      <Field label="Interne Notiz" htmlFor="note" full><textarea id="note" name="note" rows={2} defaultValue={v.note} className="input" disabled={ro} placeholder="z. B. Sonderkonditionen, Vertragsnummer, Ansprechpartner" /></Field>
      <FormError error={state?.error} />
      {state?.ok && <p className="md:col-span-2 text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>}
      {canManage && (
        <div className="md:col-span-2">
          <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : values ? "Tarif/Abo speichern" : "Tarif/Abo anlegen"}</button>
        </div>
      )}
    </form>
  );
}

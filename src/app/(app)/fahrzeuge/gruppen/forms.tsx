"use client";

import { useActionState } from "react";
import { Field, FormError } from "@/components/ui";
import { createGroupAction, updateGroupAction } from "./actions";

export type GroupFormValues = {
  name: string;
  description: string;
  sortOrder: string;
  dailyRate: string;
  workWeekRate: string;
  weeklyRate: string;
  monthlyRate: string;
  kmIncludedPerDay: string;
  extraKmRate: string;
  deposit: string;
};

export function GroupForm({ id, values }: { id?: string; values: GroupFormValues }) {
  const action = id ? updateGroupAction.bind(null, id) : createGroupAction;
  const [state, formAction, pending] = useActionState(action, undefined);
  const v = values;
  const isNew = !id;

  return (
    <form action={formAction} className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-3 p-4" key={isNew ? state?.ok : undefined}>
      <Field label="Name" htmlFor={`name-${id ?? "neu"}`} full>
        <input id={`name-${id ?? "neu"}`} name="name" defaultValue={v.name} required className="input" placeholder="z. B. Transporter 3,5 t" />
      </Field>
      <Field label="Reihenfolge" htmlFor={`sort-${id ?? "neu"}`}>
        <input id={`sort-${id ?? "neu"}`} name="sortOrder" type="number" min={0} defaultValue={v.sortOrder} className="input tnum" />
      </Field>
      <div className="col-span-2 md:col-span-3">
        <Field label="Beschreibung" htmlFor={`desc-${id ?? "neu"}`}>
          <input id={`desc-${id ?? "neu"}`} name="description" defaultValue={v.description} className="input" placeholder="z. B. bis 3,5 t, Führerschein B" />
        </Field>
      </div>
      <div className="col-span-2 md:col-span-3 label-xs !normal-case !tracking-normal !text-ink-2 -mb-1">Preise brutto</div>
      <Field label="Tag €" htmlFor={`d-${id ?? "neu"}`}><input id={`d-${id ?? "neu"}`} name="dailyRate" inputMode="decimal" defaultValue={v.dailyRate} className="input tnum" /></Field>
      <Field label="Woche € (5 Tage)" htmlFor={`w5-${id ?? "neu"}`}><input id={`w5-${id ?? "neu"}`} name="workWeekRate" inputMode="decimal" defaultValue={v.workWeekRate} className="input tnum" /></Field>
      <Field label="Kalenderwoche € (7 Tage)" htmlFor={`w-${id ?? "neu"}`}><input id={`w-${id ?? "neu"}`} name="weeklyRate" inputMode="decimal" defaultValue={v.weeklyRate} className="input tnum" /></Field>
      <Field label="Monat €" htmlFor={`m-${id ?? "neu"}`}><input id={`m-${id ?? "neu"}`} name="monthlyRate" inputMode="decimal" defaultValue={v.monthlyRate} className="input tnum" /></Field>
      <Field label="Frei-km / Tag" htmlFor={`k-${id ?? "neu"}`}><input id={`k-${id ?? "neu"}`} name="kmIncludedPerDay" type="number" min={0} defaultValue={v.kmIncludedPerDay} className="input tnum" /></Field>
      <Field label="Mehr-km €" htmlFor={`x-${id ?? "neu"}`}><input id={`x-${id ?? "neu"}`} name="extraKmRate" inputMode="decimal" defaultValue={v.extraKmRate} className="input tnum" /></Field>
      <Field label="Kaution €" htmlFor={`c-${id ?? "neu"}`}><input id={`c-${id ?? "neu"}`} name="deposit" inputMode="decimal" defaultValue={v.deposit} className="input tnum" /></Field>
      <div className="col-span-2 md:col-span-3 flex items-center gap-3">
        <button disabled={pending} className={`btn ${isNew ? "btn-primary" : ""}`}>{pending ? "Wird gespeichert…" : isNew ? "Gruppe anlegen" : "Speichern"}</button>
        {state?.ok && <span className="text-good text-sm">{state.ok}</span>}
      </div>
      <FormError error={state?.error} />
    </form>
  );
}

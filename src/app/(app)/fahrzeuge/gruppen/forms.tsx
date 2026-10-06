"use client";

import { useActionState } from "react";
import { Field, FormError } from "@/components/ui";
import { LICENSE_CLASSES } from "@/lib/constants";
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
  requiredLicenseClass: string;
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
      <p className="col-span-2 md:col-span-3 text-xs text-ink-3">Preise, Kilometer und Kaution der Gruppe kommen aus den Miettarifen (Einstellungen → Miettarife).</p>
      <Field label="Erforderliche Fahrerlaubnisklasse" htmlFor={`rlc-${id ?? "neu"}`} hint="Phase 19.5: leer = Standard (PKW = B)">
        <select id={`rlc-${id ?? "neu"}`} name="requiredLicenseClass" defaultValue={v.requiredLicenseClass} className="input">
          <option value="">Standard nach Fahrzeugart</option>
          {Object.keys(LICENSE_CLASSES).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <div className="col-span-2 md:col-span-3 flex items-center gap-3">
        <button disabled={pending} className={`btn ${isNew ? "btn-primary" : ""}`}>{pending ? "Wird gespeichert…" : isNew ? "Gruppe anlegen" : "Speichern"}</button>
        {state?.ok && <span className="text-good text-sm">{state.ok}</span>}
      </div>
      <FormError error={state?.error} />
    </form>
  );
}

"use client";

import { useActionState } from "react";
import Link from "next/link";
import { FUELS, VEHICLE_CATEGORIES, VEHICLE_STATUS } from "@/lib/constants";
import { Field, FormError } from "@/components/ui";
import type { FormState } from "./actions";

export type VehicleFormValues = {
  plate: string;
  make: string;
  model: string;
  category: string;
  fuel: string;
  status: string;
  year: string;
  vin: string;
  color: string;
  mileage: string;
  huDate: string;
  dailyRate: string;
  weeklyRate: string;
  monthlyRate: string;
  kmIncludedPerDay: string;
  extraKmRate: string;
  deposit: string;
  notes: string;
};

export const emptyVehicle: VehicleFormValues = {
  plate: "", make: "", model: "", category: "KOMPAKT", fuel: "DIESEL", status: "AVAILABLE",
  year: "", vin: "", color: "", mileage: "0", huDate: "", dailyRate: "", weeklyRate: "", monthlyRate: "",
  kmIncludedPerDay: "200", extraKmRate: "0,25", deposit: "", notes: "",
};

export function VehicleForm({
  action,
  values,
  submitLabel,
  cancelHref,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values: VehicleFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const v = values;

  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      <h2 className="md:col-span-2 text-base font-semibold mt-1">Fahrzeug</h2>
      <Field label="Kennzeichen" htmlFor="plate">
        <input id="plate" name="plate" defaultValue={v.plate} required className="input font-mono uppercase" placeholder="H-MB 2041" autoFocus />
      </Field>
      <Field label="Status" htmlFor="status">
        <select id="status" name="status" defaultValue={v.status} className="input">
          {Object.entries(VEHICLE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Marke" htmlFor="make">
        <input id="make" name="make" defaultValue={v.make} required className="input" placeholder="VW" />
      </Field>
      <Field label="Modell" htmlFor="model">
        <input id="model" name="model" defaultValue={v.model} required className="input" placeholder="T6.1 Transporter Kasten" />
      </Field>
      <Field label="Klasse" htmlFor="category">
        <select id="category" name="category" defaultValue={v.category} className="input">
          {Object.entries(VEHICLE_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Kraftstoff" htmlFor="fuel">
        <select id="fuel" name="fuel" defaultValue={v.fuel} className="input">
          {Object.entries(FUELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Baujahr" htmlFor="year">
        <input id="year" name="year" type="number" min={1980} max={2100} defaultValue={v.year} className="input" />
      </Field>
      <Field label="Farbe" htmlFor="color">
        <input id="color" name="color" defaultValue={v.color} className="input" />
      </Field>
      <Field label="Fahrgestellnummer (FIN)" htmlFor="vin">
        <input id="vin" name="vin" defaultValue={v.vin} className="input font-mono" maxLength={17} />
      </Field>
      <Field label="Kilometerstand" htmlFor="mileage">
        <input id="mileage" name="mileage" type="number" min={0} defaultValue={v.mileage} required className="input tnum" />
      </Field>
      <Field label="HU fällig" htmlFor="huDate" hint="Hauptuntersuchung, Datum aus der Plakette">
        <input id="huDate" name="huDate" type="date" defaultValue={v.huDate} className="input" />
      </Field>

      <h2 className="md:col-span-2 text-base font-semibold mt-2">Preise</h2>
      <Field label="Tagespreis € (brutto)" htmlFor="dailyRate">
        <input id="dailyRate" name="dailyRate" inputMode="decimal" defaultValue={v.dailyRate} required className="input tnum" placeholder="89" />
      </Field>
      <Field label="Kaution €" htmlFor="deposit">
        <input id="deposit" name="deposit" inputMode="decimal" defaultValue={v.deposit} required className="input tnum" placeholder="500" />
      </Field>
      <Field label="Wochenpreis € (optional)" htmlFor="weeklyRate">
        <input id="weeklyRate" name="weeklyRate" inputMode="decimal" defaultValue={v.weeklyRate} className="input tnum" />
      </Field>
      <Field label="Monatspreis € (optional)" htmlFor="monthlyRate">
        <input id="monthlyRate" name="monthlyRate" inputMode="decimal" defaultValue={v.monthlyRate} className="input tnum" />
      </Field>
      <Field label="Freikilometer pro Tag" htmlFor="kmIncludedPerDay">
        <input id="kmIncludedPerDay" name="kmIncludedPerDay" type="number" min={0} defaultValue={v.kmIncludedPerDay} required className="input tnum" />
      </Field>
      <Field label="Mehrkilometer € je km" htmlFor="extraKmRate">
        <input id="extraKmRate" name="extraKmRate" inputMode="decimal" defaultValue={v.extraKmRate} required className="input tnum" />
      </Field>

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

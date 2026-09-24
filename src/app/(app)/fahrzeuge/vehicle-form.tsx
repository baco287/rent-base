"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { FUELS, LICENSE_CLASSES, VEHICLE_STATUS } from "@/lib/constants";
import { Field, FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import type { FormState } from "./actions";

export type GroupOption = {
  id: string;
  name: string;
  dailyRate: string;
  workWeekRate: string;
  weeklyRate: string;
  monthlyRate: string;
  kmIncludedPerDay: string;
  extraKmRate: string;
  deposit: string;
};

export type VehicleFormValues = {
  plate: string;
  make: string;
  model: string;
  groupId: string;
  fuel: string;
  status: string;
  year: string;
  vin: string;
  color: string;
  mileage: string;
  huDate: string;
  dailyRate: string;
  workWeekRate: string;
  weeklyRate: string;
  monthlyRate: string;
  kmIncludedPerDay: string;
  extraKmRate: string;
  deposit: string;
  notes: string;
  requiredLicenseClass: string;
};

export const emptyVehicle: VehicleFormValues = {
  plate: "", make: "", model: "", groupId: "", fuel: "DIESEL", status: "AVAILABLE",
  year: "", vin: "", color: "", mileage: "0", huDate: "", dailyRate: "", workWeekRate: "", weeklyRate: "", monthlyRate: "",
  kmIncludedPerDay: "200", extraKmRate: "0,25", deposit: "", notes: "", requiredLicenseClass: "",
};

export function VehicleForm({
  action,
  values,
  groups,
  submitLabel,
  cancelHref,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values: VehicleFormValues;
  groups: GroupOption[];
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [groupId, setGroupId] = useState(values.groupId);
  const [prices, setPrices] = useState({
    dailyRate: values.dailyRate,
    workWeekRate: values.workWeekRate,
    weeklyRate: values.weeklyRate,
    monthlyRate: values.monthlyRate,
    kmIncludedPerDay: values.kmIncludedPerDay,
    extraKmRate: values.extraKmRate,
    deposit: values.deposit,
  });
  const v = values;
  const group = groups.find((g) => g.id === groupId);

  function pickGroup(id: string) {
    setGroupId(id);
    const g = groups.find((x) => x.id === id);
    if (g) setPrices({ dailyRate: g.dailyRate, workWeekRate: g.workWeekRate, weeklyRate: g.weeklyRate, monthlyRate: g.monthlyRate, kmIncludedPerDay: g.kmIncludedPerDay, extraKmRate: g.extraKmRate, deposit: g.deposit });
  }
  const set = (k: keyof typeof prices) => (e: React.ChangeEvent<HTMLInputElement>) => setPrices((p) => ({ ...p, [k]: e.target.value }));

  return (
    <form onSubmit={submitWithoutReset(formAction)} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      <h2 className="md:col-span-2 text-base font-semibold mt-1">Fahrzeug</h2>
      <Field label="Fahrzeuggruppe" htmlFor="groupId" hint={groups.length === 0 ? "Noch keine Gruppe vorhanden. Erst unter „Gruppen verwalten“ anlegen." : "Preise werden aus der Gruppe vorgeschlagen"}>
        <select id="groupId" name="groupId" value={groupId} onChange={(e) => pickGroup(e.target.value)} required className="input">
          <option value="">Bitte wählen…</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </Field>
      <Field label="Status" htmlFor="status">
        <select id="status" name="status" defaultValue={v.status} className="input">
          {Object.entries(VEHICLE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Kennzeichen" htmlFor="plate">
        <input id="plate" name="plate" defaultValue={v.plate} required className="input font-mono uppercase" placeholder="H-MB 2041" />
      </Field>
      <Field label="Kraftstoff" htmlFor="fuel">
        <select id="fuel" name="fuel" defaultValue={v.fuel} className="input">
          {Object.entries(FUELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Marke" htmlFor="make">
        <input id="make" name="make" defaultValue={v.make} required className="input" placeholder="VW" />
      </Field>
      <Field label="Modell" htmlFor="model">
        <input id="model" name="model" defaultValue={v.model} required className="input" placeholder="T6.1 Transporter Kasten" />
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
      <Field label="Erforderliche Fahrerlaubnisklasse" htmlFor="requiredLicenseClass" hint="Phase 19.5: leer = aus der Fahrzeuggruppe bzw. Standard (PKW = B)">
        <select id="requiredLicenseClass" name="requiredLicenseClass" defaultValue={v.requiredLicenseClass} className="input">
          <option value="">aus der Gruppe</option>
          {Object.keys(LICENSE_CLASSES).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>

      <h2 className="md:col-span-2 text-base font-semibold mt-2">
        Preise {group && <span className="text-ink-3 font-normal text-sm">· Vorgabe aus Gruppe {group.name}, hier je Fahrzeug anpassbar</span>}
      </h2>
      <Field label="Tagespreis € (brutto)" htmlFor="dailyRate">
        <input id="dailyRate" name="dailyRate" inputMode="decimal" value={prices.dailyRate} onChange={set("dailyRate")} required className="input tnum" placeholder="89" />
      </Field>
      <Field label="Kaution €" htmlFor="deposit">
        <input id="deposit" name="deposit" inputMode="decimal" value={prices.deposit} onChange={set("deposit")} required className="input tnum" placeholder="500" />
      </Field>
      <Field label="Woche € (5 Tage, optional)" htmlFor="workWeekRate">
        <input id="workWeekRate" name="workWeekRate" inputMode="decimal" value={prices.workWeekRate} onChange={set("workWeekRate")} className="input tnum" />
      </Field>
      <Field label="Kalenderwoche € (7 Tage, optional)" htmlFor="weeklyRate">
        <input id="weeklyRate" name="weeklyRate" inputMode="decimal" value={prices.weeklyRate} onChange={set("weeklyRate")} className="input tnum" />
      </Field>
      <Field label="Monatspreis € (optional)" htmlFor="monthlyRate">
        <input id="monthlyRate" name="monthlyRate" inputMode="decimal" value={prices.monthlyRate} onChange={set("monthlyRate")} className="input tnum" />
      </Field>
      <Field label="Freikilometer pro Tag" htmlFor="kmIncludedPerDay">
        <input id="kmIncludedPerDay" name="kmIncludedPerDay" type="number" min={0} value={prices.kmIncludedPerDay} onChange={set("kmIncludedPerDay")} required className="input tnum" />
      </Field>
      <Field label="Mehrkilometer € je km" htmlFor="extraKmRate">
        <input id="extraKmRate" name="extraKmRate" inputMode="decimal" value={prices.extraKmRate} onChange={set("extraKmRate")} required className="input tnum" />
      </Field>

      <Field label="Notizen" htmlFor="notes" full>
        <textarea id="notes" name="notes" defaultValue={v.notes} rows={3} className="input" />
      </Field>

      <FormError error={state?.error} />
      <div className="md:col-span-2 flex items-center gap-2 mt-1">
        <button type="submit" disabled={pending || groups.length === 0} className="btn btn-primary">{pending ? "Wird gespeichert…" : submitLabel}</button>
        <Link href={cancelHref} className="btn">Abbrechen</Link>
      </div>
    </form>
  );
}

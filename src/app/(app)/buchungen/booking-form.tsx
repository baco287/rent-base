"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { Field, FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import type { FormState } from "./actions";
import { CustomerFields, emptyCustomer } from "../kunden/customer-fields";

export type VehicleOption = { id: string; plate: string; label: string; group: string; dailyRate: string; deposit: string; status: string };
export type CustomerOption = { id: string; label: string; blocked: boolean; discountPercent: number };

export type BookingFormValues = {
  vehicleId: string;
  customerId: string;
  startAt: string;
  endAt: string;
  dailyRate: string;
  deposit: string;
  notes: string;
};

function days(start: string, end: string) {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!s || !e || e <= s) return 0;
  return Math.max(1, Math.ceil((e - s) / 86400000));
}

export function BookingForm({
  action,
  values,
  vehicles,
  customers,
  submitLabel,
  cancelHref,
  allowNewCustomer = false,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values: BookingFormValues;
  vehicles: VehicleOption[];
  customers: CustomerOption[];
  submitLabel: string;
  cancelHref: string;
  /** Nur bei neuer Buchung: Kunde kann direkt mit angelegt werden. */
  allowNewCustomer?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [vehicleId, setVehicleId] = useState(values.vehicleId);
  const [customerId, setCustomerId] = useState(values.customerId);
  const [customerMode, setCustomerMode] = useState<"existing" | "new">(allowNewCustomer && customers.length === 0 ? "new" : "existing");
  const [startAt, setStartAt] = useState(values.startAt);
  const [endAt, setEndAt] = useState(values.endAt);
  const [dailyRate, setDailyRate] = useState(values.dailyRate);
  const [deposit, setDeposit] = useState(values.deposit);

  const vehicle = useMemo(() => vehicles.find((v) => v.id === vehicleId), [vehicles, vehicleId]);
  const customer = useMemo(() => customers.find((c) => c.id === customerId), [customers, customerId]);
  const n = days(startAt, endAt);
  const rate = parseFloat(dailyRate.replace(",", ".")) || 0;
  const discount = customerMode === "new" ? 0 : customer?.discountPercent ?? 0;
  const gross = n * rate;
  const total = gross * (1 - discount / 100);
  const eur = (x: number) => x.toLocaleString("de-DE", { style: "currency", currency: "EUR" });

  function pickVehicle(id: string) {
    setVehicleId(id);
    const v = vehicles.find((x) => x.id === id);
    if (v) {
      setDailyRate(v.dailyRate);
      setDeposit(v.deposit);
    }
  }

  return (
    <form onSubmit={submitWithoutReset(formAction)} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      <Field label="Fahrzeug" htmlFor="vehicleId" hint="Preis und Kaution werden aus dem Fahrzeug übernommen und können angepasst werden">
        <select id="vehicleId" name="vehicleId" value={vehicleId} onChange={(e) => pickVehicle(e.target.value)} required className="input">
          <option value="">Bitte wählen…</option>
          {Array.from(new Set(vehicles.map((v) => v.group))).map((g) => (
            <optgroup key={g} label={g}>
              {vehicles.filter((v) => v.group === g).map((v) => (
                <option key={v.id} value={v.id} disabled={v.status === "INACTIVE"}>
                  {v.plate} · {v.label}{v.status === "WORKSHOP" ? " (Werkstatt)" : v.status === "BLOCKED" ? " (gesperrt)" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <Field label="Kunde" htmlFor="customerId">
        {allowNewCustomer && (
          <div className="flex rounded-md border border-line overflow-hidden mb-1.5 text-[13px] font-medium" role="group" aria-label="Kunde">
            <button type="button" onClick={() => setCustomerMode("existing")} className={`flex-1 px-3 py-1.5 ${customerMode === "existing" ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>Bestehender Kunde</button>
            <button type="button" onClick={() => setCustomerMode("new")} className={`flex-1 px-3 py-1.5 ${customerMode === "new" ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>Neuer Kunde</button>
          </div>
        )}
        <input type="hidden" name="customerMode" value={customerMode} />
        {customerMode === "new" ? (
          <p className="text-xs text-ink-3">Die Kundendaten stehen unten im Formular und werden zusammen mit der Buchung gespeichert.</p>
        ) : (
        <select id="customerId" name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required className="input">
          <option value="">Bitte wählen…</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id} disabled={c.blocked}>
              {c.label}{c.blocked ? " (gesperrt)" : c.discountPercent ? ` · ${c.discountPercent} % Rabatt` : ""}
            </option>
          ))}
        </select>
        )}
      </Field>
      <Field label="Abholung" htmlFor="startAt">
        <input id="startAt" name="startAt" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} required className="input tnum" />
      </Field>
      <Field label="Rückgabe" htmlFor="endAt">
        <input id="endAt" name="endAt" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} required className="input tnum" min={startAt || undefined} />
      </Field>
      <Field label="Tagespreis € (brutto)" htmlFor="dailyRate">
        <input id="dailyRate" name="dailyRate" inputMode="decimal" value={dailyRate} onChange={(e) => setDailyRate(e.target.value)} required className="input tnum" />
      </Field>
      <Field label="Kaution €" htmlFor="deposit">
        <input id="deposit" name="deposit" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} required className="input tnum" />
      </Field>
      <Field label="Notizen" htmlFor="notes" full>
        <textarea id="notes" name="notes" defaultValue={values.notes} rows={2} className="input" placeholder="z. B. Abholung am Nebeneingang, Zusatzfahrer folgt" />
      </Field>

      {customerMode === "new" && (
        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 rounded-lg border border-line bg-bg/60 p-4 -mx-1">
          <CustomerFields values={emptyCustomer} prefix="c_" compact />
        </div>
      )}

      <div className="md:col-span-2 rounded-lg bg-panel-2 px-4 py-3 text-sm flex flex-wrap gap-x-6 gap-y-1 tnum">
        <span>Miettage: <b>{n || "–"}</b></span>
        <span>{n || 0} × {eur(rate)} = <b>{eur(gross)}</b></span>
        {discount > 0 && <span>Rabatt {discount} %: <b>−{eur(gross - total)}</b></span>}
        <span>Voraussichtlich: <b>{eur(total)}</b></span>
        <span className="text-ink-3">zzgl. Kaution {eur(parseFloat(deposit.replace(",", ".")) || 0)}</span>
        {vehicle && <span className="text-ink-3">Fahrzeug {vehicle.plate}</span>}
      </div>

      <FormError error={state?.error} />
      <div className="md:col-span-2 flex items-center gap-2 mt-1">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird geprüft…" : submitLabel}</button>
        <Link href={cancelHref} className="btn">Abbrechen</Link>
      </div>
    </form>
  );
}

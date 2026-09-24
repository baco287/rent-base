"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { Field, FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import type { FormState } from "./actions";
import { CustomerFields, emptyCustomer } from "../kunden/customer-fields";
import { calculateRentalPrice, describePrice, toNumber } from "@/lib/pricing";
import { PAYMENT_METHODS, RENTAL_PAYMENT_INTENTS, type RentalPaymentIntent } from "@/lib/constants";
import { fmtCents, toCents } from "@/lib/money";

/** Nur bei neuer Buchung: erste Mietzahlung direkt mit erfassen. */
export type InitialPaymentConfig = { nonce: string; defaultWhen: string };

function centsOf(input: string): number | null {
  try {
    const c = toCents(input.trim());
    return c > 0 ? c : null;
  } catch {
    return null;
  }
}

/**
 * Bereich „Zahlung“ im Formular. Gespeichert wird nur die tatsächliche Zahlungsbewegung; „Offen / Teilweise /
 * Vollständig“ ist die Absicht, der Status der Buchung wird danach immer aus den Zahlungen berechnet.
 * Die Kaution gehört nicht hierher und zählt nicht als Mietzahlung.
 */
function PaymentSection({ totalCents, config }: { totalCents: number; config: InitialPaymentConfig }) {
  const [intent, setIntent] = useState<RentalPaymentIntent>("NONE");
  const [amount, setAmount] = useState("");
  const paid = intent === "FULL" ? totalCents : intent === "PARTIAL" ? centsOf(amount) ?? 0 : 0;
  const open = Math.max(0, totalCents - paid);
  const fullAmount = (totalCents / 100).toFixed(2).replace(".", ",");
  return (
    <fieldset className="md:col-span-2 rounded-lg border border-line p-4 flex flex-col gap-3">
      <legend className="label-xs px-1">Zahlung (Miete)</legend>
      <input type="hidden" name="payNonce" value={config.nonce} />
      <div className="flex rounded-md border border-line overflow-hidden text-[13px] font-medium" role="radiogroup" aria-label="Zahlungsstatus">
        {(Object.keys(RENTAL_PAYMENT_INTENTS) as RentalPaymentIntent[]).map((k) => (
          <label key={k} className={`flex-1 px-3 py-1.5 text-center cursor-pointer ${intent === k ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>
            <input type="radio" name="payIntent" value={k} checked={intent === k} onChange={() => setIntent(k)} className="sr-only" />
            {RENTAL_PAYMENT_INTENTS[k]}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm tnum">
        <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Gesamtpreis</div><div className="font-mono font-semibold">{fmtCents(totalCents)}</div></div>
        <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Bereits bezahlt</div><div className="font-mono font-semibold text-good">{fmtCents(paid)}</div></div>
        <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Noch offen</div><div className={`font-mono font-semibold ${open > 0 ? "text-bad" : ""}`}>{fmtCents(open)}</div></div>
      </div>
      {intent !== "NONE" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="label-xs">Tatsächlich gezahlter Betrag €</span>
            {intent === "FULL" ? (
              <input name="payAmount" value={fullAmount} readOnly className="input tnum bg-panel-2" />
            ) : (
              <input name="payAmount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" required className="input tnum" />
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-xs">Zahlungsart</span>
            <select name="payMethod" defaultValue="CASH" className="input">
              {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1"><span className="label-xs">Zahlungsdatum</span><input name="payPaidAt" type="datetime-local" defaultValue={config.defaultWhen} required className="input tnum" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Referenz (optional)</span><input name="payReference" maxLength={120} placeholder="z. B. Belegnummer, Verwendungszweck" className="input" /></label>
          <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="payNote" maxLength={500} className="input" /></label>
        </div>
      )}
      <p className="text-xs text-ink-3">Jede Zahlung wird als eigene Bewegung gespeichert; weitere Teilzahlungen später auf der Buchung unter „Mietzahlung“. Karten- und Überweisungszahlungen werden außerhalb von Rent-Base ausgeführt und hier nur dokumentiert. Die Kaution ist keine Mietzahlung und wird getrennt erfasst.</p>
    </fieldset>
  );
}

export type TierRates = { workWeekRate: string | null; weeklyRate: string | null; monthlyRate: string | null };
export type VehicleOption = { id: string; plate: string; label: string; group: string; dailyRate: string; deposit: string; status: string } & TierRates;
export type CustomerOption = { id: string; label: string; blocked: boolean; discountPercent: number };

export type BookingFormValues = {
  vehicleId: string;
  customerId: string;
  startAt: string;
  endAt: string;
  dailyRate: string;
  deposit: string;
  notes: string;
  /** Bei bestehender Buchung: die dort eingefrorenen Stufen, solange das Fahrzeug gleich bleibt. */
  tiers?: TierRates;
};

export function BookingForm({
  action,
  values,
  vehicles,
  customers,
  submitLabel,
  cancelHref,
  allowNewCustomer = false,
  initialPayment,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values: BookingFormValues;
  vehicles: VehicleOption[];
  customers: CustomerOption[];
  submitLabel: string;
  cancelHref: string;
  /** Nur bei neuer Buchung: Bereich „Zahlung“ im Formular. Bestehende Buchungen erfassen Zahlungen unter „Mietzahlung“. */
  initialPayment?: InitialPaymentConfig;
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
  const discount = customerMode === "new" ? 0 : customer?.discountPercent ?? 0;
  // Stufen: bei unverändertem Fahrzeug die der Buchung, sonst die des gewählten Fahrzeugs
  const tiers: TierRates | undefined = values.tiers && vehicleId === values.vehicleId ? values.tiers : vehicle;
  const price = calculateRentalPrice({
    start: new Date(startAt),
    end: new Date(endAt),
    rates: { dailyRate: toNumber(dailyRate) ?? 0, workWeekRate: toNumber(tiers?.workWeekRate), weeklyRate: toNumber(tiers?.weeklyRate), monthlyRate: toNumber(tiers?.monthlyRate) },
    discountPercent: discount,
  });
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
        <span>Miettage: <b>{price.days || "–"}</b></span>
        <span>{describePrice(price)} = <b>{eur(price.subtotal)}</b></span>
        {discount > 0 && <span>Rabatt {discount} %: <b>−{eur(price.discountAmount)}</b></span>}
        <span>Voraussichtlich: <b>{eur(price.total)}</b></span>
        <span className="text-ink-3">zzgl. Kaution {eur(parseFloat(deposit.replace(",", ".")) || 0)}</span>
        {vehicle && <span className="text-ink-3">Fahrzeug {vehicle.plate}</span>}
      </div>

      {initialPayment && <PaymentSection totalCents={Math.round(price.total * 100)} config={initialPayment} />}

      <FormError error={state?.error} />
      <div className="md:col-span-2 flex items-center gap-2 mt-1">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird geprüft…" : submitLabel}</button>
        <Link href={cancelHref} className="btn">Abbrechen</Link>
      </div>
    </form>
  );
}

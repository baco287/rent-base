"use client";

import { useActionState, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Field, FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { quoteTariffsAction, type FormState } from "./actions";
import { TariffPicker, type TariffTotals } from "./tariff-picker";
import type { TariffChoices } from "@/lib/tariffs";
import { CustomerFields, emptyCustomer } from "../kunden/customer-fields";
import { CustomerPicker } from "./customer-picker";
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
 * Bereich „Miete & Kaution“ im Formular (Befehl 20.8/20.9): Miete und Kaution nebeneinander, finanziell getrennt.
 * Gespeichert wird nur die tatsächliche Mietzahlung; „Offen / Teilweise / Vollständig“ ist die Absicht, der Status der
 * Buchung wird danach immer aus den Zahlungen berechnet. Kaution: entweder „Noch nicht erhalten“ (Eingang später auf der
 * Buchungsseite) oder „Kaution jetzt erhalten“ – dann wird der Eingang zusammen mit der Anlage gesendet und serverseitig
 * erst nach dem Anlegen der Buchung über die bestehende Kautionserfassung dokumentiert. Die Kaution ist nie eine Mietzahlung.
 */
function PaymentSection({ totalCents, depositCents, config }: { totalCents: number; depositCents: number; config: InitialPaymentConfig }) {
  const [intent, setIntent] = useState<RentalPaymentIntent>("NONE");
  const [amount, setAmount] = useState("");
  const [depositNow, setDepositNow] = useState(false);
  const [depositAmount, setDepositAmount] = useState<string | null>(null);
  const depositDefault = (depositCents / 100).toFixed(2).replace(".", ",");
  const depositEntered = depositAmount ?? depositDefault;
  const depositEnteredCents = centsOf(depositEntered) ?? 0;
  const paid = intent === "FULL" ? totalCents : intent === "PARTIAL" ? centsOf(amount) ?? 0 : 0;
  const open = Math.max(0, totalCents - paid);
  const fullAmount = (totalCents / 100).toFixed(2).replace(".", ",");
  const status = intent === "FULL" || (intent === "PARTIAL" && paid >= totalCents && totalCents > 0) ? "Vollständig bezahlt" : intent === "PARTIAL" && paid > 0 ? "Teilweise bezahlt" : "Offen";
  return (
    <fieldset className="md:col-span-2 rounded-lg border border-line p-4 flex flex-col gap-3">
      <legend className="label-xs px-1">Miete & Kaution</legend>
      <input type="hidden" name="payNonce" value={config.nonce} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="flex flex-col gap-2.5" aria-label="Miete">
          <div className="flex items-center gap-2"><span className="font-semibold text-sm">Miete</span><span className={`chip ${status === "Vollständig bezahlt" ? "bg-good-soft text-good" : status === "Teilweise bezahlt" ? "bg-amber-soft text-amber" : "bg-panel-2 text-ink-2"}`}>{status}</span></div>
          <div className="grid grid-cols-3 gap-2 text-sm tnum">
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Gesamtmietpreis</div><div className="font-mono font-semibold">{fmtCents(totalCents)}</div></div>
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Bereits bezahlt</div><div className="font-mono font-semibold text-good">{fmtCents(paid)}</div></div>
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Noch offen</div><div className={`font-mono font-semibold ${open > 0 ? "text-bad" : ""}`}>{fmtCents(open)}</div></div>
          </div>
          <div className="flex rounded-md border border-line overflow-hidden text-[13px] font-medium" role="radiogroup" aria-label="Zahlungsstatus">
            {(Object.keys(RENTAL_PAYMENT_INTENTS) as RentalPaymentIntent[]).map((k) => (
              <label key={k} className={`flex-1 px-3 py-1.5 text-center cursor-pointer ${intent === k ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>
                <input type="radio" name="payIntent" value={k} checked={intent === k} onChange={() => setIntent(k)} className="sr-only" />
                {RENTAL_PAYMENT_INTENTS[k]}
              </label>
            ))}
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
              <label className="flex flex-col gap-1"><span className="label-xs">Referenz (optional)</span><input name="payReference" maxLength={120} placeholder="z. B. Belegnummer" className="input" /></label>
              <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="payNote" maxLength={500} className="input" /></label>
            </div>
          )}
          <p className="text-xs text-ink-3">Nur dokumentiert, nicht eingezogen. Weitere Teilzahlungen später auf der Buchung unter „Mietzahlung“.</p>
        </section>
        <section className="flex flex-col gap-2.5 md:border-l md:border-line-soft md:pl-4" aria-label="Kaution">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">Kaution</span>
            {depositNow && depositCents > 0 ? <span className="chip bg-good-soft text-good">{depositEnteredCents >= depositCents ? "Wird als erhalten dokumentiert" : "Wird als teilweise erhalten dokumentiert"}</span> : <span className="chip bg-amber-soft text-amber">Noch nicht erhalten</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm tnum">
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Vereinbarte Kaution</div><div className="font-mono font-semibold">{fmtCents(depositCents)}</div></div>
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Erhalten</div><div className="font-mono font-semibold">{fmtCents(depositNow ? Math.min(depositEnteredCents, depositCents) : 0)}</div></div>
          </div>
          <input type="hidden" name="depNonce" value={`${config.nonce}-dep`} />
          <div className="flex rounded-md border border-line overflow-hidden text-[13px] font-medium" role="radiogroup" aria-label="Kautionsstatus">
            {([["NONE", "Noch nicht erhalten"], ["RECEIVED", "Kaution jetzt erhalten"]] as const).map(([k, label]) => (
              <label key={k} className={`flex-1 px-3 py-1.5 text-center cursor-pointer ${(depositNow ? "RECEIVED" : "NONE") === k ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"} ${k === "RECEIVED" && depositCents <= 0 ? "opacity-50" : ""}`}>
                <input type="radio" name="depIntent" value={k} checked={(depositNow ? "RECEIVED" : "NONE") === k} onChange={() => setDepositNow(k === "RECEIVED")} disabled={k === "RECEIVED" && depositCents <= 0} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
          {depositNow && depositCents > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1"><span className="label-xs">Erhaltener Betrag €</span><input name="depAmount" inputMode="decimal" value={depositEntered} onChange={(e) => setDepositAmount(e.target.value)} required className="input tnum" /></label>
              <label className="flex flex-col gap-1"><span className="label-xs">Zahlungsart</span><select name="depMethod" defaultValue="CASH" className="input">{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="flex flex-col gap-1"><span className="label-xs">Datum und Uhrzeit</span><input name="depOccurredAt" type="datetime-local" defaultValue={config.defaultWhen} required className="input tnum" /></label>
              <label className="flex flex-col gap-1"><span className="label-xs">Referenz (optional)</span><input name="depReference" maxLength={120} placeholder="z. B. Belegnummer" className="input" /></label>
              <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="depNote" maxLength={500} className="input" /></label>
              {depositEnteredCents > depositCents && <p role="alert" className="sm:col-span-2 text-xs text-bad bg-bad-soft rounded-md px-3 py-2">Mehr als die vereinbarte Kaution kann nicht als erhalten dokumentiert werden.</p>}
            </div>
          )}
          <p className="text-xs text-ink-3">{depositNow ? "Der Eingang wird mit der Buchung dokumentiert – nur Dokumentation, keine Abbuchung." : "Der Eingang kann auch später auf der Buchungsseite unter „Kaution“ dokumentiert werden."} Die Kaution ist eine Sicherheitsleistung, keine Mietzahlung, und verringert den offenen Mietpreis nicht.</p>
        </section>
      </div>
    </fieldset>
  );
}

export type TierRates = { workWeekRate: string | null; weeklyRate: string | null; monthlyRate: string | null };
export type VehicleOption = { id: string; plate: string; label: string; group: string; dailyRate: string; deposit: string; kmIncludedPerDay: string; extraKmRate: string; status: string } & TierRates;
/** Treffer der Kundensuche bzw. vorbelegter Kunde: eindeutig durch Nummer + Name/Firma + Kontaktdaten. */
export type CustomerOption = { id: string; label: string; number: string | null; context: string; blocked: boolean; discountPercent: number };

export type BookingFormValues = {
  vehicleId: string;
  customerId: string;
  startAt: string;
  endAt: string;
  notes: string;
  /** Befehl 29: bestehende Buchung – ihre ID (eingefrorener Tarif) und bisherige Abweichungen (Preis, Kilometer, Kaution) */
  bookingId?: string;
  choices?: TariffChoices;
  /** Buchung ohne Tarif (Altbestand): bisherige Preisvereinbarung */
  legacy?: { totalCents: number; text: string; depositCents: number } | null;
};

export function BookingForm({
  action,
  values,
  vehicles,
  initialCustomer,
  submitLabel,
  cancelHref,
  allowNewCustomer = false,
  initialPayment,
  periodLocked = false,
  periodChangeable = true,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values: BookingFormValues;
  vehicles: VehicleOption[];
  /** Vorbelegter Kunde (bestehende Buchung oder ?kunde=…); die Auswahl selbst läuft über die serverseitige Suche. */
  initialCustomer: CustomerOption | null;
  submitLabel: string;
  cancelHref: string;
  /** Nur bei neuer Buchung: Bereich „Zahlung“ im Formular. Bestehende Buchungen erfassen Zahlungen unter „Mietzahlung“. */
  initialPayment?: InitialPaymentConfig;
  /** Nur bei neuer Buchung: Kunde kann direkt mit angelegt werden. */
  allowNewCustomer?: boolean;
  /** Befehl 28: bestehende Buchung – Zeitraum nur über „Zeitraum ändern“ (mit Grund und Audit), hier nur angezeigt */
  periodLocked?: boolean;
  /** Befehl 28: false, wenn der Dialog „Zeitraum ändern“ für diese Rolle bzw. diesen Stand nicht angeboten wird */
  periodChangeable?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [vehicleId, setVehicleId] = useState(values.vehicleId);
  const [customer, setCustomer] = useState<CustomerOption | null>(initialCustomer);
  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");
  const [startAt, setStartAt] = useState(values.startAt);
  const [endAt, setEndAt] = useState(values.endAt);
  // Befehl 29: Mietpreis und Kaution kommen aus dem gewählten Miettarif (Abweichungen mit Grund in der Tarifauswahl)
  const [totals, setTotals] = useState<TariffTotals>({ totalCents: 0, depositCents: 0, ready: false });
  const onTotals = useCallback((t: TariffTotals) => setTotals((p) => (p.totalCents === t.totalCents && p.depositCents === t.depositCents && p.ready === t.ready ? p : t)), []);

  const vehicle = useMemo(() => vehicles.find((v) => v.id === vehicleId), [vehicles, vehicleId]);
  const eur = (c: number) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

  function pickVehicle(id: string) {
    setVehicleId(id);
  }

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      <Field label="Fahrzeug" htmlFor="vehicleId" hint="Preis, Kilometer und Kaution kommen aus dem Miettarif der Fahrzeuggruppe">
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
          <CustomerPicker value={customer} onChange={setCustomer} />
        )}
      </Field>
      <Field label="Abholung" htmlFor="startAt">
        <input id="startAt" name="startAt" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} required readOnly={periodLocked} aria-describedby={periodLocked ? "period-locked-hint" : undefined} className={`input tnum ${periodLocked ? "bg-panel-2 text-ink-2" : ""}`} />
      </Field>
      <Field label="Rückgabe" htmlFor="endAt">
        <input id="endAt" name="endAt" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} required readOnly={periodLocked} aria-describedby={periodLocked ? "period-locked-hint" : undefined} className={`input tnum ${periodLocked ? "bg-panel-2 text-ink-2" : ""}`} min={startAt || undefined} />
      </Field>
      {periodLocked && <p id="period-locked-hint" className="text-xs text-ink-3 sm:col-span-2 -mt-1">{periodChangeable ? "Der Zeitraum wird über „Zeitraum ändern“ geändert – mit Grund, Preisvorschlag und Verfügbarkeitsprüfung." : "Der Zeitraum kann hier nicht geändert werden."}</p>}
      <TariffPicker
        quote={quoteTariffsAction}
        vehicleId={vehicleId}
        startAt={startAt}
        endAt={endAt}
        customerId={customerMode === "new" ? null : customer?.id ?? null}
        bookingId={values.bookingId}
        bookingVehicleId={values.bookingId ? values.vehicleId : undefined}
        legacy={values.legacy ?? null}
        initial={values.choices}
        onTotals={onTotals}
      />
      <Field label="Notizen" htmlFor="notes" full>
        <textarea id="notes" name="notes" defaultValue={values.notes} rows={2} className="input" placeholder="z. B. Abholung am Nebeneingang, Zusatzfahrer folgt" />
      </Field>

      {customerMode === "new" && (
        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 rounded-lg border border-line bg-bg/60 p-4 -mx-1">
          <CustomerFields values={emptyCustomer} prefix="c_" compact />
        </div>
      )}

      <div className="md:col-span-2 rounded-lg bg-panel-2 px-4 py-3 text-sm flex flex-wrap gap-x-6 gap-y-1 tnum">
        <span>Mietpreis: <b>{totals.ready ? eur(totals.totalCents) : "–"}</b></span>
        <span className="text-ink-3">zzgl. Kaution {totals.ready ? eur(totals.depositCents) : "–"}</span>
        {vehicle && <span className="text-ink-3">Fahrzeug {vehicle.plate}</span>}
      </div>

      {initialPayment && <PaymentSection totalCents={totals.totalCents} depositCents={totals.depositCents} config={initialPayment} />}

      <FormError error={state?.error} />
      <div className="md:col-span-2 flex items-center gap-2 mt-1">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird geprüft…" : submitLabel}</button>
        <Link href={cancelHref} className="btn">Abbrechen</Link>
      </div>
    </form>
  );
}

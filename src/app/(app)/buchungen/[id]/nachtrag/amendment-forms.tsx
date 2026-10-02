"use client";

// Befehl 25: Formulare der Nachtragsseite. Kein Fachwissen: Vorschläge, Prüfungen und der wirksame Stand kommen vom Server.

import { useActionState, useState } from "react";
import { Field, FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { AMENDMENT_HELP } from "@/lib/constants";
import type { AmendmentState } from "./actions";

type Action = (prev: AmendmentState, fd: FormData) => Promise<AmendmentState>;

function Msg({ state }: { state: AmendmentState }) {
  if (state?.error) return <FormError error={state.error} />;
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  return null;
}

export type ChangesValues = {
  newEndAt: string; // datetime-local oder ""
  priceDeltaCents: number | null;
  priceProposalCents: number | null;
  priceReason: string;
  newKmIncludedPerDay: number | null;
  newExtraKmRate: string; // "0,35" oder ""
  newDepositCents: number | null;
  newReturnLocation: string | null;
  agreementText: string | null;
};
export type CurrentValues = { endAt: string; totalEur: string; kmIncludedPerDay: number; extraKmRateEur: string; depositEur: string; returnLocation: string };

const eur = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Toggle({ id, label, checked, onChange, children }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className={`rounded-md border ${checked ? "border-brand/50 bg-panel" : "border-line-soft bg-panel-2/40"} p-3 flex flex-col gap-3`}>
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <input id={id} name={id} type="checkbox" value="1" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5" />
        <span className="font-medium">{label}</span>
      </label>
      {checked && <div className="flex flex-col gap-3 pl-8">{children}</div>}
    </div>
  );
}

/** Änderungsarten anhaken und ausfüllen. Links „bisher“, rechts „neu“. Speichern macht Unterschriften ungültig. */
export function ChangesForm({ action, values: v, current: c, locked }: { action: Action; values: ChangesValues; current: CurrentValues; locked: boolean }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [period, setPeriod] = useState(!!v.newEndAt);
  const [price, setPrice] = useState(v.priceDeltaCents != null);
  const [km, setKm] = useState(v.newKmIncludedPerDay != null || !!v.newExtraKmRate);
  const [deposit, setDeposit] = useState(v.newDepositCents != null);
  const [location, setLocation] = useState(v.newReturnLocation != null);
  const [agreement, setAgreement] = useState(v.agreementText != null);
  const delta = v.priceDeltaCents ?? v.priceProposalCents ?? null;
  const [sign, setSign] = useState<"+" | "-">(delta != null && delta < 0 ? "-" : "+");
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
      <fieldset disabled={pending || locked} className="flex flex-col gap-3">
        <Toggle id="changePeriod" label="Mietdauer / geplante Rückgabe ändern" checked={period} onChange={setPeriod}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Bisher"><div className="input bg-panel-2 font-mono tnum">{c.endAt}</div></Field>
            <Field label="Neue geplante Rückgabe" htmlFor="newEndAt"><input id="newEndAt" name="newEndAt" type="datetime-local" defaultValue={v.newEndAt} className="input tnum" required={period} /></Field>
          </div>
          <p className="text-xs text-ink-3">Die Verfügbarkeit des Fahrzeugs wird beim Speichern und erneut beim Unterschreiben geprüft. {AMENDMENT_HELP.SHORTEN}</p>
          {v.priceProposalCents != null && (
            <p className="text-sm rounded-md bg-info-soft text-info px-3 py-2">Vorschlag der Preislogik dieses Vertrags für den neuen Zeitraum: <b className="font-mono tnum">{v.priceProposalCents >= 0 ? "+" : "−"}{eur(Math.abs(v.priceProposalCents))} €</b>. {price ? "" : "Zum Übernehmen „Mietpreis ändern“ anhaken."}</p>
          )}
        </Toggle>

        <Toggle id="changePrice" label="Mietpreis ändern" checked={price} onChange={setPrice}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Bisher (Gesamtpreis)"><div className="input bg-panel-2 font-mono tnum">{c.totalEur} €</div></Field>
            <Field label="Änderung" htmlFor="priceDelta">
              <div className="flex gap-2">
                <select name="priceSign" value={sign} onChange={(e) => setSign(e.target.value as "+" | "-")} className="input !w-20" aria-label="Vorzeichen">
                  <option value="+">+</option>
                  <option value="-">−</option>
                </select>
                <input id="priceDelta" name="priceDelta" inputMode="decimal" defaultValue={delta != null ? eur(Math.abs(delta)) : ""} placeholder="0,00" className="input tnum flex-1" required={price} />
              </div>
            </Field>
            <Field label="Begründung" htmlFor="priceReason" hint={v.priceProposalCents != null ? "Pflicht, wenn vom Vorschlag abweichend" : "Pflicht bei manueller Preisänderung"}><input id="priceReason" name="priceReason" defaultValue={v.priceReason} maxLength={300} className="input" /></Field>
          </div>
        </Toggle>

        <Toggle id="changeKm" label="Kilometervereinbarung ändern" checked={km} onChange={setKm}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Bisher"><div className="input bg-panel-2 font-mono tnum">{c.kmIncludedPerDay.toLocaleString("de-DE")} km/Tag · {c.extraKmRateEur} €/km</div></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Freikilometer je Tag" htmlFor="newKmIncludedPerDay"><input id="newKmIncludedPerDay" name="newKmIncludedPerDay" inputMode="numeric" defaultValue={v.newKmIncludedPerDay ?? ""} className="input tnum" /></Field>
              <Field label="€ je Mehrkilometer" htmlFor="newExtraKmRate"><input id="newExtraKmRate" name="newExtraKmRate" inputMode="decimal" defaultValue={v.newExtraKmRate} className="input tnum" /></Field>
            </div>
          </div>
          <p className="text-xs text-ink-3">{AMENDMENT_HELP.KM}</p>
        </Toggle>

        <Toggle id="changeDeposit" label="Vereinbarte Kaution ändern" checked={deposit} onChange={setDeposit}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Bisher vereinbart"><div className="input bg-panel-2 font-mono tnum">{c.depositEur} €</div></Field>
            <Field label="Neu vereinbart €" htmlFor="newDeposit"><input id="newDeposit" name="newDeposit" inputMode="decimal" defaultValue={v.newDepositCents != null ? eur(v.newDepositCents) : ""} className="input tnum" required={deposit} /></Field>
          </div>
          <p className="text-xs text-ink-3">{AMENDMENT_HELP.DEPOSIT}</p>
        </Toggle>

        <Toggle id="changeReturnLocation" label="Rückgabeort ändern" checked={location} onChange={setLocation}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Bisher"><div className="input bg-panel-2">{c.returnLocation}</div></Field>
            <Field label="Neuer Rückgabeort" htmlFor="newReturnLocation"><input id="newReturnLocation" name="newReturnLocation" defaultValue={v.newReturnLocation ?? ""} maxLength={200} className="input" required={location} /></Field>
          </div>
        </Toggle>

        <Toggle id="changeAgreement" label="Sonstige Vereinbarung (Freitext)" checked={agreement} onChange={setAgreement}>
          <Field label="Vereinbarungstext" htmlFor="agreementText" hint="Reiner Text, höchstens 2000 Zeichen. Ersetzt keine Fahrerprüfung und keine der obigen Änderungsarten."><textarea id="agreementText" name="agreementText" defaultValue={v.agreementText ?? ""} maxLength={2000} rows={4} className="input" required={agreement} /></Field>
        </Toggle>
      </fieldset>
      <Msg state={state} />
      {!locked && <div><button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird gespeichert…" : "Änderungen speichern"}</button></div>}
    </form>
  );
}

export function MessageForm({ action, children, submitLabel, pendingLabel = "Bitte warten…", confirm, className = "btn" }: { action: Action; children?: React.ReactNode; submitLabel: string; pendingLabel?: string; confirm?: string; className?: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }} className="flex flex-col gap-2">
      {children}
      <div><button type="submit" disabled={pending} className={className}>{pending ? pendingLabel : submitLabel}</button></div>
      <Msg state={state} />
    </form>
  );
}

export function ConfirmForm({ action, label, question, className = "btn" }: { action: (fd: FormData) => Promise<void>; label: string; question: string; className?: string }) {
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm(question)) e.preventDefault(); }}>
      <button type="submit" className={className}>{label}</button>
    </form>
  );
}

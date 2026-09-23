"use client";

import { useActionState, useState, type ReactNode } from "react";
import Link from "next/link";
import { ADDITIONAL_DRIVER_FEE_TYPES, COUNTRIES, FUEL_POLICIES, KM_POLICIES, PETS_POLICIES, TERMS_ACKNOWLEDGEMENT_TEXT } from "@/lib/constants";
import { Field, FormError } from "@/components/ui";
import { SignaturePad } from "@/components/signature-pad";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { WIZARD_STEPS } from "./steps";

export type StepState = { error?: string } | undefined;
type StepAction = (prev: StepState, fd: FormData) => Promise<StepState>;


/** Fortschrittsanzeige. Erledigte Schritte sind anklickbar, so kann man jederzeit zurückspringen. */
export function WizardProgress({ bookingId, current, reached, steps = WIZARD_STEPS, basePath }: { bookingId: string; current: number; reached: number; steps?: readonly string[]; basePath?: string }) {
  const base = basePath ?? `/buchungen/${bookingId}/vertrag`;
  return (
    <nav aria-label="Fortschritt" className="card p-2.5 md:p-3">
      <ol className="flex gap-1.5 overflow-x-auto">
        {steps.map((label, i) => {
          const n = i + 1;
          const state = n === current ? "current" : n <= reached ? "done" : "todo";
          const cls =
            state === "current" ? "bg-brand text-brand-ink border-brand" : state === "done" ? "bg-good-soft text-good border-transparent hover:underline" : "bg-panel-2 text-ink-3 border-transparent";
          const inner = (
            <>
              <span className="font-mono tnum text-[11px] opacity-80">{n}</span>
              <span className="whitespace-nowrap">{label}</span>
            </>
          );
          return (
            <li key={label} className="shrink-0">
              {state === "todo" ? (
                <span className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12.5px] font-medium ${cls}`}>{inner}</span>
              ) : (
                <Link href={`${base}?schritt=${n}`} aria-current={state === "current" ? "step" : undefined} className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12.5px] font-medium ${cls}`}>
                  {inner}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Rahmen für einen Schritt: speichert beim Klick auf "Zurück" und "Speichern & weiter",
 * behält Eingaben bei Fehlermeldungen und sperrt die Knöpfe während des Speicherns.
 */
export function StepForm({ action, children, step, nextLabel = "Speichern & weiter", hideNext = false }: { action: StepAction; children: ReactNode; step: number; nextLabel?: string; hideNext?: boolean }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-4">
      {children}
      <FormError error={state?.error} />
      <div className="sticky bottom-0 -mx-4 md:-mx-5 -mb-4 md:-mb-5 px-4 md:px-5 py-3 bg-panel/95 backdrop-blur border-t border-line-soft flex items-center gap-2 rounded-b-lg">
        {step > 1 && (
          <button type="submit" name="nav" value="back" formNoValidate disabled={pending} className="btn !py-2.5">
            Zurück
          </button>
        )}
        <span className="flex-1" />
        {!hideNext && (
          <button type="submit" name="nav" value="next" disabled={pending} className="btn btn-primary !py-2.5 !px-5">
            {pending ? "Wird gespeichert…" : nextLabel}
          </button>
        )}
      </div>
    </form>
  );
}

/** Kleines Formular mit eigener Fehlermeldung, z. B. "Zusatzfahrer hinzufügen". */
export function InlineForm({ action, children, submitLabel, pendingLabel = "Wird gespeichert…", className = "" }: { action: StepAction; children: ReactNode; submitLabel: string; pendingLabel?: string; className?: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-3 ${className}`}>
      {children}
      <FormError error={state?.error} />
      <div>
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? pendingLabel : submitLabel}</button>
      </div>
    </form>
  );
}

/** Auswahl "Mieter fährt selbst" oder "Abweichender Fahrer". Die Fahrerfelder sind nur im zweiten Fall aktiv. */
export function DriverModeSection({ initial, renterSummary, children }: { initial: "RENTER" | "OTHER"; renterSummary: ReactNode; children: ReactNode }) {
  const [mode, setMode] = useState(initial);
  const option = (value: "RENTER" | "OTHER", title: string, text: string) => (
    <label className={`flex-1 min-w-[240px] cursor-pointer rounded-lg border-2 p-3.5 flex gap-3 items-start ${mode === value ? "border-brand bg-brand-soft" : "border-line bg-panel"}`}>
      <input type="radio" name="driverMode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1 size-4" />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-xs text-ink-2">{text}</span>
      </span>
    </label>
  );
  return (
    <>
      <div className="flex flex-wrap gap-3">
        {option("RENTER", "Mieter fährt selbst", "Die Führerscheindaten des Mieters werden in den Vertrag übernommen.")}
        {option("OTHER", "Abweichender Fahrer", "Eine andere Person fährt. Ihre Daten werden eigens am Vertrag gespeichert.")}
      </div>
      {mode === "RENTER" ? renterSummary : null}
      <fieldset disabled={mode !== "OTHER"} className={mode === "OTHER" ? "contents" : "hidden"}>
        {children}
      </fieldset>
    </>
  );
}

/** Unterschrift erfassen. Der Hash des angezeigten Vertrags geht mit, der Server vergleicht ihn mit dem aktuellen Stand. */
export function SignatureForm({ action, role, defaultName, seenHash }: { action: StepAction; role: "RENTER" | "EMPLOYEE"; defaultName: string; seenHash: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [hasInk, setHasInk] = useState(false);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
      <input type="hidden" name="role" value={role} />
      <input type="hidden" name="seenHash" value={seenHash} />
      <div className="flex flex-col gap-1">
        <label htmlFor={`signer-${role}`} className="label-xs">Name in Druckbuchstaben</label>
        <input id={`signer-${role}`} name="signerName" defaultValue={defaultName} required className="input" autoComplete="off" />
      </div>
      <SignaturePad name="imageDataUrl" label={role === "RENTER" ? "Unterschrift Mieter" : "Unterschrift Vermieter"} onChange={setHasInk} />
      <FormError error={state?.error} />
      <div>
        <button type="submit" disabled={pending || !hasInk} className="btn btn-primary !py-2.5">{pending ? "Wird gespeichert…" : "Unterschrift übernehmen"}</button>
      </div>
    </form>
  );
}

/** Ein Knopf mit eigener Fehlermeldung, z. B. „Aktuelle Standardwerte übernehmen“ oder „Version 1.3 übernehmen“. */
export function ActionButton({ action, label, pendingLabel = "Bitte warten…", className = "btn" }: { action: StepAction; label: string; pendingLabel?: string; className?: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="inline-flex flex-col gap-1">
      <button type="submit" disabled={pending} className={className}>{pending ? pendingLabel : label}</button>
      <FormError error={state?.error} />
    </form>
  );
}

export type RuleFieldValues = {
  kmPolicy: string; kmPolicyNote: string; fuelPolicy: string; fuelMinimumEighths: string; batteryMinimumPercent: string;
  abroadAllowed: boolean; abroadCountries: string[]; allowedCountries: string[]; abroadPossible: boolean;
  smokingAllowed: boolean; petsPolicy: string; additionalDriversAllowed: boolean; additionalDriverFeeType: string; additionalDriverFee: string;
  driveClass: "COMBUSTION" | "ELECTRIC" | "PHEV";
};
/** Geschäftsregeln im Schritt Konditionen: jedes Feld zeigt seine Herkunft (Text vom Server); abhängige Felder erscheinen nur bei Bedarf. */
export function RuleFields({ v, sources }: { v: RuleFieldValues; sources: Record<string, string> }) {
  const source = (key: string): ReactNode => (sources[key] ? <span className="text-[11px] text-ink-3">Quelle: {sources[key]}</span> : null);
  const [kmPolicy, setKmPolicy] = useState(v.kmPolicy);
  const [fuelPolicy, setFuelPolicy] = useState(v.fuelPolicy);
  const [abroad, setAbroad] = useState(v.abroadAllowed);
  const [feeType, setFeeType] = useState(v.additionalDriverFeeType);
  return (
    <>
      <input type="hidden" name="rulesPresent" value="1" />
      <Field label="Kilometerregel" htmlFor="kmPolicy" hint={undefined}>
        <select id="kmPolicy" name="kmPolicy" value={kmPolicy} onChange={(e) => setKmPolicy(e.target.value)} className="input">{Object.entries(KM_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {source("kmPolicy")}
      </Field>
      {kmPolicy === "INDIVIDUAL" && <Field label="Beschreibung der individuellen Kilometerregel" htmlFor="kmPolicyNote"><input id="kmPolicyNote" name="kmPolicyNote" defaultValue={v.kmPolicyNote} className="input" maxLength={300} /></Field>}
      <Field label={v.driveClass === "ELECTRIC" ? "Laderegel" : v.driveClass === "PHEV" ? "Tank- und Laderegel" : "Tankregelung"} htmlFor="fuelPolicy">
        <select id="fuelPolicy" name="fuelPolicy" value={fuelPolicy} onChange={(e) => setFuelPolicy(e.target.value)} className="input">
          {Object.entries(FUEL_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {source("fuelRule")}
      </Field>
      {fuelPolicy === "MINIMUM_LEVEL" && v.driveClass !== "ELECTRIC" && <Field label="Mindestfüllstand Tank (Achtel, 0–8)" htmlFor="fuelMinimumEighths"><input id="fuelMinimumEighths" name="fuelMinimumEighths" type="number" min={0} max={8} defaultValue={v.fuelMinimumEighths} className="input tnum" /></Field>}
      {fuelPolicy === "MINIMUM_LEVEL" && v.driveClass !== "COMBUSTION" && <Field label="Mindestladestand Batterie (%)" htmlFor="batteryMinimumPercent"><input id="batteryMinimumPercent" name="batteryMinimumPercent" type="number" min={0} max={100} defaultValue={v.batteryMinimumPercent} className="input tnum" /></Field>}
      <Field label="Tiere im Fahrzeug" htmlFor="petsPolicy">
        <select id="petsPolicy" name="petsPolicy" defaultValue={v.petsPolicy} className="input">{Object.entries(PETS_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {source("petsPolicy")}
      </Field>
      <div className="flex flex-col gap-1">
        <span className="label-xs">Rauchen im Fahrzeug</span>
        <label className="flex items-center gap-2 text-sm py-2"><input type="checkbox" name="smokingAllowed" value="1" defaultChecked={v.smokingAllowed} /> Rauchen gestattet</label>
        {source("smokingAllowed")}
      </div>
      <div className="md:col-span-2 flex flex-col gap-1.5 rounded-lg bg-panel-2 p-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="abroadAllowed" value="1" checked={abroad} onChange={(e) => setAbroad(e.target.checked)} disabled={!v.abroadPossible} /> Auslandsfahrten gestattet {source("abroadAllowed")}</label>
        {!v.abroadPossible && <span className="text-xs text-ink-3">Nach den Geschäftsregeln des Vermieters sind Auslandsfahrten nicht vorgesehen. Eine Freigabe braucht zuerst die Einstellung (Inhaber).</span>}
        {abroad && v.abroadPossible && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span className="basis-full text-xs text-ink-3">Konkret genehmigte Länder (nur aus der Freigabeliste des Vermieters):</span>
            {v.allowedCountries.map((c) => <label key={c} className="flex items-center gap-1.5"><input type="checkbox" name="abroadCountries" value={c} defaultChecked={v.abroadCountries.includes(c)} /> {COUNTRIES[c as keyof typeof COUNTRIES] ?? c}</label>)}
          </div>
        )}
      </div>
      <Field label="Zusatzfahrer-Preisregel" htmlFor="additionalDriverFeeType" hint={v.additionalDriversAllowed ? "Erscheint als eigene Position im Vertrag, nie im Basispreis." : "Zusatzfahrer sind für dieses Fahrzeug nicht vorgesehen."}>
        <select id="additionalDriverFeeType" name="additionalDriverFeeType" value={feeType} onChange={(e) => setFeeType(e.target.value)} className="input" disabled={!v.additionalDriversAllowed}>{Object.entries(ADDITIONAL_DRIVER_FEE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {source("additionalDriverFeeType")}
      </Field>
      {feeType !== "FREE" && v.additionalDriversAllowed && <Field label="Zusatzfahrer-Preis €" htmlFor="additionalDriverFeeCents"><input id="additionalDriverFeeCents" name="additionalDriverFeeCents" inputMode="decimal" defaultValue={v.additionalDriverFee} className="input tnum" />{source("additionalDriverFeeCents")}</Field>}
    </>
  );
}

/** Kenntnisnahme der Mietbedingungen: Häkchen nie vorausgewählt; der Server verlangt sie vor der Mieterunterschrift. */
export function AcknowledgeForm({ action, version }: { action: StepAction; version: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [checked, setChecked] = useState(false);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex items-start gap-2 rounded-md border-2 border-brand px-3 py-2 text-sm">
        <input type="checkbox" name="acknowledged" value="1" checked={checked} onChange={(e) => setChecked(e.target.checked)} required className="mt-1" aria-describedby="ack-hint" />
        <span>{TERMS_ACKNOWLEDGEMENT_TEXT.replace("{version}", version)}</span>
      </label>
      <p id="ack-hint" className="text-xs text-ink-3">Bitte die Bedingungen oben öffnen und dem Mieter zur Kenntnis bringen. Zeitpunkt, Person und Fassung werden dokumentiert.</p>
      <FormError error={state?.error} />
      <div><button type="submit" disabled={pending || !checked} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Kenntnisnahme bestätigen"}</button></div>
    </form>
  );
}

/** Verbindlicher Abschluss: ein Klick, danach gesperrt, mit Ladeanzeige. */
export function FinalizeForm({ action, disabled, reason, label = "Mietvertrag verbindlich abschließen", pendingLabel = "Vertrag wird abgeschlossen…" }: { action: StepAction; disabled: boolean; reason?: string; label?: string; pendingLabel?: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [clicked, setClicked] = useState(false);
  const locked = disabled || pending || (clicked && !state?.error);
  return (
    <form
      onSubmit={(e) => {
        setClicked(true);
        submitWithoutReset(formAction)(e);
      }}
      className="flex flex-col gap-2"
    >
      <FormError error={state?.error} />
      <button type="submit" disabled={locked} className="btn btn-primary justify-center !py-3 !text-[15px]">
        {pending || (clicked && !state?.error) ? pendingLabel : label}
      </button>
      {disabled && reason && <p className="text-xs text-ink-3">{reason}</p>}
    </form>
  );
}

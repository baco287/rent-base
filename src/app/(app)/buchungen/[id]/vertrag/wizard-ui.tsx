"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ADDITIONAL_DRIVER_FEE_TYPES, COUNTRIES, FUEL_POLICIES, KM_POLICIES, PETS_POLICIES, TERMS_ACKNOWLEDGEMENT_TEXT } from "@/lib/constants";
import { Field, FormError, type FieldIssue } from "@/components/ui";
import { SignaturePad } from "@/components/signature-pad";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { WIZARD_STEPS } from "./steps";
import { ActionBar, BAR_BACK, BAR_NEXT, LockedBox, SourceHint } from "./wizard-layout";
import { useBarHeight } from "./wizard-shell";
import { ContractIcon } from "./contract-icons";

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
/** Einzelner Weiter-Knopf ohne Fußleiste, z. B. „Nein, nur der Hauptfahrer“ (Befehl 20.8); nutzt dieselbe Navigations-Action. */
export function NavButton({ action, label, className = "btn btn-primary justify-center !py-2.5" }: { action: StepAction; label: string; className?: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <button type="submit" name="nav" value="next" disabled={pending} className={className}>{pending ? "Bitte warten…" : label}</button>
      <FormError error={state?.error} />
    </form>
  );
}

/**
 * variant "page" (Befehl 29.6): Formular als display: contents – die Eingabekarten liegen im Kartenraster der Hauptspalte,
 * die Aktionsleiste (sticky) am Ende; gleiche Absende-Logik (nav über den Submitter, Eingaben bleiben bei Fehlern erhalten).
 * Standard "card": unverändert (Übergabe, Rückgabe).
 */
export function StepForm({ action, children, step, nextLabel = "Speichern & weiter", hideNext = false, variant = "card", info }: { action: StepAction; children: ReactNode; step: number; nextLabel?: string; hideNext?: boolean; variant?: "card" | "page"; info?: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const barRef = useRef<HTMLDivElement>(null);
  useBarHeight(barRef);
  if (variant === "page") {
    return (
      <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="contents">
        {children}
        <ActionBar
          barRef={barRef}
          error={state?.error}
          left={step > 1 ? (
            <button type="submit" name="nav" value="back" formNoValidate disabled={pending} className={BAR_BACK}>
              <ContractIcon name="chevron-left" size={16} /><span className="max-sm:sr-only">Zurück</span>
            </button>
          ) : undefined}
          info={info}
          right={!hideNext ? (
            <button type="submit" name="nav" value="next" disabled={pending} className={BAR_NEXT}>
              {pending ? "Wird gespeichert…" : nextLabel}<ContractIcon name="chevron-right" size={16} />
            </button>
          ) : undefined}
        />
      </form>
    );
  }
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-4">
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
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-3 ${className}`}>
      {children}
      <FormError error={state?.error} />
      <div>
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? pendingLabel : submitLabel}</button>
      </div>
    </form>
  );
}

/**
 * Auswahl "Mieter fährt selbst" oder "Abweichender Fahrer". Die Fahrerfelder sind nur im zweiten Fall aktiv.
 * Befehl 29.6: Kacheln als Fieldset mit (unsichtbarer) Legende; renterSummary bzw. das gesperrte Fieldset bleiben die einzige Steuerung.
 */
export function DriverModeSection({ initial, renterSummary, children }: { initial: "RENTER" | "OTHER"; renterSummary: ReactNode; children: ReactNode }) {
  const [mode, setMode] = useState(initial);
  const option = (value: "RENTER" | "OTHER", title: string, text: string) => (
    <label className={`flex-1 cursor-pointer rounded-lg border-2 p-3.5 flex gap-3 items-start has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-info ${mode === value ? "border-brand bg-brand-soft" : "border-line bg-panel"}`}>
      <input type="radio" name="driverMode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1 size-4" />
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-panel text-brand"><ContractIcon name={value === "RENTER" ? "user" : "users"} /></span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="block text-xs text-ink-2">{text}</span>
      </span>
    </label>
  );
  return (
    <>
      <fieldset className="card px-4 py-4 md:px-[18px]">
        <legend className="sr-only">Wer fährt das Fahrzeug?</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {option("RENTER", "Mieter fährt selbst", "Die Führerscheindaten des Mieters werden in den Vertrag übernommen.")}
          {option("OTHER", "Abweichender Fahrer", "Eine andere Person fährt. Ihre Daten werden eigens am Vertrag gespeichert.")}
        </div>
      </fieldset>
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
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
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
/*
 * Geschäftsregeln im Schritt Konditionen (Befehl 29.6: auf die Karten E, F und G verteilt; vorher eine Komponente RuleFields).
 * Jedes Feld zeigt seine Herkunft (Text vom Server); abhängige Felder erscheinen nur bei Bedarf. Feldnamen, Werte und
 * Bedingungen sind unverändert – das verborgene rulesPresent setzt page.tsx genau einmal.
 */
const sourceHint = (text: string | undefined, locked = false): ReactNode => (text ? <SourceHint locked={locked}>Quelle: {text}</SourceHint> : null);
const lockedSelect = "input disabled:bg-panel-2 disabled:text-ink-2 disabled:cursor-not-allowed";

/** Karte E: Kilometerregel. kmLocked (Befehl 29, Tarifbuchung): Regel aus der Buchung – Auswahl gesperrt, Wert als verborgenes Feld. */
export function KmPolicyField({ value, note, kmLocked = false, source }: { value: string; note: string; kmLocked?: boolean; source?: string }) {
  const [kmPolicy, setKmPolicy] = useState(value);
  return (
    <>
      <div className="min-w-0 @min-[480px]/karte:col-span-2">
        <Field label="Kilometerregel" htmlFor="kmPolicy">
          <select id="kmPolicy" name={kmLocked ? undefined : "kmPolicy"} value={kmPolicy} onChange={(e) => setKmPolicy(e.target.value)} disabled={kmLocked} className={lockedSelect}>{Object.entries(KM_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {kmLocked && <input type="hidden" name="kmPolicy" value={kmPolicy} />}
          {sourceHint(source, kmLocked)}
        </Field>
      </div>
      {kmPolicy === "INDIVIDUAL" && (
        <div className="min-w-0 @min-[480px]/karte:col-span-2">
          <Field label="Beschreibung der individuellen Kilometerregel" htmlFor="kmPolicyNote"><input id="kmPolicyNote" name="kmPolicyNote" defaultValue={note} className="input" maxLength={300} /></Field>
        </div>
      )}
    </>
  );
}

/** Karte E: Tank-/Laderegel mit Preis je fehlendem Liter; Mindeststände bzw. Beschreibung nur, wenn die Regel sie braucht. */
export function FuelRuleFields({ driveClass, fuelPolicy: initial, fuelPolicyNote, fuelMinimumEighths, batteryMinimumPercent, fuelPricePerLiter, source, noteIssue }: { driveClass: RuleFieldValues["driveClass"]; fuelPolicy: string; fuelPolicyNote: string; fuelMinimumEighths: string; batteryMinimumPercent: string; fuelPricePerLiter: string; source?: string; noteIssue?: FieldIssue }) {
  const [fuelPolicy, setFuelPolicy] = useState(initial);
  return (
    <>
      <Field label={driveClass === "ELECTRIC" ? "Laderegel" : driveClass === "PHEV" ? "Tank- und Laderegel" : "Tankregelung"} htmlFor="fuelPolicy">
        <select id="fuelPolicy" name="fuelPolicy" value={fuelPolicy} onChange={(e) => setFuelPolicy(e.target.value)} className="input">
          {Object.entries(FUEL_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {sourceHint(source)}
      </Field>
      <Field label="Preis je fehlendem Liter € (optional)" htmlFor="fuelPricePerLiter"><input id="fuelPricePerLiter" name="fuelPricePerLiter" inputMode="decimal" defaultValue={fuelPricePerLiter} className="input tnum" /></Field>
      {fuelPolicy === "MINIMUM_LEVEL" && driveClass !== "ELECTRIC" && <Field label="Mindestfüllstand Tank (Achtel, 0–8)" htmlFor="fuelMinimumEighths"><input id="fuelMinimumEighths" name="fuelMinimumEighths" type="number" min={0} max={8} defaultValue={fuelMinimumEighths} className="input tnum" /></Field>}
      {fuelPolicy === "MINIMUM_LEVEL" && driveClass !== "COMBUSTION" && <Field label="Mindestladestand Batterie (%)" htmlFor="batteryMinimumPercent"><input id="batteryMinimumPercent" name="batteryMinimumPercent" type="number" min={0} max={100} defaultValue={batteryMinimumPercent} className="input tnum" /></Field>}
      {fuelPolicy === "OTHER" && (
        <div className="min-w-0 col-span-full">
          <Field label="Beschreibung bei individueller Tankregelung" htmlFor="fuelPolicyNote" issue={noteIssue}><input id="fuelPolicyNote" name="fuelPolicyNote" defaultValue={fuelPolicyNote} aria-invalid={noteIssue?.error ? true : undefined} aria-describedby={noteIssue?.describedBy || undefined} className="input" placeholder="Nur bei „Individuelle Regelung“ nötig" /></Field>
        </div>
      )}
    </>
  );
}

/** Karte E: Tiere und Rauchen. */
export function UsageRuleFields({ petsPolicy, smokingAllowed, sources }: { petsPolicy: string; smokingAllowed: boolean; sources: Record<string, string> }) {
  return (
    <>
      <Field label="Tiere im Fahrzeug" htmlFor="petsPolicy">
        <select id="petsPolicy" name="petsPolicy" defaultValue={petsPolicy} className="input">{Object.entries(PETS_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {sourceHint(sources.petsPolicy)}
      </Field>
      <div className="flex flex-col gap-1">
        <span className="label-xs">Rauchen im Fahrzeug</span>
        <label className="flex min-h-[38px] items-center gap-2 text-sm"><input type="checkbox" name="smokingAllowed" value="1" defaultChecked={smokingAllowed} className="size-4" /> Rauchen gestattet</label>
        {sourceHint(sources.smokingAllowed)}
      </div>
    </>
  );
}

/**
 * Karte F: Auslandsfahrten. abroadLocked: Auslandsfahrt laut Buchung (Genehmigung, Länder, Aufpreis) – nur Anzeige, keine Felder
 * (die Aktion lässt die Werte dann unverändert). Sonst Häkchen und Länder aus der Freigabeliste des Vermieters.
 */
export function AbroadRuleFields({ abroadAllowed, abroadCountries, allowedCountries, abroadPossible, abroadLocked = null, source }: { abroadAllowed: boolean; abroadCountries: string[]; allowedCountries: string[]; abroadPossible: boolean; abroadLocked?: string | null; source?: string }) {
  const [abroad, setAbroad] = useState(abroadAllowed);
  return abroadLocked ? (
    <LockedBox>
      <span className="label-xs">Auslandsfahrten</span>
      <span>{abroadLocked}</span>
      <SourceHint locked>laut Buchung – Änderung in der Buchung · Quelle: Buchung</SourceHint>
    </LockedBox>
  ) : (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="abroadAllowed" value="1" checked={abroad} onChange={(e) => setAbroad(e.target.checked)} disabled={!abroadPossible} className="size-4" /> Auslandsfahrten gestattet</label>
      {sourceHint(source)}
      {!abroadPossible && <span className="text-xs text-ink-2">Nach den Geschäftsregeln des Vermieters sind Auslandsfahrten nicht vorgesehen. Eine Freigabe braucht zuerst die Einstellung (Inhaber).</span>}
      {abroad && abroadPossible && (
        <div role="group" aria-labelledby="k4-f-laender" className="flex flex-col gap-1.5 rounded-lg bg-panel-2 p-3">
          <span id="k4-f-laender" className="text-xs text-ink-2">Konkret genehmigte Länder (nur aus der Freigabeliste des Vermieters):</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
            {allowedCountries.map((c) => <label key={c} className="flex min-h-7 items-center gap-1.5"><input type="checkbox" name="abroadCountries" value={c} defaultChecked={abroadCountries.includes(c)} className="size-4" /> {COUNTRIES[c as keyof typeof COUNTRIES] ?? c}</label>)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Karte G: Zusatzfahrer-Preisregel. driverFeeNote (Befehl 29 Phase E, Unfallersatz): nur ein Hinweis – die Gebühr aus den Regeln gilt dort nicht. */
export function DriverFeeFields({ driverFeeNote, allowed, feeType: initial, fee, sources }: { driverFeeNote?: string; allowed: boolean; feeType: string; fee: string; sources: Record<string, string> }) {
  const [feeType, setFeeType] = useState(initial);
  if (driverFeeNote) return <div className="col-span-full flex flex-col gap-1"><span className="label-xs">Zusatzfahrer-Kosten</span><span className="text-sm text-ink-2 py-1">{driverFeeNote}</span></div>;
  return (
    <>
      <Field label="Zusatzfahrer-Preisregel" htmlFor="additionalDriverFeeType" hint={allowed ? "Erscheint als eigene Position im Vertrag, nie im Basispreis." : "Zusatzfahrer sind für dieses Fahrzeug nicht vorgesehen."}>
        <select id="additionalDriverFeeType" name="additionalDriverFeeType" value={feeType} onChange={(e) => setFeeType(e.target.value)} className={lockedSelect} disabled={!allowed}>{Object.entries(ADDITIONAL_DRIVER_FEE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {sourceHint(sources.additionalDriverFeeType)}
      </Field>
      {feeType !== "FREE" && allowed ? <Field label="Zusatzfahrer-Preis €" htmlFor="additionalDriverFeeCents"><input id="additionalDriverFeeCents" name="additionalDriverFeeCents" inputMode="decimal" defaultValue={fee} className="input tnum" />{sourceHint(sources.additionalDriverFeeCents)}</Field> : <div className="hidden @min-[448px]/karte:block" />}
    </>
  );
}

/**
 * Kenntnisnahme der Mietbedingungen: Häkchen nie vorausgewählt; der Server verlangt sie vor der Mieterunterschrift.
 * Befehl 20.8: Häkchen setzen löst die Bestätigung sofort aus (ein Schritt statt zwei); bis der Server geantwortet hat,
 * zeigt die UI „wird bestätigt“ – sie behauptet nie, die Kenntnisnahme sei schon dokumentiert. Danach lädt die Seite den
 * Serverstand (Chip „Kenntnisnahme bestätigt“, roter Punkt verschwindet). Der Knopf bleibt als Ersatz erhalten.
 */
export function AcknowledgeForm({ action, version }: { action: StepAction; version: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [checked, setChecked] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3">
      <label className={`flex items-start gap-2 rounded-md border-2 px-3 py-2 text-sm ${pending ? "border-line bg-panel-2" : "border-brand"}`}>
        <input type="checkbox" name="acknowledged" value="1" checked={checked} disabled={pending} onChange={(e) => { setChecked(e.target.checked); if (e.target.checked) setTimeout(() => formRef.current?.requestSubmit(), 0); }} required className="mt-1" aria-describedby="ack-hint" />
        <span>{TERMS_ACKNOWLEDGEMENT_TEXT.replace("{version}", version)}</span>
      </label>
      {pending ? (
        <p role="status" className="rounded-md bg-info-soft text-info px-3 py-2 text-sm">Kenntnisnahme wird bestätigt …</p>
      ) : (
        <p id="ack-hint" className="text-xs text-ink-3">Bitte die Bedingungen oben öffnen und dem Mieter zur Kenntnis bringen. Mit dem Häkchen wird die Kenntnisnahme dokumentiert (Zeitpunkt, Person, Fassung).</p>
      )}
      <FormError error={state?.error} />
      {state?.error && <div><button type="submit" disabled={pending || !checked} className="btn btn-primary">Kenntnisnahme erneut bestätigen</button></div>}
    </form>
  );
}

/**
 * Verbindlicher Abschluss: ein Klick, danach gesperrt, mit Ladeanzeige.
 * variant "bar" (Befehl 29.6, Vertrag Schritt 7): dieselbe Logik in der sticky Aktionsleiste; left = „Zurück“ (vom Server),
 * der Grund steht auf allen Breiten sichtbar (aria-live) und ist per aria-describedby mit dem Knopf verknüpft.
 * Standard "stack": unverändert (Übergabe, Rückgabe, Nachtrag).
 */
export function FinalizeForm({ action, disabled, reason, label = "Mietvertrag verbindlich abschließen", pendingLabel = "Vertrag wird abgeschlossen…", variant = "stack", left }: { action: StepAction; disabled: boolean; reason?: string; label?: string; pendingLabel?: string; variant?: "stack" | "bar"; left?: ReactNode }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [clicked, setClicked] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  useBarHeight(barRef);
  const locked = disabled || pending || (clicked && !state?.error);
  if (variant === "bar") {
    const why = disabled && reason ? reason : undefined;
    return (
      <form
        action={formAction}
        onSubmit={(e) => {
          setClicked(true);
          submitWithoutReset(formAction)(e);
        }}
        className="contents"
      >
        <ActionBar
          barRef={barRef}
          error={state?.error}
          left={left}
          statusId="abschluss-grund"
          status={why}
          right={
            <button type="submit" disabled={locked} aria-describedby={why ? "abschluss-grund" : undefined} className={`${BAR_NEXT} !text-[15px]`}>
              {pending || (clicked && !state?.error) ? pendingLabel : label}
            </button>
          }
        />
      </form>
    );
  }
  return (
    <form
      action={formAction}
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

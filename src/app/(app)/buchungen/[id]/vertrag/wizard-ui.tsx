"use client";

import { useActionState, useState, type ReactNode } from "react";
import Link from "next/link";
import { FormError } from "@/components/ui";
import { SignaturePad } from "@/components/signature-pad";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { WIZARD_STEPS } from "./steps";

export type StepState = { error?: string } | undefined;
type StepAction = (prev: StepState, fd: FormData) => Promise<StepState>;


/** Fortschrittsanzeige. Erledigte Schritte sind anklickbar, so kann man jederzeit zurückspringen. */
export function WizardProgress({ bookingId, current, reached }: { bookingId: string; current: number; reached: number }) {
  return (
    <nav aria-label="Fortschritt" className="card p-2.5 md:p-3">
      <ol className="flex gap-1.5 overflow-x-auto">
        {WIZARD_STEPS.map((label, i) => {
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
                <Link href={`/buchungen/${bookingId}/vertrag?schritt=${n}`} aria-current={state === "current" ? "step" : undefined} className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12.5px] font-medium ${cls}`}>
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

/** Verbindlicher Abschluss: ein Klick, danach gesperrt, mit Ladeanzeige. */
export function FinalizeForm({ action, disabled, reason }: { action: StepAction; disabled: boolean; reason?: string }) {
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
        {pending || (clicked && !state?.error) ? "Vertrag wird abgeschlossen…" : "Mietvertrag verbindlich abschließen"}
      </button>
      {disabled && reason && <p className="text-xs text-ink-3">{reason}</p>}
    </form>
  );
}

"use client";

// Abschluss einer Gutschrift oder eines Stornobelegs: Vorschau der Wirkung, Pflichtgrund, ausdrückliche Bestätigung,
// Doppelklick-sicher. Es entsteht ausschließlich ein Beleg – keine Zahlung, keine Erstattung, keine Verrechnung.
import { useActionState, useState } from "react";
import { submitWithoutReset } from "@/components/submit-without-reset";
import type { CounterState } from "./counter-actions";

type Action = (prev: CounterState, fd: FormData) => Promise<CounterState>;

export type EffectPreview = { invoice: string; creditedBefore: string; thisDocument: string; effectiveAfter: string; paid: string; customerCreditAfter: string; openAfter: string };

export function FinalizeCounterForm({ action, type, reason, blocking, blockingReason, effect }: { action: Action; type: "CREDIT_NOTE" | "CANCELLATION"; reason: string; blocking: boolean; blockingReason?: string; effect: EffectPreview }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [clicked, setClicked] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [why, setWhy] = useState(reason);
  const credit = type === "CREDIT_NOTE";
  const locked = blocking || pending || (clicked && !state?.error) || !confirmed || why.trim().length < 3;
  return (
    <form onSubmit={(e) => { setClicked(true); submitWithoutReset(formAction)(e); }} className="card p-4 flex flex-col gap-3">
      <div className="font-semibold">{credit ? "Gutschrift abschließen" : "Rechnung stornieren"}</div>
      <div className="rounded-md border border-line-soft p-3 text-sm flex flex-col gap-1">
        <div className="label-xs">Wirkung auf die Rechnung</div>
        <div className="flex justify-between"><span className="text-ink-3">Rechnungsbetrag</span><span className="font-mono tnum">{effect.invoice}</span></div>
        <div className="flex justify-between"><span className="text-ink-3">Bereits gutgeschrieben</span><span className="font-mono tnum">− {effect.creditedBefore}</span></div>
        <div className="flex justify-between font-semibold"><span>{credit ? "Diese Gutschrift" : "Dieser Stornobeleg"}</span><span className="font-mono tnum">− {effect.thisDocument}</span></div>
        <div className="flex justify-between border-t border-line-soft pt-1"><span className="text-ink-3">Forderung danach</span><span className="font-mono tnum">{effect.effectiveAfter}</span></div>
        <div className="flex justify-between"><span className="text-ink-3">Dokumentierte Zahlungen</span><span className="font-mono tnum">{effect.paid}</span></div>
        <div className="flex justify-between"><span className="text-ink-3">Offen danach</span><span className="font-mono tnum">{effect.openAfter}</span></div>
        <div className={`flex justify-between font-semibold ${effect.customerCreditAfter !== "0,00 €" ? "text-bad" : ""}`}><span>Kundenguthaben danach (Erstattung erforderlich)</span><span className="font-mono tnum">{effect.customerCreditAfter}</span></div>
      </div>
      {!credit && <p className="text-sm text-ink-2">Der Stornobeleg hebt den noch offenen Rest der Rechnung vollständig auf; die Gesamtwirkung von Rechnung, Gutschriften und Storno ist dann 0,00 €. Die Rechnung selbst und ihr PDF bleiben unverändert archiviert. Danach sind keine weiteren Gutschriften möglich.</p>}
      <label className="flex flex-col gap-1">
        <span className="label-xs">{credit ? "Grund der Gutschrift (Pflicht, erscheint auf dem Beleg)" : "Grund des Stornos (Pflicht, erscheint auf dem Beleg)"}</span>
        <input name="reason" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} className="input" placeholder={credit ? "z. B. Reinigungspauschale zu Unrecht berechnet" : "z. B. Rechnung an den falschen Empfänger gestellt"} />
      </label>
      <label className="flex items-start gap-2 rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">
        <input type="checkbox" name="confirmed" value="1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
        <span>Ich bestätige den Abschluss. Das System vergibt die Belegnummer, friert den Beleg ein, erzeugt das PDF und sendet es an den Rechnungsempfänger. Zahlungen bleiben unverändert; Rent-Base erstattet, verrechnet und zahlt nichts automatisch aus.</span>
      </label>
      {state?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>}
      <button type="submit" disabled={locked} className="btn btn-primary justify-center !py-3 !text-[15px]">
        {pending || (clicked && !state?.error) ? "Wird abgeschlossen…" : credit ? "Gutschrift finalisieren" : "Stornobeleg finalisieren"}
      </button>
      {blocking && blockingReason && <p className="text-xs text-ink-3">{blockingReason}</p>}
    </form>
  );
}

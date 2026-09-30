"use client";

// Befehl 23: Formulare des Mahnwesens. Erst Vorschau (Server rechnet), dann bewusste Bestätigung. Der Server prüft beim
// Erstellen den Betrag der Vorschau erneut; hat sich der Stand geändert, wird nichts erstellt.

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { fmtCents } from "@/lib/money";
import type { DunningPlanView, DunningState } from "./dunning-actions";

type Action = (prev: DunningState, fd: FormData) => Promise<DunningState>;

function Feedback({ state }: { state: DunningState }) {
  if (state?.error) return <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>;
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  return null;
}

function useDunningAction(action: Action) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: DunningState, fd: FormData) => {
    const res = await action(prev, fd);
    router.refresh();
    return res;
  }, undefined);
  return { state, formAction, pending, done: !!state?.ok };
}

const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <div className="flex items-baseline justify-between gap-3"><span className="text-ink-2">{label}</span><span className={`font-mono tnum text-right ${strong ? "font-semibold" : ""}`}>{value}</span></div>
);

/** „Zahlungserinnerung / 1. Mahnung / 2. Mahnung erstellen“: Vorschau, dann Versand per E-Mail oder Erstellen für den Postversand. */
export function DunningCreateForm({ levelLabel, preview, action, nonce }: { levelLabel: string; preview: () => Promise<DunningPlanView | { error: string }>; action: Action; nonce: string }) {
  const { state, formAction, pending, done } = useDunningAction(action);
  const [pv, setPv] = useState<DunningPlanView | { error: string } | null>(null);
  const [loading, start] = useTransition();
  if (done) return <Feedback state={state} />;
  const plan = pv && "totalCents" in pv ? pv : null;
  if (!pv) {
    return (
      <div className="flex flex-col gap-2">
        <div><button type="button" className="btn btn-primary !py-2.5" disabled={loading} onClick={() => start(async () => setPv(await preview()))}>{loading ? "Vorschau wird berechnet…" : `${levelLabel} erstellen`}</button></div>
        <Feedback state={state} />
      </div>
    );
  }
  return (
    <form action={formAction} className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-3">
      <input type="hidden" name="nonce" value={nonce} />
      {"error" in pv && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{pv.error}</p>}
      {plan && (
        <>
          <div className="text-sm font-medium">Vorschau: {plan.levelLabel} zu Rechnung {plan.invoiceNumber}</div>
          <div className="text-sm flex flex-col gap-0.5">
            <Row label="Offener Rechnungsbetrag" value={fmtCents(plan.principalOpenCents)} />
            {plan.priorFeesOpenCents > 0 && <Row label="Offene Mahngebühren früherer Stufen" value={fmtCents(plan.priorFeesOpenCents)} />}
            <Row label={plan.feeCents > 0 ? "Mahngebühr dieser Stufe (eigene Gebührenrechnung)" : "Mahngebühr dieser Stufe"} value={plan.feeCents > 0 ? fmtCents(plan.feeCents) : "keine"} />
            <div className="border-t border-line-soft mt-1 pt-1"><Row label="Gesamtforderung" value={fmtCents(plan.totalCents)} strong /></div>
            <Row label="Neue Frist" value={`${plan.deadline} (${plan.deadlineDays} Tage)`} strong />
            {plan.dueDate && <Row label="Rechnung fällig seit" value={`${plan.dueDate}${plan.daysOverdue > 0 ? ` · ${plan.daysOverdue} Tage überfällig` : ""}`} />}
            <Row label="Empfänger" value={plan.recipientEmail ? `${plan.recipientName} (${plan.recipientEmail})` : `${plan.recipientName} · keine E-Mail-Adresse`} />
          </div>
          {!plan.allowed && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">{plan.reason}</p>}
          <input type="hidden" name="expectedTotalCents" value={plan.totalCents} />
          {plan.allowed && (
            <div className="flex flex-col sm:flex-row flex-wrap gap-2">
              {plan.recipientEmail && <button type="submit" name="delivery" value="EMAIL" disabled={pending} className="btn btn-primary !py-2.5 max-w-full !whitespace-normal text-left">{pending ? "Wird erstellt…" : `${plan.levelLabel} an ${plan.recipientName} (${plan.recipientEmail}) senden`}</button>}
              <button type="submit" name="delivery" value="POST" disabled={pending} className={`btn !py-2.5 ${plan.recipientEmail ? "" : "btn-primary"}`}>{pending ? "Wird erstellt…" : "Nur erstellen – Versand per Post"}</button>
            </div>
          )}
          <p className="text-xs text-ink-3">Das Schreiben erhält eine feste Nummer und bleibt unverändert. Zahlungen, Gutschriften oder Kautionsverrechnungen danach verändern es nicht; die nächste Stufe rechnet mit dem dann aktuellen Stand.</p>
        </>
      )}
      <div><button type="button" className="btn" onClick={() => setPv(null)}>Abbrechen</button></div>
      <Feedback state={state} />
    </form>
  );
}

/** Versand bzw. erneuter Versand mit Rückfrage. */
export function DunningSendForm({ action, id, nonce, label, question }: { action: Action; id: string; nonce: string; label: string; question: string }) {
  const { state, formAction, pending, done } = useDunningAction(action);
  const [open, setOpen] = useState(false);
  if (done) return <Feedback state={state} />;
  if (!open) return <div className="flex flex-col gap-2"><div><button type="button" className="btn !py-2.5" onClick={() => setOpen(true)}>{label}</button></div><Feedback state={state} /></div>;
  return (
    <form action={formAction} className="rounded-md border border-line bg-panel-2 p-3 flex flex-col gap-2 text-sm">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="nonce" value={nonce} />
      <div className="font-medium">{question}</div>
      <p className="text-xs text-ink-3">Es wird dasselbe archivierte PDF versendet. Keine neue Stufe, keine neue Gebühr, keine neue Nummer.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird gesendet…" : "Ja, senden"}</button>
        <button type="button" className="btn !py-2.5" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Übermittlung per Post oder persönlich vermerken (einmalig). */
export function DunningDeliveredForm({ action, id }: { action: Action; id: string }) {
  const { state, formAction, pending, done } = useDunningAction(action);
  const [open, setOpen] = useState(false);
  if (done) return <Feedback state={state} />;
  if (!open) return <div><button type="button" className="btn !py-2.5" onClick={() => setOpen(true)}>Übermittlung vermerken</button></div>;
  return (
    <form action={formAction} className="rounded-md border border-line bg-panel-2 p-3 flex flex-col gap-2 text-sm">
      <input type="hidden" name="id" value={id} />
      <label className="flex flex-col gap-1"><span className="label-xs">Wie übermittelt? (optional)</span><input name="note" maxLength={300} className="input" placeholder="z. B. per Post am …, persönlich übergeben" /></label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird vermerkt…" : "Als übermittelt vermerken"}</button>
        <button type="button" className="btn !py-2.5" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

"use client";

// Auszahlungen erfassen und verwalten: Eingabe → serverseitige Vorschau (Rest vor/nach, Empfänger, Weg) → ausdrückliche
// Bestätigung. Zwei Wege: „Als Entwurf speichern“ (kein Geldfluss) oder „Auszahlung als tatsächlich erfolgt erfassen“.
// Jedes Formular trägt einen einmaligen Schlüssel; nach Erfolg ist es gesperrt (kein Doppelklick).

import { useActionState, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { PAYOUT_METHODS, type PayoutMethod } from "@/lib/constants";
import { fmtCents } from "@/lib/money";
import type { PayoutPreview } from "@/lib/payouts";
import type { PayoutState } from "./actions";

type Action = (prev: PayoutState, formData: FormData) => Promise<PayoutState>;

function Feedback({ state }: { state: PayoutState }) {
  if (state?.error) return <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>;
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  return null;
}

function usePayoutAction(action: Action) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: PayoutState, fd: FormData) => {
    const res = await action(prev, fd);
    if (res?.ok) router.refresh();
    return res;
  }, undefined);
  return { state, formAction, pending, done: !!state?.ok };
}

const Row = ({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "bad" | "good" }) => <div className={`flex justify-between gap-3 ${strong ? "font-semibold" : ""} ${tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : ""}`}><span className={strong ? "" : "text-ink-3"}>{label}</span><span className="font-mono tnum">{value}</span></div>;

export type PayoutFormProps = {
  action: Action;
  preview: (payload: unknown) => Promise<PayoutPreview | { error: string }>;
  sourceLabel: string;
  remaining: string;
  remainingCents: number;
  customerName: string;
  nonce: string;
  defaultWhen: string;
  /** vorhandener Entwurf: Felder vorbelegen, Schaltfläche „Entwurf speichern“ */
  draft?: { amount: string; method: string; methodDescription: string; executedAt: string; recipientName: string; recipientReason: string; iban: string; reference: string; receiptConfirmed: boolean; historicalEntry: boolean; customerNote: string; internalNote: string } | null;
  kind: "INVOICE" | "DEPOSIT";
};

export function PayoutForm({ action, preview, sourceLabel, remaining, remainingCents, customerName, nonce, defaultWhen, draft = null, kind }: PayoutFormProps) {
  const { state, formAction, pending, done } = usePayoutAction(action);
  const [open, setOpen] = useState(!!draft);
  const [method, setMethod] = useState<PayoutMethod>((draft?.method as PayoutMethod) || "BANK_TRANSFER");
  const [recipient, setRecipient] = useState(draft?.recipientName || customerName);
  const [pv, setPv] = useState<PayoutPreview | { error: string } | null>(null);
  const [mode, setMode] = useState<"draft" | "complete">("complete");
  const [confirmed, setConfirmed] = useState(false);
  const [checking, start] = useTransition();
  const form = useRef<HTMLFormElement>(null);

  const check = (nextMode: "draft" | "complete") => {
    if (!form.current) return;
    if (nextMode === "complete" && !form.current.reportValidity()) return;
    const fd = new FormData(form.current);
    setMode(nextMode);
    if (nextMode === "draft") { setPv({ error: "" }); return; }
    start(async () => setPv(await preview(Object.fromEntries(fd))));
  };
  const full = pv && "source" in pv && !pv.error ? pv : null;
  const pvError = pv && "error" in pv && pv.error ? pv.error : null;
  if (done) return <Feedback state={state} />;
  if (!open) return <div><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>{kind === "INVOICE" ? "Erstattung erfassen" : "Kaution auszahlen"}</button></div>;
  const deviates = recipient.trim() !== customerName;

  return (
    <form ref={form} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <input type="hidden" name="nonce" value={nonce} />
      <input type="hidden" name="mode" value={mode} />
      <div className="font-medium">{kind === "INVOICE" ? "Erstattung an den Kunden erfassen" : "Kautionsrückzahlung erfassen"}</div>
      <div className="text-sm text-ink-2">{sourceLabel} · noch auszuzahlen: <span className="font-mono tnum font-semibold">{remaining}</span></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Betrag in €</span><input name="amount" inputMode="decimal" placeholder="0,00" required defaultValue={draft?.amount ?? (remainingCents / 100).toFixed(2).replace(".", ",")} className="input text-xl tnum" onChange={() => setPv(null)} /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Auszahlungsweg</span>
          <select name="method" value={method} onChange={(e) => { setMethod(e.target.value as PayoutMethod); setPv(null); }} className="input">
            {Object.entries(PAYOUT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1"><span className="label-xs">Tatsächlicher Zeitpunkt der Auszahlung</span><input name="executedAt" type="datetime-local" defaultValue={draft?.executedAt || defaultWhen} required className="input" onChange={() => setPv(null)} /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Empfänger (Standard: Kunde)</span><input name="recipientName" value={recipient} maxLength={200} className="input" onChange={(e) => { setRecipient(e.target.value); setPv(null); }} /></label>
        {deviates && <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Grund für den abweichenden Empfänger (Pflicht)</span><input name="recipientReason" required minLength={3} maxLength={300} defaultValue={draft?.recipientReason ?? ""} className="input" placeholder="z. B. Rückzahlung an den Kontoinhaber der ursprünglichen Zahlung" /></label>}
        {method === "BANK_TRANSFER" && <label className="flex flex-col gap-1"><span className="label-xs">IBAN des Empfängerkontos</span><input name="iban" required defaultValue={draft?.iban ?? ""} className="input font-mono" placeholder="DE00 0000 0000 0000 0000 00" autoComplete="off" onChange={() => setPv(null)} /></label>}
        {method === "OTHER" && <label className="flex flex-col gap-1"><span className="label-xs">Auszahlungsweg beschreiben (Pflicht)</span><input name="methodDescription" required minLength={3} maxLength={200} defaultValue={draft?.methodDescription ?? ""} className="input" placeholder="z. B. Gutschein, Scheck, Verrechnungsscheck" /></label>}
        <label className="flex flex-col gap-1"><span className="label-xs">{method === "BANK_TRANSFER" ? "Verwendungszweck / Transaktionsreferenz (optional)" : method === "CARD" ? "Transaktions- oder Belegreferenz (Pflicht)" : "Referenz (optional)"}</span><input name="reference" required={method === "CARD"} maxLength={140} defaultValue={draft?.reference ?? ""} className="input" /></label>
        {method === "CASH" && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="receiptConfirmed" value="1" defaultChecked={draft?.receiptConfirmed ?? false} />Empfang vom Empfänger bestätigt (z. B. unterschriebene Quittung, danach als Nachweis hochladen)</label>}
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="historicalEntry" value="1" defaultChecked={draft?.historicalEntry ?? false} />Historisch nacherfasst: Die Auszahlung erfolgte bereits außerhalb von Rent-Base (wird auf dem Beleg gekennzeichnet)</label>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Text auf dem Auszahlungsbeleg (optional)</span><input name="customerNote" maxLength={1000} defaultValue={draft?.customerNote ?? ""} className="input" /></label>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Interne Notiz (optional, nicht auf dem Beleg)</span><input name="internalNote" maxLength={2000} defaultValue={draft?.internalNote ?? ""} className="input" /></label>
      </div>
      <p className="text-xs text-ink-3">Rent-Base führt keine Überweisung, Kartenrückbuchung oder Providertransaktion aus. Erfasst wird der tatsächlich außerhalb ausgeführte Vorgang; die IBAN wird nur an dieser Auszahlung gespeichert und verschleiert angezeigt.</p>
      {!full && (
        <div className="flex flex-wrap gap-2 items-center">
          <button type="button" className="btn btn-primary" disabled={checking} onClick={() => check("complete")}>{checking ? "Wird geprüft…" : "Weiter zur Bestätigung"}</button>
          <button type="submit" className="btn" disabled={pending} onClick={() => setMode("draft")}>{pending && mode === "draft" ? "Wird gespeichert…" : draft ? "Entwurf speichern" : "Nur als Entwurf speichern"}</button>
          {!draft && <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>}
        </div>
      )}
      {pvError && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{pvError}</p>}
      {full && (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2 text-sm">
          <div className="font-medium">Auszahlung als tatsächlich erfolgt erfassen?</div>
          <div className="text-3xl font-semibold font-mono tnum tracking-tight">{fmtCents(full.amountCents)}</div>
          <Row label="Noch auszuzahlen vor dieser Auszahlung" value={fmtCents(full.remainingBefore)} />
          <Row label="Noch auszuzahlen danach" value={fmtCents(full.remainingAfter)} strong />
          <Row label="Empfänger" value={full.recipientName + (full.recipientDeviates ? " (abweichend vom Kunden)" : "")} />
          <Row label="Auszahlungsweg" value={PAYOUT_METHODS[full.method]} />
          {full.ibanMasked && <Row label="IBAN" value={full.ibanMasked} />}
          <label className="flex items-start gap-2 rounded-md bg-amber-soft text-amber px-3 py-2">
            <input type="checkbox" name="confirmed" value="1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
            <span>Ich bestätige: Diese Auszahlung ist tatsächlich erfolgt. Rent-Base erfasst sie mit Nummer und Beleg; sie ist danach nur noch per Storno korrigierbar.</span>
          </label>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="submit" disabled={pending || !confirmed} className="btn btn-primary !py-2.5">{pending ? "Wird erfasst…" : "Auszahlung als tatsächlich erfolgt erfassen"}</button>
            <button type="button" className="btn" onClick={() => { setPv(null); setConfirmed(false); }}>Zurück</button>
          </div>
        </div>
      )}
      <Feedback state={state} />
    </form>
  );
}

/** Entwurf abschließen: Bestätigung; Zeitpunkt kann hier noch gesetzt werden. */
export function CompleteDraftForm({ action, amount, defaultWhen, hasExecutedAt }: { action: Action; amount: string; defaultWhen: string; hasExecutedAt: boolean }) {
  const { state, formAction, pending, done } = usePayoutAction(action);
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  if (done) return <Feedback state={state} />;
  if (!open) return <button type="button" className="btn btn-primary !py-1.5" onClick={() => setOpen(true)}>Als tatsächlich erfolgt erfassen</button>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2 rounded-md border-2 border-brand bg-panel p-3 text-sm">
      <div className="font-medium">Auszahlung über {amount} als tatsächlich erfolgt erfassen?</div>
      <label className="flex flex-col gap-1"><span className="label-xs">Tatsächlicher Zeitpunkt</span><input name="executedAt" type="datetime-local" defaultValue={defaultWhen} required={!hasExecutedAt} className="input" /></label>
      <label className="flex items-start gap-2 rounded-md bg-amber-soft text-amber px-3 py-2"><input type="checkbox" name="confirmed" value="1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" /><span>Ich bestätige, dass diese Auszahlung tatsächlich erfolgt ist. Der Rest wird unter Sperre neu geprüft; es wird nie mehr ausgezahlt als verfügbar.</span></label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || !confirmed} className="btn btn-primary">{pending ? "Wird erfasst…" : "Ja, als erfolgt erfassen"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Storno mit Pflichtgrund: Entwurf aufheben oder erfolgte Auszahlung als Fehlbuchung kennzeichnen. */
export function CancelPayoutForm({ action, label, question, wasCompleted }: { action: Action; label: string; question: string; wasCompleted: boolean }) {
  const { state, formAction, pending, done } = usePayoutAction(action);
  const [open, setOpen] = useState(false);
  if (done) return <Feedback state={state} />;
  if (!open) return <button type="button" className="text-xs underline text-ink-3 hover:text-bad" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2 rounded-md bg-bad-soft/40 border border-bad/30 p-3 text-sm">
      <div className="font-medium">{question}</div>
      <label className="flex flex-col gap-1"><span className="label-xs">Grund (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} className="input" placeholder={wasCompleted ? "z. B. versehentlich erfasst, Geld ist nie geflossen" : "z. B. Entwurf nicht mehr benötigt"} /></label>
      <p className="text-xs text-ink-3">{wasCompleted ? "Die Auszahlung bleibt mit Nummer und Beleg sichtbar, zählt aber nicht mehr als erfolgt. Der Betrag steht wieder zur Auszahlung zur Verfügung; danach kann eine korrekte Auszahlung neu erfasst werden." : "Der Entwurf wird aufgehoben und bleibt als storniert sichtbar."}</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-danger">{pending ? "Wird storniert…" : "Stornieren"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function PayoutActionButton({ action, label, pendingLabel, primary = false }: { action: Action; label: string; pendingLabel: string; primary?: boolean }) {
  const { state, formAction, pending } = usePayoutAction(action);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div><button type="submit" disabled={pending} className={`btn ${primary ? "btn-primary" : ""}`}>{pending ? pendingLabel : label}</button></div>
      <Feedback state={state} />
    </form>
  );
}

/** Auszahlungsbeleg per E-Mail senden: Empfänger zeigen, bestätigen; der einmalige Schlüssel verhindert Doppelversand. */
export function SendReceiptForm({ action, recipient, nonce, label }: { action: Action; recipient: string | null; nonce: string; label: string }) {
  const { state, formAction, pending } = usePayoutAction(action);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      {!open ? (
        <div><button type="button" className="btn" onClick={() => setOpen(true)}>{label}</button></div>
      ) : (
        <form action={formAction} className="rounded-md border border-line bg-panel-2 p-3 flex flex-col gap-2.5">
          <input type="hidden" name="nonce" value={nonce} readOnly />
          <div className="text-sm"><div className="label-xs">Empfänger laut Rechnungs- bzw. Vertragskopie</div><div className="font-medium break-all">{recipient || "keine E-Mail-Adresse hinterlegt"}</div></div>
          <p className="text-xs text-ink-3">Versendet wird der archivierte Auszahlungsbeleg. Es wird nichts neu erzeugt und keine Zahlung ausgelöst.</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gesendet…" : "Jetzt senden"}</button>
            <button type="button" disabled={pending} className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
          </div>
        </form>
      )}
      <Feedback state={state} />
    </div>
  );
}

/** Nachweis hochladen (PDF/Bild): privat, geprüft, mit Prüfsumme. */
export function AttachmentUploader({ payoutId }: { payoutId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.set("file", file, file.name);
        const res = await fetch(`/api/payouts/${payoutId}/documents`, { method: "POST", body });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Der Nachweis konnte nicht gespeichert werden.");
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-center">
        <input ref={input} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => upload(e.target.files)} />
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Wird hochgeladen…" : "Nachweis hochladen"}</button>
        <span className="text-xs text-ink-3">Überweisungsbeleg, Terminalbeleg oder unterschriebene Barauszahlungsbestätigung – PDF oder Bild bis 8 MB, privat gespeichert.</span>
      </div>
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error}</p>}
    </div>
  );
}

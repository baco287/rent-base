"use client";

// Geldaktionen mit ausdrücklicher Bestätigung: erst Eingabe, dann Vorschau mit großem Betrag (vom Server gerechnet),
// dann Bestätigen. Jedes Formular trägt einen einmaligen Schlüssel; nach Erfolg ist es gesperrt (kein Doppelklick).

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { PAYMENT_METHODS } from "@/lib/constants";
import { fmtCents } from "@/lib/money";
import type { SettlePreview } from "@/lib/deposits";
import type { PaymentPreview } from "@/lib/payments";
import type { MoneyState } from "./actions";

type Action = (prev: MoneyState, formData: FormData) => Promise<MoneyState>;

function Feedback({ state }: { state: MoneyState }) {
  if (state?.error) return <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>;
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  return null;
}

/** Nach einer erfolgreichen Buchung: Seite neu laden, damit Summen, Status und Historie vom Server kommen. */
function useMoneyAction(action: Action) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: MoneyState, fd: FormData) => {
    const res = await action(prev, fd);
    if (res?.ok) router.refresh();
    return res;
  }, undefined);
  return { state, formAction, pending, done: !!state?.ok };
}

const MethodSelect = ({ name, defaultValue = "CASH", id }: { name: string; defaultValue?: string; id: string }) => (
  <select id={id} name={name} defaultValue={defaultValue} className="input">
    {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
  </select>
);

const Big = ({ children }: { children: React.ReactNode }) => <div className="text-3xl font-semibold font-mono tnum tracking-tight">{children}</div>;
const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => <div className={`flex justify-between gap-3 ${strong ? "font-semibold" : ""}`}><span className="text-ink-3">{label}</span><span className="font-mono tnum">{value}</span></div>;

// ---------------------------------------------------------------------------
// Zahlung erfassen
// ---------------------------------------------------------------------------

/**
 * targetId: Rechnung (Rechnungszahlung) oder Buchung (Mietzahlung vor der Rechnung); die Vorschau rechnet je Ziel.
 * targetField: Name des versteckten Feldes für targetId (null = keines, die Aktion kennt das Ziel bereits).
 */
export function PaymentForm({ action, preview, targetId, targetField = "invoiceId", totalLabel = "Rechnungsbetrag", nonce, defaultWhen }: { action: Action; preview: (targetId: string, amount: string, method: string) => Promise<PaymentPreview | { error: string }>; targetId: string; targetField?: string | null; totalLabel?: string; nonce: string; defaultWhen: string }) {
  const { state, formAction, pending, done } = useMoneyAction(action);
  const [open, setOpen] = useState(false);
  const [pv, setPv] = useState<PaymentPreview | { error: string } | null>(null);
  const [checking, start] = useTransition();
  const [form, setForm] = useState<HTMLFormElement | null>(null);

  const check = () => {
    if (!form) return;
    const fd = new FormData(form);
    start(async () => setPv(await preview(targetId, String(fd.get("amount") ?? ""), String(fd.get("method") ?? ""))));
  };
  const pvError = pv?.error ?? null;
  const full = pv && "grossCents" in pv && !pv.error ? pv : null;
  if (done) return <Feedback state={state} />;
  if (!open) return <div><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Zahlung erfassen</button></div>;

  return (
    <form ref={setForm} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      {targetField && <input type="hidden" name={targetField} value={targetId} />}
      <input type="hidden" name="nonce" value={nonce} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Betrag in €</span><input name="amount" inputMode="decimal" placeholder="0,00" required className="input text-xl tnum" onChange={() => setPv(null)} /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Zahlungsdatum</span><input name="paidAt" type="datetime-local" defaultValue={defaultWhen} required className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Zahlungsart</span><MethodSelect id="pay-method" name="method" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Referenz (optional)</span><input name="reference" maxLength={120} placeholder="z. B. Belegnummer, Verwendungszweck" className="input" /></label>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={500} className="input" /></label>
      </div>
      <p className="text-xs text-ink-3">Karten- und Überweisungszahlungen werden außerhalb von Rent-Base ausgeführt und hier nur dokumentiert.</p>
      {!full && (
        <div className="flex flex-wrap gap-2 items-center">
          <button type="button" className="btn btn-primary" disabled={checking} onClick={check}>{checking ? "Wird geprüft…" : "Weiter zur Bestätigung"}</button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
      )}
      {pvError && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{pvError}</p>}
      {full && (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2">
          <div className="text-sm font-medium">Zahlung über</div>
          <Big>{fmtCents(full.newCents)}</Big>
          <div className="text-sm">als <span className="font-medium">{full.methodLabel}</span> erfassen?</div>
          <div className="text-sm flex flex-col gap-0.5 mt-1 border-t border-line-soft pt-2">
            <Row label={totalLabel} value={fmtCents(full.grossCents)} />
            <Row label="Bereits erfasst" value={fmtCents(full.paidCents)} />
            <Row label="Offener Betrag" value={fmtCents(full.openCents)} />
            <Row label="Neue Zahlung" value={fmtCents(full.newCents)} />
            <Row label="Danach offen" value={fmtCents(full.afterCents)} strong />
          </div>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird erfasst…" : "Ja, Zahlung erfassen"}</button>
            <button type="button" className="btn" onClick={() => setPv(null)}>Zurück</button>
          </div>
        </div>
      )}
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Storno mit Pflichtgrund (Zahlung oder Kautionsbewegung)
// ---------------------------------------------------------------------------

export function ReasonForm({ action, id, label, question }: { action: Action; id: string; label: string; question: string }) {
  const { state, formAction, pending, done } = useMoneyAction(action);
  const [open, setOpen] = useState(false);
  if (done) return <Feedback state={state} />;
  if (!open) return <button type="button" className="text-xs underline text-ink-3 hover:text-bad" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2 rounded-md bg-bad-soft/40 border border-bad/30 p-3 text-sm">
      <input type="hidden" name="id" value={id} />
      <div className="font-medium">{question}</div>
      <label className="flex flex-col gap-1"><span className="label-xs">Grund der Korrektur (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} className="input" placeholder="z. B. Betrag falsch eingegeben" /></label>
      <p className="text-xs text-ink-3">Der Eintrag bleibt sichtbar und wird als storniert gekennzeichnet. Summen werden neu berechnet.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-danger">{pending ? "Wird storniert…" : "Stornieren"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Kaution als erhalten dokumentieren
// ---------------------------------------------------------------------------

export function DepositReceiveForm({ action, nonce, defaultAmount, defaultWhen }: { action: Action; nonce: string; defaultAmount: string; defaultWhen: string }) {
  const { state, formAction, pending, done } = useMoneyAction(action);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ amount: string; method: string } | null>(null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  if (done) return <Feedback state={state} />;
  if (!open) return <div><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Kaution als erhalten erfassen</button></div>;
  const toConfirm = () => {
    if (!form || !form.reportValidity()) return;
    const fd = new FormData(form);
    setConfirm({ amount: String(fd.get("amount") ?? ""), method: PAYMENT_METHODS[String(fd.get("method")) as keyof typeof PAYMENT_METHODS] ?? "" });
  };
  return (
    <form ref={setForm} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <input type="hidden" name="nonce" value={nonce} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Erhaltener Betrag in €</span><input name="amount" inputMode="decimal" defaultValue={defaultAmount} required className="input text-xl tnum" onChange={() => setConfirm(null)} /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Datum und Uhrzeit</span><input name="occurredAt" type="datetime-local" defaultValue={defaultWhen} required className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Methode</span><MethodSelect id="dep-method" name="method" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Referenz (optional)</span><input name="reference" maxLength={120} placeholder="z. B. Belegnummer" className="input" /></label>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={500} className="input" /></label>
      </div>
      <p className="text-xs text-ink-3">Nur Dokumentation: Rent-Base bucht nichts ab. Die Kaution bleibt eine Sicherheitsleistung und wird nicht mit Rechnungen verrechnet.</p>
      {!confirm && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={toConfirm}>Weiter zur Bestätigung</button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
      )}
      {confirm && (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2">
          <div className="text-sm font-medium">Kaution über</div>
          <Big>{confirm.amount} €</Big>
          <div className="text-sm">als erhalten dokumentieren ({confirm.method})?</div>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird dokumentiert…" : "Ja, als erhalten dokumentieren"}</button>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>Zurück</button>
          </div>
        </div>
      )}
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Kaution freigeben / teilweise freigeben / einbehalten
// ---------------------------------------------------------------------------

export function DepositSettleForm({ action, preview, bookingId, nonce, remainingCents, defaultWhen }: { action: Action; preview: (bookingId: string, releaseAmount: string) => Promise<SettlePreview | { error: string }>; bookingId: string; nonce: string; remainingCents: number; defaultWhen: string }) {
  const { state, formAction, pending, done } = useMoneyAction(action);
  const [mode, setMode] = useState<"RELEASE" | "PARTIAL" | "RETAIN" | null>(null);
  const [pv, setPv] = useState<SettlePreview | { error: string } | null>(null);
  const [checking, start] = useTransition();
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  if (done) return <Feedback state={state} />;
  if (!mode) {
    return (
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => setMode("RELEASE")}>Kaution vollständig freigeben</button>
        <button type="button" className="btn" onClick={() => setMode("PARTIAL")}>Kaution teilweise freigeben</button>
        <button type="button" className="btn" onClick={() => setMode("RETAIN")}>Kaution einbehalten</button>
      </div>
    );
  }
  const check = () => {
    if (!form || !form.reportValidity()) return;
    const fd = new FormData(form);
    start(async () => setPv(await preview(bookingId, String(fd.get("releaseAmount") ?? ""))));
  };
  const pvError = pv?.error ?? null;
  const full = pv && "remainingCents" in pv && !pv.error ? pv : null;
  const title = mode === "RELEASE" ? "Kaution vollständig freigeben" : mode === "PARTIAL" ? "Kaution teilweise freigeben" : "Kaution einbehalten";
  return (
    <form ref={setForm} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <input type="hidden" name="nonce" value={nonce} />
      <div className="font-medium">{title}</div>
      <div className="text-sm text-ink-2">Noch nicht zugeordnete Kaution: <span className="font-mono tnum font-semibold">{fmtCents(remainingCents)}</span></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {mode === "PARTIAL" ? (
          <label className="flex flex-col gap-1"><span className="label-xs">Freizugebender Betrag in €</span><input name="releaseAmount" inputMode="decimal" required className="input text-xl tnum" placeholder="0,00" onChange={() => setPv(null)} /></label>
        ) : (
          <input type="hidden" name="releaseAmount" value={mode === "RELEASE" ? eur(remainingCents) : "0"} />
        )}
        <label className="flex flex-col gap-1"><span className="label-xs">Datum und Uhrzeit</span><input name="occurredAt" type="datetime-local" defaultValue={defaultWhen} required className="input" /></label>
        {mode !== "RETAIN" && <label className="flex flex-col gap-1"><span className="label-xs">Geplanter Auszahlungsweg (optional)</span><select id="settle-method" name="method" defaultValue="" className="input"><option value="">noch offen</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
        {mode !== "RELEASE" && <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Grund für den einbehaltenen Betrag (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} className="input" placeholder="z. B. Prüfung eines bei Rückgabe festgestellten Schadens" /></label>}
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={500} className="input" /></label>
      </div>
      {mode !== "RELEASE" && <p role="note" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Der dokumentierte Einbehalt stellt keine automatische Schadenabrechnung oder Haftungsanerkennung dar. Er wird nicht mit Rechnungen oder Zusatzkosten verrechnet.</p>}
      {!full && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={checking} onClick={check}>{checking ? "Wird geprüft…" : "Weiter zur Bestätigung"}</button>
          <button type="button" className="btn" onClick={() => { setMode(null); setPv(null); }}>Abbrechen</button>
        </div>
      )}
      {pvError && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{pvError}</p>}
      {full && (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2">
          {full.kind === "RELEASE" && <><div className="text-sm font-medium">Freigeben</div><Big>{fmtCents(full.releaseCents)}</Big><div className="text-sm">der Kaution zur Rückzahlung freigeben? Die tatsächliche Auszahlung wird danach als eigener Vorgang erfasst.</div></>}
          {full.kind === "RETAIN" && <><div className="text-sm font-medium">Einbehalten</div><Big>{fmtCents(full.retainCents)}</Big><div className="text-sm">der Kaution als einbehalten dokumentieren?</div></>}
          {full.kind === "PARTIAL" && <><div className="text-sm font-medium">Teilweise freigeben</div><Big>{fmtCents(full.releaseCents)}</Big><div className="text-sm">der Kaution freigeben und <span className="font-mono tnum font-semibold">{fmtCents(full.retainCents)}</span> einbehalten?</div></>}
          <div className="text-xs text-ink-3">Status danach: {full.statusAfter === "RELEASED" ? "Freigegeben" : full.statusAfter === "RETAINED" ? "Einbehalten" : "Teilweise freigegeben"}. Freigabe ist die Entscheidung, nicht die Auszahlung: Der Geldfluss wird anschließend unter „Kautionsauszahlung“ dokumentiert; Rent-Base zahlt nichts selbst aus.</div>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird dokumentiert…" : "Ja, dokumentieren"}</button>
            <button type="button" className="btn" onClick={() => setPv(null)}>Zurück</button>
          </div>
        </div>
      )}
      <Feedback state={state} />
    </form>
  );
}

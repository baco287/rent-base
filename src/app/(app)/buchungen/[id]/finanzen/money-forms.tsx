"use client";

// Geldaktionen mit ausdrücklicher Bestätigung: erst Eingabe, dann Vorschau mit großem Betrag (vom Server gerechnet),
// dann Bestätigen. Jedes Formular trägt einen einmaligen Schlüssel; nach Erfolg ist es gesperrt (kein Doppelklick).

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { PAYMENT_METHODS } from "@/lib/constants";
import { fmtCents } from "@/lib/money";
import type { SettlePreview } from "@/lib/deposits";
import type { DepositOffsetPreview, OffsetInvoiceOption } from "@/lib/deposit-offset";
import type { OffsetReturnPreview } from "@/lib/deposit-offset-return";
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

/**
 * variant "link": dezenter Textlink mit Inline-Formular (Kautionsbewegungen).
 * variant "button" (Befehl 20.9, Zahlungen): klar erkennbare, destruktiv gekennzeichnete Aktion mit zwingendem
 * Bestätigungsdialog. Es wird nichts gelöscht – die bestehende Stornologik kennzeichnet den Eintrag als storniert.
 */
export function ReasonForm({ action, id, label, question, variant = "link", explanation, confirmLabel }: { action: Action; id: string; label: string; question: string; variant?: "link" | "button"; explanation?: string; confirmLabel?: string }) {
  const { state, formAction, pending, done } = useMoneyAction(action);
  const [open, setOpen] = useState(false);
  if (done) return <Feedback state={state} />;
  if (!open) {
    if (variant === "button") return <div><button type="button" className="btn !py-1.5 !text-bad !border-bad/40 hover:!bg-bad-soft" onClick={() => setOpen(true)}>{label}</button></div>;
    return <button type="button" className="text-xs underline text-ink-3 hover:text-bad" onClick={() => setOpen(true)}>{label}</button>;
  }
  const form = (
    <form onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-3 text-sm ${variant === "button" ? "" : "rounded-md bg-bad-soft/40 border border-bad/30 p-3"}`}>
      <input type="hidden" name="id" value={id} />
      <div className={variant === "button" ? "text-base font-semibold" : "font-medium"}>{question}</div>
      <p className="text-xs text-ink-2">{explanation ?? "Der Eintrag bleibt sichtbar und wird als storniert gekennzeichnet. Summen werden neu berechnet."}</p>
      <label className="flex flex-col gap-1"><span className="label-xs">Grund der Korrektur (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} className="input" placeholder="z. B. Betrag falsch eingegeben" autoFocus={variant === "button"} /></label>
      <div className="flex flex-wrap gap-2 justify-end">
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
        <button type="submit" disabled={pending} className="btn btn-danger">{pending ? "Wird storniert…" : confirmLabel ?? "Stornieren"}</button>
      </div>
      <Feedback state={state} />
    </form>
  );
  if (variant !== "button") return form;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !pending) setOpen(false); }}>
      <div role="dialog" aria-modal="true" aria-label={question} className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-panel border border-line shadow-xl p-4 sm:p-5">
        {form}
      </div>
    </div>
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
// Befehl 20.7: Kaution mit einer offenen Forderung verrechnen (kein Geldeingang, ausdrückliche Bestätigung)
// ---------------------------------------------------------------------------

export function DepositOffsetForm({ action, preview, bookingId, nonce, invoices, availableCents, defaultWhen, buttonLabel }: { action: Action; preview: (bookingId: string, invoiceId: string, amount: string) => Promise<DepositOffsetPreview | { error: string }>; bookingId: string; nonce: string; invoices: OffsetInvoiceOption[]; availableCents: number; defaultWhen: string; buttonLabel?: string }) {
  const { state, formAction, pending, done } = useMoneyAction(action);
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState(invoices[0]?.id ?? "");
  const [pv, setPv] = useState<DepositOffsetPreview | { error: string } | null>(null);
  const [checking, start] = useTransition();
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const invoice = invoices.find((i) => i.id === invoiceId) ?? invoices[0];
  const suggested = invoice ? Math.max(0, Math.min(invoice.openCents, availableCents)) : 0;
  const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  if (done) return <Feedback state={state} />;
  if (!open) return <div><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>{buttonLabel ?? "Aus Kaution verrechnen"}</button></div>;
  const check = () => {
    if (!form || !form.reportValidity()) return;
    const fd = new FormData(form);
    start(async () => setPv(await preview(bookingId, String(fd.get("invoiceId") ?? ""), String(fd.get("amount") ?? ""))));
  };
  const pvError = pv?.error ?? null;
  const full = pv && "availableCents" in pv && !pv.error ? pv : null;
  return (
    <form ref={setForm} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <input type="hidden" name="nonce" value={nonce} />
      <div className="font-medium">Offene Forderung aus der Kaution begleichen</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Forderung</span>
          <select name="invoiceId" value={invoiceId} onChange={(e) => { setInvoiceId(e.target.value); setPv(null); }} className="input" required>
            {invoices.map((i) => <option key={i.id} value={i.id}>{i.number} · offen {fmtCents(i.openCents)}{i.kind === "DAMAGE" ? " · Schadenabrechnung" : i.kind === "AUTHORITY_FEE" ? " · Bearbeitungsentgelt" : ""}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1"><span className="label-xs">Verrechnungsbetrag in €</span><input key={invoiceId} name="amount" inputMode="decimal" defaultValue={eur(suggested)} required className="input text-xl tnum" onChange={() => setPv(null)} /><span className="text-[11px] text-ink-3">Vorschlag: {fmtCents(suggested)} (höchstens offene Forderung und verfügbare Kaution). Teilbetrag möglich.</span></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Datum und Uhrzeit</span><input name="occurredAt" type="datetime-local" defaultValue={defaultWhen} required className="input" /></label>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={500} className="input" placeholder="z. B. Mehrkilometer laut Rückgabe" /></label>
      </div>
      <p className="text-xs text-ink-3">Bei der Verrechnung fließt kein Geld: Die bereits erhaltene Kaution deckt die Forderung. Sie erscheint in der Zahlungshistorie als „Kautionsverrechnung“ und in der Kautionshistorie als „Mit Forderung verrechnet“ – nie als Bar- oder Bankzahlung. Ein bloßer Einbehalt (ungeklärter Schaden) ist keine Verrechnung.</p>
      {!full && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={checking} onClick={check}>{checking ? "Wird geprüft…" : "Weiter zur Bestätigung"}</button>
          <button type="button" className="btn" onClick={() => { setOpen(false); setPv(null); }}>Abbrechen</button>
        </div>
      )}
      {pvError && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{pvError}</p>}
      {full && (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2">
          <div className="text-sm font-medium">Aus der Kaution verrechnen</div>
          <Big>{fmtCents(full.amountCents)}</Big>
          <div className="text-sm">mit der Forderung <span className="font-medium">{full.invoiceNumber}</span>?</div>
          <div className="text-sm flex flex-col gap-0.5 mt-1 border-t border-line-soft pt-2">
            <Row label="Offene Forderung" value={fmtCents(full.openCents)} />
            <Row label="Kaution tatsächlich erhalten" value={fmtCents(full.receivedCents)} />
            {full.releasedCents > 0 && <Row label="Davon zur Rückzahlung freigegeben" value={fmtCents(full.releasedCents)} />}
            {full.paidOutCents > 0 && <Row label="Davon bereits ausgezahlt" value={fmtCents(full.paidOutCents)} />}
            {full.retainedCents > 0 && <Row label="Davon einbehalten (ungeklärt)" value={fmtCents(full.retainedCents)} />}
            {full.offsetCents > 0 && <Row label="Davon bereits verrechnet" value={fmtCents(full.offsetCents)} />}
            <Row label="Tatsächlich verfügbare Kaution" value={fmtCents(full.availableCents)} />
            <Row label="Vorgeschlagener Verrechnungsbetrag" value={fmtCents(full.suggestedCents)} />
            <Row label="Verrechnung" value={fmtCents(full.amountCents)} strong />
            <Row label="Verbleibende Forderung" value={fmtCents(full.claimAfterCents)} strong />
            <Row label="Verbleibende Kaution" value={fmtCents(full.depositAfterCents)} strong />
          </div>
          <div className="text-xs text-ink-3">Danach: Rechnung {full.invoiceStatusAfter === "PAID" ? "vollständig ausgeglichen" : "teilweise ausgeglichen"}. Eine verbleibende Kaution wird wie bisher freigegeben und ausgezahlt.</div>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird verrechnet…" : "Ja, aus Kaution verrechnen"}</button>
            <button type="button" className="btn" onClick={() => setPv(null)}>Zurück</button>
          </div>
        </div>
      )}
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Befehl 22: Kundenguthaben zur Kaution zurückführen (ausdrückliche Bestätigung, Vorschau vom Server)
// ---------------------------------------------------------------------------

export function OffsetReturnForm({ action, preview, nonce, defaultWhen, maxCents }: { action: Action; preview: (amount: string) => Promise<OffsetReturnPreview | { error: string }>; nonce: string; defaultWhen: string; maxCents: number }) {
  const { state, formAction, pending, done } = useMoneyAction(action);
  const [open, setOpen] = useState(false);
  const [pv, setPv] = useState<OffsetReturnPreview | { error: string } | null>(null);
  const [checking, start] = useTransition();
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  if (done) return <Feedback state={state} />;
  if (!open) return <div><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Zur Kaution zurückführen</button></div>;
  const check = () => {
    if (!form || !form.reportValidity()) return;
    const fd = new FormData(form);
    start(async () => setPv(await preview(String(fd.get("amount") ?? ""))));
  };
  const full = pv && "maxCents" in pv && !pv.error ? pv : null;
  return (
    <form ref={setForm} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <input type="hidden" name="nonce" value={nonce} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Betrag in €</span><input name="amount" inputMode="decimal" defaultValue={eur(maxCents)} required className="input text-xl tnum" onChange={() => setPv(null)} /><span className="text-[11px] text-ink-3">höchstens {fmtCents(maxCents)} (verfügbares Guthaben und noch rückführbarer Teil der Verrechnung). Teilbetrag möglich.</span></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Datum und Uhrzeit</span><input name="occurredAt" type="datetime-local" defaultValue={defaultWhen} required className="input" /></label>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={500} className="input" /></label>
      </div>
      <p className="text-xs text-ink-3">Es fließt kein Geld: Der Betrag steht danach wieder als Kaution zur Verfügung und wird später mit der Kaution freigegeben oder einbehalten. Die ursprüngliche Verrechnung bleibt als Historie bestehen.</p>
      {!full && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={checking} onClick={check}>{checking ? "Wird geprüft…" : "Weiter zur Bestätigung"}</button>
          <button type="button" className="btn" onClick={() => { setOpen(false); setPv(null); }}>Abbrechen</button>
        </div>
      )}
      {pv?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{pv.error}</p>}
      {full && (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2">
          <div className="text-sm font-medium">Zur Kaution zurückführen</div>
          <Big>{fmtCents(full.amountCents)}</Big>
          <div className="text-sm flex flex-col gap-0.5 mt-1 border-t border-line-soft pt-2">
            <Row label="Verfügbares Guthaben" value={fmtCents(full.availableCreditCents)} />
            <Row label="Frühere Kautionsverrechnung" value={fmtCents(full.offsetCents)} />
            <Row label="Bereits zurückgeführt" value={fmtCents(full.offsetReturnedCents)} />
            <Row label="Maximal möglich" value={fmtCents(full.maxCents)} />
            <Row label="Guthaben danach" value={fmtCents(full.creditAfterCents)} strong />
            <Row label="Kaution verfügbar danach" value={`${fmtCents(full.depositAvailableBeforeCents)} → ${fmtCents(full.depositAvailableAfterCents)}`} strong />
          </div>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird gebucht…" : `${fmtCents(full.amountCents)} wieder der Kaution zuführen`}</button>
            <button type="button" className="btn" onClick={() => setPv(null)}>Zurück</button>
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

export function DepositSettleForm({ action, preview, bookingId, nonce, remainingCents, defaultWhen, releaseLabel }: { action: Action; preview: (bookingId: string, releaseAmount: string) => Promise<SettlePreview | { error: string }>; bookingId: string; nonce: string; remainingCents: number; defaultWhen: string; releaseLabel?: string }) {
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
        <button type="button" className="btn btn-primary" onClick={() => setMode("RELEASE")}>{releaseLabel ?? "Kaution vollständig freigeben"}</button>
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

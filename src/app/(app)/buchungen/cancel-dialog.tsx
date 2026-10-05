"use client";

// Befehl 28: Storno-Assistent (erweitert den Befehl-27-Dialog an derselben Stelle). Zeigt Buchung, Vertrag, Finanzen und
// Nachträge, verlangt den Grund und – nur wenn Geld an der Buchung hängt – bewusste Entscheidungen: optionale Stornogebühr
// (Steuer je Storno gewählt, nichts vorausgewählt), Erstattung der Vorauszahlung oder Kundenguthaben, Kaution freigeben oder
// vorerst behalten. Die Abrechnung rechnet der Server (Vorschau); der Abschluss wiederholt alles unter Sperren in einer Transaktion.

import { useActionState, useRef, useState } from "react";
import { FormError } from "@/components/ui";
import type { CancelState, CancellationPreviewResult } from "./actions";

export type CancellationAssistantView = {
  booking: { number: string; statusLabel: string; customerName: string; vehicle: string; plate: string; start: string; end: string };
  contract: { state: "NONE" | "DRAFT" | "SIGNED" | "CANCELLED"; number: string | null };
  finances: {
    agreed: string; agreedSource: string; prepaidCents: number; prepaid: string;
    invoices: { label: string; gross: string; open: string; credit: string }[];
    openReceivable: string; customerCredit: string;
    deposit: { expected: string; received: string; released: string; retained: string; offset: string; remaining: string; remainingCents: number } | null;
  };
  amendments: { drafts: number; agreed: number; signed: number };
  blockers: string[];
  warnings: string[];
  needs: { refund: boolean; deposit: boolean };
  fee: { available: boolean; blockedReason: string | null; pricesIncludeTax: boolean; standardRate: string };
  taxTreatments: { key: string; label: string }[];
  payoutMethods: { key: string; label: string }[];
  idempotencyKey: string;
  defaultWhen: string;
};

const CONTRACT_LABEL = { NONE: "kein Mietvertrag", DRAFT: "Vertragsentwurf (wird verworfen)", SIGNED: "unterschriebener Mietvertrag (bleibt unverändert archiviert)", CANCELLED: "Mietvertrag storniert" } as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="flex flex-col gap-2"><h3 className="label-xs">{title}</h3>{children}</section>;
}
function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return <div className="flex justify-between gap-3 py-1 border-b border-line-soft last:border-0"><span className="text-ink-2">{label}</span><span className={`font-mono tnum text-right ${strong ? "font-semibold" : ""}`}>{value}</span></div>;
}
function Radio({ name, value, label, hint, checked, onChange }: { name: string; value: string; label: string; hint?: string; checked: boolean; onChange: (v: string) => void }) {
  return (
    <label className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer ${checked ? "border-brand bg-panel" : "border-line-soft bg-panel-2/40"}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className="mt-0.5 h-5 w-5 shrink-0" />
      <span className="flex flex-col"><span className="font-medium">{label}</span>{hint && <span className="text-xs text-ink-3">{hint}</span>}</span>
    </label>
  );
}

function PayoutFields({ prefix, methods, defaultWhen, amountLabel, confirmLabel }: { prefix: string; methods: { key: string; label: string }[]; defaultWhen: string; amountLabel: string; confirmLabel: string }) {
  const [method, setMethod] = useState("");
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-0 sm:pl-8">
      <label className="flex flex-col gap-1"><span className="label-xs">{amountLabel}</span><input name={`${prefix}Amount`} inputMode="decimal" placeholder="0,00" className="input tnum" /></label>
      <label className="flex flex-col gap-1"><span className="label-xs">Auszahlungsweg</span>
        <select name={`${prefix}Method`} value={method} onChange={(e) => setMethod(e.target.value)} required className="input">
          <option value="" disabled>bitte wählen</option>
          {methods.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1"><span className="label-xs">Ausgezahlt am</span><input name={`${prefix}When`} type="datetime-local" defaultValue={defaultWhen} className="input tnum" /></label>
      {method === "BANK_TRANSFER" && <label className="flex flex-col gap-1"><span className="label-xs">IBAN des Empfängers</span><input name={`${prefix}Iban`} autoComplete="off" className="input font-mono" placeholder="DE…" /></label>}
      {method === "CARD" && <label className="flex flex-col gap-1"><span className="label-xs">Transaktions-/Belegreferenz</span><input name={`${prefix}Reference`} maxLength={140} className="input" /></label>}
      {method === "OTHER" && <label className="flex flex-col gap-1"><span className="label-xs">Welcher Weg?</span><input name={`${prefix}MethodDescription`} maxLength={200} className="input" /></label>}
      <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz für den Beleg (optional)</span><input name={`${prefix}Note`} maxLength={1000} className="input" /></label>
      <label className="flex items-start gap-2 sm:col-span-2 text-sm"><input type="checkbox" name={`${prefix}Confirmed`} value="1" className="mt-0.5 h-5 w-5 shrink-0" required /><span>{confirmLabel}</span></label>
    </div>
  );
}

export function CancelBookingDialog({ action, preview, view }: { action: (prev: CancelState, fd: FormData) => Promise<CancelState>; preview: (fd: FormData) => Promise<CancellationPreviewResult>; view: CancellationAssistantView }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, undefined);
  const [reason, setReason] = useState("");
  const [fee, setFee] = useState(false);
  const [refundMode, setRefundMode] = useState("");
  const [depositMode, setDepositMode] = useState("");
  const [depositPayout, setDepositPayout] = useState(false);
  const [result, setResult] = useState<CancellationPreviewResult | null>(null);
  const [checking, setChecking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const v = view;
  const blocked = v.blockers.length > 0;

  async function check() {
    if (!formRef.current) return;
    setChecking(true);
    try { setResult(await preview(new FormData(formRef.current))); } finally { setChecking(false); }
  }

  if (!open) return <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>Stornieren…</button>;
  const ready = !!result && result.errors.length === 0 && reason.trim().length >= 3;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cancel-title" className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onKeyDown={(e) => { if (e.key === "Escape" && !pending) setOpen(false); }}>
      <div className="w-full sm:max-w-2xl max-h-[94vh] overflow-y-auto rounded-t-xl sm:rounded-xl bg-panel shadow-xl p-4 sm:p-5 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <h2 id="cancel-title" className="text-lg font-semibold">Buchung {v.booking.number} stornieren</h2>
          <button type="button" className="btn !py-1.5" onClick={() => setOpen(false)} disabled={pending}>Schließen</button>
        </div>

        <Section title="Buchung">
          <dl className="grid grid-cols-[minmax(96px,32%)_1fr] gap-x-3 gap-y-1 text-sm rounded-md bg-panel-2 p-3">
            <dt className="text-ink-3">Buchung</dt><dd className="font-mono tnum">{v.booking.number} · {v.booking.statusLabel}</dd>
            <dt className="text-ink-3">Kunde</dt><dd>{v.booking.customerName}</dd>
            <dt className="text-ink-3">Fahrzeug</dt><dd>{v.booking.vehicle} · <span className="font-mono">{v.booking.plate}</span></dd>
            <dt className="text-ink-3">Mietbeginn</dt><dd className="font-mono tnum">{v.booking.start}</dd>
            <dt className="text-ink-3">Mietende</dt><dd className="font-mono tnum">{v.booking.end}</dd>
            <dt className="text-ink-3">Vertrag</dt><dd>{CONTRACT_LABEL[v.contract.state]}{v.contract.number ? ` · ${v.contract.number}` : ""}</dd>
            {v.amendments.drafts + v.amendments.agreed + v.amendments.signed > 0 && <><dt className="text-ink-3">Nachträge</dt><dd>{v.amendments.signed} wirksam{v.amendments.agreed ? ` · ${v.amendments.agreed} vereinbart (Unterschrift ausstehend)` : ""}{v.amendments.drafts ? ` · ${v.amendments.drafts} Entwurf` : ""}</dd></>}
          </dl>
        </Section>

        <Section title="Finanzen">
          <div className="rounded-md bg-panel-2 p-3 text-sm">
            <Row label={v.finances.agreedSource === "CONTRACT" ? "Vereinbarter Mietpreis (Vertrag)" : v.finances.agreedSource === "ACCIDENT" ? "Mietpreis" : "Voraussichtlicher Mietpreis"} value={v.finances.agreedSource === "ACCIDENT" ? "kein Mietpreis im Voraus (Unfallersatz, nicht übergeben)" : v.finances.agreed} />
            <Row label="Bereits geleistete Mietzahlungen" value={v.finances.prepaid} strong={v.finances.prepaidCents > 0} />
            {v.finances.invoices.map((i) => <Row key={i.label} label={i.label} value={`${i.gross} · offen ${i.open}`} />)}
            {v.finances.invoices.length > 0 && <Row label="Offene Forderung" value={v.finances.openReceivable} />}
            {v.finances.invoices.length > 0 && <Row label="Bestehendes Kundenguthaben" value={v.finances.customerCredit} />}
            {v.finances.deposit ? (
              <>
                <Row label="Vereinbarte Kaution" value={v.finances.deposit.expected} />
                <Row label="Erhaltene Kaution" value={v.finances.deposit.received} strong />
                <Row label="Freigegeben / einbehalten / verrechnet" value={`${v.finances.deposit.released} / ${v.finances.deposit.retained} / ${v.finances.deposit.offset}`} />
                <Row label="Noch nicht zugeordnet" value={v.finances.deposit.remaining} />
              </>
            ) : <Row label="Kaution" value="keine erhalten" />}
          </div>
        </Section>

        {blocked && (
          <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm flex flex-col gap-1.5">
            <div className="font-semibold">Storno nicht möglich</div>
            {v.blockers.map((b) => <p key={b}>{b}</p>)}
          </div>
        )}
        {v.warnings.length > 0 && (
          <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm flex flex-col gap-1.5">
            <div className="font-semibold">Bitte beachten</div>
            {v.warnings.map((w) => <p key={w}>{w}</p>)}
          </div>
        )}

        {!blocked && (
          <form ref={formRef} action={formAction} onChange={() => setResult(null)} className="flex flex-col gap-4">
            <input type="hidden" name="key" value={v.idempotencyKey} />
            <label className="flex flex-col gap-1">
              <span className="label-xs">Grund der Stornierung (Pflicht)</span>
              <textarea name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} rows={2} className="input" placeholder="z. B. Kunde hat telefonisch abgesagt" />
            </label>

            <Section title="Stornogebühr (optional)">
              {v.fee.available ? (
                <>
                  <label className="flex items-center gap-3 cursor-pointer select-none"><input type="checkbox" name="feeEnabled" value="1" checked={fee} onChange={(e) => setFee(e.target.checked)} className="h-5 w-5" /><span className="font-medium">Stornogebühr berechnen</span></label>
                  {fee && (
                    <div className="flex flex-col gap-3 pl-0 sm:pl-8">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1"><span className="label-xs">Betrag ({v.fee.pricesIncludeTax ? "brutto" : "netto"})</span><input name="feeAmount" inputMode="decimal" required placeholder="0,00" className="input tnum" /></label>
                        <label className="flex flex-col gap-1"><span className="label-xs">Beschreibung</span><input name="feeDescription" required maxLength={300} defaultValue="Stornogebühr laut Mietbedingungen" className="input" /></label>
                      </div>
                      <fieldset className="flex flex-col gap-2">
                        <legend className="label-xs mb-1">Steuerliche Behandlung (bitte bewusst wählen)</legend>
                        {v.taxTreatments.map((t) => <label key={t.key} className="flex items-start gap-2 text-sm"><input type="radio" name="feeTaxTreatment" value={t.key} required className="mt-0.5 h-5 w-5 shrink-0" /><span>{t.label}{t.key === "TAXABLE_SUPPLY" ? ` – ${v.fee.standardRate}` : ""}</span></label>)}
                        <span className="text-xs text-ink-3">Die Einordnung trifft der Vermieter (ggf. mit Steuerberatung). Die Gebühr wird eine eigene Rechnung; der ursprüngliche Mietpreis bleibt unverändert.</span>
                      </fieldset>
                    </div>
                  )}
                </>
              ) : <p className="text-sm text-ink-3">{v.fee.blockedReason}</p>}
            </Section>

            {v.needs.refund && (
              <Section title={`Mietvorauszahlung (${v.finances.prepaid})`}>
                <Radio name="refundMode" value="PAYOUT" label="Erstattung als Auszahlung erfassen" hint="Die Auszahlung wurde bereits durchgeführt (Überweisung, bar, Karte). RentBase dokumentiert sie; es wird kein Geld bewegt." checked={refundMode === "PAYOUT"} onChange={setRefundMode} />
                {refundMode === "PAYOUT" && <PayoutFields prefix="refund" methods={v.payoutMethods} defaultWhen={v.defaultWhen} amountLabel="Erstattungsbetrag (leer = gesamter Rest)" confirmLabel="Die Erstattung ist tatsächlich ausgezahlt worden." />}
                <Radio name="refundMode" value="CREDIT" label="Als Kundenguthaben stehen lassen" hint="Das Guthaben erscheint in der Kundenakte und kann später ausgezahlt werden. Es wird nicht automatisch verrechnet." checked={refundMode === "CREDIT"} onChange={setRefundMode} />
              </Section>
            )}

            {v.needs.deposit && v.finances.deposit && (
              <Section title={`Kaution (${v.finances.deposit.remaining} erhalten, nicht zugeordnet)`}>
                <Radio name="depositMode" value="RELEASE" label="Vollständig freigeben" hint="Die Kaution wird freigegeben und ist rückzahlbar. Sie wird nicht mit einer Stornogebühr verrechnet." checked={depositMode === "RELEASE"} onChange={setDepositMode} />
                {depositMode === "RELEASE" && (
                  <div className="flex flex-col gap-3 pl-0 sm:pl-8">
                    <label className="flex items-center gap-3 cursor-pointer select-none text-sm"><input type="checkbox" name="depositPayout" value="1" checked={depositPayout} onChange={(e) => setDepositPayout(e.target.checked)} className="h-5 w-5" /><span>Rückzahlung jetzt als erfolgt dokumentieren</span></label>
                    {depositPayout && <PayoutFields prefix="depositPayout" methods={v.payoutMethods} defaultWhen={v.defaultWhen} amountLabel="Rückzahlungsbetrag (leer = gesamte Kaution)" confirmLabel="Die Kaution ist tatsächlich zurückgezahlt worden." />}
                  </div>
                )}
                <Radio name="depositMode" value="KEEP" label="Vorerst behalten" hint="Bleibt als erhaltene Kaution stehen und erscheint als offene Aufgabe. Freigabe, Auszahlung oder eine bewusste Verrechnung mit einer Stornorechnung später im Bereich „Kaution“." checked={depositMode === "KEEP"} onChange={setDepositMode} />
              </Section>
            )}

            <div className="flex flex-col gap-2">
              <button type="button" className="btn justify-center" onClick={check} disabled={checking || pending}>{checking ? "Wird geprüft…" : "Storno-Abrechnung prüfen"}</button>
              {result && result.errors.length > 0 && (
                <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm flex flex-col gap-1">{result.errors.map((e) => <p key={e}>{e}</p>)}</div>
              )}
              {result && result.errors.length === 0 && (
                <div className="rounded-md border-2 border-brand bg-panel p-3 text-sm">
                  <div className="label-xs mb-1">Storno-Abrechnung</div>
                  {result.lines.map((l) => <Row key={l.label} label={l.label} value={l.value} strong={l.bold} />)}
                </div>
              )}
            </div>

            <FormError error={state?.error} />
            <p className="text-xs text-ink-3">Das Storno kann nicht rückgängig gemacht werden. Grund, Zeitpunkt, Benutzer und Abrechnung werden dauerhaft dokumentiert. Zahlungen, Rechnungen und Verträge werden nicht gelöscht.</p>
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button type="button" className="btn justify-center" onClick={() => setOpen(false)} disabled={pending}>Abbrechen</button>
              <button type="submit" className="btn btn-danger justify-center" disabled={pending || !ready}>{pending ? "Wird storniert…" : "Buchung verbindlich stornieren"}</button>
            </div>
            {!ready && <p className="text-xs text-ink-3 sm:text-right">Zum Abschließen: Grund eintragen und „Storno-Abrechnung prüfen“.</p>}
          </form>
        )}
        {blocked && <div className="flex justify-end"><button type="button" className="btn" onClick={() => setOpen(false)}>Schließen</button></div>}
      </div>
    </div>
  );
}

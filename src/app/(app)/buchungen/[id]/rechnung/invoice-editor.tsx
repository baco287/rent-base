"use client";

// Entwurf einer Rechnungsfassung bearbeiten. Zeigt die vom Server gerechneten Beträge; beim Speichern gehen nur
// Eingaben zum Server, der rechnet neu. Nichts hier ist eine Betragsquelle. Fassung >= 2 startet aus dem Snapshot der
// Vorfassung: Empfänger, Anschrift, Leistungszeitraum und Rechnungsstellerdaten sind bewusst änderbare Kopien.

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { INVOICE_UNITS } from "@/lib/constants";
import type { InvoiceDocumentData } from "@/lib/invoice-view";
import type { InvoiceState } from "./actions";

export type EditableItem = { id: string; description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; source: string; sourceLabel: string; net: string; tax: string; gross: string };
export type EditableCustomer = { type: string; companyName: string; firstName: string; lastName: string; street: string; zip: string; city: string; country: string; email: string; number: string };
export type EditableCompany = { name: string; legalForm: string; street: string; zip: string; city: string; country: string; email: string; phone: string; vatId: string; taxNumber: string; bankName: string; iban: string; bic: string; invoiceFooter: string };
export type EditableDraft = { customerNote: string; taxNote: string; notes: string; paymentTermDays: number | null; reason: string; servicePeriodStart: string; servicePeriodEnd: string; customer: EditableCustomer; company: EditableCompany };

type Props = {
  /** Stand des Entwurfs auf dem Server; ändert er sich (nach dem Speichern), werden die Felder neu befüllt */
  version: number;
  versionNo: number;
  /** Fassungsart des Entwurfs; bei CORRECTION ist der Grund Pflicht */
  kind: "ORIGINAL" | "REVISION" | "CORRECTION";
  doc: InvoiceDocumentData;
  items: EditableItem[];
  allowedRates: number[];
  draft: EditableDraft;
  blocking: boolean;
  blockingReason?: string;
  /** Vorschau der Zahlungsdifferenz (Fassung >= 2 mit Zahlungen), vom Server gerechnet */
  paymentPreview: { paid: string; grossBefore: string; grossAfter: string; openAfter: string; overpaid: string | null } | null;
  save: (payload: unknown) => Promise<InvoiceState>;
  finalize: (prev: InvoiceState, fd: FormData) => Promise<InvoiceState>;
};

/**
 * Nach dem Speichern liefert der Server die neu gerechneten Beträge. Der Editor wird dann über den Schlüssel (version)
 * neu aufgebaut, damit alle Felder den gespeicherten Stand zeigen; die Rückmeldung bleibt außerhalb erhalten.
 */
export function InvoiceEditor(props: Props) {
  const [message, setMessage] = useState<InvoiceState>(undefined);
  const [dirty, setDirty] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <EditorBody key={props.version} {...props} onSaved={setMessage} onDirty={setDirty} />
      {message?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{message.error}</p>}
      {message?.ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{message.ok}</p>}
      <FinalizeCard {...props} blocking={props.blocking || dirty} blockingReason={dirty ? "Bitte zuerst den Entwurf speichern." : props.blockingReason} />
    </div>
  );
}

function FinalizeCard({ finalize, blocking, blockingReason, versionNo, kind, paymentPreview }: Props) {
  const [state, formAction, pending] = useActionState(finalize, undefined);
  const [clicked, setClicked] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const overpaid = !!paymentPreview?.overpaid;
  const locked = blocking || pending || (clicked && !state?.error) || (overpaid && !confirmed);
  return (
    <form onSubmit={(e) => { setClicked(true); submitWithoutReset(formAction)(e); }} className="card p-4 flex flex-col gap-3">
      {versionNo === 1 ? (
        <p className="text-sm text-ink-2">Mit dem Abschluss vergibt das System die Rechnungsnummer, friert Empfänger, Firmendaten und Beträge ein, erzeugt das PDF und sendet es an den Rechnungsempfänger. Danach ist die Fassung unveränderlich; Korrekturen erzeugen eine neue Fassung.</p>
      ) : (
        <p className="text-sm text-ink-2">Mit dem Abschluss entsteht Fassung {versionNo} unter derselben Rechnungsnummer{kind === "CORRECTION" ? " als berichtigte Rechnung" : ""}. Die bisherige Fassung bleibt archiviert und einsehbar. Das PDF der neuen Fassung wird erzeugt und an den Rechnungsempfänger gesendet.</p>
      )}
      {paymentPreview && (
        <div className="rounded-md border border-line-soft p-3 text-sm flex flex-col gap-1">
          <div className="label-xs">Zahlungen zu dieser Rechnung</div>
          <div className="flex justify-between"><span className="text-ink-3">Bisheriger Rechnungsbetrag</span><span className="font-mono tnum">{paymentPreview.grossBefore}</span></div>
          <div className="flex justify-between"><span className="text-ink-3">Neuer Rechnungsbetrag</span><span className="font-mono tnum">{paymentPreview.grossAfter}</span></div>
          <div className="flex justify-between"><span className="text-ink-3">Bezahlt</span><span className="font-mono tnum">{paymentPreview.paid}</span></div>
          {paymentPreview.overpaid ? (
            <div className="flex justify-between font-semibold text-bad"><span>Überzahlung / Erstattungsbedarf</span><span className="font-mono tnum">{paymentPreview.overpaid}</span></div>
          ) : (
            <div className="flex justify-between font-semibold"><span>Danach offen</span><span className="font-mono tnum">{paymentPreview.openAfter}</span></div>
          )}
        </div>
      )}
      {overpaid && (
        <label className="flex items-start gap-2 rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">
          <input type="checkbox" name="confirmOverpayment" value="1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
          <span>Für diese Rechnung wurden bereits {paymentPreview!.paid} Zahlungen dokumentiert. Der neue Rechnungsbetrag beträgt {paymentPreview!.grossAfter}. Dadurch entsteht eine Überzahlung von {paymentPreview!.overpaid}. Rent-Base führt keine automatische Erstattung durch. Ich bestätige das ausdrücklich.</span>
        </label>
      )}
      {state?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>}
      <button type="submit" disabled={locked} className="btn btn-primary justify-center !py-3 !text-[15px]">
        {pending || (clicked && !state?.error) ? "Rechnung wird abgeschlossen…" : versionNo === 1 ? "Rechnung finalisieren" : `Fassung ${versionNo} finalisieren`}
      </button>
      {blocking && blockingReason && <p className="text-xs text-ink-3">{blockingReason}</p>}
    </form>
  );
}

const Field = ({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) => (
  <label className={`flex flex-col gap-1 ${className}`}><span className="label-xs">{label}</span>{children}</label>
);

function EditorBody({ doc, items: initial, allowedRates, draft, kind, versionNo, save, onSaved, onDirty }: Props & { onSaved: (s: InvoiceState) => void; onDirty: (d: boolean) => void }) {
  const router = useRouter();
  const [items, setItems] = useState(initial.map((i) => ({ ...i })));
  const [customerNote, setCustomerNote] = useState(draft.customerNote);
  const [taxNote, setTaxNote] = useState(draft.taxNote);
  const [notes, setNotes] = useState(draft.notes);
  const [reason, setReason] = useState(draft.reason);
  const [paymentTermDays, setPaymentTermDays] = useState(draft.paymentTermDays == null ? "" : String(draft.paymentTermDays));
  const [period, setPeriod] = useState({ start: draft.servicePeriodStart, end: draft.servicePeriodEnd });
  const [customer, setCustomer] = useState(draft.customer);
  const [company, setCompany] = useState(draft.company);
  const [showCompany, setShowCompany] = useState(false);
  const [pending, start] = useTransition();
  const [dirty, setDirtyState] = useState(false);
  const setDirty = (d: boolean) => { setDirtyState(d); onDirty(d); };
  const rateOptions = allowedRates.map((r) => r.toLocaleString("de-DE", { minimumFractionDigits: 2 }));

  const update = (idx: number, patch: Partial<EditableItem>) => { setItems((xs) => xs.map((x, i) => (i === idx ? { ...x, ...patch } : x))); setDirty(true); };
  const remove = (idx: number) => { setItems((xs) => xs.filter((_, i) => i !== idx)); setDirty(true); };
  const add = () => { setItems((xs) => [...xs, { id: "", description: "", quantity: "1", unit: "pauschal", unitPrice: "", taxRate: rateOptions[0] ?? "0,00", source: "MANUAL", sourceLabel: "Manuell erfasst", net: "–", tax: "–", gross: "–" }]); setDirty(true); };
  const cust = (patch: Partial<EditableCustomer>) => { setCustomer((c) => ({ ...c, ...patch })); setDirty(true); };
  const comp = (patch: Partial<EditableCompany>) => { setCompany((c) => ({ ...c, ...patch })); setDirty(true); };
  const submit = () => {
    onSaved(undefined);
    start(async () => {
      const res = await save({
        items: items.map((i) => ({ id: i.id || undefined, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, taxRate: i.taxRate.replace(" %", "") })),
        customerNote, taxNote, notes, reason, paymentTermDays,
        servicePeriodStart: period.start, servicePeriodEnd: period.end,
        customer, company,
      });
      onSaved(res);
      if (!res?.error) {
        setDirty(false);
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {versionNo > 1 && (
        <div className="card p-4 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="label-xs">{kind === "CORRECTION" ? "Grund der Berichtigung (Pflicht, erscheint auf der berichtigten Rechnung)" : "Änderungsgrund (optional)"}</span>
            <input value={reason} onChange={(e) => { setReason(e.target.value); setDirty(true); }} maxLength={500} className="input" placeholder={kind === "CORRECTION" ? "z. B. Anschrift des Rechnungsempfängers korrigiert" : "z. B. Tippfehler in der Positionsbeschreibung"} />
          </label>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <div className="card p-4 flex flex-col gap-3">
          <div className="font-semibold text-sm">Rechnungsempfänger</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Art"><select value={customer.type} onChange={(e) => cust({ type: e.target.value })} className="input"><option value="PRIVATE">Privatkunde</option><option value="COMPANY">Firmenkunde</option></select></Field>
            <Field label="Kundennummer"><input value={customer.number} onChange={(e) => cust({ number: e.target.value })} className="input" /></Field>
            {customer.type === "COMPANY" && <Field label="Firma" className="sm:col-span-2"><input value={customer.companyName} onChange={(e) => cust({ companyName: e.target.value })} className="input" /></Field>}
            <Field label="Vorname"><input value={customer.firstName} onChange={(e) => cust({ firstName: e.target.value })} className="input" /></Field>
            <Field label="Nachname"><input value={customer.lastName} onChange={(e) => cust({ lastName: e.target.value })} className="input" /></Field>
            <Field label="Straße und Hausnummer" className="sm:col-span-2"><input value={customer.street} onChange={(e) => cust({ street: e.target.value })} className="input" /></Field>
            <Field label="PLZ"><input value={customer.zip} onChange={(e) => cust({ zip: e.target.value })} className="input" /></Field>
            <Field label="Ort"><input value={customer.city} onChange={(e) => cust({ city: e.target.value })} className="input" /></Field>
            <Field label="Land"><input value={customer.country} onChange={(e) => cust({ country: e.target.value })} className="input" maxLength={2} /></Field>
            <Field label="E-Mail (Rechnungsversand)"><input value={customer.email} onChange={(e) => cust({ email: e.target.value })} className="input" type="email" /></Field>
          </div>
          <p className="text-[11px] text-ink-3">Kopie {versionNo > 1 ? `aus Fassung ${versionNo - 1}` : "aus dem Mietvertrag"}. Änderungen hier wirken nur auf diese Rechnung, nicht auf den Kunden.</p>
        </div>
        <div className="flex flex-col gap-4">
          <div className="card p-4 flex flex-col gap-3">
            <div className="font-semibold text-sm">Leistungszeitraum</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Beginn"><input type="datetime-local" value={period.start} onChange={(e) => { setPeriod((p) => ({ ...p, start: e.target.value })); setDirty(true); }} className="input" /></Field>
              <Field label="Ende"><input type="datetime-local" value={period.end} onChange={(e) => { setPeriod((p) => ({ ...p, end: e.target.value })); setDirty(true); }} className="input" /></Field>
            </div>
          </div>
          <div className="card p-4 flex flex-col gap-2">
            <button type="button" className="text-left font-semibold text-sm flex items-center justify-between" onClick={() => setShowCompany((s) => !s)} aria-expanded={showCompany}>
              <span>Rechnungssteller {versionNo === 1 ? "(wird beim Abschluss aus den Einstellungen übernommen)" : "(Kopie, bewusst korrigierbar)"}</span><span className="text-ink-3 text-xs">{showCompany ? "einklappen" : "bearbeiten"}</span>
            </button>
            {!showCompany && <div className="text-sm text-ink-2">{doc.company.fullName} · {doc.company.addressLines.join(", ")}{doc.company.taxLine ? ` · ${doc.company.taxLine}` : ""}</div>}
            {showCompany && versionNo === 1 && <p className="text-xs text-ink-3">Fassung 1 friert beim Abschluss die aktuellen Einstellungen ein. Änderungen bitte in den Einstellungen vornehmen.</p>}
            {showCompany && versionNo > 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Unternehmen"><input value={company.name} onChange={(e) => comp({ name: e.target.value })} className="input" /></Field>
                <Field label="Rechtsform"><input value={company.legalForm} onChange={(e) => comp({ legalForm: e.target.value })} className="input" /></Field>
                <Field label="Straße und Hausnummer" className="sm:col-span-2"><input value={company.street} onChange={(e) => comp({ street: e.target.value })} className="input" /></Field>
                <Field label="PLZ"><input value={company.zip} onChange={(e) => comp({ zip: e.target.value })} className="input" /></Field>
                <Field label="Ort"><input value={company.city} onChange={(e) => comp({ city: e.target.value })} className="input" /></Field>
                <Field label="USt-IdNr."><input value={company.vatId} onChange={(e) => comp({ vatId: e.target.value })} className="input" /></Field>
                <Field label="Steuernummer"><input value={company.taxNumber} onChange={(e) => comp({ taxNumber: e.target.value })} className="input" /></Field>
                <Field label="Bank"><input value={company.bankName} onChange={(e) => comp({ bankName: e.target.value })} className="input" /></Field>
                <Field label="IBAN"><input value={company.iban} onChange={(e) => comp({ iban: e.target.value })} className="input" /></Field>
                <Field label="BIC"><input value={company.bic} onChange={(e) => comp({ bic: e.target.value })} className="input" /></Field>
                <Field label="E-Mail"><input value={company.email} onChange={(e) => comp({ email: e.target.value })} className="input" /></Field>
                <Field label="Telefon"><input value={company.phone} onChange={(e) => comp({ phone: e.target.value })} className="input" /></Field>
                <Field label="Fußtext" className="sm:col-span-2"><textarea value={company.invoiceFooter} onChange={(e) => comp({ invoiceFooter: e.target.value })} rows={2} className="input" /></Field>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2"><span className="font-semibold text-sm">Positionen</span><span className="text-xs text-ink-3">{doc.pricesIncludeTax ? "Einzelpreise sind Bruttobeträge, die Steuer wird herausgerechnet" : "Einzelpreise sind Nettobeträge, die Steuer kommt hinzu"}</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead><tr className="text-left text-xs text-ink-3 border-b border-line-soft"><th className="px-3 py-2 font-medium">Beschreibung</th><th className="px-2 py-2 font-medium w-20">Menge</th><th className="px-2 py-2 font-medium w-24">Einheit</th><th className="px-2 py-2 font-medium w-28 text-right">{doc.pricesIncludeTax ? "Einzelpreis brutto" : "Einzelpreis netto"}</th><th className="px-2 py-2 font-medium w-24">Steuer</th><th className="px-2 py-2 font-medium text-right">Netto</th><th className="px-2 py-2 font-medium text-right">Steuer</th><th className="px-2 py-2 font-medium text-right">Brutto</th><th className="w-10" /></tr></thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={it.id || `new-${idx}`} className="border-b border-line-soft align-top">
                  <td className="px-3 py-2">
                    <textarea value={it.description} onChange={(e) => update(idx, { description: e.target.value })} rows={2} className="input !py-1.5 text-sm" aria-label={`Beschreibung Position ${idx + 1}`} />
                    <div className="text-[11px] text-ink-3 mt-0.5">{it.sourceLabel}</div>
                  </td>
                  <td className="px-2 py-2"><input value={it.quantity} onChange={(e) => update(idx, { quantity: e.target.value })} inputMode="decimal" className="input !py-1.5 tnum" aria-label={`Menge Position ${idx + 1}`} /></td>
                  <td className="px-2 py-2"><select value={it.unit} onChange={(e) => update(idx, { unit: e.target.value })} className="input !py-1.5" aria-label={`Einheit Position ${idx + 1}`}>{INVOICE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select></td>
                  <td className="px-2 py-2"><input value={it.unitPrice} onChange={(e) => update(idx, { unitPrice: e.target.value })} inputMode="decimal" className="input !py-1.5 tnum text-right" aria-label={`Einzelpreis Position ${idx + 1}`} /></td>
                  <td className="px-2 py-2"><select value={it.taxRate} onChange={(e) => update(idx, { taxRate: e.target.value })} className="input !py-1.5" aria-label={`Steuersatz Position ${idx + 1}`}>{[...new Set([...rateOptions, it.taxRate])].map((r) => <option key={r} value={r}>{r} %</option>)}</select></td>
                  <td className="px-2 py-2 text-right font-mono tnum">{it.net}</td>
                  <td className="px-2 py-2 text-right font-mono tnum">{it.tax}</td>
                  <td className="px-2 py-2 text-right font-mono tnum font-semibold">{it.gross}</td>
                  <td className="px-2 py-2"><button type="button" onClick={() => remove(idx)} className="text-bad text-xs underline" aria-label={`Position ${idx + 1} entfernen`}>entfernen</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 flex flex-wrap items-center gap-3 border-t border-line-soft">
          <button type="button" className="btn" onClick={add}>Position hinzufügen</button>
          {dirty && <span className="text-xs text-amber">Beträge werden beim Speichern vom Server neu berechnet.</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <div className="card p-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1"><span className="label-xs">Zahlungsziel in Tagen (leer = keins)</span><input value={paymentTermDays} onChange={(e) => { setPaymentTermDays(e.target.value); setDirty(true); }} type="number" min={0} max={365} className="input tnum max-w-[10rem]" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Text auf der Rechnung (optional)</span><textarea value={customerNote} onChange={(e) => { setCustomerNote(e.target.value); setDirty(true); }} rows={2} className="input" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Steuerhinweis (erscheint bei Positionen mit 0 %)</span><input value={taxNote} onChange={(e) => { setTaxNote(e.target.value); setDirty(true); }} className="input" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Interne Notiz (nicht auf der Rechnung)</span><textarea value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={2} className="input" /></label>
        </div>
        <div className="card p-4 flex flex-col gap-2 text-sm">
          <div className="font-semibold">Steuerzusammenfassung</div>
          {doc.taxSummary.map((t) => <div key={t.rate} className="flex justify-between"><span className="text-ink-3">{t.rate} auf {t.net}</span><span className="font-mono tnum">{t.tax}</span></div>)}
          <div className="flex justify-between border-t border-line-soft pt-2"><span className="text-ink-3">Netto</span><span className="font-mono tnum">{doc.totals.net}</span></div>
          <div className="flex justify-between"><span className="text-ink-3">Steuer</span><span className="font-mono tnum">{doc.totals.tax}</span></div>
          <div className="flex justify-between text-base font-semibold border-t-2 border-ink pt-2"><span>Gesamt</span><span className="font-mono tnum">{doc.totals.gross}</span></div>
          {dirty && <div className="text-xs text-amber">Ungespeicherte Änderungen: Die Summen zeigen den gespeicherten Stand.</div>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending} className="btn btn-primary" onClick={submit}>{pending ? "Wird gespeichert…" : "Entwurf speichern"}</button>
        <span className="text-xs text-ink-3">„Rechnung prüfen“ passiert beim Speichern und beim Laden automatisch, siehe Prüfliste oben.{dirty ? " Vor dem Abschluss bitte speichern." : ""}</span>
      </div>
    </div>
  );
}

"use client";

// Entwurf einer Rechnungsfassung bearbeiten. Zeigt die vom Server gerechneten Beträge; beim Speichern gehen nur
// Eingaben zum Server, der rechnet neu. Nichts hier ist eine Betragsquelle. Fassung >= 2 startet aus dem Snapshot der
// Vorfassung: Empfänger, Anschrift, Leistungszeitraum und Rechnungsstellerdaten sind bewusst änderbare Kopien.

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { DAMAGE_TAX_TREATMENT_HELP, DAMAGE_TAX_TREATMENTS, INVOICE_UNITS, type DamageTaxTreatment } from "@/lib/constants";
import type { InvoiceDocumentData } from "@/lib/invoice-view";
import { fmtCents, toCents } from "@/lib/money";
import type { InvoiceState } from "./actions";

export type EditableItem = { id: string; description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; source: string; sourceLabel: string; net: string; tax: string; gross: string };
export type EditableCustomer = { type: string; companyName: string; firstName: string; lastName: string; street: string; zip: string; city: string; country: string; email: string; number: string; /** Befehl 29: nur Unfallersatz */ claimNumber?: string; insuredName?: string };
export type EditableCompany = { name: string; legalForm: string; street: string; zip: string; city: string; country: string; email: string; phone: string; vatId: string; taxNumber: string; bankName: string; iban: string; bic: string; invoiceFooter: string };
export type EditableDraft = { customerNote: string; taxNote: string; taxTreatment: string | null; notes: string; paymentTermDays: number | null; reason: string; servicePeriodStart: string; servicePeriodEnd: string; customer: EditableCustomer; company: EditableCompany };

type Props = {
  /** Stand des Entwurfs auf dem Server; ändert er sich (nach dem Speichern), werden die Felder neu befüllt */
  version: number;
  versionNo: number;
  /** Fassungsart des Entwurfs; bei CORRECTION ist der Grund Pflicht */
  kind: "ORIGINAL" | "REVISION" | "CORRECTION";
  /** Rechnungsart: bei DAMAGE ist die steuerliche Behandlung Teil des Entwurfs; bei ACCIDENT (Unfallersatz) ist der Leistungszeitraum fest */
  invoiceKind: "RENTAL" | "DAMAGE" | "ACCIDENT";
  doc: InvoiceDocumentData;
  items: EditableItem[];
  allowedRates: number[];
  draft: EditableDraft;
  blocking: boolean;
  blockingReason?: string;
  /** Vorschau der Zahlungsdifferenz (Fassung >= 2 mit Zahlungen), vom Server gerechnet */
  paymentPreview: { paid: string; grossBefore: string; grossAfter: string; openAfter: string; overpaid: string | null } | null;
  /**
   * Befehl 21: Ausgangslage für die bewusste Kautionsverrechnung beim Abschluss (vom Server gerechnet). null = nichts zu
   * verrechnen (keine offene Forderung, keine verfügbare Kaution, Miete nicht zurückgegeben). Nie vorausgewählt.
   */
  depositOffset?: DepositOffsetChoice | null;
  /** Befehl 23.1: Standard-Zahlungsziel des Mandanten (Einstellungen → Geschäftsregeln → Mahnwesen); nur Vorschlag */
  defaultPaymentTermDays?: number | null;
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

export type DepositOffsetChoice = { grossCents: number; paidCents: number; openCents: number; receivedCents: number; usedCents: number; availableCents: number; suggestedCents: number; nonce: string; when: string };

const Line = ({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "good" | "bad" | "info" }) => (
  <div className={`flex justify-between gap-3 ${strong ? "font-semibold" : ""}`}><span className="text-ink-3">{label}</span><span className={`font-mono tnum ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "info" ? "text-info" : ""}`}>{value}</span></div>
);

/**
 * Befehl 21: Kautionsverrechnung bewusst auswählen. Die Auswahl bucht nichts – sie wird mit „Rechnung finalisieren“
 * gesendet und serverseitig zusammen mit dem Abschluss verbucht (oder gar nicht). Die Vorschau rechnet nur mit den vom
 * Server gelieferten Zahlen; der Server prüft beim Abschluss erneut (nie mehr als offen, nie mehr als verfügbar).
 */
function DepositOffsetSection({ choice, chosen, setChosen, amount, setAmount }: { choice: DepositOffsetChoice; chosen: boolean; setChosen: (v: boolean) => void; amount: string; setAmount: (v: string) => void }) {
  let cents = 0;
  try { cents = Math.max(0, toCents(amount.trim() || "0")); } catch { cents = -1; }
  const tooMuch = cents > choice.openCents || cents > choice.availableCents;
  const invalid = chosen && (cents <= 0 || tooMuch);
  const used = chosen && !invalid ? cents : 0;
  return (
    <div className="rounded-lg border-2 border-info/40 p-3 flex flex-col gap-3 text-sm">
      <div className="font-semibold">Kaution &amp; offene Forderung</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex flex-col gap-0.5">
          <Line label="Rechnungsbetrag" value={fmtCents(choice.grossCents)} />
          <Line label="Mietzahlungen" value={fmtCents(choice.paidCents)} />
          {used > 0 && <Line label="aus Kaution verrechnet" value={fmtCents(used)} tone="info" />}
          <div className="border-t border-line-soft mt-1 pt-1"><Line label={used > 0 ? "noch offen" : "offen nach Abschluss"} value={fmtCents(Math.max(0, choice.openCents - used))} strong tone={choice.openCents - used > 0 ? "bad" : "good"} /></div>
        </div>
        <div className="flex flex-col gap-0.5">
          <Line label="Kaution erhalten" value={fmtCents(choice.receivedCents)} />
          {choice.usedCents > 0 && <Line label="bereits freigegeben, einbehalten oder verrechnet" value={fmtCents(choice.usedCents)} />}
          {used > 0 && <Line label="davon jetzt verrechnet" value={fmtCents(used)} tone="info" />}
          <div className="border-t border-line-soft mt-1 pt-1"><Line label={used > 0 ? "an Kunden verbleibend" : "aktuell verfügbar"} value={fmtCents(choice.availableCents - used)} strong /></div>
        </div>
      </div>
      <label className="flex items-start gap-2.5 rounded-md bg-panel-2 px-3 py-2.5 cursor-pointer">
        <input type="checkbox" name="depositOffset" value="1" checked={chosen} onChange={(e) => setChosen(e.target.checked)} className="mt-0.5 size-5 shrink-0" />
        <span><span className="font-medium">{fmtCents(choice.suggestedCents)} aus Kaution verrechnen</span><span className="block text-xs text-ink-3">Vorschlag: kleinerer Betrag aus offener Forderung und verfügbarer Kaution. Ohne Auswahl wird nichts verrechnet.</span></span>
      </label>
      {chosen && (
        <>
          <label className="flex flex-col gap-1 max-w-xs"><span className="label-xs">Verrechnungsbetrag in €</span><input name="depositOffsetAmount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required className="input tnum" /></label>
          <input type="hidden" name="depositOffsetConfirmed" value="1" />
          <input type="hidden" name="depositOffsetNonce" value={choice.nonce} />
          <input type="hidden" name="depositOffsetAt" value={choice.when} />
          {invalid && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-xs">{cents <= 0 ? "Bitte einen Betrag über 0,00 € eingeben." : `Höchstens ${fmtCents(Math.min(choice.openCents, choice.availableCents))}: nie mehr als die offene Forderung und nie mehr als die verfügbare Kaution.`}</p>}
          <p className="text-xs text-ink-3">Es fließt kein Geld und die Rechnung bleibt unverändert: Die Verrechnung gleicht die Forderung aus, wie eine Zahlung. Die verbleibende Kaution wird dadurch weder freigegeben noch ausgezahlt – das ist danach ein eigener Schritt.</p>
        </>
      )}
    </div>
  );
}

function FinalizeCard({ finalize, blocking, blockingReason, versionNo, kind, paymentPreview, depositOffset }: Props) {
  const [state, formAction, pending] = useActionState(finalize, undefined);
  const [clicked, setClicked] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [offsetChosen, setOffsetChosen] = useState(false);
  const [offsetAmount, setOffsetAmount] = useState(depositOffset ? (depositOffset.suggestedCents / 100).toFixed(2).replace(".", ",") : "");
  let offsetCents = 0;
  try { offsetCents = offsetChosen ? toCents(offsetAmount.trim() || "0") : 0; } catch { offsetCents = -1; }
  const offsetInvalid = !!depositOffset && offsetChosen && (offsetCents <= 0 || offsetCents > depositOffset.openCents || offsetCents > depositOffset.availableCents);
  const overpaid = !!paymentPreview?.overpaid;
  const locked = blocking || pending || (clicked && !state?.error) || (overpaid && !confirmed) || offsetInvalid;
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
      {depositOffset && !overpaid && <DepositOffsetSection choice={depositOffset} chosen={offsetChosen} setChosen={setOffsetChosen} amount={offsetAmount} setAmount={setOffsetAmount} />}
      {state?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>}
      <button type="submit" disabled={locked} className="btn btn-primary justify-center !py-3 !text-[15px]">
        {pending || (clicked && !state?.error) ? "Rechnung wird abgeschlossen…" : `${versionNo === 1 ? "Rechnung finalisieren" : `Fassung ${versionNo} finalisieren`}${depositOffset && offsetChosen && !offsetInvalid ? ` und ${fmtCents(offsetCents)} aus Kaution verrechnen` : ""}`}
      </button>
      {blocking && blockingReason && <p className="text-xs text-ink-3">{blockingReason}</p>}
    </form>
  );
}

const Field = ({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) => (
  <label className={`flex flex-col gap-1 ${className}`}><span className="label-xs">{label}</span>{children}</label>
);

function EditorBody({ doc, items: initial, allowedRates, draft, kind, versionNo, invoiceKind, defaultPaymentTermDays = null, save, onSaved, onDirty }: Props & { onSaved: (s: InvoiceState) => void; onDirty: (d: boolean) => void }) {
  const router = useRouter();
  const [items, setItems] = useState(initial.map((i) => ({ ...i })));
  const [customerNote, setCustomerNote] = useState(draft.customerNote);
  const [taxNote, setTaxNote] = useState(draft.taxNote);
  const [taxTreatment, setTaxTreatment] = useState<string>(draft.taxTreatment ?? "");
  const nonTaxable = invoiceKind === "DAMAGE" && taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION";
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
        ...(invoiceKind === "DAMAGE" ? { taxTreatment } : {}),
        // Unfallersatz: der Leistungszeitraum ergibt sich aus Übergabe, Stichtag bzw. Rückgabe – wird nicht gesendet (Server lehnt Änderungen ab)
        ...(invoiceKind === "ACCIDENT" ? {} : { servicePeriodStart: period.start, servicePeriodEnd: period.end }),
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
            {invoiceKind === "ACCIDENT" && <Field label="Schadennummer"><input value={customer.claimNumber ?? ""} onChange={(e) => cust({ claimNumber: e.target.value })} className="input" maxLength={100} /></Field>}
            {invoiceKind === "ACCIDENT" && <Field label="Geschädigter / Mieter" className="sm:col-span-2"><input value={customer.insuredName ?? ""} onChange={(e) => cust({ insuredName: e.target.value })} className="input" maxLength={200} /></Field>}
          </div>
          <p className="text-[11px] text-ink-3">Kopie {versionNo > 1 ? `aus Fassung ${versionNo - 1}` : invoiceKind === "ACCIDENT" ? "aus der Fallakte bzw. dem Mietvertrag" : "aus dem Mietvertrag"}. Änderungen hier wirken nur auf diese Rechnung, nicht auf den Kunden{invoiceKind === "ACCIDENT" ? " und nicht auf die Fallakte" : ""}.</p>
        </div>
        <div className="flex flex-col gap-4">
          <div className="card p-4 flex flex-col gap-3">
            <div className="font-semibold text-sm">Leistungszeitraum</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Beginn"><input type="datetime-local" value={period.start} disabled={invoiceKind === "ACCIDENT"} onChange={(e) => { setPeriod((p) => ({ ...p, start: e.target.value })); setDirty(true); }} className="input" /></Field>
              <Field label="Ende"><input type="datetime-local" value={period.end} disabled={invoiceKind === "ACCIDENT"} onChange={(e) => { setPeriod((p) => ({ ...p, end: e.target.value })); setDirty(true); }} className="input" /></Field>
            </div>
            {invoiceKind === "ACCIDENT" && <p className="text-[11px] text-ink-3">Unfallersatz: Der Leistungszeitraum ergibt sich aus der tatsächlichen Übergabe, dem Stichtag bzw. der Rückgabe und ist nicht änderbar – so wird kein Miettag doppelt oder gar nicht berechnet.</p>}
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

      {invoiceKind === "DAMAGE" && (
        <div className="card p-4 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="label-xs">Steuerliche Behandlung dieser Fassung (bewusste Einordnung, keine Steuerberatung)</span>
            <select value={taxTreatment} onChange={(e) => { setTaxTreatment(e.target.value); setDirty(true); }} className="input max-w-xl">
              <option value="" disabled>Bitte auswählen</option>
              {Object.entries(DAMAGE_TAX_TREATMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          {taxTreatment in DAMAGE_TAX_TREATMENT_HELP && <p className="text-xs text-ink-3">{DAMAGE_TAX_TREATMENT_HELP[taxTreatment as DamageTaxTreatment]}</p>}
          {nonTaxable && <p className="rounded-md bg-info-soft text-info px-3 py-2 text-sm">Nicht steuerbar ist nicht dasselbe wie „0 % Umsatzsteuer“: Die Positionen tragen keinen Steuersatz, das Dokument weist keine Umsatzsteuer aus und enthält den Hinweis zur gewählten Behandlung.</p>}
        </div>
      )}

      <div className="card">
        <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2"><span className="font-semibold text-sm">Positionen</span><span className="text-xs text-ink-3">{nonTaxable ? "Nicht steuerbarer Schadensersatz: Beträge ohne Steuersatz" : doc.pricesIncludeTax ? "Einzelpreise sind Bruttobeträge, die Steuer wird herausgerechnet" : "Einzelpreise sind Nettobeträge, die Steuer kommt hinzu"}</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead><tr className="text-left text-xs text-ink-3 border-b border-line-soft"><th className="px-3 py-2 font-medium">Beschreibung</th><th className="px-2 py-2 font-medium w-20">Menge</th><th className="px-2 py-2 font-medium w-24">Einheit</th><th className="px-2 py-2 font-medium w-28 text-right">{doc.pricesIncludeTax ? "Einzelpreis brutto" : "Einzelpreis netto"}</th>{!nonTaxable && <th className="px-2 py-2 font-medium w-24">Steuer</th>}{!nonTaxable && <th className="px-2 py-2 font-medium text-right">Netto</th>}{!nonTaxable && <th className="px-2 py-2 font-medium text-right">Steuer</th>}<th className="px-2 py-2 font-medium text-right">{nonTaxable ? "Betrag" : "Brutto"}</th><th className="w-10" /></tr></thead>
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
                  {!nonTaxable && <td className="px-2 py-2"><select value={it.taxRate} onChange={(e) => update(idx, { taxRate: e.target.value })} className="input !py-1.5" aria-label={`Steuersatz Position ${idx + 1}`}>{[...new Set([...rateOptions, it.taxRate])].map((r) => <option key={r} value={r}>{r} %</option>)}</select></td>}
                  {!nonTaxable && <td className="px-2 py-2 text-right font-mono tnum">{it.net}</td>}
                  {!nonTaxable && <td className="px-2 py-2 text-right font-mono tnum">{it.tax}</td>}
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
          <PaymentTermField value={paymentTermDays} standardDays={defaultPaymentTermDays} onChange={(v) => { setPaymentTermDays(v); setDirty(true); }} />
          <label className="flex flex-col gap-1"><span className="label-xs">Text auf der Rechnung (optional)</span><textarea value={customerNote} onChange={(e) => { setCustomerNote(e.target.value); setDirty(true); }} rows={2} className="input" /></label>
          {nonTaxable ? (
            <div className="flex flex-col gap-1"><span className="label-xs">Hinweis auf dem Dokument (fest, aus der gewählten Behandlung)</span><p className="text-sm text-ink-2">{doc.taxTreatmentNote}</p></div>
          ) : (
            <label className="flex flex-col gap-1"><span className="label-xs">Steuerhinweis (erscheint bei Positionen mit 0 %)</span><input value={taxNote} onChange={(e) => { setTaxNote(e.target.value); setDirty(true); }} className="input" /></label>
          )}
          <label className="flex flex-col gap-1"><span className="label-xs">Interne Notiz (nicht auf der Rechnung)</span><textarea value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={2} className="input" /></label>
        </div>
        <div className="card p-4 flex flex-col gap-2 text-sm">
          <div className="font-semibold">{doc.nonTaxable ? "Forderung" : "Steuerzusammenfassung"}</div>
          {doc.nonTaxable && <div className="flex justify-between"><span className="text-ink-3">Nicht steuerbarer Schadensersatz</span><span className="font-mono tnum">{doc.totals.gross}</span></div>}
          {!doc.nonTaxable && doc.taxSummary.map((t) => <div key={t.rate} className="flex justify-between"><span className="text-ink-3">{t.rate} auf {t.net}</span><span className="font-mono tnum">{t.tax}</span></div>)}
          {!doc.nonTaxable && <div className="flex justify-between border-t border-line-soft pt-2"><span className="text-ink-3">Netto</span><span className="font-mono tnum">{doc.totals.net}</span></div>}
          {!doc.nonTaxable && <div className="flex justify-between"><span className="text-ink-3">Steuer</span><span className="font-mono tnum">{doc.totals.tax}</span></div>}
          <div className="flex justify-between text-base font-semibold border-t-2 border-ink pt-2"><span>{doc.nonTaxable ? "Gesamtforderung" : "Gesamt"}</span><span className="font-mono tnum">{doc.totals.gross}</span></div>
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

/**
 * Befehl 23.1: Zahlungsziel dieser Rechnung. Vorschlag = Mandantenstandard; Änderungen gelten nur für diesen Entwurf (nie für
 * die Geschäftsregel). Fällig wird die Rechnung am Tag des Abschlusses plus Zahlungsziel – dieses Datum wird beim Abschluss
 * mit der Fassung versiegelt und ist die einzige Fälligkeitsquelle des Mahnwesens. Ein Datum vor dem Rechnungsdatum ist
 * nicht wählbar (eine Rechnung kann nicht vor ihrer Ausstellung fällig sein). Überfällig ist sie ab dem Folgetag.
 */
function PaymentTermField({ value, standardDays, onChange }: { value: string; standardDays: number | null; onChange: (v: string) => void }) {
  const tz = "Europe/Berlin";
  const today = new Date();
  const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const de = (d: Date) => d.toLocaleDateString("de-DE", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  const days = value.trim() === "" ? null : Number(value);
  const valid = days === null || (Number.isInteger(days) && days >= 0 && days <= 365);
  const due = days !== null && valid ? new Date(today.getTime() + days * 86_400_000) : null;
  const dayDiff = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); const [ty, tm, td] = ymd(today).split("-").map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000); };
  const quick: { label: string; v: string }[] = [
    { label: "Sofort fällig", v: "0" }, { label: "7 Tage", v: "7" }, { label: "14 Tage", v: "14" }, { label: "30 Tage", v: "30" },
    ...(standardDays != null && ![0, 7, 14, 30].includes(standardDays) ? [{ label: `Standard (${standardDays} Tage)`, v: String(standardDays) }] : []),
    { label: "Ohne Zahlungsziel", v: "" },
  ];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="label-xs mb-1">Zahlungsziel</legend>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Zahlungsziel wählen">
        {quick.map((q) => (
          <button key={q.label} type="button" onClick={() => onChange(q.v)} aria-pressed={value === q.v} className={`btn !py-2 text-xs ${value === q.v ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{q.label}</button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="flex flex-col gap-1"><span className="label-xs">Tage nach Rechnungsdatum</span><input value={value} onChange={(e) => onChange(e.target.value)} type="number" min={0} max={365} inputMode="numeric" className="input tnum" placeholder="leer = keins" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">oder fällig am (eigenes Datum)</span><input type="date" min={ymd(today)} value={due ? ymd(due) : ""} onChange={(e) => { if (!e.target.value) return; const n = dayDiff(e.target.value); if (n >= 0 && n <= 365) onChange(String(n)); }} className="input tnum" /></label>
      </div>
      {!valid ? (
        <p role="alert" className="text-sm text-bad">Das Zahlungsziel liegt zwischen 0 und 365 Tagen.</p>
      ) : due ? (
        <p className="rounded-md bg-panel-2 px-3 py-2 text-sm"><span className="font-medium">Zahlungsziel: {days === 0 ? "sofort fällig" : `${days} ${days === 1 ? "Tag" : "Tage"}`}</span> · Fällig am <span className="font-mono tnum font-semibold">{de(due)}</span> <span className="text-ink-3">(bei Abschluss heute; überfällig ab dem Folgetag)</span>{standardDays != null && days !== standardDays ? <span className="text-ink-3"> · abweichend vom Standard {standardDays} Tage, nur für diese Rechnung</span> : null}</p>
      ) : (
        <p className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Ohne Zahlungsziel hat die Rechnung kein Fälligkeitsdatum – sie wird nicht überfällig und kann nicht gemahnt werden.</p>
      )}
    </fieldset>
  );
}

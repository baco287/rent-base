// Gutschrift / Stornobeleg (Phase 17): Entwurf (Positionen, Grund, Vorschau, Abschluss) und abgeschlossener Beleg (nur lesend).
// Dazu die Belegkette einer Rechnung mit zentraler Finanzsummierung. Server-Komponenten; Beträge kommen ausschließlich vom Server.
import Link from "next/link";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { COUNTER_DOCUMENT_HELP, INVOICE_CHAIN_STATUS, INVOICE_DOCUMENT_TYPES } from "@/lib/constants";
import { documentChain, getCounterDocumentState, originalDateLabel, type InvoiceFinancials } from "@/lib/counter-documents";
import { loadInvoiceDocumentData } from "@/lib/document-data";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fmtCents, fmtRate, toCents } from "@/lib/money";
import type { EditModeInfo } from "@/lib/invoices";
import { DocumentsPanel } from "../dokumente/documents-panel";
import { FollowUpNotice } from "../dokumente/follow-up-notice";
import { createCancellationAction, createCreditNoteAction, discardCounterAction, finalizeCounterAction, saveCounterDraftAction } from "./counter-actions";
import { CreditNoteEditor, type ManualRow, type SourceRow } from "./credit-note-editor";
import { FinalizeCounterForm } from "./counter-forms";
import { InvoiceDocumentView, InvoiceIssueList } from "./invoice-parts";

const de = (v: unknown, digits = 2) => Number(String(v)).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

type Booking = { id: string; number: string; vehicle: { plate: string } };
type Sp = Record<string, string | string[] | undefined>;

export async function CounterDocumentPage({ tenantId, role, booking, invoiceId, sp }: { tenantId: string; role: string; booking: Booking; invoiceId: string; sp: Sp }) {
  const st = await getCounterDocumentState(tenantId, invoiceId);
  const canEdit = role !== "YARD";
  const word = INVOICE_DOCUMENT_TYPES[st.type];
  const changeLog = (Array.isArray(st.invoice.changeLog) ? st.invoice.changeLog : []) as { at: string; by: string; summary: string }[];
  const hint = typeof sp.hinweis === "string" ? sp.hinweis : null;
  const originalLine = `Zu Rechnung ${st.original.number}${originalDateLabel(st.original.snapshot) ? ` vom ${originalDateLabel(st.original.snapshot)}` : ""}${st.original.snapshot.versionNo > 1 ? ` (Fassung ${st.original.snapshot.versionNo})` : ""}`;

  // Entwurf: Editor (Gutschrift) bzw. Stornovorschau, Prüfung, Abschluss
  if (st.draft && st.residuals) {
    if (!canEdit) return null;
    const { doc } = await loadInvoiceDocumentData(tenantId, st.draft.id, { allowDraft: true });
    const draftGross = toCents(st.draft.grossTotal);
    const byItem = new Map(st.draft.items.filter((i) => i.sourceInvoiceVersionItemId).map((i) => [i.sourceInvoiceVersionItemId!, i]));
    const sources: SourceRow[] = st.residuals.items.map((r) => {
      const own = byItem.get(r.itemId);
      const full = !!own && toCents(own.grossAmount) === r.remaining.gross;
      const mode: SourceRow["mode"] = !own ? "REMAINING" : full ? "REMAINING" : own.unit === "pauschal" && Number(own.quantity) === 1 && r.unit !== "pauschal" ? "AMOUNT" : own.unit === r.unit && toCents(own.unitPrice) === r.unitPrice ? "QUANTITY" : "AMOUNT";
      return { itemId: r.itemId, description: r.description, quantity: de(r.quantity, 0), unit: r.unit, unitPrice: fmtCents(r.unitPrice), taxRate: fmtRate(r.taxRateBp), original: fmtCents(r.original.gross), credited: fmtCents(r.credited.gross), remaining: fmtCents(r.remaining.gross), remainingCents: r.remaining.gross, selected: !!own, mode, quantityInput: own ? de(own.quantity) : "", amountInput: own ? de(own.grossAmount) : "", current: own ? fmtCents(toCents(own.grossAmount)) : null };
    });
    const manual: ManualRow[] = st.draft.items.filter((i) => !i.sourceInvoiceVersionItemId && st.type === "CREDIT_NOTE").map((i) => ({ key: i.id, description: i.description, quantity: de(i.quantity), unit: i.unit, unitPrice: de(i.unitPrice), taxRate: de(i.taxRate), reason: i.reference ?? "", current: fmtCents(toCents(i.grossAmount)) }));
    const rateOptions = [...new Set(st.residuals.items.map((r) => r.taxRateBp))].sort((a, b) => b - a).map((bp) => de(bp / 100));
    const blockingIssues = st.issues.filter((i) => i.severity === "error" && i.code !== "REASON");
    const effect = { invoice: fmtCents(st.financials.invoiceCents), creditedBefore: fmtCents(st.financials.creditedCents + st.financials.cancelledCents), thisDocument: fmtCents(draftGross), effectiveAfter: fmtCents(st.effectiveAfter), paid: fmtCents(st.paidCents), customerCreditAfter: fmtCents(st.customerCreditAfter), openAfter: fmtCents(Math.max(0, st.effectiveAfter - st.paidCents)) };
    return (
      <>
        <PageHeader title={`${word} (Entwurf)`} sub={<>{originalLine} · Buchung {booking.number} · {doc.customer.name}</>}>
          <Chip tone="amber">Entwurf</Chip>
          <Link href={st.original.href} className="btn">Zur Rechnung {st.original.number}</Link>
          <form action={discardCounterAction.bind(null, booking.id, st.invoice.id)}><button className="btn btn-danger">Entwurf verwerfen</button></form>
        </PageHeader>
        <Content>
          {hint && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{hint}</p>}
          <div className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">
            <span className="font-semibold">{st.type === "CREDIT_NOTE" ? COUNTER_DOCUMENT_HELP.CREDIT_NOTE : COUNTER_DOCUMENT_HELP.CANCELLATION}</span> Die Rechnung {st.original.number} wird dadurch nicht verändert. Zahlungen bleiben bestehen; ein Guthaben wird nur ausgewiesen, nicht ausgezahlt oder verrechnet.
            {st.original.taxTreatmentLabel && <> Steuerliche Behandlung wie in der Rechnung: {st.original.taxTreatmentLabel}.</>}
          </div>
          <FinancialSummary f={st.financials} numberLabel={st.original.number} />
          <InvoiceIssueList issues={st.issues.filter((i) => i.code !== "REASON")} okText={`Alle Prüfungen bestanden. ${word} über ${fmtCents(draftGross)} kann abgeschlossen werden.`} />
          {st.type === "CREDIT_NOTE" ? (
            <CreditNoteEditor
              version={st.draft.updatedAt.getTime()}
              sources={sources}
              manual={manual}
              rateOptions={rateOptions}
              nonTaxable={st.draft.taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION"}
              reason={st.draft.reason ?? ""}
              customerNote={st.draft.customerNote ?? ""}
              notes={st.invoice.notes ?? ""}
              totalGross={fmtCents(draftGross)}
              remainingGross={fmtCents(st.residuals.remaining.gross)}
              save={saveCounterDraftAction.bind(null, booking.id, st.invoice.id)}
            />
          ) : (
            <Card title="Storno der Rechnung" right={<Chip tone="bad">{fmtCents(draftGross)}</Chip>}>
              <div className="p-4 text-sm flex flex-col gap-1.5">
                <div className="flex justify-between"><span className="text-ink-3">Rechnungsbetrag {st.original.number}</span><span className="font-mono tnum">{fmtCents(st.financials.invoiceCents)}</span></div>
                <div className="flex justify-between"><span className="text-ink-3">Bereits gutgeschrieben</span><span className="font-mono tnum">− {fmtCents(st.financials.creditedCents)}</span></div>
                <div className="flex justify-between font-semibold"><span>Stornobetrag (verbleibender Rest)</span><span className="font-mono tnum">− {fmtCents(draftGross)}</span></div>
                <div className="flex justify-between border-t border-line-soft pt-1.5"><span className="text-ink-3">Gesamtwirkung danach</span><span className="font-mono tnum">{fmtCents(st.effectiveAfter)}</span></div>
                <p className="text-xs text-ink-3 mt-1">Die Positionen unten spiegeln {st.financials.creditedCents > 0 ? "den verbleibenden Rest je Steuersatz" : "die Positionen der Rechnung"}; sie werden nicht bearbeitet. Für Teilbeträge eine Gutschrift verwenden.</p>
              </div>
            </Card>
          )}
          <Card title="Vorschau des Belegs"><div className="p-4"><InvoiceDocumentView doc={doc} /></div></Card>
          <FinalizeCounterForm action={finalizeCounterAction.bind(null, booking.id, st.invoice.id)} type={st.type} reason={st.draft.reason ?? ""} blocking={blockingIssues.length > 0} blockingReason={blockingIssues.length > 0 ? "Bitte zuerst die offenen Punkte aus der Prüfung lösen (Entwurf speichern)." : undefined} effect={effect} />
          <Card title="Änderungsprotokoll"><div className="p-4 text-sm"><ChangeLog entries={changeLog} /></div></Card>
        </Content>
      </>
    );
  }

  if (!st.current) return null;
  const { doc } = await loadInvoiceDocumentData(tenantId, st.current.id);
  const finished = sp.abgeschlossen === "1";
  return (
    <>
      <PageHeader title={`${word} ${st.invoice.number}`} sub={<>{originalLine} · Buchung {booking.number} · {doc.customer.name}</>}>
        <Chip tone="good">Finalisiert</Chip>
        <Chip tone="info">Wirkung: Minderung {fmtCents(toCents(st.current.grossTotal))}</Chip>
        <Link href={st.original.href} className="btn">Zur Rechnung {st.original.number}</Link>
        <Link href={`/buchungen/${booking.id}`} className="btn">Zur Buchung</Link>
      </PageHeader>
      <Content>
        {hint && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{hint}</p>}
        {finished && <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">{word} {st.invoice.number} ist abgeschlossen und versiegelt. Betrag {fmtCents(toCents(st.current.grossTotal))}. Die Rechnung {st.original.number} bleibt unverändert; Zahlungen wurden nicht verändert.</p>}
        {finished && <FollowUpNotice tenantId={tenantId} bookingId={booking.id} invoiceId={st.invoice.id} invoiceVersionId={st.current.id} kind="INVOICE" documentType={st.type} />}
        <FinancialSummary f={st.financials} numberLabel={st.original.number} />
        <ChainCard tenantId={tenantId} invoiceId={st.original.id} currentId={st.invoice.id} canEdit={false} mode={null} />
        <DocumentsPanel tenantId={tenantId} bookingId={booking.id} role={role} invoiceId={st.invoice.id} />
        <InvoiceDocumentView doc={doc} />
        <div className="text-xs text-ink-3 flex flex-wrap gap-x-3">
          <span>Abgeschlossen {fmtDateTime(st.current.finalizedAt)}{st.current.finalizedByName ? ` von ${st.current.finalizedByName}` : ""}</span>
          {st.current.reason && <span>Grund: {st.current.reason}</span>}
        </div>
        {canEdit && (
          <Card title="Intern (nicht auf dem Beleg)">
            <div className="p-4 text-sm flex flex-col gap-2">
              <div><span className="label-xs">Interne Notiz</span><div className="whitespace-pre-line">{st.invoice.notes || "–"}</div></div>
              <ChangeLog entries={changeLog} />
            </div>
          </Card>
        )}
      </Content>
    </>
  );
}

/** Zentrale Summierung: Rechnung − Gutschriften − Storno = Forderung; Zahlungen; offen oder Kundenguthaben (nie negativ offen). */
export function FinancialSummary({ f, numberLabel }: { f: InvoiceFinancials; numberLabel: string }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
      <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Rechnung {numberLabel}</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(f.invoiceCents)}</div>{(f.creditedCents > 0 || f.cancelledCents > 0) && <div className="text-xs text-ink-3">{f.creditedCents > 0 ? `− Gutschriften ${fmtCents(f.creditedCents)}` : ""}{f.cancelledCents > 0 ? ` − Storno ${fmtCents(f.cancelledCents)}` : ""}</div>}</div>
      <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Wirksame Forderung</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(f.effectiveCents)}</div><div className="text-xs text-ink-3">{INVOICE_CHAIN_STATUS[f.chain]}</div></div>
      <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Bezahlt</div><div className="font-mono tnum text-lg font-semibold text-good">{fmtCents(f.paidCents)}</div><div className="text-xs text-ink-3">unverändert durch Gegenbelege</div></div>
      {f.customerCreditCents > 0 ? (
        <div className="rounded-md bg-bad-soft p-3"><div className="label-xs">Kundenguthaben</div><div className="font-mono tnum text-lg font-semibold text-bad">{fmtCents(f.customerCreditCents)}</div><div className="text-xs">Erstattung erforderlich – keine automatische Auszahlung, keine Verrechnung</div></div>
      ) : (
        <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Offen</div><div className={`font-mono tnum text-lg font-semibold ${f.openCents > 0 ? "text-bad" : ""}`}>{fmtCents(f.openCents)}</div><div className="text-xs text-ink-3">{f.openCents === 0 ? "nichts mehr offen" : "vom Kunden zu zahlen"}</div></div>
      )}
    </div>
  );
}

/** Belegkette: Rechnung → Gutschriften → Storno, anklickbar, mit Beträgen und verbleibender Forderung; dazu die Aktionen. */
export async function ChainCard({ tenantId, invoiceId, currentId, canEdit, mode, bookingId }: { tenantId: string; invoiceId: string; currentId: string; canEdit: boolean; mode: EditModeInfo | null; bookingId?: string }) {
  const { original, counters, financials: f } = await documentChain(tenantId, invoiceId);
  const canCounter = canEdit && !f.fullyNeutralized && !f.hasDraftCounter && f.effectiveCents > 0;
  const tone = (t: string, status: string) => (status === "DRAFT" ? "amber" : t === "CANCELLATION" ? "bad" : t === "CREDIT_NOTE" ? "info" : "good");
  return (
    <Card title="Belegkette" right={<Chip tone={f.chain === "NONE" ? "grey" : f.chain === "CANCELLED" ? "bad" : "info"}>{INVOICE_CHAIN_STATUS[f.chain]}</Chip>}>
      <ul className="divide-y divide-line-soft text-sm">
        {[original, ...counters].map((e) => (
          <li key={e.id} className={`px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 ${e.id === currentId ? "bg-panel-2/60" : ""}`}>
            <Chip tone={tone(e.documentType, e.status)}>{INVOICE_DOCUMENT_TYPES[e.documentType]}</Chip>
            {e.id === currentId ? <span className="font-mono tnum font-semibold">{e.number ?? "(Entwurf)"}</span> : <Link href={e.href} className="font-mono tnum font-semibold hover:underline">{e.number ?? "(Entwurf)"}</Link>}
            <span className="text-xs text-ink-3">{e.status === "DRAFT" ? "Entwurf, noch ohne Nummer" : e.issueDate ? fmtDate(e.issueDate) : e.finalizedAt ? fmtDate(e.finalizedAt) : ""}{e.documentType === "INVOICE" && e.versionNo > 1 ? ` · Fassung ${e.versionNo}` : ""}</span>
            <span className={`ml-auto font-mono tnum ${e.documentType === "INVOICE" ? "" : "text-bad"}`}>{e.documentType === "INVOICE" ? "" : "− "}{fmtCents(e.grossCents)}</span>
            {e.reason && e.documentType !== "INVOICE" && <span className="basis-full text-xs text-ink-2">Grund: {e.reason}</span>}
          </li>
        ))}
        <li className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 font-semibold"><span>Verbleibende Forderung</span><span className="ml-auto font-mono tnum">{fmtCents(f.effectiveCents)}</span></li>
      </ul>
      {canEdit && (
        <div className="px-4 pb-4 flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {canCounter && bookingId && <form action={createCreditNoteAction.bind(null, bookingId, invoiceId)}><button className="btn btn-primary">Gutschrift erstellen</button></form>}
            {canCounter && bookingId && <form action={createCancellationAction.bind(null, bookingId, invoiceId)}><button className="btn btn-danger">Rechnung stornieren</button></form>}
            {f.hasDraftCounter && <span className="text-amber">Ein Entwurf eines Gegenbelegs ist offen (siehe Kette).</span>}
            {f.fullyNeutralized && <span className="text-ink-3">{f.chain === "CANCELLED" ? "Die Rechnung ist storniert; weitere Gegenbelege sind nicht möglich." : "Die Rechnung ist vollständig gutgeschrieben; weitere Gegenbelege sind nicht möglich."}</span>}
          </div>
          <details className="text-xs text-ink-2">
            <summary className="cursor-pointer font-medium">Berichtigen, Gutschrift oder Storno – was ist richtig?</summary>
            <ul className="list-disc pl-5 mt-1 flex flex-col gap-1">
              <li>{COUNTER_DOCUMENT_HELP.REVISION}</li>
              <li>{COUNTER_DOCUMENT_HELP.CREDIT_NOTE}</li>
              <li>{COUNTER_DOCUMENT_HELP.CANCELLATION}</li>
            </ul>
            {mode && !mode.editable && mode.blockedReason && <p className="mt-1">{mode.blockedReason}</p>}
          </details>
        </div>
      )}
    </Card>
  );
}

function ChangeLog({ entries }: { entries: { at: string; by: string; summary: string }[] }) {
  if (entries.length === 0) return <span className="text-ink-3">Keine Einträge.</span>;
  return (
    <ul className="divide-y divide-line-soft">
      {entries.map((e, i) => (
        <li key={i} className="py-1.5 flex flex-wrap gap-x-2 items-baseline"><span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(new Date(e.at))}</span><span className="text-xs text-ink-3">{e.by}</span><span>{e.summary}</span></li>
      ))}
    </ul>
  );
}

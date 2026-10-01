// Befehl 23.1: Rechnungsseite für freie Rechnungen (kind GENERAL, mit oder ohne Buchungsbezug) und für alle Belege ohne
// Buchung (deren Gegenbelege und Mahngebühren). Kein eigenes Rechnungssystem: dieselben Bausteine wie die Rechnung einer
// Buchung – Editor, Prüfung, Abschluss, Fassungen, Archiv, Zahlungen, Gegenbelege, Kundenguthaben, Erstattung, Mahnwesen.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { INVOICE_CHAIN_STATUS, INVOICE_ITEM_SOURCES, INVOICE_VERSION_KINDS, invoiceKindWord } from "@/lib/constants";
import { invoiceFinancials } from "@/lib/counter-documents";
import { loadInvoiceDocumentData } from "@/lib/document-data";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { getInvoiceState, listVersions, type CompanySnapshot, type InvoiceCustomerSnapshot } from "@/lib/invoices";
import { bookingLabel } from "@/lib/invoice-links";
import { fmtCents, toCents } from "@/lib/money";
import { invoicePaymentSummary } from "@/lib/payments";
import { toDateTimeInputValue } from "@/lib/time";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { InvoiceDocumentsCard } from "../../buchungen/[id]/dokumente/invoice-documents-card";
import { FollowUpNotice } from "../../buchungen/[id]/dokumente/follow-up-notice";
import { PaymentsPanel, PaymentStatusChip } from "../../buchungen/[id]/finanzen/panels";
import { CustomerCreditCard } from "../../buchungen/[id]/finanzen/customer-credit-card";
import { DepositSettlementCard } from "../../buchungen/[id]/finanzen/deposit-settlement-card";
import { DunningCard, DunningFeeNote } from "../../buchungen/[id]/rechnung/dunning-card";
import { discardInvoiceDraftAction, finalizeInvoiceAction, markDeliveredAction, saveInvoiceDraftAction, startInvoiceEditAction } from "../../buchungen/[id]/rechnung/actions";
import { InvoiceEditor, type EditableItem } from "../../buchungen/[id]/rechnung/invoice-editor";
import { InvoiceDocumentView, InvoiceIssueList } from "../../buchungen/[id]/rechnung/invoice-parts";
import { MarkDeliveredForm } from "../../buchungen/[id]/rechnung/version-forms";
import { ChainCard, CounterDocumentPage, FinancialSummary } from "../../buchungen/[id]/rechnung/counter-document";
import { PayoutPanel } from "../../auszahlungen/payout-panel";

export const metadata = { title: "Rechnung" };

const de = (v: unknown, digits = 2) => Number(String(v)).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default async function FreeInvoicePage({ params, searchParams }: PageProps<"/rechnungen/[id]">) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const { id } = await params;
  const sp = await searchParams;
  const invoice = await db.invoice.findFirst({ where: { id, tenantId: tenant.id, status: { in: ["DRAFT", "FINALIZED"] } }, include: { booking: { select: { id: true, number: true, vehicle: { select: { plate: true } } } } } });
  if (!invoice) notFound();
  // Rechnungen einer Buchung (Miete, Schaden, Bearbeitungsentgelt, deren Mahngebühren) bleiben unter ihrer Buchung
  if (invoice.bookingId && invoice.kind !== "GENERAL") redirect(`/buchungen/${invoice.bookingId}/rechnung?nr=${invoice.id}`);
  const canEdit = user.role !== "YARD";
  const booking = invoice.booking;
  if (invoice.documentType !== "INVOICE") return <CounterDocumentPage tenantId={tenant.id} role={user.role} booking={booking} invoiceId={invoice.id} sp={sp} />;

  const state = await getInvoiceState(tenant.id, invoice.id);
  const { invoice: inv, draft, current, issues, allowedRates, mode } = state;
  const word = invoiceKindWord(inv.kind);
  const changeLog = (Array.isArray(inv.changeLog) ? inv.changeLog : []) as { at: string; by: string; summary: string }[];
  const bookingLine = booking ? <Link href={`/buchungen/${booking.id}`} className="underline">{bookingLabel(booking.number)}</Link> : <span>{bookingLabel(null)}</span>;
  const log = <Card title="Änderungsprotokoll"><ul className="p-4 text-sm flex flex-col gap-1">{changeLog.length === 0 ? <li className="text-ink-3">Keine Einträge.</li> : [...changeLog].reverse().map((e, i) => <li key={i}><span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(new Date(e.at))}</span> · {e.by}: {e.summary}</li>)}</ul></Card>;

  if (draft && canEdit) {
    const { doc } = await loadInvoiceDocumentData(tenant.id, draft.id, { allowDraft: true });
    const items: EditableItem[] = draft.items.map((i) => ({
      id: i.id, description: i.description, quantity: de(i.quantity), unit: i.unit, unitPrice: de(i.unitPrice), taxRate: de(i.taxRate), source: i.source,
      sourceLabel: INVOICE_ITEM_SOURCES[i.source as keyof typeof INVOICE_ITEM_SOURCES] ?? i.source,
      net: fmtCents(toCents(i.netAmount)), tax: fmtCents(toCents(i.taxAmount)), gross: fmtCents(toCents(i.grossAmount)),
    }));
    const blockingIssues = issues.filter((i) => i.severity === "error");
    const c = draft.customerSnapshot as InvoiceCustomerSnapshot;
    const co = draft.companySnapshot as CompanySnapshot;
    const s = (v: string | null | undefined) => v ?? "";
    const kind = draft.kind as "ORIGINAL" | "REVISION" | "CORRECTION";
    const newGross = toCents(draft.grossTotal);
    const paymentPreview = mode && draft.versionNo > 1 && mode.paidCents > 0
      ? { paid: fmtCents(mode.paidCents), grossBefore: fmtCents(mode.currentGrossCents), grossAfter: fmtCents(newGross), openAfter: fmtCents(Math.max(0, newGross - mode.paidCents)), overpaid: mode.paidCents > newGross ? fmtCents(mode.paidCents - newGross) : null }
      : null;
    return (
      <>
        <PageHeader title={draft.versionNo === 1 ? `${word} (Entwurf)` : `${word} ${inv.number} · Fassung ${draft.versionNo} (Entwurf)`} sub={<>{doc.customer.name} · {bookingLine}</>}>
          <Chip tone="amber">{draft.versionNo === 1 ? "Entwurf" : kind === "CORRECTION" ? "Berichtigung in Bearbeitung" : "Neufassung in Bearbeitung"}</Chip>
          <Link href="/rechnungen" className="btn">Rechnungen</Link>
          <form action={discardInvoiceDraftAction.bind(null, null, inv.id)}><button className="btn btn-danger">Entwurf verwerfen</button></form>
        </PageHeader>
        <Content>
          {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
          {draft.versionNo === 1 && (
            <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">
              <span className="font-semibold">Freie Rechnung</span> an {doc.customer.name}{booking ? <> mit Bezug zur Buchung {booking.number} (nur Zuordnung: keine Mietpositionen, Kaution und Buchung bleiben unverändert)</> : <> ohne Buchungsbezug (keine Kaution)</>}. Die Leistungen ergeben sich aus den Positionen. Der Rechnungsempfänger wird beim Abschluss versiegelt.
            </p>
          )}
          <InvoiceIssueList issues={issues} okText="Alle Prüfungen bestanden. Die Rechnung kann abgeschlossen werden." />
          <InvoiceEditor
            defaultPaymentTermDays={tenant.paymentTermDays}
            version={draft.updatedAt.getTime()}
            versionNo={draft.versionNo}
            kind={kind}
            invoiceKind="RENTAL"
            doc={doc}
            items={items}
            allowedRates={allowedRates}
            draft={{
              customerNote: s(draft.customerNote), taxNote: s(draft.taxNote), taxTreatment: draft.taxTreatment, notes: s(inv.notes), reason: s(draft.reason), paymentTermDays: draft.paymentTermDays ?? null,
              servicePeriodStart: toDateTimeInputValue(draft.servicePeriodStart), servicePeriodEnd: toDateTimeInputValue(draft.servicePeriodEnd),
              customer: { type: c.type ?? "PRIVATE", companyName: s(c.companyName), firstName: s(c.firstName), lastName: s(c.lastName), street: s(c.street), zip: s(c.zip), city: s(c.city), country: s(c.country) || "DE", email: s(c.email), number: s(c.number) },
              company: { name: s(co.name), legalForm: s(co.legalForm), street: s(co.street), zip: s(co.zip), city: s(co.city), country: s(co.country) || "DE", email: s(co.email), phone: s(co.phone), vatId: s(co.vatId), taxNumber: s(co.taxNumber), bankName: s(co.bankName), iban: s(co.iban), bic: s(co.bic), invoiceFooter: s(co.invoiceFooter) },
            }}
            blocking={blockingIssues.length > 0}
            blockingReason={blockingIssues.length > 0 ? "Bitte zuerst die offenen Punkte aus der Prüfung lösen." : undefined}
            paymentPreview={paymentPreview}
            depositOffset={null}
            save={saveInvoiceDraftAction.bind(null, null, inv.id)}
            finalize={finalizeInvoiceAction.bind(null, null, inv.id)}
          />
          {log}
          <p className="text-xs text-ink-3">Steuersätze zur Auswahl: {allowedRates.map((r) => `${de(r)} %`).join(", ")}. 0 % nur mit Steuerhinweis.</p>
        </Content>
      </>
    );
  }

  if (!current) {
    return (
      <>
        <PageHeader title={`${word} (Entwurf)`} sub={bookingLine}><Link href="/rechnungen" className="btn">Rechnungen</Link></PageHeader>
        <Content><p className="text-sm text-ink-3">Diese Rechnung ist noch ein Entwurf. Entwürfe bearbeitet die Disposition.</p></Content>
      </>
    );
  }

  const versions = await listVersions(tenant.id, inv.id);
  const requestedNo = typeof sp.fassung === "string" ? parseInt(sp.fassung, 10) : NaN;
  const shown = versions.find((v) => v.versionNo === requestedNo && v.status === "FINALIZED") ?? versions.find((v) => v.id === current.id)!;
  const { doc } = await loadInvoiceDocumentData(tenant.id, shown.id);
  const [pay, finance] = await Promise.all([invoicePaymentSummary(tenant.id, inv.id), invoiceFinancials(tenant.id, inv.id)]);
  const currentInfo = versions.find((v) => v.id === current.id)!;
  const transmission = currentInfo.sentAt ? `Versendet ${fmtDateTime(currentInfo.sentAt)}` : currentInfo.deliveredAt ? `Übergeben ${fmtDateTime(currentInfo.deliveredAt)}` : "Noch nicht übermittelt";
  const finishedNo = typeof sp.abgeschlossen === "string" ? parseInt(sp.abgeschlossen, 10) : NaN;
  const self = `/rechnungen/${inv.id}`;
  const due = current.paymentDueDate;

  return (
    <>
      <PageHeader title={`${word} ${inv.number}`} sub={<>{doc.customer.name} · {bookingLine}</>}>
        <Chip tone="good">Finalisiert</Chip>
        {versions.length > 1 && <Chip>Aktuelle Fassung {current.versionNo}</Chip>}
        <Chip tone={currentInfo.delivered ? "info" : "amber"}>{transmission}</Chip>
        {(finance.effectiveCents > 0 || finance.paidCents > 0) && <PaymentStatusChip status={pay.status} />}
        {finance.chain !== "NONE" && <Chip tone={finance.chain === "CANCELLED" ? "bad" : "info"}>{INVOICE_CHAIN_STATUS[finance.chain]}</Chip>}
        <Link href="/rechnungen" className="btn">Rechnungen</Link>
        {canEdit && mode?.editable && <form action={startInvoiceEditAction.bind(null, null, inv.id)}><button className="btn btn-primary">Rechnung bearbeiten</button></form>}
      </PageHeader>
      <Content>
        {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
        {Number.isFinite(finishedNo) && finishedNo === current.versionNo && (
          <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">{finishedNo === 1 ? `Die Rechnung ${inv.number} ist abgeschlossen und versiegelt.` : `Fassung ${finishedNo} der Rechnung ${inv.number} ist abgeschlossen und versiegelt.`}</p>
        )}
        {Number.isFinite(finishedNo) && finishedNo === current.versionNo && <FollowUpNotice tenantId={tenant.id} bookingId={inv.bookingId} invoiceId={inv.id} invoiceVersionId={current.id} kind="INVOICE" />}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Rechnungsdatum</div><div className="font-mono tnum">{fmtDate(current.issueDate)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Fällig am</div><div className="font-mono tnum">{due ? fmtDate(due) : "–"}</div>{!due && <div className="text-[11px] text-ink-3">ohne Zahlungsziel</div>}</div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Betrag</div><div className="font-mono tnum font-semibold">{fmtCents(finance.invoiceCents)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Offen</div><div className={`font-mono tnum font-semibold ${finance.openCents > 0 ? "text-bad" : "text-good"}`}>{fmtCents(finance.openCents)}</div></div>
        </div>
        {(pay.chain !== "NONE" || finance.hasDraftCounter) && <FinancialSummary f={finance} numberLabel={inv.number ?? ""} />}
        {inv.kind === "DUNNING_FEE" && <DunningFeeNote tenantId={tenant.id} bookingId={inv.bookingId} invoiceId={inv.id} />}
        {inv.kind !== "DUNNING_FEE" && <DunningCard tenantId={tenant.id} bookingId={inv.bookingId} role={user.role} invoiceId={inv.id} />}
        <PaymentsPanel tenantId={tenant.id} bookingId={inv.bookingId} role={user.role} invoiceId={inv.id} />
        {/* Kaution nur bei Buchungsbezug – über die bestehende, bewusste Kautionsverrechnung dieser Buchung */}
        {booking && <DepositSettlementCard tenantId={tenant.id} bookingId={booking.id} role={user.role} invoice={{ id: inv.id, number: inv.number, status: "FINALIZED", grossCents: finance.effectiveCents, prepaidCents: pay.paidCents }} />}
        <CustomerCreditCard tenantId={tenant.id} bookingId={inv.bookingId} role={user.role} invoiceId={inv.id} />
        {(finance.refundRequired || finance.completedRefundCents > 0) && <PayoutPanel tenantId={tenant.id} role={user.role} sourceRef={{ sourceType: "INVOICE_REFUND", invoiceId: inv.id }} bookingId={inv.bookingId} />}
        <ChainCard tenantId={tenant.id} invoiceId={inv.id} currentId={inv.id} canEdit={canEdit} mode={mode} bookingId={null} />
        <InvoiceDocumentsCard tenantId={tenant.id} invoiceId={inv.id} role={user.role} />
        <Card title="Fassungsverlauf" right={<Chip>{versions.length === 1 ? "1 Fassung" : `${versions.length} Fassungen`}</Chip>}>
          <ul className="divide-y divide-line-soft">
            {[...versions].reverse().map((v) => (
              <li key={v.id} className={`px-4 py-3 flex flex-col gap-1.5 ${v.id === shown.id ? "bg-panel-2/60" : ""}`}>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="font-semibold">Fassung {v.versionNo}</span>
                  <Chip>{INVOICE_VERSION_KINDS[v.kind as keyof typeof INVOICE_VERSION_KINDS] ?? v.kind}</Chip>
                  {v.status === "DRAFT" ? <Chip tone="amber">Entwurf</Chip> : v.id === current.id ? <Chip tone="good">Aktuell</Chip> : <Chip tone="grey">Ersetzt</Chip>}
                </div>
                <div className="text-xs text-ink-3 flex flex-wrap gap-x-3">
                  {v.finalizedAt && <span>Finalisiert {fmtDateTime(v.finalizedAt)}{v.finalizedByName ? ` von ${v.finalizedByName}` : ""}</span>}
                  {v.sentAt && <span>Versendet {fmtDateTime(v.sentAt)}{v.sentTo ? ` an ${v.sentTo}` : ""}</span>}
                  {v.deliveredAt && <span>Übergeben {fmtDateTime(v.deliveredAt)}{v.deliveredByName ? ` von ${v.deliveredByName}` : ""}</span>}
                  <span className="font-mono tnum">{fmtCents(toCents(v.grossTotal))}</span>
                </div>
                {v.status === "FINALIZED" && (
                  <div className="flex flex-wrap gap-2 items-center">
                    {v.id !== shown.id && <Link href={v.id === current.id ? self : `${self}?fassung=${v.versionNo}`} className="btn !py-2">Anzeigen</Link>}
                    {canEdit && !v.delivered && <MarkDeliveredForm action={markDeliveredAction.bind(null, null, inv.id)} versionId={v.id} versionNo={v.versionNo} />}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
        <InvoiceDocumentView doc={doc} />
        {canEdit && log}
      </Content>
    </>
  );
}

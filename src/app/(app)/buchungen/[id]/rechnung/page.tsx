import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { DAMAGE_TAX_TREATMENTS, EXTRA_CHARGE_TYPES, INVOICE_CHAIN_STATUS, INVOICE_ITEM_SOURCES, INVOICE_VERSION_KINDS, invoiceKindWord, isSideInvoice, type DamageTaxTreatment, type ExtraChargeType } from "@/lib/constants";
import { loadInvoiceDocumentData } from "@/lib/document-data";
import { customerName, fmtDateTime, fmtEur } from "@/lib/format";
import { getInvoiceState, invoiceSettingsMissing, listVersions, type CompanySnapshot, type InvoiceCustomerSnapshot, type VersionDiff } from "@/lib/invoices";
import { fmtCents, toCents } from "@/lib/money";
import { invoicePaymentSummary } from "@/lib/payments";
import { invoiceFinancials } from "@/lib/counter-documents";
import { toDateTimeInputValue } from "@/lib/time";
import { Card, Chip, Content, PageHeader, Plate } from "@/components/ui";
import { DocumentsPanel } from "../dokumente/documents-panel";
import { FollowUpNotice } from "../dokumente/follow-up-notice";
import { PaymentsPanel, PaymentStatusChip } from "../finanzen/panels";
import { createInvoiceAction, discardInvoiceDraftAction, finalizeInvoiceAction, markDeliveredAction, saveInvoiceDraftAction, startInvoiceEditAction } from "./actions";
import { InvoiceEditor, type EditableItem } from "./invoice-editor";
import { InvoiceDocumentView, InvoiceIssueList } from "./invoice-parts";
import { MarkDeliveredForm } from "./version-forms";
import { ChainCard, CounterDocumentPage, FinancialSummary } from "./counter-document";
import { PayoutPanel } from "../../../auszahlungen/payout-panel";

export const metadata = { title: "Rechnung" };

const de = (v: unknown, digits = 2) => Number(String(v)).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default async function InvoicePage({ params, searchParams }: PageProps<"/buchungen/[id]/rechnung">) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const { id } = await params;
  const sp = await searchParams;

  const b = await db.booking.findFirst({
    where: { id, tenantId: tenant.id },
    include: { vehicle: true, customer: true, contract: { select: { number: true, status: true, totalAmount: true } }, handovers: { where: { correctsId: null, type: "RETURN", status: "FINALIZED" }, select: { id: true, number: true } } },
  });
  if (!b) notFound();
  const canEdit = user.role !== "YARD";
  // Ohne nr: die Mietrechnung. Mit nr: eine bestimmte Rechnung dieser Buchung, z. B. eine Schadenabrechnung.
  const requestedId = typeof sp.nr === "string" ? sp.nr : null;
  const invoice = requestedId
    ? await db.invoice.findFirst({ where: { id: requestedId, bookingId: b.id, tenantId: tenant.id, status: { in: ["DRAFT", "FINALIZED"] } } })
    : await db.invoice.findFirst({ where: { bookingId: b.id, tenantId: tenant.id, kind: "RENTAL", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
  if (requestedId && !invoice) notFound();
  const key = isSideInvoice(invoice?.kind) || (invoice && invoice.documentType !== "INVOICE") ? invoice!.id : null;
  const self = `/buchungen/${b.id}/rechnung${key ? `?nr=${key}` : ""}`;
  const selfWith = (q: string) => `${self}${self.includes("?") ? "&" : "?"}${q}`;
  const damageCase = invoice?.damageCaseId ? await db.damageCase.findFirst({ where: { id: invoice.damageCaseId, tenantId: tenant.id }, select: { id: true, caseNumber: true, customerChargeBasis: true } }) : null;
  const authorityCase = invoice?.authorityCaseId ? await db.authorityCase.findFirst({ where: { id: invoice.authorityCaseId, tenantId: tenant.id }, select: { id: true, caseNumber: true, authorityName: true, authorityReference: true } }) : null;
  const kindLabel = invoiceKindWord(invoice?.kind);
  const feeNote = authorityCase ? <div className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm"><span className="font-semibold">Bearbeitungsentgelt zum Behördenvorgang {authorityCase.caseNumber}</span> ({authorityCase.authorityName}, Az. {authorityCase.authorityReference}). Grundlage ist das im Mietvertrag vereinbarte Bearbeitungsentgelt für Behördenanfragen. Das Bußgeld selbst wird nicht weiterberechnet; diese Rechnung ist von der Mietrechnung getrennt.</div> : null;

  // Hofmitarbeiter: nur abgeschlossene Rechnungen, kein Entwurf und keine Neuanlage (serverseitig auch in den Actions)
  if (!canEdit && invoice?.status !== "FINALIZED") redirect(`/buchungen/${b.id}`);
  // Gutschrift oder Stornobeleg: eigene Seite (Entwurf mit Abschluss oder abgeschlossener Beleg)
  if (invoice && invoice.documentType !== "INVOICE") return <CounterDocumentPage tenantId={tenant.id} role={user.role} booking={{ id: b.id, number: b.number, vehicle: { plate: b.vehicle.plate } }} invoiceId={invoice.id} sp={sp} />;

  if (!invoice) {
    const ret = b.handovers[0];
    const ready = b.status === "RETURNED" && b.contract?.status === "SIGNED" && !!ret;
    const missing = invoiceSettingsMissing(tenant);
    const create = createInvoiceAction.bind(null, b.id);
    return (
      <>
        <PageHeader title="Rechnung" sub={<>Buchung {b.number} · <Plate>{b.vehicle.plate}</Plate></>}>
          <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content>
          {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
          <Card className="p-5 flex flex-col gap-4 max-w-2xl">
            <div>
              <h2 className="font-semibold text-lg">Rechnung zur Buchung {b.number} erstellen</h2>
              <p className="text-sm text-ink-2 mt-1">Der Entwurf wird aus dem abgeschlossenen Mietvertrag und den bei der Rückgabe bestätigten Zusatzkosten vorbefüllt. Vorschläge und ungeklärte Schäden werden nicht übernommen. Beträge lassen sich im Entwurf anpassen; die Rechnungsnummer vergibt das System erst beim Abschluss.</p>
            </div>
            <dl className="grid grid-cols-[150px_1fr] gap-y-1.5 text-sm">
              <dt className="label-xs self-center">Kunde</dt><dd>{customerName(b.customer)}</dd>
              <dt className="label-xs self-center">Mietvertrag</dt><dd>{b.contract?.status === "SIGNED" ? b.contract.number : <span className="text-bad">nicht abgeschlossen</span>}</dd>
              <dt className="label-xs self-center">Rückgabe</dt><dd>{ret ? ret.number : <span className="text-bad">nicht abgeschlossen</span>}</dd>
              <dt className="label-xs self-center">Buchungsstatus</dt><dd>{b.status === "RETURNED" ? "Zurückgegeben" : <span className="text-bad">noch nicht zurückgegeben</span>}</dd>
            </dl>
            {!ready && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">Eine Rechnung wird erst nach abgeschlossener Rückgabe erstellt. So stehen alle Zusatzkosten fest, bevor abgerechnet wird.</p>}
            {missing.length > 0 && (
              <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">
                <div className="font-semibold">Bevor Rechnungen erstellt werden können, fehlen Angaben in den Einstellungen:</div>
                <ul className="list-disc pl-5 mt-1">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
                <div className="mt-1">{user.role === "OWNER" ? <Link href="/einstellungen" className="underline">Zu den Einstellungen</Link> : "Nur der Inhaber kann diese Angaben pflegen."} Steuersatz und Brutto/Netto-Angabe werden für jede Position gebraucht, deshalb gibt es ohne sie keinen Entwurf.</div>
              </div>
            )}
            <form action={create}><button className="btn btn-primary" disabled={!ready || missing.length > 0}>Rechnung erstellen</button></form>
          </Card>
        </Content>
      </>
    );
  }

  const state = await getInvoiceState(tenant.id, invoice.id);
  const { invoice: inv, draft, current, issues, allowedRates, mode } = state;
  const changeLog = (Array.isArray(inv.changeLog) ? inv.changeLog : []) as { at: string; by: string; summary: string; versionNo?: number }[];

  // Hofmitarbeiter sehen keinen Entwurf; mit Entwurf und Bearbeitungsrecht: Editor
  if (draft && canEdit) {
    const { doc } = await loadInvoiceDocumentData(tenant.id, draft.id, { allowDraft: true });
    const charges = draft.versionNo === 1 && inv.returnHandoverId ? await db.extraCharge.findMany({ where: { tenantId: tenant.id, handoverId: inv.returnHandoverId }, orderBy: { createdAt: "asc" } }) : [];
    const items: EditableItem[] = draft.items.map((i) => ({
      id: i.id, description: i.description, quantity: de(i.quantity), unit: i.unit, unitPrice: de(i.unitPrice), taxRate: de(i.taxRate), source: i.source,
      sourceLabel: INVOICE_ITEM_SOURCES[i.source as keyof typeof INVOICE_ITEM_SOURCES] ?? i.source,
      net: fmtCents(toCents(i.netAmount)), tax: fmtCents(toCents(i.taxAmount)), gross: fmtCents(toCents(i.grossAmount)),
    }));
    const included = new Set(draft.items.map((i) => i.extraChargeId).filter(Boolean));
    const blockingIssues = issues.filter((i) => i.severity === "error");
    const c = draft.customerSnapshot as InvoiceCustomerSnapshot;
    const co = draft.companySnapshot as CompanySnapshot;
    const s = (v: string | null | undefined) => v ?? "";
    const kind = draft.kind as "ORIGINAL" | "REVISION" | "CORRECTION";
    const newGross = toCents(draft.grossTotal);
    // Erste Fassung der Mietrechnung: vorab an der Buchung erfasste Mietzahlungen werden beim Abschluss zugeordnet
    const prepaidCents = draft.versionNo === 1 && inv.kind === "RENTAL"
      ? (await db.payment.aggregate({ where: { tenantId: tenant.id, bookingId: b.id, type: "RENTAL_PAYMENT", invoiceId: null, status: "CONFIRMED" }, _sum: { amountCents: true } }))._sum.amountCents ?? 0
      : 0;
    const paymentPreview = mode && draft.versionNo > 1 && mode.paidCents > 0
      ? { paid: fmtCents(mode.paidCents), grossBefore: fmtCents(mode.currentGrossCents), grossAfter: fmtCents(newGross), openAfter: fmtCents(Math.max(0, newGross - mode.paidCents)), overpaid: mode.paidCents > newGross ? fmtCents(mode.paidCents - newGross) : null }
      : prepaidCents > 0
        ? { paid: fmtCents(prepaidCents), grossBefore: "–", grossAfter: fmtCents(newGross), openAfter: fmtCents(Math.max(0, newGross - prepaidCents)), overpaid: prepaidCents > newGross ? fmtCents(prepaidCents - newGross) : null }
        : null;
    const title = draft.versionNo === 1 ? `${kindLabel} (Entwurf)` : `${kindLabel} ${inv.number} · Fassung ${draft.versionNo} (Entwurf)`;
    return (
      <>
        <PageHeader title={title} sub={<>Buchung {b.number} · {doc.customer.name}{damageCase ? <> · Schadenakte {damageCase.caseNumber}</> : null}{authorityCase ? <> · Behördenvorgang {authorityCase.caseNumber}</> : null}</>}>
          <Chip tone="amber">{draft.versionNo === 1 ? "Entwurf" : kind === "CORRECTION" ? "Berichtigung in Bearbeitung" : "Neufassung in Bearbeitung"}</Chip>
          {damageCase && <Link href={`/schaeden/${damageCase.id}`} className="btn">Zur Schadenakte</Link>}
          {authorityCase && <Link href={`/behoerden/${authorityCase.id}`} className="btn">Zum Behördenvorgang</Link>}
          <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
          <form action={discardInvoiceDraftAction.bind(null, b.id, key)}><button className="btn btn-danger">Entwurf verwerfen</button></form>
        </PageHeader>
        <Content>
          {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
          {inv.kind === "DAMAGE" && damageCase && (
            <div className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">
              <span className="font-semibold">Schadenabrechnung zur Schadenakte {damageCase.caseNumber}.</span> Steuerliche Behandlung dieser Fassung: {DAMAGE_TAX_TREATMENTS[draft.taxTreatment as DamageTaxTreatment] ?? "noch nicht festgelegt"}. Grundlage: {damageCase.customerChargeBasis ?? "–"}. Diese Rechnung ist von der Mietrechnung getrennt; Kaution und Forderung wurden nicht miteinander verrechnet.
            </div>
          )}
          {feeNote}
          {draft.versionNo > 1 && mode && (
            <div className={`rounded-md px-3.5 py-2.5 text-sm ${mode.delivered ? "bg-amber-soft text-amber" : "bg-info-soft text-info"}`}>
              {mode.delivered ? (
                <><span className="font-semibold">Der Kunde hat bereits eine frühere Fassung dieser Rechnung erhalten</span> ({mode.reasons.join("; ")}). Beim Finalisieren wird eine berichtigte Rechnungsfassung erstellt und die bisherige Fassung bleibt archiviert. Der Grund der Berichtigung ist Pflicht.</>
              ) : (
                <>Diese Rechnung wurde dem Kunden noch nicht übermittelt. Beim erneuten Finalisieren wird eine neue Fassung unter derselben Rechnungsnummer erstellt; die bisherige Fassung bleibt archiviert.</>
              )}
              {mode.paidCents > 0 && <> Zu dieser Rechnung sind bereits Zahlungen über {fmtCents(mode.paidCents)} dokumentiert; die Differenz wird vor dem Abschluss angezeigt.</>}
            </div>
          )}
          <InvoiceIssueList issues={issues} okText="Alle Prüfungen bestanden. Die Rechnung kann abgeschlossen werden." />
          {draft.versionNo === 1 && inv.kind === "RENTAL" && (
            <Card title="Quellen des Entwurfs" right={<Chip>nur bestätigte Beträge</Chip>}>
              <div className="p-4 text-sm flex flex-col gap-1.5">
                <div className="flex justify-between gap-3"><span>Mietpreis laut Mietvertrag {doc.reference.contractNumber}</span><span className="font-mono tnum">{fmtEur(Number(b.contract?.totalAmount ?? 0))}</span></div>
                {charges.length === 0 && <span className="text-ink-3">Bei der Rückgabe wurden keine Zusatzkosten bestätigt.</span>}
                {charges.map((ch) => (
                  <div key={ch.id} className="flex justify-between gap-3">
                    <span>{EXTRA_CHARGE_TYPES[ch.type as ExtraChargeType] ?? ch.type}: {ch.description}{!included.has(ch.id) && <span className="text-amber text-xs ml-2">aus der Rechnung entfernt</span>}</span>
                    <span className="font-mono tnum">{fmtEur(Number(ch.amount))}</span>
                  </div>
                ))}
                {prepaidCents > 0 && <div className="flex justify-between gap-3 border-t border-line-soft pt-1.5 mt-1"><span>Vorab erfasste Mietzahlungen (werden beim Abschluss dieser Rechnung zugeordnet, keine Kaution)</span><span className="font-mono tnum">{fmtCents(prepaidCents)}</span></div>}
                <p className="text-xs text-ink-3 mt-1">Vertrag und Rückgabe sind versiegelt; die Beträge oben sind die Quellen, die Positionen unten die Rechnung. Schäden erscheinen nur, wenn bei der Rückgabe eine Zusatzkostenposition dafür bestätigt wurde.</p>
              </div>
            </Card>
          )}
          {draft.versionNo > 1 && <p className="text-xs text-ink-3">Dieser Entwurf startet aus dem Snapshot der Fassung {draft.versionNo - 1}, nicht aus aktuellen Kunden-, Vertrags- oder Einstellungsdaten. Änderungen wirken nur auf diese Rechnung.</p>}
          <InvoiceEditor
            version={draft.updatedAt.getTime()}
            versionNo={draft.versionNo}
            kind={kind}
            invoiceKind={inv.kind === "DAMAGE" ? "DAMAGE" : "RENTAL"}
            doc={doc}
            items={items}
            allowedRates={allowedRates}
            draft={{
              customerNote: s(draft.customerNote), taxNote: s(draft.taxNote), taxTreatment: draft.taxTreatment, notes: s(inv.notes), reason: s(draft.reason), paymentTermDays: draft.paymentTermDays ?? (draft.versionNo === 1 ? tenant.paymentTermDays : null) ?? null,
              servicePeriodStart: toDateTimeInputValue(draft.servicePeriodStart), servicePeriodEnd: toDateTimeInputValue(draft.servicePeriodEnd),
              customer: { type: c.type ?? "PRIVATE", companyName: s(c.companyName), firstName: s(c.firstName), lastName: s(c.lastName), street: s(c.street), zip: s(c.zip), city: s(c.city), country: s(c.country) || "DE", email: s(c.email), number: s(c.number) },
              company: { name: s(co.name), legalForm: s(co.legalForm), street: s(co.street), zip: s(co.zip), city: s(co.city), country: s(co.country) || "DE", email: s(co.email), phone: s(co.phone), vatId: s(co.vatId), taxNumber: s(co.taxNumber), bankName: s(co.bankName), iban: s(co.iban), bic: s(co.bic), invoiceFooter: s(co.invoiceFooter) },
            }}
            blocking={blockingIssues.length > 0}
            blockingReason={blockingIssues.length > 0 ? "Bitte zuerst die offenen Punkte aus der Prüfung lösen." : undefined}
            paymentPreview={paymentPreview}
            save={saveInvoiceDraftAction.bind(null, b.id, key)}
            finalize={finalizeInvoiceAction.bind(null, b.id, key)}
          />
          <Card title="Änderungsprotokoll"><div className="p-4 text-sm"><ChangeLog entries={changeLog} /></div></Card>
          <p className="text-xs text-ink-3">Steuersätze zur Auswahl: {allowedRates.map((r) => `${de(r)} %`).join(", ")} (Standardsatz aus den Einstellungen, 0 % nur mit Steuerhinweis, dazu die in der Fassung bereits verwendeten Sätze).</p>
        </Content>
      </>
    );
  }

  if (!current) redirect(`/buchungen/${b.id}`);

  // Abgeschlossene Rechnung: aktuelle Fassung oder eine historische (?fassung=n) nur lesend
  const versions = await listVersions(tenant.id, inv.id);
  const requestedNo = typeof sp.fassung === "string" ? parseInt(sp.fassung, 10) : NaN;
  const shown = versions.find((v) => v.versionNo === requestedNo && v.status === "FINALIZED") ?? versions.find((v) => v.id === current.id)!;
  const { doc } = await loadInvoiceDocumentData(tenant.id, shown.id);
  const pay = await invoicePaymentSummary(tenant.id, inv.id);
  const finance = await invoiceFinancials(tenant.id, inv.id);
  const currentInfo = versions.find((v) => v.id === current.id)!;
  const transmission = currentInfo.sentAt ? `Versendet ${fmtDateTime(currentInfo.sentAt)}` : currentInfo.deliveredAt ? `Übergeben ${fmtDateTime(currentInfo.deliveredAt)}` : "Noch nicht übermittelt";
  const docs = await db.document.findMany({ where: { tenantId: tenant.id, type: "INVOICE", invoiceId: inv.id }, orderBy: { version: "desc" }, select: { id: true, invoiceVersionId: true, fileName: true } });
  const docOf = (versionId: string) => docs.find((d) => d.invoiceVersionId === versionId);
  const finishedNo = typeof sp.abgeschlossen === "string" ? parseInt(sp.abgeschlossen, 10) : NaN;

  return (
    <>
      <PageHeader title={`${kindLabel} ${inv.number}`} sub={<>Buchung {b.number} · {doc.customer.name}{damageCase ? <> · Schadenakte {damageCase.caseNumber}</> : null}{authorityCase ? <> · Behördenvorgang {authorityCase.caseNumber}</> : null}</>}>
        <Chip tone="good">Finalisiert</Chip>
        <Chip>Aktuelle Fassung {current.versionNo}</Chip>
        <Chip tone={currentInfo.delivered ? "info" : "amber"}>{transmission}</Chip>
        {(finance.effectiveCents > 0 || finance.paidCents > 0) && <PaymentStatusChip status={pay.status} />}
        {finance.chain !== "NONE" && <Chip tone={finance.chain === "CANCELLED" ? "bad" : "info"}>{INVOICE_CHAIN_STATUS[finance.chain]}</Chip>}
        {damageCase && <Link href={`/schaeden/${damageCase.id}`} className="btn">Zur Schadenakte</Link>}
          {authorityCase && <Link href={`/behoerden/${authorityCase.id}`} className="btn">Zum Behördenvorgang</Link>}
        <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
        {canEdit && mode?.editable && <form action={startInvoiceEditAction.bind(null, b.id, key)}><button className="btn btn-primary">Rechnung bearbeiten</button></form>}
      </PageHeader>
      <Content>
        {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
        {inv.kind === "DAMAGE" && damageCase && (
          <div className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">
            <span className="font-semibold">Schadenabrechnung zur Schadenakte {damageCase.caseNumber}.</span> Steuerliche Behandlung (Fassung {shown.versionNo}): {DAMAGE_TAX_TREATMENTS[shown.taxTreatment as DamageTaxTreatment] ?? "–"}. Diese Rechnung ist von der Mietrechnung getrennt; Kaution und Forderung wurden nicht miteinander verrechnet.
          </div>
        )}
        {feeNote}
        {Number.isFinite(finishedNo) && finishedNo === current.versionNo && (
          <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">
            {finishedNo === 1 ? `Die Rechnung ${inv.number} ist abgeschlossen und versiegelt.` : `Fassung ${finishedNo} der Rechnung ${inv.number} ist abgeschlossen und versiegelt (${INVOICE_VERSION_KINDS[current.kind as keyof typeof INVOICE_VERSION_KINDS]}). Fassung ${finishedNo - 1} bleibt archiviert.`} Rechnungsbetrag {fmtCents(toCents(current.grossTotal))}.
          </p>
        )}
        {Number.isFinite(finishedNo) && finishedNo === current.versionNo && <FollowUpNotice tenantId={tenant.id} bookingId={b.id} invoiceId={inv.id} invoiceVersionId={current.id} kind="INVOICE" />}
        {mode && !mode.editable && mode.blockedReason && <p className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm font-medium">{mode.blockedReason}</p>}
        {pay.status === "OVERPAID" && finance.refundRemainingCents > 0 && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm font-medium">Erstattung erforderlich: wirksame Forderung {fmtCents(pay.grossCents)}, bezahlt {fmtCents(pay.paidCents)}, Kundenguthaben {fmtCents(pay.overpaidCents)}, bereits ausgezahlt {fmtCents(finance.completedRefundCents)}, noch auszuzahlen {fmtCents(finance.refundRemainingCents)}. Offen ist 0,00 €. Rent-Base führt keine automatische Erstattung und keine Verrechnung durch; die Auszahlung wird unten erfasst.</p>}
        {pay.status === "OVERPAID" && finance.refundRemainingCents === 0 && <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Kundenguthaben {fmtCents(pay.overpaidCents)} wurde vollständig ausgezahlt ({fmtCents(finance.completedRefundCents)}). Nichts mehr auszuzahlen.</p>}
        {(pay.chain !== "NONE" || finance.hasDraftCounter) && <FinancialSummary f={finance} numberLabel={inv.number ?? ""} />}
        <ChainCard tenantId={tenant.id} invoiceId={inv.id} currentId={inv.id} canEdit={canEdit} mode={mode} bookingId={b.id} />
        {shown.id !== current.id && <p className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm font-medium">Sie sehen die ersetzte Fassung {shown.versionNo}. <Link href={self} className="underline">Zur aktuellen Fassung {current.versionNo}</Link>.</p>}

        <Card title="Fassungsverlauf" right={<Chip>{versions.length === 1 ? "1 Fassung" : `${versions.length} Fassungen`}</Chip>}>
          <ul className="divide-y divide-line-soft">
            {[...versions].reverse().map((v) => {
              const d = docOf(v.id);
              const isCurrent = v.id === current.id;
              return (
                <li key={v.id} className={`px-4 py-3 flex flex-col gap-1.5 ${v.id === shown.id ? "bg-panel-2/60" : ""}`}>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="font-semibold">Fassung {v.versionNo}</span>
                    <Chip>{INVOICE_VERSION_KINDS[v.kind as keyof typeof INVOICE_VERSION_KINDS] ?? v.kind}</Chip>
                    {v.status === "DRAFT" ? <Chip tone="amber">Entwurf</Chip> : isCurrent ? <Chip tone="good">Aktuell</Chip> : <Chip tone="grey">Ersetzt</Chip>}
                  </div>
                  <div className="text-xs text-ink-3 flex flex-wrap gap-x-3">
                    {v.finalizedAt && <span>Finalisiert {fmtDateTime(v.finalizedAt)}{v.finalizedByName ? ` von ${v.finalizedByName}` : ""}</span>}
                    {v.sentAt && <span>Versendet {fmtDateTime(v.sentAt)}{v.sentTo ? ` an ${v.sentTo}` : ""}</span>}
                    {v.deliveredAt && <span>Übergeben {fmtDateTime(v.deliveredAt)}{v.deliveredByName ? ` von ${v.deliveredByName}` : ""}{v.deliveredNote ? ` (${v.deliveredNote})` : ""}</span>}
                    {!v.sentAt && !v.deliveredAt && v.status === "FINALIZED" && <span>Noch nicht übermittelt</span>}
                    <span className="font-mono tnum">{fmtCents(toCents(v.grossTotal))}</span>
                  </div>
                  {v.reason && v.kind === "CORRECTION" && <div className="text-sm">Grund: {v.reason}</div>}
                  {v.status === "FINALIZED" && (
                    <div className="flex flex-wrap gap-2 items-center">
                      {v.id !== shown.id && <Link href={isCurrent ? self : selfWith(`fassung=${v.versionNo}`)} className="btn !py-1.5">Anzeigen</Link>}
                      {d ? <a href={`/api/documents/${d.id}?download=1`} className="btn !py-1.5">PDF</a> : <span className="text-xs text-ink-3">PDF noch nicht erzeugt{isCurrent ? " (siehe Dokumente)" : ""}</span>}
                      {canEdit && !v.delivered && <MarkDeliveredForm action={markDeliveredAction.bind(null, b.id, key)} versionId={v.id} versionNo={v.versionNo} />}
                    </div>
                  )}
                  {v.status === "DRAFT" && canEdit && <Link href={self} className="btn btn-primary !py-1.5 self-start">Entwurf fortsetzen</Link>}
                </li>
              );
            })}
          </ul>
        </Card>

        {shown.id === current.id && <DocumentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} invoiceId={inv.id} />}
        {shown.id === current.id && <PaymentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} invoiceId={inv.id} />}
        {shown.id === current.id && (finance.refundRequired || finance.completedRefundCents > 0) && <PayoutPanel tenantId={tenant.id} role={user.role} sourceRef={{ sourceType: "INVOICE_REFUND", invoiceId: inv.id }} bookingId={b.id} />}
        <InvoiceDocumentView doc={doc} />
        {shown.diffFromPrevious && <DiffCard diff={shown.diffFromPrevious as unknown as VersionDiff} />}
        {canEdit && (
          <Card title="Intern (nicht auf der Rechnung)">
            <div className="p-4 text-sm flex flex-col gap-2">
              <div><span className="label-xs">Interne Notiz</span><div className="whitespace-pre-line">{inv.notes || "–"}</div></div>
              <ChangeLog entries={changeLog} />
            </div>
          </Card>
        )}
      </Content>
    </>
  );
}

function DiffCard({ diff }: { diff: VersionDiff }) {
  return (
    <Card title={`Änderungen gegenüber Fassung ${diff.fromVersion}`} right={<Chip>{diff.entries.length} {diff.entries.length === 1 ? "Änderung" : "Änderungen"}</Chip>}>
      <div className="p-4 text-sm flex flex-col gap-2">
        {diff.entries.length === 0 && <span className="text-ink-3">Keine inhaltlichen Änderungen.</span>}
        {diff.entries.map((e) => (
          <div key={e.field} className="grid grid-cols-1 md:grid-cols-[180px_1fr_1fr] gap-x-3 gap-y-0.5 border-b border-line-soft pb-2 last:border-0">
            <div className="label-xs self-start">{e.label}</div>
            <div className="text-ink-3 line-through break-words">{e.before ?? "–"}</div>
            <div className="break-words">{e.after ?? "–"}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ChangeLog({ entries }: { entries: { at: string; by: string; summary: string; versionNo?: number }[] }) {
  if (entries.length === 0) return <span className="text-ink-3">Keine Einträge.</span>;
  return (
    <ul className="divide-y divide-line-soft">
      {entries.map((e, i) => (
        <li key={i} className="py-1.5 flex flex-wrap gap-x-2 items-baseline"><span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(new Date(e.at))}</span><span className="text-xs text-ink-3">{e.by}</span>{e.versionNo ? <span className="text-xs text-ink-3">F{e.versionNo}</span> : null}<span>{e.summary}</span></li>
      ))}
    </ul>
  );
}

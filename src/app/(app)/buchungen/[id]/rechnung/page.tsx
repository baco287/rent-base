import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { EXTRA_CHARGE_TYPES, INVOICE_ITEM_SOURCES, type ExtraChargeType } from "@/lib/constants";
import { loadInvoiceDocumentData } from "@/lib/document-data";
import { customerName, fmtDateTime, fmtEur } from "@/lib/format";
import { getInvoiceState, invoiceSettingsMissing } from "@/lib/invoices";
import { fmtCents, toCents } from "@/lib/money";
import { Card, Chip, Content, PageHeader, Plate } from "@/components/ui";
import { DocumentsPanel } from "../dokumente/documents-panel";
import { FollowUpNotice } from "../dokumente/follow-up-notice";
import { createInvoiceAction, discardInvoiceDraftAction, finalizeInvoiceAction, saveInvoiceDraftAction } from "./actions";
import { InvoiceEditor, type EditableItem } from "./invoice-editor";
import { InvoiceDocumentView, InvoiceHeadCards, InvoiceIssueList } from "./invoice-parts";

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
  const invoice = await db.invoice.findFirst({ where: { bookingId: b.id, tenantId: tenant.id, status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });

  // Hofmitarbeiter: nur die abgeschlossene Rechnung, kein Entwurf und keine Neuanlage (serverseitig auch in den Actions)
  if (!canEdit && invoice?.status !== "FINALIZED") redirect(`/buchungen/${b.id}`);

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

  const { invoice: inv, issues, allowedRates } = await getInvoiceState(tenant.id, invoice.id);
  const { doc } = await loadInvoiceDocumentData(tenant.id, inv.id, { allowDraft: true });
  const changeLog = (Array.isArray(inv.changeLog) ? inv.changeLog : []) as { at: string; by: string; summary: string }[];

  if (inv.status === "FINALIZED") {
    return (
      <>
        <PageHeader title={`Rechnung ${inv.number}`} sub={<>Buchung {b.number} · {doc.customer.name}</>}>
          <Chip tone="good">Abgeschlossen</Chip>
          <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content>
          {sp.abgeschlossen === "1" && <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">Die Rechnung {inv.number} ist abgeschlossen und versiegelt. Rechnungsbetrag {doc.totals.gross}.</p>}
          {sp.abgeschlossen === "1" && <FollowUpNotice tenantId={tenant.id} bookingId={b.id} invoiceId={inv.id} kind="INVOICE" />}
          <DocumentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} />
          <InvoiceDocumentView doc={doc} />
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

  // Entwurf: Bearbeitung nur für Inhaber und Disposition (Hofmitarbeiter wurden oben umgeleitet)
  const charges = inv.returnHandoverId ? await db.extraCharge.findMany({ where: { tenantId: tenant.id, handoverId: inv.returnHandoverId }, orderBy: { createdAt: "asc" } }) : [];
  const items: EditableItem[] = inv.items.map((i) => ({
    id: i.id,
    description: i.description,
    quantity: de(i.quantity),
    unit: i.unit,
    unitPrice: de(i.unitPrice),
    taxRate: de(i.taxRate),
    source: i.source,
    sourceLabel: INVOICE_ITEM_SOURCES[i.source as keyof typeof INVOICE_ITEM_SOURCES] ?? i.source,
    net: fmtCents(toCents(i.netAmount)),
    tax: fmtCents(toCents(i.taxAmount)),
    gross: fmtCents(toCents(i.grossAmount)),
  }));
  const included = new Set(inv.items.map((i) => i.extraChargeId).filter(Boolean));
  const blockingIssues = issues.filter((i) => i.severity === "error");
  const save = saveInvoiceDraftAction.bind(null, b.id);
  const finalize = finalizeInvoiceAction.bind(null, b.id);
  const discard = discardInvoiceDraftAction.bind(null, b.id);

  return (
    <>
      <PageHeader title="Rechnung (Entwurf)" sub={<>Buchung {b.number} · {doc.customer.name}</>}>
        <Chip tone="amber">Entwurf</Chip>
        <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
        <form action={discard}><button className="btn btn-danger">Entwurf verwerfen</button></form>
      </PageHeader>
      <Content>
        {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
        <InvoiceIssueList issues={issues} okText="Alle Prüfungen bestanden. Die Rechnung kann abgeschlossen werden." />
        <InvoiceHeadCards doc={doc} />

        <Card title="Quellen des Entwurfs" right={<Chip>nur bestätigte Beträge</Chip>}>
          <div className="p-4 text-sm flex flex-col gap-1.5">
            <div className="flex justify-between gap-3"><span>Mietpreis laut Mietvertrag {doc.reference.contractNumber}</span><span className="font-mono tnum">{fmtEur(Number(b.contract?.totalAmount ?? 0))}</span></div>
            {charges.length === 0 && <span className="text-ink-3">Bei der Rückgabe wurden keine Zusatzkosten bestätigt.</span>}
            {charges.map((c) => (
              <div key={c.id} className="flex justify-between gap-3">
                <span>{EXTRA_CHARGE_TYPES[c.type as ExtraChargeType] ?? c.type}: {c.description}{!included.has(c.id) && <span className="text-amber text-xs ml-2">aus der Rechnung entfernt</span>}</span>
                <span className="font-mono tnum">{fmtEur(Number(c.amount))}</span>
              </div>
            ))}
            <p className="text-xs text-ink-3 mt-1">Vertrag und Rückgabe sind versiegelt; die Beträge oben sind die Quellen, die Positionen unten die Rechnung. Schäden erscheinen nur, wenn bei der Rückgabe eine Zusatzkostenposition dafür bestätigt wurde.</p>
          </div>
        </Card>

        <InvoiceEditor
          version={inv.updatedAt.getTime()}
          doc={doc}
          items={items}
          allowedRates={allowedRates}
          draft={{ customerNote: inv.customerNote ?? "", taxNote: inv.taxNote ?? "", notes: inv.notes ?? "", paymentTermDays: inv.paymentTermDays ?? tenant.paymentTermDays ?? null }}
          blocking={blockingIssues.length > 0}
          blockingReason={blockingIssues.length > 0 ? "Bitte zuerst die offenen Punkte aus der Prüfung lösen." : undefined}
          save={save}
          finalize={finalize}
        />
        <Card title="Änderungsprotokoll"><div className="p-4 text-sm"><ChangeLog entries={changeLog} /></div></Card>
        <p className="text-xs text-ink-3">Steuersätze zur Auswahl: {allowedRates.map((r) => `${de(r)} %`).join(", ")} (Standardsatz aus den Einstellungen; 0 % nur mit Steuerhinweis).</p>
      </Content>
    </>
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

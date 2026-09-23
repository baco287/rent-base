import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { PAYOUT_METHODS, PAYOUT_SOURCE_TYPES, type PayoutMethod, type PayoutSourceType } from "@/lib/constants";
import { customerName, fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { buildPayoutDocument } from "@/lib/payout-view";
import { getPayout, verifyPayout } from "@/lib/payouts";
import { toDateTimeInputValue } from "@/lib/time";
import { db } from "@/lib/db";
import { cancelPayoutAction, completePayoutAction, generatePayoutPdfAction, previewPayoutAction, sendPayoutReceiptAction, updatePayoutDraftAction } from "../actions";
import { AttachmentUploader, CancelPayoutForm, CompleteDraftForm, PayoutActionButton, PayoutForm, SendReceiptForm } from "../payout-forms";
import { PayoutStatusChip } from "../payout-panel";

export const metadata = { title: "Auszahlung" };

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Eine Auszahlung: Stand, Quelle, Beleg (PDF), Nachweise, Versand, Storno. Bankdaten nur verschleiert; volle IBAN nur für Inhaber/Disponent auf Wunsch. */
export default async function PayoutPage({ params }: PageProps<"/auszahlungen/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const p = await getPayout(tenant.id, id);
  if (!p) notFound();
  const canManage = user.role !== "YARD";
  const tenantRow = await db.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { name: true, legalForm: true, street: true, zip: true, city: true, phone: true, email: true } });
  const doc = buildPayoutDocument(p, tenantRow);
  const receipt = p.documents.filter((d) => d.type === "PAYOUT_RECEIPT").sort((a, b) => b.version - a.version)[0] ?? null;
  const attachments = p.documents.filter((d) => d.type === "PAYOUT_ATTACHMENT");
  const check = p.contentHash ? await verifyPayout(tenant.id, p.id) : null;
  const sourceRef = p.sourceType === "INVOICE_REFUND" ? { sourceType: "INVOICE_REFUND" as const, invoiceId: p.invoiceId! } : { sourceType: "SECURITY_DEPOSIT_REFUND" as const, bookingId: p.bookingId };
  const sourceHref = p.sourceType === "INVOICE_REFUND" ? `/buchungen/${p.bookingId}/rechnung?nr=${p.invoiceId}` : `/buchungen/${p.bookingId}#kaution`;
  const snapshot = doc.snapshot;
  const remainingNow = p.sourceNow?.remainingCents ?? 0;

  return (
    <>
      <PageHeader title={`${doc.title} ${doc.number}`} sub={<>{PAYOUT_SOURCE_TYPES[p.sourceType as PayoutSourceType]} · {doc.referenceLine}</>}>
        <PayoutStatusChip status={p.status} />
        {p.historicalEntry && <Chip tone="grey">historisch nacherfasst</Chip>}
        <Link href={sourceHref} className="btn">{p.sourceType === "INVOICE_REFUND" ? `Zur Rechnung ${p.invoice?.number ?? ""}` : `Zur Buchung ${p.booking.number}`}</Link>
        <Link href="/auszahlungen" className="btn">Alle Auszahlungen</Link>
      </PageHeader>
      <Content>
        {p.status === "CANCELLED" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm font-medium">Storniert am {fmtDateTime(p.cancelledAt)} von {p.cancelledByName ?? "–"}: {p.cancellationReason}. Diese Auszahlung zählt nicht mehr als erfolgt; der Vorgang bleibt vollständig sichtbar.</p>}
        {p.status === "DRAFT" && <p className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm font-medium">Entwurf: Es ist noch kein Geldfluss dokumentiert. Der Entwurf mindert weder Guthaben noch Kautionsrest.</p>}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Betrag</div><div className="font-mono tnum text-lg font-semibold">{doc.amount}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Auszahlungsweg</div><div className="font-semibold">{PAYOUT_METHODS[p.method as PayoutMethod]}</div>{p.methodDescription && <div className="text-xs text-ink-3">{p.methodDescription}</div>}</div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Tatsächlich ausgezahlt am</div><div className="font-mono tnum font-semibold">{doc.executedAt ?? "–"}</div>{p.plannedAt && !p.executedAt && <div className="text-xs text-ink-3">geplant {fmtDateTime(p.plannedAt)}</div>}</div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Empfänger</div><div className="font-semibold">{p.recipientName}</div>{p.recipientDeviates && <div className="text-xs text-amber">abweichend vom Kunden: {p.recipientReason}</div>}</div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card title="Angaben zur Auszahlung">
            <dl className="p-4 text-sm grid grid-cols-[170px_1fr] gap-y-1.5">
              <dt className="label-xs self-center">Kunde</dt><dd>{p.customer ? <Link href={`/kunden/${p.customer.id}`} className="underline">{customerName(p.customer)}</Link> : snapshot.customerName || "–"}</dd>
              <dt className="label-xs self-center">Quelle</dt><dd><Link href={sourceHref} className="underline">{doc.referenceLine}</Link></dd>
              {p.ibanMasked && <><dt className="label-xs self-center">IBAN</dt><dd className="font-mono">{p.ibanMasked}{canManage && p.iban && <details className="inline ml-2 text-xs"><summary className="cursor-pointer inline text-ink-3">vollständig anzeigen</summary><span className="font-mono ml-1">{p.iban}</span></details>}</dd></>}
              {p.reference && <><dt className="label-xs self-center">Referenz</dt><dd>{p.reference}</dd></>}
              {p.method === "CASH" && <><dt className="label-xs self-center">Empfang bestätigt</dt><dd>{p.receiptConfirmed ? "Ja" : "Nein"}</dd></>}
              {p.customerNote && <><dt className="label-xs self-center">Text auf dem Beleg</dt><dd className="whitespace-pre-line">{p.customerNote}</dd></>}
              {canManage && p.internalNote && <><dt className="label-xs self-center">Interne Notiz</dt><dd className="whitespace-pre-line">{p.internalNote}</dd></>}
              <dt className="label-xs self-center">Erfasst</dt><dd>{fmtDateTime(p.createdAt)} von {p.createdByName ?? "–"}</dd>
              {p.completedAt && <><dt className="label-xs self-center">Als erfolgt erfasst</dt><dd>{fmtDateTime(p.completedAt)} von {p.completedByName ?? "–"}</dd></>}
              {p.contentHash && <><dt className="label-xs self-center">Prüfsumme</dt><dd className="font-mono text-[11px] break-all">{p.contentHash}{check && <span className={`ml-2 ${check.intact ? "text-good" : "text-bad"}`}>{check.intact ? "(intakt)" : "(abweichend)"}</span>}</dd></>}
            </dl>
          </Card>
          <Card title={p.sourceType === "INVOICE_REFUND" ? "Stand der Rechnung" : "Stand der Kaution"}>
            <div className="p-4 text-sm flex flex-col gap-1.5">
              {p.sourceType === "INVOICE_REFUND" ? (
                <>
                  <div className="flex justify-between"><span className="text-ink-3">Rechnungsbetrag (beim Abschluss)</span><span className="font-mono tnum">{snapshot.invoiceCents != null ? fmtCents(snapshot.invoiceCents) : "–"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Wirksame Forderung</span><span className="font-mono tnum">{snapshot.effectiveCents != null ? fmtCents(snapshot.effectiveCents) : "–"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Zahlungen des Kunden</span><span className="font-mono tnum">{snapshot.paidCents != null ? fmtCents(snapshot.paidCents) : "–"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Kundenguthaben</span><span className="font-mono tnum">{snapshot.customerCreditCents != null ? fmtCents(snapshot.customerCreditCents) : "–"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Vor dieser Auszahlung bereits ausgezahlt</span><span className="font-mono tnum">{snapshot.paidOutBeforeCents != null ? fmtCents(snapshot.paidOutBeforeCents) : "–"}</span></div>
                </>
              ) : (
                <>
                  <div className="flex justify-between"><span className="text-ink-3">Vereinbart</span><span className="font-mono tnum">{snapshot.expectedCents != null ? fmtCents(snapshot.expectedCents) : "–"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Erhalten</span><span className="font-mono tnum">{snapshot.receivedCents != null ? fmtCents(snapshot.receivedCents) : "–"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Einbehalten</span><span className="font-mono tnum">{snapshot.retainedCents != null ? fmtCents(snapshot.retainedCents) : "–"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Zur Rückzahlung freigegeben</span><span className="font-mono tnum">{snapshot.releasedCents != null ? fmtCents(snapshot.releasedCents) : "–"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Vor dieser Auszahlung bereits ausgezahlt</span><span className="font-mono tnum">{snapshot.paidOutBeforeCents != null ? fmtCents(snapshot.paidOutBeforeCents) : "–"}</span></div>
                </>
              )}
              <div className="flex justify-between border-t border-line-soft pt-1.5 font-semibold"><span>Heute noch auszuzahlen</span><span className="font-mono tnum">{fmtCents(remainingNow)}</span></div>
              <p className="text-xs text-ink-3">{p.status === "COMPLETED" ? "Der Stand oben ist der beim Abschluss festgehaltene Snapshot; „heute“ zeigt den aktuellen Rest der Quelle." : "Aktueller Stand der Quelle."}</p>
            </div>
          </Card>
        </div>

        {canManage && p.status === "DRAFT" && p.sourceNow && (
          <Card title="Entwurf bearbeiten">
            <div className="p-4 flex flex-col gap-3">
              <PayoutForm action={updatePayoutDraftAction.bind(null, p.id, p.bookingId)} preview={previewPayoutAction.bind(null, sourceRef)} sourceLabel={doc.referenceLine} remaining={fmtCents(remainingNow)} remainingCents={remainingNow} customerName={p.sourceNow.customerName} nonce={randomUUID()} defaultWhen={toDateTimeInputValue(new Date())} kind={p.sourceType === "INVOICE_REFUND" ? "INVOICE" : "DEPOSIT"} draft={{ amount: (p.amountCents / 100).toFixed(2).replace(".", ","), method: p.method, methodDescription: p.methodDescription ?? "", executedAt: p.executedAt ? toDateTimeInputValue(p.executedAt) : "", recipientName: p.recipientName, recipientReason: p.recipientReason ?? "", iban: p.iban ?? "", reference: p.reference ?? "", receiptConfirmed: p.receiptConfirmed, historicalEntry: p.historicalEntry, customerNote: p.customerNote ?? "", internalNote: p.internalNote ?? "" }} />
              <div className="flex flex-wrap gap-3 items-center">
                <CompleteDraftForm action={completePayoutAction.bind(null, p.id, p.bookingId)} amount={fmtCents(p.amountCents)} defaultWhen={toDateTimeInputValue(p.executedAt ?? new Date())} hasExecutedAt={!!p.executedAt} />
                <CancelPayoutForm action={cancelPayoutAction.bind(null, p.id, p.bookingId)} label="Entwurf aufheben" question="Diesen Entwurf aufheben?" wasCompleted={false} />
              </div>
            </div>
          </Card>
        )}

        {p.status !== "DRAFT" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <Card title="Auszahlungsbeleg">
              <div className="p-4 flex flex-col gap-2 text-sm">
                {receipt ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2"><Chip tone="good">✓ erstellt</Chip><span className="text-ink-2 break-all">{receipt.fileName}</span></div>
                    <div className="text-xs text-ink-3">erstellt am {fmtDateTime(receipt.createdAt)} · {kb(receipt.sizeBytes)}</div>
                    <div className="flex flex-wrap gap-2"><a href={`/api/documents/${receipt.id}`} target="_blank" rel="noopener noreferrer" className="btn">Anzeigen</a><a href={`/api/documents/${receipt.id}?download=1`} className="btn">Herunterladen</a></div>
                    <div className="text-[11px] text-ink-3 font-mono break-all">SHA-256 {receipt.checksum}</div>
                  </>
                ) : p.status === "COMPLETED" && canManage ? (
                  <PayoutActionButton action={generatePayoutPdfAction.bind(null, p.id, p.bookingId)} label="Auszahlungsbeleg-PDF erzeugen" pendingLabel="PDF wird erzeugt…" primary />
                ) : (
                  <span className="text-ink-3">Noch kein Beleg erzeugt.</span>
                )}
                <p className="text-xs text-ink-3">Der Beleg dokumentiert die Erfassung in Rent-Base; er ist keine Bankbestätigung. IBAN nur verkürzt.</p>
                {p.status === "COMPLETED" && canManage && receipt && <SendReceiptForm action={sendPayoutReceiptAction.bind(null, p.id, p.bookingId)} recipient={snapshot.customerEmail} nonce={randomUUID()} label={p.emails.some((e) => e.status === "SENT") ? "Auszahlungsbeleg erneut per E-Mail senden" : "Auszahlungsbeleg per E-Mail senden"} />}
                {p.emails.length > 0 && (
                  <ul className="text-xs divide-y divide-line-soft">
                    {p.emails.map((e) => <li key={e.id} className="py-1 flex flex-wrap gap-x-2"><span className="font-mono tnum text-ink-3">{fmtDateTime(e.sentAt ?? e.createdAt)}</span><span className="break-all">{e.recipient}</span><span className={e.status === "SENT" ? "text-good" : e.status === "FAILED" ? "text-bad" : "text-amber"}>{e.status === "SENT" ? "Erfolgreich" : e.status === "FAILED" ? `Fehlgeschlagen – ${e.error ?? ""}` : "Nicht bestätigt"}</span><span className="text-ink-3">Versuch {e.attemptNo}</span></li>)}
                  </ul>
                )}
              </div>
            </Card>
            <Card title="Nachweise" right={<Chip>{attachments.length}</Chip>}>
              <div className="p-4 flex flex-col gap-2 text-sm">
                {attachments.length === 0 && <span className="text-ink-3">Kein Nachweis hochgeladen (optional).</span>}
                <ul className="divide-y divide-line-soft">
                  {attachments.map((d) => (
                    <li key={d.id} className="py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <a href={`/api/documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline break-all">{d.fileName}</a>
                      <span className="text-xs text-ink-3">{fmtDateTime(d.createdAt)} · {kb(d.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
                {canManage && p.status !== "CANCELLED" && <AttachmentUploader payoutId={p.id} />}
              </div>
            </Card>
          </div>
        )}

        {canManage && p.status === "COMPLETED" && (
          <Card title="Korrektur">
            <div className="p-4 flex flex-col gap-2 text-sm">
              <p className="text-ink-2">Eine erfolgte Auszahlung wird nicht bearbeitet oder gelöscht. War sie falsch erfasst (z. B. Geld ist nie geflossen), wird sie mit Grund storniert; danach kann die korrekte Auszahlung neu erfasst werden. Beide Vorgänge bleiben sichtbar.</p>
              <CancelPayoutForm action={cancelPayoutAction.bind(null, p.id, p.bookingId)} label="Auszahlung stornieren (Fehlbuchung)" question={`Auszahlung ${p.number} über ${fmtCents(p.amountCents)} stornieren?`} wasCompleted />
            </div>
          </Card>
        )}
      </Content>
    </>
  );
}

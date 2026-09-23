// Auszahlungen einer Quelle (Rechnung oder Kaution): Stand, Historie, Aktion „Erstattung erfassen“ / „Kaution auszahlen“.
// Server-Komponente; alle Beträge kommen aus der zentralen Summierung (invoiceFinancials bzw. securityDepositFinancials).
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { PAYOUT_HELP, PAYOUT_METHODS, PAYOUT_STATUS, type PayoutMethod, type PayoutStatus } from "@/lib/constants";
import { fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { listSourcePayouts, payoutSource, type SourceRef } from "@/lib/payouts";
import { db } from "@/lib/db";
import { toDateTimeInputValue } from "@/lib/time";
import { cancelPayoutAction, completePayoutAction, createPayoutAction, previewPayoutAction } from "./actions";
import { CancelPayoutForm, CompleteDraftForm, PayoutForm } from "./payout-forms";

export function PayoutStatusChip({ status }: { status: string }) {
  const tone = status === "COMPLETED" ? "good" : status === "DRAFT" ? "amber" : "bad";
  return <Chip tone={tone}>{PAYOUT_STATUS[status as PayoutStatus] ?? status}</Chip>;
}

export async function PayoutPanel({ tenantId, role, sourceRef, bookingId, title }: { tenantId: string; role: string; sourceRef: SourceRef; bookingId: string; title?: string }) {
  const canManage = role !== "YARD";
  let source;
  try {
    source = await payoutSource(db, tenantId, sourceRef);
  } catch {
    return null;
  }
  const rows = await listSourcePayouts(tenantId, sourceRef.sourceType === "INVOICE_REFUND" ? { invoiceId: sourceRef.invoiceId } : { securityDepositId: source.sourceType === "SECURITY_DEPOSIT_REFUND" ? source.securityDepositId : null });
  const completed = rows.filter((p) => p.status === "COMPLETED");
  const drafts = rows.filter((p) => p.status === "DRAFT");
  const kind = sourceRef.sourceType === "INVOICE_REFUND" ? "INVOICE" : "DEPOSIT";
  const nothing = source.remainingCents <= 0 && rows.length === 0;
  if (nothing && !(source.sourceType === "INVOICE_REFUND" && source.invoice.completedRefundCents > 0)) return null;
  const heading = title ?? (kind === "INVOICE" ? "Erstattungen an den Kunden" : "Kautionsauszahlung");
  const sourceLabel = kind === "INVOICE" ? `Rechnung ${source.snapshot.invoiceNumber ?? ""}` : `Kaution zu Buchung ${source.snapshot.bookingNumber ?? ""}`;
  const paidOut = source.sourceType === "INVOICE_REFUND" ? source.invoice.completedRefundCents : source.deposit.completedPayoutCents;
  const claim = source.sourceType === "INVOICE_REFUND" ? source.invoice.customerCreditCents : Math.max(0, Math.min(source.deposit.releasedCents, source.deposit.receivedCents - source.deposit.retainedCents));
  const excess = source.sourceType === "INVOICE_REFUND" ? source.invoice.refundExcessCents : source.deposit.payoutExcessCents;

  return (
    <Card title={heading} right={source.remainingCents > 0 ? <Chip tone="bad">noch auszuzahlen {fmtCents(source.remainingCents)}</Chip> : paidOut > 0 ? <Chip tone="good">ausgezahlt {fmtCents(paidOut)}</Chip> : <Chip>nichts auszuzahlen</Chip>}>
      <div className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">{kind === "INVOICE" ? "Kundenguthaben" : "Zur Auszahlung freigegeben"}</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(claim)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Ausgezahlt</div><div className="font-mono tnum text-lg font-semibold text-good">{fmtCents(paidOut)}</div></div>
          <div className={`rounded-md p-3 ${source.remainingCents > 0 ? "bg-bad-soft" : "bg-panel-2"}`}><div className="label-xs">Noch auszuzahlen</div><div className={`font-mono tnum text-lg font-semibold ${source.remainingCents > 0 ? "text-bad" : ""}`}>{fmtCents(source.remainingCents)}</div></div>
        </div>
        {excess > 0 && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Es wurden {fmtCents(excess)} mehr ausgezahlt, als nach heutigem Stand {kind === "INVOICE" ? "Guthaben" : "auszahlbar"} ist. Der Geldfluss bleibt historisch wahr; bitte den Fall prüfen.</p>}
        <p className="text-xs text-ink-3">{kind === "INVOICE" ? PAYOUT_HELP.REFUND + " " + PAYOUT_HELP.REVERSAL : PAYOUT_HELP.DEPOSIT}</p>
        {canManage && source.remainingCents > 0 && drafts.length === 0 && (
          <PayoutForm action={createPayoutAction.bind(null, sourceRef, bookingId)} preview={previewPayoutAction.bind(null, sourceRef)} sourceLabel={sourceLabel} remaining={fmtCents(source.remainingCents)} remainingCents={source.remainingCents} customerName={source.customerName} nonce={randomUUID()} defaultWhen={toDateTimeInputValue(new Date())} kind={kind} />
        )}
        {!canManage && source.remainingCents > 0 && <p className="text-xs text-ink-3">Auszahlungen erfasst die Disposition.</p>}
        {rows.length > 0 && (
          <div>
            <div className="label-xs mb-1">Auszahlungshistorie</div>
            <ul className="divide-y divide-line-soft text-sm">
              {rows.map((p) => (
                <li key={p.id} className={`py-2 flex flex-col gap-1 ${p.status === "CANCELLED" ? "opacity-70" : ""}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Link href={`/auszahlungen/${p.id}`} className="font-mono tnum font-medium hover:underline">{p.number ?? "Entwurf"}</Link>
                      <PayoutStatusChip status={p.status} />
                      <span className="text-ink-3">{PAYOUT_METHODS[p.method as PayoutMethod] ?? p.method}</span>
                      {p.historicalEntry && <Chip tone="grey">nacherfasst</Chip>}
                      <span className="font-mono tnum text-xs text-ink-3">{p.executedAt ? fmtDateTime(p.executedAt) : p.plannedAt ? `geplant ${fmtDateTime(p.plannedAt)}` : ""}</span>
                    </div>
                    <span className={`font-mono tnum font-semibold ${p.status === "CANCELLED" ? "line-through text-ink-3" : ""}`}>{fmtCents(p.amountCents)}</span>
                  </div>
                  <div className="text-xs text-ink-3 flex flex-wrap gap-x-2"><span>Empfänger {p.recipientName}</span>{p.ibanMasked && <span>· {p.ibanMasked}</span>}{p.reference && <span>· {p.reference}</span>}<span>· erfasst von {p.createdByName ?? "–"}</span></div>
                  {p.status === "CANCELLED" && <div className="text-xs text-bad">Storniert am {fmtDateTime(p.cancelledAt)} von {p.cancelledByName ?? "–"}: {p.cancellationReason}</div>}
                  {canManage && p.status === "DRAFT" && (
                    <div className="flex flex-wrap gap-2 items-center">
                      <CompleteDraftForm action={completePayoutAction.bind(null, p.id, bookingId)} amount={fmtCents(p.amountCents)} defaultWhen={toDateTimeInputValue(p.executedAt ?? new Date())} hasExecutedAt={!!p.executedAt} />
                      <Link href={`/auszahlungen/${p.id}`} className="btn !py-1.5">Entwurf bearbeiten</Link>
                      <CancelPayoutForm action={cancelPayoutAction.bind(null, p.id, bookingId)} label="Entwurf aufheben" question="Diesen Entwurf aufheben?" wasCompleted={false} />
                    </div>
                  )}
                  {canManage && p.status === "COMPLETED" && <CancelPayoutForm action={cancelPayoutAction.bind(null, p.id, bookingId)} label="Auszahlung stornieren (Fehlbuchung)" question={`Auszahlung ${p.number} über ${fmtCents(p.amountCents)} stornieren?`} wasCompleted />}
                </li>
              ))}
            </ul>
          </div>
        )}
        {completed.length === 0 && rows.length === 0 && source.remainingCents === 0 && <p className="text-xs text-ink-3">Nichts auszuzahlen.</p>}
      </div>
    </Card>
  );
}

// Bereiche „Zahlungen“ und „Kaution“ einer Buchung. Bewusst getrennt: Rechnung = Forderung, Zahlung = Geldfluss,
// Kaution = Sicherheitsleistung. Keine Verrechnung, alle Summen serverseitig aus bestätigten Einträgen.
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { db } from "@/lib/db";
import { Card, Chip } from "@/components/ui";
import { DEPOSIT_EVENT_TYPES, DEPOSIT_STATUS, INVOICE_PAYMENT_STATUS, PAYMENT_METHODS, type DepositEventType, type PaymentMethod } from "@/lib/constants";
import { depositView } from "@/lib/deposits";
import { fmtDateTime, fmtEur } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { invoicePaymentSummary, listInvoicePayments, type PaymentSummary } from "@/lib/payments";
import { toDateTimeInputValue } from "@/lib/time";
import { cancelDepositEventAction, cancelPaymentAction, previewDepositSettleAction, previewPaymentAction, recordDepositReceivedAction, recordPaymentAction, settleDepositAction } from "./actions";
import { DepositReceiveForm, DepositSettleForm, PaymentForm, ReasonForm } from "./money-forms";

const methodLabel = (m: string | null) => (m ? PAYMENT_METHODS[m as PaymentMethod] ?? m : "–");

export function PaymentStatusChip({ status }: { status: PaymentSummary["status"] }) {
  const tone = status === "PAID" ? "good" : status === "PARTIAL" ? "amber" : "bad";
  return <Chip tone={tone}>{INVOICE_PAYMENT_STATUS[status]}</Chip>;
}

/** Zahlungen zu einer abgeschlossenen Rechnung: Saldo, Erfassen, Historie mit Storno. */
export async function PaymentsPanel({ tenantId, bookingId, role, compact = false }: { tenantId: string; bookingId: string; role: string; compact?: boolean }) {
  const invoice = await db.invoice.findFirst({ where: { tenantId, bookingId, status: "FINALIZED" }, select: { id: true, number: true, grossTotal: true } });
  const canManage = role !== "YARD";
  if (!invoice) {
    return (
      <Card title="Zahlungen">
        <div className="p-4 text-sm text-ink-3">Zahlungen werden zu einer abgeschlossenen Rechnung erfasst. Zu dieser Buchung gibt es noch keine.</div>
      </Card>
    );
  }
  const [summary, payments] = await Promise.all([invoicePaymentSummary(tenantId, invoice.id), listInvoicePayments(tenantId, invoice.id)]);
  return (
    <Card title="Zahlungen" right={<PaymentStatusChip status={summary.status} />}>
      <div className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Rechnungsbetrag</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(summary.grossCents)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Bezahlt</div><div className="font-mono tnum text-lg font-semibold text-good">{fmtCents(summary.paidCents)}</div></div>
          {summary.status === "OVERPAID" ? (
            <div className="rounded-md bg-bad-soft p-3"><div className="label-xs">Überzahlt</div><div className="font-mono tnum text-lg font-semibold text-bad">{fmtCents(summary.overpaidCents)}</div></div>
          ) : (
            <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Offen</div><div className={`font-mono tnum text-lg font-semibold ${summary.openCents > 0 ? "text-bad" : ""}`}>{fmtCents(summary.openCents)}</div></div>
          )}
        </div>
        {summary.status === "OVERPAID" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3 py-2 text-sm">Überzahlt – Erstattung zu klären: Der Rechnungsbetrag der aktuellen Fassung liegt unter den dokumentierten Zahlungen. Rent-Base führt keine automatische Erstattung durch; Zahlungen bleiben unverändert.</p>}
        {compact && <div className="text-xs text-ink-3">Rechnung <Link href={`/buchungen/${bookingId}/rechnung`} className="underline">{invoice.number}</Link></div>}
        {canManage && summary.openCents > 0 && <PaymentForm action={recordPaymentAction.bind(null, bookingId)} preview={previewPaymentAction} invoiceId={invoice.id} nonce={randomUUID()} defaultWhen={toDateTimeInputValue(new Date())} />}
        {canManage && summary.openCents === 0 && summary.status === "PAID" && <p className="text-sm text-good">Die Rechnung ist vollständig bezahlt.</p>}
        {!canManage && <p className="text-xs text-ink-3">Zahlungen erfasst und korrigiert die Disposition.</p>}
        <div>
          <div className="label-xs mb-1">Zahlungshistorie</div>
          {payments.length === 0 && <div className="text-sm text-ink-3">Noch keine Zahlung erfasst.</div>}
          <ul className="divide-y divide-line-soft text-sm">
            {payments.map((p) => (
              <li key={p.id} className={`py-2 flex flex-col gap-1 ${p.status === "CANCELLED" ? "opacity-70" : ""}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(p.paidAt)}</span>
                    <span>{methodLabel(p.method)}</span>
                    {p.reference && <span className="text-ink-3">· {p.reference}</span>}
                  </div>
                  <span className={`font-mono tnum font-semibold ${p.status === "CANCELLED" ? "line-through text-ink-3" : ""}`}>{fmtCents(p.amountCents)}</span>
                </div>
                <div className="text-xs text-ink-3 flex flex-wrap gap-x-2">
                  <span>erfasst von {p.createdByName ?? "–"} am {fmtDateTime(p.createdAt)}</span>
                  {p.note && <span>· {p.note}</span>}
                </div>
                {p.status === "CANCELLED" && <div className="text-xs text-bad">Storniert am {fmtDateTime(p.cancelledAt)} von {p.cancelledByName ?? "–"}: {p.cancellationReason}</div>}
                {p.status === "CONFIRMED" && canManage && <ReasonForm action={cancelPaymentAction.bind(null, bookingId)} id={p.id} label="Zahlung stornieren" question={`Zahlung über ${fmtCents(p.amountCents)} (${methodLabel(p.method)}) stornieren?`} />}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

const depositTone = (status: string) => (status === "RELEASED" ? "good" : status === "RECEIVED" ? "info" : status === "EXPECTED" ? "amber" : status === "RETAINED" ? "bad" : "amber");

/** Kaution: vereinbart, erhalten, freigegeben, einbehalten, Status, Aktionen und Historie. */
export async function DepositPanel({ tenantId, bookingId, role, charges }: { tenantId: string; bookingId: string; role: string; charges?: { count: number; total: number } | null }) {
  const v = await depositView(tenantId, bookingId);
  const canDecide = role !== "YARD";
  if (!v.contractSigned) {
    return (
      <Card title="Kaution">
        <div className="p-4 text-sm text-ink-3">Die vereinbarte Kaution ergibt sich aus dem abgeschlossenen Mietvertrag.</div>
      </Card>
    );
  }
  const invoice = await db.invoice.findFirst({ where: { tenantId, bookingId, status: "FINALIZED" }, select: { number: true, grossTotal: true } });
  const afterReturn = v.bookingStatus === "RETURNED" || v.bookingStatus === "CANCELLED";
  const nonce = randomUUID();
  const now = toDateTimeInputValue(new Date());
  return (
    <Card title="Kaution" right={<Chip tone={depositTone(v.status)}>{DEPOSIT_STATUS[v.status]}</Chip>}>
      <div className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Vereinbart</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(v.expectedCents)}</div><div className="text-[11px] text-ink-3">laut {v.contractNumber}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Erhalten</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(v.receivedCents)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Freigegeben</div><div className="font-mono tnum text-lg font-semibold text-good">{fmtCents(v.releasedCents)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Einbehalten</div><div className="font-mono tnum text-lg font-semibold text-bad">{fmtCents(v.retainedCents)}</div></div>
        </div>
        {v.expectedCents === 0 && <p className="text-sm text-ink-3">Laut Mietvertrag wurde keine Kaution vereinbart.</p>}
        {v.expectedCents > 0 && v.receivedCents < v.expectedCents && v.bookingStatus !== "CANCELLED" && (
          <p role="alert" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm font-medium">Kaution laut Vertrag noch nicht {v.receivedCents > 0 ? "vollständig " : ""}als erhalten dokumentiert.</p>
        )}
        {v.expectedCents > 0 && v.receivedCents < v.expectedCents && v.bookingStatus !== "CANCELLED" && (
          <DepositReceiveForm action={recordDepositReceivedAction.bind(null, bookingId)} nonce={nonce} defaultAmount={((v.expectedCents - v.receivedCents) / 100).toFixed(2).replace(".", ",")} defaultWhen={now} />
        )}
        {afterReturn && (charges || invoice) && (
          <div className="text-sm rounded-md border border-line-soft p-3 flex flex-col gap-1">
            <div className="label-xs">Zur Einordnung (keine Verrechnung)</div>
            {charges && <div className="flex justify-between"><span>Bestätigte Zusatzkosten der Rückgabe ({charges.count})</span><span className="font-mono tnum">{fmtEur(charges.total)}</span></div>}
            {invoice && <div className="flex justify-between"><span>Rechnung {invoice.number}</span><span className="font-mono tnum">{fmtEur(Number(invoice.grossTotal))}</span></div>}
            <p className="text-xs text-ink-3">Rent-Base verrechnet die Kaution nicht automatisch mit Zusatzkosten oder Rechnungen. Freigabe und Einbehalt sind eine dokumentierte Entscheidung des Mitarbeiters.</p>
          </div>
        )}
        {afterReturn && v.remainingCents > 0 && canDecide && (
          <DepositSettleForm action={settleDepositAction.bind(null, bookingId)} preview={previewDepositSettleAction} bookingId={bookingId} nonce={`${nonce}`} remainingCents={v.remainingCents} defaultWhen={now} />
        )}
        {afterReturn && v.remainingCents > 0 && !canDecide && <p className="text-xs text-ink-3">Freigabe oder Einbehalt der Kaution entscheidet die Disposition.</p>}
        {!afterReturn && v.receivedCents > 0 && <p className="text-xs text-ink-3">Freigabe oder Einbehalt wird nach der Rückgabe dokumentiert.</p>}
        <div>
          <div className="label-xs mb-1">Kautionshistorie</div>
          {v.events.length === 0 && <div className="text-sm text-ink-3">Noch keine Bewegung dokumentiert.</div>}
          <ul className="divide-y divide-line-soft text-sm">
            {v.events.map((e) => (
              <li key={e.id} className={`py-2 flex flex-col gap-1 ${e.status === "CANCELLED" ? "opacity-70" : ""}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(e.occurredAt)}</span>
                    <span className="font-medium">{DEPOSIT_EVENT_TYPES[e.type as DepositEventType] ?? e.type}</span>
                    {e.method && <span className="text-ink-3">· {methodLabel(e.method)}</span>}
                    {e.reference && <span className="text-ink-3">· {e.reference}</span>}
                  </div>
                  <span className={`font-mono tnum font-semibold ${e.status === "CANCELLED" ? "line-through text-ink-3" : e.type === "RETAINED" ? "text-bad" : e.type === "RELEASED" ? "text-good" : ""}`}>{fmtCents(e.amountCents)}</span>
                </div>
                {e.reason && <div className="text-xs">Grund: {e.reason}</div>}
                <div className="text-xs text-ink-3 flex flex-wrap gap-x-2"><span>dokumentiert von {e.createdByName ?? "–"} am {fmtDateTime(e.createdAt)}</span>{e.note && <span>· {e.note}</span>}</div>
                {e.status === "CANCELLED" && <div className="text-xs text-bad">Storniert am {fmtDateTime(e.cancelledAt)} von {e.cancelledByName ?? "–"}: {e.cancellationReason}</div>}
                {e.status === "CONFIRMED" && canDecide && <ReasonForm action={cancelDepositEventAction.bind(null, bookingId)} id={e.id} label="Bewegung korrigieren (Storno)" question={`${DEPOSIT_EVENT_TYPES[e.type as DepositEventType]} über ${fmtCents(e.amountCents)} stornieren?`} />}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/** Kurzer Hinweis für die Übergabe: Kaution laut Vertrag noch nicht (vollständig) als erhalten dokumentiert. Blockiert nichts. */
export async function DepositNotice({ tenantId, bookingId }: { tenantId: string; bookingId: string }) {
  const v = await depositView(tenantId, bookingId);
  if (!v.contractSigned || v.expectedCents === 0 || v.receivedCents >= v.expectedCents) return null;
  return (
    <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm font-medium">
      Kaution laut Vertrag ({fmtCents(v.expectedCents)}) noch nicht {v.receivedCents > 0 ? `vollständig (erhalten ${fmtCents(v.receivedCents)}) ` : ""}als erhalten dokumentiert. Die Übergabe ist trotzdem möglich; erfassen unter <Link href={`/buchungen/${bookingId}#kaution`} className="underline">Kaution</Link>.
    </p>
  );
}

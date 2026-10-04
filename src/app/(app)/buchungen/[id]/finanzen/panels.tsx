// Bereiche „Zahlungen“ und „Kaution“ einer Buchung. Bewusst getrennt: Rechnung = Forderung, Zahlung = Geldfluss,
// Kaution = Sicherheitsleistung. Keine Verrechnung, alle Summen serverseitig aus bestätigten Einträgen.
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { db } from "@/lib/db";
import { Card, Chip } from "@/components/ui";
import { DEPOSIT_EVENT_TYPES, DEPOSIT_OFFSET_LABEL, DEPOSIT_OFFSET_METHOD, depositStatusLabel, INVOICE_PAYMENT_STATUS, PAYMENT_METHODS, RENTAL_PAYMENT_STATUS, type DepositEventType, type PaymentMethod, invoiceKindWord, isSideInvoice } from "@/lib/constants";
import { depositView } from "@/lib/deposits";
import { depositOffsetOptions } from "@/lib/deposit-offset";
import { fmtDateTime, fmtEur } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { invoicePaymentSummary, listInvoicePayments, type PaymentSummary } from "@/lib/payments";
import { listRentalPayments, rentalPaymentSummary, type RentalPaymentSummary } from "@/lib/rental-payments";
import { toDateTimeInputValue } from "@/lib/time";
import { applyDepositOffsetAction, cancelDepositEventAction, cancelDepositOffsetAction, cancelOffsetReturnAction, cancelPaymentAction, previewDepositOffsetAction, previewDepositSettleAction, previewPaymentAction, previewRentalPaymentAction, recordDepositReceivedAction, recordPaymentAction, recordRentalPaymentAction, settleDepositAction } from "./actions";
import { DepositOffsetForm, DepositReceiveForm, DepositSettleForm, PaymentForm, ReasonForm } from "./money-forms";
import { PayoutPanel } from "../../../auszahlungen/payout-panel";

// Befehl 20.7: eine Kautionsverrechnung ist keine Bar-/Bankzahlung – eigene Bezeichnung in jeder Historie
const methodLabel = (m: string | null) => (m ? (m === DEPOSIT_OFFSET_METHOD ? DEPOSIT_OFFSET_LABEL : PAYMENT_METHODS[m as PaymentMethod] ?? m) : "–");
// Befehl 20.9: Storno-Dialog sagt, was tatsächlich passiert (bestehende Stornologik: kennzeichnen, nicht löschen)
const CANCEL_PAYMENT_EXPLANATION = "Die Zahlung wird nicht gelöscht. Sie bleibt in der Historie sichtbar, wird als storniert gekennzeichnet und der offene Betrag wird entsprechend neu berechnet.";

export function PaymentStatusChip({ status }: { status: PaymentSummary["status"] }) {
  const tone = status === "PAID" ? "good" : status === "PARTIAL" ? "amber" : "bad";
  return <Chip tone={tone}>{INVOICE_PAYMENT_STATUS[status]}</Chip>;
}

/**
 * Zahlungen zu einer abgeschlossenen Rechnung: Saldo, Erfassen, Historie mit Storno.
 * invoiceId: eine bestimmte Rechnung (z. B. Schadenabrechnung); ohne Angabe die Mietrechnung der Buchung.
 */
export async function PaymentsPanel({ tenantId, bookingId, role, compact = false, invoiceId = null, title }: { tenantId: string; bookingId: string | null; role: string; compact?: boolean; invoiceId?: string | null; title?: string }) {
  // Befehl 23.1: freie Rechnung ohne Buchung – immer über die Rechnungs-Id (mandantengebunden)
  const invoice = bookingId || invoiceId ? await db.invoice.findFirst({ where: { tenantId, ...(bookingId ? { bookingId } : {}), status: "FINALIZED", documentType: "INVOICE", ...(invoiceId ? { id: invoiceId } : { kind: "RENTAL" }) }, select: { id: true, number: true, kind: true, grossTotal: true } }) : null;
  const canManage = role !== "YARD";
  const heading = title ?? (invoice?.kind === "DAMAGE" ? "Zahlungen zur Schadenabrechnung" : invoice?.kind === "AUTHORITY_FEE" ? "Zahlungen zum Bearbeitungsentgelt" : invoice?.kind === "DUNNING_FEE" ? "Zahlungen zur Mahngebühr" : "Zahlungen");
  if (!invoice) {
    return (
      <Card title={heading}>
        <div className="p-4 text-sm text-ink-3">Zahlungen werden zu einer abgeschlossenen Rechnung erfasst. Zu dieser Buchung gibt es noch keine{invoiceId ? "" : " Mietrechnung"}.</div>
      </Card>
    );
  }
  const [summary, payments] = await Promise.all([invoicePaymentSummary(tenantId, invoice.id), listInvoicePayments(tenantId, invoice.id)]);
  const invoiceHref = bookingId && invoice.kind !== "GENERAL" ? `/buchungen/${bookingId}/rechnung${isSideInvoice(invoice.kind) ? `?nr=${invoice.id}` : ""}` : `/rechnungen/${invoice.id}`;
  return (
    <Card title={heading} right={summary.grossCents > 0 || summary.paidCents > 0 ? <PaymentStatusChip status={summary.status} /> : <Chip tone={summary.chain === "CANCELLED" ? "bad" : "info"}>{summary.chain === "CANCELLED" ? "Storniert" : "Gutgeschrieben"}</Chip>}>
      <div className="p-4 flex flex-col gap-4">
        {summary.chain !== "NONE" && (
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Rechnungsbetrag</div><div className="font-mono tnum font-semibold">{fmtCents(summary.invoiceCents)}</div></div>
            <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Gutgeschrieben</div><div className="font-mono tnum font-semibold">− {fmtCents(summary.creditedCents)}</div></div>
            <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Storniert</div><div className="font-mono tnum font-semibold">− {fmtCents(summary.cancelledCents)}</div></div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">{summary.chain === "NONE" ? "Rechnungsbetrag" : "Forderung nach Gegenbelegen"}</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(summary.grossCents)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Bezahlt</div><div className="font-mono tnum text-lg font-semibold text-good">{fmtCents(summary.paidCents)}</div>{summary.offsetCents > 0 && <div className="text-[11px] text-ink-3">davon {fmtCents(summary.offsetCents)} aus Kaution verrechnet</div>}</div>
          {summary.status === "OVERPAID" ? (
            <div className="rounded-md bg-bad-soft p-3"><div className="label-xs">Kundenguthaben</div><div className="font-mono tnum text-lg font-semibold text-bad">{fmtCents(summary.overpaidCents)}</div></div>
          ) : (
            <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Offen</div><div className={`font-mono tnum text-lg font-semibold ${summary.openCents > 0 ? "text-bad" : ""}`}>{fmtCents(summary.openCents)}</div></div>
          )}
        </div>
        {summary.status === "OVERPAID" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3 py-2 text-sm">Erstattung erforderlich: Die dokumentierten Zahlungen ({fmtCents(summary.paidCents)}) übersteigen die wirksame Forderung ({fmtCents(summary.grossCents)}). Offen ist 0,00 €; das Kundenguthaben beträgt {fmtCents(summary.overpaidCents)}. Rent-Base führt keine automatische Erstattung und keine Verrechnung durch; Zahlungen bleiben unverändert.</p>}
        {compact && <div className="text-xs text-ink-3">{invoiceKindWord(invoice.kind)} <Link href={invoiceHref} className="underline">{invoice.number}</Link></div>}
        {canManage && summary.openCents > 0 && <PaymentForm action={recordPaymentAction.bind(null, bookingId)} preview={previewPaymentAction} targetId={invoice.id} nonce={randomUUID()} defaultWhen={toDateTimeInputValue(new Date())} />}
        {canManage && summary.openCents === 0 && summary.status === "PAID" && summary.grossCents > 0 && <p className="text-sm text-good">Die Forderung ist vollständig bezahlt.</p>}
        {summary.openCents === 0 && summary.grossCents === 0 && summary.chain !== "NONE" && <p className="text-sm text-ink-2">Die Forderung wurde durch {summary.chain === "CANCELLED" ? "einen Stornobeleg" : "Gutschriften"} vollständig aufgehoben; es ist nichts mehr offen.{summary.paidCents > 0 ? " Die dokumentierten Zahlungen bleiben bestehen und ergeben ein Kundenguthaben." : ""}</p>}
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
                    {p.type === "DEPOSIT_OFFSET" ? <Chip tone="info">{DEPOSIT_OFFSET_LABEL}</Chip> : <span>{methodLabel(p.method)}</span>}
                    {p.reference && <span className="text-ink-3">· {p.reference}</span>}
                  </div>
                  <span className={`font-mono tnum font-semibold ${p.status === "CANCELLED" ? "line-through text-ink-3" : ""}`}>{fmtCents(p.amountCents)}</span>
                </div>
                <div className="text-xs text-ink-3 flex flex-wrap gap-x-2">
                  <span>{p.type === "DEPOSIT_OFFSET" ? "verrechnet" : "erfasst"} von {p.createdByName ?? "–"} am {fmtDateTime(p.createdAt)}</span>
                  {p.type === "DEPOSIT_OFFSET" && <span>· kein Geldeingang, aus der erhaltenen Kaution</span>}
                  {p.note && <span>· {p.note}</span>}
                </div>
                {p.status === "CANCELLED" && <div className="text-xs text-bad">Storniert am {fmtDateTime(p.cancelledAt)} von {p.cancelledByName ?? "–"}: {p.cancellationReason}</div>}
                {p.status === "CONFIRMED" && canManage && p.type !== "DEPOSIT_OFFSET" && <ReasonForm variant="button" action={cancelPaymentAction.bind(null, bookingId)} id={p.id} label="Zahlung stornieren" confirmLabel="Zahlung stornieren" question={`Zahlung über ${fmtCents(p.amountCents)} wirklich stornieren?`} explanation={CANCEL_PAYMENT_EXPLANATION} />}
                {p.status === "CONFIRMED" && canManage && p.type === "DEPOSIT_OFFSET" && <ReasonForm variant="button" action={cancelDepositOffsetAction.bind(null, bookingId)} id={p.id} label="Verrechnung stornieren" confirmLabel="Verrechnung stornieren" question={`Kautionsverrechnung über ${fmtCents(p.amountCents)} wirklich stornieren?`} explanation="Die Verrechnung wird nicht gelöscht, sondern als storniert gekennzeichnet. Die Forderung ist danach wieder offen, die Kaution wieder verfügbar." />}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

export function RentalPaymentStatusChip({ status }: { status: PaymentSummary["status"] }) {
  const tone = status === "PAID" ? "good" : status === "PARTIAL" ? "amber" : status === "OVERPAID" ? "bad" : "grey";
  return <Chip tone={tone}>{RENTAL_PAYMENT_STATUS[status]}</Chip>;
}

const totalLabel = (s: RentalPaymentSummary, contractNumber: string | null) =>
  s.source === "CONTRACT" ? `Gesamtpreis laut Vertrag${contractNumber ? ` ${contractNumber}` : ""}` : "Gesamtpreis (voraussichtlich)";

/**
 * Mietzahlung einer Buchung: Gesamtpreis, bereits bezahlt, noch offen, „Zahlung erfassen“ und Historie mit Storno.
 * Vor der Rechnung hängen die Zahlungen an der Buchung; nach Abschluss der Mietrechnung zeigt der Bereich deren Saldo
 * (die vorab erfassten Zahlungen sind ihr dann zugeordnet). Die Kaution erscheint hier bewusst nicht.
 */
export async function RentalPaymentsPanel({ tenantId, bookingId, role }: { tenantId: string; bookingId: string; role: string }) {
  const s = await rentalPaymentSummary(tenantId, bookingId);
  if (s.source === "INVOICE") return <PaymentsPanel tenantId={tenantId} bookingId={bookingId} role={role} compact title="Mietzahlung" />;
  const cancelled = s.bookingStatus === "CANCELLED";
  const [payments, contract, cancelRow] = await Promise.all([
    listRentalPayments(tenantId, bookingId),
    db.rentalContract.findFirst({ where: { tenantId, bookingId }, select: { number: true } }),
    cancelled ? db.booking.findFirst({ where: { id: bookingId, tenantId }, select: { cancellationKey: true } }) : null,
  ]);
  // Befehl 28: ein Storno über den Assistenten hat zur Vorauszahlung entschieden (Gebühr, Erstattung oder Guthaben); nur ältere Stornos brauchen den Klärungshinweis
  const legacyCancel = cancelled && !cancelRow?.cancellationKey;
  const canManage = role !== "YARD";
  return (
    <Card title="Mietzahlung" right={cancelled ? <Chip tone="grey">Storniert</Chip> : <RentalPaymentStatusChip status={s.status} />}>
      <div id="mietzahlung" className="p-4 flex flex-col gap-4">
        {!cancelled && (<>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">{totalLabel(s, contract?.number ?? null)}</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(s.grossCents)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Bereits bezahlt</div><div className="font-mono tnum text-lg font-semibold text-good">{fmtCents(s.paidCents)}</div></div>
          {s.status === "OVERPAID" ? (
            <div className="rounded-md bg-bad-soft p-3"><div className="label-xs">Zu viel erfasst</div><div className="font-mono tnum text-lg font-semibold text-bad">{fmtCents(s.overpaidCents)}</div></div>
          ) : (
            <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Noch offen</div><div className={`font-mono tnum text-lg font-semibold ${s.openCents > 0 ? "text-bad" : ""}`}>{fmtCents(s.openCents)}</div></div>
          )}
        </div>
        {s.status === "OVERPAID" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3 py-2 text-sm">Die erfassten Mietzahlungen ({fmtCents(s.paidCents)}) übersteigen den aktuellen Gesamtpreis ({fmtCents(s.grossCents)}), z. B. nach einer Änderung von Zeitraum oder Preis. Eine falsch erfasste Zahlung wird storniert; eine tatsächliche Rückzahlung wird nach Abschluss der Mietrechnung als Erstattung dokumentiert.</p>}
        </>)}
        {legacyCancel && s.paidCents > 0 && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Die Buchung ist storniert, es sind aber Mietzahlungen über {fmtCents(s.paidCents)} dokumentiert. Bitte klären, ob der Betrag zurückgezahlt wurde; eine falsch erfasste Zahlung wird storniert.</p>}
        {cancelled ? <p className="text-sm text-ink-2">Die Buchung ist storniert. Es besteht keine Mietforderung mehr; neue Mietzahlungen werden nicht erfasst. Die dokumentierten Zahlungen bleiben unten unverändert sichtbar – ihre Zuordnung (Stornogebühr, Erstattung, Guthaben) zeigt die <Link href="#storno" className="underline">Storno-Abrechnung</Link>.</p> : (
          <p className="text-xs text-ink-3">{s.source === "ESTIMATE" ? "Der Gesamtpreis wird aus Zeitraum und Preisen der Buchung berechnet und steht erst mit dem Mietvertrag fest. " : ""}Mehrkilometer, Tank und weitere Zusatzkosten kommen mit der Rechnung dazu. Die Kaution wird getrennt unter „Kaution“ erfasst und verringert den offenen Mietbetrag nicht.</p>
        )}
        {canManage && s.canRecord && <PaymentForm action={recordRentalPaymentAction.bind(null, bookingId)} preview={previewRentalPaymentAction} targetId={bookingId} targetField={null} totalLabel={totalLabel(s, contract?.number ?? null)} nonce={randomUUID()} defaultWhen={toDateTimeInputValue(new Date())} />}
        {canManage && !cancelled && !s.canRecord && s.status === "PAID" && s.grossCents > 0 && <p className="text-sm text-good">Der Mietpreis ist vollständig bezahlt.</p>}
        {!canManage && <p className="text-xs text-ink-3">Mietzahlungen erfasst und korrigiert die Disposition.</p>}
        <div>
          <div className="label-xs mb-1">Zahlungen</div>
          {payments.length === 0 && <div className="text-sm text-ink-3">Noch keine Mietzahlung erfasst.</div>}
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
                {p.status === "CONFIRMED" && canManage && <ReasonForm variant="button" action={cancelPaymentAction.bind(null, bookingId)} id={p.id} label="Zahlung stornieren" confirmLabel="Zahlung stornieren" question={`Zahlung über ${fmtCents(p.amountCents)} wirklich stornieren?`} explanation={CANCEL_PAYMENT_EXPLANATION} />}
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
  // Befehl 20.9: Ohne Vertrag gibt es eine Kautionszeile nur, wenn der Eingang schon bei der Buchungsanlage dokumentiert wurde
  if (!v.contractSigned && !v.deposit) {
    return (
      <Card title="Kaution">
        <div className="p-4 text-sm text-ink-3">Die vereinbarte Kaution ergibt sich aus dem abgeschlossenen Mietvertrag. Ein bereits erhaltener Betrag kann bei der Anlage der Buchung dokumentiert werden.</div>
      </Card>
    );
  }
  const invoices = await db.invoice.findMany({ where: { tenantId, bookingId, status: "FINALIZED", documentType: "INVOICE" }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, kind: true, currentVersion: { select: { grossTotal: true } }, grossTotal: true } });
  const invoice = invoices[0] ?? null;
  const afterReturn = v.bookingStatus === "RETURNED" || v.bookingStatus === "CANCELLED";
  const nonce = randomUUID();
  const now = toDateTimeInputValue(new Date());
  // Befehl 20.7: bewusste Verrechnung mit einer offenen Forderung – nur nach Rückgabe, nur mit verfügbarer Kaution
  const offset = afterReturn && canDecide && v.remainingCents > 0 ? await depositOffsetOptions(tenantId, bookingId) : null;
  return (
    <Card title="Kaution" right={<Chip tone={depositTone(v.status)}>{depositStatusLabel(v.status, v)}</Chip>}>
      <div className="p-4 flex flex-col gap-4">
        <div className={`grid grid-cols-2 ${v.offsetGrossCents > 0 ? "sm:grid-cols-5" : "sm:grid-cols-4"} gap-2 text-sm`}>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Vereinbart</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(v.expectedCents)}</div><div className="text-[11px] text-ink-3">laut {v.contractSigned && v.contractNumber ? v.contractNumber : v.bookingStatus === "CANCELLED" ? "stornierter Buchung" : "Buchung (Vertrag folgt)"}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Erhalten</div><div className="font-mono tnum text-lg font-semibold">{fmtCents(v.receivedCents)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Freigegeben</div><div className="font-mono tnum text-lg font-semibold text-good">{fmtCents(v.releasedCents)}</div></div>
          <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Einbehalten</div><div className="font-mono tnum text-lg font-semibold text-bad">{fmtCents(v.retainedCents)}</div></div>
          {v.offsetGrossCents > 0 && <div className="rounded-md bg-info-soft p-3"><div className="label-xs">Mit Forderungen verrechnet</div><div className="font-mono tnum text-lg font-semibold text-info">{fmtCents(v.offsetGrossCents)}</div><div className="text-[11px] text-ink-3">{v.offsetReturnedCents > 0 ? `davon zurückgeführt ${fmtCents(v.offsetReturnedCents)} · netto ${fmtCents(v.offsetCents)}` : "kein Einbehalt"}</div></div>}
        </div>
        {(v.releasedCents > 0 || v.completedPayoutCents > 0) && (
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Zur Auszahlung freigegeben</div><div className="font-mono tnum font-semibold">{fmtCents(v.releasedCents)}</div><div className="text-[11px] text-ink-3">Entscheidung, kein Geldfluss</div></div>
            <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Tatsächlich ausgezahlt</div><div className="font-mono tnum font-semibold text-good">{fmtCents(v.completedPayoutCents)}</div></div>
            <div className={`rounded-md p-3 ${v.payoutRemainingCents > 0 ? "bg-bad-soft" : "bg-panel-2"}`}><div className="label-xs">Noch auszuzahlen</div><div className={`font-mono tnum font-semibold ${v.payoutRemainingCents > 0 ? "text-bad" : ""}`}>{fmtCents(v.payoutRemainingCents)}</div></div>
          </div>
        )}
        {v.releasedWithoutPayoutCents > 0 && v.completedPayoutCents === 0 && v.events.some((e) => e.type === "RELEASED" && e.status === "CONFIRMED" && e.method) && (
          <p className="rounded-md bg-info-soft text-info px-3 py-2 text-sm">Freigegeben – Auszahlung nicht in Rent-Base dokumentiert. Wurde die Kaution bereits außerhalb zurückgezahlt, kann die Auszahlung unten als „historisch nacherfasst“ dokumentiert werden.</p>
        )}
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
            {invoices.map((i) => <div key={i.id} className="flex justify-between"><span>{invoiceKindWord(i.kind)} {i.number}</span><span className="font-mono tnum">{fmtEur(Number(i.currentVersion?.grossTotal ?? i.grossTotal))}</span></div>)}
            <p className="text-xs text-ink-3">Rent-Base verrechnet die Kaution nie automatisch mit Zusatzkosten, Rechnungen oder Schadenabrechnungen. Eine Verrechnung gibt es nur als bewusste Aktion „Aus Kaution verrechnen“ gegen eine konkrete Rechnung; Freigabe und Einbehalt sind davon getrennte, dokumentierte Entscheidungen.</p>
          </div>
        )}
        {offset && !offset.blockedReason && offset.invoices.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="text-sm">Offene Forderung{offset.invoices.length > 1 ? "en" : ""}: {offset.invoices.map((i) => `${i.number} (${fmtCents(i.openCents)})`).join(", ")} · verfügbare Kaution <span className="font-mono tnum font-semibold">{fmtCents(offset.availableCents)}</span></div>
            <DepositOffsetForm action={applyDepositOffsetAction.bind(null, bookingId)} preview={previewDepositOffsetAction} bookingId={bookingId} nonce={`${nonce}-offset`} invoices={offset.invoices} availableCents={offset.availableCents} defaultWhen={now} />
          </div>
        )}
        {afterReturn && v.remainingCents > 0 && canDecide && (
          <DepositSettleForm action={settleDepositAction.bind(null, bookingId)} preview={previewDepositSettleAction} bookingId={bookingId} nonce={`${nonce}`} remainingCents={v.remainingCents} defaultWhen={now} />
        )}
        {afterReturn && v.remainingCents > 0 && !canDecide && <p className="text-xs text-ink-3">Freigabe oder Einbehalt der Kaution entscheidet die Disposition.</p>}
        {!afterReturn && v.receivedCents > 0 && <p className="text-xs text-ink-3">Freigabe oder Einbehalt wird nach der Rückgabe dokumentiert.</p>}
        {v.deposit && (v.payoutRemainingCents > 0 || v.completedPayoutCents > 0) && (
          <PayoutPanel tenantId={tenantId} role={role} sourceRef={{ sourceType: "SECURITY_DEPOSIT_REFUND", bookingId }} bookingId={bookingId} title="Kautionsauszahlung (tatsächlicher Geldfluss)" />
        )}
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
                  <span className={`font-mono tnum font-semibold ${e.status === "CANCELLED" ? "line-through text-ink-3" : e.type === "RETAINED" ? "text-bad" : e.type === "RELEASED" ? "text-good" : e.type === "OFFSET" || e.type === "OFFSET_RETURN" ? "text-info" : ""}`}>{e.type === "OFFSET" ? "− " : e.type === "OFFSET_RETURN" || e.type === "RECEIVED" ? "+ " : ""}{fmtCents(e.amountCents)}</span>
                </div>
                {e.reason && <div className="text-xs">Grund: {e.reason}</div>}
                <div className="text-xs text-ink-3 flex flex-wrap gap-x-2"><span>dokumentiert von {e.createdByName ?? "–"} am {fmtDateTime(e.createdAt)}</span>{e.type === "OFFSET" && <span>· kein Geldfluss, Storno unter „Zahlungen“</span>}{e.type === "OFFSET_RETURN" && <span>· kein Geldfluss, aus Kundenguthaben der Rechnung</span>}{e.note && <span>· {e.note}</span>}</div>
                {e.status === "CANCELLED" && <div className="text-xs text-bad">Storniert am {fmtDateTime(e.cancelledAt)} von {e.cancelledByName ?? "–"}: {e.cancellationReason}</div>}
                {e.status === "CONFIRMED" && canDecide && e.type === "OFFSET_RETURN" && <ReasonForm action={cancelOffsetReturnAction.bind(null, bookingId)} id={e.id} label="Rückführung stornieren" question={`Rückführung über ${fmtCents(e.amountCents)} stornieren? Das Kundenguthaben ist danach wieder verfügbar.`} />}
                {e.status === "CONFIRMED" && canDecide && e.type !== "OFFSET" && e.type !== "OFFSET_RETURN" && <ReasonForm action={cancelDepositEventAction.bind(null, bookingId)} id={e.id} label="Bewegung korrigieren (Storno)" question={`${DEPOSIT_EVENT_TYPES[e.type as DepositEventType]} über ${fmtCents(e.amountCents)} stornieren?`} />}
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

// Befehl 28: Bereich „Buchung storniert“ – eingefrorene Storno-Abrechnung (nie live neu gerechnet), Stornobestätigung (Archiv),
// bewusster Mailversand, Guthaben/Erstattung der Mietvorauszahlung über die bestehende Auszahlungs-Komponente.
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { db } from "@/lib/db";
import type { CancellationSnapshot } from "@/lib/cancellation";
import { fmtDateTime } from "@/lib/format";
import { invoiceHref } from "@/lib/invoice-links";
import { fmtCents } from "@/lib/money";
import { prepaymentBalance } from "@/lib/rental-payments";
import { PayoutPanel } from "../../auszahlungen/payout-panel";
import { MessageForm } from "./nachtrag/amendment-forms";
import { ensureCancellationDocumentAction, sendCancellationAction } from "../actions";

export async function CancellationPanel({ tenantId, bookingId, role, supportMode }: { tenantId: string; bookingId: string; role: string; supportMode: boolean }) {
  const b = await db.booking.findFirst({ where: { id: bookingId, tenantId }, select: { status: true, cancelledAt: true, cancellationReason: true, cancelledByName: true, cancellationSnapshot: true, contract: { select: { number: true, status: true } } } });
  if (!b || b.status !== "CANCELLED") return null;
  const s = b.cancellationSnapshot as unknown as CancellationSnapshot | null;
  const canManage = role !== "YARD" && !supportMode;
  const [doc, fee, mails, pre] = await Promise.all([
    db.document.findFirst({ where: { tenantId, bookingId, type: "BOOKING_CANCELLATION" }, orderBy: { version: "desc" }, select: { id: true, fileName: true, createdAt: true } }),
    db.invoice.findFirst({ where: { tenantId, bookingId, kind: "CANCELLATION_FEE", documentType: "INVOICE" }, select: { id: true, number: true, bookingId: true, kind: true } }),
    db.emailLog.findMany({ where: { tenantId, bookingId, template: "BOOKING_CANCELLATION" }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true, sentAt: true, createdAt: true, recipient: true } }),
    prepaymentBalance(tenantId, bookingId),
  ]);
  const f = s?.finances;
  return (
    <div id="storno" className="scroll-mt-20 flex flex-col gap-4">
      <Card title="Buchung storniert" right={<Chip tone="bad">Storniert</Chip>}>
        <div className="p-4 flex flex-col gap-3 text-sm">
          <p><b>Storniert</b>{b.cancelledAt ? ` am ${fmtDateTime(b.cancelledAt)}` : ""}{b.cancelledByName ? ` von ${b.cancelledByName}` : ""}{b.cancellationReason ? <> · Grund: {b.cancellationReason}</> : " · ohne erfassten Grund (Storno vor der Grundpflicht)"}</p>
          {b.contract?.status === "CANCELLED" && <p className="rounded-md bg-panel-2 px-3 py-2">Der unterschriebene Mietvertrag {b.contract.number} bleibt unverändert archiviert; er gehört zu dieser stornierten Buchung.</p>}
          {f && (
            <div className="rounded-md border border-line-soft p-3">
              <div className="label-xs mb-1">Storno-Abrechnung (eingefroren beim Storno)</div>
              <dl className="flex flex-col">
                <div className="flex justify-between gap-3 py-1 border-b border-line-soft"><dt>Geleistete Mietvorauszahlung</dt><dd className="font-mono tnum">{fmtCents(f.prepaidCents)}</dd></div>
                <div className="flex justify-between gap-3 py-1 border-b border-line-soft"><dt>Stornogebühr</dt><dd className="font-mono tnum text-right">{f.fee ? <>{fmtCents(f.fee.grossCents)}{fee && <Link href={invoiceHref(fee)} className="block text-xs underline font-sans">Rechnung {fee.number}</Link>}<span className="block text-[11px] text-ink-3 font-sans">{f.fee.taxTreatmentLabel}</span></> : "keine"}</dd></div>
                {f.stillOwedCents > 0 && <div className="flex justify-between gap-3 py-1 border-b border-line-soft"><dt>Noch zu zahlen</dt><dd className="font-mono tnum font-semibold">{fmtCents(f.stillOwedCents)}</dd></div>}
                {f.refund.mode === "PAYOUT" && <div className="flex justify-between gap-3 py-1 border-b border-line-soft"><dt>Erstattet{f.refund.payoutNumber ? ` (${f.refund.payoutNumber})` : ""}</dt><dd className="font-mono tnum font-semibold">{fmtCents(f.refund.amountCents)}</dd></div>}
                {f.refund.remainingCreditCents > 0 && <div className="flex justify-between gap-3 py-1 border-b border-line-soft"><dt>Als Kundenguthaben belassen</dt><dd className="font-mono tnum font-semibold">{fmtCents(f.refund.remainingCreditCents)}</dd></div>}
                {f.deposit && f.deposit.receivedCents > 0 && <div className="flex justify-between gap-3 py-1"><dt>Kaution</dt><dd className="font-mono tnum text-right">{f.deposit.mode === "RELEASE" ? `freigegeben ${fmtCents(f.deposit.releasedCents)}${f.deposit.payoutCents ? ` · zurückgezahlt ${fmtCents(f.deposit.payoutCents)}` : ""}` : f.deposit.mode === "KEEP" ? `vorerst behalten ${fmtCents(f.deposit.keptCents)}` : "–"}</dd></div>}
              </dl>
              <p className="text-xs text-ink-3 mt-2">Zahlungen, Rechnungen und Auszahlungen bleiben als eigene Belege unverändert bestehen. Den aktuellen Stand zeigen die Bereiche „Mietzahlung“, „Kaution“ und die Rechnungen.</p>
            </div>
          )}
          {s && (
            <div className="flex flex-col gap-2">
              <div className="label-xs">Stornobestätigung</div>
              {doc ? (
                <div className="flex flex-wrap items-center gap-2"><span className="break-all">{doc.fileName}</span><a href={`/api/documents/${doc.id}`} target="_blank" rel="noopener noreferrer" className="btn !py-1.5">Anzeigen</a><a href={`/api/documents/${doc.id}?download=1`} className="btn !py-1.5">Herunterladen</a></div>
              ) : (
                <div className="flex flex-wrap items-center gap-2"><Chip tone="amber">PDF noch nicht erzeugt</Chip>{canManage && <form action={ensureCancellationDocumentAction.bind(null, bookingId)}><button className="btn !py-1.5">Stornobestätigung erzeugen</button></form>}</div>
              )}
              {mails.map((m) => <div key={m.id} className="flex flex-wrap items-center gap-2 text-xs"><Chip tone={m.status === "SENT" ? "good" : m.status === "FAILED" ? "bad" : "amber"}>{m.status === "SENT" ? "versendet" : m.status === "FAILED" ? "fehlgeschlagen" : "in Arbeit"}</Chip><span>{fmtDateTime(m.sentAt ?? m.createdAt)}</span></div>)}
              {canManage && (s.customer.email ? (
                <MessageForm action={sendCancellationAction.bind(null, bookingId)} submitLabel={mails.some((m) => m.status === "SENT") ? "Stornobestätigung erneut senden" : "Stornobestätigung per E-Mail senden"} pendingLabel="Wird gesendet…" confirm={`Stornobestätigung an ${s.customer.email} senden? Angehängt werden die Bestätigung und die beim Storno neu entstandenen Belege.`}>
                  <input type="hidden" name="nonce" value={randomUUID()} />
                  <span className="text-xs text-ink-3">An: {s.customer.email} · Anhang: Stornobestätigung{f?.fee ? ", Rechnung Stornogebühr" : ""}{f?.refund.payoutNumber || f?.deposit?.payoutNumber ? ", Auszahlungsbeleg(e)" : ""}</span>
                </MessageForm>
              ) : <p className="text-xs text-ink-3">Zum Kunden ist keine E-Mail-Adresse hinterlegt.</p>)}
            </div>
          )}
        </div>
      </Card>
      {(pre.remainingCents > 0 || pre.refundedCents > 0) && <PayoutPanel tenantId={tenantId} role={supportMode ? "YARD" : role} sourceRef={{ sourceType: "RENTAL_PREPAYMENT_REFUND", bookingId }} bookingId={bookingId} title="Guthaben aus der Mietvorauszahlung" />}
      {fee && f?.refund.remainingCreditCents ? <p className="text-xs text-ink-3">Das Guthaben nach der Stornogebühr steht an der <Link href={invoiceHref(fee)} className="underline">Rechnung {fee.number}</Link> und wird dort erstattet.</p> : null}
    </div>
  );
}

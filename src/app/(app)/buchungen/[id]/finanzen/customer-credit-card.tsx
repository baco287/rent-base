// Befehl 22: Kundenguthaben einer Rechnung (nach Gutschrift, Storno oder Überzahlung) – Herkunft, Verbrauch und die zwei
// bewussten Folgeaktionen: zur Kaution zurückführen (nur wenn die Rechnung aus der Kaution ausgeglichen wurde) oder
// auszahlen (bestehender Auszahlungsprozess). Nichts passiert automatisch. Alle Zahlen aus der zentralen Summierung.
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { db } from "@/lib/db";
import { offsetReturnOptions } from "@/lib/deposit-offset-return";
import { fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { toDateTimeInputValue } from "@/lib/time";
import { cancelOffsetReturnAction, previewOffsetReturnAction, returnOffsetToDepositAction } from "./actions";
import { OffsetReturnForm, ReasonForm } from "./money-forms";

const Tile = ({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" | "info" }) => (
  <div className="rounded-md bg-panel-2 p-3 min-w-0"><div className="label-xs">{label}</div><div className={`font-mono tnum text-lg font-semibold ${tone === "good" ? "text-good" : tone === "bad" && value > 0 ? "text-bad" : tone === "info" ? "text-info" : ""}`}>{fmtCents(value)}</div></div>
);

export async function CustomerCreditCard({ tenantId, bookingId, role, invoiceId }: { tenantId: string; bookingId: string; role: string; invoiceId: string }) {
  const o = await offsetReturnOptions(tenantId, invoiceId);
  const f = o.financials;
  if (f.customerCreditCents <= 0 && f.returnedToDepositCents <= 0 && f.completedRefundCents <= 0) return null;
  const canManage = role !== "YARD";
  const returns = await db.securityDepositEvent.findMany({ where: { tenantId, invoiceId, type: "OFFSET_RETURN" }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }] });
  const origin = o.counterDocuments.length > 0 ? o.counterDocuments.map((c) => `${c.documentType === "CANCELLATION" ? "Stornobeleg" : "Gutschrift"} ${c.number ?? ""} (${fmtCents(c.grossCents)})`).join(", ") : "Zahlungen über der Rechnungssumme";
  const returnable = canManage && !o.blockedReason ? o.offsets.filter((x) => x.returnableCents > 0) : [];
  const now = toDateTimeInputValue(new Date());
  return (
    <Card title="Kundenguthaben" right={f.refundRemainingCents > 0 ? <Chip tone="bad">noch verfügbar {fmtCents(f.refundRemainingCents)}</Chip> : <Chip tone="good">erledigt</Chip>}>
      <div className="p-4 flex flex-col gap-4">
        <p className="text-sm text-ink-2">Entstanden durch: <span className="font-medium text-ink">{origin}</span>. Die Rechnung und alle Zahlungen bleiben unverändert.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <Tile label="Guthaben gesamt" value={f.customerCreditCents} />
          <Tile label="Zurück zur Kaution" value={f.returnedToDepositCents} tone="info" />
          <Tile label="Ausgezahlt" value={f.completedRefundCents} tone="good" />
          <Tile label="Noch verfügbar" value={f.refundRemainingCents} tone="bad" />
        </div>
        {f.refundExcessCents > 0 && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Es wurden {fmtCents(f.refundExcessCents)} mehr ausgezahlt oder zurückgeführt, als nach heutigem Stand Guthaben besteht. Die Vorgänge bleiben historisch wahr; bitte den Fall prüfen.</p>}
        {f.refundRemainingCents > 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">Was soll mit den {fmtCents(f.refundRemainingCents)} passieren? Rent-Base entscheidet das nicht selbst.</p>
            {returnable.map((x) => (
              <div key={x.paymentId} className="rounded-lg border border-line-soft p-3 flex flex-col gap-2">
                <div className="text-sm">Kautionsverrechnung vom {fmtDateTime(x.paidAt)}: <span className="font-mono tnum">{fmtCents(x.amountCents)}</span>{x.returnedCents > 0 && <> · bereits zurückgeführt <span className="font-mono tnum">{fmtCents(x.returnedCents)}</span></>} · noch rückführbar <span className="font-mono tnum font-semibold">{fmtCents(x.returnableCents)}</span></div>
                <OffsetReturnForm action={returnOffsetToDepositAction.bind(null, bookingId, invoiceId, x.paymentId)} preview={previewOffsetReturnAction.bind(null, invoiceId, x.paymentId)} nonce={randomUUID()} defaultWhen={now} maxCents={Math.min(f.refundRemainingCents, x.returnableCents)} />
              </div>
            ))}
            {canManage && o.blockedReason && o.offsets.length > 0 && <p className="text-sm text-ink-3">Zur Kaution zurückführen: {o.blockedReason}</p>}
            {canManage && <div><Link href="#erstattung" className="btn">Guthaben auszahlen</Link></div>}
            {!canManage && <p className="text-xs text-ink-3">Über das Guthaben entscheidet die Disposition.</p>}
          </div>
        )}
        {returns.length > 0 && (
          <div>
            <div className="label-xs mb-1">Rückführungen zur Kaution</div>
            <ul className="divide-y divide-line-soft text-sm">
              {returns.map((e) => (
                <li key={e.id} className={`py-2 flex flex-col gap-1 ${e.status === "CANCELLED" ? "opacity-70" : ""}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span><span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(e.occurredAt)}</span> · zur Kaution zurückgeführt{e.reference ? ` · ${e.reference}` : ""}</span>
                    <span className={`font-mono tnum font-semibold ${e.status === "CANCELLED" ? "line-through text-ink-3" : "text-info"}`}>{fmtCents(e.amountCents)}</span>
                  </div>
                  <div className="text-xs text-ink-3">von {e.createdByName ?? "–"} · kein Geldfluss{e.note ? ` · ${e.note}` : ""}</div>
                  {e.status === "CANCELLED" && <div className="text-xs text-bad">Storniert am {fmtDateTime(e.cancelledAt)} von {e.cancelledByName ?? "–"}: {e.cancellationReason}</div>}
                  {e.status === "CONFIRMED" && canManage && <ReasonForm action={cancelOffsetReturnAction.bind(null, bookingId)} id={e.id} label="Rückführung stornieren" question={`Rückführung über ${fmtCents(e.amountCents)} stornieren? Das Guthaben ist danach wieder verfügbar, die Kaution um diesen Betrag geringer.`} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

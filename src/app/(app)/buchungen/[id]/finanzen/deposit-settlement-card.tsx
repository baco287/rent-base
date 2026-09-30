// Befehl 20.9: „Kaution & Abrechnung“ auf der Rechnungsseite – die finanzielle Gesamtsituation vor und nach dem Abschluss
// der Rechnung. Rechnet nichts Neues: Forderungsseite = invoicePaymentSummary / Entwurfsbetrag, Kautionsseite = depositView,
// Verrechnung = der bestehende DEPOSIT_OFFSET-Vorgang aus Befehl 20.7 (deposit-offset.ts), Freigabe = settleDeposit.
// Nichts passiert automatisch: Verrechnung und Freigabe sind zwei getrennte, ausdrücklich bestätigte Aktionen.
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { depositStatusLabel } from "@/lib/constants";
import { depositView } from "@/lib/deposits";
import { depositOffsetOptions } from "@/lib/deposit-offset";
import { fmtCents } from "@/lib/money";
import { invoicePaymentSummary } from "@/lib/payments";
import { toDateTimeInputValue } from "@/lib/time";
import { applyDepositOffsetAction, previewDepositOffsetAction, previewDepositSettleAction, settleDepositAction } from "./actions";
import { DepositOffsetForm, DepositSettleForm } from "./money-forms";

const Tile = ({ label, value, tone, sub }: { label: string; value: string; tone?: "good" | "bad" | "info"; sub?: string }) => (
  <div className="rounded-md bg-panel-2 p-3 text-sm"><div className="label-xs">{label}</div><div className={`font-mono tnum text-lg font-semibold ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "info" ? "text-info" : ""}`}>{value}</div>{sub && <div className="text-[11px] text-ink-3">{sub}</div>}</div>
);

export async function DepositSettlementCard({ tenantId, bookingId, role, invoice }: {
  tenantId: string;
  bookingId: string;
  role: string;
  /** Entwurf: Bruttobetrag des Entwurfs + vorab dokumentierte Mietzahlungen; abgeschlossen: wirksame Forderung aus der Zahlungsübersicht */
  invoice: { id: string; number: string | null; status: "DRAFT" | "FINALIZED"; grossCents: number; prepaidCents: number };
}) {
  const canDecide = role !== "YARD";
  const v = await depositView(tenantId, bookingId);
  const finalized = invoice.status === "FINALIZED";
  const pay = finalized ? await invoicePaymentSummary(tenantId, invoice.id) : null;
  const grossCents = pay ? pay.grossCents : invoice.grossCents;
  const paidCents = pay ? pay.paidCents : invoice.prepaidCents;
  const openCents = pay ? pay.openCents : Math.max(0, invoice.grossCents - invoice.prepaidCents);
  const afterReturn = v.bookingStatus === "RETURNED" || v.bookingStatus === "CANCELLED";
  const availableCents = Math.max(0, v.remainingCents);
  const offset = finalized && canDecide && afterReturn && availableCents > 0 && openCents > 0 ? await depositOffsetOptions(tenantId, bookingId) : null;
  const thisInvoice = offset?.invoices.find((i) => i.id === invoice.id) ?? null;
  const suggested = thisInvoice ? Math.max(0, Math.min(thisInvoice.openCents, availableCents)) : 0;
  const nonce = randomUUID();
  const now = toDateTimeInputValue(new Date());
  const noDeposit = !v.deposit && !v.contractSigned;

  return (
    <Card title="Kaution & Abrechnung" right={v.expectedCents > 0 ? <Chip tone={v.status === "RECEIVED" ? "info" : v.status === "EXPECTED" ? "amber" : "grey"}>Kaution: {depositStatusLabel(v.status, v)}</Chip> : undefined}>
      <div className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <section aria-label="Rechnung" className="flex flex-col gap-2">
            <div className="font-semibold text-sm">Rechnung{invoice.number ? ` ${invoice.number}` : ""}{finalized ? "" : " (Entwurf)"}</div>
            <div className="grid grid-cols-3 gap-2">
              <Tile label={finalized ? "Wirksame Forderung" : "Rechnungsbetrag"} value={fmtCents(grossCents)} />
              <Tile label={finalized ? "Bezahlt" : "Dokumentierte Mietzahlungen"} value={fmtCents(paidCents)} tone="good" sub={pay && pay.offsetCents > 0 ? `davon ${fmtCents(pay.offsetCents)} aus Kaution` : finalized ? undefined : "werden beim Abschluss zugeordnet"} />
              <Tile label={finalized ? "Offen" : "Offen nach Abschluss"} value={fmtCents(openCents)} tone={openCents > 0 ? "bad" : undefined} />
            </div>
          </section>
          <section aria-label="Kaution" className="flex flex-col gap-2 md:border-l md:border-line-soft md:pl-4">
            <div className="font-semibold text-sm">Kaution</div>
            {noDeposit ? (
              <p className="text-sm text-ink-3">Zu dieser Buchung ist noch keine Kaution dokumentiert.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Tile label="Vereinbart" value={fmtCents(v.expectedCents)} />
                <Tile label="Tatsächlich erhalten" value={fmtCents(v.receivedCents)} />
                <Tile label="Bereits freigegeben" value={fmtCents(v.releasedCents)} tone={v.releasedCents > 0 ? "good" : undefined} />
                <Tile label="Bereits ausgezahlt" value={fmtCents(v.completedPayoutCents)} />
                <Tile label="Bereits einbehalten" value={fmtCents(v.retainedCents)} tone={v.retainedCents > 0 ? "bad" : undefined} />
                <Tile label="Mit Forderungen verrechnet" value={fmtCents(v.offsetGrossCents)} tone={v.offsetCents > 0 ? "info" : undefined} sub={v.offsetReturnedCents > 0 ? `davon zurückgeführt ${fmtCents(v.offsetReturnedCents)} · netto ${fmtCents(v.offsetCents)}` : undefined} />
                <div className="col-span-2 sm:col-span-3"><Tile label="Aktuell verfügbar" value={fmtCents(availableCents)} tone={availableCents > 0 ? "info" : undefined} sub="erhalten − freigegeben − einbehalten − verrechnet" /></div>
              </div>
            )}
          </section>
        </div>

        {!finalized && (
          <p className="text-xs text-ink-3">Die Kaution wird nie automatisch verrechnet.{openCents > 0 && availableCents > 0 ? ` Unten bei „Rechnung finalisieren“ können Sie bewusst ${fmtCents(Math.min(openCents, availableCents))} aus der Kaution verrechnen (Vorschlag: kleinerer Betrag aus offener Forderung und verfügbarer Kaution).` : ""} Freigabe und Auszahlung der verbleibenden Kaution sind danach eigene Schritte.</p>
        )}

        {finalized && thisInvoice && offset && !offset.blockedReason && (
          <div className="flex flex-col gap-2 rounded-lg border-2 border-info/40 p-3">
            <div className="text-sm">Offene Forderung <span className="font-mono tnum font-semibold">{fmtCents(thisInvoice.openCents)}</span> · verfügbare Kaution <span className="font-mono tnum font-semibold">{fmtCents(availableCents)}</span> → Vorschlag <span className="font-mono tnum font-semibold">{fmtCents(suggested)}</span> aus Kaution verrechnen.</div>
            <div className="text-xs text-ink-3">Danach: Rechnung offen {fmtCents(Math.max(0, thisInvoice.openCents - suggested))} · verbleibende Kaution {fmtCents(availableCents - suggested)} · zur Freigabe/Rückzahlung verfügbar {fmtCents(availableCents - suggested)}. Kein Geldeingang, keine Zahlungsart „Kaution“ – die Kaution bleibt Sicherheitsleistung.</div>
            <DepositOffsetForm action={applyDepositOffsetAction.bind(null, bookingId)} preview={previewDepositOffsetAction} bookingId={bookingId} nonce={`${nonce}-offset`} invoices={[thisInvoice]} availableCents={availableCents} defaultWhen={now} buttonLabel={`${fmtCents(suggested)} Kaution mit der offenen Forderung verrechnen`} />
          </div>
        )}
        {finalized && openCents > 0 && availableCents > 0 && afterReturn && canDecide && (!offset || offset.blockedReason || !thisInvoice) && (
          <p className="text-sm text-ink-3">{offset?.blockedReason ?? "Für diese Rechnung ist derzeit keine Verrechnung möglich (z. B. Gegenbeleg-Entwurf)."}</p>
        )}
        {finalized && openCents === 0 && availableCents > 0 && afterReturn && <p className="text-sm text-good">Die Forderung ist ausgeglichen. Es wird keine Verrechnung angeboten; {fmtCents(availableCents)} der Kaution bleiben für Freigabe und Auszahlung verfügbar.</p>}
        {finalized && !afterReturn && availableCents > 0 && openCents > 0 && <p className="text-sm text-ink-3">Eine Verrechnung ist erst nach der Rückgabe möglich.</p>}

        {finalized && afterReturn && availableCents > 0 && canDecide && (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium">Verbleibende Kaution (zur Rückzahlung verfügbar, noch nicht freigegeben oder ausgezahlt): {fmtCents(availableCents)}</div>
            <DepositSettleForm action={settleDepositAction.bind(null, bookingId)} preview={previewDepositSettleAction} bookingId={bookingId} nonce={`${nonce}-settle`} remainingCents={availableCents} defaultWhen={now} releaseLabel={`${fmtCents(availableCents)} Kaution zur Auszahlung freigeben`} />
            <p className="text-xs text-ink-3">Freigabe ist die Entscheidung, die Auszahlung der tatsächliche Geldfluss – dokumentiert unter <Link href={`/buchungen/${bookingId}#kaution`} className="underline">Kaution</Link> auf der Buchungsseite.</p>
          </div>
        )}
        {finalized && (v.payoutRemainingCents > 0 || v.completedPayoutCents > 0) && <p className="text-xs text-ink-3">Zur Auszahlung freigegeben, noch auszuzahlen: {fmtCents(v.payoutRemainingCents)} · bereits ausgezahlt: {fmtCents(v.completedPayoutCents)} (<Link href={`/buchungen/${bookingId}#kaution`} className="underline">Kautionsauszahlung</Link>).</p>}
        {!canDecide && finalized && <p className="text-xs text-ink-3">Verrechnung, Freigabe und Auszahlung entscheidet die Disposition.</p>}
      </div>
    </Card>
  );
}

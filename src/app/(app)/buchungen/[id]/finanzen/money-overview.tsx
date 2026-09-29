// Befehl 20.7: Miete und Kaution auf einen Blick – gemeinsam sichtbar, fachlich strikt getrennt. Reine Anzeige aus den
// bestehenden Summierungen (rentalPaymentSummary, depositView); keine zweite Rechnung, keine Verrechnung. Die
// Aktionen selbst bleiben in den Bereichen „Mietzahlung“ und „Kaution“ (Sprungmarken).
// Befehl 21: Die Kautionsseite zeigt wie die Miete drei klare Werte (Vereinbart / Erhalten / Noch offen) mit Status.
// „Erhalten“ stammt ausschließlich aus dokumentierten Kautionsbewegungen – nie aus dem Buchungs- oder Vertragsbetrag.
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { DEPOSIT_STATUS } from "@/lib/constants";
import { DEPOSIT_RECEIPT_LABELS, depositReceiptState, depositView } from "@/lib/deposits";
import { fmtCents } from "@/lib/money";
import { rentalPaymentSummary } from "@/lib/rental-payments";
import { RentalPaymentStatusChip } from "./panels";

export async function MoneyOverview({ tenantId, bookingId, role }: { tenantId: string; bookingId: string; role: string }) {
  const [rent, dep] = await Promise.all([rentalPaymentSummary(tenantId, bookingId), depositView(tenantId, bookingId)]);
  const canRecord = role !== "YARD";
  // Vereinbart: Kautionszeile bzw. abgeschlossener Vertrag; davor der Kautionsbetrag der Buchung (nur „vereinbart“, nie „erhalten“)
  const documented = Boolean(dep.deposit) || dep.contractSigned;
  const agreedCents = documented ? dep.expectedCents : dep.bookingDepositCents;
  const depositOpen = Math.max(0, agreedCents - dep.receivedCents);
  const receipt = depositReceiptState(agreedCents, dep.receivedCents);
  const decided = dep.releasedCents + dep.retainedCents + dep.offsetCents > 0;
  const tile = (label: string, value: number, tone: "" | "good" | "bad" | "info" = "") => (
    <div className="rounded-md bg-panel-2 p-3 min-w-0"><div className="label-xs">{label}</div><div className={`font-mono tnum text-lg font-semibold ${tone === "good" ? "text-good" : tone === "bad" && value > 0 ? "text-bad" : tone === "info" ? "text-info" : ""}`}>{fmtCents(value)}</div></div>
  );
  return (
    <Card title="Miete und Kaution" right={<span className="text-xs text-ink-3">getrennt geführt – keine automatische Verrechnung</span>}>
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="flex flex-col gap-2" aria-label="Miete">
          <div className="flex items-center gap-2"><span className="font-semibold text-sm">Miete</span><RentalPaymentStatusChip status={rent.status} /></div>
          <div className="grid grid-cols-3 gap-2 text-sm">
            {tile(rent.source === "ESTIMATE" ? "Voraussichtlich" : "Gesamt", rent.grossCents)}
            {tile("Bezahlt", rent.paidCents, "good")}
            {rent.status === "OVERPAID" ? tile("Zu viel erfasst", rent.overpaidCents, "bad") : tile("Offen", rent.openCents, "bad")}
          </div>
          {rent.offsetCents > 0 && <p className="text-[11px] text-ink-3">Davon {fmtCents(rent.offsetCents)} aus der Kaution verrechnet (kein Geldeingang).</p>}
          <div>{canRecord && rent.canRecord ? <Link href="#mietzahlung" className="btn !py-1.5 text-xs">Mietzahlung erfassen</Link> : <Link href="#mietzahlung" className="btn !py-1.5 text-xs">Zur Mietzahlung</Link>}</div>
        </section>
        <section className="flex flex-col gap-2 md:border-l md:border-line-soft md:pl-4" aria-label="Kaution">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm">Kaution</span>
            <Chip tone={receipt === "RECEIVED" ? "good" : receipt === "NONE_AGREED" ? "grey" : "amber"}>{DEPOSIT_RECEIPT_LABELS[receipt]}</Chip>
            {decided && <Chip tone={dep.status === "RELEASED" ? "good" : dep.status === "RETAINED" ? "bad" : "info"}>{DEPOSIT_STATUS[dep.status]}</Chip>}
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm">
            {tile("Vereinbart", agreedCents)}
            {tile("Erhalten", dep.receivedCents, "good")}
            {tile("Noch offen", depositOpen, "bad")}
          </div>
          {decided && (
            <p className="text-[11px] text-ink-3">{[dep.releasedCents > 0 ? `freigegeben ${fmtCents(dep.releasedCents)}` : null, dep.retainedCents > 0 ? `einbehalten ${fmtCents(dep.retainedCents)}` : null, dep.offsetCents > 0 ? `mit Forderung verrechnet ${fmtCents(dep.offsetCents)}` : null, `verbleibend ${fmtCents(Math.max(0, dep.remainingCents))}`].filter(Boolean).join(" · ")}</p>
          )}
          {!documented && agreedCents > 0 && <p className="text-[11px] text-ink-3">Vereinbart laut Buchung. Der Eingang wird nach dem Vertragsabschluss unter „Kaution“ dokumentiert.</p>}
          <div>
            {documented && depositOpen > 0 && dep.bookingStatus !== "CANCELLED" ? <Link href="#kaution" className="btn btn-primary !py-1.5 text-xs">Kaution erhalten</Link> : <Link href="#kaution" className="btn !py-1.5 text-xs">Zur Kaution</Link>}
          </div>
        </section>
      </div>
      <p className="px-4 pb-3 text-xs text-ink-3">Die Kaution ist eine Sicherheitsleistung und keine Mietzahlung; sie verringert den offenen Mietbetrag nicht. Verrechnet wird nur bewusst – beim Rechnungsabschluss oder unter „Kaution“.</p>
    </Card>
  );
}

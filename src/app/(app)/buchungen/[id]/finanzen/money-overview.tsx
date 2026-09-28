// Befehl 20.7: Miete und Kaution auf einen Blick – gemeinsam sichtbar, fachlich strikt getrennt. Reine Anzeige aus den
// bestehenden Summierungen (rentalPaymentSummary, depositView); keine zweite Rechnung, keine Verrechnung. Die
// Aktionen selbst bleiben in den Bereichen „Mietzahlung“ und „Kaution“ (Sprungmarken).
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { DEPOSIT_STATUS } from "@/lib/constants";
import { depositView } from "@/lib/deposits";
import { fmtCents } from "@/lib/money";
import { rentalPaymentSummary } from "@/lib/rental-payments";
import { RentalPaymentStatusChip } from "./panels";

export async function MoneyOverview({ tenantId, bookingId, role }: { tenantId: string; bookingId: string; role: string }) {
  const [rent, dep] = await Promise.all([rentalPaymentSummary(tenantId, bookingId), depositView(tenantId, bookingId)]);
  const canRecord = role !== "YARD";
  const depositOpen = Math.max(0, dep.expectedCents - dep.receivedCents);
  const tile = (label: string, value: number, tone: "" | "good" | "bad" | "info" = "") => (
    <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">{label}</div><div className={`font-mono tnum text-lg font-semibold ${tone === "good" ? "text-good" : tone === "bad" && value > 0 ? "text-bad" : tone === "info" ? "text-info" : ""}`}>{fmtCents(value)}</div></div>
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
          <div>{canRecord && rent.canRecord ? <Link href="#mietzahlung" className="btn !py-1.5 text-xs">Mietzahlung erfassen</Link> : <Link href="#mietzahlung" className="text-xs underline">Zur Mietzahlung</Link>}</div>
        </section>
        <section className="flex flex-col gap-2 md:border-l md:border-line-soft md:pl-4" aria-label="Kaution">
          <div className="flex items-center gap-2"><span className="font-semibold text-sm">Kaution</span>{dep.contractSigned ? <Chip tone={dep.status === "RELEASED" ? "good" : dep.status === "RECEIVED" ? "info" : dep.status === "EXPECTED" ? "amber" : "grey"}>{DEPOSIT_STATUS[dep.status]}</Chip> : <Chip>laut Vertrag</Chip>}</div>
          {dep.contractSigned ? (
            <>
              <div className="grid grid-cols-3 gap-2 text-sm">
                {tile("Vereinbart", dep.expectedCents)}
                {tile("Erhalten", dep.receivedCents, "good")}
                {tile("Noch offen", depositOpen, "bad")}
              </div>
              {(dep.releasedCents > 0 || dep.retainedCents > 0 || dep.offsetCents > 0) && (
                <p className="text-[11px] text-ink-3">{[dep.releasedCents > 0 ? `freigegeben ${fmtCents(dep.releasedCents)}` : null, dep.retainedCents > 0 ? `einbehalten ${fmtCents(dep.retainedCents)}` : null, dep.offsetCents > 0 ? `mit Forderung verrechnet ${fmtCents(dep.offsetCents)}` : null].filter(Boolean).join(" · ")}</p>
              )}
              <div>{depositOpen > 0 && dep.bookingStatus !== "CANCELLED" ? <Link href="#kaution" className="btn !py-1.5 text-xs">Kaution erhalten</Link> : <Link href="#kaution" className="text-xs underline">Zur Kaution</Link>}</div>
            </>
          ) : (
            <p className="text-sm text-ink-3">Die vereinbarte Kaution ergibt sich aus dem abgeschlossenen Mietvertrag{dep.expectedCents > 0 ? ` (Buchung: ${fmtCents(dep.expectedCents)})` : ""}.</p>
          )}
        </section>
      </div>
      <p className="px-4 pb-3 text-xs text-ink-3">Die Kaution ist eine Sicherheitsleistung und keine Mietzahlung; sie verringert den offenen Mietbetrag nicht. Eine Verrechnung mit einer Rechnung ist nur nach der Rückgabe als bewusste Aktion unter „Kaution“ möglich.</p>
    </Card>
  );
}

// Reiter der Kundenakte 360°. Server-Komponenten; jeder Reiter lädt nur seine Daten. Alle Beträge kommen aus den
// zentralen Summierungen (lib/customer-file.ts → financialsFor, computeDepositFinancials). Stornierte Zahlungen und
// Auszahlungen bleiben sichtbar, werden aber nie summiert. Haftung bei Schäden ist die Entscheidung der Akte.
import Link from "next/link";
import { BookingStatusChip, Card, Chip, Empty, KPI, Plate } from "@/components/ui";
import { DocumentThumb } from "@/components/document-thumb";
import { AUTHORITY_DOCUMENT_TYPES, CONTRACT_STATUS, DAMAGE_CASE_DOCUMENT_TYPES, DEPOSIT_EVENT_TYPES, DEPOSIT_STATUS, DOCUMENT_TYPES, DRIVER_ROLES, DRIVER_VERIFICATION_STATUS, EMAIL_STATUS, INVOICE_CHAIN_STATUS, INVOICE_DOCUMENT_TYPES, PAYMENT_METHODS, PAYOUT_METHODS, PAYOUT_SOURCE_TYPES, PAYOUT_STATUS, type AuthorityDocumentType, type DamageCaseDocumentType, type DepositEventType, type DepositStatus, type DocumentType, type DriverRole, type DriverVerificationStatus, type EmailStatus, type InvoiceDocumentTypeKey, type PaymentMethod, type PayoutMethod, type PayoutSourceType, type PayoutStatus, isSideInvoice, invoiceKindWord } from "@/lib/constants";
import { casesForCustomer } from "@/lib/authority";
import { driverDocumentHistoryForCustomer } from "@/lib/driver-verification";
import { BOOKINGS_PAGE, customerBookings, customerDamageCases, customerDeposits, customerDocuments, customerDriverRoles, customerEmails, customerFinance, customerTimeline, type CustomerOverview } from "@/lib/customer-file";
import { templateLabel } from "@/lib/dashboard";
import { customerName, fmtDate, fmtDateTime, fmtEur } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { AuthorityCasesPanel } from "../../behoerden/authority-panel";
import { CaseStatusChip, LiabilityChip } from "../../schaeden/chips";
import { PaymentStatusChip } from "../../buchungen/[id]/finanzen/panels";

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const Row = ({ children }: { children: React.ReactNode }) => <li className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">{children}</li>;

// ---------------------------------------------------------------------------

export function OverviewTab({ customerId, o }: { customerId: string; o: CustomerOverview }) {
  const tab = (t: string) => `/kunden/${customerId}?tab=${t}`;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPI label="Buchungen gesamt" value={o.bookingsTotal} detail={<Link href={tab("buchungen")} className="underline">als Mieter{o.driverOnlyContracts > 0 ? ` · zusätzlich ${o.driverOnlyContracts}× als Fahrer` : ""}</Link>} />
        <KPI label="Aktive Mieten" value={o.activeRentals} detail={o.activeRentals > 0 ? "unterwegs" : "keine"} hot={o.activeRentals > 0} />
        <KPI label="Letzte Miete" value={o.lastRental ? <span className="text-xl">{fmtDate(o.lastRental.actualReturnAt ?? o.lastRental.endAt)}</span> : "–"} detail={o.lastRental ? <Link href={`/buchungen/${o.lastRental.id}`} className="underline">{o.lastRental.number} · {o.lastRental.plate}</Link> : "noch keine"} />
        <KPI label="Nächste Buchung" value={o.nextBooking ? <span className="text-xl">{fmtDate(o.nextBooking.startAt)}</span> : "–"} detail={o.nextBooking ? <Link href={`/buchungen/${o.nextBooking.id}`} className="underline">{o.nextBooking.number} · {o.nextBooking.plate}</Link> : "keine reserviert"} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPI label="Offene Forderungen" value={<span className="text-xl">{fmtCents(o.openReceivablesCents)}</span>} detail={<Link href={tab("finanzen")} className="underline">{o.openInvoices} offene Rechnung{o.openInvoices === 1 ? "" : "en"}</Link>} hot={o.openReceivablesCents > 0} />
        <KPI label="Guthaben / Erstattung offen" value={<span className="text-xl">{fmtCents(o.refundOpenCents)}</span>} detail={<Link href={tab("finanzen")} className="underline">{o.refundsOpen > 0 ? `${o.refundsOpen} Beleg${o.refundsOpen === 1 ? "" : "e"} mit Kundenguthaben` : "nichts zu erstatten"}</Link>} hot={o.refundOpenCents > 0} />
        <KPI label="Kautionen auszuzahlen" value={<span className="text-xl">{fmtCents(o.depositPayoutOpenCents)}</span>} detail={<Link href={tab("kautionen")} className="underline">{o.depositsHeld > 0 ? `${o.depositsHeld} nach Rückgabe noch nicht entschieden` : "freigegeben, noch nicht ausgezahlt"}</Link>} hot={o.depositPayoutOpenCents > 0 || o.depositsHeld > 0} />
        <KPI label="Offene Akten" value={o.openDamageCases + o.openAuthorityCases} detail={<><Link href={tab("schaeden")} className="underline">{o.openDamageCases} Schaden</Link> · <Link href={tab("behoerden")} className="underline">{o.openAuthorityCases} Behörde</Link></>} hot={o.openDamageCases + o.openAuthorityCases > 0} />
      </div>
      <Card title="Offen" right={<Chip tone={o.tasks.length ? "amber" : "good"}>{o.tasks.length}</Chip>}>
        {o.tasks.length === 0 ? <p className="p-4 text-sm text-ink-3">Nichts offen. Alle Vorgänge dieser Person sind erledigt oder in Ordnung.</p> : (
          <ul className="divide-y divide-line-soft">
            {o.tasks.map((t) => <Row key={t.key}><Chip tone={t.tone}>{t.tone === "bad" ? "Dringend" : t.tone === "amber" ? "Offen" : "Hinweis"}</Chip><Link href={t.href} className="font-medium hover:underline">{t.title}</Link><span className="text-xs text-ink-3">{t.detail}</span></Row>)}
          </ul>
        )}
      </Card>
      <p className="text-xs text-ink-3">Kennzahlen sind Stichtagswerte aus den Modulen Rechnungen, Zahlungen, Kautionen und Auszahlungen. Kautionen sind kein Umsatz; Beträge aus Schadenabrechnungen sind Schadenersatz.</p>
    </>
  );
}

// ---------------------------------------------------------------------------

export async function BookingsTab({ tenantId, customerId, page, now }: { tenantId: string; customerId: string; page: number; now: number }) {
  const [list, roles] = await Promise.all([customerBookings(tenantId, customerId, page, BOOKINGS_PAGE), customerDriverRoles(tenantId, customerId)]);
  const href = (p: number) => `/kunden/${customerId}?tab=buchungen&seite=${p}`;
  return (
    <>
      <Card title="Buchungen als Mieter" right={<Chip>{list.total}</Chip>}>
        {list.rows.length === 0 ? <Empty>Noch keine Buchungen.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead><tr className="text-left"><th className="label-xs px-3 py-2 border-b border-line">Nr.</th><th className="label-xs px-3 py-2 border-b border-line">Fahrzeug</th><th className="label-xs px-3 py-2 border-b border-line">Abholung</th><th className="label-xs px-3 py-2 border-b border-line">Rückgabe</th><th className="label-xs px-3 py-2 border-b border-line">Vertrag</th><th className="label-xs px-3 py-2 border-b border-line text-right">Gesamt</th><th className="label-xs px-3 py-2 border-b border-line">Status</th></tr></thead>
              <tbody>
                {list.rows.map((b) => {
                  const live = b.status === "ACTIVE" || (b.status === "RESERVED" && b.startAt.getTime() >= now);
                  const overdue = b.status === "ACTIVE" && b.endAt.getTime() < now;
                  const inv = b.invoices[0];
                  return (
                    <tr key={b.id} className={`border-b border-line-soft last:border-0 hover:bg-panel-2/60 ${live ? "bg-brand-soft/40" : ""}`}>
                      <td className="px-3 py-2.5 font-mono tnum"><Link href={`/buchungen/${b.id}`} className="hover:underline font-medium">{b.number}</Link></td>
                      <td className="px-3 py-2.5"><Plate>{b.vehicle.plate}</Plate> <span className="text-xs text-ink-3">{b.vehicle.make} {b.vehicle.model}</span></td>
                      <td className="px-3 py-2.5 font-mono tnum">{fmtDateTime(b.actualPickupAt ?? b.startAt)}{b.actualPickupAt && <span className="block text-[11px] text-ink-3">geplant {fmtDateTime(b.startAt)}</span>}</td>
                      <td className={`px-3 py-2.5 font-mono tnum ${overdue ? "text-bad font-semibold" : ""}`}>{fmtDateTime(b.actualReturnAt ?? b.endAt)}{b.actualReturnAt && <span className="block text-[11px] text-ink-3">geplant {fmtDateTime(b.endAt)}</span>}</td>
                      <td className="px-3 py-2.5">{b.contract ? <Link href={`/buchungen/${b.id}/vertrag`} className="font-mono tnum hover:underline">{b.contract.number}</Link> : <span className="text-ink-3">–</span>}{b.contract && <span className="block text-[11px] text-ink-3">{CONTRACT_STATUS[b.contract.status as keyof typeof CONTRACT_STATUS] ?? b.contract.status}</span>}</td>
                      <td className="px-3 py-2.5 text-right font-mono tnum">{inv ? <Link href={`/buchungen/${b.id}/rechnung?nr=${inv.id}`} className="hover:underline">{fmtEur(inv.currentVersion?.grossTotal)}</Link> : b.contract?.status === "SIGNED" ? fmtEur(b.contract.totalAmount) : "–"}{inv && <span className="block text-[11px] text-ink-3">{inv.number}</span>}</td>
                      <td className="px-3 py-2.5">{overdue ? <Chip tone="bad">Überfällig</Chip> : <BookingStatusChip status={b.status} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.pages > 1 && (
          <nav aria-label="Seiten" className="px-4 py-3 border-t border-line-soft flex items-center gap-2">
            {list.page > 1 && <Link href={href(list.page - 1)} className="btn !py-1.5">Zurück</Link>}
            <Chip>Seite {list.page} von {list.pages}</Chip>
            {list.page < list.pages && <Link href={href(list.page + 1)} className="btn !py-1.5">Weiter</Link>}
          </nav>
        )}
      </Card>
      <Card title="Als Fahrer eingetragen" right={<Chip>{roles.length}</Chip>}>
        {roles.length === 0 ? <p className="p-4 text-sm text-ink-3">In keinem fremden Mietvertrag als Fahrer oder Zusatzfahrer eingetragen.</p> : (
          <ul className="divide-y divide-line-soft">
            {roles.map((r) => <Row key={r.id}><Chip tone="info">{DRIVER_ROLES[r.role as DriverRole] ?? r.role}</Chip><Link href={`/buchungen/${r.contract.bookingId}/vertrag`} className="font-mono tnum font-medium hover:underline">{r.contract.number}</Link><span>Mieter {customerName(r.contract.customer)}</span><Plate>{r.contract.booking.vehicle.plate}</Plate><span className="text-xs text-ink-3">{fmtDate(r.contract.startAt)} – {fmtDate(r.contract.endAt)}</span><BookingStatusChip status={r.contract.booking.status} /></Row>)}
          </ul>
        )}
        <p className="px-4 pb-3 text-xs text-ink-3">Fahrerangaben sind Vertrags-Snapshots; sie zählen nicht als Buchungen dieser Person.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

export async function FinanceTab({ tenantId, customerId }: { tenantId: string; customerId: string }) {
  const f = await customerFinance(tenantId, customerId);
  const s = f.sums;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPI label="Wirksames Rechnungsvolumen" value={<span className="text-xl">{fmtCents(s.effectiveInvoiceCents)}</span>} detail={`Rechnungen ${fmtCents(s.invoiceCents)} − Gutschriften ${fmtCents(s.creditedCents)} − Storno ${fmtCents(s.cancelledCents)}`} />
        <KPI label="Bezahlt" value={<span className="text-xl">{fmtCents(s.paidCents)}</span>} detail="bestätigte Zahlungen" />
        <KPI label="Offen" value={<span className="text-xl">{fmtCents(s.openCents)}</span>} detail="Forderung nach Gegenbelegen" hot={s.openCents > 0} />
        <KPI label="Erstattung offen" value={<span className="text-xl">{fmtCents(s.refundOpenCents)}</span>} detail={`Guthaben ${fmtCents(s.creditCents)} · erstattet ${fmtCents(s.refundedCents)}`} hot={s.refundOpenCents > 0} />
      </div>
      {s.effectiveDamageCents > 0 && <p className="text-xs text-ink-3">Darin enthalten: Schadenabrechnungen {fmtCents(s.effectiveDamageCents)} (Schadenersatz, kein gewöhnlicher Mietumsatz). Kautionen erscheinen nicht hier, sondern unter „Kautionen“; Auszahlungen sind Geldabflüsse ({fmtCents(s.payoutsCompletedCents)} erfasst).</p>}
      {s.effectiveDamageCents === 0 && <p className="text-xs text-ink-3">Kautionen erscheinen nicht hier, sondern unter „Kautionen“. Auszahlungen sind Geldabflüsse ({fmtCents(s.payoutsCompletedCents)} erfasst) und mindern keinen Umsatz.</p>}
      <Card title="Belege" right={<Chip>{f.documents.length}</Chip>}>
        {f.documents.length === 0 && f.drafts.length === 0 ? <Empty>Noch keine Belege.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead><tr className="text-left"><th className="label-xs px-3 py-2 border-b border-line">Nummer</th><th className="label-xs px-3 py-2 border-b border-line">Art</th><th className="label-xs px-3 py-2 border-b border-line">Datum</th><th className="label-xs px-3 py-2 border-b border-line text-right">Betrag</th><th className="label-xs px-3 py-2 border-b border-line text-right">Wirksam</th><th className="label-xs px-3 py-2 border-b border-line text-right">Bezahlt</th><th className="label-xs px-3 py-2 border-b border-line text-right">Offen</th><th className="label-xs px-3 py-2 border-b border-line">Stand</th></tr></thead>
              <tbody>
                {f.drafts.map((d) => <tr key={d.id} className="border-b border-line-soft"><td className="px-3 py-2.5"><Link href={d.href} className="hover:underline text-ink-3">Entwurf</Link></td><td className="px-3 py-2.5">{INVOICE_DOCUMENT_TYPES[d.documentType as InvoiceDocumentTypeKey]}{d.kind === "DAMAGE" ? " · Schaden" : d.kind === "AUTHORITY_FEE" ? " · Behörde" : ""}</td><td className="px-3 py-2.5 text-ink-3" colSpan={5}>Buchung {d.bookingNumber} · noch nicht abgeschlossen</td><td className="px-3 py-2.5"><Chip tone="amber">Entwurf</Chip></td></tr>)}
                {f.documents.map((d) => {
                  const fin = d.financials;
                  const counter = d.documentType !== "INVOICE";
                  return (
                    <tr key={d.id} className={`border-b border-line-soft last:border-0 hover:bg-panel-2/60 ${counter ? "text-ink-2" : ""}`}>
                      <td className="px-3 py-2.5 font-mono tnum"><Link href={d.href} className="hover:underline font-medium">{d.number}</Link><span className="block text-[11px] text-ink-3">Buchung {d.bookingNumber}</span></td>
                      <td className="px-3 py-2.5">{INVOICE_DOCUMENT_TYPES[d.documentType as InvoiceDocumentTypeKey] ?? d.documentType}{isSideInvoice(d.kind) ? <span className="block text-[11px] text-ink-3">{invoiceKindWord(d.kind)}</span> : null}{counter && d.original && <span className="block text-[11px] text-ink-3">zu {d.original.number}</span>}</td>
                      <td className="px-3 py-2.5 font-mono tnum">{fmtDate(d.issueDate ?? d.finalizedAt)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tnum">{counter ? `− ${fmtCents(d.grossCents)}` : fmtCents(d.grossCents)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tnum">{fin ? fmtCents(fin.effectiveCents) : "–"}</td>
                      <td className="px-3 py-2.5 text-right font-mono tnum">{fin ? fmtCents(fin.paidCents) : "–"}</td>
                      <td className={`px-3 py-2.5 text-right font-mono tnum ${fin && fin.openCents > 0 ? "text-bad font-semibold" : ""}`}>{fin ? fmtCents(fin.openCents) : "–"}</td>
                      <td className="px-3 py-2.5">{fin ? (
                        <div className="flex flex-wrap gap-1">
                          {(fin.effectiveCents > 0 || fin.paidCents > 0) && <PaymentStatusChip status={fin.refundRequired ? "OVERPAID" : fin.paymentStatus} />}
                          {fin.chain !== "NONE" && <Chip tone={fin.chain === "CANCELLED" ? "bad" : "info"}>{INVOICE_CHAIN_STATUS[fin.chain]}</Chip>}
                          {fin.refundOpen && <Chip tone="bad">Erstattung {fmtCents(fin.refundRemainingCents)} offen</Chip>}
                          {fin.refundRequired && !fin.refundOpen && <Chip tone="good">Erstattet {fmtCents(fin.completedRefundCents)}</Chip>}
                        </div>
                      ) : <Chip tone="grey">Gegenbeleg</Chip>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <Card title="Zahlungen" right={<Chip>{f.payments.filter((p) => p.status === "CONFIRMED").length}</Chip>}>
          {f.payments.length === 0 ? <p className="p-4 text-sm text-ink-3">Keine Zahlungen erfasst.</p> : (
            <ul className="divide-y divide-line-soft">
              {f.payments.map((p) => <Row key={p.id}><span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(p.paidAt)}</span><span className={`font-mono tnum font-semibold ${p.status === "CANCELLED" ? "line-through text-ink-3" : ""}`}>{fmtCents(p.amountCents)}</span><span className="text-ink-2">{PAYMENT_METHODS[p.method as PaymentMethod] ?? p.method}</span>{p.invoiceNumber && <Link href={`/buchungen/${p.bookingId}/finanzen`} className="text-xs underline">zu {p.invoiceNumber}</Link>}{p.reference && <span className="text-xs text-ink-3">{p.reference}</span>}{p.status === "CANCELLED" && <Chip tone="bad">Storniert{p.cancellationReason ? ` · ${p.cancellationReason}` : ""}</Chip>}</Row>)}
            </ul>
          )}
        </Card>
        <Card title="Auszahlungen" right={<Chip>{f.payouts.filter((p) => p.status === "COMPLETED").length}</Chip>}>
          {f.payouts.length === 0 ? <p className="p-4 text-sm text-ink-3">Keine Auszahlungen.</p> : (
            <ul className="divide-y divide-line-soft">
              {f.payouts.map((p) => <Row key={p.id}><Link href={`/auszahlungen/${p.id}`} className="font-mono tnum font-medium hover:underline">{p.number ?? "Entwurf"}</Link><Chip tone={p.status === "COMPLETED" ? "good" : p.status === "DRAFT" ? "amber" : "bad"}>{PAYOUT_STATUS[p.status as PayoutStatus]}</Chip><span className="text-ink-2">{PAYOUT_SOURCE_TYPES[p.sourceType as PayoutSourceType]}{p.invoiceNumber ? ` ${p.invoiceNumber}` : ` · Buchung ${p.bookingNumber}`}</span><span className="text-xs text-ink-3">{PAYOUT_METHODS[p.method as PayoutMethod] ?? p.method}{p.ibanMasked ? ` · ${p.ibanMasked}` : ""}{p.executedAt ? ` · ${fmtDateTime(p.executedAt)}` : p.plannedAt ? ` · geplant ${fmtDateTime(p.plannedAt)}` : ""}</span><span className={`ml-auto font-mono tnum font-semibold ${p.status === "CANCELLED" ? "line-through text-ink-3" : ""}`}>{fmtCents(p.amountCents)}</span></Row>)}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

export async function DepositsTab({ tenantId, customerId }: { tenantId: string; customerId: string }) {
  const rows = await customerDeposits(tenantId, customerId);
  return (
    <Card title="Kautionen je Buchung" right={<Chip>{rows.length}</Chip>}>
      {rows.length === 0 ? <Empty>Keine Kautionen erfasst.</Empty> : (
        <ul className="divide-y divide-line-soft">
          {rows.map((d) => (
            <li key={d.depositId} className="px-4 py-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Link href={`/buchungen/${d.bookingId}#kaution`} className="font-mono tnum font-medium hover:underline">Buchung {d.bookingNumber}</Link>
                <Plate>{d.plate}</Plate>
                <BookingStatusChip status={d.bookingStatus} />
                <Chip tone={d.status === "RELEASED" ? "good" : d.status === "RETAINED" ? "bad" : d.status === "EXPECTED" ? "amber" : "info"}>{DEPOSIT_STATUS[d.status as DepositStatus]}</Chip>
                {d.payoutRemainingCents > 0 && <Chip tone="bad">noch auszuzahlen {fmtCents(d.payoutRemainingCents)}</Chip>}
                {d.payoutExcessCents > 0 && <Chip tone="amber">mehr ausgezahlt als freigegeben {fmtCents(d.payoutExcessCents)}</Chip>}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-sm">
                <div className="rounded-md bg-panel-2 p-2"><div className="label-xs">Vereinbart</div><div className="font-mono tnum">{fmtCents(d.expectedCents)}</div></div>
                <div className="rounded-md bg-panel-2 p-2"><div className="label-xs">Erhalten</div><div className="font-mono tnum">{fmtCents(d.receivedCents)}</div></div>
                <div className="rounded-md bg-panel-2 p-2"><div className="label-xs">Freigegeben</div><div className="font-mono tnum">{fmtCents(d.releasedCents)}</div></div>
                <div className="rounded-md bg-panel-2 p-2"><div className="label-xs">Einbehalten</div><div className="font-mono tnum">{fmtCents(d.retainedCents)}</div></div>
                <div className="rounded-md bg-panel-2 p-2"><div className="label-xs">Nicht entschieden</div><div className={`font-mono tnum ${d.remainingCents > 0 && (d.bookingStatus === "RETURNED" || d.bookingStatus === "CANCELLED") ? "text-amber font-semibold" : ""}`}>{fmtCents(d.remainingCents)}</div></div>
                <div className="rounded-md bg-panel-2 p-2"><div className="label-xs">Ausgezahlt</div><div className="font-mono tnum">{fmtCents(d.completedPayoutCents)}</div></div>
              </div>
              {d.events.length > 0 && (
                <ul className="text-xs text-ink-3 flex flex-wrap gap-x-3 gap-y-0.5">
                  {d.events.map((e) => <li key={e.id} className={e.status === "CANCELLED" ? "line-through" : ""}>{fmtDate(e.occurredAt)} {DEPOSIT_EVENT_TYPES[e.type as DepositEventType] ?? e.type} {fmtCents(e.amountCents)}{e.status === "CANCELLED" ? ` (storniert${e.cancellationReason ? `: ${e.cancellationReason}` : ""})` : ""}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="px-4 pb-3 text-xs text-ink-3">Kautionen sind Sicherheitsleistungen, kein Umsatz. Freigabe, Einbehalt und Auszahlung werden ausschließlich auf der Buchung entschieden; hier gibt es keine Verrechnung.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export async function DamagesTab({ tenantId, customerId }: { tenantId: string; customerId: string }) {
  const rows = await customerDamageCases(tenantId, customerId);
  return (
    <Card title="Schadenakten zu Vermietungen dieser Person" right={<Chip>{rows.length}</Chip>}>
      {rows.length === 0 ? <Empty>Keine Schadenakten mit Bezug zu dieser Person.</Empty> : (
        <ul className="divide-y divide-line-soft">
          {rows.map((d) => (
            <Row key={d.id}>
              <Link href={`/schaeden/${d.id}`} className="font-mono tnum font-medium hover:underline">{d.caseNumber}</Link>
              <Plate>{d.vehicle.plate}</Plate>
              <span className="min-w-0 truncate">{d.description}</span>
              {d.booking && <Link href={`/buchungen/${d.bookingId}`} className="text-xs underline">Buchung {d.booking.number}</Link>}
              <CaseStatusChip status={d.status} />
              <LiabilityChip status={d.liabilityStatus} />
              {d.liabilityStatus === "CUSTOMER_RESPONSIBILITY_CONFIRMED" && d.customerChargeCents != null && <span className="text-xs text-ink-2">Belastung {fmtCents(d.customerChargeCents)}</span>}
              {d.invoices.map((i) => <Link key={i.id} href={`/buchungen/${d.bookingId}/rechnung?nr=${i.id}`} className="text-xs underline">{i.number}</Link>)}
              <span className="ml-auto font-mono tnum text-xs text-ink-3">{fmtDate(d.createdAt)}</span>
            </Row>
          ))}
        </ul>
      )}
      <p className="px-4 pb-3 text-xs text-ink-3">Angezeigt werden Akten zu Buchungen dieser Person. „Nicht bewertet“ und „Unklar“ bedeuten keine Verantwortung des Kunden – die Haftung wird ausschließlich in der Akte entschieden.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export async function DocumentsTab({ tenantId, customerId, role }: { tenantId: string; customerId: string; role: string }) {
  const [rows, driverHistory] = await Promise.all([customerDocuments(tenantId, customerId, role), driverDocumentHistoryForCustomer(tenantId, customerId)]);
  const label = (d: (typeof rows)[number]) => d.kind === "BOOKING" ? DOCUMENT_TYPES[d.type as DocumentType] ?? d.type : d.kind === "DAMAGE" ? DAMAGE_CASE_DOCUMENT_TYPES[d.type as DamageCaseDocumentType] ?? d.type : AUTHORITY_DOCUMENT_TYPES[d.type as AuthorityDocumentType] ?? d.type;
  const copyLabel = (kind: string, side: string) => `${kind === "IDENTITY" ? "Ausweis" : "Führerschein"} · ${side === "FRONT" ? "Vorderseite" : "Rückseite"}`;
  return (
    <>
      <Card title="Dokumente" right={<Chip>{rows.length}</Chip>}>
        {rows.length === 0 ? <Empty>Noch keine Dokumente archiviert.</Empty> : (
          <ul className="divide-y divide-line-soft">
            {rows.map((d) => (
              <Row key={`${d.kind}-${d.id}`}>
                <span className="font-medium">{label(d)}</span>
                <Link href={d.contextHref} className="text-xs underline">{d.context}</Link>
                <span className="text-xs text-ink-3 break-all">{d.fileName} · {kb(d.sizeBytes)}</span>
                <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(d.createdAt)}</span>
                <span className="ml-auto flex gap-2"><a href={d.href} target="_blank" rel="noopener" className="btn !py-1">Öffnen</a><a href={`${d.href}?download=1`} className="btn !py-1">Herunterladen</a></span>
              </Row>
            ))}
          </ul>
        )}
        <p className="px-4 pb-3 text-xs text-ink-3">Dateien liegen im privaten Speicher und werden nur über die geschützte Adresse an angemeldete Mitarbeiter dieses Mandanten ausgeliefert. Fahrzeug- und Werkstattdokumente gehören zur Fahrzeugakte.{role === "YARD" ? " Behördendokumente sind der Disposition vorbehalten." : ""}</p>
      </Card>
      <Card title="Ausweis- & Führerscheinkopien (Verlauf)" right={<Chip>{driverHistory.length}</Chip>}>
        {driverHistory.length === 0 ? <Empty>Noch keine Dokumentkopien bei einer Übergabe erfasst.</Empty> : (
          <ul className="divide-y divide-line-soft">
            {driverHistory.map((h) => (
              <li key={h.verificationId} className="px-4 py-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{h.driverName}</span>
                  <Chip tone="info">{DRIVER_ROLES[h.driverRole as DriverRole]}</Chip>
                  <Chip tone={h.status === "CONFIRMED" ? "good" : h.status === "BLOCKED" ? "bad" : "amber"}>{DRIVER_VERIFICATION_STATUS[h.status as DriverVerificationStatus]}</Chip>
                  <Link href={`/buchungen/${h.bookingId}`} className="text-xs underline">Buchung {h.bookingNumber}</Link>
                  {h.verifiedAt && <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(h.verifiedAt)}</span>}
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {h.copies.map((c) => (
                    <div key={c.id} className="flex flex-col items-center gap-1">
                      <DocumentThumb id={c.id} label={copyLabel(c.documentKind, c.side)} />
                      <span className="text-[11px] text-ink-3">{copyLabel(c.documentKind, c.side)}</span>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="px-4 pb-3 text-xs text-ink-3">Nur zur Ansicht. Jede Kopie bleibt an ihren jeweiligen Vermietvorgang gebunden (Zweckbindung, Art. 5/6 DSGVO) und wird nicht automatisch für neue Buchungen übernommen.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

export async function CommunicationTab({ tenantId, customerId }: { tenantId: string; customerId: string }) {
  const rows = await customerEmails(tenantId, customerId);
  return (
    <Card title="E-Mail-Verlauf" right={<Chip>{rows.length}</Chip>}>
      {rows.length === 0 ? <Empty>Noch keine E-Mails versendet.</Empty> : (
        <ul className="divide-y divide-line-soft">
          {rows.map((m) => (
            <Row key={m.id}>
              <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(m.sentAt ?? m.lastAttemptAt ?? m.createdAt)}</span>
              <Chip tone={m.status === "SENT" ? "good" : m.status === "FAILED" ? "bad" : "amber"}>{EMAIL_STATUS[m.status as EmailStatus] ?? m.status}</Chip>
              <span className="font-medium">{templateLabel(m.template)}</span>
              <span className="text-ink-2 min-w-0 truncate">{m.subject}</span>
              <span className="text-xs text-ink-3">an {m.recipient}{m.attemptNo > 1 ? ` · Versuch ${m.attemptNo}` : ""}{m.trigger === "MANUAL" ? " · manuell" : ""}</span>
              {m.invoiceVersion?.invoice.number && <span className="text-xs text-ink-3">{m.invoiceVersion.invoice.number}</span>}
              {m.payoutId ? <Link href={`/auszahlungen/${m.payoutId}`} className="text-xs underline">Auszahlung</Link> : m.bookingId ? <Link href={`/buchungen/${m.bookingId}`} className="text-xs underline">Buchung {m.booking?.number ?? ""}</Link> : null}
              {m.status === "FAILED" && m.error && <span className="text-xs text-bad basis-full">{m.error}</span>}
            </Row>
          ))}
        </ul>
      )}
      <p className="px-4 pb-3 text-xs text-ink-3">Gespeichert werden Empfänger, Vorlage, Betreff und Versandstand – nicht der vollständige Mailtext. Erneut senden ist auf der jeweiligen Buchung bzw. Auszahlung möglich. Freie E-Mails aus der Kundenakte sind nicht vorgesehen.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export async function AuthorityTab({ tenantId, customerId, canManage }: { tenantId: string; customerId: string; canManage: boolean }) {
  return (
    <>
      <AuthorityCasesPanel tenantId={tenantId} scope={{ customerId }} canManage={canManage} title="Behördenvorgänge mit dieser Person als benanntem Fahrer" />
      <NoAuthorityHint tenantId={tenantId} customerId={customerId} />
    </>
  );
}

async function NoAuthorityHint({ tenantId, customerId }: { tenantId: string; customerId: string }) {
  const rows = await casesForCustomer(tenantId, customerId);
  if (rows.length > 0) return null;
  return <Card><Empty>Keine Behördenvorgänge, in denen diese Person als Fahrer bestimmt wurde. Vorgänge werden nie aus Kennzeichen oder Mietzeitraum abgeleitet.</Empty></Card>;
}

// ---------------------------------------------------------------------------

export async function HistoryTab({ tenantId, customerId }: { tenantId: string; customerId: string }) {
  const rows = await customerTimeline(tenantId, customerId);
  return (
    <Card title="Historie" right={<Chip>{rows.length}</Chip>}>
      {rows.length === 0 ? <Empty>Noch keine Ereignisse.</Empty> : (
        <ol className="divide-y divide-line-soft">
          {rows.map((e) => (
            <li key={e.key} className="px-4 py-2 grid grid-cols-[130px_1fr] md:grid-cols-[150px_110px_1fr] gap-x-3 gap-y-0.5 text-sm items-baseline">
              <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(e.at)}</span>
              <span className="label-xs hidden md:block">{e.kind}</span>
              <span className="min-w-0">{e.href ? <Link href={e.href} className="font-medium hover:underline">{e.title}</Link> : <span className="font-medium">{e.title}</span>}{e.detail && <span className="text-ink-3"> · {e.detail}</span>}<span className="md:hidden text-ink-3 text-xs"> · {e.kind}</span></span>
            </li>
          ))}
        </ol>
      )}
      <p className="px-4 pb-3 text-xs text-ink-3">Operative Zeitleiste aus gespeicherten Zeitpunkten (Buchungen, Verträge, Übergaben, Belege, Zahlungen, Kautionen, Auszahlungen, Schäden, Behörden, E-Mails). Das Änderungsprotokoll (Audit) bleibt davon getrennt.</p>
    </Card>
  );
}

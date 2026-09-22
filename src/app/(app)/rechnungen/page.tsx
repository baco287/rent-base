import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Chip, Content, Empty, PageHeader } from "@/components/ui";
import { INVOICE_KINDS, INVOICE_PAYMENT_STATUS, type InvoicePaymentStatus } from "@/lib/constants";
import { fmtDate } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { paymentSummaries } from "@/lib/payments";
import { PaymentStatusChip } from "../buchungen/[id]/finanzen/panels";

export const metadata = { title: "Rechnungen" };

const FILTERS: { key: string; label: string; status: InvoicePaymentStatus | null }[] = [
  { key: "offen", label: "Offen", status: "OPEN" },
  { key: "teilbezahlt", label: "Teilbezahlt", status: "PARTIAL" },
  { key: "bezahlt", label: "Bezahlt", status: "PAID" },
  { key: "ueberzahlt", label: "Überzahlt", status: "OVERPAID" },
  { key: "alle", label: "Alle", status: null },
];
const KINDS: { key: string; label: string; kind: string | null }[] = [
  { key: "alle", label: "Alle Arten", kind: null },
  { key: "miete", label: "Mietrechnungen", kind: "RENTAL" },
  { key: "schaden", label: "Schadensrechnungen", kind: "DAMAGE" },
];
const PAGE = 50;
const KindChip = ({ kind }: { kind: string }) => (kind === "DAMAGE" ? <Chip tone="amber">Schaden</Chip> : <Chip>Miete</Chip>);

/** Abgeschlossene Rechnungen mit Zahlungsstand. Der Stand kommt aus den bestätigten Zahlungen, nie aus einem gespeicherten Feld. */
export default async function InvoicesPage({ searchParams }: PageProps<"/rechnungen">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filter) ?? FILTERS[FILTERS.length - 1];
  const kindF = KINDS.find((k) => k.key === sp.art) ?? KINDS[0];
  const qs = (over: Record<string, string | number>) => { const u = new URLSearchParams({ filter: filter.key, art: kindF.key, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) }); return `/rechnungen?${u.toString()}`; };
  const page = Math.max(1, parseInt(typeof sp.seite === "string" ? sp.seite : "1", 10) || 1);

  // Eine Hauptzeile je logischer Rechnung; Betrag, Empfänger und Fälligkeit stammen aus der aktuellen Fassung
  const rows0 = await db.invoice.findMany({
    where: { tenantId: tenant.id, status: "FINALIZED", currentVersionId: { not: null }, ...(kindF.kind ? { kind: kindF.kind } : {}) },
    orderBy: [{ finalizedAt: "desc" }, { number: "desc" }],
    select: { id: true, number: true, kind: true, damageCase: { select: { id: true, caseNumber: true } }, bookingId: true, booking: { select: { number: true } }, currentVersion: { select: { id: true, versionNo: true, kind: true, issueDate: true, paymentDueDate: true, grossTotal: true, customerSnapshot: true, deliveredAt: true } }, _count: { select: { versions: true } } },
  });
  const sentIds = new Set((await db.emailLog.findMany({ where: { tenantId: tenant.id, status: "SENT", invoiceVersionId: { in: rows0.map((r) => r.currentVersion!.id) } }, select: { invoiceVersionId: true } })).map((e) => e.invoiceVersionId));
  const all = rows0.map((r) => ({ id: r.id, number: r.number, invoiceKind: r.kind, damageCase: r.damageCase, bookingId: r.bookingId, booking: r.booking, issueDate: r.currentVersion!.issueDate, paymentDueDate: r.currentVersion!.paymentDueDate, grossTotal: r.currentVersion!.grossTotal, customerSnapshot: r.currentVersion!.customerSnapshot, versionNo: r.currentVersion!.versionNo, versionCount: r._count.versions, kind: r.currentVersion!.kind, delivered: sentIds.has(r.currentVersion!.id) || !!r.currentVersion!.deliveredAt }));
  const sums = await paymentSummaries(tenant.id, all);
  const rows = all.filter((i) => !filter.status || sums.get(i.id)!.status === filter.status);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const slice = rows.slice((page - 1) * PAGE, page * PAGE);
  const totalOpen = rows.reduce((a, i) => a + sums.get(i.id)!.openCents, 0);
  const customerOf = (c: unknown) => {
    const s = c as { type?: string; companyName?: string | null; firstName?: string; lastName?: string };
    const person = `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim();
    return s.type === "COMPANY" && s.companyName ? s.companyName : person || "–";
  };
  const today = new Date();

  return (
    <>
      <PageHeader title="Rechnungen" sub={`${rows.length} ${filter.label.toLowerCase()} · offen ${fmtCents(totalOpen)}`} />
      <Content>
        <div className="flex gap-1.5 flex-wrap">
          {FILTERS.map((f) => (
            <Link key={f.key} href={qs({ filter: f.key })} className={`btn !py-1.5 ${f.key === filter.key ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{f.label}</Link>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap" aria-label="Rechnungsart">
          {KINDS.map((k) => (
            <Link key={k.key} href={qs({ art: k.key })} className={`btn !py-1.5 ${k.key === kindF.key ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{k.label}</Link>
          ))}
        </div>
        <Card>
          {slice.length === 0 ? (
            <Empty>Keine Rechnungen in dieser Ansicht.</Empty>
          ) : (
            <>
              {/* Smartphone: Karten statt breiter Tabelle */}
              <ul className="md:hidden divide-y divide-line-soft">
                {slice.map((i) => {
                  const s = sums.get(i.id)!;
                  return (
                    <li key={i.id} className="px-4 py-3 flex flex-col gap-1">
                      <div className="flex justify-between items-baseline gap-2"><span className="flex items-center gap-2"><Link href={`/buchungen/${i.bookingId}/rechnung?nr=${i.id}`} className="font-mono tnum font-medium hover:underline">{i.number}</Link><KindChip kind={i.invoiceKind} /></span><PaymentStatusChip status={s.status} /></div>
                      <div className="text-sm">{customerOf(i.customerSnapshot)} <span className="text-ink-3">· {fmtDate(i.issueDate)}{i.versionNo > 1 ? ` · Fassung ${i.versionNo}` : ""} · {i.delivered ? "übermittelt" : "nicht übermittelt"}</span></div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div><div className="label-xs">Gesamt</div><div className="font-mono tnum">{fmtCents(s.grossCents)}</div></div>
                        <div><div className="label-xs">Bezahlt</div><div className="font-mono tnum text-good">{fmtCents(s.paidCents)}</div></div>
                        <div><div className="label-xs">{s.status === "OVERPAID" ? "Überzahlt" : "Offen"}</div><div className={`font-mono tnum ${s.openCents > 0 || s.overpaidCents > 0 ? "text-bad font-semibold" : ""}`}>{fmtCents(s.status === "OVERPAID" ? s.overpaidCents : s.openCents)}</div></div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-[13.5px]">
                  <thead>
                    <tr className="text-left">
                      <th className="label-xs px-3 py-2 border-b border-line">Nr.</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Art</th>
                      <th className="label-xs px-3 py-2 border-b border-line text-right">Fassung</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Datum</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Kunde</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Buchung</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Fällig</th>
                      <th className="label-xs px-3 py-2 border-b border-line text-right">Gesamt</th>
                      <th className="label-xs px-3 py-2 border-b border-line text-right">Bezahlt</th>
                      <th className="label-xs px-3 py-2 border-b border-line text-right">Offen / Überzahlt</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Zahlungsstatus</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Übermittlung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slice.map((i) => {
                      const s = sums.get(i.id)!;
                      const overdue = s.status !== "PAID" && i.paymentDueDate && i.paymentDueDate < today;
                      return (
                        <tr key={i.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                          <td className="px-3 py-2.5 font-mono tnum"><Link href={`/buchungen/${i.bookingId}/rechnung?nr=${i.id}`} className="hover:underline font-medium">{i.number}</Link></td>
                          <td className="px-3 py-2.5 text-xs"><KindChip kind={i.invoiceKind} />{i.damageCase ? <> <Link href={`/schaeden/${i.damageCase.id}`} className="font-mono tnum hover:underline">{i.damageCase.caseNumber}</Link></> : null}</td>
                          <td className="px-3 py-2.5 text-right tnum">{i.versionNo}{i.versionCount > 1 ? <span className="text-ink-3 text-xs"> / {i.versionCount}</span> : null}</td>
                          <td className="px-3 py-2.5 font-mono tnum">{fmtDate(i.issueDate)}</td>
                          <td className="px-3 py-2.5">{customerOf(i.customerSnapshot)}</td>
                          <td className="px-3 py-2.5 font-mono tnum"><Link href={`/buchungen/${i.bookingId}`} className="hover:underline">{i.booking.number}</Link></td>
                          <td className={`px-3 py-2.5 font-mono tnum ${overdue ? "text-bad font-semibold" : ""}`}>{i.paymentDueDate ? fmtDate(i.paymentDueDate) : "–"}{overdue ? " (überfällig)" : ""}</td>
                          <td className="px-3 py-2.5 text-right font-mono tnum">{fmtCents(s.grossCents)}</td>
                          <td className="px-3 py-2.5 text-right font-mono tnum text-good">{fmtCents(s.paidCents)}</td>
                          <td className={`px-3 py-2.5 text-right font-mono tnum ${s.openCents > 0 || s.overpaidCents > 0 ? "text-bad font-semibold" : ""}`}>{s.status === "OVERPAID" ? `+${fmtCents(s.overpaidCents)}` : fmtCents(s.openCents)}</td>
                          <td className="px-3 py-2.5"><PaymentStatusChip status={s.status} /></td>
                          <td className="px-3 py-2.5 text-xs">{i.delivered ? <Chip tone="info">übermittelt</Chip> : <Chip tone="amber">nicht übermittelt</Chip>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
        {pages > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {page > 1 && <Link href={qs({ seite: page - 1 })} className="btn !py-1.5">Zurück</Link>}
            <Chip>Seite {page} von {pages}</Chip>
            {page < pages && <Link href={qs({ seite: page + 1 })} className="btn !py-1.5">Weiter</Link>}
          </div>
        )}
        <p className="text-xs text-ink-3">Zahlungsstatus: {Object.values(INVOICE_PAYMENT_STATUS).join(" · ")} – abgeleitet aus dem Betrag der aktuellen Fassung und den bestätigten Zahlungen. Kautionen sind hier nicht enthalten; sie sind keine Rechnungszahlungen. Rechnungsarten: {Object.values(INVOICE_KINDS).join(" · ")}.</p>
      </Content>
    </>
  );
}

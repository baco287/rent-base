import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Chip, Content, Empty, PageHeader } from "@/components/ui";
import { DAMAGE_TAX_TREATMENTS, INVOICE_CHAIN_STATUS, INVOICE_DOCUMENT_TYPES, INVOICE_KINDS, INVOICE_PAYMENT_STATUS, type DamageTaxTreatment } from "@/lib/constants";
import { financialsFor, type InvoiceFinancials } from "@/lib/counter-documents";
import { fmtDate } from "@/lib/format";
import { fmtCents, toCents } from "@/lib/money";
import { PaymentStatusChip } from "../buchungen/[id]/finanzen/panels";

export const metadata = { title: "Rechnungen" };

type Filter = { key: string; label: string; match: (f: InvoiceFinancials) => boolean };
const FILTERS: Filter[] = [
  { key: "offen", label: "Offen", match: (f) => f.paymentStatus === "OPEN" && f.effectiveCents > 0 },
  { key: "teilbezahlt", label: "Teilbezahlt", match: (f) => f.paymentStatus === "PARTIAL" },
  { key: "bezahlt", label: "Bezahlt", match: (f) => f.paymentStatus === "PAID" && !f.refundRequired && f.effectiveCents > 0 },
  { key: "gutgeschrieben", label: "Gutgeschrieben / teilweise", match: (f) => f.chain === "CREDITED" || f.chain === "PARTIALLY_CREDITED" },
  { key: "storniert", label: "Storniert", match: (f) => f.chain === "CANCELLED" },
  { key: "erstattung", label: "Erstattung erforderlich", match: (f) => f.refundOpen },
  { key: "alle", label: "Alle", match: () => true },
];
const KINDS: { key: string; label: string; kind: string | null }[] = [
  { key: "alle", label: "Alle Arten", kind: null },
  { key: "miete", label: "Mietrechnungen", kind: "RENTAL" },
  { key: "schaden", label: "Schadensrechnungen", kind: "DAMAGE" },
  { key: "behoerde", label: "Bearbeitungsentgelte Behörde", kind: "AUTHORITY_FEE" },
];
const DOCS: { key: string; label: string; types: string[] }[] = [
  { key: "rechnungen", label: "Rechnungen", types: ["INVOICE"] },
  { key: "gutschriften", label: "Gutschriften", types: ["CREDIT_NOTE"] },
  { key: "stornos", label: "Stornobelege", types: ["CANCELLATION"] },
  { key: "alle", label: "Alle Belege", types: ["INVOICE", "CREDIT_NOTE", "CANCELLATION"] },
];
const PAGE = 50;
const KindChip = ({ kind }: { kind: string }) => (kind === "DAMAGE" ? <Chip tone="amber">Schaden</Chip> : kind === "AUTHORITY_FEE" ? <Chip tone="info">Behörde</Chip> : <Chip>Miete</Chip>);
const DocChip = ({ type }: { type: string }) => (type === "CREDIT_NOTE" ? <Chip tone="info">Gutschrift</Chip> : type === "CANCELLATION" ? <Chip tone="bad">Storno</Chip> : null);

/** Belegstatus in mehreren Dimensionen: Zahlungsstand · Belegkette · Erstattungsbedarf – alles aus der zentralen Summierung, nie gespeichert. */
function StatusCell({ f }: { f: InvoiceFinancials }) {
  return (
    <div className="flex flex-wrap gap-1 items-center">
      {(f.effectiveCents > 0 || f.paidCents > 0) && <PaymentStatusChip status={f.refundRequired ? "OVERPAID" : f.paymentStatus} />}
      {f.chain !== "NONE" && <Chip tone={f.chain === "CANCELLED" ? "bad" : "info"}>{INVOICE_CHAIN_STATUS[f.chain]}</Chip>}
      {f.refundOpen && <Chip tone="bad">Erstattung {fmtCents(f.refundRemainingCents)} erforderlich</Chip>}
      {f.refundRequired && !f.refundOpen && <Chip tone="good">Erstattet {fmtCents(f.completedRefundCents)}</Chip>}
      {f.hasDraftCounter && <Chip tone="amber">Gegenbeleg-Entwurf offen</Chip>}
    </div>
  );
}

/**
 * Abgeschlossene Belege mit Zahlungsstand. Rechnungen tragen ihren Stand aus Fassung, Gutschriften, Storno und bestätigten
 * Zahlungen; Gutschriften und Stornobelege erscheinen als eigene Zeilen mit Bezug auf ihre Rechnung. Überfällig ist nur,
 * wer noch etwas schuldet: offen > 0 und Fälligkeit überschritten (ein Guthaben ist nie überfällig).
 */
export default async function InvoicesPage({ searchParams }: PageProps<"/rechnungen">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filter) ?? FILTERS[FILTERS.length - 1];
  const kindF = KINDS.find((k) => k.key === sp.art) ?? KINDS[0];
  const docF = DOCS.find((d) => d.key === sp.beleg) ?? DOCS[0];
  const qs = (over: Record<string, string | number>) => { const u = new URLSearchParams({ filter: filter.key, art: kindF.key, beleg: docF.key, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) }); return `/rechnungen?${u.toString()}`; };
  const page = Math.max(1, parseInt(typeof sp.seite === "string" ? sp.seite : "1", 10) || 1);

  // Eine Zeile je Beleg; Betrag, Empfänger und Fälligkeit stammen aus der aktuellen Fassung
  const rows0 = await db.invoice.findMany({
    where: { tenantId: tenant.id, status: "FINALIZED", currentVersionId: { not: null }, documentType: { in: docF.types }, ...(kindF.kind ? { kind: kindF.kind } : {}) },
    orderBy: [{ finalizedAt: "desc" }, { number: "desc" }],
    select: { id: true, number: true, kind: true, documentType: true, damageCase: { select: { id: true, caseNumber: true } }, bookingId: true, booking: { select: { number: true } }, original: { select: { id: true, number: true, bookingId: true } }, currentVersion: { select: { id: true, versionNo: true, kind: true, issueDate: true, paymentDueDate: true, grossTotal: true, customerSnapshot: true, deliveredAt: true, taxTreatment: true } }, _count: { select: { versions: true } } },
  });
  const sentIds = new Set((await db.emailLog.findMany({ where: { tenantId: tenant.id, status: "SENT", invoiceVersionId: { in: rows0.map((r) => r.currentVersion!.id) } }, select: { invoiceVersionId: true } })).map((e) => e.invoiceVersionId));
  const all = rows0.map((r) => ({ id: r.id, number: r.number, invoiceKind: r.kind, documentType: r.documentType, original: r.original, taxTreatment: r.currentVersion!.taxTreatment, damageCase: r.damageCase, bookingId: r.bookingId, booking: r.booking, issueDate: r.currentVersion!.issueDate, paymentDueDate: r.currentVersion!.paymentDueDate, grossTotal: r.currentVersion!.grossTotal, customerSnapshot: r.currentVersion!.customerSnapshot, versionNo: r.currentVersion!.versionNo, versionCount: r._count.versions, kind: r.currentVersion!.kind, delivered: sentIds.has(r.currentVersion!.id) || !!r.currentVersion!.deliveredAt }));
  const invoicesOnly = all.filter((i) => i.documentType === "INVOICE");
  const fin = await financialsFor(tenant.id, invoicesOnly);
  const rows = all.filter((i) => (i.documentType === "INVOICE" ? filter.match(fin.get(i.id)!) : filter.key === "alle"));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const slice = rows.slice((page - 1) * PAGE, page * PAGE);
  const totalOpen = rows.reduce((a, i) => a + (fin.get(i.id)?.openCents ?? 0), 0);
  const totalCredit = rows.reduce((a, i) => a + (fin.get(i.id)?.refundRemainingCents ?? 0), 0);
  const customerOf = (c: unknown) => {
    const s = c as { type?: string; companyName?: string | null; firstName?: string; lastName?: string };
    const person = `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim();
    return s.type === "COMPANY" && s.companyName ? s.companyName : person || "–";
  };
  const today = new Date();
  const href = (bookingId: string, id: string) => `/buchungen/${bookingId}/rechnung?nr=${id}`;

  return (
    <>
      <PageHeader title="Rechnungen" sub={`${rows.length} ${filter.label.toLowerCase()} · offen ${fmtCents(totalOpen)}${totalCredit > 0 ? ` · noch zu erstatten ${fmtCents(totalCredit)}` : ""}`} />
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
          <span className="w-px bg-line-soft mx-1" aria-hidden />
          {DOCS.map((d) => (
            <Link key={d.key} href={qs({ beleg: d.key })} className={`btn !py-1.5 ${d.key === docF.key ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{d.label}</Link>
          ))}
        </div>
        <Card>
          {slice.length === 0 ? (
            <Empty>Keine Belege in dieser Ansicht.</Empty>
          ) : (
            <>
              {/* Smartphone: Karten statt breiter Tabelle */}
              <ul className="md:hidden divide-y divide-line-soft">
                {slice.map((i) => {
                  const f = fin.get(i.id);
                  return (
                    <li key={i.id} className="px-4 py-3 flex flex-col gap-1">
                      <div className="flex justify-between items-baseline gap-2"><span className="flex items-center gap-2"><Link href={href(i.bookingId, i.id)} className="font-mono tnum font-medium hover:underline">{i.number}</Link><DocChip type={i.documentType} /><KindChip kind={i.invoiceKind} /></span></div>
                      {f ? <StatusCell f={f} /> : i.original && <div className="text-xs">zu Rechnung <Link href={href(i.original.bookingId, i.original.id)} className="font-mono tnum hover:underline">{i.original.number}</Link></div>}
                      <div className="text-sm">{customerOf(i.customerSnapshot)} <span className="text-ink-3">· {fmtDate(i.issueDate)}{i.versionNo > 1 ? ` · Fassung ${i.versionNo}` : ""} · {i.delivered ? "übermittelt" : "nicht übermittelt"}</span></div>
                      {f ? (
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div><div className="label-xs">Forderung</div><div className="font-mono tnum">{fmtCents(f.effectiveCents)}</div>{f.effectiveCents !== f.invoiceCents && <div className="text-ink-3">Rechnung {fmtCents(f.invoiceCents)}</div>}</div>
                          <div><div className="label-xs">Bezahlt</div><div className="font-mono tnum text-good">{fmtCents(f.paidCents)}</div></div>
                          <div><div className="label-xs">{f.refundRequired ? "Zu erstatten" : "Offen"}</div><div className={`font-mono tnum ${f.openCents > 0 || f.refundOpen ? "text-bad font-semibold" : ""}`}>{fmtCents(f.refundRequired ? f.refundRemainingCents : f.openCents)}</div></div>
                        </div>
                      ) : (
                        <div className="text-xs"><span className="label-xs">Betrag</span> <span className="font-mono tnum text-bad">− {fmtCents(toCents(i.grossTotal))}</span></div>
                      )}
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
                      <th className="label-xs px-3 py-2 border-b border-line text-right">Forderung</th>
                      <th className="label-xs px-3 py-2 border-b border-line text-right">Bezahlt</th>
                      <th className="label-xs px-3 py-2 border-b border-line text-right">Offen / Guthaben</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Status</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Übermittlung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slice.map((i) => {
                      const f = fin.get(i.id);
                      const overdue = !!f && f.openCents > 0 && !!i.paymentDueDate && i.paymentDueDate < today;
                      return (
                        <tr key={i.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                          <td className="px-3 py-2.5 font-mono tnum"><Link href={href(i.bookingId, i.id)} className="hover:underline font-medium">{i.number}</Link>{i.original && <div className="text-xs text-ink-3">zu <Link href={href(i.original.bookingId, i.original.id)} className="hover:underline">{i.original.number}</Link></div>}</td>
                          <td className="px-3 py-2.5 text-xs"><span className="flex flex-wrap gap-1"><DocChip type={i.documentType} /><KindChip kind={i.invoiceKind} /></span>{i.damageCase ? <> <Link href={`/schaeden/${i.damageCase.id}`} className="font-mono tnum hover:underline">{i.damageCase.caseNumber}</Link></> : null}{i.taxTreatment && <div className="text-ink-3 mt-0.5">{DAMAGE_TAX_TREATMENTS[i.taxTreatment as DamageTaxTreatment] ?? i.taxTreatment}</div>}</td>
                          <td className="px-3 py-2.5 text-right tnum">{i.documentType === "INVOICE" ? <>{i.versionNo}{i.versionCount > 1 ? <span className="text-ink-3 text-xs"> / {i.versionCount}</span> : null}</> : "–"}</td>
                          <td className="px-3 py-2.5 font-mono tnum">{fmtDate(i.issueDate)}</td>
                          <td className="px-3 py-2.5">{customerOf(i.customerSnapshot)}</td>
                          <td className="px-3 py-2.5 font-mono tnum"><Link href={`/buchungen/${i.bookingId}`} className="hover:underline">{i.booking.number}</Link></td>
                          <td className={`px-3 py-2.5 font-mono tnum ${overdue ? "text-bad font-semibold" : ""}`}>{f && i.paymentDueDate ? fmtDate(i.paymentDueDate) : "–"}{overdue ? " (überfällig)" : ""}</td>
                          <td className="px-3 py-2.5 text-right font-mono tnum">{f ? <>{fmtCents(f.effectiveCents)}{f.effectiveCents !== f.invoiceCents && <div className="text-xs text-ink-3 font-normal">Rechnung {fmtCents(f.invoiceCents)}</div>}</> : <span className="text-bad">− {fmtCents(toCents(i.grossTotal))}</span>}</td>
                          <td className="px-3 py-2.5 text-right font-mono tnum text-good">{f ? fmtCents(f.paidCents) : "–"}</td>
                          <td className={`px-3 py-2.5 text-right font-mono tnum ${f && (f.openCents > 0 || f.refundOpen) ? "text-bad font-semibold" : ""}`}>{f ? (f.refundRequired ? `zu erstatten ${fmtCents(f.refundRemainingCents)}` : fmtCents(f.openCents)) : "–"}</td>
                          <td className="px-3 py-2.5">{f ? <StatusCell f={f} /> : <Chip tone="info">{INVOICE_DOCUMENT_TYPES[i.documentType as keyof typeof INVOICE_DOCUMENT_TYPES]} · Minderung</Chip>}</td>
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
        <p className="text-xs text-ink-3">Zahlungsstatus: {Object.values(INVOICE_PAYMENT_STATUS).join(" · ")} – abgeleitet aus der wirksamen Forderung (Rechnungsbetrag der aktuellen Fassung abzüglich abgeschlossener Gutschriften und Storno) und den bestätigten Zahlungen. Ein Guthaben ist nie ein negativer offener Betrag und nie überfällig. Kautionen sind hier nicht enthalten; sie sind keine Rechnungszahlungen. Rechnungsarten: {Object.values(INVOICE_KINDS).join(" · ")}.</p>
      </Content>
    </>
  );
}

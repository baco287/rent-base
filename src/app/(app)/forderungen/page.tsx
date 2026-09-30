import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, Empty, KPI, PageHeader } from "@/components/ui";
import { DUNNING_HELP } from "@/lib/constants";
import { listReceivables, RECEIVABLE_FILTERS, RECEIVABLE_SORTS, type Receivable, type ReceivableFilter, type ReceivableSort } from "@/lib/dunning";
import { fmtDate } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { receivableTone } from "../buchungen/[id]/rechnung/dunning-card";

export const metadata = { title: "Forderungen" };

const href = (r: Receivable) => `/buchungen/${r.bookingId}/rechnung?nr=${r.invoiceId}`;
const stage = (r: Receivable) => { const top = [...r.notices].sort((a, b) => b.level - a.level)[0]; return top ? `${top.label}${top.delivered ? "" : " (Versand offen)"}` : "–"; };
const nextText = (r: Receivable) => (r.next.kind === "WAIT_DUE" || r.next.kind === "WAIT_DEADLINE" ? `${r.next.label} bis ${fmtDate(r.next.until)}` : r.next.label);

/**
 * Befehl 23: Forderungsübersicht. Welcher Kunde hat welche Rechnung mit welcher Restforderung, seit wann fällig, in welcher
 * Mahnstufe, was ist als Nächstes zu tun. Suche, Filter, Sortierung und Seiten serverseitig; Stand aus der zentralen Summierung.
 */
export default async function ReceivablesPage({ searchParams }: PageProps<"/forderungen">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;
  const filter = (typeof sp.filter === "string" && sp.filter in RECEIVABLE_FILTERS ? sp.filter : "offen") as ReceivableFilter;
  const sort = (typeof sp.sort === "string" && sp.sort in RECEIVABLE_SORTS ? sp.sort : "faelligkeit") as ReceivableSort;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const page = Math.max(1, Number(typeof sp.seite === "string" ? sp.seite : 1) || 1);
  const list = await listReceivables(tenant.id, { filter, sort, q, page });
  const qs = (over: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | number | null> = { filter, sort, q: q || null, seite: null, ...over };
    for (const [k, v] of Object.entries(merged)) if (v != null && v !== "") p.set(k, String(v));
    return `/forderungen?${p.toString()}`;
  };

  return (
    <>
      <PageHeader title="Forderungen" sub={`${list.total} ${RECEIVABLE_FILTERS[filter].toLowerCase()} · offen ${fmtCents(list.sums.openCents)} · davon überfällig ${fmtCents(list.sums.overdueCents)}`}>
        <Link href="/rechnungen" className="btn">Rechnungen</Link>
        <Link href="/einstellungen/geschaeftsregeln" className="btn">Mahnwesen einstellen</Link>
      </PageHeader>
      <Content>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPI label="Offene Forderungen" value={fmtCents(list.sums.openCents)} detail="Rechnungen und Mahngebühren, ohne Kundenguthaben" hot={list.sums.openCents > 0} />
          <KPI label="Davon überfällig" value={fmtCents(list.sums.overdueCents)} detail="Fälligkeit überschritten" hot={list.sums.overdueCents > 0} />
        </div>
        <form action="/forderungen" className="flex flex-col sm:flex-row gap-2">
          <input type="hidden" name="filter" value={filter} />
          <input type="hidden" name="sort" value={sort} />
          <input name="q" defaultValue={q} maxLength={100} placeholder="Kunde, Kundennummer, Rechnungs- oder Buchungsnummer" className="input flex-1" aria-label="Forderungen durchsuchen" />
          <button className="btn btn-primary">Suchen</button>
          {q && <Link href={qs({ q: null })} className="btn">Zurücksetzen</Link>}
        </form>
        <nav aria-label="Filter" className="flex gap-1.5 flex-wrap">
          {(Object.keys(RECEIVABLE_FILTERS) as ReceivableFilter[]).map((k) => (
            <Link key={k} href={qs({ filter: k })} aria-current={k === filter ? "page" : undefined} className={`btn !py-2 ${k === filter ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{RECEIVABLE_FILTERS[k]}</Link>
          ))}
        </nav>
        <nav aria-label="Sortierung" className="flex gap-1.5 flex-wrap items-center text-sm">
          <span className="label-xs mr-1">Sortieren</span>
          {(Object.keys(RECEIVABLE_SORTS) as ReceivableSort[]).map((k) => (
            <Link key={k} href={qs({ sort: k })} aria-current={k === sort ? "page" : undefined} className={`btn !py-1.5 text-xs ${k === sort ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{RECEIVABLE_SORTS[k]}</Link>
          ))}
        </nav>
        <Card>
          {list.rows.length === 0 ? (
            <Empty>{q ? "Keine Forderung passt zur Suche." : "Keine Forderungen in dieser Ansicht."}</Empty>
          ) : (
            <>
              {/* Smartphone und Tablet hochkant: Karten */}
              <ul className="lg:hidden divide-y divide-line-soft">
                {list.rows.map((r) => (
                  <li key={r.invoiceId} className="px-4 py-3 flex flex-col gap-1.5">
                    <div className="flex flex-wrap justify-between items-baseline gap-2">
                      <Link href={href(r)} className="font-medium hover:underline">{r.customerName}</Link>
                      <span className={`font-mono tnum font-semibold ${r.totalOpenCents > 0 ? "text-bad" : "text-good"}`}>{fmtCents(r.totalOpenCents)}</span>
                    </div>
                    <div className="text-xs text-ink-3 flex flex-wrap gap-x-2">
                      <Link href={href(r)} className="font-mono tnum underline">{r.number}</Link>
                      <span>· Buchung {r.bookingNumber}</span>
                      {r.customerNumber && <span>· {r.customerNumber}</span>}
                      <span>· Rechnung {fmtCents(r.invoiceCents)} vom {fmtDate(r.issueDate)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Chip tone={receivableTone(r.status)}>{r.statusLabel}</Chip>
                      <span>fällig {r.dueDate ? fmtDate(r.dueDate) : "–"}{r.daysOverdue > 0 ? ` · ${r.daysOverdue} Tage überfällig` : ""}</span>
                    </div>
                    <div className="text-xs">Mahnstufe: {stage(r)}{r.feesOpenCents > 0 ? ` · Gebühren offen ${fmtCents(r.feesOpenCents)}` : ""}</div>
                    <div className="text-xs font-medium">Nächster Schritt: {nextText(r)}</div>
                  </li>
                ))}
              </ul>
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-[13.5px]">
                  <thead>
                    <tr className="text-left">
                      {["Kunde", "Rechnung", "Buchung", "Rechnungsdatum", "Fällig am", "Rechnungsbetrag", "Restforderung", "Überfällig", "Mahnstufe", "Nächster Schritt"].map((h, i) => <th key={h} className={`label-xs px-3 py-2 border-b border-line ${i === 5 || i === 6 || i === 7 ? "text-right" : ""}`}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((r) => (
                      <tr key={r.invoiceId} className="border-b border-line-soft align-top">
                        <td className="px-3 py-2.5"><div className="font-medium">{r.customerName}</div>{r.customerNumber && <div className="text-xs text-ink-3 font-mono">{r.customerNumber}</div>}</td>
                        <td className="px-3 py-2.5"><Link href={href(r)} className="font-mono tnum hover:underline">{r.number}</Link></td>
                        <td className="px-3 py-2.5 font-mono tnum"><Link href={`/buchungen/${r.bookingId}`} className="hover:underline">{r.bookingNumber}</Link></td>
                        <td className="px-3 py-2.5 font-mono tnum">{fmtDate(r.issueDate)}</td>
                        <td className="px-3 py-2.5 font-mono tnum">{r.dueDate ? fmtDate(r.dueDate) : "–"}</td>
                        <td className="px-3 py-2.5 font-mono tnum text-right">{fmtCents(r.invoiceCents)}</td>
                        <td className={`px-3 py-2.5 font-mono tnum text-right ${r.totalOpenCents > 0 ? "text-bad font-semibold" : "text-good"}`}>{fmtCents(r.totalOpenCents)}{r.feesOpenCents > 0 && <div className="text-[11px] text-ink-3 font-normal">inkl. Gebühren {fmtCents(r.feesOpenCents)}</div>}</td>
                        <td className="px-3 py-2.5 font-mono tnum text-right">{r.daysOverdue > 0 ? `${r.daysOverdue} T.` : "–"}</td>
                        <td className="px-3 py-2.5"><Chip tone={receivableTone(r.status)}>{r.statusLabel}</Chip><div className="text-xs text-ink-3 mt-0.5">{stage(r)}</div></td>
                        <td className="px-3 py-2.5 text-xs">{nextText(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
        {list.pages > 1 && (
          <nav aria-label="Seiten" className="flex flex-wrap gap-1.5 items-center text-sm">
            {list.page > 1 && <Link href={qs({ seite: list.page - 1 })} className="btn !py-2">Zurück</Link>}
            <span className="text-ink-3">Seite {list.page} von {list.pages}</span>
            {list.page < list.pages && <Link href={qs({ seite: list.page + 1 })} className="btn !py-2">Weiter</Link>}
          </nav>
        )}
        <p className="text-xs text-ink-3">{DUNNING_HELP.NO_AUTOMATION} {DUNNING_HELP.NO_INTEREST} Rechnungen ohne Zahlungsziel erscheinen unter „Ohne Fälligkeit“; Rent-Base legt für sie kein Fälligkeitsdatum rückwirkend fest.</p>
      </Content>
    </>
  );
}

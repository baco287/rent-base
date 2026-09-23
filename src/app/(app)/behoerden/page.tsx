import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, Empty, PageHeader, Plate } from "@/components/ui";
import { AUTHORITY_CASE_TYPES } from "@/lib/constants";
import { AUTHORITY_FILTERS, authorityCounts, listAuthorityCases, type AuthorityFilter, type ListOptions } from "@/lib/authority";
import { fmtDate } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { AuthorityStatusChip, AuthorityTypeChip, DeadlineChip } from "./chips";

export const metadata = { title: "Behörden & Bußgelder" };

const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null);

/** Eingangsübersicht der Behördenvorgänge: Abschnitte als Filter, Suche, weitere Filter, Serverseiten. Keine Personendaten in der Liste. */
export default async function AuthorityOverviewPage({ searchParams }: PageProps<"/behoerden">) {
  const { tenant, user } = await requireSession();
  const sp = await searchParams;
  const filter = (AUTHORITY_FILTERS.find((f) => f.key === sp.filter)?.key ?? "alle") as AuthorityFilter;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : "";
  const page = Math.max(1, parseInt(typeof sp.seite === "string" ? sp.seite : "1", 10) || 1);
  const type = typeof sp.art === "string" && sp.art in AUTHORITY_CASE_TYPES ? sp.art : null;
  const opts: ListOptions = { filter, q, page, type, assigned: pick(sp.zugeordnet, ["ja", "nein"] as const), driver: pick(sp.fahrer, ["ja", "nein"] as const), submitted: pick(sp.uebermittelt, ["ja", "nein"] as const), deadline: pick(sp.frist, ["ueberfaellig", "bald", "ohne"] as const) };
  const [counts, list] = await Promise.all([authorityCounts(tenant.id), listAuthorityCases(tenant.id, opts)]);
  const base: Record<string, string> = { filter, ...(q ? { q } : {}), ...(type ? { art: type } : {}), ...(opts.assigned ? { zugeordnet: opts.assigned } : {}), ...(opts.driver ? { fahrer: opts.driver } : {}), ...(opts.submitted ? { uebermittelt: opts.submitted } : {}), ...(opts.deadline ? { frist: opts.deadline } : {}) };
  const qs = (over: Record<string, string | number>) => `/behoerden?${new URLSearchParams({ ...base, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) }).toString()}`;
  const canManage = user.role !== "YARD";

  return (
    <>
      <PageHeader title="Behörden & Bußgelder" sub={`${counts.received} neu · ${counts.assignment} Zuordnung erforderlich · ${counts.overdue} überfällig`}>
        {canManage && <Link href="/behoerden/neu" className="btn btn-primary">Schreiben erfassen</Link>}
      </PageHeader>
      <Content>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Link href="/behoerden?filter=neu" className={`rounded-lg px-3.5 py-3 ${counts.received > 0 ? "bg-info-soft" : "bg-panel-2"}`}><div className="label-xs">Neue Behördenanfragen</div><div className="font-display text-3xl font-semibold tnum">{counts.received}</div></Link>
          <Link href="/behoerden?filter=zuordnung" className={`rounded-lg px-3.5 py-3 ${counts.assignment > 0 ? "bg-amber-soft" : "bg-panel-2"}`}><div className="label-xs">Zuordnung erforderlich</div><div className="font-display text-3xl font-semibold tnum">{counts.assignment}</div></Link>
          <Link href="/behoerden?frist=bald" className={`rounded-lg px-3.5 py-3 ${counts.dueSoon > 0 ? "bg-amber-soft" : "bg-panel-2"}`}><div className="label-xs">Antwortfrist ≤ 3 Tage</div><div className="font-display text-3xl font-semibold tnum">{counts.dueSoon}</div></Link>
          <Link href="/behoerden?filter=ueberfaellig" className={`rounded-lg px-3.5 py-3 ${counts.overdue > 0 ? "bg-bad-soft" : "bg-panel-2"}`}><div className="label-xs">Überfällig</div><div className="font-display text-3xl font-semibold tnum">{counts.overdue}</div></Link>
        </div>

        <form action="/behoerden" className="flex flex-wrap gap-2 items-end">
          <input type="hidden" name="filter" value={filter} />
          <label className="sr-only" htmlFor="a-q">Suche</label>
          <input id="a-q" name="q" defaultValue={q} placeholder="Vorgangsnr., Aktenzeichen, Kennzeichen, Kunde, Buchung, Vertrag, Behörde" className="input max-w-md flex-1 min-w-[220px]" />
          <label className="flex flex-col gap-1"><span className="label-xs">Art</span><select name="art" defaultValue={type ?? ""} className="input"><option value="">alle</option>{Object.entries(AUTHORITY_CASE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Frist</span><select name="frist" defaultValue={opts.deadline ?? ""} className="input"><option value="">alle</option><option value="ueberfaellig">überfällig</option><option value="bald">≤ 3 Tage</option><option value="ohne">ohne Frist</option></select></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Vermietung</span><select name="zugeordnet" defaultValue={opts.assigned ?? ""} className="input"><option value="">alle</option><option value="ja">zugeordnet</option><option value="nein">nicht zugeordnet</option></select></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Fahrer</span><select name="fahrer" defaultValue={opts.driver ?? ""} className="input"><option value="">alle</option><option value="ja">benannt</option><option value="nein">nicht benannt</option></select></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Antwort</span><select name="uebermittelt" defaultValue={opts.submitted ?? ""} className="input"><option value="">alle</option><option value="ja">übermittelt</option><option value="nein">nicht übermittelt</option></select></label>
          <button className="btn">Suchen</button>
        </form>
        <div className="flex gap-1.5 flex-wrap" aria-label="Abschnitte">
          {AUTHORITY_FILTERS.map((f) => <Link key={f.key} href={qs({ filter: f.key, seite: 1 })} className={`btn !py-1.5 ${f.key === filter ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{f.label}</Link>)}
        </div>

        <Card title={AUTHORITY_FILTERS.find((f) => f.key === filter)?.label ?? "Vorgänge"} right={<Chip>{list.total}</Chip>}>
          {list.items.length === 0 ? (
            <Empty action={canManage && filter === "alle" && !q ? { href: "/behoerden/neu", label: "Schreiben erfassen" } : undefined}>Keine Vorgänge in dieser Ansicht.</Empty>
          ) : (
            <>
              <ul className="md:hidden divide-y divide-line-soft">
                {list.items.map((c) => (
                  <li key={c.id} className="px-4 py-3 flex flex-col gap-1">
                    <div className="flex justify-between items-baseline gap-2"><Link href={`/behoerden/${c.id}`} className="font-medium font-mono tnum hover:underline">{c.caseNumber}</Link><AuthorityStatusChip status={c.status} /></div>
                    <div className="text-sm flex flex-wrap items-center gap-x-2 gap-y-1"><Plate>{c.licensePlateSnapshot}</Plate><AuthorityTypeChip type={c.type} /><span className="text-ink-2">{c.authorityName}</span></div>
                    <div className="text-xs text-ink-3 flex flex-wrap gap-x-3"><span>Az. {c.authorityReference}</span><span>Tatzeit {c.offenseText}</span>{c.booking && <span>Buchung {c.booking.number}</span>}</div>
                    <div><DeadlineChip level={c.deadline.level} text={c.deadline.text} /></div>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-[13.5px]">
                  <thead><tr className="text-left"><th className="label-xs px-3 py-2 border-b border-line">Nr.</th><th className="label-xs px-3 py-2 border-b border-line">Art</th><th className="label-xs px-3 py-2 border-b border-line">Behörde / Aktenzeichen</th><th className="label-xs px-3 py-2 border-b border-line">Kennzeichen</th><th className="label-xs px-3 py-2 border-b border-line">Tatzeit</th><th className="label-xs px-3 py-2 border-b border-line">Vermietung</th><th className="label-xs px-3 py-2 border-b border-line">Frist</th><th className="label-xs px-3 py-2 border-b border-line text-right">Betrag</th><th className="label-xs px-3 py-2 border-b border-line">Status</th></tr></thead>
                  <tbody>
                    {list.items.map((c) => (
                      <tr key={c.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                        <td className="px-3 py-2.5 font-mono tnum"><Link href={`/behoerden/${c.id}`} className="hover:underline font-medium">{c.caseNumber}</Link></td>
                        <td className="px-3 py-2.5"><AuthorityTypeChip type={c.type} /></td>
                        <td className="px-3 py-2.5"><div>{c.authorityName}</div><div className="text-xs text-ink-3 font-mono">{c.authorityReference}</div></td>
                        <td className="px-3 py-2.5"><div className="flex items-center gap-2"><Plate>{c.licensePlateSnapshot}</Plate>{c.vehicle ? <Link href={`/fahrzeuge/${c.vehicle.id}?tab=behoerden`} className="hover:underline text-xs">{c.vehicle.make} {c.vehicle.model}</Link> : <span className="text-xs text-ink-3">kein Fahrzeug</span>}</div></td>
                        <td className="px-3 py-2.5 font-mono tnum text-xs">{c.offenseText}</td>
                        <td className="px-3 py-2.5 text-xs">{c.booking ? <Link href={`/buchungen/${c.booking.id}`} className="underline font-mono tnum">{c.booking.number}</Link> : <span className="text-ink-3">–</span>}</td>
                        <td className="px-3 py-2.5"><DeadlineChip level={c.deadline.level} text={c.deadline.text} />{c.responseDeadline && <div className="text-xs text-ink-3 mt-0.5">Antwort bis {fmtDate(c.responseDeadline)}</div>}</td>
                        <td className="px-3 py-2.5 text-right font-mono tnum">{c.noticeAmountCents != null ? fmtCents(c.noticeAmountCents) : "–"}</td>
                        <td className="px-3 py-2.5"><AuthorityStatusChip status={c.status} />{c.responses[0] && <div className="text-xs text-ink-3 mt-0.5">Fassung {c.responses[0].version}</div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
        {list.pages > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {list.page > 1 && <Link href={qs({ seite: list.page - 1 })} className="btn !py-1.5">Zurück</Link>}
            <Chip>Seite {list.page} von {list.pages}</Chip>
            {list.page < list.pages && <Link href={qs({ seite: list.page + 1 })} className="btn !py-1.5">Weiter</Link>}
          </div>
        )}
        <p className="text-xs text-ink-3">Beträge sind reine Information aus dem Schreiben – ein Bußgeld erzeugt in Rent-Base nie eine Rechnung, Zahlung, Zusatzkosten oder Kautionsbewegung. Fristen werden nur angezeigt, wenn sie im Schreiben stehen.</p>
      </Content>
    </>
  );
}

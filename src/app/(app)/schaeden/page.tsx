import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, Empty, PageHeader, Plate } from "@/components/ui";
import { DAMAGE_CASE_PRIORITY, DAMAGE_CASE_STATUS, DAMAGE_KINDS, LIABILITY_STATUS, type DamageCasePriority, type DamageKind } from "@/lib/constants";
import { CASE_FILTERS, listCases, type CaseFilter } from "@/lib/damage-cases";
import { fmtDate } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { PaymentStatusChip } from "../buchungen/[id]/finanzen/panels";
import { CaseStatusChip, LiabilityChip } from "./chips";

export const metadata = { title: "Schäden" };

/** Schadenakten: serverseitig gefiltert, gesucht und seitenweise geladen. Eine Akte je Schaden; historische Schäden ohne Akte stehen an der Fahrzeugakte. */
export default async function DamageCasesPage({ searchParams }: PageProps<"/schaeden">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;
  const filter = (CASE_FILTERS.find((f) => f.key === sp.filter)?.key ?? "offen") as CaseFilter;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : "";
  const page = Math.max(1, parseInt(typeof sp.seite === "string" ? sp.seite : "1", 10) || 1);
  const list = await listCases(tenant.id, { filter, q, page });
  const qs = (over: Record<string, string | number>) => {
    const u = new URLSearchParams({ filter, ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) });
    return `/schaeden?${u.toString()}`;
  };
  const label = CASE_FILTERS.find((f) => f.key === filter)!.label;

  return (
    <>
      <PageHeader title="Schäden" sub={`${list.total} ${list.total === 1 ? "Schadenakte" : "Schadenakten"} · ${label}${q ? ` · Suche „${q}“` : ""}`} />
      <Content>
        <form action="/schaeden" className="flex flex-wrap gap-2 items-center">
          <input type="hidden" name="filter" value={filter} />
          <label className="sr-only" htmlFor="case-q">Suche</label>
          <input id="case-q" name="q" defaultValue={q} placeholder="Aktennummer, Kennzeichen, Buchung, Kunde" className="input max-w-sm" />
          <button className="btn">Suchen</button>
          {q && <Link href={qs({ q: "" }).replace(/&?q=(&|$)/, "$1")} className="btn">Zurücksetzen</Link>}
        </form>
        <div className="flex gap-1.5 flex-wrap" aria-label="Filter">
          {CASE_FILTERS.map((f) => (
            <Link key={f.key} href={qs({ filter: f.key, seite: 1 })} className={`btn !py-1.5 ${f.key === filter ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{f.label}</Link>
          ))}
        </div>
        <Card>
          {list.items.length === 0 ? (
            <Empty>Keine Schadenakten in dieser Ansicht. Akten werden aus einem dokumentierten Schaden heraus eröffnet – an der Fahrzeugakte, der Buchung oder dem Rückgabeprotokoll.</Empty>
          ) : (
            <>
              <ul className="md:hidden divide-y divide-line-soft">
                {list.items.map((c) => (
                  <li key={c.id} className="px-4 py-3 flex flex-col gap-1.5">
                    <div className="flex justify-between items-baseline gap-2">
                      <Link href={`/schaeden/${c.id}`} className="font-mono tnum font-medium hover:underline">{c.caseNumber}</Link>
                      <CaseStatusChip status={c.status} />
                    </div>
                    <div className="text-sm flex flex-wrap items-center gap-x-2 gap-y-1"><Plate>{c.vehicle.plate}</Plate><span>{c.vehicle.make} {c.vehicle.model}</span>{c.vehicle.status === "BLOCKED" && <Chip tone="bad">gesperrt</Chip>}</div>
                    <div className="text-sm text-ink-2">{DAMAGE_KINDS[c.damage.kind as DamageKind] ?? c.damage.kind}: {c.damage.description}</div>
                    <div className="flex flex-wrap gap-1.5 items-center text-xs">
                      <LiabilityChip status={c.liabilityStatus} />
                      {c.priority !== "NORMAL" && <Chip tone={c.priority === "HIGH" ? "bad" : "grey"}>Priorität {DAMAGE_CASE_PRIORITY[c.priority as DamageCasePriority]}</Chip>}
                      <span className="text-ink-3">{fmtDate(c.reportedAt)}{c.booking ? ` · ${c.booking.number}` : ""}</span>
                    </div>
                    {c.invoice && <div className="text-xs flex flex-wrap gap-1.5 items-center"><span>Schadenabrechnung {c.invoice.number ?? "(Entwurf)"}</span>{c.payment ? <PaymentStatusChip status={c.payment.status} /> : <Chip tone="amber">Entwurf</Chip>}</div>}
                  </li>
                ))}
              </ul>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-[13.5px]">
                  <thead>
                    <tr className="text-left">
                      <th className="label-xs px-3 py-2 border-b border-line">Akte</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Fahrzeug</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Schaden</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Festgestellt</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Status</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Haftung</th>
                      <th className="label-xs px-3 py-2 border-b border-line text-right">Kosten</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Abrechnung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((c) => (
                      <tr key={c.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                        <td className="px-3 py-2.5 font-mono tnum"><Link href={`/schaeden/${c.id}`} className="hover:underline font-medium">{c.caseNumber}</Link>{c.priority === "HIGH" && <Chip tone="bad">hoch</Chip>}</td>
                        <td className="px-3 py-2.5"><div className="flex items-center gap-2"><Plate>{c.vehicle.plate}</Plate><span>{c.vehicle.make} {c.vehicle.model}</span>{c.vehicle.status === "BLOCKED" && <Chip tone="bad">gesperrt</Chip>}</div></td>
                        <td className="px-3 py-2.5 max-w-[280px]"><div className="truncate" title={c.damage.description}>{DAMAGE_KINDS[c.damage.kind as DamageKind] ?? c.damage.kind}: {c.damage.description}</div><div className="text-xs text-ink-3">{c.damage.discoveredIn ? `${c.damage.discoveredIn.type === "RETURN" ? "Rückgabe" : "Übergabe"} ${c.damage.discoveredIn.number}` : "Hof"}{c.booking ? ` · ${c.booking.number}` : ""}</div></td>
                        <td className="px-3 py-2.5 font-mono tnum">{fmtDate(c.reportedAt)}</td>
                        <td className="px-3 py-2.5"><CaseStatusChip status={c.status} /></td>
                        <td className="px-3 py-2.5"><LiabilityChip status={c.liabilityStatus} /></td>
                        <td className="px-3 py-2.5 text-right font-mono tnum">{c.actualCostCents != null ? fmtCents(c.actualCostCents) : c.estimatedCostCents != null ? <span className="text-ink-3">~{fmtCents(c.estimatedCostCents)}</span> : "–"}</td>
                        <td className="px-3 py-2.5 text-xs">{c.invoice ? <span className="flex flex-wrap items-center gap-1.5"><span className="font-mono tnum">{c.invoice.number ?? "Entwurf"}</span>{c.payment ? <PaymentStatusChip status={c.payment.status} /> : <Chip tone="amber">Entwurf</Chip>}</span> : c.customerChargeCents != null ? "Belastung festgelegt" : "–"}</td>
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
        <p className="text-xs text-ink-3">Status: {Object.values(DAMAGE_CASE_STATUS).join(" · ")}. Haftung: {Object.values(LIABILITY_STATUS).join(" · ")}. Eine Akte setzt keine Haftung fest und erzeugt keine Forderung; beides sind ausdrückliche Entscheidungen in der Akte.</p>
      </Content>
    </>
  );
}

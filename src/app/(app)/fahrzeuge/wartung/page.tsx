import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, Empty, PageHeader, Plate, VehicleStatusChip } from "@/components/ui";
import { MAINTENANCE_PRIORITY, type MaintenancePriority } from "@/lib/constants";
import { fleetDues, FLEET_FILTERS, listMaintenance, maintenanceCounts, type FleetFilter } from "@/lib/maintenance";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { DueChip, MaintStatusChip, TypeChip } from "./chips";

export const metadata = { title: "Wartung & Werkstatt" };

/** Wartungsübersicht der Flotte: Fälligkeiten (aus Plänen berechnet) und Werkstattvorgänge mit Filter, Suche und Seiten. */
export default async function MaintenanceOverviewPage({ searchParams }: PageProps<"/fahrzeuge/wartung">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;
  const filter = (FLEET_FILTERS.find((f) => f.key === sp.filter)?.key ?? "alle") as FleetFilter;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : "";
  const page = Math.max(1, parseInt(typeof sp.seite === "string" ? sp.seite : "1", 10) || 1);
  const [dues, counts, list] = await Promise.all([fleetDues(tenant.id), maintenanceCounts(tenant.id), listMaintenance(tenant.id, { filter: filter === "ueberfaellig" || filter === "bald" ? "alle" : filter, q, page })]);
  const dueRows = filter === "ueberfaellig" ? dues.filter((d) => d.due.level === "OVERDUE" || d.due.level === "DUE") : filter === "bald" ? dues.filter((d) => d.due.level === "SOON") : dues.filter((d) => d.due.level !== "OK" && d.due.level !== "NONE");
  const qs = (over: Record<string, string | number>) => `/fahrzeuge/wartung?${new URLSearchParams({ filter, ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) }).toString()}`;

  return (
    <>
      <PageHeader title="Wartung & Werkstatt" sub={`${counts.overdue} überfällig · ${counts.soon} bald fällig · ${counts.inWorkshop} in Werkstatt`}>
        <Link href="/fahrzeuge" className="btn">Fahrzeuge</Link>
      </PageHeader>
      <Content>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className={`rounded-lg px-3.5 py-3 ${counts.overdue > 0 ? "bg-bad-soft" : "bg-panel-2"}`}><div className="label-xs">Überfällig / fällig</div><div className="font-display text-3xl font-semibold tnum">{counts.overdue}</div></div>
          <div className={`rounded-lg px-3.5 py-3 ${counts.soon > 0 ? "bg-amber-soft" : "bg-panel-2"}`}><div className="label-xs">Bald fällig</div><div className="font-display text-3xl font-semibold tnum">{counts.soon}</div></div>
          <div className="rounded-lg px-3.5 py-3 bg-panel-2"><div className="label-xs">Werkstatttermine 7 Tage</div><div className="font-display text-3xl font-semibold tnum">{counts.appointmentsWeek}</div></div>
          <div className="rounded-lg px-3.5 py-3 bg-panel-2"><div className="label-xs">Fahrzeuge in Werkstatt</div><div className="font-display text-3xl font-semibold tnum">{counts.inWorkshop}</div><div className="text-xs text-ink-2">{counts.inProgress} Vorgänge in Arbeit</div></div>
        </div>

        <form action="/fahrzeuge/wartung" className="flex flex-wrap gap-2 items-center">
          <input type="hidden" name="filter" value={filter} />
          <label className="sr-only" htmlFor="m-q">Suche</label>
          <input id="m-q" name="q" defaultValue={q} placeholder="Vorgangsnummer, Titel, Werkstatt, Kennzeichen" className="input max-w-sm" />
          <button className="btn">Suchen</button>
        </form>
        <div className="flex gap-1.5 flex-wrap" aria-label="Filter">
          {FLEET_FILTERS.map((f) => <Link key={f.key} href={qs({ filter: f.key, seite: 1 })} className={`btn !py-1.5 ${f.key === filter ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{f.label}</Link>)}
        </div>

        {(filter === "alle" || filter === "ueberfaellig" || filter === "bald") && (
          <Card title={filter === "bald" ? "Bald fällige Wartungen" : filter === "ueberfaellig" ? "Überfällige und fällige Wartungen" : "Anstehende Fälligkeiten"} right={<Chip tone={dueRows.length > 0 ? "amber" : "good"}>{dueRows.length}</Chip>}>
            {dueRows.length === 0 ? (
              <p className="p-4 text-sm text-ink-3">Keine {filter === "bald" ? "bald fälligen" : "überfälligen oder bald fälligen"} Wartungen. Fälligkeiten entstehen aus Wartungsplänen an der Fahrzeugakte.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {dueRows.map((d) => (
                  <li key={d.id} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-x-3 gap-y-1 text-sm">
                    <div className="flex items-center gap-2 min-w-[220px]"><Plate>{d.vehicle.plate}</Plate><Link href={`/fahrzeuge/${d.vehicle.id}?tab=wartung`} className="hover:underline">{d.vehicle.make} {d.vehicle.model}</Link></div>
                    <div className="flex-1 flex flex-wrap items-center gap-2"><TypeChip type={d.type} /><span>{d.title}</span><DueChip level={d.due.level} text={d.due.text} /></div>
                    <div className="text-xs text-ink-3">{d.nextDueDate ? fmtDate(d.nextDueDate) : ""}{d.nextDueMileage != null ? ` · ${d.nextDueMileage.toLocaleString("de-DE")} km` : ""}</div>
                    <Link href={`/fahrzeuge/wartung/neu?fahrzeug=${d.vehicle.id}&plan=${d.id}&art=${d.type}`} className="btn !py-1.5">Vorgang anlegen</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card title="Werkstattvorgänge" right={<Chip>{list.total}</Chip>}>
          {list.items.length === 0 ? (
            <Empty>Keine Vorgänge in dieser Ansicht. Vorgänge werden an der Fahrzeugakte über „Wartung / Werkstatt hinzufügen“ angelegt.</Empty>
          ) : (
            <>
              <ul className="md:hidden divide-y divide-line-soft">
                {list.items.map((r) => (
                  <li key={r.id} className="px-4 py-3 flex flex-col gap-1">
                    <div className="flex justify-between items-baseline gap-2"><Link href={`/fahrzeuge/wartung/${r.id}`} className="font-medium hover:underline">{r.title}</Link><MaintStatusChip status={r.status} /></div>
                    <div className="text-sm flex flex-wrap items-center gap-x-2 gap-y-1"><Plate>{r.vehicle.plate}</Plate><span>{r.vehicle.make} {r.vehicle.model}</span><TypeChip type={r.type} /></div>
                    <div className="text-xs text-ink-3 flex flex-wrap gap-x-3"><span className="font-mono tnum">{r.maintenanceNumber}</span>{r.scheduledAt && <span>Termin {fmtDateTime(r.scheduledAt)}</span>}{r.completedAt && <span>erledigt {fmtDate(r.completedAt)}</span>}{r.workshopName && <span>{r.workshopName}</span>}{r.actualCostCents != null && <span className="font-mono tnum">{fmtCents(r.actualCostCents)}</span>}</div>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-[13.5px]">
                  <thead><tr className="text-left"><th className="label-xs px-3 py-2 border-b border-line">Nr.</th><th className="label-xs px-3 py-2 border-b border-line">Fahrzeug</th><th className="label-xs px-3 py-2 border-b border-line">Vorgang</th><th className="label-xs px-3 py-2 border-b border-line">Termin / Erledigt</th><th className="label-xs px-3 py-2 border-b border-line">Werkstatt</th><th className="label-xs px-3 py-2 border-b border-line text-right">Kosten</th><th className="label-xs px-3 py-2 border-b border-line">Status</th></tr></thead>
                  <tbody>
                    {list.items.map((r) => (
                      <tr key={r.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                        <td className="px-3 py-2.5 font-mono tnum"><Link href={`/fahrzeuge/wartung/${r.id}`} className="hover:underline font-medium">{r.maintenanceNumber}</Link>{r.priority !== "NORMAL" && <div><Chip tone={r.priority === "LOW" ? "grey" : "bad"}>{MAINTENANCE_PRIORITY[r.priority as MaintenancePriority]}</Chip></div>}</td>
                        <td className="px-3 py-2.5"><div className="flex items-center gap-2"><Plate>{r.vehicle.plate}</Plate><Link href={`/fahrzeuge/${r.vehicle.id}?tab=wartung`} className="hover:underline">{r.vehicle.make} {r.vehicle.model}</Link><VehicleStatusChip status={r.vehicle.status} /></div></td>
                        <td className="px-3 py-2.5"><div className="flex items-center gap-2"><TypeChip type={r.type} /><span>{r.title}</span>{r.damageCase && <Link href={`/schaeden/${r.damageCase.id}`} className="font-mono tnum text-xs underline">{r.damageCase.caseNumber}</Link>}</div></td>
                        <td className="px-3 py-2.5 font-mono tnum text-xs">{r.completedAt ? `erledigt ${fmtDate(r.completedAt)}` : r.scheduledAt ? fmtDateTime(r.scheduledAt) : "–"}</td>
                        <td className="px-3 py-2.5">{r.workshopName ?? "–"}</td>
                        <td className="px-3 py-2.5 text-right font-mono tnum">{r.actualCostCents != null ? fmtCents(r.actualCostCents) : r.estimatedCostCents != null ? <span className="text-ink-3">~{fmtCents(r.estimatedCostCents)}</span> : "–"}</td>
                        <td className="px-3 py-2.5"><MaintStatusChip status={r.status} /></td>
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
        <p className="text-xs text-ink-3">Eine Fälligkeit warnt nur – sie sperrt kein Fahrzeug. Sperren („Werkstatt“) und Freigeben sind bewusste Aktionen am Vorgang. Kosten sind interne Betriebskosten, keine Kundenrechnungen.</p>
      </Content>
    </>
  );
}

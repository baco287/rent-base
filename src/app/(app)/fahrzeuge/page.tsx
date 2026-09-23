import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { FUELS, type Fuel } from "@/lib/constants";
import { fmtEur, fmtInt } from "@/lib/format";
import { Card, Content, Empty, PageHeader, Plate, VehicleStatusChip } from "@/components/ui";

export const metadata = { title: "Fahrzeuge" };

function huTone(d: Date | null) {
  if (!d) return "";
  const days = (d.getTime() - Date.now()) / 86400000;
  if (days < 0) return "text-bad font-semibold";
  if (days < 30) return "text-amber font-semibold";
  return "";
}

export default async function VehiclesPage({ searchParams }: PageProps<"/fahrzeuge">) {
  const { tenant } = await requireSession();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const showInactive = params.inaktiv === "1";

  const [groups, vehicles] = await Promise.all([
    db.vehicleGroup.findMany({ where: { tenantId: tenant.id }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    db.vehicle.findMany({
      where: {
        tenantId: tenant.id,
        ...(showInactive ? {} : { status: { not: "INACTIVE" } }),
        ...(q ? { OR: [{ plate: { contains: q } }, { make: { contains: q } }, { model: { contains: q } }] } : {}),
      },
      orderBy: [{ plate: "asc" }],
    }),
  ]);

  const active = vehicles.filter((v) => v.status !== "INACTIVE").length;
  const sections = [
    ...groups.map((g) => ({ id: g.id, name: g.name, description: g.description, items: vehicles.filter((v) => v.groupId === g.id) })),
    { id: "none", name: "Ohne Gruppe", description: null, items: vehicles.filter((v) => !v.groupId) },
  ].filter((s) => s.items.length > 0 || (s.id !== "none" && !q));

  return (
    <>
      <PageHeader title="Fahrzeuge" sub={`${active} aktiv in ${groups.length} Gruppen`}>
        <Link href="/fahrzeuge/wartung" className="btn">Wartung & Werkstatt</Link>
        <form className="flex gap-2">
          <input name="q" defaultValue={q} placeholder="Kennzeichen, Marke, Modell" className="input !w-56 !min-h-[36px]" />
          {showInactive && <input type="hidden" name="inaktiv" value="1" />}
          <button className="btn">Suchen</button>
        </form>
        <Link href="/fahrzeuge/gruppen" className="btn">Gruppen verwalten</Link>
        <Link href="/fahrzeuge/neu" className="btn btn-primary">+ Fahrzeug</Link>
      </PageHeader>
      <Content>
        {groups.length === 0 ? (
          <Card>
            <Empty action={{ href: "/fahrzeuge/gruppen", label: "Erste Fahrzeuggruppe anlegen" }}>
              Fahrzeuge werden in Gruppen geführt, zum Beispiel Transporter, Kompaktklasse, Kombi. Lege zuerst eine Gruppe an.
            </Empty>
          </Card>
        ) : vehicles.length === 0 && q ? (
          <Card><Empty>Nichts gefunden für „{q}“.</Empty></Card>
        ) : (
          sections.map((s) => (
            <Card
              key={s.id}
              title={s.name}
              right={
                <>
                  <span className="text-xs text-ink-3">{s.description}</span>
                  <span className="chip bg-panel-2 text-ink-2">{s.items.length} {s.items.length === 1 ? "Fahrzeug" : "Fahrzeuge"}</span>
                  {s.id !== "none" && <Link href={`/fahrzeuge/neu?gruppe=${s.id}`} className="btn !py-1">+ Fahrzeug</Link>}
                </>
              }
            >
              {s.items.length === 0 ? (
                <p className="px-4 py-3 text-sm text-ink-3">Noch kein Fahrzeug in dieser Gruppe.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13.5px]">
                    <thead>
                      <tr className="text-left">
                        <th className="label-xs px-3 py-2 border-b border-line">Kennzeichen</th>
                        <th className="label-xs px-3 py-2 border-b border-line">Fahrzeug</th>
                        <th className="label-xs px-3 py-2 border-b border-line text-right">km-Stand</th>
                        <th className="label-xs px-3 py-2 border-b border-line">HU</th>
                        <th className="label-xs px-3 py-2 border-b border-line">Status</th>
                        <th className="label-xs px-3 py-2 border-b border-line text-right">Tag</th>
                        <th className="label-xs px-3 py-2 border-b border-line text-right">Woche 5 T / KW 7 T</th>
                        <th className="label-xs px-3 py-2 border-b border-line text-right">Monat</th>
                        <th className="label-xs px-3 py-2 border-b border-line text-right">Kaution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.items.map((v) => (
                        <tr key={v.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                          <td className="px-3 py-2.5"><Link href={`/fahrzeuge/${v.id}`}><Plate>{v.plate}</Plate></Link></td>
                          <td className="px-3 py-2.5">
                            <Link href={`/fahrzeuge/${v.id}`} className="font-medium hover:underline">{v.make} {v.model}</Link>
                            <div className="text-xs text-ink-3">{FUELS[v.fuel as Fuel] ?? v.fuel}{v.year ? ` · Bj. ${v.year}` : ""}{v.color ? ` · ${v.color}` : ""}</div>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tnum">{fmtInt(v.mileage)}</td>
                          <td className={`px-3 py-2.5 font-mono tnum ${huTone(v.huDate)}`}>
                            {v.huDate ? v.huDate.toLocaleDateString("de-DE", { month: "2-digit", year: "numeric" }) : "–"}
                          </td>
                          <td className="px-3 py-2.5"><VehicleStatusChip status={v.status} /></td>
                          <td className="px-3 py-2.5 text-right font-mono tnum">{fmtEur(v.dailyRate)}</td>
                          <td className="px-3 py-2.5 text-right font-mono tnum">{v.workWeekRate ? fmtEur(v.workWeekRate) : "–"} / {v.weeklyRate ? fmtEur(v.weeklyRate) : "–"}</td>
                          <td className="px-3 py-2.5 text-right font-mono tnum">{v.monthlyRate ? fmtEur(v.monthlyRate) : "–"}</td>
                          <td className="px-3 py-2.5 text-right font-mono tnum">{fmtEur(v.deposit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))
        )}
        <div className="text-xs text-ink-3">
          {showInactive ? (
            <Link href="/fahrzeuge" className="hover:underline">Inaktive ausblenden</Link>
          ) : (
            <Link href="/fahrzeuge?inaktiv=1" className="hover:underline">Inaktive Fahrzeuge anzeigen</Link>
          )}
        </div>
      </Content>
    </>
  );
}

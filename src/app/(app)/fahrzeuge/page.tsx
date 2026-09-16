import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { FUELS, VEHICLE_CATEGORIES, type Fuel, type VehicleCategory } from "@/lib/constants";
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

  const vehicles = await db.vehicle.findMany({
    where: {
      tenantId: tenant.id,
      ...(showInactive ? {} : { status: { not: "INACTIVE" } }),
      ...(q ? { OR: [{ plate: { contains: q } }, { make: { contains: q } }, { model: { contains: q } }] } : {}),
    },
    orderBy: [{ category: "asc" }, { plate: "asc" }],
  });

  const active = vehicles.filter((v) => v.status !== "INACTIVE").length;

  return (
    <>
      <PageHeader title="Fahrzeuge" sub={`${active} aktiv`}>
        <form className="flex gap-2">
          <input name="q" defaultValue={q} placeholder="Kennzeichen, Marke, Modell" className="input !w-56 !min-h-[36px]" />
          {showInactive && <input type="hidden" name="inaktiv" value="1" />}
          <button className="btn">Suchen</button>
        </form>
        <Link href="/fahrzeuge/neu" className="btn btn-primary">+ Fahrzeug</Link>
      </PageHeader>
      <Content>
        <Card>
          {vehicles.length === 0 ? (
            <Empty action={q ? undefined : { href: "/fahrzeuge/neu", label: "Erstes Fahrzeug anlegen" }}>
              {q ? `Nichts gefunden für „${q}“.` : "Noch keine Fahrzeuge angelegt."}
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="text-left">
                    <th className="label-xs px-3 py-2 border-b border-line">Kennzeichen</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Fahrzeug</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Klasse</th>
                    <th className="label-xs px-3 py-2 border-b border-line text-right">km-Stand</th>
                    <th className="label-xs px-3 py-2 border-b border-line">HU</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Status</th>
                    <th className="label-xs px-3 py-2 border-b border-line text-right">Tag / Kaution</th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.map((v) => (
                    <tr key={v.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                      <td className="px-3 py-2.5"><Link href={`/fahrzeuge/${v.id}`}><Plate>{v.plate}</Plate></Link></td>
                      <td className="px-3 py-2.5">
                        <Link href={`/fahrzeuge/${v.id}`} className="font-medium hover:underline">{v.make} {v.model}</Link>
                        <div className="text-xs text-ink-3">{FUELS[v.fuel as Fuel] ?? v.fuel}{v.year ? ` · Bj. ${v.year}` : ""}</div>
                      </td>
                      <td className="px-3 py-2.5">{VEHICLE_CATEGORIES[v.category as VehicleCategory] ?? v.category}</td>
                      <td className="px-3 py-2.5 text-right font-mono tnum">{fmtInt(v.mileage)}</td>
                      <td className={`px-3 py-2.5 font-mono tnum ${huTone(v.huDate)}`}>
                        {v.huDate ? v.huDate.toLocaleDateString("de-DE", { month: "2-digit", year: "numeric" }) : "–"}
                      </td>
                      <td className="px-3 py-2.5"><VehicleStatusChip status={v.status} /></td>
                      <td className="px-3 py-2.5 text-right font-mono tnum">{fmtEur(v.dailyRate)} / {fmtEur(v.deposit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
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

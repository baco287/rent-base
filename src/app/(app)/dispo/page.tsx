import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtTime, toDateInput } from "@/lib/format";
import { Content, Empty, PageHeader, Plate } from "@/components/ui";

export const metadata = { title: "Dispo-Kalender" };

const DAYS = 14;
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export default async function DispoPage({ searchParams }: PageProps<"/dispo">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;

  const today = startOfDay(new Date());
  let from = today;
  if (typeof sp.ab === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.ab)) {
    const [y, m, d] = sp.ab.split("-").map(Number);
    from = startOfDay(new Date(y, m - 1, d));
  }
  const to = addDays(from, DAYS);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(from, i));

  const [vehicles, bookings] = await Promise.all([
    db.vehicle.findMany({ where: { tenantId: tenant.id, status: { not: "INACTIVE" } }, include: { group: true }, orderBy: [{ group: { sortOrder: "asc" } }, { plate: "asc" }] }),
    db.booking.findMany({
      where: { tenantId: tenant.id, status: { in: ["RESERVED", "ACTIVE"] }, startAt: { lt: to }, endAt: { gt: from } },
      include: { customer: true },
    }),
  ]);
  const byVehicle = new Map<string, typeof bookings>();
  for (const b of bookings) {
    const list = byVehicle.get(b.vehicleId) ?? [];
    list.push(b);
    byVehicle.set(b.vehicleId, list);
  }

  const now = new Date();
  const rangeMs = to.getTime() - from.getTime();
  const pct = (d: Date) => Math.min(100, Math.max(0, ((d.getTime() - from.getTime()) / rangeMs) * 100));
  const fmtRange = `${from.toLocaleDateString("de-DE", { day: "numeric", month: "long" })} bis ${addDays(to, -1).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" })}`;

  return (
    <>
      <PageHeader title="Dispo-Kalender" sub={fmtRange}>
        <Link href={`/dispo?ab=${toDateInput(addDays(from, -7))}`} className="btn">‹ Woche</Link>
        <Link href="/dispo" className="btn">Heute</Link>
        <Link href={`/dispo?ab=${toDateInput(addDays(from, 7))}`} className="btn">Woche ›</Link>
        <Link href="/buchungen/neu" className="btn btn-primary">+ Neue Buchung</Link>
      </PageHeader>
      <Content>
        <div className="flex gap-4 flex-wrap text-xs text-ink-2">
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 bg-info-soft border border-info" />Reserviert</span>
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 bg-brand" />Unterwegs</span>
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 bg-bad-soft border border-bad" />Rückgabe überfällig</span>
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 bg-panel-2 border border-line" style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, var(--line) 3px 6px)" }} />Werkstatt / gesperrt</span>
        </div>

        {vehicles.length === 0 ? (
          <div className="card"><Empty action={{ href: "/fahrzeuge/neu", label: "Erstes Fahrzeug anlegen" }}>Der Kalender zeigt Fahrzeuge als Zeilen. Noch sind keine angelegt.</Empty></div>
        ) : (
          <div className="card overflow-x-auto">
            <div className="grid text-xs min-w-[1000px]" style={{ gridTemplateColumns: `200px repeat(${DAYS}, minmax(58px, 1fr))` }}>
              <div className="sticky left-0 z-10 bg-panel-2 px-2.5 py-2 border-b border-line label-xs self-end">Fahrzeug</div>
              {days.map((d) => {
                const isToday = d.getTime() === today.getTime();
                const we = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <Link
                    key={d.toISOString()}
                    href={`/buchungen/neu?tag=${toDateInput(d)}`}
                    title="Buchung an diesem Tag anlegen"
                    className={`px-1 py-1.5 text-center border-b border-l border-line-soft font-semibold ${isToday ? "bg-amber-soft text-amber" : we ? "bg-bg text-ink-3" : "bg-panel-2 text-ink-3"} hover:underline`}
                  >
                    {WD[d.getDay()]}
                    <b className={`block font-mono text-[13px] ${isToday ? "text-amber" : "text-ink"}`}>{d.getDate()}.</b>
                  </Link>
                );
              })}

              {vehicles.map((v, i) => {
                const list = byVehicle.get(v.id) ?? [];
                const blocked = v.status === "WORKSHOP" || v.status === "BLOCKED";
                const groupName = v.group?.name ?? "Ohne Gruppe";
                const newGroup = i === 0 || (vehicles[i - 1].group?.name ?? "Ohne Gruppe") !== groupName;
                return (
                  <div key={v.id} className="contents">
                    {newGroup && (
                      <div className="col-span-full sticky left-0 bg-panel-2 px-2.5 py-1 border-b border-line label-xs !text-ink-2">
                        {groupName}
                      </div>
                    )}
                    <div className="sticky left-0 z-10 bg-panel px-2.5 py-2 border-b border-line-soft flex flex-col gap-0.5 justify-center">
                      <Link href={`/fahrzeuge/${v.id}`}><Plate>{v.plate}</Plate></Link>
                      <small className="text-ink-3 truncate">{v.make} {v.model}</small>
                    </div>
                    <div className="relative border-b border-line-soft h-12" style={{ gridColumn: `2 / span ${DAYS}` }}>
                      <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, minmax(58px, 1fr))` }}>
                        {days.map((d) => (
                          <div key={d.toISOString()} className={`border-l border-line-soft ${d.getTime() === today.getTime() ? "bg-amber/8" : ""}`} />
                        ))}
                      </div>
                      {blocked && (
                        <div className="absolute inset-y-2 left-0.5 right-0.5 rounded-md border border-line text-ink-2 flex items-center px-2 font-medium" style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--panel-2) 0 6px, var(--line-soft) 6px 12px)" }}>
                          {v.status === "WORKSHOP" ? "Werkstatt" : "Gesperrt"}
                        </div>
                      )}
                      {list.map((b) => {
                        const left = pct(b.startAt);
                        const right = pct(b.endAt);
                        const overdue = b.status === "ACTIVE" && b.endAt < now;
                        const cls = overdue
                          ? "bg-bad-soft text-bad border-bad/50"
                          : b.status === "ACTIVE"
                            ? "bg-brand text-brand-ink border-transparent"
                            : "bg-info-soft text-info border-info/40";
                        return (
                          <Link
                            key={b.id}
                            href={`/buchungen/${b.id}`}
                            title={`${b.number} · ${customerName(b.customer)} · ${fmtTime(b.startAt)} bis ${fmtTime(b.endAt)}`}
                            className={`absolute top-2 h-8 rounded-md border px-2 flex items-center gap-2 font-medium whitespace-nowrap overflow-hidden text-[12px] ${cls}`}
                            style={{ left: `calc(${left}% + 2px)`, width: `calc(${Math.max(right - left, 1.5)}% - 4px)` }}
                          >
                            {customerName(b.customer)}
                            <small className="opacity-80 font-normal">{fmtTime(b.startAt)}</small>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <p className="text-xs text-ink-3 max-w-[70ch]">Klick auf einen Balken öffnet die Buchung, Klick auf einen Tag legt eine neue Buchung an diesem Tag an. Doppelbelegungen werden beim Speichern abgelehnt.</p>
      </Content>
    </>
  );
}

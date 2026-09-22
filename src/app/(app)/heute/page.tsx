import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDate, fmtTime } from "@/lib/format";
import { Card, Chip, Content, KPI, PageHeader, Plate } from "@/components/ui";
import { openDepositCounts } from "@/lib/deposits";
import { fmtCents } from "@/lib/money";
import { paymentSummaries } from "@/lib/payments";

export const metadata = { title: "Heute" };

export default async function TodayPage({ searchParams }: PageProps<"/heute">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;

  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const weekEnd = new Date(start); weekEnd.setDate(weekEnd.getDate() + 7);
  const in30 = new Date(start); in30.setDate(in30.getDate() + 30);

  const [pickups, returns, overdue, activeCount, vehicles, huSoon, noLicense] = await Promise.all([
    db.booking.findMany({ where: { tenantId: tenant.id, status: "RESERVED", startAt: { gte: start, lt: end } }, include: { vehicle: true, customer: true }, orderBy: { startAt: "asc" } }),
    db.booking.findMany({ where: { tenantId: tenant.id, status: "ACTIVE", endAt: { gte: start, lt: end } }, include: { vehicle: true, customer: true }, orderBy: { endAt: "asc" } }),
    db.booking.findMany({ where: { tenantId: tenant.id, status: "ACTIVE", endAt: { lt: start } }, include: { vehicle: true, customer: true }, orderBy: { endAt: "asc" } }),
    db.booking.count({ where: { tenantId: tenant.id, status: "ACTIVE" } }),
    db.vehicle.findMany({ where: { tenantId: tenant.id, status: { not: "INACTIVE" } }, select: { id: true, status: true } }),
    db.vehicle.findMany({ where: { tenantId: tenant.id, status: { not: "INACTIVE" }, huDate: { lt: in30 } }, orderBy: { huDate: "asc" } }),
    db.booking.findMany({ where: { tenantId: tenant.id, status: "RESERVED", startAt: { gte: start, lt: weekEnd }, customer: { licenseNumber: null } }, include: { customer: true, vehicle: true }, orderBy: { startAt: "asc" } }),
  ]);

  // Auslastung: belegte Fahrzeugtage / verfügbare Fahrzeugtage in den nächsten 7 Tagen
  const weekBookings = await db.booking.findMany({
    where: { tenantId: tenant.id, status: { in: ["RESERVED", "ACTIVE"] }, startAt: { lt: weekEnd }, endAt: { gt: start } },
    select: { startAt: true, endAt: true },
  });
  const weekMs = weekEnd.getTime() - start.getTime();
  const bookedMs = weekBookings.reduce((sum, b) => sum + (Math.min(b.endAt.getTime(), weekEnd.getTime()) - Math.max(b.startAt.getTime(), start.getTime())), 0);
  const fleet = vehicles.filter((v) => v.status === "AVAILABLE").length || vehicles.length;
  const utilization = fleet ? Math.round((bookedMs / (weekMs * fleet)) * 100) : 0;

  // Operative Geldübersicht (keine Buchhaltung): offene Rechnungen, heute erfasste Zahlungen, offene Kautionen
  const [finalInvoices, todayPayments, deposits] = await Promise.all([
    db.invoice.findMany({ where: { tenantId: tenant.id, status: "FINALIZED", currentVersionId: { not: null } }, select: { id: true, currentVersion: { select: { grossTotal: true } } } }).then((rows) => rows.map((r) => ({ id: r.id, grossTotal: r.currentVersion!.grossTotal }))),
    db.payment.aggregate({ where: { tenantId: tenant.id, status: "CONFIRMED", createdAt: { gte: start, lt: end } }, _sum: { amountCents: true }, _count: true }),
    openDepositCounts(tenant.id),
  ]);
  const sums = await paymentSummaries(tenant.id, finalInvoices);
  const openInvoices = [...sums.values()].filter((x) => x.status === "OPEN" || x.status === "PARTIAL");
  const openInvoiceCents = openInvoices.reduce((a, x) => a + x.openCents, 0);
  const overpaid = [...sums.values()].filter((x) => x.status === "OVERPAID");
  const overpaidCents = overpaid.reduce((a, x) => a + x.overpaidCents, 0);

  const events = [
    ...pickups.map((b) => ({ at: b.startAt, kind: "Abholung", b })),
    ...returns.map((b) => ({ at: b.endAt, kind: "Rückgabe", b })),
  ].sort((a, z) => a.at.getTime() - z.at.getTime());

  const kw = (() => {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - y0.getTime()) / 86400000 + 1) / 7);
  })();

  return (
    <>
      <PageHeader title={now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })} sub={`KW ${kw}`}>
        <Link href="/dispo" className="btn">Kalender</Link>
        <Link href="/buchungen/neu" className="btn btn-primary">+ Neue Buchung</Link>
      </PageHeader>
      <Content>
        {sp.fehler === "rechte" && <Chip tone="bad">Dafür fehlen deiner Rolle die Rechte.</Chip>}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPI label="Abholungen heute" value={pickups.length} detail={pickups[0] ? `nächste um ${fmtTime(pickups[0].startAt)}` : "keine"} hot={pickups.length > 0} />
          <KPI label="Rückgaben heute" value={returns.length} detail={overdue.length ? `${overdue.length} überfällig` : "keine überfällig"} />
          <KPI label="Auslastung 7 Tage" value={`${utilization} %`} detail={`${activeCount} von ${vehicles.length} Fahrzeugen unterwegs`} />
          <KPI label="Flotte" value={vehicles.length} detail={`${vehicles.filter((v) => v.status === "WORKSHOP").length} in Werkstatt`} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPI label="Offene Rechnungen" value={openInvoices.length} detail={<Link href="/rechnungen?filter=offen" className="underline">zur Rechnungsliste</Link>} hot={openInvoices.length > 0} />
          <KPI label="Offener Rechnungsbetrag" value={<span className="text-2xl">{fmtCents(openInvoiceCents)}</span>} detail="aus abgeschlossenen Rechnungen" />
          <KPI label="Zahlungen heute" value={todayPayments._count} detail={fmtCents(todayPayments._sum.amountCents ?? 0)} />
          <KPI label="Offene Kautionen" value={deposits.held} detail={`nach Rückgabe noch nicht entschieden · ${deposits.expectedActive} unterwegs ohne Eingang`} />
        </div>
        {overpaid.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KPI label="Erstattungen zu klären" value={overpaid.length} detail={<Link href="/rechnungen?filter=ueberzahlt" className="underline">{fmtCents(overpaidCents)} überzahlt – keine automatische Erstattung</Link>} hot />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card title="Heute auf dem Hof" right={<Chip>{events.length} Termine</Chip>}>
            {events.length === 0 ? (
              <p className="p-4 text-ink-3 text-sm">Heute keine Abholungen oder Rückgaben.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {events.map(({ at, kind, b }) => (
                  <li key={kind + b.id} className="px-4 py-2.5 grid grid-cols-[52px_1fr_auto] gap-3 items-center">
                    <span className="font-mono tnum font-medium text-ink-2">{fmtTime(at)}</span>
                    <div className="min-w-0">
                      <Link href={`/buchungen/${b.id}`} className="font-medium hover:underline">{kind} · {customerName(b.customer)}</Link>
                      <div className="text-xs text-ink-3 truncate">{b.vehicle.make} {b.vehicle.model} · Nr. {b.number}{!b.customer.licenseNumber ? " · Führerschein fehlt" : ""}</div>
                    </div>
                    <Plate>{b.vehicle.plate}</Plate>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Braucht Aufmerksamkeit">
            {overdue.length + huSoon.length + noLicense.length === 0 ? (
              <p className="p-4 text-ink-3 text-sm">Nichts offen. Guter Tag.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {overdue.map((b) => (
                  <li key={b.id} className="px-4 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <Link href={`/buchungen/${b.id}`} className="font-medium hover:underline">Rückgabe überfällig · {customerName(b.customer)}</Link>
                      <div className="text-xs text-ink-3">{b.vehicle.plate} · sollte {fmtDate(b.endAt)} um {fmtTime(b.endAt)} zurück sein</div>
                    </div>
                    <Chip tone="bad">Überfällig</Chip>
                  </li>
                ))}
                {huSoon.map((v) => {
                  const past = v.huDate! < now;
                  return (
                    <li key={v.id} className="px-4 py-2.5 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <Link href={`/fahrzeuge/${v.id}`} className="font-medium hover:underline">HU {past ? "überfällig" : "fällig"} · {v.plate}</Link>
                        <div className="text-xs text-ink-3">{v.make} {v.model} · TÜV bis {fmtDate(v.huDate)}</div>
                      </div>
                      <Chip tone={past ? "bad" : "amber"}>{past ? "Überfällig" : "Termin machen"}</Chip>
                    </li>
                  );
                })}
                {noLicense.map((b) => (
                  <li key={b.id} className="px-4 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <Link href={`/kunden/${b.customerId}`} className="font-medium hover:underline">Führerschein fehlt · {customerName(b.customer)}</Link>
                      <div className="text-xs text-ink-3">Abholung {fmtDate(b.startAt)} · {b.vehicle.plate}</div>
                    </div>
                    <Chip tone="amber">Vor Abholung erfassen</Chip>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Content>
    </>
  );
}

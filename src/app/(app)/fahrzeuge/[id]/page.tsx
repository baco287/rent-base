import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtInt, toDateInput } from "@/lib/format";
import { BookingStatusChip, Card, Chip, Content, PageHeader, Plate, VehicleStatusChip } from "@/components/ui";
import { VEHICLE_EVENT_TYPES, type VehicleEventType } from "@/lib/constants";
import { vehicleMaintenanceOverview } from "@/lib/maintenance";
import { listVehicleEvents } from "@/lib/vehicle-events";
import { deleteVehicleAction, updateVehicleAction } from "../actions";
import { loadGroupOptions } from "../groups";
import { VehicleForm } from "../vehicle-form";
import { VehicleFile } from "./vehicle-file";
import { CostsCard, DocumentsSection, DueSection, DueSummary, MaintenanceSection } from "./vehicle-maintenance";

const TABS = [
  { key: "uebersicht", label: "Übersicht" },
  { key: "vermietungen", label: "Vermietungen" },
  { key: "kilometer", label: "Kilometer" },
  { key: "schaeden", label: "Schäden" },
  { key: "wartung", label: "Wartung & Werkstatt" },
  { key: "faelligkeiten", label: "Fälligkeiten" },
  { key: "dokumente", label: "Dokumente" },
  { key: "historie", label: "Historie" },
  { key: "stammdaten", label: "Stammdaten" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** Digitale Fahrzeugakte: Bereiche als Reiter (?tab=…), keine gigantische Einzelseite. */
export default async function VehiclePage({ params, searchParams }: PageProps<"/fahrzeuge/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "uebersicht") as Tab;

  const vehicle = await db.vehicle.findFirst({
    where: { id, tenantId: tenant.id },
    include: { bookings: { include: { customer: true }, orderBy: { startAt: "desc" }, take: tab === "vermietungen" ? 100 : 5 } },
  });
  if (!vehicle) notFound();
  const canManage = user.role !== "YARD";
  const overview = await vehicleMaintenanceOverview(tenant.id, vehicle.id);
  const groups = tab === "stammdaten" ? await loadGroupOptions(tenant.id) : [];
  const events = tab === "historie" || tab === "kilometer" ? await listVehicleEvents(db, tenant.id, vehicle.id, 200) : [];

  const values = {
    plate: vehicle.plate, make: vehicle.make, model: vehicle.model, groupId: vehicle.groupId ?? "", fuel: vehicle.fuel, status: vehicle.status,
    year: vehicle.year?.toString() ?? "", vin: vehicle.vin ?? "", color: vehicle.color ?? "", mileage: vehicle.mileage.toString(), huDate: toDateInput(vehicle.huDate),
    dailyRate: vehicle.dailyRate.toString().replace(".", ","), workWeekRate: vehicle.workWeekRate?.toString().replace(".", ",") ?? "", weeklyRate: vehicle.weeklyRate?.toString().replace(".", ",") ?? "", monthlyRate: vehicle.monthlyRate?.toString().replace(".", ",") ?? "",
    kmIncludedPerDay: vehicle.kmIncludedPerDay.toString(), extraKmRate: vehicle.extraKmRate.toString().replace(".", ","), deposit: vehicle.deposit.toString().replace(".", ","), notes: vehicle.notes ?? "",
  };
  const update = updateVehicleAction.bind(null, vehicle.id);
  const remove = deleteVehicleAction.bind(null, vehicle.id);
  const urgent = overview.plans.filter((p) => p.isActive && (p.due.level === "OVERDUE" || p.due.level === "DUE" || p.due.level === "SOON"));
  const href = (t: Tab) => `/fahrzeuge/${vehicle.id}${t === "uebersicht" ? "" : `?tab=${t}`}`;

  return (
    <>
      <PageHeader title={`${vehicle.make} ${vehicle.model}`} sub={<><Plate>{vehicle.plate}</Plate> · {fmtInt(vehicle.mileage)} km{vehicle.year ? ` · ${vehicle.year}` : ""}</>}>
        <VehicleStatusChip status={vehicle.status} />
        {urgent.length > 0 && <Chip tone={urgent.some((p) => p.due.level !== "SOON") ? "bad" : "amber"}>{urgent.length} {urgent.length === 1 ? "Fälligkeit" : "Fälligkeiten"}</Chip>}
        {overview.open.length > 0 && <Chip tone="info">{overview.open.length} Werkstatt offen</Chip>}
        {canManage && <Link href={`/fahrzeuge/wartung/neu?fahrzeug=${vehicle.id}`} className="btn">Wartung / Werkstatt</Link>}
        <Link href={`/buchungen/neu?fahrzeug=${vehicle.id}`} className="btn btn-primary">+ Buchung</Link>
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <Chip tone="good">Gespeichert</Chip>}
        <nav aria-label="Bereiche der Fahrzeugakte" className="flex gap-1.5 overflow-x-auto pb-0.5">
          {TABS.map((t) => <Link key={t.key} href={href(t.key)} aria-current={t.key === tab ? "page" : undefined} className={`btn !py-1.5 shrink-0 ${t.key === tab ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{t.label}</Link>)}
        </nav>

        {tab === "uebersicht" && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
            <Card title="Fahrzeug">
              <dl className="p-4 grid grid-cols-[150px_1fr] gap-y-1.5 text-sm">
                <dt className="label-xs self-center">Kennzeichen</dt><dd><Plate>{vehicle.plate}</Plate></dd>
                <dt className="label-xs self-center">Fahrzeug</dt><dd>{vehicle.make} {vehicle.model}{vehicle.color ? ` · ${vehicle.color}` : ""}{vehicle.year ? ` · ${vehicle.year}` : ""}</dd>
                <dt className="label-xs self-center">FIN</dt><dd className="font-mono tnum">{vehicle.vin ?? "–"}</dd>
                <dt className="label-xs self-center">Kilometerstand</dt><dd>{fmtInt(vehicle.mileage)} km</dd>
                <dt className="label-xs self-center">Status</dt><dd><VehicleStatusChip status={vehicle.status} /></dd>
                <dt className="label-xs self-center">Nächste HU</dt><dd>{overview.hu.next ? <>{toDateInput(overview.hu.next).split("-").reverse().join(".")} {overview.hu.due && <Chip tone={overview.hu.due.level === "OK" ? "good" : overview.hu.due.level === "SOON" ? "amber" : "bad"}>{overview.hu.due.text}</Chip>}</> : "–"}</dd>
              </dl>
              <div className="px-4 pb-3"><Link href={href("stammdaten")} className="text-xs underline">Stammdaten bearbeiten</Link></div>
            </Card>
            <DueSummary o={overview} vehicleId={vehicle.id} />
            <Card title="Offene Werkstattvorgänge" right={<Link href={href("wartung")} className="text-xs underline">alle</Link>}>
              {overview.open.length === 0 ? <p className="p-4 text-sm text-ink-3">Keine offenen Vorgänge.</p> : (
                <ul className="divide-y divide-line-soft text-sm">{overview.open.slice(0, 5).map((r) => <li key={r.id} className="px-4 py-2 flex flex-wrap items-center gap-2"><Link href={`/fahrzeuge/wartung/${r.id}`} className="font-medium hover:underline">{r.title}</Link><span className="text-xs text-ink-3">{r.scheduledAt ? fmtDateTime(r.scheduledAt) : r.maintenanceNumber}</span></li>)}</ul>
              )}
            </Card>
            <Card title="Letzte Buchungen" right={<Link href={href("vermietungen")} className="text-xs underline">alle</Link>}>
              {vehicle.bookings.length === 0 ? <p className="p-4 text-ink-3 text-sm">Noch keine Buchungen.</p> : (
                <ul className="divide-y divide-line-soft">{vehicle.bookings.map((b) => <li key={b.id} className="px-4 py-2.5 flex items-center gap-3"><div className="flex-1 min-w-0"><Link href={`/buchungen/${b.id}`} className="font-medium hover:underline">{customerName(b.customer)}</Link><div className="text-xs text-ink-3 font-mono tnum">{fmtDateTime(b.startAt)} bis {fmtDateTime(b.endAt)}</div></div><BookingStatusChip status={b.status} /></li>)}</ul>
              )}
            </Card>
          </div>
        )}

        {tab === "vermietungen" && (
          <Card title="Vermietungen" right={<Chip>{vehicle.bookings.length}</Chip>}>
            {vehicle.bookings.length === 0 ? <p className="p-4 text-ink-3 text-sm">Noch keine Buchungen.</p> : (
              <ul className="divide-y divide-line-soft">{vehicle.bookings.map((b) => <li key={b.id} className="px-4 py-2.5 flex items-center gap-3"><div className="flex-1 min-w-0"><Link href={`/buchungen/${b.id}`} className="font-medium hover:underline">{b.number} · {customerName(b.customer)}</Link><div className="text-xs text-ink-3 font-mono tnum">{fmtDateTime(b.startAt)} bis {fmtDateTime(b.endAt)}</div></div><BookingStatusChip status={b.status} /></li>)}</ul>
            )}
          </Card>
        )}

        {tab === "kilometer" && (
          <Card title="Kilometerstände" right={<Chip>{fmtInt(vehicle.mileage)} km aktuell</Chip>}>
            {events.filter((e) => e.mileage != null).length === 0 ? <p className="p-4 text-sm text-ink-3">Noch keine Kilometerstände dokumentiert.</p> : (
              <ul className="divide-y divide-line-soft text-sm">{events.filter((e) => e.mileage != null).map((e) => <li key={e.id} className="px-4 py-2 flex flex-wrap items-baseline gap-x-3"><span className="font-mono tnum text-xs text-ink-3 w-[11ch]">{fmtDateTime(e.occurredAt)}</span><span className="font-mono tnum font-medium">{fmtInt(e.mileage)} km</span><span className="text-ink-2">{VEHICLE_EVENT_TYPES[e.type as VehicleEventType] ?? e.type}{e.description ? ` · ${e.description}` : ""}</span>{e.bookingId && <Link href={`/buchungen/${e.bookingId}`} className="text-xs underline text-ink-3">Buchung</Link>}</li>)}</ul>
            )}
            <p className="px-4 pb-3 text-xs text-ink-3">Kilometerstände werden nur fortgeschrieben, nie zurückgedreht. Niedrigere Servicestände bleiben historische Werte am Vorgang.</p>
          </Card>
        )}

        {tab === "schaeden" && <VehicleFile tenantId={tenant.id} vehicleId={vehicle.id} damagesOnly />}
        {tab === "wartung" && <MaintenanceSection o={overview} vehicleId={vehicle.id} canManage={canManage} />}
        {tab === "faelligkeiten" && <DueSection o={overview} vehicleId={vehicle.id} canManage={canManage} />}
        {tab === "dokumente" && <DocumentsSection o={overview} vehicleId={vehicle.id} canManage={canManage} isOwner={user.role === "OWNER"} />}
        {tab === "historie" && (
          <div className="flex flex-col gap-4">
            <Card title="Historie" right={<Chip>{events.length}</Chip>}>
              {events.length === 0 ? <p className="p-4 text-ink-3 text-sm">Noch keine Einträge.</p> : (
                <ul className="divide-y divide-line-soft text-sm">{events.filter((e) => e.type !== "MILEAGE").map((e) => <li key={e.id} className="px-4 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5"><span className="font-mono tnum text-xs text-ink-3 w-[11ch]">{fmtDateTime(e.occurredAt)}</span><span className="font-medium">{VEHICLE_EVENT_TYPES[e.type as VehicleEventType] ?? e.type}</span>{e.mileage != null && <span className="font-mono tnum">{fmtInt(e.mileage)} km</span>}{e.description && <span className="text-ink-2 flex-1 min-w-[12ch]">{e.description}</span>}{e.bookingId && <Link href={`/buchungen/${e.bookingId}`} className="text-xs underline text-ink-3">Buchung</Link>}{e.userName && <span className="text-xs text-ink-3">{e.userName}</span>}</li>)}</ul>
              )}
            </Card>
            <CostsCard o={overview} />
          </div>
        )}

        {tab === "stammdaten" && (
          <Card className="p-5 max-w-4xl">
            <VehicleForm action={update} values={values} groups={groups} submitLabel="Speichern" cancelHref={`/fahrzeuge/${vehicle.id}`} />
            <p className="text-xs text-ink-3 mt-3">Das HU-Datum hier und ein HU/AU-Wartungsplan unter „Fälligkeiten“ bleiben synchron. Fahrzeugstatus „Werkstatt“ und „Gesperrt“ sind nicht buchbar.</p>
            {user.role === "OWNER" && (
              <form action={remove} className="mt-6 pt-4 border-t border-line-soft">
                <button type="submit" className="btn btn-danger">{vehicle.bookings.length > 0 ? "Fahrzeug inaktiv setzen" : "Fahrzeug löschen"}</button>
                <span className="text-xs text-ink-3 ml-3">{vehicle.bookings.length > 0 ? "Hat Buchungen, wird deshalb nicht gelöscht, nur ausgeblendet." : "Endgültig, nur ohne Buchungen möglich."}</span>
              </form>
            )}
          </Card>
        )}
      </Content>
    </>
  );
}

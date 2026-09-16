import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, toDateInput } from "@/lib/format";
import { BookingStatusChip, Card, Chip, Content, PageHeader, Plate, VehicleStatusChip } from "@/components/ui";
import { deleteVehicleAction, updateVehicleAction } from "../actions";
import { loadGroupOptions } from "../groups";
import { VehicleForm } from "../vehicle-form";

export default async function VehiclePage({ params, searchParams }: PageProps<"/fahrzeuge/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  const vehicle = await db.vehicle.findFirst({
    where: { id, tenantId: tenant.id },
    include: {
      bookings: { include: { customer: true }, orderBy: { startAt: "desc" }, take: 10 },
    },
  });
  if (!vehicle) notFound();
  const groups = await loadGroupOptions(tenant.id);

  const values = {
    plate: vehicle.plate,
    make: vehicle.make,
    model: vehicle.model,
    groupId: vehicle.groupId ?? "",
    fuel: vehicle.fuel,
    status: vehicle.status,
    year: vehicle.year?.toString() ?? "",
    vin: vehicle.vin ?? "",
    color: vehicle.color ?? "",
    mileage: vehicle.mileage.toString(),
    huDate: toDateInput(vehicle.huDate),
    dailyRate: vehicle.dailyRate.toString().replace(".", ","),
    weeklyRate: vehicle.weeklyRate?.toString().replace(".", ",") ?? "",
    monthlyRate: vehicle.monthlyRate?.toString().replace(".", ",") ?? "",
    kmIncludedPerDay: vehicle.kmIncludedPerDay.toString(),
    extraKmRate: vehicle.extraKmRate.toString().replace(".", ","),
    deposit: vehicle.deposit.toString().replace(".", ","),
    notes: vehicle.notes ?? "",
  };

  const update = updateVehicleAction.bind(null, vehicle.id);
  const remove = deleteVehicleAction.bind(null, vehicle.id);

  return (
    <>
      <PageHeader title={`${vehicle.make} ${vehicle.model}`} sub={<Plate>{vehicle.plate}</Plate>}>
        <VehicleStatusChip status={vehicle.status} />
        <Link href={`/buchungen/neu?fahrzeug=${vehicle.id}`} className="btn btn-primary">+ Buchung</Link>
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <Chip tone="good">Gespeichert</Chip>}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
          <Card className="p-5">
            <VehicleForm action={update} values={values} groups={groups} submitLabel="Speichern" cancelHref="/fahrzeuge" />
            {user.role === "OWNER" && (
              <form action={remove} className="mt-6 pt-4 border-t border-line-soft">
                <button type="submit" className="btn btn-danger">
                  {vehicle.bookings.length > 0 ? "Fahrzeug inaktiv setzen" : "Fahrzeug löschen"}
                </button>
                <span className="text-xs text-ink-3 ml-3">
                  {vehicle.bookings.length > 0 ? "Hat Buchungen, wird deshalb nicht gelöscht, nur ausgeblendet." : "Endgültig, nur ohne Buchungen möglich."}
                </span>
              </form>
            )}
          </Card>
          <Card title="Letzte Buchungen">
            {vehicle.bookings.length === 0 ? (
              <p className="p-4 text-ink-3 text-sm">Noch keine Buchungen.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {vehicle.bookings.map((b) => (
                  <li key={b.id} className="px-4 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <Link href={`/buchungen/${b.id}`} className="font-medium hover:underline">{customerName(b.customer)}</Link>
                      <div className="text-xs text-ink-3 font-mono tnum">{fmtDateTime(b.startAt)} bis {fmtDateTime(b.endAt)}</div>
                    </div>
                    <BookingStatusChip status={b.status} />
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

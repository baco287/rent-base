import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtEur, rentalDays, toDateTimeInput } from "@/lib/format";
import { BookingStatusChip, Card, Chip, Content, PageHeader, Plate } from "@/components/ui";
import { setBookingStatusAction, updateBookingAction } from "../actions";
import { BookingForm } from "../booking-form";
import { loadBookingOptions } from "../options";

export default async function BookingPage({ params, searchParams }: PageProps<"/buchungen/[id]">) {
  const { tenant } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  const b = await db.booking.findFirst({ where: { id, tenantId: tenant.id }, include: { vehicle: true, customer: true } });
  if (!b) notFound();

  const editable = b.status === "RESERVED" || b.status === "ACTIVE";
  const { vehicles, customers } = editable ? await loadBookingOptions(tenant.id) : { vehicles: [], customers: [] };
  const d = rentalDays(b.startAt, b.endAt);
  const gross = d * Number(b.dailyRate);
  const total = gross * (1 - b.customer.discountPercent / 100);
  const overdue = b.status === "ACTIVE" && b.endAt < new Date();

  const update = updateBookingAction.bind(null, b.id);
  const activate = setBookingStatusAction.bind(null, b.id, "ACTIVE");
  const finish = setBookingStatusAction.bind(null, b.id, "RETURNED");
  const cancel = setBookingStatusAction.bind(null, b.id, "CANCELLED");

  return (
    <>
      <PageHeader title={`Buchung ${b.number}`} sub={<Plate>{b.vehicle.plate}</Plate>}>
        {overdue ? <Chip tone="bad">Rückgabe überfällig</Chip> : <BookingStatusChip status={b.status} />}
        {b.status === "RESERVED" && (
          <form action={activate}><button className="btn btn-primary">Fahrzeug übergeben</button></form>
        )}
        {b.status === "ACTIVE" && (
          <form action={finish}><button className="btn btn-primary">Fahrzeug zurücknehmen</button></form>
        )}
        {b.status === "RESERVED" && (
          <form action={cancel}><button className="btn btn-danger">Stornieren</button></form>
        )}
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <Chip tone="good">Gespeichert</Chip>}
        {sp.fehler === "status" && <Chip tone="bad">Dieser Statuswechsel ist nicht möglich.</Chip>}

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4 items-start">
          <Card className="p-5">
            {editable ? (
              <BookingForm
                action={update}
                values={{
                  vehicleId: b.vehicleId,
                  customerId: b.customerId,
                  startAt: toDateTimeInput(b.startAt),
                  endAt: toDateTimeInput(b.endAt),
                  dailyRate: b.dailyRate.toString().replace(".", ","),
                  deposit: b.deposit.toString().replace(".", ","),
                  notes: b.notes ?? "",
                }}
                vehicles={vehicles}
                customers={customers}
                submitLabel="Änderungen speichern"
                cancelHref="/buchungen"
              />
            ) : (
              <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
                <dt className="label-xs self-center">Kunde</dt><dd><Link href={`/kunden/${b.customerId}`} className="hover:underline font-medium">{customerName(b.customer)}</Link></dd>
                <dt className="label-xs self-center">Fahrzeug</dt><dd><Link href={`/fahrzeuge/${b.vehicleId}`} className="hover:underline">{b.vehicle.make} {b.vehicle.model}</Link></dd>
                <dt className="label-xs self-center">Abholung</dt><dd className="font-mono tnum">{fmtDateTime(b.startAt)}</dd>
                <dt className="label-xs self-center">Rückgabe</dt><dd className="font-mono tnum">{fmtDateTime(b.endAt)}</dd>
                <dt className="label-xs self-center">Notizen</dt><dd>{b.notes || "–"}</dd>
              </dl>
            )}
          </Card>

          <div className="flex flex-col gap-4">
            <Card title="Kosten">
              <div className="p-4 text-sm flex flex-col">
                <div className="flex justify-between py-1.5 border-b border-line-soft"><span>{d} Tage × {fmtEur(b.dailyRate)}</span><span className="font-mono tnum">{fmtEur(gross)}</span></div>
                {b.customer.discountPercent > 0 && (
                  <div className="flex justify-between py-1.5 border-b border-line-soft"><span>Rabatt {b.customer.discountPercent} %</span><span className="font-mono tnum">−{fmtEur(gross - total)}</span></div>
                )}
                <div className="flex justify-between py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>Voraussichtlich</span><span className="font-mono tnum">{fmtEur(total)}</span></div>
                <div className="flex justify-between py-1.5 text-ink-3"><span>zzgl. Kaution</span><span className="font-mono tnum">{fmtEur(b.deposit)}</span></div>
                <p className="text-xs text-ink-3 mt-2">Mehrkilometer, Tank und Schäden werden bei der Rücknahme berechnet (Etappe 2).</p>
              </div>
            </Card>
            <Card title="Kunde">
              <div className="p-4 text-sm flex flex-col gap-1">
                <Link href={`/kunden/${b.customerId}`} className="font-medium hover:underline">{customerName(b.customer)}</Link>
                {b.customer.phone && <span>{b.customer.phone}</span>}
                {b.customer.email && <span className="text-ink-3">{b.customer.email}</span>}
                {!b.customer.licenseNumber && <Chip tone="amber">Führerschein noch nicht erfasst</Chip>}
                {b.customer.licenseValidUntil && b.customer.licenseValidUntil < b.endAt && <Chip tone="bad">Führerschein läuft vor Rückgabe ab</Chip>}
              </div>
            </Card>
          </div>
        </div>
      </Content>
    </>
  );
}

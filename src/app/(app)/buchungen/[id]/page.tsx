import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtEur, toDateTimeInput } from "@/lib/format";
import { calculateRentalPrice, rateCardFrom } from "@/lib/pricing";
import { BookingStageChip, Card, Chip, Content, PageHeader, Plate } from "@/components/ui";
import { bookingStage } from "@/lib/booking-status";
import { startContractAction } from "./vertrag/actions";
import { setBookingStatusAction, updateBookingAction } from "../actions";
import { BookingForm } from "../booking-form";
import { loadBookingOptions } from "../options";

export default async function BookingPage({ params, searchParams }: PageProps<"/buchungen/[id]">) {
  const { tenant } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  const b = await db.booking.findFirst({ where: { id, tenantId: tenant.id }, include: { vehicle: true, customer: true, contract: { select: { number: true, status: true } }, handovers: { where: { type: "PICKUP", correctsId: null }, select: { number: true, status: true } } } });
  if (!b) notFound();

  // Mit unterschriebenem Vertrag sind Zeitraum, Fahrzeug und Preis festgeschrieben
  const editable = (b.status === "RESERVED" || b.status === "ACTIVE") && b.contract?.status !== "SIGNED";
  const { vehicles, customers } = editable ? await loadBookingOptions(tenant.id) : { vehicles: [], customers: [] };
  const price = calculateRentalPrice({ start: b.startAt, end: b.endAt, rates: rateCardFrom(b), discountPercent: b.customer.discountPercent });
  const overdue = b.status === "ACTIVE" && b.endAt < new Date();

  const stage = bookingStage(b, b.contract);
  const contractSigned = b.contract?.status === "SIGNED";
  const pickupDraft = b.handovers.find((h) => h.status === "DRAFT");
  const pickupDone = b.handovers.find((h) => h.status === "FINALIZED");
  const update = updateBookingAction.bind(null, b.id);
  const startContract = startContractAction.bind(null, b.id);
  const finish = setBookingStatusAction.bind(null, b.id, "RETURNED");
  const cancel = setBookingStatusAction.bind(null, b.id, "CANCELLED");

  return (
    <>
      <PageHeader title={`Buchung ${b.number}`} sub={<Plate>{b.vehicle.plate}</Plate>}>
        {overdue ? <Chip tone="bad">Rückgabe überfällig</Chip> : <BookingStageChip stage={stage} />}
        {stage === "NEEDS_CONTRACT" && <form action={startContract}><button className="btn btn-primary">Mietvertrag erstellen</button></form>}
        {stage === "CONTRACT_DRAFT" && <Link href={`/buchungen/${b.id}/vertrag`} className="btn btn-primary">Mietvertrag fortsetzen</Link>}
        {b.contract && b.contract.status !== "DRAFT" && <Link href={`/buchungen/${b.id}/vertrag`} className="btn">Mietvertrag anzeigen</Link>}
        {stage === "READY_FOR_PICKUP" && <Link href={`/buchungen/${b.id}/uebergabe`} className="btn btn-primary">{pickupDraft ? "Übergabe fortsetzen" : "Übergabe starten"}</Link>}
        {pickupDone && <Link href={`/buchungen/${b.id}/uebergabe`} className="btn">Übergabeprotokoll anzeigen</Link>}
        {b.status === "ACTIVE" && !pickupDone && (
          <form action={finish}><button className="btn btn-primary">Fahrzeug zurücknehmen</button></form>
        )}
        {b.status === "RESERVED" && (
          <form action={cancel}><button className="btn btn-danger">Stornieren</button></form>
        )}
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <Chip tone="good">Gespeichert</Chip>}
        {sp.fehler === "status" && <Chip tone="bad">Dieser Statuswechsel ist nicht möglich.</Chip>}
        {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
        {b.status === "ACTIVE" && pickupDone && (
          <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">Übergeben mit Protokoll {pickupDone.number}. Die Rückgabe läuft ebenfalls über ein Protokoll und wird in der nächsten Ausbaustufe freigeschaltet.</p>
        )}
        {contractSigned && b.status === "RESERVED" && (
          <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Mietvertrag {b.contract!.number} ist abgeschlossen. Die Buchung ist bereit zur Übergabe.</p>
        )}

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
                  tiers: { workWeekRate: b.workWeekRate?.toString() ?? null, weeklyRate: b.weeklyRate?.toString() ?? null, monthlyRate: b.monthlyRate?.toString() ?? null },
                }}
                vehicles={vehicles}
                customers={customers}
                submitLabel="Änderungen speichern"
                cancelHref="/buchungen"
              />
            ) : (
              <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
                {contractSigned && <><dt className="label-xs self-center">Vertrag</dt><dd>{b.contract!.number}. Zeitraum, Fahrzeug und Preis sind festgeschrieben.</dd></>}
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
                <div className="text-xs text-ink-3 pb-1">{price.days} Miettage</div>
                {price.lines.map((l) => (
                  <div key={l.tier} className="flex justify-between py-1.5 border-b border-line-soft"><span>{l.quantity} × {l.label} zu {fmtEur(l.unitPrice)}</span><span className="font-mono tnum">{fmtEur(l.amount)}</span></div>
                ))}
                {price.discountPercent > 0 && (
                  <div className="flex justify-between py-1.5 border-b border-line-soft"><span>Rabatt {price.discountPercent} %</span><span className="font-mono tnum">−{fmtEur(price.discountAmount)}</span></div>
                )}
                <div className="flex justify-between py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>Voraussichtlich</span><span className="font-mono tnum">{fmtEur(price.total)}</span></div>
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

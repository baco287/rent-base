import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { bookingStage } from "@/lib/booking-status";
import { customerName, fmtDateTime } from "@/lib/format";
import { BookingStageChip, Card, Content, PageHeader, Plate } from "@/components/ui";

export const metadata = { title: "Übergabe" };

// Vorbereitete Seite. Der Übergabe-Assistent (Kilometer, Tank, Schäden, Fotos, Unterschrift) folgt in der nächsten Phase.
// Bis dahin gibt es bewusst keinen Weg, ein Fahrzeug ohne Protokoll auf "Unterwegs" zu setzen.
export default async function PickupPage({ params }: PageProps<"/buchungen/[id]/uebergabe">) {
  const { tenant } = await requireRole("DISPO", "YARD");
  const { id } = await params;
  const b = await db.booking.findFirst({ where: { id, tenantId: tenant.id }, include: { vehicle: true, customer: true, contract: { select: { number: true, status: true, signedAt: true } } } });
  if (!b) notFound();
  const stage = bookingStage(b, b.contract);

  return (
    <>
      <PageHeader title="Übergabe" sub={`Buchung ${b.number}`}>
        <BookingStageChip stage={stage} />
        <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
      </PageHeader>
      <Content>
        <Card className="p-5 max-w-2xl flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2"><Plate>{b.vehicle.plate}</Plate><span className="font-medium">{b.vehicle.make} {b.vehicle.model}</span><span className="text-ink-3">für {customerName(b.customer)}</span></div>
          {stage === "READY_FOR_PICKUP" ? (
            <>
              <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">Mietvertrag {b.contract!.number} abgeschlossen. Übergabe noch nicht gestartet.</p>
              <p className="text-sm text-ink-2">Geplante Abholung: {fmtDateTime(b.startAt)}. Der Übergabe-Assistent mit Kilometerstand, Tank, Schäden, Fotos und Unterschrift wird in der nächsten Ausbaustufe freigeschaltet. Erst das finalisierte Übergabeprotokoll setzt das Fahrzeug auf „Unterwegs“.</p>
              <div><Link href={`/buchungen/${b.id}/vertrag`} className="btn">Mietvertrag anzeigen</Link></div>
            </>
          ) : stage === "NEEDS_CONTRACT" || stage === "CONTRACT_DRAFT" ? (
            <>
              <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">Die Übergabe ist erst möglich, wenn der Mietvertrag abgeschlossen ist.</p>
              <div><Link href={`/buchungen/${b.id}/vertrag`} className="btn btn-primary">{stage === "CONTRACT_DRAFT" ? "Mietvertrag fortsetzen" : "Zum Mietvertrag"}</Link></div>
            </>
          ) : (
            <p className="text-sm text-ink-2">Für diese Buchung ist keine Übergabe mehr offen.</p>
          )}
        </Card>
      </Content>
    </>
  );
}

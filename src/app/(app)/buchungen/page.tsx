import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtEur } from "@/lib/format";
import { calculateRentalPrice, rateCardFrom } from "@/lib/pricing";
import { BookingStageChip, Card, Content, Empty, PageHeader, Plate } from "@/components/ui";
import { bookingStage } from "@/lib/booking-status";

export const metadata = { title: "Buchungen" };

const FILTERS: { key: string; label: string; where: Prisma.BookingWhereInput }[] = [
  { key: "offen", label: "Offen", where: { status: { in: ["RESERVED", "ACTIVE"] } } },
  { key: "reserviert", label: "Reserviert", where: { status: "RESERVED" } },
  { key: "unterwegs", label: "Unterwegs", where: { status: "ACTIVE" } },
  { key: "abgeschlossen", label: "Abgeschlossen", where: { status: { in: ["RETURNED", "CANCELLED"] } } },
  { key: "alle", label: "Alle", where: {} },
];

export default async function BookingsPage({ searchParams }: PageProps<"/buchungen">) {
  const { tenant } = await requireSession();
  const params = await searchParams;
  const filterKey = typeof params.filter === "string" ? params.filter : "offen";
  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0];

  const bookings = await db.booking.findMany({
    where: { tenantId: tenant.id, ...filter.where },
    include: { vehicle: true, customer: true, contract: { select: { status: true } } },
    orderBy: { startAt: filter.key === "abgeschlossen" || filter.key === "alle" ? "desc" : "asc" },
    take: 300,
  });

  return (
    <>
      <PageHeader title="Buchungen" sub={`${bookings.length} ${filter.label.toLowerCase()}`}>
        <Link href="/buchungen/neu" className="btn btn-primary">+ Neue Buchung</Link>
      </PageHeader>
      <Content>
        <div className="flex gap-1.5 flex-wrap">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/buchungen?filter=${f.key}`} className={`btn !py-1.5 ${f.key === filter.key ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>
              {f.label}
            </Link>
          ))}
        </div>
        <Card>
          {bookings.length === 0 ? (
            <Empty action={{ href: "/buchungen/neu", label: "Buchung anlegen" }}>Keine Buchungen in dieser Ansicht.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="text-left">
                    <th className="label-xs px-3 py-2 border-b border-line">Nr.</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Kunde</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Fahrzeug</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Abholung</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Rückgabe</th>
                    <th className="label-xs px-3 py-2 border-b border-line text-right">Tage</th>
                    <th className="label-xs px-3 py-2 border-b border-line text-right">Voraussichtlich</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => {
                    const price = calculateRentalPrice({ start: b.startAt, end: b.endAt, rates: rateCardFrom(b), discountPercent: b.customer.discountPercent });
                    const d = price.days;
                    const total = price.total;
                    const overdue = b.status === "ACTIVE" && b.endAt < new Date();
                    return (
                      <tr key={b.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                        <td className="px-3 py-2.5 font-mono tnum"><Link href={`/buchungen/${b.id}`} className="hover:underline">{b.number}</Link></td>
                        <td className="px-3 py-2.5"><Link href={`/buchungen/${b.id}`} className="font-medium hover:underline">{customerName(b.customer)}</Link></td>
                        <td className="px-3 py-2.5"><Plate>{b.vehicle.plate}</Plate> <span className="text-ink-3 text-xs">{b.vehicle.make} {b.vehicle.model}</span></td>
                        <td className="px-3 py-2.5 font-mono tnum">{fmtDateTime(b.startAt)}</td>
                        <td className={`px-3 py-2.5 font-mono tnum ${overdue ? "text-bad font-semibold" : ""}`}>{fmtDateTime(b.endAt)}</td>
                        <td className="px-3 py-2.5 text-right tnum">{d}</td>
                        <td className="px-3 py-2.5 text-right font-mono tnum">{fmtEur(total)}</td>
                        <td className="px-3 py-2.5">{overdue ? <span className="chip bg-bad-soft text-bad">Überfällig</span> : <BookingStageChip stage={bookingStage(b, b.contract)} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <p className="text-xs text-ink-3">Ablauf: Buchung, Mietvertrag, Übergabe, Rückgabe. „Unterwegs“ entsteht nur durch Mietvertrag und Übergabeprotokoll.</p>
      </Content>
    </>
  );
}

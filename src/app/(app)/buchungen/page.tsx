import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtEur } from "@/lib/format";
import { rentalDays } from "@/lib/pricing";
import { SIGNED_AMENDMENTS_SELECT } from "@/lib/amendments";
import { AGREED_EXTENSION_SELECT, agreedEndOf, isOverdue, pricingEnd } from "@/lib/bookings";
import { expectedRentalCents } from "@/lib/rental-payments";
import { accidentTariffsFor } from "@/lib/accident-case-file";
import { accidentRentState } from "@/lib/accident-pricing";
import { BookingStageChip, Card, Chip, Content, Empty, PageHeader, Plate } from "@/components/ui";
import { bookingStage, pickupAction, returnAction } from "@/lib/booking-status";
import { bookingSearchWhere, SEARCH_MAX } from "@/lib/search";

export const metadata = { title: "Buchungen" };
const PAGE = 50;

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
  const q = typeof params.q === "string" ? params.q.trim().slice(0, SEARCH_MAX) : "";
  const page = Math.max(1, parseInt(typeof params.seite === "string" ? params.seite : "1", 10) || 1);
  const qs = (over: Record<string, string | number>) => `/buchungen?${new URLSearchParams({ filter: filter.key, ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) }).toString()}`;

  // Suche statt fester Obergrenze: Nummer, Kunde, Kennzeichen (auch ohne Leerzeichen), Fahrzeug, Vertragsnummer; Serverseiten
  const search = q ? await bookingSearchWhere(tenant.id, q) : {};
  const where: Prisma.BookingWhereInput = { tenantId: tenant.id, ...filter.where, ...(q ? { AND: [search] } : {}) };
  const [total, bookings] = await Promise.all([
    db.booking.count({ where }),
    db.booking.findMany({
      where,
      include: { vehicle: true, customer: true, contractAmendments: AGREED_EXTENSION_SELECT, contract: { select: { status: true, totalAmount: true, amendments: SIGNED_AMENDMENTS_SELECT } }, handovers: { where: { correctsId: null }, select: { type: true, status: true } } },
      orderBy: { startAt: filter.key === "abgeschlossen" || filter.key === "alle" ? "desc" : "asc" },
      skip: (page - 1) * PAGE,
      take: PAGE,
    }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  // Befehl 29 Phase E: Unfallersatz – Miettage und Mietwert wie Fallakte und Rechnung (ab Übergabe, Tarif laut Vertrag), vorher kein Ist-Wert
  const accidentTariffs = await accidentTariffsFor(tenant.id, bookings.filter((b) => b.rentalType === "ACCIDENT_REPLACEMENT").map((b) => b.id));

  return (
    <>
      <PageHeader title="Buchungen" sub={`${total} ${filter.label.toLowerCase()}${q ? ` · Suche „${q}“` : ""}`}>
        <form className="flex gap-2" role="search">
          <input type="hidden" name="filter" value={filter.key} />
          <label htmlFor="buchungen-q" className="sr-only">Buchungen suchen</label>
          <input id="buchungen-q" name="q" defaultValue={q} maxLength={SEARCH_MAX} placeholder="Nummer, Kunde, Kennzeichen, Fahrzeug" className="input !w-64 !min-h-[36px]" />
          <button className="btn">Suchen</button>
          {q && <Link href={`/buchungen?filter=${filter.key}`} className="btn">Zurücksetzen</Link>}
        </form>
        {/* Befehl 29.2: „+ Neue Buchung“ steht in der Kopfleiste der App-Shell (keine doppelte Primäraktion) */}
      </PageHeader>
      <Content>
        <div className="flex gap-1.5 flex-wrap">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/buchungen?${new URLSearchParams({ filter: f.key, ...(q ? { q } : {}) }).toString()}`} className={`btn !py-1.5 ${f.key === filter.key ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>
              {f.label}
            </Link>
          ))}
        </div>
        <Card>
          {bookings.length === 0 ? (
            <Empty action={q ? undefined : { href: "/buchungen/neu", label: "Buchung anlegen" }}>{q ? `Nichts gefunden für „${q}“ in „${filter.label}“.` : "Keine Buchungen in dieser Ansicht."}</Empty>
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
                    <th className="label-xs px-3 py-2 border-b border-line">Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => {
                    // Befehl 27: mit unterschriebenem Vertrag der wirksame Vertragspreis (inkl. Nachträgen), sonst Schätzung aus der Buchung
                    // Befehl 29: offenes Mietende (Unfallersatz) – bisherige Miettage bis zur Rückgabe bzw. bis jetzt
                    const accidentTariff = accidentTariffs.get(b.id);
                    const rent = accidentTariff ? accidentRentState(b, accidentTariff) : null;
                    const d = rent ? (rent.phase === "NONE" ? null : rent.value.days) : rentalDays(b.startAt, pricingEnd(b));
                    const total = rent ? (rent.phase === "NONE" ? null : rent.value.cents / 100) : expectedRentalCents(b).cents / 100;
                    // Befehl 28: überfällig gemessen am operativen Ende (vereinbarte Verlängerung zählt)
                    const overdue = isOverdue({ status: b.status, endAt: b.endAt, agreedEndAt: agreedEndOf(b) });
                    // Befehl 21: die nächste Prozessaktion direkt in der Zeile – Rückgabe (laufende Miete) bzw. Übergabe (bereit)
                    const ret = returnAction(b, b.contract, b.handovers);
                    const pick = pickupAction(b, b.contract, b.handovers);
                    const rowAction = ret.kind === "START" || ret.kind === "CONTINUE" ? { href: `/buchungen/${b.id}/rueckgabe`, label: ret.label } : pick.kind === "START" || pick.kind === "CONTINUE" ? { href: `/buchungen/${b.id}/uebergabe`, label: pick.label } : null;
                    return (
                      <tr key={b.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                        <td className="px-3 py-2.5 font-mono tnum"><Link href={`/buchungen/${b.id}`} className="hover:underline">{b.number}</Link></td>
                        <td className="px-3 py-2.5"><Link href={`/buchungen/${b.id}`} className="font-medium hover:underline">{customerName(b.customer)}</Link></td>
                        <td className="px-3 py-2.5"><Plate>{b.vehicle.plate}</Plate> <span className="text-ink-3 text-xs">{b.vehicle.make} {b.vehicle.model}</span></td>
                        <td className="px-3 py-2.5 font-mono tnum">{rent && b.actualPickupAt ? <>{fmtDateTime(b.actualPickupAt)}<span className="block text-[11px] text-ink-3 font-sans">übergeben</span></> : fmtDateTime(b.startAt)}</td>
                        <td className={`px-3 py-2.5 font-mono tnum ${overdue ? "text-bad font-semibold" : ""}`}>{rent ? (b.status === "CANCELLED" ? "entfällt" : b.actualReturnAt ? <>{fmtDateTime(b.actualReturnAt)}<span className="block text-[11px] text-ink-3 font-sans">zurückgegeben</span></> : b.endAt ? <>{fmtDateTime(b.endAt)}<span className="block text-[11px] text-ink-3 font-sans">geplant</span></> : "offen") : fmtDateTime(b.endAt)}</td>
                        <td className="px-3 py-2.5 text-right tnum">{d ?? "–"}</td>
                        <td className="px-3 py-2.5 text-right font-mono tnum">{total == null ? "–" : fmtEur(total)}</td>
                        <td className="px-3 py-2.5">{overdue ? <span className="chip bg-bad-soft text-bad">Überfällig</span> : <BookingStageChip stage={bookingStage(b, b.contract)} />}</td>
                        <td className="px-3 py-2">{rowAction ? <Link href={rowAction.href} className="btn btn-primary !py-1.5 whitespace-nowrap">{rowAction.label}</Link> : <Link href={`/buchungen/${b.id}`} className="btn !py-1.5 whitespace-nowrap">Öffnen</Link>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <nav aria-label="Seiten" className="px-4 py-3 border-t border-line-soft flex items-center gap-2">
              {page > 1 && <Link href={qs({ seite: page - 1 })} className="btn !py-1.5">Zurück</Link>}
              <Chip>Seite {page} von {pages}</Chip>
              {page < pages && <Link href={qs({ seite: page + 1 })} className="btn !py-1.5">Weiter</Link>}
            </nav>
          )}
        </Card>
        <p className="text-xs text-ink-3">Ablauf: Buchung, Mietvertrag, Übergabe, Rückgabe. „Unterwegs“ entsteht nur durch Mietvertrag und Übergabeprotokoll.</p>
      </Content>
    </>
  );
}

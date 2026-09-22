import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtEur, toDateTimeInput } from "@/lib/format";
import { calculateRentalPrice, rateCardFrom } from "@/lib/pricing";
import { BookingStageChip, Card, Chip, Content, PageHeader, Plate } from "@/components/ui";
import { EXTRA_CHARGE_TYPES, type ExtraChargeType } from "@/lib/constants";
import { bookingStage, canCancel } from "@/lib/booking-status";
import { startContractAction } from "./vertrag/actions";
import { setBookingStatusAction, updateBookingAction } from "../actions";
import { BookingForm } from "../booking-form";
import { loadBookingOptions } from "../options";
import { DocumentsPanel } from "./dokumente/documents-panel";
import { DepositPanel, PaymentsPanel } from "./finanzen/panels";
import { DamageCasesPanel } from "../../schaeden/damages-panel";

export default async function BookingPage({ params, searchParams }: PageProps<"/buchungen/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  const b = await db.booking.findFirst({ where: { id, tenantId: tenant.id }, include: { vehicle: true, customer: true, contract: { select: { number: true, status: true } }, handovers: { where: { correctsId: null }, select: { id: true, type: true, number: true, status: true } } } });
  if (!b) notFound();

  // Mit unterschriebenem Vertrag sind Zeitraum, Fahrzeug und Preis festgeschrieben
  const editable = (b.status === "RESERVED" || b.status === "ACTIVE") && b.contract?.status !== "SIGNED";
  const { vehicles, customers } = editable ? await loadBookingOptions(tenant.id) : { vehicles: [], customers: [] };
  const price = calculateRentalPrice({ start: b.startAt, end: b.endAt, rates: rateCardFrom(b), discountPercent: b.customer.discountPercent });
  const overdue = b.status === "ACTIVE" && b.endAt < new Date();

  const stage = bookingStage(b, b.contract);
  const contractSigned = b.contract?.status === "SIGNED";
  const pickupDraft = b.handovers.find((h) => h.type === "PICKUP" && h.status === "DRAFT");
  const pickupDone = b.handovers.find((h) => h.type === "PICKUP" && h.status === "FINALIZED");
  const returnDraft = b.handovers.find((h) => h.type === "RETURN" && h.status === "DRAFT");
  const returnDone = b.handovers.find((h) => h.type === "RETURN" && h.status === "FINALIZED");
  const invoice = b.status === "RETURNED" ? await db.invoice.findFirst({ where: { tenantId: tenant.id, bookingId: b.id, kind: "RENTAL", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true, versionNo: true } }, _count: { select: { versions: true } } } }) : null;
  // Schadenabrechnungen sind eigene Rechnungen (kind DAMAGE) mit Bezug zur Schadenakte
  const damageInvoices = await db.invoice.findMany({ where: { tenantId: tenant.id, bookingId: b.id, kind: "DAMAGE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true } }, damageCase: { select: { id: true, caseNumber: true } } } });
  const charges = b.status === "RETURNED" || returnDraft ? await db.extraCharge.findMany({ where: { tenantId: tenant.id, bookingId: b.id }, orderBy: { createdAt: "asc" } }) : [];
  const chargesTotal = charges.reduce((s, c) => s + Number(c.amount), 0);
  const update = updateBookingAction.bind(null, b.id);
  const startContract = startContractAction.bind(null, b.id);
  const finish = setBookingStatusAction.bind(null, b.id, "RETURNED");
  const cancel = setBookingStatusAction.bind(null, b.id, "CANCELLED");

  return (
    <>
      <PageHeader title={`Buchung ${b.number}`} sub={<Plate>{b.vehicle.plate}</Plate>}>
        {overdue ? <Chip tone="bad">Rückgabe überfällig</Chip> : <BookingStageChip stage={stage} />}
        {stage === "NEEDS_CONTRACT" && user.role !== "YARD" && <form action={startContract}><button className="btn btn-primary">Mietvertrag erstellen</button></form>}
        {stage === "CONTRACT_DRAFT" && user.role !== "YARD" && <Link href={`/buchungen/${b.id}/vertrag`} className="btn btn-primary">Mietvertrag fortsetzen</Link>}
        {(stage === "NEEDS_CONTRACT" || stage === "CONTRACT_DRAFT") && user.role === "YARD" && <Chip tone="amber">Mietvertrag wird von der Disposition erstellt</Chip>}
        {b.contract && b.contract.status !== "DRAFT" && <Link href={`/buchungen/${b.id}/vertrag`} className="btn">Mietvertrag anzeigen</Link>}
        {stage === "READY_FOR_PICKUP" && <Link href={`/buchungen/${b.id}/uebergabe`} className="btn btn-primary">{pickupDraft ? "Übergabe fortsetzen" : "Übergabe starten"}</Link>}
        {pickupDone && <Link href={`/buchungen/${b.id}/uebergabe`} className="btn">Übergabeprotokoll anzeigen</Link>}
        {b.status === "ACTIVE" && pickupDone && !returnDone && <Link href={`/buchungen/${b.id}/rueckgabe`} className="btn btn-primary">{returnDraft ? "Rückgabe fortsetzen" : "Rückgabe starten"}</Link>}
        {returnDone && <Link href={`/buchungen/${b.id}/rueckgabe`} className="btn">Rückgabeprotokoll anzeigen</Link>}
        {b.status === "RETURNED" && returnDone && !invoice && user.role !== "YARD" && <Link href={`/buchungen/${b.id}/rechnung`} className="btn btn-primary">Rechnung erstellen</Link>}
        {invoice?.status === "DRAFT" && user.role !== "YARD" && <Link href={`/buchungen/${b.id}/rechnung`} className="btn btn-primary">Rechnung fortsetzen</Link>}
        {invoice?.status === "FINALIZED" && <Link href={`/buchungen/${b.id}/rechnung`} className="btn">Rechnung {invoice.number} anzeigen</Link>}
        {b.status === "ACTIVE" && !pickupDone && (
          <form action={finish}><button className="btn btn-primary">Fahrzeug zurücknehmen</button></form>
        )}
        {canCancel(b) && user.role !== "YARD" && (
          <form action={cancel}><button className="btn btn-danger">Stornieren</button></form>
        )}
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <Chip tone="good">Gespeichert</Chip>}
        {sp.fehler === "status" && <Chip tone="bad">Dieser Statuswechsel ist nicht möglich.</Chip>}
        {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
        {b.status === "ACTIVE" && pickupDone && (
          <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">Übergeben mit Protokoll {pickupDone.number}. Die Rückgabe läuft über „Rückgabe starten“ und vergleicht den Zustand mit der Übergabe.</p>
        )}
        {b.status === "RETURNED" && returnDone && (
          <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm">Zurückgegeben mit Protokoll {returnDone.number}. Übergabe {pickupDone?.number ?? "–"}. <Link href={`/fahrzeuge/${b.vehicleId}`} className="underline">Fahrzeughistorie ansehen</Link>.</p>
        )}
        {b.status === "RETURNED" && returnDone && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="label-xs">Rechnung</span>
            {!invoice && <Chip tone="amber">noch nicht erstellt</Chip>}
            {invoice?.status === "DRAFT" && <Chip tone="amber">Entwurf</Chip>}
            {invoice?.status === "FINALIZED" && <><Chip tone="good">{invoice.number} abgeschlossen</Chip><span className="font-mono tnum">{fmtEur(Number(invoice.currentVersion?.grossTotal ?? 0))}</span>{invoice._count.versions > 1 && <Link href={`/buchungen/${b.id}/rechnung`} className="chip bg-panel-2 text-ink-2 hover:underline">{invoice._count.versions} Fassungen · aktuell {invoice.currentVersion?.versionNo}</Link>}</>}
            {!invoice && user.role === "YARD" && <span className="text-ink-3">wird von der Disposition erstellt</span>}
          </div>
        )}
        {damageInvoices.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="label-xs">Schadenabrechnung{damageInvoices.length > 1 ? "en" : ""}</span>
            {damageInvoices.map((i) => (
              <Link key={i.id} href={`/buchungen/${b.id}/rechnung?nr=${i.id}`} className={`chip ${i.status === "FINALIZED" ? "bg-good-soft text-good" : "bg-amber-soft text-amber"} hover:underline`}>
                {i.status === "FINALIZED" ? `${i.number} · ${fmtEur(Number(i.currentVersion?.grossTotal ?? 0))}` : "Entwurf"}{i.damageCase ? ` · ${i.damageCase.caseNumber}` : ""}
              </Link>
            ))}
          </div>
        )}
        {contractSigned && b.status === "RESERVED" && (
          <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Mietvertrag {b.contract!.number} ist abgeschlossen. Die Buchung ist bereit zur Übergabe.</p>
        )}

        <DocumentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} />
        {(b.status === "RETURNED" || b.status === "ACTIVE") && <DamageCasesPanel tenantId={tenant.id} where={{ OR: [{ bookingId: b.id }, { discoveredIn: { bookingId: b.id, type: "RETURN" } }] }} title="Schäden dieser Vermietung" empty="Zu dieser Vermietung wurde kein Schaden festgestellt." />}
        {contractSigned && (
          <div id="kaution" className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <PaymentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} compact />
            <DepositPanel tenantId={tenant.id} bookingId={b.id} role={user.role} charges={returnDone ? { count: charges.length, total: chargesTotal } : null} />
          </div>
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
            {(returnDone || returnDraft) && (
              <Card title="Zusatzkosten" right={<Chip tone={charges.length > 0 ? "amber" : "grey"}>{charges.length === 0 ? "keine" : fmtEur(chargesTotal)}</Chip>}>
                <div className="p-4 text-sm flex flex-col">
                  {charges.length === 0 && <span className="text-ink-3">{returnDraft ? "Rückgabe läuft, noch keine Positionen bestätigt." : "Bei der Rückgabe wurden keine Zusatzkosten erfasst."}</span>}
                  {charges.map((c) => (
                    <div key={c.id} className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{EXTRA_CHARGE_TYPES[c.type as ExtraChargeType] ?? c.type}: {c.description}</span><span className="font-mono tnum">{fmtEur(Number(c.amount))}</span></div>
                  ))}
                  {charges.length > 0 && <div className="flex justify-between py-2 mt-1 border-t-2 border-ink font-semibold"><span>Gesamt Zusatzkosten</span><span className="font-mono tnum">{fmtEur(chargesTotal)}</span></div>}
                  <div className="flex justify-between py-1.5 text-ink-3"><span>Kaution laut Buchung</span><span className="font-mono tnum">{fmtEur(b.deposit)}</span></div>
                  <p className="text-xs text-ink-3 mt-1">Zusatzkosten und Kaution werden nicht automatisch verrechnet. Stand der Kaution siehe Bereich „Kaution“.</p>
                </div>
              </Card>
            )}
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
                <p className="text-xs text-ink-3 mt-2">Mehrkilometer, Tank und weitere Positionen werden bei der Rückgabe geprüft und erscheinen dann als Zusatzkosten.</p>
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

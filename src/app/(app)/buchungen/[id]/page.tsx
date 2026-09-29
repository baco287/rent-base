import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { KeyDropPanel } from "./key-drop-panel";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtEur, toDateTimeInput } from "@/lib/format";
import { calculateRentalPrice, rateCardFrom } from "@/lib/pricing";
import { BookingStageChip, Card, Chip, Content, PageHeader, Plate } from "@/components/ui";
import { EXTRA_CHARGE_TYPES, type ExtraChargeType } from "@/lib/constants";
import { bookingStage, canCancel, pickupAction, returnAction } from "@/lib/booking-status";
import { startContractAction } from "./vertrag/actions";
import { setBookingStatusAction, updateBookingAction } from "../actions";
import { BookingForm } from "../booking-form";
import { customerOptionOf } from "../customer-option";
import { loadBookingOptions } from "../options";
import { DocumentsPanel } from "./dokumente/documents-panel";
import { MoneyOverview } from "./finanzen/money-overview";
import { DepositPanel, RentalPaymentsPanel } from "./finanzen/panels";
import { DamageCasesPanel } from "../../schaeden/damages-panel";
import { AuthorityCasesPanel } from "../../behoerden/authority-panel";

export default async function BookingPage({ params, searchParams }: PageProps<"/buchungen/[id]">) {
  const { tenant, user, supportSession } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  const b = await db.booking.findFirst({ where: { id, tenantId: tenant.id }, include: { vehicle: true, customer: true, contract: { select: { number: true, status: true } }, handovers: { where: { correctsId: null }, select: { id: true, type: true, number: true, status: true } } } });
  if (!b) notFound();

  // Mit unterschriebenem Vertrag sind Zeitraum, Fahrzeug und Preis festgeschrieben
  const editable = (b.status === "RESERVED" || b.status === "ACTIVE") && b.contract?.status !== "SIGNED";
  const { vehicles } = editable ? await loadBookingOptions(tenant.id) : { vehicles: [] };
  const initialCustomer = editable ? customerOptionOf(b.customer) : null;
  const price = calculateRentalPrice({ start: b.startAt, end: b.endAt, rates: rateCardFrom(b), discountPercent: b.customer.discountPercent });
  const overdue = b.status === "ACTIVE" && b.endAt < new Date();

  const stage = bookingStage(b, b.contract);
  const contractSigned = b.contract?.status === "SIGNED";
  const pickupDraft = b.handovers.find((h) => h.type === "PICKUP" && h.status === "DRAFT");
  const pickupDone = b.handovers.find((h) => h.type === "PICKUP" && h.status === "FINALIZED");
  const returnDraft = b.handovers.find((h) => h.type === "RETURN" && h.status === "DRAFT");
  const returnDone = b.handovers.find((h) => h.type === "RETURN" && h.status === "FINALIZED");
  const invoice = b.status === "RETURNED" ? await db.invoice.findFirst({ where: { tenantId: tenant.id, bookingId: b.id, kind: "RENTAL", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true, versionNo: true } }, _count: { select: { versions: true } } } }) : null;
  // Schadenabrechnungen sind eigene Rechnungen (kind DAMAGE) mit Bezug zur Schadenakte
  const damageInvoices = await db.invoice.findMany({ where: { tenantId: tenant.id, bookingId: b.id, kind: "DAMAGE", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true } }, damageCase: { select: { id: true, caseNumber: true } } } });
  // Bearbeitungsentgelte zu Behördenvorgängen (kind AUTHORITY_FEE), nur Entwurf aus dem Vertrag
  const feeInvoices = await db.invoice.findMany({ where: { tenantId: tenant.id, bookingId: b.id, kind: "AUTHORITY_FEE", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true } }, authorityCase: { select: { id: true, caseNumber: true } } } });
  const counterDocs = await db.invoice.findMany({ where: { tenantId: tenant.id, bookingId: b.id, documentType: { in: ["CREDIT_NOTE", "CANCELLATION"] }, status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, documentType: true, currentVersion: { select: { grossTotal: true } }, original: { select: { number: true } } } });
  const charges = b.status === "RETURNED" || returnDraft ? await db.extraCharge.findMany({ where: { tenantId: tenant.id, bookingId: b.id }, orderBy: { createdAt: "asc" } }) : [];
  const chargesTotal = charges.reduce((s, c) => s + Number(c.amount), 0);
  const update = updateBookingAction.bind(null, b.id);
  const startContract = startContractAction.bind(null, b.id);
  const finish = setBookingStatusAction.bind(null, b.id, "RETURNED");
  const cancel = setBookingStatusAction.bind(null, b.id, "CANCELLED");
  // Befehl 21: „Was ist als Nächstes zu tun?“ – eine deutliche Aktion je Stand, abgeleitet aus denselben Regeln wie die Kopfzeile
  const pickupNext = pickupAction(b, b.contract, b.handovers);
  const returnNext = returnAction(b, b.contract, b.handovers);
  const canContract = user.role !== "YARD";
  const nextStep: { title: string; text: string; action: React.ReactNode } | null =
    stage === "NEEDS_CONTRACT" ? { title: "Mietvertrag fehlt", text: canContract ? "Für diese Buchung gibt es noch keinen Mietvertrag. Ohne Vertrag ist keine Übergabe möglich." : "Der Mietvertrag wird von der Disposition erstellt. Danach kann die Übergabe beginnen.", action: canContract ? <form action={startContract}><button className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">Mietvertrag erstellen</button></form> : null }
    : stage === "CONTRACT_DRAFT" ? { title: "Mietvertrag noch nicht abgeschlossen", text: canContract ? "Der Vertragsentwurf ist angelegt. Bitte prüfen, unterschreiben lassen und abschließen." : "Die Disposition schließt den Mietvertrag ab. Danach kann die Übergabe beginnen.", action: canContract ? <Link href={`/buchungen/${b.id}/vertrag`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">Mietvertrag fortsetzen</Link> : null }
    : pickupNext.kind === "START" || pickupNext.kind === "CONTINUE" ? { title: "Bereit zur Übergabe", text: "Der Mietvertrag ist abgeschlossen. Jetzt auf dem Tablet mit der Übergabe weitermachen.", action: <Link href={`/buchungen/${b.id}/uebergabe`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">{pickupNext.label}</Link> }
    : returnNext.kind === "START" || returnNext.kind === "CONTINUE" ? { title: overdue ? "Rückgabe überfällig" : "Fahrzeug ist unterwegs", text: "Wenn das Fahrzeug zurückkommt: Rückgabe am besten auf dem Tablet durchführen.", action: <Link href={`/buchungen/${b.id}/rueckgabe`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">{returnNext.label}</Link> }
    : b.status === "RETURNED" && returnDone && invoice?.status !== "FINALIZED" ? { title: invoice ? "Rechnung noch nicht abgeschlossen" : "Rechnung fehlt", text: canContract ? "Die Rückgabe ist abgeschlossen. Die Rechnung wird am PC geprüft und finalisiert." : "Die Rechnung wird von der Disposition erstellt.", action: canContract ? <Link href={`/buchungen/${b.id}/rechnung`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">{invoice ? "Rechnung fortsetzen" : "Rechnung erstellen"}</Link> : null }
    : null;

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
        {nextStep && (
          <section aria-label="Nächster Schritt" className="rounded-xl border-2 border-brand bg-panel p-4 md:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
            <div className="flex-1 min-w-0">
              <div className="label-xs text-ink-3">Nächster Schritt</div>
              <div className="text-lg font-semibold leading-snug">{nextStep.title}</div>
              <p className="text-sm text-ink-2 mt-0.5">{nextStep.text}</p>
            </div>
            {nextStep.action}
          </section>
        )}
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
        {feeInvoices.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="label-xs">Bearbeitungsentgelt{feeInvoices.length > 1 ? "e" : ""} Behörde</span>
            {feeInvoices.map((i) => (
              <Link key={i.id} href={`/buchungen/${b.id}/rechnung?nr=${i.id}`} className={`chip ${i.status === "FINALIZED" ? "bg-good-soft text-good" : "bg-amber-soft text-amber"} hover:underline`}>
                {i.status === "FINALIZED" ? `${i.number} · ${fmtEur(Number(i.currentVersion?.grossTotal ?? 0))}` : "Entwurf"}{i.authorityCase ? ` · ${i.authorityCase.caseNumber}` : ""}
              </Link>
            ))}
          </div>
        )}
        {counterDocs.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="label-xs">Gutschriften / Storno</span>
            {counterDocs.map((i) => (
              <Link key={i.id} href={`/buchungen/${b.id}/rechnung?nr=${i.id}`} className={`chip ${i.status === "FINALIZED" ? "bg-info-soft text-info" : "bg-amber-soft text-amber"} hover:underline`}>
                {i.documentType === "CANCELLATION" ? "Storno" : "Gutschrift"} {i.status === "FINALIZED" ? `${i.number} · ${fmtEur(Number(i.currentVersion?.grossTotal ?? 0))}` : "(Entwurf)"} zu {i.original?.number ?? "–"}
              </Link>
            ))}
          </div>
        )}
        {contractSigned && b.status === "RESERVED" && (
          <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Mietvertrag {b.contract!.number} ist abgeschlossen. Die Buchung ist bereit zur Übergabe.</p>
        )}

        {(b.status === "ACTIVE" || b.status === "RETURNED") && pickupDone && <KeyDropPanel tenantId={tenant.id} booking={{ id: b.id, status: b.status, endAt: b.endAt, vehicleId: b.vehicleId }} role={user.role} supportMode={Boolean(supportSession)} returnStarted={Boolean(returnDraft || returnDone)} />}
        <DocumentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} />
        {(b.status === "RETURNED" || b.status === "ACTIVE") && <DamageCasesPanel tenantId={tenant.id} where={{ OR: [{ bookingId: b.id }, { discoveredIn: { bookingId: b.id, type: "RETURN" } }] }} title="Schäden dieser Vermietung" empty="Zu dieser Vermietung wurde kein Schaden festgestellt." />}
        <AuthorityCasesPanel tenantId={tenant.id} scope={{ bookingId: b.id }} canManage={user.role !== "YARD"} />
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4 items-start">
          <div className="flex flex-col gap-4 min-w-0">
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
                  kmIncludedPerDay: String(b.kmIncludedPerDay ?? b.vehicle.kmIncludedPerDay),
                  extraKmRate: (b.extraKmRate ?? b.vehicle.extraKmRate).toString().replace(".", ","),
                  notes: b.notes ?? "",
                  tiers: { workWeekRate: b.workWeekRate?.toString() ?? null, weeklyRate: b.weeklyRate?.toString() ?? null, monthlyRate: b.monthlyRate?.toString() ?? null },
                }}
                vehicles={vehicles}
                initialCustomer={initialCustomer}
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
                <dt className="label-xs self-center">Kilometer</dt><dd className="font-mono tnum">{(b.kmIncludedPerDay ?? b.vehicle.kmIncludedPerDay).toLocaleString("de-DE")} km/Tag frei · {fmtEur(Number(b.extraKmRate ?? b.vehicle.extraKmRate))} je Mehrkilometer{contractSigned ? " (laut Vertrag)" : ""}</dd>
                <dt className="label-xs self-center">Notizen</dt><dd>{b.notes || "–"}</dd>
              </dl>
            )}
          </Card>
          {/* Mietzahlung und Kaution bleiben getrennt: gemeinsamer Überblick (Befehl 20.7), eigene Bereiche, keine automatische Verrechnung */}
          <MoneyOverview tenantId={tenant.id} bookingId={b.id} role={user.role} />
          <RentalPaymentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} />
          {/* Befehl 21: der Bereich ist immer erreichbar („Zur Kaution“); ohne Vertrag erklärt er, wann der Eingang dokumentiert wird */}
          <div id="kaution" className="scroll-mt-20">
            <DepositPanel tenantId={tenant.id} bookingId={b.id} role={user.role} charges={returnDone ? { count: charges.length, total: chargesTotal } : null} />
          </div>
          </div>

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

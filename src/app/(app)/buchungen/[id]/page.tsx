import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { KeyDropPanel } from "./key-drop-panel";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtEur, toDateTimeInput } from "@/lib/format";
import { calculateRentalPrice, rateCardFrom } from "@/lib/pricing";
import { BookingStageChip, Card, Chip, Content, PageHeader, Plate } from "@/components/ui";
import { AMENDMENT_AGREED_CHANNELS, CANCELLATION_FEE_TAX_TREATMENTS, EXTRA_CHARGE_TYPES, LATE_RETURN_RULES, PAYOUT_METHODS, type ExtraChargeType, type LateReturnRule } from "@/lib/constants";
import { bookingStage, canCancel, pickupAction, returnAction } from "@/lib/booking-status";
import { cancellationOverview } from "@/lib/cancellation";
import { isOverdue } from "@/lib/bookings";
import { readContractRules } from "@/lib/business-rules";
import { bookingTimeline } from "@/lib/customer-file";
import { fmtCents, fmtRate } from "@/lib/money";
import { toDateTimeInputValue } from "@/lib/time";
import { startContractAction } from "./vertrag/actions";
import { cancelBookingAction, changePeriodAction, previewCancellationAction, previewPeriodChangeAction, setBookingStatusAction, updateBookingAction } from "../actions";
import { CancelBookingDialog, type CancellationAssistantView } from "../cancel-dialog";
import { PeriodChangeDialog } from "../period-dialog";
import { CancellationPanel } from "./storno-panel";
import { createAmendmentAction } from "./nachtrag/actions";
import { BookingForm } from "../booking-form";
import { customerOptionOf } from "../customer-option";
import { loadBookingOptions } from "../options";
import { DocumentsPanel } from "./dokumente/documents-panel";
import { MoneyOverview } from "./finanzen/money-overview";
import { DepositPanel, RentalPaymentsPanel } from "./finanzen/panels";
import { DamageCasesPanel } from "../../schaeden/damages-panel";
import { AuthorityCasesPanel } from "../../behoerden/authority-panel";
import { AmendmentsCard } from "./nachtrag/amendments-card";
import { agreedAmendmentOf, effectiveStateForBooking } from "@/lib/amendments";
import { accidentRentState } from "@/lib/accident-pricing";
import { caseTariff } from "@/lib/accident-case-file";
import { ACCIDENT_BILLING_WHERE, ACCIDENT_CASE_CLOSED_MESSAGE } from "@/lib/accident-replacement-events";

export default async function BookingPage({ params, searchParams }: PageProps<"/buchungen/[id]">) {
  const { tenant, user, supportSession } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  const b = await db.booking.findFirst({ where: { id, tenantId: tenant.id }, include: { vehicle: true, customer: true, contract: { select: { number: true, status: true } }, handovers: { where: { correctsId: null }, select: { id: true, type: true, number: true, status: true } } } });
  if (!b) notFound();

  // Mit unterschriebenem Vertrag sind Zeitraum, Fahrzeug und Preis festgeschrieben
  // Befehl 29: Unfallersatz-Buchungen werden nicht über das Buchungsformular bearbeitet (Zeitraum und Tarif gehören zur Fallakte)
  const accident = b.rentalType === "ACCIDENT_REPLACEMENT";
  const accidentCase = accident ? await db.accidentReplacementCase.findFirst({ where: { tenantId: tenant.id, bookingId: b.id }, select: { id: true, caseNumber: true, status: true } }) : null;
  // Phase D: Unfallersatz wird in der Fallakte geführt (Link nur, wenn das Modul freigeschaltet ist – sonst gäbe es keine Akte zu öffnen)
  const caseHref = accidentCase && (await isFeatureEnabled(tenant.id, "ACCIDENT_REPLACEMENT")) ? `/unfallersatz/${accidentCase.id}` : null;
  const editable = (b.status === "RESERVED" || b.status === "ACTIVE") && b.contract?.status !== "SIGNED" && !accident;
  const { vehicles } = editable ? await loadBookingOptions(tenant.id) : { vehicles: [] };
  const initialCustomer = editable ? customerOptionOf(b.customer) : null;
  // Befehl 29: Unfallersatz zeigt nur den Mietwert ab der tatsächlichen Übergabe – bis jetzt bzw. bis zur Rückgabe (Endwert), nie bis
  // zum geplanten Ende und nie mit erfundenem Datum. Phase E: dieselbe Rechnung wie Fallakte und Rechnung (Tagessatz + Tarifpositionen,
  // im Vertrag eingefroren); vor der Übergabe kein Ist-Wert.
  const accidentTariff = accident && accidentCase ? await caseTariff(tenant.id, accidentCase.id, b.id) : null;
  const accidentRent = accidentTariff ? accidentRentState(b, accidentTariff) : null;
  const accidentPerDayCents = accidentTariff ? accidentTariff.dailyRateCents + accidentTariff.items.filter((i) => i.perDay && i.unitPriceCents > 0).reduce((sum, i) => sum + i.unitPriceCents, 0) : 0;
  // Phase E: geschlossener Unfallersatzfall – Vertrag, Übergabe, Rückgabe und Storno sind serverseitig gesperrt; keine Knöpfe in die Sperre
  const caseLocked = accidentCase?.status === "CLOSED";
  const price = calculateRentalPrice({ start: b.startAt, end: b.endAt ?? b.startAt, rates: rateCardFrom(b), discountPercent: b.customer.discountPercent });
  // Befehl 28: vereinbarte, noch nicht unterschriebene Vertragsänderung (reserviert operativ, wirkt vertraglich erst mit Unterschrift)
  const agreed = await agreedAmendmentOf(tenant.id, b.id);
  const overdue = isOverdue({ status: b.status, endAt: b.endAt, agreedEndAt: agreed?.newEndAt ?? null });

  const stage = bookingStage(b, b.contract);
  const contractSigned = b.contract?.status === "SIGNED";
  // Befehl 25: wirksamer Vertragsstand (Vertrag + unterschriebene Nachträge) – zentral abgeleitet, hier nur angezeigt
  const effective = contractSigned ? await effectiveStateForBooking(tenant.id, b.id) : null;
  const pickupDraft = b.handovers.find((h) => h.type === "PICKUP" && h.status === "DRAFT");
  const pickupDone = b.handovers.find((h) => h.type === "PICKUP" && h.status === "FINALIZED");
  const returnDraft = b.handovers.find((h) => h.type === "RETURN" && h.status === "DRAFT");
  const returnDone = b.handovers.find((h) => h.type === "RETURN" && h.status === "FINALIZED");
  const invoice = b.status === "RETURNED" ? await db.invoice.findFirst({ where: { tenantId: tenant.id, bookingId: b.id, kind: "RENTAL", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true, versionNo: true } }, _count: { select: { versions: true } } } }) : null;
  // Schadenabrechnungen sind eigene Rechnungen (kind DAMAGE) mit Bezug zur Schadenakte
  const damageInvoices = await db.invoice.findMany({ where: { tenantId: tenant.id, bookingId: b.id, kind: "DAMAGE", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true } }, damageCase: { select: { id: true, caseNumber: true } } } });
  // Bearbeitungsentgelte zu Behördenvorgängen (kind AUTHORITY_FEE), nur Entwurf aus dem Vertrag
  const feeInvoices = await db.invoice.findMany({ where: { tenantId: tenant.id, bookingId: b.id, kind: "AUTHORITY_FEE", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true } }, authorityCase: { select: { id: true, caseNumber: true } } } });
  const counterDocs = await db.invoice.findMany({ where: { tenantId: tenant.id, bookingId: b.id, documentType: { in: ["CREDIT_NOTE", "CANCELLATION"] }, status: { in: ["DRAFT", "FINALIZED"] }, ...(user.role === "YARD" ? { NOT: ACCIDENT_BILLING_WHERE } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, documentType: true, currentVersion: { select: { grossTotal: true } }, original: { select: { number: true } } } });
  const charges = b.status === "RETURNED" || returnDraft ? await db.extraCharge.findMany({ where: { tenantId: tenant.id, bookingId: b.id }, orderBy: { createdAt: "asc" } }) : [];
  const chargesTotal = charges.reduce((s, c) => s + Number(c.amount), 0);
  const update = updateBookingAction.bind(null, b.id);
  const startContract = startContractAction.bind(null, b.id);
  const finish = setBookingStatusAction.bind(null, b.id, "RETURNED");
  // Befehl 27: Storno nur über den Dialog mit Grund; was an der Buchung hängt, prüft der Server (cancellationCheck)
  // Befehl 28: Storno-Assistent (Übersicht und Abrechnung aus lib/cancellation; Entscheidungen bewusst im Dialog)
  const cancelOv = canCancel(b) && user.role !== "YARD" && !supportSession && !caseLocked ? await cancellationOverview(tenant.id, b.id) : null;
  const cancelView: CancellationAssistantView | null = cancelOv ? {
    booking: { number: cancelOv.booking.number, statusLabel: cancelOv.booking.statusLabel, customerName: cancelOv.booking.customerName, vehicle: cancelOv.booking.vehicle, plate: cancelOv.booking.plate, start: fmtDateTime(cancelOv.booking.startAt), end: cancelOv.booking.endAt ? fmtDateTime(cancelOv.booking.endAt) + (accident ? " (geplant, nur Disposition)" : "") : "offen (bis zur Rückgabe)" },
    contract: cancelOv.contract,
    finances: {
      agreed: fmtCents(cancelOv.finances.agreedCents), agreedSource: cancelOv.finances.agreedSource, prepaidCents: cancelOv.finances.prepaidCents, prepaid: fmtCents(cancelOv.finances.prepaidCents),
      invoices: cancelOv.finances.invoices.map((i) => ({ label: `${i.number ?? "Entwurf"} (${i.kind === "RENTAL" ? "Miete" : i.kind === "DAMAGE" ? "Schaden" : i.kind === "AUTHORITY_FEE" ? "Behörde" : "Rechnung"})`, gross: fmtCents(i.grossCents), open: fmtCents(i.openCents), credit: fmtCents(i.creditCents) })),
      openReceivable: fmtCents(cancelOv.finances.openReceivableCents), customerCredit: fmtCents(cancelOv.finances.customerCreditCents),
      deposit: cancelOv.finances.deposit ? { expected: fmtCents(cancelOv.finances.deposit.expectedCents), received: fmtCents(cancelOv.finances.deposit.receivedCents), released: fmtCents(cancelOv.finances.deposit.releasedCents), retained: fmtCents(cancelOv.finances.deposit.retainedCents), offset: fmtCents(cancelOv.finances.deposit.offsetCents), remaining: fmtCents(cancelOv.finances.deposit.remainingCents), remainingCents: cancelOv.finances.deposit.remainingCents } : null,
    },
    amendments: { drafts: cancelOv.amendments.filter((a) => a.status === "DRAFT").length, agreed: cancelOv.amendments.filter((a) => a.status === "AGREED").length, signed: cancelOv.amendments.filter((a) => a.status === "SIGNED").length },
    blockers: cancelOv.blockers, warnings: cancelOv.warnings,
    needs: { refund: cancelOv.needs.refundDecision, deposit: cancelOv.needs.depositDecision },
    fee: { available: cancelOv.fee.available, blockedReason: cancelOv.fee.blockedReason, pricesIncludeTax: cancelOv.fee.pricesIncludeTax, standardRate: `Standardsatz ${fmtRate(cancelOv.fee.standardRateBp)}` },
    taxTreatments: Object.entries(CANCELLATION_FEE_TAX_TREATMENTS).map(([key, label]) => ({ key, label })),
    payoutMethods: Object.entries(PAYOUT_METHODS).map(([key, label]) => ({ key, label })),
    idempotencyKey: randomUUID(),
    defaultWhen: toDateTimeInputValue(new Date()),
  } : null;
  // Befehl 28: Zeitraum vor der Vertragsunterschrift nur über „Zeitraum ändern“ (Grund, Preisvorschlag, Verfügbarkeit, Audit)
  const canChangePeriod = b.status === "RESERVED" && b.contract?.status !== "SIGNED" && user.role !== "YARD" && !supportSession && !accident;
  // Befehl 28: vertragliche Verspätungsregel (eingefroren im Vertrag) – nur Anzeige; ein Betrag entsteht erst bei der Rückgabe als Vorschlag
  const lateRule = overdue && contractSigned ? (readContractRules((await db.rentalContract.findFirst({ where: { tenantId: tenant.id, bookingId: b.id }, select: { conditions: true } }))?.conditions)?.values as { lateReturnRule?: LateReturnRule; lateReturnFeeCents?: number | null } | undefined) : undefined;
  const lateRuleText = lateRule?.lateReturnRule && lateRule.lateReturnRule in LATE_RETURN_RULES ? `${LATE_RETURN_RULES[lateRule.lateReturnRule]}${lateRule.lateReturnRule === "CONFIGURED_FEE" && lateRule.lateReturnFeeCents ? ` (Richtwert ${fmtCents(lateRule.lateReturnFeeCents)})` : ""}` : null;
  const history = await bookingTimeline(tenant.id, b.id, 60);
  // Befehl 21: „Was ist als Nächstes zu tun?“ – eine deutliche Aktion je Stand, abgeleitet aus denselben Regeln wie die Kopfzeile
  const pickupNext = pickupAction(b, b.contract, b.handovers);
  const returnNext = returnAction(b, b.contract, b.handovers);
  const canContract = user.role !== "YARD";
  // Phase E: Vertrag, Übergabe und Rückgabe laufen beim Unfallersatz über die normalen Schritte; die Fallakte übernimmt Abrechnung und
  // Abschluss. Ein geschlossener Fall sperrt alle operativen Schritte.
  const accidentStep: { title: string; text: string; action: React.ReactNode } | null = accident && caseLocked
    ? { title: `Unfallersatzfall ${accidentCase!.caseNumber} abgeschlossen`, text: `${ACCIDENT_CASE_CLOSED_MESSAGE} Vertrag, Übergabe und Rückgabe sind gesperrt, bis der Fall in der Fallakte wieder geöffnet wird.`, action: caseHref ? <Link href={caseHref} className="btn btn-primary !py-3 !px-5 !text-[15px] justify-center">Unfallersatzfall öffnen</Link> : null }
    : accident && caseHref && b.status === "RETURNED"
      ? { title: `Unfallersatzfall ${accidentCase!.caseNumber}`, text: "Die Rückgabe ist abgeschlossen. Abrechnung, Zahlungen und Kürzungen stehen in der Fallakte; der Fall bleibt offen, bis er bewusst abgeschlossen wird.", action: <Link href={caseHref} className="btn btn-primary !py-3 !px-5 !text-[15px] justify-center">Unfallersatzfall öffnen</Link> }
      : null;
  const nextStep: { title: string; text: string; action: React.ReactNode } | null = accidentStep ??
    (stage === "NEEDS_CONTRACT" ? { title: "Mietvertrag fehlt", text: canContract ? (accident ? "Für diese Unfallersatz-Buchung gibt es noch keinen Mietvertrag. Er läuft bis zur Rückgabe (Mietende offen); ohne Vertrag ist keine Übergabe möglich." : "Für diese Buchung gibt es noch keinen Mietvertrag. Ohne Vertrag ist keine Übergabe möglich.") : "Der Mietvertrag wird von der Disposition erstellt. Danach kann die Übergabe beginnen.", action: canContract ? <form action={startContract}><button className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">Mietvertrag erstellen</button></form> : null }
    : stage === "CONTRACT_DRAFT" ? { title: "Mietvertrag noch nicht abgeschlossen", text: canContract ? (accident ? "Der Unfallersatz-Vertrag (Mietende offen, Tarif aus der Fallakte) ist vorbereitet. Bitte prüfen, unterschreiben lassen und abschließen." : "Der Vertragsentwurf ist angelegt. Bitte prüfen, unterschreiben lassen und abschließen.") : "Die Disposition schließt den Mietvertrag ab. Danach kann die Übergabe beginnen.", action: canContract ? <Link href={`/buchungen/${b.id}/vertrag`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">Mietvertrag fortsetzen</Link> : null }
    : pickupNext.kind === "START" || pickupNext.kind === "CONTINUE" ? { title: "Bereit zur Übergabe", text: "Der Mietvertrag ist abgeschlossen. Jetzt auf dem Tablet mit der Übergabe weitermachen.", action: <Link href={`/buchungen/${b.id}/uebergabe`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">{pickupNext.label}</Link> }
    : returnNext.kind === "START" || returnNext.kind === "CONTINUE" ? { title: overdue ? "Rückgabe überfällig" : "Fahrzeug ist unterwegs", text: "Wenn das Fahrzeug zurückkommt: Rückgabe am besten auf dem Tablet durchführen.", action: <Link href={`/buchungen/${b.id}/rueckgabe`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">{returnNext.label}</Link> }
    : b.status === "RETURNED" && returnDone && invoice?.status !== "FINALIZED" && !accident ? { title: invoice ? "Rechnung noch nicht abgeschlossen" : "Rechnung fehlt", text: canContract ? "Die Rückgabe ist abgeschlossen. Die Rechnung wird am PC geprüft und finalisiert." : "Die Rechnung wird von der Disposition erstellt.", action: canContract ? <Link href={`/buchungen/${b.id}/rechnung`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">{invoice ? "Rechnung fortsetzen" : "Rechnung erstellen"}</Link> : null }
    : null);

  return (
    <>
      <PageHeader title={`Buchung ${b.number}`} sub={<Plate>{b.vehicle.plate}</Plate>}>
        {overdue ? <Chip tone="bad">Rückgabe überfällig</Chip> : <BookingStageChip stage={stage} />}
        {accident && <Chip tone="info">Unfallersatz{accidentCase ? ` ${accidentCase.caseNumber}` : ""}</Chip>}
        {caseHref && <Link href={caseHref} className="btn btn-primary">Unfallersatzfall öffnen</Link>}
        {stage === "NEEDS_CONTRACT" && user.role !== "YARD" && !caseLocked && <form action={startContract}><button className="btn btn-primary">Mietvertrag erstellen</button></form>}
        {stage === "CONTRACT_DRAFT" && user.role !== "YARD" && !caseLocked && <Link href={`/buchungen/${b.id}/vertrag`} className="btn btn-primary">Mietvertrag fortsetzen</Link>}
        {caseLocked && <Chip tone="grey">Fall abgeschlossen – gesperrt</Chip>}
        {(stage === "NEEDS_CONTRACT" || stage === "CONTRACT_DRAFT") && user.role === "YARD" && <Chip tone="amber">Mietvertrag wird von der Disposition erstellt</Chip>}
        {b.contract && b.contract.status !== "DRAFT" && <Link href={`/buchungen/${b.id}/vertrag`} className="btn">Mietvertrag anzeigen</Link>}
        {stage === "READY_FOR_PICKUP" && !caseLocked && <Link href={`/buchungen/${b.id}/uebergabe`} className="btn btn-primary">{pickupDraft ? "Übergabe fortsetzen" : "Übergabe starten"}</Link>}
        {pickupDone && <Link href={`/buchungen/${b.id}/uebergabe`} className="btn">Übergabeprotokoll anzeigen</Link>}
        {b.status === "ACTIVE" && pickupDone && !returnDone && !caseLocked && <Link href={`/buchungen/${b.id}/rueckgabe`} className="btn btn-primary">{returnDraft ? "Rückgabe fortsetzen" : "Rückgabe starten"}</Link>}
        {returnDone && <Link href={`/buchungen/${b.id}/rueckgabe`} className="btn">Rückgabeprotokoll anzeigen</Link>}
        {b.status === "RETURNED" && returnDone && !invoice && user.role !== "YARD" && !accident && <Link href={`/buchungen/${b.id}/rechnung`} className="btn btn-primary">Rechnung erstellen</Link>}
        {invoice?.status === "DRAFT" && user.role !== "YARD" && <Link href={`/buchungen/${b.id}/rechnung`} className="btn btn-primary">Rechnung fortsetzen</Link>}
        {invoice?.status === "FINALIZED" && <Link href={`/buchungen/${b.id}/rechnung`} className="btn">Rechnung {invoice.number} anzeigen</Link>}
        {b.status === "ACTIVE" && !pickupDone && !caseLocked && (
          <form action={finish}><button className="btn btn-primary">Fahrzeug zurücknehmen</button></form>
        )}
        {canChangePeriod && <PeriodChangeDialog action={changePeriodAction.bind(null, b.id)} preview={previewPeriodChangeAction.bind(null, b.id)} startAt={toDateTimeInput(b.startAt)} endAt={toDateTimeInput(b.endAt)} />}
        {cancelView && (
          <CancelBookingDialog
            action={cancelBookingAction.bind(null, b.id)}
            preview={previewCancellationAction.bind(null, b.id)}
            view={cancelView}
          />
        )}
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <Chip tone="good">Gespeichert</Chip>}
        {sp.fehler === "status" && <Chip tone="bad">Dieser Statuswechsel ist nicht möglich.</Chip>}
        {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
        {sp.zurueckgenommen === "1" && <p role="status" className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">Die vereinbarte Vertragsänderung wurde zurückgenommen. Der Mietvertrag gilt unverändert; die Reservierung ist aufgehoben.</p>}
        {sp.storniert === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Die Buchung ist storniert. Abrechnung, Belege und Kaution sind unten zusammengefasst.</p>}
        {sp.zeitraum === "1" && <Chip tone="good">Zeitraum geändert</Chip>}
        <CancellationPanel tenantId={tenant.id} bookingId={b.id} role={user.role} supportMode={Boolean(supportSession)} />
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
        {agreed && (
          <section aria-label="Vertragsänderung vereinbart – Unterschrift fehlt" className="rounded-xl border-2 border-amber bg-amber-soft/60 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0 text-sm">
              <div className="font-semibold text-amber">Vertragsänderung vereinbart – Unterschrift fehlt</div>
              <p>{agreed.agreedChannel ? AMENDMENT_AGREED_CHANNELS[agreed.agreedChannel as keyof typeof AMENDMENT_AGREED_CHANNELS] : "Vorab"} vereinbart{agreed.agreedAt ? ` am ${fmtDateTime(agreed.agreedAt)}` : ""}{agreed.agreedByName ? ` von ${agreed.agreedByName}` : ""}.{agreed.newEndAt ? <> Fahrzeug reserviert bis <b className="font-mono tnum">{fmtDateTime(agreed.newEndAt)}</b>.</> : null} Vertrag, Preis und Rechnung gelten erst nach der Unterschrift.</p>
            </div>
            {user.role !== "YARD" && !supportSession && <Link href={`/buchungen/${b.id}/nachtrag/${agreed.id}#unterschrift`} className="btn btn-primary !py-3 justify-center">Unterschrift nachholen</Link>}
          </section>
        )}
        {overdue && contractSigned && (
          <section aria-label="Rückgabe überfällig" className="rounded-xl border-2 border-bad bg-bad-soft/60 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0 text-sm">
              <div className="font-semibold text-bad">Rückgabe überfällig – geplant {fmtDateTime(agreed?.newEndAt && b.endAt && agreed.newEndAt > b.endAt ? agreed.newEndAt : b.endAt)}</div>
              {accident && caseLocked ? <p>Das geplante Mietende (nur Disposition) ist überschritten. Der Unfallersatzfall ist abgeschlossen; Mietdauer und Rückgabe sind gesperrt, bis der Fall wieder geöffnet wird.</p> : accident ? <p>Das geplante Mietende (nur Disposition) ist überschritten. Beim Unfallersatz entsteht dadurch keine Verspätungsgebühr und kein Nachtrag – der Vertrag läuft bis zur Rückgabe. Mietdauer in der Fallakte aktualisieren oder die Rückgabe durchführen.</p> : <p>Ruft der Kunde an und verlängert, die Verlängerung hier erfassen – Folgebuchungen werden dabei sofort geprüft.{lateRuleText ? ` Vertragliche Verspätungsregel: ${lateRuleText}. Ein Betrag wird erst bei der Rückgabe als Vorschlag gezeigt und nur nach Bestätigung berechnet.` : ""}</p>}
            </div>
            {user.role !== "YARD" && !supportSession && !agreed && !accident && <form action={createAmendmentAction.bind(null, b.id)}><input type="hidden" name="nonce" value={randomUUID()} /><button className="btn btn-primary !py-3 justify-center w-full">Miete verlängern</button></form>}
            {user.role !== "YARD" && !supportSession && accident && caseHref && accidentCase?.status === "OPEN" && <Link href={`${caseHref}?tab=miete#mietdauer`} className="btn btn-primary !py-3 justify-center">Mietdauer in der Fallakte aktualisieren</Link>}
          </section>
        )}
        {b.status === "ACTIVE" && pickupDone && !caseLocked && (
          <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">Übergeben mit Protokoll {pickupDone.number}. Die Rückgabe läuft über „Rückgabe starten“ und vergleicht den Zustand mit der Übergabe.</p>
        )}
        {b.status === "RETURNED" && returnDone && (
          <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm">Zurückgegeben mit Protokoll {returnDone.number}. Übergabe {pickupDone?.number ?? "–"}. <Link href={`/fahrzeuge/${b.vehicleId}`} className="underline">Fahrzeughistorie ansehen</Link>.</p>
        )}
        {b.status === "RETURNED" && returnDone && accident && caseHref && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="label-xs">Abrechnung</span>
            <Link href={`${caseHref}?tab=abrechnung`} className="chip bg-info-soft text-info hover:underline">Unfallersatz-Abrechnung in der Fallakte</Link>
          </div>
        )}
        {b.status === "RETURNED" && returnDone && !accident && (
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
        {contractSigned && b.status === "RESERVED" && !caseLocked && (
          <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Mietvertrag {b.contract!.number} ist abgeschlossen. Die Buchung ist bereit zur Übergabe.</p>
        )}

        {(b.status === "ACTIVE" || b.status === "RETURNED") && pickupDone && <KeyDropPanel tenantId={tenant.id} booking={{ id: b.id, status: b.status, endAt: b.endAt, vehicleId: b.vehicleId }} role={user.role} supportMode={Boolean(supportSession)} returnStarted={Boolean(returnDraft || returnDone)} locked={caseLocked} />}
        {/* Befehl 25: Vertrag & Nachträge – Änderungen während der Miete nur als unterschriebener Nachtrag */}
        <AmendmentsCard tenantId={tenant.id} bookingId={b.id} role={user.role} supportMode={Boolean(supportSession)} locked={caseLocked} />
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
                periodLocked
                periodChangeable={canChangePeriod}
              />
            ) : (
              <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
                {contractSigned && accident && <><dt className="label-xs self-center">Vertrag</dt><dd>{b.contract!.number}. Mietende offen (bis zur Rückgabe), Tarif laut Vertrag festgeschrieben. Das geplante Ende ist nur Disposition und wird in der Fallakte geändert; Kilometer, Kaution und Fahrer per <a href="#vertrag" className="underline">Nachtrag</a>.</dd></>}
                {contractSigned && !accident && <><dt className="label-xs self-center">Vertrag</dt><dd>{b.contract!.number}. Zeitraum, Fahrzeug und Preis sind festgeschrieben{effective?.amendments.length ? <>; geändert durch Nachtrag {effective.amendments.map((a) => a.number).join(", ")} (siehe <a href="#vertrag" className="underline">Vertrag &amp; Nachträge</a>)</> : <>. Änderungen nur per <a href="#vertrag" className="underline">Nachtrag</a></>}.</dd></>}
                <dt className="label-xs self-center">Kunde</dt><dd><Link href={`/kunden/${b.customerId}`} className="hover:underline font-medium">{customerName(b.customer)}</Link></dd>
                <dt className="label-xs self-center">Fahrzeug</dt><dd><Link href={`/fahrzeuge/${b.vehicleId}`} className="hover:underline">{b.vehicle.make} {b.vehicle.model}</Link></dd>
                <dt className="label-xs self-center">Abholung</dt><dd className="font-mono tnum">{fmtDateTime(b.startAt)}</dd>
                <dt className="label-xs self-center">Rückgabe</dt><dd className="font-mono tnum">{b.endAt ? fmtDateTime(b.endAt) : accident ? "offen (bis zur Rückgabe)" : "–"}{effective?.changedBy.endAt && <span className="block text-[11px] text-ink-3 font-sans">geändert durch {effective.changedBy.endAt}</span>}</dd>
                <dt className="label-xs self-center">Kilometer</dt><dd className="font-mono tnum">{effective ? <>{effective.kmIncludedPerDay.toLocaleString("de-DE")} km/Tag frei · {fmtEur(effective.extraKmRate)} je Mehrkilometer (laut Vertrag{effective.changedBy.km ? `, geändert durch ${effective.changedBy.km}` : ""})</> : <>{(b.kmIncludedPerDay ?? b.vehicle.kmIncludedPerDay).toLocaleString("de-DE")} km/Tag frei · {fmtEur(Number(b.extraKmRate ?? b.vehicle.extraKmRate))} je Mehrkilometer</>}</dd>
                <dt className="label-xs self-center">Notizen</dt><dd>{b.notes || "–"}</dd>
              </dl>
            )}
          </Card>
          {/* Mietzahlung und Kaution bleiben getrennt: gemeinsamer Überblick (Befehl 20.7), eigene Bereiche, keine automatische Verrechnung */}
          <MoneyOverview tenantId={tenant.id} bookingId={b.id} role={user.role} accident={accident} />
          {/* Befehl 29: beim Unfallersatz keine Mietvorauszahlung – Zahlungen gehören zur Unfallersatz-Rechnung */}
          {!accident && <RentalPaymentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} />}
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
                  <div className="flex justify-between py-1.5 text-ink-3"><span>Kaution laut Buchung</span><span className="font-mono tnum">{accident && !(Number(b.deposit) > 0) ? "keine" : fmtEur(b.deposit)}</span></div>
                  <p className="text-xs text-ink-3 mt-1">Zusatzkosten und Kaution werden nicht automatisch verrechnet. Stand der Kaution siehe Bereich „Kaution“.</p>
                </div>
              </Card>
            )}
            <Card title="Kosten">
              {accident && b.status !== "CANCELLED" ? (
                <div className="p-4 text-sm flex flex-col">
                  <div className="text-xs text-ink-3 pb-1">Unfallersatz{accidentCase ? ` · Fall ${accidentCase.caseNumber}` : ""}</div>
                  <div className="flex justify-between py-1.5 border-b border-line-soft"><span>Tagessatz</span><span className="font-mono tnum">{fmtCents(accidentTariff?.dailyRateCents ?? Math.round(Number(b.dailyRate) * 100))} je Miettag</span></div>
                  {accidentTariff && accidentPerDayCents !== accidentTariff.dailyRateCents && <div className="flex justify-between py-1.5 border-b border-line-soft"><span>Je Miettag mit Tarifpositionen</span><span className="font-mono tnum">{fmtCents(accidentPerDayCents)}</span></div>}
                  <div className="flex justify-between py-1.5 border-b border-line-soft"><span>Mietende</span><span className="font-mono tnum">{b.actualReturnAt ? `zurückgegeben ${fmtDateTime(b.actualReturnAt)}` : b.endAt ? `geplant ${fmtDateTime(b.endAt)}` : "offen"}</span></div>
                  {accidentRent && accidentRent.phase !== "NONE"
                    ? <div className="flex justify-between py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>{accidentRent.phase === "FINAL" ? "Endwert" : "Bisher"} ({accidentRent.value.days} {accidentRent.value.days === 1 ? "Miettag" : "Miettage"}{accidentRent.phase === "RUNNING" ? ", Stand jetzt" : ""})</span><span className="font-mono tnum">{fmtCents(accidentRent.value.cents)}</span></div>
                    : <div className="flex justify-between py-2 mt-1 border-t-2 border-ink text-ink-3"><span>Mietwert</span><span>noch kein Ist-Wert</span></div>}
                  <div className="flex justify-between py-1.5 text-ink-3"><span>zzgl. Kaution</span><span className="font-mono tnum">{Number(b.deposit) > 0 ? fmtEur(b.deposit) : "keine"}</span></div>
                  <p className="text-xs text-ink-3 mt-2">Abgerechnet wird nach tatsächlichen Miettagen ab der Übergabe zum Tarif laut Mietvertrag (Tagessatz und Positionen des Falls). Kein Gesamtpreis im Voraus.</p>
                </div>
              ) : b.status === "CANCELLED" ? (
                <p className="p-4 text-sm text-ink-2">Die Buchung ist storniert; es besteht keine Mietforderung mehr. Vorauszahlung, Stornogebühr, Erstattung und Kaution stehen in der eingefrorenen Storno-Abrechnung oben.</p>
              ) : effective ? (
                <div className="p-4 text-sm flex flex-col">
                  <div className="text-xs text-ink-3 pb-1">laut Mietvertrag {b.contract!.number}{effective.amendments.length ? ` und Nachtrag ${effective.amendments.map((a) => a.number).join(", ")}` : ""}</div>
                  <div className="flex justify-between py-1.5 border-b border-line-soft"><span>Mietpreis laut Vertrag</span><span className="font-mono tnum">{fmtEur(effective.original.totalCents / 100)}</span></div>
                  {effective.amendments.filter((a) => a.priceDeltaCents).map((a) => (
                    <div key={a.id} className="flex justify-between py-1.5 border-b border-line-soft"><span>Nachtrag {a.number}</span><span className="font-mono tnum">{(a.priceDeltaCents ?? 0) > 0 ? "+" : "−"}{fmtEur(Math.abs(a.priceDeltaCents ?? 0) / 100)}</span></div>
                  ))}
                  <div className="flex justify-between py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>Gesamtmietpreis</span><span className="font-mono tnum">{fmtEur(effective.totalCents / 100)}</span></div>
                  <div className="flex justify-between py-1.5 text-ink-3"><span>zzgl. vereinbarte Kaution</span><span className="font-mono tnum">{fmtEur(effective.depositCents / 100)}</span></div>
                  <p className="text-xs text-ink-3 mt-2">Mehrkilometer, Tank und weitere Positionen werden bei der Rückgabe geprüft und erscheinen dann als Zusatzkosten.</p>
                </div>
              ) : (
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
              )}
            </Card>
            {/* Befehl 28: Änderungshistorie aus gespeicherten Zeitstempeln und Audit (dieselbe Ableitung wie die Kundenakte) */}
            <Card title="Verlauf" right={<span className="text-xs text-ink-3">{history.length} Einträge</span>}>
              {history.length === 0 ? <p className="p-4 text-sm text-ink-3">Noch keine Einträge.</p> : (
                <ol className="divide-y divide-line-soft text-sm max-h-[420px] overflow-y-auto">
                  {history.map((h) => (
                    <li key={h.key} className="px-4 py-2 flex flex-col gap-0.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2"><span className="font-medium">{h.href ? <Link href={h.href} className="hover:underline">{h.title}</Link> : h.title}</span><span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(h.at)}</span></div>
                      <div className="text-xs text-ink-3"><span className="chip !py-0 mr-1.5">{h.kind}</span>{h.detail}</div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <Card title="Kunde">
              <div className="p-4 text-sm flex flex-col gap-1">
                <Link href={`/kunden/${b.customerId}`} className="font-medium hover:underline">{customerName(b.customer)}</Link>
                {b.customer.phone && <span>{b.customer.phone}</span>}
                {b.customer.email && <span className="text-ink-3">{b.customer.email}</span>}
                {!b.customer.licenseNumber && <Chip tone="amber">Führerschein noch nicht erfasst</Chip>}
                {b.customer.licenseValidUntil && b.endAt && b.customer.licenseValidUntil < b.endAt && <Chip tone="bad">Führerschein läuft vor Rückgabe ab</Chip>}
              </div>
            </Card>
          </div>
        </div>
      </Content>
    </>
  );
}

import Link from "next/link";
import { Fragment } from "react";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { bookingStage } from "@/lib/booking-status";
import { getHandoverState } from "@/lib/handovers";
import { buildHandoverDocument } from "@/lib/handover-view";
import { getReturnComparison, fmtMinutes } from "@/lib/returns";
import { loadDocKeyDrop, loadHandoverContext } from "@/lib/document-data";
import { keyDropForBooking } from "@/lib/key-drop";
import { KeyDropExceptionForm, ReturnTimeOverrideForm } from "./key-drop-parts";
import { keyDropFindingsForHandover } from "@/lib/document-data";
import { toDateTimeInputValue } from "@/lib/time";
import { storageStatus } from "@/lib/storage";
import { FUELS, PHOTO_CATEGORIES, REQUIRED_PHOTO_CATEGORIES, energyRequirements, type Fuel, type PhotoCategory } from "@/lib/constants";
import { customerName, fmtDateTime, fmtEur, fmtInt } from "@/lib/format";
import { BookingStageChip, Card, Chip, Content, Field, PageHeader, Plate } from "@/components/ui";
import { FinalizeForm, SignatureForm, StepForm, WizardProgress } from "../vertrag/wizard-ui";
import { FuelGauge, HandoverDocumentView, HandoverIssueList, KeyDropCustomerCard, RETURN_STEPS } from "../uebergabe/handover-parts";
import { PhotoUploader } from "../uebergabe/photo-uploader";
import { DocumentsPanel } from "../dokumente/documents-panel";
import { DamageCasesPanel } from "../../../schaeden/damages-panel";
import { FollowUpNotice } from "../dokumente/follow-up-notice";
import { getHandoverCompletionStatus } from "@/lib/completion";
import { CompletionCard } from "../uebergabe/completion-card";
import {
  addChargeAction,
  addDamageAction,
  confirmProposalAction,
  finalizeReturnAction,
  navigateStepAction,
  removeChargeAction,
  removeDamageAction,
  removeSignatureAction,
  saveChecklistAction,
  saveEnergyAction,
  saveMileageAction,
  saveSignatureAction,
  startReturnAction,
  updateDamageAction,
} from "./actions";
import { ChargesEditor, CompareDamages, ComparePhotos, ReturnSummary } from "./return-parts";

export const metadata = { title: "Rückgabe" };

export default async function ReturnPage({ params, searchParams }: PageProps<"/buchungen/[id]/rueckgabe">) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const { id } = await params;
  const sp = await searchParams;

  const b = await db.booking.findFirst({
    where: { id, tenantId: tenant.id },
    include: {
      vehicle: { include: { group: true } },
      customer: true,
      contract: { include: { drivers: true } },
      handovers: { where: { correctsId: null }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!b) notFound();
  const stage = bookingStage(b, b.contract);
  const pickup = b.handovers.find((h) => h.type === "PICKUP" && h.status === "FINALIZED");
  const existing = b.handovers.find((h) => h.type === "RETURN");

  if (!existing) {
    const canStart = stage === "ACTIVE" && !!pickup && b.contract?.status === "SIGNED";
    // Befehl 20.6: vereinbarte kontaktlose Rückgabe – Kontrolle erst nach Kundenmeldung (oder mit dokumentierter Ausnahme)
    const kd = canStart ? (await keyDropForBooking(tenant.id, b.id)).keyDrop : null;
    if (kd && (kd.status === "AUTHORIZED" || kd.status === "CUSTOMER_CONFIRMED")) {
      const confirmed = kd.status === "CUSTOMER_CONFIRMED";
      return (
        <>
          <PageHeader title="Schlüsselbox-Rückgabe prüfen" sub={`Buchung ${b.number}`}>
            <BookingStageChip stage={stage} />
            <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
          </PageHeader>
          <Content>
            {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
            <Card className="p-5 max-w-2xl flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2"><Plate>{b.vehicle.plate}</Plate><span className="font-medium">{b.vehicle.make} {b.vehicle.model}</span><span className="text-ink-3">von {customerName(b.customer)}</span></div>
              {confirmed ? (
                <>
                  <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 font-medium">Kontaktlos zurückgegeben – Kontrolle ausstehend. Abgabe laut Kunde: {fmtDateTime(kd.customerDropOffAt)}, {kd.customerMileage != null ? `${fmtInt(kd.customerMileage)} km` : "–"}.</p>
                  <p className="text-sm text-ink-2">Die Kontrolle läuft über den bekannten Rückgabe-Assistenten. Die Angaben des Kunden werden daneben angezeigt, aber nie übernommen oder überschrieben. Der Kunde unterschreibt nicht unter die Feststellungen der Kontrolle.</p>
                  <form action={startReturnAction.bind(null, b.id)}><button className="btn btn-primary !py-2.5 !px-5">Schlüsselbox-Rückgabe prüfen</button></form>
                </>
              ) : (
                <>
                  <p className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">Für diese Miete ist eine kontaktlose Rückgabe vereinbart. Der Kunde hat die Abgabe noch nicht gemeldet.</p>
                  <p className="text-sm text-ink-2">Bringt der Kunde das Fahrzeug doch persönlich, zuerst auf der Buchung die kontaktlose Rückgabe aufheben – danach ist die normale Rückgabe möglich.</p>
                  {user.role !== "YARD" ? <KeyDropExceptionForm bookingId={b.id} /> : <p className="text-xs text-ink-3">Eine Kontrolle ohne Kundenmeldung kann nur Inhaber oder Disposition mit Begründung starten.</p>}
                </>
              )}
            </Card>
          </Content>
        </>
      );
    }
    return (
      <>
        <PageHeader title="Rückgabe" sub={`Buchung ${b.number}`}>
          <BookingStageChip stage={stage} />
          <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content>
          {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
          <Card className="p-5 max-w-2xl flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2"><Plate>{b.vehicle.plate}</Plate><span className="font-medium">{b.vehicle.make} {b.vehicle.model}</span><span className="text-ink-3">von {customerName(b.customer)}</span></div>
            {canStart ? (
              <>
                <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 font-medium">Der Rückgabezustand wird mit dem dokumentierten Übergabezustand ({pickup!.number}) verglichen.</p>
                <p className="text-sm text-ink-2">Geplante Rückgabe: {fmtDateTime(b.endAt)}. Der Assistent führt durch Kilometer, Tank, Fahrzeugzustand im Vorher-/Nachher-Vergleich, Fotos, Checkliste, Zusatzkosten und Unterschrift. Erst das finalisierte Protokoll setzt die Buchung auf „Zurückgegeben“.</p>
                <form action={startReturnAction.bind(null, b.id)}><button className="btn btn-primary !py-2.5 !px-5">Rückgabe starten</button></form>
              </>
            ) : stage === "ACTIVE" ? (
              <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">Zu dieser Miete gibt es {b.contract?.status !== "SIGNED" ? "keinen abgeschlossenen Mietvertrag" : "kein abgeschlossenes Übergabeprotokoll"}. Ohne dokumentierten Übergabezustand ist keine Rückgabe über den Assistenten möglich.</p>
            ) : (
              <p className="text-sm text-ink-2">Eine Rückgabe ist nur für Fahrzeuge möglich, die unterwegs sind. Diese Buchung steht auf „{stage === "RETURNED" ? "Zurückgegeben" : stage === "CANCELLED" ? "Storniert" : "noch nicht übergeben"}“.</p>
            )}
          </Card>
        </Content>
      </>
    );
  }

  const state = await getHandoverState(tenant.id, existing.id);
  const { handover, signatures, sketch, issues, hash } = state;
  const context = await loadHandoverContext(tenant.id, handover);
  const comparison = await getReturnComparison(tenant.id, handover.id).catch(() => null);
  const keyDrop = await loadDocKeyDrop(tenant.id, handover);
  const kdRaw = handover.keyDropId ? await db.keyDropReturn.findFirst({ where: { id: handover.keyDropId, tenantId: tenant.id }, select: { customerMileage: true, customerFuelEighths: true, customerBatteryPercent: true, customerNewDamages: true, customerDamageNote: true, customerDropOffAt: true } }) : null;
  const doc = buildHandoverDocument(handover, sketch, signatures, REQUIRED_PHOTO_CATEGORIES, context, comparison, [], keyDrop?.doc ?? null);
  const isKeyDrop = handover.returnMode === "KEY_DROP";
  const findings = isKeyDrop ? await keyDropFindingsForHandover(tenant.id, handover) : [];
  const findingList = (kinds: string[]) => {
    const rows = findings.filter((f) => kinds.includes(f.kind));
    return rows.length > 0 ? <div role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm"><div className="font-medium">Abweichung zur Angabe des Kunden</div><ul className="list-disc pl-5">{rows.map((f) => <li key={f.code}>{f.message}</li>)}</ul></div> : null;
  };
  const customerSays = (text: string) => <p className="rounded-md bg-info-soft text-info px-3 py-2 text-sm"><span className="font-medium">Angabe des Kunden:</span> {text} <span className="text-xs">(wird nicht übernommen – bitte selbst ablesen)</span></p>;

  if (handover.status === "FINALIZED") {
    return (
      <>
        <PageHeader title={`Rückgabeprotokoll ${handover.number}`} sub={`Buchung ${b.number}`}>
          <BookingStageChip stage={stage} />
          <Link href={`/fahrzeuge/${b.vehicleId}`} className="btn">Fahrzeughistorie</Link>
          <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content>
          {sp.abgeschlossen === "1" && <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">Die Rückgabe ist abgeschlossen und versiegelt. {b.vehicle.plate} ist zurück und die Buchung steht auf „Zurückgegeben“.</p>}
          {sp.abgeschlossen === "1" && <FollowUpNotice tenantId={tenant.id} bookingId={b.id} handoverId={handover.id} kind="RETURN" />}
          <DocumentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} />
          <DamageCasesPanel tenantId={tenant.id} where={{ discoveredInHandoverId: handover.id }} title="Bei dieser Rückgabe neu festgestellte Schäden" empty="Bei dieser Rückgabe wurden keine neuen Schäden festgestellt." />
          <HandoverDocumentView doc={doc} handoverId={handover.id} />
        </Content>
      </>
    );
  }

  // Übergabezustand für den Vergleich, unveränderlich
  const pickupState = pickup ? await getHandoverState(tenant.id, pickup.id) : null;
  const pickupDoc = pickupState ? buildHandoverDocument(pickupState.handover, pickupState.sketch, pickupState.signatures, REQUIRED_PHOTO_CATEGORIES, context) : null;

  const reached = Math.max(1, handover.wizardStep);
  const requested = typeof sp.schritt === "string" ? parseInt(sp.schritt, 10) : reached;
  const step = Math.min(9, Math.max(1, Number.isFinite(requested) ? requested : reached));
  const energy = energyRequirements(handover.driveType);
  const storage = storageStatus();
  const renterSig = signatures.find((s) => s.role === "RENTER");
  const employeeSig = signatures.find((s) => s.role === "EMPLOYEE");
  const completion = step === 9 ? await getHandoverCompletionStatus(tenant.id, handover.id) : null!;
  const byCategory = (d: typeof doc | null, c: string) => (d ? d.photos.filter((p) => p.category === c).map((p) => ({ id: p.id, url: p.url })) : []);
  const primaryDriver = b.contract?.drivers.find((d) => d.role === "PRIMARY_DRIVER");
  const items = [...handover.checklistItems].sort((x, y) => x.sortOrder - y.sortOrder);
  const pickupAnswers = new Map((pickupState?.handover.checklistItems ?? []).map((c) => [c.itemKey, c]));
  const base = `/buchungen/${b.id}/rueckgabe`;
  const cmp = comparison;
  const late = cmp && cmp.time.lateMinutes > 15 ? fmtMinutes(cmp.time.lateMinutes) : null;
  const attention = issues.filter((i) => i.code === "CHECKLIST_ATTENTION" || i.code === "ACCESSORY_MISSING").map((i) => i.message);
  const damageActions = { add: addDamageAction.bind(null, b.id), update: updateDamageAction.bind(null, b.id), remove: removeDamageAction.bind(null, b.id) };

  return (
    <>
      <PageHeader title={`Rückgabe ${handover.number}`} sub={`Buchung ${b.number} · ${customerName(b.customer)}`}>
        <Plate>{b.vehicle.plate}</Plate>
        <Chip tone="amber">Entwurf</Chip>
        <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
      </PageHeader>
      <Content className="max-w-6xl">
        <WizardProgress bookingId={b.id} current={step} reached={reached} steps={RETURN_STEPS} basePath={base} />
        <h2 className="text-lg font-semibold -mb-1">Schritt {step} von 9: {RETURN_STEPS[step - 1]}</h2>

        {step === 1 && (
          <>
            <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm font-medium">Der Rückgabezustand wird mit dem dokumentierten Übergabezustand ({pickup?.number}) verglichen.</p>
            {keyDrop && <KeyDropCustomerCard k={keyDrop.doc} />}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <Card title="Miete">
                <dl className="px-4 py-3 grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Mietvertrag</dt><dd className="font-medium"><Link href={`/buchungen/${b.id}/vertrag`} className="hover:underline">{b.contract?.number}</Link></dd>
                  <dt className="text-ink-3">Mieter</dt><dd className="font-medium">{customerName(b.customer)}</dd>
                  <dt className="text-ink-3">Fahrer</dt><dd>{primaryDriver ? `${primaryDriver.firstName} ${primaryDriver.lastName}` : "–"}</dd>
                  <dt className="text-ink-3">Abholung tatsächlich</dt><dd className="font-mono tnum">{fmtDateTime(b.actualPickupAt ?? pickup?.finalizedAt)}</dd>
                  <dt className="text-ink-3">Geplante Rückgabe</dt><dd className="font-mono tnum">{fmtDateTime(b.endAt)}</dd>
                  <dt className="text-ink-3">{isKeyDrop ? "Abgabe laut Kunde" : "Aktuelle Rückgabezeit"}</dt><dd className="font-mono tnum">{fmtDateTime(cmp?.time.actualEnd ?? new Date())}{late && <span className="ml-2 chip bg-amber-soft text-amber">{late} später</span>}</dd>
                  <dt className="text-ink-3">Kaution</dt><dd className="font-mono tnum">{fmtEur(cmp?.contract.deposit ?? Number(b.contract?.deposit ?? 0))}</dd>
                  <dt className="text-ink-3">Selbstbeteiligung</dt><dd className="font-mono tnum">{fmtEur(cmp?.contract.deductible ?? Number(b.contract?.deductible ?? 0))}</dd>
                  <dt className="text-ink-3">Tankregelung</dt><dd>{cmp?.contract.fuelPolicyLabel}{cmp?.contract.fuelPolicy === "OTHER" && cmp.contract.fuelPolicyNote ? `: ${cmp.contract.fuelPolicyNote}` : ""}</dd>
                </dl>
              </Card>
              <Card title="Fahrzeug und Übergabezustand">
                <dl className="px-4 py-3 grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Kennzeichen</dt><dd><Plate>{b.vehicle.plate}</Plate></dd>
                  <dt className="text-ink-3">Fahrzeug</dt><dd className="font-medium">{b.vehicle.make} {b.vehicle.model}</dd>
                  <dt className="text-ink-3">Antrieb</dt><dd>{FUELS[handover.driveType as Fuel] ?? handover.driveType}</dd>
                  <dt className="text-ink-3">Übergabe-Kilometer</dt><dd className="font-mono tnum">{cmp?.mileage.pickup != null ? `${fmtInt(cmp.mileage.pickup)} km` : "–"}</dd>
                  {cmp?.fuel && <><dt className="text-ink-3">Übergabe-Tank</dt><dd className="font-mono tnum">{cmp.fuel.pickup != null ? `${cmp.fuel.pickup}/8` : "–"}</dd></>}
                  {cmp?.battery && <><dt className="text-ink-3">Übergabe-Batterie</dt><dd className="font-mono tnum">{cmp.battery.pickup != null ? `${cmp.battery.pickup} %` : "–"}</dd></>}
                  <dt className="text-ink-3">Dokumentierte Schäden</dt><dd>{doc.damages.filter((d) => d.marker !== "NEW").length}</dd>
                  <dt className="text-ink-3">Mitarbeiter</dt><dd>{handover.employeeName}</dd>
                </dl>
              </Card>
            </div>
            {!storage.configured && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">Der Dateispeicher ist noch nicht eingerichtet. Ohne Pflichtfotos kann die Rückgabe nicht abgeschlossen werden.</p>}
            <p className="text-xs text-ink-3">Jeder Schritt wird sofort gespeichert. Die Rückgabe kann unterbrochen und später fortgesetzt werden.</p>
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 1)} step={1} nextLabel="Rückgabe beginnen"><span className="sr-only">Übersicht</span></StepForm></Card>
          </>
        )}

        {step === 2 && (
          <>
            {isKeyDrop && (
              <Card title="Maßgebliches Mietende" right={handover.returnTimeOverrideAt ? <Chip tone="amber">korrigiert</Chip> : <Chip tone="info">Abgabe laut Kunde</Chip>}>
                <div className="p-4 flex flex-col gap-3 text-sm">
                  <dl className="grid grid-cols-[minmax(150px,40%)_1fr] gap-x-3 gap-y-1.5">
                    <dt className="text-ink-3">Abgabe laut Kunde</dt><dd>{fmtDateTime(handover.customerDropOffAt) || "– (keine Kundenmeldung)"}</dd>
                    {keyDrop?.doc.serverTimes.map((r) => <Fragment key={r.label}><dt className="text-ink-3">{r.label}</dt><dd>{r.value}</dd></Fragment>)}
                    {handover.returnTimeOverrideAt && <><dt className="text-ink-3">Korrigiert auf</dt><dd className="font-medium">{fmtDateTime(handover.returnTimeOverrideAt)} · {handover.returnTimeOverrideByName}: {handover.returnTimeOverrideReason}</dd></>}
                  </dl>
                  <p className="text-xs text-ink-3">Das maßgebliche Mietende bestimmt Mietdauer und Verspätungshinweis. Die Angabe des Kunden bleibt immer unverändert als Beleg erhalten.</p>
                  {user.role !== "YARD" ? <ReturnTimeOverrideForm bookingId={b.id} defaultAt={toDateTimeInputValue(handover.returnTimeOverrideAt ?? handover.customerDropOffAt ?? new Date())} hasOverride={Boolean(handover.returnTimeOverrideAt)} /> : <p className="text-xs text-ink-3">Korrigieren kann nur Inhaber oder Disposition.</p>}
                </div>
              </Card>
            )}
            <HandoverIssueList issues={issues} areas={["READINGS"]} />
            <Card className="p-4 md:p-5">
              <StepForm action={saveMileageAction.bind(null, b.id)} step={2}>
                <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-4 items-start">
                  {isKeyDrop && kdRaw?.customerMileage != null && customerSays(`${fmtInt(kdRaw.customerMileage)} km, abgegeben ${fmtDateTime(kdRaw.customerDropOffAt)}`)}
                  {isKeyDrop && findingList(["MILEAGE", "TIME"])}
                  <Field label={isKeyDrop ? "Kilometerstand laut Kontrolle" : "Rückgabe-Kilometerstand"} htmlFor="mileage" hint="Das Fahrzeug übernimmt den Stand erst mit dem Abschluss der Rückgabe.">
                    <input id="mileage" name="mileage" inputMode="numeric" pattern="[0-9.]*" defaultValue={handover.mileage ?? ""} required className="input tnum !text-xl !font-semibold !min-h-[52px]" placeholder={cmp?.mileage.pickup != null ? String(cmp.mileage.pickup) : ""} />
                  </Field>
                  <div className="card p-3.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm self-stretch">
                    <span className="text-ink-3">Übergabe</span><span className="font-mono tnum text-right">{cmp?.mileage.pickup != null ? `${fmtInt(cmp.mileage.pickup)} km` : "–"}</span>
                    <span className="text-ink-3">Rückgabe</span><span className="font-mono tnum text-right font-semibold">{cmp?.mileage.return != null ? `${fmtInt(cmp.mileage.return)} km` : "noch nicht erfasst"}</span>
                    <span className="text-ink-3">Gefahren</span><span className={`font-mono tnum text-right font-semibold ${cmp?.mileage.driven != null && cmp.mileage.driven < 0 ? "text-bad" : ""}`}>{cmp?.mileage.driven != null ? `${fmtInt(cmp.mileage.driven)} km` : "–"}</span>
                    {cmp && <>
                      <span className="text-ink-3 border-t border-line-soft pt-1.5">Freikilometer</span><span className="font-mono tnum text-right border-t border-line-soft pt-1.5">{fmtInt(cmp.contract.includedKm)} km</span>
                      <span className="text-ink-3">Mehrkilometer</span><span className="font-mono tnum text-right">{cmp.mileage.driven != null ? `${fmtInt(Math.max(0, cmp.mileage.driven - cmp.contract.includedKm))} km` : "–"}</span>
                      <span className="text-ink-3">Preis je Mehrkilometer</span><span className="font-mono tnum text-right">{fmtEur(cmp.contract.extraKmRate)}</span>
                      <span className="text-ink-3">Berechnet</span><span className="font-mono tnum text-right font-semibold">{cmp.proposals.find((p) => p.key === "EXTRA_MILEAGE") ? fmtEur(cmp.proposals.find((p) => p.key === "EXTRA_MILEAGE")!.draft.amount) : fmtEur(0)}</span>
                    </>}
                  </div>
                </div>
                {cmp && (
                  <div className="card p-3.5 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <div><div className="label-xs">Geplant</div><div className="font-mono tnum">{fmtDateTime(cmp.time.plannedEnd)}</div></div>
                    <div><div className="label-xs">Tatsächlich</div><div className="font-mono tnum">{fmtDateTime(cmp.time.actualEnd)}</div></div>
                    <div><div className="label-xs">Verspätung</div><div className={late ? "text-bad font-semibold" : ""}>{late ?? "keine"}</div></div>
                    <p className="sm:col-span-3 text-xs text-ink-3">Mehrkilometer sind zunächst ein Vorschlag und werden in Schritt 7 bestätigt. Eine Verspätungsgebühr ist im Vertrag nicht geregelt und wird nicht automatisch berechnet.</p>
                  </div>
                )}
              </StepForm>
            </Card>
          </>
        )}

        {step === 3 && (
          <>
            <HandoverIssueList issues={issues} areas={["READINGS"]} />
            {isKeyDrop && findingList(["ENERGY"])}
            {isKeyDrop && (kdRaw?.customerFuelEighths != null || kdRaw?.customerBatteryPercent != null) && customerSays([kdRaw?.customerFuelEighths != null ? `Tank ${kdRaw.customerFuelEighths}/8` : null, kdRaw?.customerBatteryPercent != null ? `Batterie ${kdRaw.customerBatteryPercent} %` : null].filter(Boolean).join(", "))}
            <Card className="p-4 md:p-5">
              <StepForm action={saveEnergyAction.bind(null, b.id)} step={3}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {energy.fuel && (
                    <fieldset className="md:col-span-2 flex flex-col gap-1.5">
                      <legend className="label-xs mb-1.5">Tankstand bei Rückgabe in Achteln</legend>
                      <div className="grid grid-cols-9 gap-1">
                        {Array.from({ length: 9 }, (_, n) => (
                          <label key={n} className="cursor-pointer">
                            <input type="radio" name="fuelLevelEighths" value={n} defaultChecked={handover.fuelLevelEighths === n} required className="peer sr-only" />
                            <span className="flex h-12 items-center justify-center rounded-md border border-line bg-panel text-sm font-semibold tnum peer-checked:bg-brand peer-checked:text-brand-ink peer-checked:border-brand peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-info">{n === 0 ? "leer" : n === 8 ? "voll" : `${n}/8`}</span>
                          </label>
                        ))}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
                        <div><div className="text-xs text-ink-3 mb-1">Übergabe: {cmp?.fuel?.pickup != null ? `${cmp.fuel.pickup}/8` : "–"}</div><FuelGauge eighths={cmp?.fuel?.pickup ?? null} /></div>
                        <div><div className="text-xs text-ink-3 mb-1">Rückgabe: {handover.fuelLevelEighths != null ? `${handover.fuelLevelEighths}/8` : "–"}{cmp?.fuel?.diff != null && <span className={`ml-2 font-semibold ${cmp.fuel.diff < 0 ? "text-bad" : "text-good"}`}>({cmp.fuel.diff > 0 ? "+" : cmp.fuel.diff < 0 ? "−" : "±"}{Math.abs(cmp.fuel.diff)}/8)</span>}</div><FuelGauge eighths={handover.fuelLevelEighths} /></div>
                      </div>
                    </fieldset>
                  )}
                  {energy.battery && (
                    <>
                      <Field label="Batteriestand bei Rückgabe in %" htmlFor="batteryPercent">
                        <input id="batteryPercent" name="batteryPercent" type="number" min={0} max={100} inputMode="numeric" defaultValue={handover.batteryPercent ?? ""} required className="input tnum !text-xl !font-semibold !min-h-[52px]" />
                      </Field>
                      <div className="card p-3.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm self-end">
                        <span className="text-ink-3">Übergabe</span><span className="font-mono tnum text-right">{cmp?.battery?.pickup != null ? `${cmp.battery.pickup} %` : "–"}</span>
                        <span className="text-ink-3">Rückgabe</span><span className="font-mono tnum text-right font-semibold">{cmp?.battery?.return != null ? `${cmp.battery.return} %` : "–"}</span>
                        <span className="text-ink-3">Differenz</span><span className={`font-mono tnum text-right font-semibold ${(cmp?.battery?.diff ?? 0) < 0 ? "text-bad" : ""}`}>{cmp?.battery?.diff != null ? `${cmp.battery.diff > 0 ? "+" : cmp.battery.diff < 0 ? "−" : "±"}${Math.abs(cmp.battery.diff)} Prozentpunkte` : "–"}</span>
                      </div>
                    </>
                  )}
                  {energy.fuel && cmp && (
                    <div className="md:col-span-2 card p-3.5 flex flex-col gap-2 text-sm">
                      <div><span className="text-ink-3">Tankregelung laut Vertrag:</span> <b>{cmp.contract.fuelPolicyLabel}</b>{cmp.contract.fuelPolicy === "OTHER" && cmp.contract.fuelPolicyNote ? ` (${cmp.contract.fuelPolicyNote})` : ""}</div>
                      {cmp.contract.fuelPricePerLiter != null ? (
                        <div><span className="text-ink-3">Literpreis laut Vertrag:</span> <b className="font-mono tnum">{fmtEur(cmp.contract.fuelPricePerLiter)}</b> · Tankgröße {cmp.contract.tankCapacityLiters != null ? `${cmp.contract.tankCapacityLiters} l` : "nicht hinterlegt"}</div>
                      ) : (
                        <Field label="Literpreis für diese Rückgabe in € (optional)" htmlFor="fuelPricePerLiter" hint={`Im Vertrag ist kein Literpreis hinterlegt. Nur mit einer hier ausdrücklich angegebenen Grundlage wird ein Vorschlag berechnet${cmp.contract.tankCapacityLiters != null ? ` (Tankgröße ${cmp.contract.tankCapacityLiters} l)` : ", zusätzlich fehlt die Tankgröße im Vertrag"}.`}>
                          <input id="fuelPricePerLiter" name="fuelPricePerLiter" inputMode="decimal" defaultValue={handover.fuelPricePerLiter != null ? String(handover.fuelPricePerLiter).replace(".", ",") : ""} className="input tnum max-w-[12rem]" placeholder="z. B. 1,80" />
                        </Field>
                      )}
                      {cmp.proposals.find((p) => p.key === "FUEL") && <div className="text-xs text-ink-2">Vorschlag: {cmp.proposals.find((p) => p.key === "FUEL")!.draft.formula} (Bestätigung in Schritt 7)</div>}
                      {cmp.hints.filter((h) => h.code.startsWith("FUEL") || h.code.startsWith("CHARGING")).map((h) => <div key={h.code} className="text-xs text-ink-2">{h.text}</div>)}
                    </div>
                  )}
                  <Field label="Bemerkung (optional)" htmlFor="notes" full>
                    <textarea id="notes" name="notes" defaultValue={handover.notes ?? ""} rows={2} className="input" placeholder="z. B. Fahrzeug außen verschmutzt, Zubehör vollständig" />
                  </Field>
                </div>
              </StepForm>
            </Card>
          </>
        )}

        {step === 4 && (
          <>
            {isKeyDrop && findingList(["DAMAGE"])}
            {isKeyDrop && kdRaw?.customerNewDamages != null && customerSays(kdRaw.customerNewDamages ? `Neue Schäden bekannt – ${kdRaw.customerDamageNote ?? ""}` : "keine neuen Schäden bekannt")}
            {isKeyDrop && <p className="text-xs text-ink-3">Neu festgestellte Schäden werden als „bei nachträglicher Kontrolle nach kontaktloser Rückgabe festgestellt“ geführt. Die Schadenakte startet neutral; über Verantwortung und Kosten wird gesondert entschieden.</p>}
            <HandoverIssueList issues={issues} areas={["DAMAGES"]} />
            <p className="text-sm text-ink-2 max-w-[80ch]">Der dokumentierte Zustand bei der Übergabe und der Zustand jetzt stehen nebeneinander, auf dem Smartphone schalten Sie zwischen „Übergabe (vorher)“ und „Rückgabe (jetzt)“ um. Alles, was neu ist, markieren Sie auf der Rückgabeskizze. Ein bei der Rückgabe festgestellter Schaden wird der Miete zugeordnet und in die Fahrzeugakte übernommen. Ob und was berechnet wird, entscheiden Sie gesondert in Schritt 7.</p>
            {pickupDoc && <CompareDamages pickup={pickupDoc} current={doc} handoverId={handover.id} actions={damageActions} />}
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 4)} step={4} nextLabel="Weiter zu den Fotos"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 5 && (
          <>
            <HandoverIssueList issues={issues} areas={["PHOTOS"]} okText="Alle Pflichtfotos sind vorhanden." />
            {!storage.configured && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">Der Dateispeicher ist noch nicht eingerichtet, Fotos können derzeit nicht gespeichert werden.</p>}
            <ComparePhotos
              handoverId={handover.id}
              categories={REQUIRED_PHOTO_CATEGORIES.map((c) => ({ key: c, label: PHOTO_CATEGORIES[c as PhotoCategory], required: true }))}
              pickupPhotos={Object.fromEntries(REQUIRED_PHOTO_CATEGORIES.map((c) => [c, byCategory(pickupDoc, c)]))}
              returnPhotos={Object.fromEntries(REQUIRED_PHOTO_CATEGORIES.map((c) => [c, byCategory(doc, c)]))}
            />
            <div className="max-w-sm"><PhotoUploader handoverId={handover.id} category="OTHER" label="Weitere Fotos" photos={byCategory(doc, "OTHER")} editable /></div>
            <p className="text-xs text-ink-3">Fotos einzelner Schäden gehören in Schritt 4 zum jeweiligen Schaden.</p>
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 5)} step={5} nextLabel="Weiter zur Checkliste"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 6 && (
          <>
            <HandoverIssueList issues={issues} areas={["CHECKLIST"]} />
            <Card className="p-4 md:p-5">
              <StepForm action={saveChecklistAction.bind(null, b.id)} step={6}>
                <ul className="flex flex-col divide-y divide-line-soft">
                  {items.map((c) => {
                    const options = c.answerType === "YES_NO" ? [["YES", "Ja"], ["NO", "Nein"], ["NA", "Nicht zutreffend"]] : [["OK", "In Ordnung"], ["NOT_OK", "Nicht in Ordnung"], ["NA", "Nicht zutreffend"]];
                    const badValue = c.itemKey === "unusually_dirty" ? "YES" : c.answerType === "YES_NO" ? "NO" : "NOT_OK";
                    const ref = c.itemKey === "keys_returned" ? pickupAnswers.get("keys") : pickupAnswers.get(c.itemKey);
                    return (
                      <li key={c.id} className="py-3 flex flex-col gap-2">
                        <div className="font-medium flex flex-wrap items-center gap-2">{c.label}{!c.required && <span className="text-ink-3 font-normal"> · optional</span>}{ref?.result && <span className="chip bg-panel-2 text-ink-2 font-normal">Bei Übergabe: {c.itemKey === "keys_returned" ? `${ref.result} Schlüssel` : ref.result === "YES" ? "Ja" : ref.result === "NO" ? "Nein" : ref.result === "OK" ? "In Ordnung" : ref.result === "NOT_OK" ? "Nicht in Ordnung" : ref.result}</span>}</div>
                        {c.answerType === "TEXT" ? (
                          <input name={`r_${c.id}`} defaultValue={c.result ?? ""} required={c.required} inputMode={c.itemKey === "keys_returned" ? "numeric" : undefined} className="input" aria-label={c.label} />
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-xl">
                            {options.map(([value, text]) => (
                              <label key={value} className="cursor-pointer">
                                <input type="radio" name={`r_${c.id}`} value={value} defaultChecked={c.result === value} required={c.required} className="peer sr-only" />
                                <span className={`flex h-11 items-center justify-center rounded-md border border-line bg-panel text-sm font-medium peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-info ${value === "NA" ? "peer-checked:bg-ink-2 peer-checked:text-white peer-checked:border-ink-2" : value === badValue ? "peer-checked:bg-bad peer-checked:text-white peer-checked:border-bad" : "peer-checked:bg-good peer-checked:text-white peer-checked:border-good"}`}>{text}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        {c.answerType !== "TEXT" && <input name={`n_${c.id}`} defaultValue={c.note ?? ""} className="input" placeholder="Bemerkung, Pflicht bei einer Auffälligkeit" aria-label={`Bemerkung zu ${c.label}`} />}
                      </li>
                    );
                  })}
                </ul>
              </StepForm>
            </Card>
          </>
        )}

        {step === 7 && cmp && (
          <>
            <HandoverIssueList issues={issues} areas={["CHARGES"]} />
            {attention.length > 0 && <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm"><div className="font-semibold mb-1">Auffälligkeiten aus Checkliste und Vergleich</div><ul className="list-disc pl-5">{attention.map((a) => <li key={a}>{a}</li>)}</ul></div>}
            <ChargesEditor
              proposals={cmp.proposals}
              hints={cmp.hints}
              charges={cmp.charges}
              total={cmp.chargesTotal}
              deposit={cmp.contract.deposit}
              newDamages={doc.damages.filter((d) => d.marker === "NEW")}
              actions={{ confirm: confirmProposalAction.bind(null, b.id), add: addChargeAction.bind(null, b.id), remove: removeChargeAction.bind(null, b.id) }}
            />
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 7)} step={7} nextLabel="Weiter zur Unterschrift"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 8 && (
          <>
            <HandoverIssueList issues={issues} okText="Alle Angaben sind vollständig. Das Protokoll kann unterschrieben werden." />
            <ReturnSummary doc={doc} attention={attention} />
            {isKeyDrop ? (
              <p className="text-sm text-ink-2">Kontaktlose Rückgabe: Der Kunde war bei der Kontrolle nicht anwesend und unterschreibt nicht unter diese Feststellungen. Seine Rückgabemeldung ersetzt die Anwesenheitsunterschrift ausschließlich für die Abgabe. Die Unterschrift des Mitarbeiters ist optional.</p>
            ) : (
              <p className="text-sm text-ink-2">Mit der Unterschrift bestätigt der Mieter die dokumentierte Rückgabe und den dargestellten Fahrzeugzustand. Sie ist kein Anerkenntnis über Verantwortung oder Kosten.</p>
            )}
            <p className="text-xs text-ink-3">Die Unterschrift gilt für genau diesen Protokollstand (Kennung {hash.slice(0, 12)}). Wird danach etwas geändert (Kilometer, Tank, Schäden, Fotos, Checkliste, Zusatzkosten), wird sie verworfen und der Mieter unterschreibt erneut.</p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              {isKeyDrop ? (
                <Card title="Kundenmeldung (kontaktlose Abgabe)" right={keyDrop?.doc.confirmedAt ? <Chip tone="good">Liegt vor</Chip> : <Chip tone="amber">Ausnahme</Chip>}>
                  <div className="p-4 text-sm flex flex-col gap-2">
                    {keyDrop?.doc.confirmedAt ? <p>Gemeldet am {keyDrop.doc.confirmedAt} von {keyDrop.doc.signerName}. Die Meldung bestätigt nur die Abgabe, nicht den Zustand bei der Kontrolle.</p> : <p>Keine Kundenmeldung. Kontrolle ohne Kundenbestätigung, Grund: {handover.keyDropExceptionReason}</p>}
                  </div>
                </Card>
              ) : (
              <Card title="Unterschrift Mieter" right={renterSig ? <Chip tone="good">Erfasst</Chip> : <Chip tone="amber">Fehlt</Chip>}>
                <div className="p-4 flex flex-col gap-3">
                  {renterSig ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/signatures/${renterSig.id}`} alt="Unterschrift Mieter" className="h-32 w-full object-contain rounded-md border border-line bg-white" />
                      <div className="text-xs text-ink-2">{renterSig.signerName} · {fmtDateTime(renterSig.signedAt)}</div>
                      <form action={removeSignatureAction.bind(null, b.id, "RENTER")}><button className="btn">Neu unterschreiben</button></form>
                    </>
                  ) : (
                    <SignatureForm action={saveSignatureAction.bind(null, b.id)} role="RENTER" defaultName={primaryDriver ? `${primaryDriver.firstName} ${primaryDriver.lastName}` : `${b.customer.firstName} ${b.customer.lastName}`} seenHash={hash} />
                  )}
                </div>
              </Card>
              )}
              <Card title="Unterschrift Vermieter (optional)" right={employeeSig ? <Chip tone="good">Erfasst</Chip> : <Chip>Optional</Chip>}>
                <div className="p-4 flex flex-col gap-3">
                  {employeeSig ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/signatures/${employeeSig.id}`} alt="Unterschrift Vermieter" className="h-32 w-full object-contain rounded-md border border-line bg-white" />
                      <div className="text-xs text-ink-2">{employeeSig.signerName} · {fmtDateTime(employeeSig.signedAt)}</div>
                      <form action={removeSignatureAction.bind(null, b.id, "EMPLOYEE")}><button className="btn">Neu unterschreiben</button></form>
                    </>
                  ) : (
                    <SignatureForm action={saveSignatureAction.bind(null, b.id)} role="EMPLOYEE" defaultName={user.name} seenHash={hash} />
                  )}
                </div>
              </Card>
            </div>
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 8)} step={8} nextLabel="Weiter zum Abschluss"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 9 && (
          <>
            <CompletionCard status={completion} basePath={base} okText="Alle Prüfungen bestanden. Die Rückgabe kann abgeschlossen werden." />
            <HandoverDocumentView doc={doc} handoverId={handover.id} />
            <Card className="p-4 md:p-5 flex flex-col gap-3">
              <p className="text-sm text-ink-2">Nach Abschluss kann das Rückgabeprotokoll nicht mehr verändert werden. Der Kilometerstand wird ins Fahrzeug übernommen, neu festgestellte Schäden kommen mit Bezug zu dieser Miete in die Fahrzeugakte, die bestätigten Zusatzkosten werden versiegelt und die Buchung wechselt auf „Zurückgegeben“. Danach werden Rückgabeprotokoll-PDF und E-Mail erzeugt.</p>
              <FinalizeForm
                action={finalizeReturnAction.bind(null, b.id)}
                disabled={!completion.ready}
                reason={!completion.ready ? (completion.blockers.length === 1 ? "1 Punkt muss noch erledigt werden, siehe „Vor Abschluss prüfen“." : `${completion.blockers.length} Punkte müssen noch erledigt werden, siehe „Vor Abschluss prüfen“.`) : undefined}
                label="Fahrzeugrückgabe verbindlich abschließen"
                pendingLabel="Rückgabe wird abgeschlossen…"
              />
              <div><Link href={`${base}?schritt=8`} className="btn">Zurück</Link></div>
            </Card>
          </>
        )}
      </Content>
    </>
  );
}

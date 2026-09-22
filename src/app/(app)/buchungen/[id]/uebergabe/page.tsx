import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { bookingStage } from "@/lib/booking-status";
import { getHandoverState } from "@/lib/handovers";
import { buildHandoverDocument } from "@/lib/handover-view";
import { storageStatus } from "@/lib/storage";
import { FUELS, PHOTO_CATEGORIES, REQUIRED_PHOTO_CATEGORIES, energyRequirements, type Fuel, type PhotoCategory } from "@/lib/constants";
import { customerName, fmtDateTime, fmtInt } from "@/lib/format";
import { BookingStageChip, Card, Chip, Content, Field, PageHeader, Plate } from "@/components/ui";
import { FinalizeForm, SignatureForm, StepForm, WizardProgress } from "../vertrag/wizard-ui";
import {
  addDamageAction,
  finalizePickupAction,
  navigateStepAction,
  removeDamageAction,
  removeSignatureAction,
  saveChecklistAction,
  saveReadingsAction,
  saveSignatureAction,
  startPickupAction,
  updateDamageAction,
} from "./actions";
import { DamageMap } from "./damage-map";
import { FuelGauge, HandoverDocumentView, HandoverIssueList, PICKUP_STEPS } from "./handover-parts";
import { DocumentsPanel } from "../dokumente/documents-panel";
import { FollowUpNotice } from "../dokumente/follow-up-notice";
import { DepositNotice } from "../finanzen/panels";
import { loadHandoverContext } from "@/lib/document-data";
import { PhotoUploader } from "./photo-uploader";

export const metadata = { title: "Übergabe" };

export default async function PickupPage({ params, searchParams }: PageProps<"/buchungen/[id]/uebergabe">) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const { id } = await params;
  const sp = await searchParams;

  const b = await db.booking.findFirst({
    where: { id, tenantId: tenant.id },
    include: { vehicle: { include: { group: true } }, customer: true, contract: { include: { drivers: true } }, handovers: { where: { type: "PICKUP", correctsId: null }, orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!b) notFound();
  const stage = bookingStage(b, b.contract);
  const existing = b.handovers[0];

  // Noch keine Übergabe begonnen
  if (!existing) {
    return (
      <>
        <PageHeader title="Übergabe" sub={`Buchung ${b.number}`}>
          <BookingStageChip stage={stage} />
          <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content>
          {typeof sp.hinweis === "string" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p>}
          <DepositNotice tenantId={tenant.id} bookingId={b.id} />
          <Card className="p-5 max-w-2xl flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2"><Plate>{b.vehicle.plate}</Plate><span className="font-medium">{b.vehicle.make} {b.vehicle.model}</span><span className="text-ink-3">für {customerName(b.customer)}</span></div>
            {stage === "READY_FOR_PICKUP" ? (
              <>
                <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">Mietvertrag {b.contract!.number} ist abgeschlossen. Die Übergabe kann beginnen.</p>
                <p className="text-sm text-ink-2">Geplante Abholung: {fmtDateTime(b.startAt)}. Der Assistent führt durch Kilometerstand, Tank, Fahrzeugzustand, Fotos, Checkliste und Unterschrift. Erst das finalisierte Protokoll setzt das Fahrzeug auf „Unterwegs“.</p>
                <form action={startPickupAction.bind(null, b.id)}><button className="btn btn-primary !py-2.5 !px-5">Übergabe starten</button></form>
              </>
            ) : stage === "NEEDS_CONTRACT" || stage === "CONTRACT_DRAFT" ? (
              <>
                <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">Die Übergabe ist erst möglich, wenn der Mietvertrag abgeschlossen ist.</p>
                <div><Link href={`/buchungen/${b.id}/vertrag`} className="btn btn-primary">{stage === "CONTRACT_DRAFT" ? "Mietvertrag fortsetzen" : "Zum Mietvertrag"}</Link></div>
              </>
            ) : (
              <p className="text-sm text-ink-2">Für diese Buchung gibt es kein Übergabeprotokoll. Sie wurde vor Einführung des Assistenten übergeben.</p>
            )}
          </Card>
        </Content>
      </>
    );
  }

  const state = await getHandoverState(tenant.id, existing.id);
  const { handover, signatures, sketch, issues, hash } = state;
  const doc = buildHandoverDocument(handover, sketch, signatures, REQUIRED_PHOTO_CATEGORIES, await loadHandoverContext(tenant.id, handover));

  // Finalisiert: nur noch Anzeige
  if (handover.status === "FINALIZED") {
    return (
      <>
        <PageHeader title={`Übergabeprotokoll ${handover.number}`} sub={`Buchung ${b.number}`}>
          <BookingStageChip stage={stage} />
          <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content>
          {sp.abgeschlossen === "1" && <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">Die Übergabe ist abgeschlossen und versiegelt. {b.vehicle.plate} ist jetzt unterwegs.</p>}
          {sp.abgeschlossen === "1" && <FollowUpNotice tenantId={tenant.id} bookingId={b.id} handoverId={handover.id} />}
          <DocumentsPanel tenantId={tenant.id} bookingId={b.id} role={user.role} />
          <HandoverDocumentView doc={doc} handoverId={handover.id} />
        </Content>
      </>
    );
  }

  const reached = Math.max(1, handover.wizardStep);
  const requested = typeof sp.schritt === "string" ? parseInt(sp.schritt, 10) : reached;
  const step = Math.min(7, Math.max(1, Number.isFinite(requested) ? requested : reached));
  const energy = energyRequirements(handover.driveType);
  const storage = storageStatus();
  const renterSig = signatures.find((s) => s.role === "RENTER");
  const employeeSig = signatures.find((s) => s.role === "EMPLOYEE");
  const blocking = issues.some((i) => i.severity === "error");
  const generalByCategory = (c: string) => doc.photos.filter((p) => p.category === c).map((p) => ({ id: p.id, url: p.url }));
  const primaryDriver = b.contract?.drivers.find((d) => d.role === "PRIMARY_DRIVER");
  const items = [...handover.checklistItems].sort((x, y) => x.sortOrder - y.sortOrder);
  const base = `/buchungen/${b.id}/uebergabe`;

  return (
    <>
      <PageHeader title={`Übergabe ${handover.number}`} sub={`Buchung ${b.number} · ${customerName(b.customer)}`}>
        <Plate>{b.vehicle.plate}</Plate>
        <Chip tone="amber">Entwurf</Chip>
        <Link href={`/buchungen/${b.id}`} className="btn">Zur Buchung</Link>
      </PageHeader>
      <Content className="max-w-6xl">
        <WizardProgress bookingId={b.id} current={step} reached={reached} steps={PICKUP_STEPS} basePath={base} />
        <h2 className="text-lg font-semibold -mb-1">Schritt {step} von 7: {PICKUP_STEPS[step - 1]}</h2>
        <DepositNotice tenantId={tenant.id} bookingId={b.id} />

        {step === 1 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <Card title="Miete">
                <dl className="px-4 py-3 grid grid-cols-[minmax(110px,38%)_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Mietvertrag</dt><dd className="font-medium"><Link href={`/buchungen/${b.id}/vertrag`} className="hover:underline">{b.contract?.number}</Link></dd>
                  <dt className="text-ink-3">Mieter</dt><dd className="font-medium">{customerName(b.customer)}</dd>
                  <dt className="text-ink-3">Fahrer</dt><dd className="font-medium">{primaryDriver ? `${primaryDriver.firstName} ${primaryDriver.lastName}` : "–"}</dd>
                  <dt className="text-ink-3">Zusatzfahrer</dt><dd>{b.contract?.drivers.filter((d) => d.role === "ADDITIONAL_DRIVER").map((d) => `${d.firstName} ${d.lastName}`).join(", ") || "keine"}</dd>
                  <dt className="text-ink-3">Geplante Abholung</dt><dd className="font-mono tnum">{fmtDateTime(b.startAt)}</dd>
                  <dt className="text-ink-3">Geplante Rückgabe</dt><dd className="font-mono tnum">{fmtDateTime(b.endAt)}</dd>
                  <dt className="text-ink-3">Telefon</dt><dd>{b.customer.phone || "–"}</dd>
                </dl>
              </Card>
              <Card title="Fahrzeug">
                <dl className="px-4 py-3 grid grid-cols-[minmax(110px,38%)_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Kennzeichen</dt><dd><Plate>{b.vehicle.plate}</Plate></dd>
                  <dt className="text-ink-3">Fahrzeug</dt><dd className="font-medium">{b.vehicle.make} {b.vehicle.model}</dd>
                  <dt className="text-ink-3">Gruppe</dt><dd>{b.vehicle.group?.name ?? "–"}</dd>
                  <dt className="text-ink-3">Antrieb</dt><dd>{FUELS[handover.driveType as Fuel] ?? handover.driveType}</dd>
                  <dt className="text-ink-3">Letzter km-Stand</dt><dd className="font-mono tnum">{fmtInt(b.vehicle.mileage)} km</dd>
                  <dt className="text-ink-3">Bekannte Schäden</dt><dd>{doc.damages.filter((d) => d.marker === "EXISTING").length}</dd>
                </dl>
              </Card>
            </div>
            {!storage.configured && (
              <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">Der Dateispeicher ist noch nicht eingerichtet. Fotos lassen sich erst aufnehmen, wenn der Object Storage in den Servereinstellungen hinterlegt ist. Ohne Pflichtfotos kann die Übergabe nicht abgeschlossen werden.</p>
            )}
            <p className="text-xs text-ink-3">Durchgeführt von {handover.employeeName}. Jeder Schritt wird sofort gespeichert, die Übergabe kann unterbrochen und später fortgesetzt werden.</p>
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 1)} step={1} nextLabel="Übergabe beginnen"><span className="sr-only">Übersicht</span></StepForm></Card>
          </>
        )}

        {step === 2 && (
          <>
            <HandoverIssueList issues={issues} areas={["READINGS"]} />
            <Card className="p-4 md:p-5">
              <StepForm action={saveReadingsAction.bind(null, b.id)} step={2}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
                  <Field label="Kilometerstand" htmlFor="mileage" hint={`Letzter bekannter Stand: ${fmtInt(b.vehicle.mileage)} km. Das Fahrzeug übernimmt den neuen Stand erst mit dem Abschluss der Übergabe.`}>
                    <input id="mileage" name="mileage" inputMode="numeric" pattern="[0-9.]*" defaultValue={handover.mileage ?? ""} required className="input tnum !text-xl !font-semibold !min-h-[52px]" placeholder={String(b.vehicle.mileage)} />
                  </Field>
                  {energy.battery && (
                    <Field label="Batteriestand in %" htmlFor="batteryPercent">
                      <input id="batteryPercent" name="batteryPercent" type="number" min={0} max={100} inputMode="numeric" defaultValue={handover.batteryPercent ?? ""} required className="input tnum !text-xl !font-semibold !min-h-[52px]" placeholder="z. B. 80" />
                    </Field>
                  )}
                  {energy.fuel && (
                    <fieldset className="md:col-span-2 flex flex-col gap-1.5">
                      <legend className="label-xs mb-1.5">Tankstand in Achteln</legend>
                      <div className="grid grid-cols-9 gap-1">
                        {Array.from({ length: 9 }, (_, n) => (
                          <label key={n} className="cursor-pointer">
                            <input type="radio" name="fuelLevelEighths" value={n} defaultChecked={handover.fuelLevelEighths === n} required className="peer sr-only" />
                            <span className="flex h-12 items-center justify-center rounded-md border border-line bg-panel text-sm font-semibold tnum peer-checked:bg-brand peer-checked:text-brand-ink peer-checked:border-brand peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-info">{n === 0 ? "leer" : n === 8 ? "voll" : `${n}/8`}</span>
                          </label>
                        ))}
                      </div>
                      {handover.fuelLevelEighths != null && <FuelGauge eighths={handover.fuelLevelEighths} />}
                    </fieldset>
                  )}
                  <Field label="Bemerkung (optional)" htmlFor="notes" full>
                    <textarea id="notes" name="notes" defaultValue={handover.notes ?? ""} rows={2} className="input" placeholder="z. B. 2 Schlüssel übergeben, Ladekabel im Kofferraum" />
                  </Field>
                </div>
              </StepForm>
            </Card>
          </>
        )}

        {step === 3 && (
          <>
            <HandoverIssueList issues={issues} areas={["DAMAGES"]} />
            <p className="text-sm text-ink-2 max-w-[75ch]">Bereits dokumentierte Schäden sind aus der Fahrzeugakte übernommen. Alles, was Sie jetzt zusätzlich finden, gilt als <b>Vorschaden</b> und wird dem Mieter nicht angelastet. Deshalb lohnt sich der genaue Blick vor der Abfahrt.</p>
            <Card className="p-4">
              <DamageMap
                sketch={doc.sketch}
                damages={doc.damages}
                handoverId={handover.id}
                editable
                pickup
                actions={{ add: addDamageAction.bind(null, b.id), update: updateDamageAction.bind(null, b.id), remove: removeDamageAction.bind(null, b.id) }}
              />
            </Card>
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 3)} step={3} nextLabel="Weiter zu den Fotos"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 4 && (
          <>
            <HandoverIssueList issues={issues} areas={["PHOTOS"]} okText="Alle Pflichtfotos sind vorhanden." />
            {!storage.configured && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">Der Dateispeicher ist noch nicht eingerichtet, Fotos können derzeit nicht gespeichert werden.</p>}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {REQUIRED_PHOTO_CATEGORIES.map((c) => (
                <PhotoUploader key={c} handoverId={handover.id} category={c} label={PHOTO_CATEGORIES[c as PhotoCategory]} photos={generalByCategory(c)} editable required />
              ))}
              <PhotoUploader handoverId={handover.id} category="OTHER" label="Weitere Fotos" photos={generalByCategory("OTHER")} editable />
            </div>
            <p className="text-xs text-ink-3">Die Fotos liegen in einem privaten Speicher und sind nur für angemeldete Mitarbeiter Ihrer Vermietung sichtbar. Fotos einzelner Schäden gehören in Schritt 3 zum jeweiligen Schaden.</p>
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 4)} step={4} nextLabel="Weiter zur Checkliste"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 5 && (
          <>
            <HandoverIssueList issues={issues} areas={["CHECKLIST"]} />
            <Card className="p-4 md:p-5">
              <StepForm action={saveChecklistAction.bind(null, b.id)} step={5}>
                <ul className="flex flex-col divide-y divide-line-soft">
                  {items.map((c) => {
                    const options = c.answerType === "YES_NO" ? [["YES", "Ja"], ["NO", "Nein"], ["NA", "Nicht zutreffend"]] : [["OK", "In Ordnung"], ["NOT_OK", "Nicht in Ordnung"], ["NA", "Nicht zutreffend"]];
                    return (
                      <li key={c.id} className="py-3 flex flex-col gap-2">
                        <div className="font-medium">{c.label}{!c.required && <span className="text-ink-3 font-normal"> · optional</span>}</div>
                        {c.answerType === "TEXT" ? (
                          <input name={`r_${c.id}`} defaultValue={c.result ?? ""} required={c.required} className="input" aria-label={c.label} />
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-xl">
                            {options.map(([value, text]) => (
                              <label key={value} className="cursor-pointer">
                                <input type="radio" name={`r_${c.id}`} value={value} defaultChecked={c.result === value} required={c.required} className="peer sr-only" />
                                <span className={`flex h-11 items-center justify-center rounded-md border border-line bg-panel text-sm font-medium peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-info ${value === "OK" || value === "YES" ? "peer-checked:bg-good peer-checked:text-white peer-checked:border-good" : value === "NA" ? "peer-checked:bg-ink-2 peer-checked:text-white peer-checked:border-ink-2" : "peer-checked:bg-bad peer-checked:text-white peer-checked:border-bad"}`}>{text}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        {c.answerType !== "TEXT" && <input name={`n_${c.id}`} defaultValue={c.note ?? ""} className="input" placeholder="Bemerkung, Pflicht bei „Nein“ oder „Nicht in Ordnung“" aria-label={`Bemerkung zu ${c.label}`} />}
                      </li>
                    );
                  })}
                </ul>
              </StepForm>
            </Card>
          </>
        )}

        {step === 6 && (
          <>
            <HandoverIssueList issues={issues} okText="Alle Angaben sind vollständig. Das Protokoll kann unterschrieben werden." />
            <HandoverDocumentView doc={doc} handoverId={handover.id} showSignatures={false} />
            <p className="text-xs text-ink-3">Die Unterschrift gilt für genau diesen Protokollstand (Kennung {hash.slice(0, 12)}). Wird danach etwas geändert, wird sie verworfen und der Mieter unterschreibt erneut.</p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
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
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, b.id, 6)} step={6} nextLabel="Weiter zum Abschluss"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 7 && (
          <>
            <HandoverIssueList issues={[...issues, ...(renterSig ? [] : [{ code: "SIGNATURE_MISSING", area: "SIGNATURE" as const, severity: "error" as const, message: "Die Unterschrift des Mieters fehlt." }])]} okText="Alle Prüfungen bestanden. Die Übergabe kann abgeschlossen werden." />
            <HandoverDocumentView doc={doc} handoverId={handover.id} />
            <Card className="p-4 md:p-5 flex flex-col gap-3">
              <p className="text-sm text-ink-2">Mit dem Abschluss wird das Protokoll versiegelt, der Kilometerstand ins Fahrzeug übernommen, neu entdeckte Schäden kommen als Vorschäden in die Fahrzeugakte und die Buchung wechselt auf „Unterwegs“.</p>
              <FinalizeForm
                action={finalizePickupAction.bind(null, b.id)}
                disabled={blocking || !renterSig}
                reason={blocking ? "Es gibt noch offene Punkte, siehe oben." : !renterSig ? "Es fehlt noch die Unterschrift des Mieters." : undefined}
                label="Übergabe verbindlich abschließen"
                pendingLabel="Übergabe wird abgeschlossen…"
              />
              <div><Link href={`${base}?schritt=6`} className="btn">Zurück</Link></div>
            </Card>
          </>
        )}
      </Content>
    </>
  );
}

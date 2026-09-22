import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Chip, Content, PageHeader, Plate, VehicleStatusChip } from "@/components/ui";
import { DAMAGE_CASE_DOCUMENT_TYPES, DAMAGE_CASE_EVENT_TYPES, DAMAGE_CASE_PRIORITY, DAMAGE_CASE_TRANSITIONS, DAMAGE_KINDS, DAMAGE_SEVERITY, DAMAGE_TAX_TREATMENTS, DAMAGE_VIEWS, DEPOSIT_STATUS, LIABILITY_STATUS, type DamageCaseDocumentType, type DamageCasePriority, type DamageCaseStatus, type DamageKind, type DamageSeverity, type DamageTaxTreatment, type DamageView, type LiabilityStatus } from "@/lib/constants";
import { caseView, futureBookingsOf } from "@/lib/damage-cases";
import { DomainError } from "@/lib/integrity";
import { customerName, fmtDate, fmtDateTime, fmtInt } from "@/lib/format";
import { parseSketch, SKETCH_CANVAS_WIDTH } from "@/lib/handover-view";
import { fmtCents } from "@/lib/money";
import { resolveSketch } from "@/lib/sketches";
import { toDateTimeInputValue } from "@/lib/time";
import { PaymentStatusChip } from "../../buchungen/[id]/finanzen/panels";
import { CaseStatusChip, LiabilityChip } from "../chips";
import { addNoteAction, blockVehicleAction, changeStatusAction, chargeCustomerAction, closeCaseAction, releaseVehicleAction, reopenCaseAction, setCostsAction, setInternalNoteAction, setLiabilityAction, setPriorityAction, setRepairAction } from "./actions";
import { CaseDocumentUploader, CasePhotoUploader, ChargeForm, ConfirmReasonForm, CostsForm, InternalNoteForm, LiabilityForm, NoteForm, PriorityForm, RepairForm, StatusForm } from "./case-forms";

export const metadata = { title: "Schadenakte" };

const eur = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default async function DamageCasePage({ params, searchParams }: PageProps<"/schaeden/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  let c: Awaited<ReturnType<typeof caseView>>;
  try {
    c = await caseView(tenant.id, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const canManage = user.role !== "YARD";
  const open = c.status !== "CLOSED";
  const allowed = (DAMAGE_CASE_TRANSITIONS[c.status as DamageCaseStatus] ?? []).filter((s) => s !== "CLOSED");
  const vehicle = await db.vehicle.findFirst({ where: { id: c.vehicleId, tenantId: tenant.id }, select: { group: { select: { sketchId: true, bodyType: true, name: true } } } });
  const sketch = parseSketch(await resolveSketch(db, tenant.id, vehicle?.group ?? null));
  const future = open && canManage && c.vehicle.status !== "BLOCKED" ? await futureBookingsOf(tenant.id, c.vehicleId) : [];
  const d = c.damage;
  const origin = c.returnHandover ? `Bei Rückgabe neu festgestellt (${c.returnHandover.number})` : d.discoveredIn ? `${d.discoveredIn.type === "RETURN" ? "Bei Rückgabe festgestellt" : "Vorschaden bei Übergabe dokumentiert"} (${d.discoveredIn.number})` : "Auf dem Hof erfasst";
  const protocolHref = d.discoveredIn ? `/buchungen/${d.discoveredIn.bookingId}/${d.discoveredIn.type === "RETURN" ? "rueckgabe" : "uebergabe"}` : null;
  const invoiceHref = c.invoice && c.bookingId ? `/buchungen/${c.bookingId}/rechnung?nr=${c.invoice.id}` : null;
  const chargeHints = [
    c.actualCostCents != null ? { label: "Tatsächliche Reparaturkosten", value: fmtCents(c.actualCostCents) } : null,
    c.estimatedCostCents != null ? { label: "Kostenschätzung", value: fmtCents(c.estimatedCostCents) } : null,
    c.deductibleCents != null ? { label: "Selbstbeteiligung laut Mietvertrag", value: fmtCents(c.deductibleCents) } : null,
    c.deposit ? { label: "Kaution erhalten (nicht verrechnet)", value: fmtCents(c.deposit.receivedCents) } : null,
  ].filter((x): x is { label: string; value: string } => x !== null);
  const canCharge = canManage && open && c.liabilityStatus === "CUSTOMER_RESPONSIBILITY_CONFIRMED" && !!c.bookingId && c.customerChargeCents == null && !c.invoice;
  const view = sketch?.views.find((v) => v.key === d.view) ?? null;

  return (
    <>
      <PageHeader title={`Schadenakte ${c.caseNumber}`} sub={<><Plate>{c.vehicle.plate}</Plate> {c.vehicle.make} {c.vehicle.model} · {DAMAGE_KINDS[d.kind as DamageKind] ?? d.kind}, {DAMAGE_VIEWS[d.view as DamageView] ?? d.view}</>}>
        <CaseStatusChip status={c.status} />
        <LiabilityChip status={c.liabilityStatus} />
        {c.priority !== "NORMAL" && <Chip tone={c.priority === "HIGH" ? "bad" : "grey"}>Priorität {DAMAGE_CASE_PRIORITY[c.priority as DamageCasePriority]}</Chip>}
        <VehicleStatusChip status={c.vehicle.status} />
        <Link href="/schaeden" className="btn">Alle Schäden</Link>
        <Link href={`/fahrzeuge/${c.vehicleId}`} className="btn">Fahrzeug</Link>
        {c.bookingId && <Link href={`/buchungen/${c.bookingId}`} className="btn">Buchung</Link>}
      </PageHeader>
      <Content>
        {sp.neu === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Schadenakte {c.caseNumber} eröffnet. Haftung: noch nicht bewertet – die Akte stellt keine Schuld fest und erzeugt keine Forderung.</p>}
        {c.status === "CLOSED" && <p className="rounded-md bg-panel-2 px-3.5 py-2.5 text-sm">Geschlossen am {fmtDateTime(c.closedAt!)} von {c.closedByName ?? "–"}: {c.closeReason}. {c.vehicle.status === "BLOCKED" && <span className="text-bad font-medium">Das Fahrzeug ist weiterhin gesperrt; die Freigabe ist eine eigene Entscheidung.</span>}</p>}
        {c.vehicle.status === "BLOCKED" && open && <p className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm font-medium">Fahrzeug wegen Schaden gesperrt: nicht buchbar, nicht übergebbar. Freigabe unten unter „Fahrzeug“.</p>}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* Schaden: Feststellung, Details, Vorher/Nachher */}
          <Card title="Schaden" right={<Chip tone={d.status === "REPAIRED" ? "good" : "amber"}>{d.status === "REPAIRED" ? "am Fahrzeug repariert" : "am Fahrzeug offen"}</Chip>}>
            <dl className="p-4 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
              <dt className="label-xs self-center">Art</dt><dd>{DAMAGE_KINDS[d.kind as DamageKind] ?? d.kind} · {DAMAGE_SEVERITY[d.severity as DamageSeverity] ?? d.severity}{d.size ? ` · ${d.size}` : ""}</dd>
              <dt className="label-xs self-center">Position</dt><dd>{DAMAGE_VIEWS[d.view as DamageView] ?? d.view}</dd>
              <dt className="label-xs self-center">Beschreibung</dt><dd className="whitespace-pre-line">{d.description}</dd>
              <dt className="label-xs self-center">Festgestellt</dt><dd>{fmtDateTime(c.reportedAt)} · {origin}{protocolHref && <> · <Link href={protocolHref} className="underline">Protokoll</Link></>}</dd>
              <dt className="label-xs self-center">Akte eröffnet</dt><dd>{fmtDateTime(c.createdAt)} von {c.reportedByName ?? "–"}</dd>
            </dl>
            <div className="px-4 pb-4">
              <div className="label-xs mb-1">Vorher / Nachher (aus den versiegelten Protokollen)</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div className="rounded-md border border-line-soft p-3">
                  <div className="font-medium">Übergabe</div>
                  {c.comparison.pickup ? <div className="text-ink-2">Dokumentiert in {c.comparison.pickup.number}: {c.comparison.pickup.description} · {c.comparison.pickup.photos} {c.comparison.pickup.photos === 1 ? "Foto" : "Fotos"}</div> : <div className="text-ink-3">Bei der Übergabe nicht dokumentiert.</div>}
                </div>
                <div className="rounded-md border border-line-soft p-3">
                  <div className="font-medium">Rückgabe</div>
                  {c.comparison.return ? <div className="text-ink-2">{c.comparison.return.marker === "NEW" ? "Neu festgestellt" : "Bereits bekannt"} in {c.comparison.return.number}: {c.comparison.return.description} · {c.comparison.return.photos} {c.comparison.return.photos === 1 ? "Foto" : "Fotos"}</div> : <div className="text-ink-3">Kein Rückgabeprotokoll zu diesem Schaden.</div>}
                </div>
              </div>
              <p className="text-xs text-ink-3 mt-2">„Bei Rückgabe neu festgestellt“ ist eine Feststellung, keine Haftungsentscheidung.</p>
            </div>
          </Card>

          {/* Skizze */}
          <Card title="Skizze">
            <div className="p-4">
              {sketch && view ? (
                <div className="rounded-lg border border-line bg-white p-2 max-w-md">
                  <div className="relative overflow-hidden" style={{ aspectRatio: `${view.box[2]} / ${view.box[3]}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={sketch.assetPath} alt="" draggable={false} className="absolute max-w-none h-auto select-none pointer-events-none" style={{ width: `${(SKETCH_CANVAS_WIDTH / view.box[2]) * 100}%`, left: `${(-view.box[0] / view.box[2]) * 100}%`, top: `${(-view.box[1] / view.box[3]) * 100}%` }} />
                    <svg viewBox={`${view.box[0]} ${view.box[1]} ${view.box[2]} ${view.box[3]}`} role="img" aria-label={`Fahrzeugskizze ${view.label}, Schadenposition markiert`} className="absolute inset-0 w-full h-full">
                      <circle cx={view.box[0] + d.posX * view.box[2]} cy={view.box[1] + d.posY * view.box[3]} r={view.box[2] * 0.035} fill="#b23a32" stroke="#fff" strokeWidth={view.box[2] * 0.006} />
                    </svg>
                  </div>
                  <div className="text-xs text-ink-3 mt-1">{view.label}</div>
                </div>
              ) : (
                <p className="text-sm text-ink-3">Für dieses Fahrzeug ist keine Skizze hinterlegt.</p>
              )}
            </div>
          </Card>
        </div>

        {/* Fotos */}
        <Card title="Fotos" right={<Chip>{d.photos.length + c.photos.length}</Chip>}>
          <div className="p-4 flex flex-col gap-3">
            {d.photos.length > 0 && (
              <div>
                <div className="label-xs mb-1">Aus Protokoll und Erfassung</div>
                <div className="flex gap-2 flex-wrap">
                  {d.photos.map((p) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <a key={p.id} href={`/api/photos/${p.id}`} target="_blank" rel="noopener noreferrer"><img src={`/api/photos/${p.id}`} alt="Schadenfoto" loading="lazy" className="h-24 w-32 object-cover rounded border border-line bg-panel-2" /></a>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="label-xs mb-1">Zur Akte ergänzt (Detail, Werkstatt, nach Reparatur)</div>
              {c.photos.length === 0 && <p className="text-sm text-ink-3">Noch keine Fotos ergänzt.</p>}
              <div className="flex gap-2 flex-wrap">
                {c.photos.map((p) => (
                  <figure key={p.id} className="flex flex-col gap-0.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <a href={`/api/photos/${p.id}`} target="_blank" rel="noopener noreferrer"><img src={`/api/photos/${p.id}`} alt={p.caption ?? "Foto zur Schadenakte"} loading="lazy" className="h-24 w-32 object-cover rounded border border-line bg-panel-2" /></a>
                    <figcaption className="text-[11px] text-ink-3 max-w-32 truncate">{p.caption ?? fmtDate(p.uploadedAt)}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
            {open && <CasePhotoUploader caseId={c.id} />}
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* Vermietung */}
          <Card title="Vermietung">
            {c.booking ? (
              <dl className="p-4 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
                <dt className="label-xs self-center">Buchung</dt><dd><Link href={`/buchungen/${c.booking.id}`} className="underline font-mono tnum">{c.booking.number}</Link></dd>
                <dt className="label-xs self-center">Kunde</dt><dd><Link href={`/kunden/${c.booking.customer.id}`} className="underline">{customerName(c.booking.customer)}</Link></dd>
                <dt className="label-xs self-center">Mietvertrag</dt><dd>{c.booking.contract?.status === "SIGNED" ? c.booking.contract.number : <span className="text-ink-3">nicht abgeschlossen</span>}</dd>
                <dt className="label-xs self-center">Mietzeitraum</dt><dd>{fmtDateTime(c.booking.actualPickupAt ?? c.booking.startAt)} – {fmtDateTime(c.booking.actualReturnAt ?? c.booking.endAt)}</dd>
                <dt className="label-xs self-center">Selbstbeteiligung</dt><dd>{c.deductibleCents != null ? <>{fmtCents(c.deductibleCents)} <span className="text-ink-3">laut Vertragskopie, nur zur Information</span></> : "–"}</dd>
                {c.otherCharges.length > 0 && <><dt className="label-xs self-start">Zusatzkosten</dt><dd>{c.otherCharges.map((x) => <div key={x.id}>{x.description}: <span className="font-mono tnum">{Number(x.amount).toLocaleString("de-DE", { minimumFractionDigits: 2 })} €</span> <span className="text-ink-3">(bei Rückgabe bestätigt, Teil der Mietrechnung)</span></div>)}</dd></>}
              </dl>
            ) : (
              <p className="p-4 text-sm text-ink-3">Dieser Schaden ist keiner Vermietung zugeordnet (auf dem Hof erfasst). Eine Kundenbelastung ist ohne Mietvertrag nicht möglich.</p>
            )}
          </Card>

          {/* Fahrzeug */}
          <Card title="Fahrzeug" right={<VehicleStatusChip status={c.vehicle.status} />}>
            <div className="p-4 flex flex-col gap-3 text-sm">
              <div><Plate>{c.vehicle.plate}</Plate> {c.vehicle.make} {c.vehicle.model}{c.vehicle.mileage != null ? ` · ${fmtInt(c.vehicle.mileage)} km` : ""} · <Link href={`/fahrzeuge/${c.vehicleId}`} className="underline">Fahrzeugakte</Link></div>
              {canManage && open && c.vehicle.status !== "BLOCKED" && c.vehicle.status !== "INACTIVE" && (
                <ConfirmReasonForm
                  action={blockVehicleAction.bind(null, c.id)}
                  label="Fahrzeug wegen Schaden sperren"
                  question="Fahrzeug sperren? Es ist dann nicht mehr buchbar und nicht übergebbar."
                  reasonLabel="Hinweis"
                  reasonRequired={false}
                  warning={future.length > 0 ? `Achtung: ${future.length} ${future.length === 1 ? "laufende oder künftige Buchung" : "laufende oder künftige Buchungen"} für dieses Fahrzeug (${future.slice(0, 3).map((b) => `${b.number} ab ${fmtDate(b.startAt)}`).join(", ")}${future.length > 3 ? ", …" : ""}). Nichts wird storniert oder umgebucht – bitte in der Dispo klären.` : null}
                  submitLabel="Ja, Fahrzeug sperren"
                  pendingLabel="Wird gesperrt…"
                  danger
                />
              )}
              {canManage && (c.vehicle.status === "BLOCKED" || c.vehicle.status === "WORKSHOP") && (
                <ConfirmReasonForm
                  action={releaseVehicleAction.bind(null, c.id)}
                  label="Fahrzeug wieder freigeben"
                  question="Fahrzeug freigeben (Status Verfügbar)? Bitte nur nach Prüfung – die Freigabe erfolgt nie automatisch."
                  reasonLabel="Hinweis"
                  reasonRequired={false}
                  submitLabel="Ja, Fahrzeug freigeben"
                  pendingLabel="Wird freigegeben…"
                />
              )}
              {!canManage && <p className="text-xs text-ink-3">Sperren und Freigeben des Fahrzeugs entscheidet die Disposition.</p>}
              <p className="text-xs text-ink-3">Eine offene Akte sperrt kein Fahrzeug; Reparatur- oder Aktenabschluss geben es nicht automatisch frei.</p>
            </div>
          </Card>
        </div>

        {/* Bearbeitung: Status, Priorität */}
        <Card title="Bearbeitung" right={<CaseStatusChip status={c.status} />}>
          <div className="p-4 flex flex-col gap-4">
            {canManage && open ? (
              <>
                <StatusForm action={changeStatusAction.bind(null, c.id)} current={c.status} allowed={allowed} />
                <PriorityForm action={setPriorityAction.bind(null, c.id)} current={c.priority} />
              </>
            ) : (
              <p className="text-sm text-ink-3">{open ? "Status und Priorität ändert die Disposition." : "Die Akte ist geschlossen."}</p>
            )}
          </div>
        </Card>

        {/* Haftung */}
        <Card title="Haftungsprüfung" right={<LiabilityChip status={c.liabilityStatus} />}>
          <div className="p-4 flex flex-col gap-3">
            {c.liabilityNote && <div className="text-sm"><span className="label-xs">Begründung</span><div>{c.liabilityNote}</div></div>}
            {canManage && open ? (
              <LiabilityForm action={setLiabilityAction.bind(null, c.id)} current={c.liabilityStatus} currentNote={c.liabilityNote} locked={c.customerChargeCents != null} />
            ) : (
              <p className="text-sm text-ink-3">{open ? "Die Haftung bewertet die Disposition." : "Die Akte ist geschlossen."}</p>
            )}
            <p className="text-xs text-ink-3">Mögliche Bewertungen: {Object.values(LIABILITY_STATUS).join(" · ")}. Rent-Base setzt nie automatisch eine Haftung.</p>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* Kosten */}
          <Card title="Kosten">
            <div className="p-4 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Kostenschätzung</div><div className="font-mono tnum text-lg font-semibold">{c.estimatedCostCents != null ? fmtCents(c.estimatedCostCents) : "–"}</div></div>
                <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Tatsächliche Reparaturkosten</div><div className="font-mono tnum text-lg font-semibold">{c.actualCostCents != null ? fmtCents(c.actualCostCents) : "–"}</div></div>
              </div>
              {canManage && open ? <CostsForm action={setCostsAction.bind(null, c.id)} estimated={eur(c.estimatedCostCents)} actual={eur(c.actualCostCents)} /> : <p className="text-xs text-ink-3">{open ? "Kosten trägt die Disposition ein." : "Die Akte ist geschlossen."}</p>}
            </div>
          </Card>

          {/* Reparatur */}
          <Card title="Reparatur">
            <div className="p-4 flex flex-col gap-3">
              <dl className="grid grid-cols-[150px_1fr] gap-y-1 text-sm">
                <dt className="label-xs self-center">Werkstatt</dt><dd>{c.repairProviderName ?? "–"}</dd>
                <dt className="label-xs self-center">Termin</dt><dd>{c.repairAppointmentAt ? fmtDateTime(c.repairAppointmentAt) : "–"}</dd>
                <dt className="label-xs self-center">Abgeschlossen</dt><dd>{c.repairCompletedAt ? fmtDateTime(c.repairCompletedAt) : "–"}</dd>
              </dl>
              {canManage && open ? <RepairForm action={setRepairAction.bind(null, c.id)} provider={c.repairProviderName ?? ""} appointmentAt={c.repairAppointmentAt ? toDateTimeInputValue(c.repairAppointmentAt) : ""} completedAt={c.repairCompletedAt ? toDateTimeInputValue(c.repairCompletedAt) : ""} /> : <p className="text-xs text-ink-3">{open ? "Reparaturdaten pflegt die Disposition." : "Die Akte ist geschlossen."}</p>}
            </div>
          </Card>
        </div>

        {/* Dokumente */}
        <Card title="Dokumente" right={<Chip>{c.documents.length}</Chip>}>
          <div className="p-4 flex flex-col gap-3">
            {c.documents.length === 0 && <p className="text-sm text-ink-3">Noch kein Dokument hinterlegt.</p>}
            <ul className="divide-y divide-line-soft text-sm">
              {c.documents.map((doc) => (
                <li key={doc.id} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <Chip>{DAMAGE_CASE_DOCUMENT_TYPES[doc.type as DamageCaseDocumentType] ?? doc.type}</Chip>
                  <a href={`/api/damage-documents/${doc.id}`} target="_blank" rel="noopener noreferrer" className="underline break-all">{doc.fileName}</a>
                  <span className="text-xs text-ink-3">{kb(doc.sizeBytes)} · {fmtDateTime(doc.createdAt)}{doc.createdByName ? ` · ${doc.createdByName}` : ""}</span>
                  {doc.note && <span className="text-xs text-ink-2">{doc.note}</span>}
                </li>
              ))}
            </ul>
            {open && <CaseDocumentUploader caseId={c.id} />}
          </div>
        </Card>

        {/* Kundenbelastung und Schadenabrechnung */}
        <Card title="Kundenbelastung und Schadenabrechnung" right={c.invoice ? (c.invoice.status === "FINALIZED" && c.payment ? <PaymentStatusChip status={c.payment.status} /> : <Chip tone="amber">Entwurf</Chip>) : c.customerChargeCents != null ? <Chip tone="info">festgelegt</Chip> : <Chip>keine</Chip>}>
          <div className="p-4 flex flex-col gap-3 text-sm">
            {c.customerChargeCents != null ? (
              <dl className="grid grid-cols-[170px_1fr] gap-y-1.5">
                <dt className="label-xs self-center">Betrag</dt><dd className="font-mono tnum font-semibold text-lg">{fmtCents(c.customerChargeCents)}</dd>
                <dt className="label-xs self-center">Grundlage</dt><dd>{c.customerChargeBasis}</dd>
                <dt className="label-xs self-center">Steuerlich</dt><dd>{DAMAGE_TAX_TREATMENTS[c.customerChargeTaxTreatment as DamageTaxTreatment] ?? c.customerChargeTaxTreatment}</dd>
                <dt className="label-xs self-center">Festgelegt</dt><dd>{c.customerChargeAt ? fmtDateTime(c.customerChargeAt) : "–"}{c.customerChargeByName ? ` von ${c.customerChargeByName}` : ""}</dd>
              </dl>
            ) : (
              <p className="text-ink-2">Keine Kundenbelastung. {c.liabilityStatus === "CUSTOMER_RESPONSIBILITY_CONFIRMED" ? (c.bookingId ? "Die Haftung des Kunden ist bestätigt; die Belastung kann festgelegt werden." : "Ohne Vermietung gibt es keinen Rechnungsempfänger.") : "Voraussetzung ist die Haftungsbewertung „Kunde verantwortlich (bestätigt)“."}</p>
            )}
            {c.invoice ? (
              <div className="rounded-md border border-line-soft p-3 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Schadenabrechnung {c.invoice.number ?? "(Entwurf)"}</span>
                  {c.invoice.status === "FINALIZED" ? <Chip tone="good">Finalisiert</Chip> : <Chip tone="amber">Entwurf</Chip>}
                  {c.invoice.currentVersion && <Chip>Fassung {c.invoice.currentVersion.versionNo}</Chip>}
                  {c.payment && <PaymentStatusChip status={c.payment.status} />}
                </div>
                {c.payment && <div className="text-xs text-ink-2 flex flex-wrap gap-x-3"><span>Betrag {fmtCents(c.payment.grossCents)}</span><span>bezahlt {fmtCents(c.payment.paidCents)}</span><span>{c.payment.status === "OVERPAID" ? `überzahlt ${fmtCents(c.payment.overpaidCents)}` : `offen ${fmtCents(c.payment.openCents)}`}</span></div>}
                {invoiceHref && <div><Link href={invoiceHref} className="btn btn-primary !py-1.5">{c.invoice.status === "FINALIZED" ? "Schadenabrechnung und Zahlungen" : "Entwurf der Schadenabrechnung öffnen"}</Link></div>}
                <p className="text-xs text-ink-3">Eigene Rechnung, getrennt von der Mietrechnung. Änderungen laufen über Fassungen (Neufassung oder Berichtigung).</p>
              </div>
            ) : (
              canCharge && <ChargeForm action={chargeCustomerAction.bind(null, c.id)} nonce={randomUUID()} hints={chargeHints} />
            )}
            {!canManage && <p className="text-xs text-ink-3">Kundenbelastung und Schadenabrechnung entscheidet die Disposition.</p>}
          </div>
        </Card>

        {/* Kaution informativ */}
        {c.bookingId && c.deposit && (
          <Card title="Kaution (zur Information)" right={<Chip tone={c.deposit.status === "RELEASED" ? "good" : c.deposit.status === "RETAINED" ? "bad" : "amber"}>{DEPOSIT_STATUS[c.deposit.status as keyof typeof DEPOSIT_STATUS] ?? c.deposit.status}</Chip>}>
            <div className="p-4 flex flex-col gap-2 text-sm">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Vereinbart</div><div className="font-mono tnum font-semibold">{fmtCents(c.deposit.expectedCents)}</div></div>
                <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Erhalten</div><div className="font-mono tnum font-semibold">{fmtCents(c.deposit.receivedCents)}</div></div>
                <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Freigegeben</div><div className="font-mono tnum font-semibold text-good">{fmtCents(c.deposit.releasedCents)}</div></div>
                <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Einbehalten</div><div className="font-mono tnum font-semibold text-bad">{fmtCents(c.deposit.retainedCents)}</div></div>
              </div>
              <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Kaution und Forderung wurden noch nicht miteinander verrechnet. Freigabe oder Einbehalt der Kaution wird ausschließlich unter <Link href={`/buchungen/${c.bookingId}#kaution`} className="underline">Buchung → Kaution</Link> dokumentiert.</p>
            </div>
          </Card>
        )}

        {/* Abschluss */}
        <Card title="Abschluss">
          <div className="p-4 flex flex-col gap-3 text-sm">
            {canManage && open && (
              <ConfirmReasonForm action={closeCaseAction.bind(null, c.id)} label="Schadenakte schließen" question="Schadenakte schließen? Der Vorgang bleibt vollständig sichtbar; Fahrzeugstatus, Rechnung und Kaution ändern sich dadurch nicht." reasonLabel="Abschlussgrund" submitLabel="Ja, Akte schließen" pendingLabel="Wird geschlossen…" />
            )}
            {canManage && !open && (
              <ConfirmReasonForm action={reopenCaseAction.bind(null, c.id)} label="Schadenakte wieder öffnen" question="Schadenakte wieder öffnen?" reasonLabel="Grund" submitLabel="Ja, wieder öffnen" pendingLabel="Wird geöffnet…" />
            )}
            {!canManage && <p className="text-xs text-ink-3">Schließen und Wiederöffnen entscheidet die Disposition.</p>}
            {canManage && open && (c.liabilityStatus === "UNASSESSED" || c.liabilityStatus === "UNCLEAR") && <p className="text-xs text-amber">Hinweis: Die Haftung ist noch nicht abschließend bewertet. Schließen ist trotzdem möglich (z. B. Bagatelle, keine Weiterverfolgung).</p>}
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* Notizen */}
          <Card title="Notizen">
            <div className="p-4 flex flex-col gap-4">
              {open && <NoteForm action={addNoteAction.bind(null, c.id)} />}
              {canManage && <InternalNoteForm action={setInternalNoteAction.bind(null, c.id)} value={c.internalNote ?? ""} />}
              {!canManage && c.internalNote && <div className="text-sm"><span className="label-xs">Interne Notiz</span><div className="whitespace-pre-line">{c.internalNote}</div></div>}
            </div>
          </Card>

          {/* Historie */}
          <Card title="Historie" right={<Chip>{c.events.length}</Chip>}>
            <ul className="divide-y divide-line-soft text-sm">
              {c.events.map((e) => (
                <li key={e.id} className="px-4 py-2 flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(e.createdAt)}</span>
                    <span className="font-medium">{DAMAGE_CASE_EVENT_TYPES[e.type as keyof typeof DAMAGE_CASE_EVENT_TYPES] ?? e.type}</span>
                    {e.userName && <span className="text-xs text-ink-3">{e.userName}</span>}
                  </div>
                  {(e.fromValue || e.toValue) && e.type !== "CUSTOMER_CHARGE_CREATED" && e.type !== "INVOICE_CREATED" && (
                    <div className="text-xs text-ink-2">{labelValue(e.type, e.fromValue)}{e.fromValue ? " → " : ""}{labelValue(e.type, e.toValue)}</div>
                  )}
                  {e.type === "CUSTOMER_CHARGE_CREATED" && e.toValue && <div className="text-xs text-ink-2">Betrag {fmtCents(Number(e.toValue))}</div>}
                  {e.reason && <div className="text-xs">Grund: {e.reason}</div>}
                  {e.note && <div className="text-xs text-ink-2 whitespace-pre-line">{e.note}</div>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </Content>
    </>
  );
}

function labelValue(type: string, v: string | null): string {
  if (!v) return "";
  if (type === "STATUS_CHANGED" || type === "CREATED" || type === "CLOSED" || type === "REOPENED") return ({ OPEN: "Offen", UNDER_REVIEW: "In Prüfung", REPAIR_PLANNED: "Reparatur geplant", IN_REPAIR: "In Reparatur", REPAIRED: "Repariert", CLOSED: "Geschlossen" } as Record<string, string>)[v] ?? v;
  if (type === "LIABILITY_CHANGED") return LIABILITY_STATUS[v as LiabilityStatus] ?? v;
  if (type === "VEHICLE_BLOCKED" || type === "VEHICLE_RELEASED") return ({ AVAILABLE: "Verfügbar", WORKSHOP: "Werkstatt", BLOCKED: "Gesperrt", INACTIVE: "Inaktiv" } as Record<string, string>)[v] ?? v;
  if (type === "DOCUMENT_ADDED") return DAMAGE_CASE_DOCUMENT_TYPES[v as DamageCaseDocumentType] ?? v;
  return v;
}

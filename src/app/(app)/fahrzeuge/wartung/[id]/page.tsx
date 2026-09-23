import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, PageHeader, Plate, VehicleStatusChip } from "@/components/ui";
import { LIABILITY_STATUS, MAINTENANCE_EVENT_TYPES, MAINTENANCE_PRIORITY, MAINTENANCE_STATUS, MAINTENANCE_TRANSITIONS, MAINTENANCE_TYPES, VEHICLE_DOCUMENT_TYPES, type LiabilityStatus, type MaintenancePriority, type MaintenanceStatus, type MaintenanceType, type VehicleDocumentType } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { maintenanceView } from "@/lib/maintenance";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { toDateInputValue, toDateTimeInputValue } from "@/lib/time";
import { CaseStatusChip, LiabilityChip } from "../../../schaeden/chips";
import { addNoteAction, adoptCostsAction, archiveDocumentAction, blockVehicleAction, cancelMaintenanceAction, changeStatusAction, completeMaintenanceAction, documentMileageAction, linkDamageCaseAction, linkDamageDocumentAction, releaseVehicleAction, setCostsAction, updateMaintenanceAction } from "../actions";
import { DueChip, MaintStatusChip, TypeChip } from "../chips";
import { CompleteForm, ConfirmReasonForm, CostsForm, DocumentUploader, EditMaintenanceForm, LinkCaseForm, MileageForm, NoteForm, SimpleButton, StatusButtons } from "../maintenance-forms";

export const metadata = { title: "Wartungsvorgang" };

const eur = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default async function MaintenancePage({ params, searchParams }: PageProps<"/fahrzeuge/wartung/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  let m: Awaited<ReturnType<typeof maintenanceView>>;
  try {
    m = await maintenanceView(tenant.id, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const canManage = user.role !== "YARD";
  const open = m.status !== "COMPLETED" && m.status !== "CANCELLED";
  const allowed = MAINTENANCE_TRANSITIONS[m.status as MaintenanceStatus] ?? [];
  const proposal = m.proposal ? { nextDueDate: m.proposal.nextDueDate ? toDateInputValue(m.proposal.nextDueDate) : "", nextDueMileage: m.proposal.nextDueMileage != null ? String(m.proposal.nextDueMileage) : "" } : null;
  const dc = m.damageCase;

  return (
    <>
      <PageHeader title={`${MAINTENANCE_TYPES[m.type as MaintenanceType] ?? m.type}: ${m.title}`} sub={<><Plate>{m.vehicle.plate}</Plate> {m.vehicle.make} {m.vehicle.model} · <span className="font-mono tnum">{m.maintenanceNumber}</span></>}>
        <MaintStatusChip status={m.status} />
        {m.priority !== "NORMAL" && <Chip tone={m.priority === "LOW" ? "grey" : "bad"}>Priorität {MAINTENANCE_PRIORITY[m.priority as MaintenancePriority]}</Chip>}
        <VehicleStatusChip status={m.vehicle.status} />
        <Link href="/fahrzeuge/wartung" className="btn">Übersicht</Link>
        <Link href={`/fahrzeuge/${m.vehicleId}?tab=wartung`} className="btn">Fahrzeugakte</Link>
      </PageHeader>
      <Content>
        {sp.neu === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Vorgang {m.maintenanceNumber} angelegt.{m.vehicle.status === "WORKSHOP" ? " Das Fahrzeug ist für die Werkstatt gesperrt." : " Das Fahrzeug bleibt verfügbar, bis es ausdrücklich gesperrt wird."}</p>}
        {m.overlaps.length > 0 && open && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm font-medium">Werkstatttermin überschneidet sich mit {m.overlaps.length === 1 ? "Buchung" : "Buchungen"} {m.overlaps.map((b) => <Link key={b.id} href={`/buchungen/${b.id}`} className="underline mr-1">{b.number} ({fmtDate(b.startAt)}–{fmtDate(b.endAt)})</Link>)} – keine automatische Änderung, bitte in der Dispo klären.</p>}
        {m.vehicle.status === "WORKSHOP" && <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">Fahrzeug für die Werkstatt gesperrt: nicht buchbar, nicht übergebbar. Freigabe unten unter „Fahrzeug“.</p>}
        {m.status === "CANCELLED" && <p className="rounded-md bg-panel-2 px-3.5 py-2.5 text-sm">Abgebrochen: {m.cancelReason}</p>}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card title="Vorgang" right={<TypeChip type={m.type} />}>
            <dl className="p-4 grid grid-cols-[150px_1fr] gap-y-1.5 text-sm">
              <dt className="label-xs self-center">Beschreibung</dt><dd className="whitespace-pre-line">{m.description ?? "–"}</dd>
              <dt className="label-xs self-center">Werkstatt</dt><dd>{m.workshopName ?? "–"}{m.workshopContact ? <span className="text-ink-3"> · {m.workshopContact}</span> : null}</dd>
              <dt className="label-xs self-center">Termin</dt><dd>{m.scheduledAt ? `${fmtDateTime(m.scheduledAt)}${m.scheduledEndAt ? ` – ${fmtDateTime(m.scheduledEndAt)}` : ""}` : "–"}</dd>
              <dt className="label-xs self-center">Begonnen</dt><dd>{m.startedAt ? fmtDateTime(m.startedAt) : "–"}</dd>
              <dt className="label-xs self-center">Erledigt</dt><dd>{m.completedAt ? `${fmtDateTime(m.completedAt)}${m.completedByName ? ` von ${m.completedByName}` : ""}` : "–"}</dd>
              <dt className="label-xs self-center">Kilometerstand</dt><dd>{m.mileageAtService != null ? `${m.mileageAtService.toLocaleString("de-DE")} km` : "–"} <span className="text-ink-3">(Fahrzeug aktuell {m.vehicle.mileage.toLocaleString("de-DE")} km)</span></dd>
              {m.workDone && <><dt className="label-xs self-start">Arbeiten</dt><dd className="whitespace-pre-line">{m.workDone}</dd></>}
              {(m.nextDueDate || m.nextDueMileage != null) && <><dt className="label-xs self-center">Nächste Fälligkeit</dt><dd>{[m.nextDueDate ? fmtDate(m.nextDueDate) : null, m.nextDueMileage != null ? `${m.nextDueMileage.toLocaleString("de-DE")} km` : null].filter(Boolean).join(" / ")}</dd></>}
              <dt className="label-xs self-center">Wartungsplan</dt><dd>{m.plan ? <><Link href={`/fahrzeuge/${m.vehicleId}?tab=faelligkeiten`} className="underline">{m.plan.title}</Link> <DueChip level={m.plan.due.level} text={m.plan.due.text} /></> : "– (einmaliger Vorgang)"}</dd>
              <dt className="label-xs self-center">Angelegt</dt><dd>{fmtDateTime(m.createdAt)}{m.createdByName ? ` von ${m.createdByName}` : ""}</dd>
              {canManage && <><dt className="label-xs self-start">Interne Notiz</dt><dd className="whitespace-pre-line">{m.internalNote ?? "–"}</dd></>}
            </dl>
            <div className="px-4 pb-4 flex flex-col gap-3">
              {canManage && <EditMaintenanceForm action={updateMaintenanceAction.bind(null, m.id)} finalized={!open} values={{ type: m.type, title: m.title, description: m.description ?? "", priority: m.priority, workshopName: m.workshopName ?? "", workshopContact: m.workshopContact ?? "", scheduledAt: m.scheduledAt ? toDateTimeInputValue(m.scheduledAt) : "", scheduledEndAt: m.scheduledEndAt ? toDateTimeInputValue(m.scheduledEndAt) : "", estimatedCostCents: eur(m.estimatedCostCents), internalNote: m.internalNote ?? "" }} />}
              {open && <StatusButtons action={changeStatusAction.bind(null, m.id)} current={m.status} allowed={allowed} canAll={canManage} />}
              {open && <MileageForm action={documentMileageAction.bind(null, m.id)} vehicleMileage={m.vehicle.mileage} />}
            </div>
          </Card>

          <Card title="Fahrzeug" right={<VehicleStatusChip status={m.vehicle.status} />}>
            <div className="p-4 flex flex-col gap-3 text-sm">
              <div><Plate>{m.vehicle.plate}</Plate> {m.vehicle.make} {m.vehicle.model} · {m.vehicle.mileage.toLocaleString("de-DE")} km · <Link href={`/fahrzeuge/${m.vehicleId}`} className="underline">Fahrzeugakte</Link></div>
              {m.futureBookings.length > 0 && <div className="rounded-md bg-panel-2 px-3 py-2 text-xs">Laufende/künftige Buchungen: {m.futureBookings.slice(0, 5).map((b) => <Link key={b.id} href={`/buchungen/${b.id}`} className="underline mr-2">{b.number} ({fmtDate(b.startAt)})</Link>)}{m.futureBookings.length > 5 ? "…" : ""}</div>}
              {canManage && open && m.vehicle.status === "AVAILABLE" && (
                <ConfirmReasonForm action={blockVehicleAction.bind(null, m.id)} label="Fahrzeug für Wartung sperren" question="Fahrzeug sperren? Es kann anschließend nicht für neue Vermietungen verwendet oder übergeben werden." reasonLabel="Hinweis" reasonRequired={false} warning={m.futureBookings.length > 0 ? `Dieses Fahrzeug ist noch in ${m.futureBookings.length} ${m.futureBookings.length === 1 ? "Buchung" : "Buchungen"} eingeplant. Nichts wird storniert oder umgebucht – bitte in der Dispo klären.` : null} submitLabel="Ja, Fahrzeug sperren" pendingLabel="Wird gesperrt…" danger />
              )}
              {canManage && m.vehicle.status === "WORKSHOP" && (
                <ConfirmReasonForm action={releaseVehicleAction.bind(null, m.id)} label="Fahrzeug freigeben" question={`Fahrzeug freigeben (Status Verfügbar)?${open ? " Der Vorgang ist noch nicht erledigt." : ""}`} reasonLabel="Hinweis" reasonRequired={false} submitLabel="Ja, Fahrzeug freigeben" pendingLabel="Wird freigegeben…" />
              )}
              {canManage && m.vehicle.status === "BLOCKED" && <p className="text-xs text-amber">Das Fahrzeug ist wegen eines Schadens gesperrt; die Freigabe läuft über die Schadenakte.</p>}
              {!canManage && <p className="text-xs text-ink-3">Sperren und Freigeben entscheidet die Disposition.</p>}
              <p className="text-xs text-ink-3">Ein Termin oder eine Fälligkeit sperrt nicht. Erledigt gibt nicht automatisch frei.</p>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card title="Kosten (intern)">
            <div className="p-4 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Kostenschätzung</div><div className="font-mono tnum text-lg font-semibold">{m.estimatedCostCents != null ? fmtCents(m.estimatedCostCents) : "–"}</div></div>
                <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Tatsächliche Kosten</div><div className="font-mono tnum text-lg font-semibold">{m.actualCostCents != null ? fmtCents(m.actualCostCents) : "–"}</div></div>
              </div>
              {canManage && open ? <CostsForm action={setCostsAction.bind(null, m.id)} estimated={eur(m.estimatedCostCents)} actual={eur(m.actualCostCents)} /> : <p className="text-xs text-ink-3">{open ? "Kosten trägt die Disposition ein." : "Kosten sind nach dem Abschluss fest."}</p>}
            </div>
          </Card>

          <Card title="Zugehörige Schadenakte" right={dc ? <CaseStatusChip status={dc.status} /> : <Chip>keine</Chip>}>
            <div className="p-4 flex flex-col gap-3 text-sm">
              {dc ? (
                <>
                  <div className="flex flex-wrap items-center gap-2"><Link href={`/schaeden/${dc.id}`} className="btn !py-1.5 font-mono tnum">{dc.caseNumber}</Link><LiabilityChip status={dc.liabilityStatus} /><span className="text-ink-2">{dc.description}</span></div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Reparaturkosten laut Akte</div><div className="font-mono tnum">{dc.actualCostCents != null ? fmtCents(dc.actualCostCents) : "–"}</div></div>
                    <div className="rounded-md bg-panel-2 p-3"><div className="label-xs">Tatsächliche Kosten dieses Vorgangs</div><div className="font-mono tnum">{m.actualCostCents != null ? fmtCents(m.actualCostCents) : "–"}</div></div>
                  </div>
                  {canManage && m.actualCostCents != null && dc.actualCostCents !== m.actualCostCents && dc.status !== "CLOSED" && (
                    <ConfirmReasonForm action={adoptCostsAction.bind(null, m.id)} label="Reparaturkosten in Schadenakte übernehmen" question={`Reparaturkosten der Schadenakte ${dc.caseNumber} von ${dc.actualCostCents != null ? fmtCents(dc.actualCostCents) : "–"} auf ${fmtCents(m.actualCostCents)} setzen?`} warning="Nur die Kosteninformation der Akte ändert sich. Haftung, Kundenbelastung und Schadenabrechnung bleiben unverändert." submitLabel="Ja, übernehmen" pendingLabel="Wird übernommen…" hidden={{ confirm: "1" }} />
                  )}
                  <p className="text-xs text-ink-3">Haftung {LIABILITY_STATUS[dc.liabilityStatus as LiabilityStatus] ?? dc.liabilityStatus}. Werkstattkosten bedeuten nie automatisch eine Kundenforderung.</p>
                </>
              ) : (
                <p className="text-ink-3">Kein Bezug zu einer Schadenakte.</p>
              )}
              {canManage && open && m.openCases.length > 0 && <LinkCaseForm action={linkDamageCaseAction.bind(null, m.id)} cases={m.openCases} current={m.damageCaseId} />}
            </div>
          </Card>
        </div>

        <Card title="Dokumente und Belege" right={<Chip>{m.activeDocuments.length + m.documentLinks.length}</Chip>}>
          <div className="p-4 flex flex-col gap-3 text-sm">
            {m.activeDocuments.length === 0 && m.documentLinks.length === 0 && <p className="text-ink-3">Noch kein Beleg hinterlegt.</p>}
            <ul className="divide-y divide-line-soft">
              {m.activeDocuments.map((d) => (
                <li key={d.id} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Chip>{VEHICLE_DOCUMENT_TYPES[d.type as VehicleDocumentType] ?? d.type}</Chip>
                  <a href={`/api/vehicle-documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline break-all">{d.fileName}</a>
                  <span className="text-xs text-ink-3">{d.documentDate ? `${fmtDate(d.documentDate)} · ` : ""}{kb(d.sizeBytes)} · hochgeladen {fmtDateTime(d.createdAt)}{d.createdByName ? ` von ${d.createdByName}` : ""}</span>
                  {d.description && <span className="text-xs text-ink-2">{d.description}</span>}
                  {canManage && (m.status !== "COMPLETED" || user.role === "OWNER") && <ConfirmReasonForm action={archiveDocumentAction.bind(null, d.id)} label="Archivieren" question={`„${d.fileName}“ archivieren? Datei und Eintrag bleiben nachvollziehbar erhalten.`} reasonLabel="Grund" submitLabel="Archivieren" pendingLabel="…" danger />}
                </li>
              ))}
              {m.documentLinks.map((l) => (
                <li key={l.id} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Chip tone="info">aus Schadenakte {l.damageCaseDocument.case.caseNumber}</Chip>
                  <a href={`/api/damage-documents/${l.damageCaseDocument.id}`} target="_blank" rel="noopener noreferrer" className="underline break-all">{l.damageCaseDocument.fileName}</a>
                  <span className="text-xs text-ink-3">verknüpft {fmtDateTime(l.createdAt)} – dieselbe Datei, keine Kopie</span>
                </li>
              ))}
            </ul>
            {m.archivedDocuments.length > 0 && <details className="text-xs text-ink-3"><summary className="cursor-pointer">{m.archivedDocuments.length} archivierte Dokumente</summary><ul className="mt-1 flex flex-col gap-1">{m.archivedDocuments.map((d) => <li key={d.id}><a href={`/api/vehicle-documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline">{d.fileName}</a> · archiviert {fmtDateTime(d.archivedAt!)} von {d.archivedByName ?? "–"}: {d.archiveReason}</li>)}</ul></details>}
            {canManage && m.linkableDamageDocuments.length > 0 && (
              <div className="rounded-md border border-line-soft p-3 flex flex-col gap-2">
                <div className="label-xs">Bereits in der Schadenakte vorhandene Dokumente verknüpfen (kein zweiter Upload)</div>
                {m.linkableDamageDocuments.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2"><span>{d.fileName}</span><SimpleButton action={linkDamageDocumentAction.bind(null, m.id)} label="Verknüpfen" pendingLabel="…" hidden={{ damageCaseDocumentId: d.id }} /></div>
                ))}
              </div>
            )}
            {m.status !== "CANCELLED" && <DocumentUploader endpoint={`/api/maintenance/${m.id}/documents`} defaultType={m.type === "HU_AU" ? "HU_REPORT" : m.type === "TIRES" ? "TIRE_DOCUMENT" : "WORKSHOP_INVOICE"} />}
          </div>
        </Card>

        <Card title="Abschluss">
          <div className="p-4 flex flex-col gap-3 text-sm">
            {canManage && open && (
              <div className="flex flex-wrap gap-3 items-start">
                <CompleteForm action={completeMaintenanceAction.bind(null, m.id)} defaults={{ completedAt: toDateTimeInputValue(new Date()), mileage: m.mileageAtService != null ? String(m.mileageAtService) : "", actualCost: eur(m.actualCostCents), workDone: m.workDone ?? "" }} proposal={proposal} hasPlan={!!m.plan} vehicleMileage={m.vehicle.mileage} />
                <ConfirmReasonForm action={cancelMaintenanceAction.bind(null, m.id)} label="Vorgang abbrechen" question="Vorgang abbrechen? Er bleibt in der Historie sichtbar." reasonLabel="Grund" submitLabel="Ja, abbrechen" pendingLabel="…" danger />
              </div>
            )}
            {!open && <p className="text-ink-3">Der Vorgang ist {MAINTENANCE_STATUS[m.status as MaintenanceStatus].toLowerCase()}.</p>}
            {!canManage && open && <p className="text-xs text-ink-3">Den Abschluss entscheidet die Disposition.</p>}
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card title="Notizen"><div className="p-4">{open ? <NoteForm action={addNoteAction.bind(null, m.id)} /> : <p className="text-sm text-ink-3">Keine weiteren Notizen nach dem Abschluss.</p>}</div></Card>
          <Card title="Historie" right={<Chip>{m.events.length}</Chip>}>
            <ul className="divide-y divide-line-soft text-sm">
              {m.events.map((e) => (
                <li key={e.id} className="px-4 py-2 flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2"><span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(e.createdAt)}</span><span className="font-medium">{MAINTENANCE_EVENT_TYPES[e.type as keyof typeof MAINTENANCE_EVENT_TYPES] ?? e.type}</span>{e.userName && <span className="text-xs text-ink-3">{e.userName}</span>}</div>
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

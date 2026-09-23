// Fahrzeugakte, Bereiche Fälligkeiten, Wartung & Werkstatt, Dokumente und Kosten. Datenquelle: vehicleMaintenanceOverview.
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { MAINTENANCE_TYPES, VEHICLE_DOCUMENT_TYPES, type MaintenanceType, type VehicleDocumentType } from "@/lib/constants";
import { type VehicleMaintenanceOverview } from "@/lib/maintenance";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { toDateInputValue } from "@/lib/time";
import { archiveDocumentAction, createPlanAction, setPlanActiveAction, updatePlanAction } from "../wartung/actions";
import { DueChip, MaintStatusChip, TypeChip } from "../wartung/chips";
import { ConfirmReasonForm, DocumentUploader, PlanForm, SimpleButton } from "../wartung/maintenance-forms";

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Kompakte Fälligkeiten (Übersicht): kritisch zuerst, mit Text statt nur Farbe. */
export function DueSummary({ o, vehicleId }: { o: VehicleMaintenanceOverview; vehicleId: string }) {
  const rows = o.plans.filter((p) => p.isActive);
  return (
    <Card title="Nächste Fälligkeiten" right={<Link href={`/fahrzeuge/${vehicleId}?tab=faelligkeiten`} className="text-xs underline">alle</Link>}>
      {rows.length === 0 && !o.hu.next ? (
        <p className="p-4 text-sm text-ink-3">Keine Wartungspläne hinterlegt.</p>
      ) : (
        <ul className="divide-y divide-line-soft text-sm">
          {rows.slice(0, 5).map((p) => (
            <li key={p.id} className="px-4 py-2 flex flex-wrap items-center gap-2"><span className="font-medium min-w-[120px]">{p.title}</span><DueChip level={p.due.level} text={p.due.text} /></li>
          ))}
          {!rows.some((p) => p.type === "HU_AU") && o.hu.next && o.hu.due && <li className="px-4 py-2 flex flex-wrap items-center gap-2"><span className="font-medium min-w-[120px]">HU/AU</span><DueChip level={o.hu.due.level} text={o.hu.due.text} /><span className="text-xs text-ink-3">{fmtDate(o.hu.next)} (Fahrzeugstammdaten, kein Plan)</span></li>}
        </ul>
      )}
    </Card>
  );
}

export function DueSection({ o, vehicleId, canManage }: { o: VehicleMaintenanceOverview; vehicleId: string; canManage: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="HU/AU" right={o.hu.due ? <DueChip level={o.hu.due.level} text={o.hu.due.text} /> : <Chip>kein Termin</Chip>}>
        <dl className="p-4 grid grid-cols-[150px_1fr] gap-y-1.5 text-sm">
          <dt className="label-xs self-center">Letzte HU</dt><dd>{o.hu.last?.completedAt ? <>{fmtDate(o.hu.last.completedAt)} · <Link href={`/fahrzeuge/wartung/${o.hu.last.id}`} className="underline font-mono tnum">{o.hu.last.maintenanceNumber}</Link></> : "– (kein erledigter HU-Vorgang)"}</dd>
          <dt className="label-xs self-center">Nächste HU</dt><dd>{o.hu.next ? fmtDate(o.hu.next) : "–"}</dd>
        </dl>
        <p className="px-4 pb-3 text-xs text-ink-3">Das nächste HU-Datum trägt der Mitarbeiter nach der HU ein; Rent-Base errät keine gesetzlichen Fristen. Ein HU-Plan und das HU-Datum am Fahrzeug bleiben synchron.</p>
      </Card>
      <Card title="Wartungspläne" right={<Chip>{o.plans.length}</Chip>}>
        <div className="p-4 flex flex-col gap-3">
          {o.plans.length === 0 && <p className="text-sm text-ink-3">Noch kein Wartungsplan. Ein Plan beschreibt eine wiederkehrende Fälligkeit (z. B. Inspektion alle 12 Monate / 20.000 km).</p>}
          <ul className="divide-y divide-line-soft">
            {o.plans.map((p) => (
              <li key={p.id} className="py-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <TypeChip type={p.type} /><span className="font-medium">{p.title}</span><DueChip level={p.due.level} text={p.due.text} />{!p.isActive && <Chip tone="grey">deaktiviert</Chip>}
                </div>
                <div className="text-xs text-ink-3 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>Intervall: {[p.intervalMonths ? `${p.intervalMonths} Monate` : null, p.intervalKilometers ? `${p.intervalKilometers.toLocaleString("de-DE")} km` : null].filter(Boolean).join(" / ") || "–"}</span>
                  <span>Nächste Fälligkeit: {[p.nextDueDate ? fmtDate(p.nextDueDate) : null, p.nextDueMileage != null ? `${p.nextDueMileage.toLocaleString("de-DE")} km` : null].filter(Boolean).join(" / ") || "–"}</span>
                  {p.lastMaintenance && <span>Zuletzt: <Link href={`/fahrzeuge/wartung/${p.lastMaintenance.id}`} className="underline">{p.lastMaintenance.maintenanceNumber}</Link>{p.lastMaintenance.completedAt ? ` am ${fmtDate(p.lastMaintenance.completedAt)}` : ""}</span>}
                  <span>Vorwarnung {p.warningDaysBefore} Tage / {p.warningKilometersBefore.toLocaleString("de-DE")} km</span>
                </div>
                {canManage && (
                  <div className="flex flex-wrap gap-2 items-start">
                    <Link href={`/fahrzeuge/wartung/neu?fahrzeug=${vehicleId}&plan=${p.id}&art=${p.type}`} className="btn !py-1.5">Vorgang anlegen</Link>
                    <PlanForm action={updatePlanAction.bind(null, p.id)} submitLabel="Plan bearbeiten" compact values={{ type: p.type, title: p.title, intervalMonths: p.intervalMonths ? String(p.intervalMonths) : "", intervalKilometers: p.intervalKilometers ? String(p.intervalKilometers) : "", nextDueDate: p.nextDueDate ? toDateInputValue(p.nextDueDate) : "", nextDueMileage: p.nextDueMileage != null ? String(p.nextDueMileage) : "", warningDaysBefore: p.warningDaysBefore, warningKilometersBefore: p.warningKilometersBefore, note: p.note ?? "", isActive: p.isActive }} />
                    <SimpleButton action={setPlanActiveAction.bind(null, p.id, !p.isActive)} label={p.isActive ? "Deaktivieren" : "Aktivieren"} pendingLabel="…" />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {canManage && <PlanForm action={createPlanAction.bind(null, vehicleId)} submitLabel="Wartungsplan anlegen" compact />}
          {!canManage && <p className="text-xs text-ink-3">Wartungspläne pflegt die Disposition.</p>}
        </div>
      </Card>
    </div>
  );
}

export function MaintenanceSection({ o, vehicleId, canManage }: { o: VehicleMaintenanceOverview; vehicleId: string; canManage: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Wartung & Werkstatt" right={<><Chip tone={o.open.length > 0 ? "amber" : "good"}>{o.open.length} offen</Chip>{o.done.length > 0 && <Chip>{o.done.length} erledigt</Chip>}</>}>
        {canManage && <div className="px-4 pt-3"><Link href={`/fahrzeuge/wartung/neu?fahrzeug=${vehicleId}`} className="btn btn-primary">Wartung / Werkstatt hinzufügen</Link></div>}
        {o.records.length === 0 ? (
          <p className="p-4 text-sm text-ink-3">Noch kein Werkstattvorgang dokumentiert.</p>
        ) : (
          <ul className="divide-y divide-line-soft text-sm">
            {o.records.map((r) => (
              <li key={r.id} className="px-4 py-2.5 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono tnum text-xs text-ink-3">{r.completedAt ? fmtDate(r.completedAt) : r.scheduledAt ? fmtDateTime(r.scheduledAt) : fmtDate(r.createdAt)}</span>
                  <TypeChip type={r.type} /><Link href={`/fahrzeuge/wartung/${r.id}`} className="font-medium hover:underline">{r.title}</Link><MaintStatusChip status={r.status} />
                  {r.damageCase && <Link href={`/schaeden/${r.damageCase.id}`} className="font-mono tnum text-xs underline">{r.damageCase.caseNumber}</Link>}
                </div>
                <div className="text-xs text-ink-3 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span className="font-mono tnum">{r.maintenanceNumber}</span>
                  {r.mileageAtService != null && <span>{r.mileageAtService.toLocaleString("de-DE")} km</span>}
                  {r.workshopName && <span>{r.workshopName}</span>}
                  {r.actualCostCents != null ? <span className="font-mono tnum">{fmtCents(r.actualCostCents)}</span> : r.estimatedCostCents != null ? <span className="font-mono tnum">~{fmtCents(r.estimatedCostCents)}</span> : null}
                  {r.documents.length > 0 && <span>Dokumente: {r.documents.map((d) => <a key={d.id} href={`/api/vehicle-documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline mr-1">{d.fileName}</a>)}</span>}
                  {(r.nextDueDate || r.nextDueMileage != null) && <span>Nächster Service: {[r.nextDueDate ? fmtDate(r.nextDueDate) : null, r.nextDueMileage != null ? `${r.nextDueMileage.toLocaleString("de-DE")} km` : null].filter(Boolean).join(" / ")}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CostsCard o={o} />
    </div>
  );
}

export function CostsCard({ o }: { o: VehicleMaintenanceOverview }) {
  return (
    <Card title="Wartung & Reparatur – Kosten" right={<Chip>nur erledigte Vorgänge</Chip>}>
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        {o.costs.map((y) => (
          <div key={y.year} className="flex flex-col gap-1">
            <div className="font-semibold">{y.year}</div>
            {y.byType.length === 0 && <div className="text-ink-3">Keine erledigten Vorgänge mit Kosten.</div>}
            {y.byType.map((t) => <div key={t.type} className="flex justify-between gap-3"><span>{MAINTENANCE_TYPES[t.type as MaintenanceType] ?? t.type} ({t.count})</span><span className="font-mono tnum">{fmtCents(t.cents)}</span></div>)}
            <div className="flex justify-between gap-3 border-t border-line-soft pt-1 font-semibold"><span>Gesamt Wartung/Werkstatt</span><span className="font-mono tnum">{fmtCents(y.total)}</span></div>
          </div>
        ))}
      </div>
      <p className="px-4 pb-3 text-xs text-ink-3">Operative Übersicht interner Kosten – keine Buchhaltung, keine Mietumsätze, keine Kundenforderungen, keine Kaution.</p>
    </Card>
  );
}

export function DocumentsSection({ o, vehicleId, canManage, isOwner }: { o: VehicleMaintenanceOverview; vehicleId: string; canManage: boolean; isOwner: boolean }) {
  const active = o.documents.filter((d) => !d.archivedAt);
  const archived = o.documents.filter((d) => !!d.archivedAt);
  return (
    <Card title="Fahrzeugdokumente" right={<Chip>{active.length + o.damageDocuments.length}</Chip>}>
      <div className="p-4 flex flex-col gap-3 text-sm">
        {active.length === 0 && o.damageDocuments.length === 0 && <p className="text-ink-3">Noch keine Dokumente in der Fahrzeugakte.</p>}
        <ul className="divide-y divide-line-soft">
          {active.map((d) => (
            <li key={d.id} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Chip>{VEHICLE_DOCUMENT_TYPES[d.type as VehicleDocumentType] ?? d.type}</Chip>
              <a href={`/api/vehicle-documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline break-all">{d.fileName}</a>
              <span className="text-xs text-ink-3">{d.documentDate ? `${fmtDate(d.documentDate)} · ` : ""}{kb(d.sizeBytes)} · {fmtDateTime(d.createdAt)}{d.createdByName ? ` · ${d.createdByName}` : ""}</span>
              {d.maintenance ? <Link href={`/fahrzeuge/wartung/${d.maintenance.id}`} className="text-xs underline">Vorgang {d.maintenance.maintenanceNumber}</Link> : <span className="text-xs text-ink-3">allgemeines Fahrzeugdokument</span>}
              {d.description && <span className="text-xs text-ink-2">{d.description}</span>}
              {canManage && (!d.maintenance || isOwner) && <ConfirmReasonForm action={archiveDocumentAction.bind(null, d.id)} label="Archivieren" question={`„${d.fileName}“ archivieren? Datei und Eintrag bleiben erhalten.`} reasonLabel="Grund" submitLabel="Archivieren" pendingLabel="…" danger />}
            </li>
          ))}
          {o.damageDocuments.map((d) => (
            <li key={d.id} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Chip tone="info">Schadenakte {d.case.caseNumber}</Chip>
              <a href={`/api/damage-documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline break-all">{d.fileName}</a>
              <span className="text-xs text-ink-3">{kb(d.sizeBytes)} · {fmtDateTime(d.createdAt)}</span>
              <Link href={`/schaeden/${d.case.id}`} className="text-xs underline">Akte</Link>
            </li>
          ))}
        </ul>
        {archived.length > 0 && <details className="text-xs text-ink-3"><summary className="cursor-pointer">{archived.length} archivierte Dokumente</summary><ul className="mt-1 flex flex-col gap-1">{archived.map((d) => <li key={d.id}><a href={`/api/vehicle-documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline">{d.fileName}</a> · archiviert {fmtDateTime(d.archivedAt!)} von {d.archivedByName ?? "–"}: {d.archiveReason}</li>)}</ul></details>}
        {canManage ? <DocumentUploader endpoint={`/api/vehicles/${vehicleId}/documents`} defaultType="REGISTRATION" /> : <p className="text-xs text-ink-3">Allgemeine Fahrzeugdokumente lädt die Disposition hoch; Belege zu Werkstattvorgängen können am jeweiligen Vorgang ergänzt werden.</p>}
      </div>
    </Card>
  );
}

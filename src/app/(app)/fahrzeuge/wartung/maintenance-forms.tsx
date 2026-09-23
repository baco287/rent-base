"use client";

// Formulare des Wartungsmanagements. Entscheidungen mit Tragweite (Sperren, Abschluss, Kostenübernahme, Archivierung)
// verlangen eine Rückfrage; nach Erfolg lädt die Seite die Serverdaten neu. Beträge und Kilometer prüft der Server.

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { MAINTENANCE_PRIORITY, MAINTENANCE_STATUS, MAINTENANCE_TYPES, VEHICLE_DOCUMENT_TYPES, type MaintenanceStatus } from "@/lib/constants";
import type { MaintState } from "./actions";

type Action = (prev: MaintState, formData: FormData) => Promise<MaintState>;

export function Feedback({ state }: { state: MaintState }) {
  if (!state) return null;
  return (
    <div className="flex flex-col gap-1">
      {state.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>}
      {state.ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>}
      {state.warnings?.map((w, i) => <p key={i} role="alert" className="text-amber bg-amber-soft rounded-md px-3 py-2 text-sm">{w}</p>)}
    </div>
  );
}

function useMaintAction(action: Action) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: MaintState, fd: FormData) => {
    const res = await action(prev, fd);
    if (res?.ok) router.refresh();
    return res;
  }, undefined);
  return { state, formAction, pending };
}

const Field = ({ label, children, className = "", hint }: { label: string; children: React.ReactNode; className?: string; hint?: string }) => (
  <label className={`flex flex-col gap-1 ${className}`}><span className="label-xs">{label}</span>{children}{hint && <span className="text-xs text-ink-3">{hint}</span>}</label>
);

const TypeSelect = ({ name, defaultValue = "INSPECTION" }: { name: string; defaultValue?: string }) => (
  <select name={name} defaultValue={defaultValue} className="input">{Object.entries(MAINTENANCE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
);

// ---------------------------------------------------------------------------
// Wartungsplan anlegen / bearbeiten
// ---------------------------------------------------------------------------

export type PlanValues = { type: string; title: string; intervalMonths: string; intervalKilometers: string; nextDueDate: string; nextDueMileage: string; warningDaysBefore: number; warningKilometersBefore: number; note: string; isActive: boolean };

export function PlanForm({ action, values, submitLabel, compact = false, onDone }: { action: Action; values?: PlanValues; submitLabel: string; compact?: boolean; onDone?: () => void }) {
  const { state, formAction, pending } = useMaintAction(action);
  const [open, setOpen] = useState(!compact);
  if (compact && !open) return <div className="inline-flex flex-col gap-1"><button type="button" className="btn" onClick={() => setOpen(true)}>{submitLabel}</button><Feedback state={state} /></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Wartungsart"><TypeSelect name="type" defaultValue={values?.type ?? "INSPECTION"} /></Field>
        <Field label="Bezeichnung (optional)"><input name="title" defaultValue={values?.title ?? ""} maxLength={120} className="input" placeholder="z. B. Große Inspektion" /></Field>
        <Field label="Intervall in Monaten" hint="leer = kein Datumsintervall"><input name="intervalMonths" defaultValue={values?.intervalMonths ?? ""} inputMode="numeric" className="input tnum" placeholder="z. B. 12" /></Field>
        <Field label="Intervall in km" hint="leer = kein Kilometerintervall"><input name="intervalKilometers" defaultValue={values?.intervalKilometers ?? ""} inputMode="numeric" className="input tnum" placeholder="z. B. 20000" /></Field>
        <Field label="Nächste Fälligkeit (Datum)"><input name="nextDueDate" type="date" defaultValue={values?.nextDueDate ?? ""} className="input" /></Field>
        <Field label="Nächste Fälligkeit (km)"><input name="nextDueMileage" defaultValue={values?.nextDueMileage ?? ""} inputMode="numeric" className="input tnum" placeholder="z. B. 100000" /></Field>
        <Field label="Vorwarnung Tage"><input name="warningDaysBefore" type="number" min={0} max={365} defaultValue={values?.warningDaysBefore ?? 30} className="input tnum" /></Field>
        <Field label="Vorwarnung km"><input name="warningKilometersBefore" type="number" min={0} max={100000} defaultValue={values?.warningKilometersBefore ?? 1000} className="input tnum" /></Field>
        <Field label="Notiz (optional)" className="sm:col-span-2"><input name="note" defaultValue={values?.note ?? ""} maxLength={500} className="input" /></Field>
        {values && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="isActive" value="1" defaultChecked={values.isActive} /> Plan aktiv (erzeugt Warnungen)</label>}
      </div>
      <p className="text-xs text-ink-3">Fällig ist, was zuerst erreicht wird – Datum oder Kilometer. Eine Fälligkeit warnt nur; sie sperrt kein Fahrzeug.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : submitLabel}</button>
        {(compact || onDone) && <button type="button" className="btn" onClick={() => { setOpen(false); onDone?.(); }}>Abbrechen</button>}
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function SimpleButton({ action, label, pendingLabel, danger = false, small = true, hidden }: { action: Action; label: string; pendingLabel: string; danger?: boolean; small?: boolean; hidden?: Record<string, string> }) {
  const { state, formAction, pending } = useMaintAction(action);
  return (
    <form action={formAction} className="inline-flex flex-col gap-1">
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" disabled={pending} className={`btn ${danger ? "btn-danger" : ""} ${small ? "!py-1.5" : ""}`}>{pending ? pendingLabel : label}</button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Wartungsvorgang anlegen (kompakt, ein Formular)
// ---------------------------------------------------------------------------

export type PlanOption = { id: string; title: string; type: string };
export type CaseOption = { id: string; caseNumber: string; description: string };

export function CreateMaintenanceForm({ action, plans, cases, presetPlanId, presetCaseId, presetType, vehicleMileage }: { action: Action; plans: PlanOption[]; cases: CaseOption[]; presetPlanId?: string | null; presetCaseId?: string | null; presetType?: string | null; vehicleMileage: number }) {
  const { state, formAction, pending } = useMaintAction(action);
  const [type, setType] = useState(presetType ?? (presetCaseId ? "DAMAGE_REPAIR" : "INSPECTION"));
  const [block, setBlock] = useState(false);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Art"><select name="type" value={type} onChange={(e) => setType(e.target.value)} className="input">{Object.entries(MAINTENANCE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Priorität"><select name="priority" defaultValue="NORMAL" className="input">{Object.entries(MAINTENANCE_PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Titel" className="sm:col-span-2"><input name="title" required minLength={2} maxLength={160} className="input" placeholder="z. B. Inspektion 80.000 km" defaultValue={presetType ? MAINTENANCE_TYPES[presetType as keyof typeof MAINTENANCE_TYPES] ?? "" : ""} /></Field>
        <Field label="Beschreibung (optional)" className="sm:col-span-2"><textarea name="description" rows={2} maxLength={2000} className="input" /></Field>
        {plans.length > 0 && <Field label="Zum Wartungsplan (optional)"><select name="planId" defaultValue={presetPlanId ?? ""} className="input"><option value="">– kein Plan –</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.title} ({MAINTENANCE_TYPES[p.type as keyof typeof MAINTENANCE_TYPES] ?? p.type})</option>)}</select></Field>}
        {(type === "DAMAGE_REPAIR" || presetCaseId) && cases.length > 0 && <Field label="Zugehörige Schadenakte" hint="Nur Akten dieses Fahrzeugs. Haftung und Kundenbelastung ändern sich dadurch nicht."><select name="damageCaseId" defaultValue={presetCaseId ?? ""} className="input"><option value="">– keine –</option>{cases.map((c) => <option key={c.id} value={c.id}>{c.caseNumber} · {c.description.slice(0, 60)}</option>)}</select></Field>}
        <Field label="Werkstatt (optional)"><input name="workshopName" maxLength={160} className="input" placeholder="z. B. Autohaus Muster GmbH" /></Field>
        <Field label="Werkstattkontakt (optional)"><input name="workshopContact" maxLength={200} className="input" placeholder="Ansprechpartner, Telefon oder E-Mail" /></Field>
        <Field label="Werkstatttermin (optional)"><input name="scheduledAt" type="datetime-local" className="input" /></Field>
        <Field label="Terminende (optional)"><input name="scheduledEndAt" type="datetime-local" className="input" /></Field>
        <Field label="Kilometerstand (optional)" hint={`aktuell ${vehicleMileage.toLocaleString("de-DE")} km`}><input name="mileageAtService" inputMode="numeric" className="input tnum" /></Field>
        <Field label="Kostenschätzung in € (optional)"><input name="estimatedCostCents" inputMode="decimal" className="input tnum" placeholder="0,00" /></Field>
        <Field label="Interne Notiz (optional)" className="sm:col-span-2"><input name="internalNote" maxLength={2000} className="input" /></Field>
      </div>
      <label className="flex items-start gap-2 rounded-md bg-panel-2 px-3 py-2 text-sm">
        <input type="checkbox" name="blockVehicle" value="1" checked={block} onChange={(e) => setBlock(e.target.checked)} className="mt-1" />
        <span><span className="font-medium">Fahrzeug jetzt für die Werkstatt sperren.</span> Es ist dann nicht mehr buchbar und nicht übergebbar, bis es ausdrücklich freigegeben wird. Ohne Häkchen bleibt das Fahrzeug verfügbar; ein Termin ist nur eine Warnung.</span>
      </label>
      <p className="text-xs text-ink-3">Kosten sind interne Betriebskosten – es entsteht keine Rechnung, keine Forderung und keine Änderung an einer Schadenakte.</p>
      <div><button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird angelegt…" : "Vorgang anlegen"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Vorgang bearbeiten, Status, Kosten, Kilometer, Notizen
// ---------------------------------------------------------------------------

export type MaintValues = { type: string; title: string; description: string; priority: string; workshopName: string; workshopContact: string; scheduledAt: string; scheduledEndAt: string; estimatedCostCents: string; internalNote: string };

export function EditMaintenanceForm({ action, values, finalized }: { action: Action; values: MaintValues; finalized: boolean }) {
  const { state, formAction, pending } = useMaintAction(action);
  const [open, setOpen] = useState(false);
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className="btn !py-1.5" onClick={() => setOpen(true)}>{finalized ? "Interne Notiz bearbeiten" : "Vorgang bearbeiten"}</button><Feedback state={state} /></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      {!finalized && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Art"><TypeSelect name="type" defaultValue={values.type} /></Field>
          <Field label="Priorität"><select name="priority" defaultValue={values.priority} className="input">{Object.entries(MAINTENANCE_PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Titel" className="sm:col-span-2"><input name="title" defaultValue={values.title} required minLength={2} maxLength={160} className="input" /></Field>
          <Field label="Beschreibung" className="sm:col-span-2"><textarea name="description" defaultValue={values.description} rows={2} maxLength={2000} className="input" /></Field>
          <Field label="Werkstatt"><input name="workshopName" defaultValue={values.workshopName} maxLength={160} className="input" /></Field>
          <Field label="Werkstattkontakt"><input name="workshopContact" defaultValue={values.workshopContact} maxLength={200} className="input" /></Field>
          <Field label="Werkstatttermin"><input name="scheduledAt" type="datetime-local" defaultValue={values.scheduledAt} className="input" /></Field>
          <Field label="Terminende"><input name="scheduledEndAt" type="datetime-local" defaultValue={values.scheduledEndAt} className="input" /></Field>
          <Field label="Kostenschätzung in €"><input name="estimatedCostCents" defaultValue={values.estimatedCostCents} inputMode="decimal" className="input tnum" /></Field>
        </div>
      )}
      <Field label="Interne Notiz (nie auf Kundenunterlagen)"><textarea name="internalNote" defaultValue={values.internalNote} rows={2} maxLength={2000} className="input" /></Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Speichern"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Schließen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function StatusButtons({ action, current, allowed, canAll }: { action: Action; current: string; allowed: MaintenanceStatus[]; canAll: boolean }) {
  const { state, formAction, pending } = useMaintAction(action);
  const options = allowed.filter((s) => s !== "COMPLETED" && s !== "CANCELLED" && (canAll || s === "IN_PROGRESS"));
  if (options.length === 0) return null;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-ink-3">Aktuell: {MAINTENANCE_STATUS[current as MaintenanceStatus] ?? current}</span>
        {options.map((s) => <button key={s} type="submit" name="to" value={s} disabled={pending} className={`btn !py-1.5 ${s === "IN_PROGRESS" ? "btn-primary" : ""}`}>{s === "IN_PROGRESS" ? "In Arbeit setzen" : s === "SCHEDULED" ? "Als Werkstatttermin führen" : "Zurück auf Geplant"}</button>)}
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function CostsForm({ action, estimated, actual }: { action: Action; estimated: string; actual: string }) {
  const { state, formAction, pending } = useMaintAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Kostenschätzung in €"><input name="estimated" defaultValue={estimated} inputMode="decimal" placeholder="0,00" className="input tnum" /></Field>
        <Field label="Tatsächliche Kosten in €"><input name="actual" defaultValue={actual} inputMode="decimal" placeholder="0,00" className="input tnum" /></Field>
      </div>
      <p className="text-xs text-ink-3">Interne Betriebskosten. Keine Rechnung, keine Kundenforderung, keine Änderung der Schadenakte.</p>
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Kosten speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

export function MileageForm({ action, vehicleMileage }: { action: Action; vehicleMileage: number }) {
  const { state, formAction, pending } = useMaintAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-wrap gap-2 items-end">
      <Field label="Kilometerstand beim Service" hint={`Fahrzeug aktuell ${vehicleMileage.toLocaleString("de-DE")} km – ein höherer Wert schreibt den Fahrzeugstand fort, ein niedrigerer bleibt historisch`}><input name="mileage" required inputMode="numeric" className="input tnum" /></Field>
      <button type="submit" disabled={pending} className="btn">{pending ? "…" : "Kilometer dokumentieren"}</button>
      <div className="basis-full"><Feedback state={state} /></div>
    </form>
  );
}

export function NoteForm({ action }: { action: Action }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: MaintState, fd: FormData) => { const res = await action(prev, fd); if (res?.ok) router.refresh(); return res; }, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Field label="Operative Notiz"><textarea name="note" required minLength={2} maxLength={2000} rows={2} className="input" placeholder="z. B. Werkstatt angerufen, Ersatzteil bestellt" /></Field>
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Notiz speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Abschluss: Datum, Kilometer, Kosten, Arbeiten, nächste Fälligkeit (Vorschlag aus dem Plan)
// ---------------------------------------------------------------------------

export function CompleteForm({ action, defaults, proposal, hasPlan, vehicleMileage }: { action: Action; defaults: { completedAt: string; mileage: string; actualCost: string; workDone: string }; proposal: { nextDueDate: string; nextDueMileage: string } | null; hasPlan: boolean; vehicleMileage: number }) {
  const { state, formAction, pending } = useMaintAction(action);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [setNext, setSetNext] = useState(hasPlan);
  const form = useRef<HTMLFormElement>(null);
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Als erledigt markieren</button><Feedback state={state} /></div>;
  return (
    <form ref={form} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <div className="font-medium">Vorgang abschließen</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Erledigt am"><input name="completedAt" type="datetime-local" required defaultValue={defaults.completedAt} className="input" onChange={() => setConfirm(false)} /></Field>
        <Field label="Kilometerstand" hint={`Fahrzeug aktuell ${vehicleMileage.toLocaleString("de-DE")} km`}><input name="mileage" inputMode="numeric" defaultValue={defaults.mileage} className="input tnum" onChange={() => setConfirm(false)} /></Field>
        <Field label="Tatsächliche Kosten in €"><input name="actualCost" inputMode="decimal" defaultValue={defaults.actualCost} placeholder="0,00" className="input tnum" onChange={() => setConfirm(false)} /></Field>
        <Field label="Ausgeführte Arbeiten" className="sm:col-span-2"><textarea name="workDone" rows={2} maxLength={2000} defaultValue={defaults.workDone} className="input" onChange={() => setConfirm(false)} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="setNextDue" value="1" checked={setNext} onChange={(e) => { setSetNext(e.target.checked); setConfirm(false); }} /> Nächste Fälligkeit eintragen{hasPlan ? " (Wartungsplan wird fortgeschrieben)" : ""}</label>
        {setNext && <Field label="Nächste Fälligkeit (Datum)" hint={proposal?.nextDueDate ? "Vorschlag aus dem Intervall – bitte bestätigen oder ändern" : undefined}><input name="nextDueDate" type="date" defaultValue={proposal?.nextDueDate ?? ""} className="input" onChange={() => setConfirm(false)} /></Field>}
        {setNext && <Field label="Nächste Fälligkeit (km)" hint={proposal?.nextDueMileage ? "Vorschlag aus dem Intervall – bitte bestätigen oder ändern" : undefined}><input name="nextDueMileage" inputMode="numeric" defaultValue={proposal?.nextDueMileage ?? ""} className="input tnum" onChange={() => setConfirm(false)} /></Field>}
      </div>
      <p className="text-xs text-ink-3">Nach dem Abschluss sind Datum, Kilometer, Kosten und Status fest. Ein für die Werkstatt gesperrtes Fahrzeug bleibt gesperrt, bis es ausdrücklich freigegeben wird.</p>
      {!confirm ? (
        <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-primary" onClick={() => { if (form.current?.reportValidity()) setConfirm(true); }}>Weiter zur Bestätigung</button><button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button></div>
      ) : (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2">
          <div className="font-medium">Vorgang als erledigt abschließen?</div>
          <div className="flex flex-wrap gap-2"><button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird abgeschlossen…" : "Ja, erledigt"}</button><button type="button" className="btn" onClick={() => setConfirm(false)}>Zurück</button></div>
        </div>
      )}
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Aktionen mit Grund/Rückfrage: Sperren, Freigeben, Abbrechen, Archivieren, Kostenübernahme
// ---------------------------------------------------------------------------

export function ConfirmReasonForm({ action, label, question, reasonLabel, reasonRequired = true, warning, danger = false, submitLabel, pendingLabel, hidden }: { action: Action; label: string; question: string; reasonLabel?: string; reasonRequired?: boolean; warning?: string | null; danger?: boolean; submitLabel: string; pendingLabel: string; hidden?: Record<string, string> }) {
  const { state, formAction, pending } = useMaintAction(action);
  const [open, setOpen] = useState(false);
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className={`btn !py-1.5 ${danger ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>{label}</button><Feedback state={state} /></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-2 rounded-lg border-2 p-4 text-sm ${danger ? "border-bad/40 bg-bad-soft/30" : "border-brand bg-panel"}`}>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <div className="font-medium">{question}</div>
      {warning && <p className="rounded-md bg-amber-soft text-amber px-3 py-2">{warning}</p>}
      {reasonLabel && <label className="flex flex-col gap-1"><span className="label-xs">{reasonLabel}{reasonRequired ? " (Pflicht)" : " (optional)"}</span><input name={reasonRequired ? "reason" : "note"} required={reasonRequired} minLength={reasonRequired ? 3 : undefined} maxLength={500} className="input" /></label>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={`btn ${danger ? "btn-danger" : "btn-primary"}`}>{pending ? pendingLabel : submitLabel}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function LinkCaseForm({ action, cases, current }: { action: Action; cases: { id: string; caseNumber: string; description: string }[]; current: string | null }) {
  const { state, formAction, pending } = useMaintAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-wrap gap-2 items-end">
      <Field label="Schadenakte dieses Fahrzeugs"><select name="damageCaseId" defaultValue={current ?? ""} className="input"><option value="">– keine –</option>{cases.map((c) => <option key={c.id} value={c.id}>{c.caseNumber} · {c.description.slice(0, 60)}</option>)}</select></Field>
      <button type="submit" disabled={pending} className="btn">{pending ? "…" : "Verknüpfung speichern"}</button>
      <div className="basis-full"><Feedback state={state} /></div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Beleg-/Dokument-Upload über die geschützten API-Routen
// ---------------------------------------------------------------------------

export function DocumentUploader({ endpoint, defaultType = "WORKSHOP_INVOICE", types }: { endpoint: string; defaultType?: string; types?: string[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const entries = Object.entries(VEHICLE_DOCUMENT_TYPES).filter(([k]) => !types || types.includes(k));
  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || !form.current) return;
    setBusy(true); setError(null); setOk(null);
    try {
      const fd = new FormData(form.current);
      let n = 0;
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.set("file", file, file.name);
        body.set("type", String(fd.get("type") ?? defaultType));
        if (fd.get("description")) body.set("description", String(fd.get("description")));
        if (fd.get("documentDate")) body.set("documentDate", String(fd.get("documentDate")));
        const res = await fetch(endpoint, { method: "POST", body });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Das Dokument konnte nicht gespeichert werden.");
        n++;
      }
      form.current.reset();
      setOk(n === 1 ? "Dokument hochgeladen." : `${n} Dokumente hochgeladen.`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <form ref={form} onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,200px)_minmax(0,160px)_1fr_auto] gap-2 items-end">
        <Field label="Dokumenttyp"><select name="type" className="input" defaultValue={defaultType}>{entries.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Dokumentdatum"><input name="documentDate" type="date" className="input" /></Field>
        <Field label="Beschreibung (optional)"><input name="description" maxLength={300} className="input" placeholder="z. B. Rechnung Nr. 4711" /></Field>
        <input ref={input} type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Wird hochgeladen…" : "Dokument hochladen"}</button>
      </div>
      <p className="text-xs text-ink-3">PDF oder Bild bis 8 MB. Kein OCR: Beträge werden nicht ausgelesen.</p>
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error}</p>}
      {ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{ok}</p>}
    </form>
  );
}

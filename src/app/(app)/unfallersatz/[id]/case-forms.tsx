"use client";

// Befehl 29 Phase D: Formulare der Unfallersatz-Fallakte. Jede Bearbeitung ändert die Kopie im Fall; das Adressbuch nur mit
// ausdrücklichem Häkchen. Nach Erfolg lädt die Seite die Serverdaten neu. Eingaben bleiben bei Fehlern stehen (submitWithoutReset);
// action={formAction} sorgt dafür, dass vor dem Laden des Skripts nie ein GET mit Eingaben in der Adresszeile entsteht.

import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { ACCIDENT_CASE_DOCUMENT_TYPES, ACCIDENT_DAMAGE_KINDS, ACCIDENT_LIABILITY_STATUS, INVOICE_ADJUSTMENT_REASONS } from "@/lib/constants";
import type { PartnerOption } from "@/lib/business-partners";
import { PartnerName, type PartnerState } from "../partner-field";
import type { AccidentPreviewResult, CaseFileState, PlannedEndPreviewResult } from "./actions";

type Action = (prev: CaseFileState, formData: FormData) => Promise<CaseFileState>;

function Feedback({ state }: { state: CaseFileState }) {
  if (state?.error) return <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>;
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  return null;
}

function useCaseAction(action: Action, onOk?: (message: string) => void) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: CaseFileState, fd: FormData) => {
    const res = await action(prev, fd);
    if (res?.ok) { onOk?.(res.ok); router.refresh(); }
    return res;
  }, undefined);
  return { state, formAction, pending };
}

function Text({ name, label, defaultValue, required, type = "text", full, maxLength = 200, placeholder, className = "" }: { name: string; label: string; defaultValue?: string | null; required?: boolean; type?: string; full?: boolean; maxLength?: number; placeholder?: string; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 min-w-0 ${full ? "md:col-span-2" : ""}`}>
      <span className="label-xs">{label}{required && <span className="text-bad"> *</span>}</span>
      <input name={name} type={type} defaultValue={defaultValue ?? ""} required={required} maxLength={type === "date" ? undefined : maxLength} placeholder={placeholder} className={`input ${className}`} />
    </label>
  );
}

function FormButtons({ pending, onCancel, label = "Speichern" }: { pending: boolean; onCancel: () => void; label?: string }) {
  return (
    <div className="flex flex-wrap gap-2 md:col-span-2">
      <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : label}</button>
      <button type="button" className="btn" onClick={onCancel}>Abbrechen</button>
    </div>
  );
}

/** Ansicht (vom Server) mit „Bearbeiten“; das Formular ersetzt die Ansicht, bis gespeichert oder abgebrochen wird. Nach dem Speichern bleibt die Bestätigung unter der Ansicht stehen. */
function Editor({ view, editable, label = "Bearbeiten", children }: { view: ReactNode; editable: boolean; label?: string; children: (close: (message?: string) => void) => ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  if (!editing) return <div className="flex flex-col gap-3">{view}{saved && <p role="status" className="mx-4 text-good bg-good-soft rounded-md px-3 py-2 text-sm">{saved}</p>}{editable && <div className="px-4"><button type="button" className="btn !py-1.5" onClick={() => { setSaved(null); setEditing(true); }}>{label}</button></div>}</div>;
  return <div className="px-4 pt-4">{children((message) => { setSaved(message ?? null); setEditing(false); })}</div>;
}

const grid = "grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3";

// ---------------------------------------------------------------------------
// Schadenfall
// ---------------------------------------------------------------------------

export type DamagedValues = { damagedPlate: string; damagedMake: string; damagedModel: string; damagedDrivable: boolean; damagedFirstRegistration: string; damagedVehicleClass: string; damagedLocation: string; damageKind: string };

export function DamagedVehicleEditor({ action, values, view, editable }: { action: Action; values: DamagedValues; view: ReactNode; editable: boolean }) {
  return <Editor view={view} editable={editable}>{(close) => <DamagedVehicleForm action={action} values={values} close={close} />}</Editor>;
}
function DamagedVehicleForm({ action, values, close }: { action: Action; values: DamagedValues; close: (message?: string) => void }) {
  const { state, formAction, pending } = useCaseAction(action, close);
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={grid} aria-label="Beschädigtes Fahrzeug bearbeiten">
      <Text name="damagedPlate" label="Kennzeichen" defaultValue={values.damagedPlate} required maxLength={20} className="uppercase font-mono" />
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Schadenart<span className="text-bad"> *</span></span>
        <select name="damageKind" defaultValue={values.damageKind} className="input">{Object.entries(ACCIDENT_DAMAGE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </label>
      <Text name="damagedMake" label="Hersteller" defaultValue={values.damagedMake} required maxLength={80} />
      <Text name="damagedModel" label="Modell" defaultValue={values.damagedModel} required maxLength={80} />
      <Text name="damagedFirstRegistration" label="Erstzulassung" type="date" defaultValue={values.damagedFirstRegistration} />
      <Text name="damagedVehicleClass" label="Fahrzeugklasse" defaultValue={values.damagedVehicleClass} maxLength={60} />
      <Text name="damagedLocation" label="Standort" defaultValue={values.damagedLocation} />
      <fieldset className="flex flex-col gap-1 min-w-0"><legend className="label-xs mb-1">Fahrbereit<span className="text-bad"> *</span></legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="damagedDrivable" value="1" defaultChecked={values.damagedDrivable} /> ja</label>
          <label className="flex items-center gap-2"><input type="radio" name="damagedDrivable" value="0" defaultChecked={!values.damagedDrivable} /> nein</label>
        </div>
      </fieldset>
      <div className="md:col-span-2"><Feedback state={state} /></div>
      <FormButtons pending={pending} onCancel={() => close()} />
    </form>
  );
}

export type AccidentValues = { accidentDate: string; accidentPlace: string; opponentPlate: string; opponentName: string; policeFileNumber: string; accidentNote: string; maxDate: string };

export function AccidentEditor({ action, values, view, editable }: { action: Action; values: AccidentValues; view: ReactNode; editable: boolean }) {
  return <Editor view={view} editable={editable}>{(close) => <AccidentForm action={action} values={values} close={close} />}</Editor>;
}
function AccidentForm({ action, values, close }: { action: Action; values: AccidentValues; close: (message?: string) => void }) {
  const { state, formAction, pending } = useCaseAction(action, close);
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={grid} aria-label="Unfall bearbeiten">
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Unfalldatum<span className="text-bad"> *</span></span><input name="accidentDate" type="date" required max={values.maxDate} defaultValue={values.accidentDate} className="input" /></label>
      <Text name="accidentPlace" label="Unfallort" defaultValue={values.accidentPlace} />
      <Text name="opponentPlate" label="Gegnerisches Kennzeichen" defaultValue={values.opponentPlate} maxLength={20} className="uppercase font-mono" />
      <Text name="opponentName" label="Unfallgegner" defaultValue={values.opponentName} />
      <Text name="policeFileNumber" label="Polizei-Aktenzeichen" defaultValue={values.policeFileNumber} maxLength={80} />
      <label className="flex flex-col gap-1 min-w-0 md:col-span-2"><span className="label-xs">Interne Notiz zum Unfall</span><textarea name="accidentNote" rows={3} maxLength={2000} defaultValue={values.accidentNote} className="input" /></label>
      <div className="md:col-span-2"><Feedback state={state} /></div>
      <FormButtons pending={pending} onCancel={() => close()} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Versicherung, Haftung, Werkstatt, Rechtsanwalt – Adressbuch zur Auswahl, Übernahme ins Adressbuch nur auf Wunsch
// ---------------------------------------------------------------------------

function AddressBookChoice({ kindLabel }: { kindLabel: string }) {
  return (
    <label className="flex items-start gap-2 text-sm md:col-span-2 rounded-md bg-panel-2 px-3 py-2">
      <input type="checkbox" name="addressBook" value="1" className="mt-0.5" />
      <span>Angaben auch ins Adressbuch übernehmen <span className="text-ink-3">– sonst ändert sich nur dieser Fall; der {kindLabel}-Eintrag im Adressbuch bleibt wie er ist.</span></span>
    </label>
  );
}

export function InsurerEditor({ action, values, options, view, editable }: { action: Action; values: PartnerState & { claimNumber: string }; options: PartnerOption[]; view: ReactNode; editable: boolean }) {
  return <Editor view={view} editable={editable}>{(close) => <InsurerForm action={action} values={values} options={options} close={close} />}</Editor>;
}
function InsurerForm({ action, values, options, close }: { action: Action; values: PartnerState & { claimNumber: string }; options: PartnerOption[]; close: (message?: string) => void }) {
  const { state, formAction, pending } = useCaseAction(action, close);
  const [p, setP] = useState<PartnerState>(values);
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={grid} aria-label="Versicherung bearbeiten">
      <PartnerName kind="insurer" label="Versicherung" options={options} value={p} onChange={setP} required />
      <Text name="insurerClaimNumber" label="Schadennummer" defaultValue={values.claimNumber} maxLength={80} />
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Ansprechpartner</span><input name="insurerContactName" value={p.contactName} onChange={(e) => setP({ ...p, contactName: e.target.value })} maxLength={200} className="input" /></label>
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Telefon</span><input name="insurerPhone" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} maxLength={60} className="input" /></label>
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">E-Mail</span><input name="insurerEmail" type="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} maxLength={200} className="input" /></label>
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Straße und Hausnummer</span><input name="insurerStreet" value={p.street} onChange={(e) => setP({ ...p, street: e.target.value })} maxLength={200} className="input" /></label>
      <div className="grid grid-cols-[110px_1fr] gap-2 min-w-0">
        <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">PLZ</span><input name="insurerZip" value={p.zip} onChange={(e) => setP({ ...p, zip: e.target.value })} maxLength={20} className="input" /></label>
        <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Ort</span><input name="insurerCity" value={p.city} onChange={(e) => setP({ ...p, city: e.target.value })} maxLength={200} className="input" /></label>
      </div>
      <AddressBookChoice kindLabel="Versicherungs" />
      <div className="md:col-span-2"><Feedback state={state} /></div>
      <FormButtons pending={pending} onCancel={() => close()} />
    </form>
  );
}

export function LiabilityEditor({ action, values, view, editable }: { action: Action; values: { status: string; quota: string; note: string }; view: ReactNode; editable: boolean }) {
  return <Editor view={view} editable={editable} label="Haftung ändern">{(close) => <LiabilityForm action={action} values={values} close={close} />}</Editor>;
}
function LiabilityForm({ action, values, close }: { action: Action; values: { status: string; quota: string; note: string }; close: (message?: string) => void }) {
  const { state, formAction, pending } = useCaseAction(action, close);
  const [status, setStatus] = useState(values.status);
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={grid} aria-label="Haftung bearbeiten">
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Haftungsstatus</span>
        <select name="liabilityStatus" value={status} onChange={(e) => setStatus(e.target.value)} className="input">{Object.entries(ACCIDENT_LIABILITY_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </label>
      {status === "QUOTA" ? <Text name="liabilityQuotaPercent" label="Haftungsquote des Gegners in %" defaultValue={values.quota} required maxLength={3} /> : <div />}
      <label className="flex flex-col gap-1 min-w-0 md:col-span-2"><span className="label-xs">Notiz (z. B. Quelle der Aussage)</span><textarea name="liabilityNote" rows={2} maxLength={1000} defaultValue={values.note} className="input" /></label>
      <p className="text-xs text-ink-3 md:col-span-2">Angabe laut Versicherung – Rent-Base bewertet die Haftung nicht.</p>
      <div className="md:col-span-2"><Feedback state={state} /></div>
      <FormButtons pending={pending} onCancel={() => close()} />
    </form>
  );
}

export type WorkshopValues = PartnerState & { repairStartAt: string; repairEndAt: string };

export function WorkshopEditor({ action, values, options, view, editable, present }: { action: Action; values: WorkshopValues; options: PartnerOption[]; view: ReactNode; editable: boolean; present: boolean }) {
  return <Editor view={view} editable={editable} label={present ? "Bearbeiten" : "Werkstatt erfassen"}>{(close) => <WorkshopForm action={action} values={values} options={options} close={close} present={present} />}</Editor>;
}
function WorkshopForm({ action, values, options, close, present }: { action: Action; values: WorkshopValues; options: PartnerOption[]; close: (message?: string) => void; present: boolean }) {
  const { state, formAction, pending } = useCaseAction(action, close);
  const [p, setP] = useState<PartnerState>(values);
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={grid} aria-label="Werkstatt bearbeiten">
      <PartnerName kind="workshop" label="Werkstatt / Firma" options={options} value={p} onChange={setP} required />
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Ansprechpartner</span><input name="workshopContactName" value={p.contactName} onChange={(e) => setP({ ...p, contactName: e.target.value })} maxLength={200} className="input" /></label>
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Telefon</span><input name="workshopPhone" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} maxLength={60} className="input" /></label>
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">E-Mail</span><input name="workshopEmail" type="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} maxLength={200} className="input" /></label>
      <Text name="repairStartAt" label="Geplanter Reparaturbeginn" type="date" defaultValue={values.repairStartAt} />
      <Text name="repairEndAt" label="Voraussichtliches Reparaturende" type="date" defaultValue={values.repairEndAt} />
      <AddressBookChoice kindLabel="Werkstatt" />
      <div className="md:col-span-2"><Feedback state={state} /></div>
      <FormButtons pending={pending} onCancel={() => close()} />
      {present && <div className="md:col-span-2"><button type="submit" name="remove" value="1" formNoValidate disabled={pending} className="btn btn-danger !py-1.5">Werkstattangaben aus dem Fall entfernen</button></div>}
    </form>
  );
}

export function LawyerEditor({ action, values, options, view, editable, present }: { action: Action; values: PartnerState; options: PartnerOption[]; view: ReactNode; editable: boolean; present: boolean }) {
  return <Editor view={view} editable={editable} label={present ? "Bearbeiten" : "Rechtsanwalt erfassen"}>{(close) => <LawyerForm action={action} values={values} options={options} close={close} present={present} />}</Editor>;
}
function LawyerForm({ action, values, options, close, present }: { action: Action; values: PartnerState; options: PartnerOption[]; close: (message?: string) => void; present: boolean }) {
  const { state, formAction, pending } = useCaseAction(action, close);
  const [p, setP] = useState<PartnerState>(values);
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={grid} aria-label="Rechtsanwalt bearbeiten">
      <PartnerName kind="lawyer" label="Kanzlei / Firma" options={options} value={p} onChange={setP} required />
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Ansprechpartner</span><input name="lawyerContactName" value={p.contactName} onChange={(e) => setP({ ...p, contactName: e.target.value })} maxLength={200} className="input" /></label>
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Telefon</span><input name="lawyerPhone" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} maxLength={60} className="input" /></label>
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">E-Mail</span><input name="lawyerEmail" type="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} maxLength={200} className="input" /></label>
      <AddressBookChoice kindLabel="Kanzlei" />
      <div className="md:col-span-2"><Feedback state={state} /></div>
      <FormButtons pending={pending} onCancel={() => close()} />
      {present && <div className="md:col-span-2"><button type="submit" name="remove" value="1" formNoValidate disabled={pending} className="btn btn-danger !py-1.5">Angaben zum Rechtsanwalt entfernen</button></div>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Mietdauer aktualisieren: Vorschau (Konflikt, Mietwert alt/neu) vor dem Speichern
// ---------------------------------------------------------------------------

type PlannedEndProps = { action: Action; preview: (input: { endMode: string; plannedEndAt: string }) => Promise<PlannedEndPreviewResult>; currentEnd: string; minEnd: string };

/** Knopf und Formular getrennt: das Formular entsteht bei jedem Öffnen neu (frische Vorschau, aktueller Stand). */
export function PlannedEndForm(props: PlannedEndProps) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  if (!open) return <div className="flex flex-col gap-2"><div><button type="button" className="btn btn-primary" onClick={() => { setSaved(null); setOpen(true); }}>Mietdauer aktualisieren</button></div>{saved && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{saved}</p>}</div>;
  return <PlannedEndDialog {...props} close={(message) => { setSaved(message ?? null); setOpen(false); }} />;
}

function PlannedEndDialog({ action, preview, currentEnd, minEnd, close }: PlannedEndProps & { close: (message?: string) => void }) {
  const open = true;
  const setOpen = (v: boolean) => { if (!v) close(); };
  const { state, formAction, pending } = useCaseAction(action, (message) => close(message));
  const [endMode, setEndMode] = useState<"open" | "known">(currentEnd ? "known" : "open");
  const [plannedEndAt, setPlannedEndAt] = useState(currentEnd);
  const [result, setResult] = useState<(PlannedEndPreviewResult & { key: string }) | null>(null);
  const key = `${endMode}|${endMode === "known" ? plannedEndAt : ""}`;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await preview({ endMode, plannedEndAt });
        if (!cancelled) setResult({ ...r, key });
      } catch {
        if (!cancelled) setResult({ error: "Die Vorschau konnte gerade nicht berechnet werden.", key });
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, endMode, plannedEndAt, preview, key]);
  const r = result?.key === key ? result : null;
  const blocked = !r || Boolean(r.error) || Boolean(r.conflict) || Boolean(r.unchanged);
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg border-2 border-brand bg-panel p-4" aria-label="Mietdauer aktualisieren">
      <div className="font-medium">Mietdauer aktualisieren</div>
      <p className="text-sm text-ink-3">Ändert nur das geplante Mietende dieser Buchung (Disposition) – keine neue Buchung, kein Nachtrag. Der Unfallersatz-Vertrag läuft ohnehin bis zur Rückgabe.</p>
      <div className="flex rounded-md border border-line overflow-hidden text-[13px] font-medium max-w-md" role="group" aria-label="Mietende">
        <button type="button" onClick={() => setEndMode("open")} aria-pressed={endMode === "open"} className={`flex-1 px-3 py-2 ${endMode === "open" ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>Mietende offen</button>
        <button type="button" onClick={() => setEndMode("known")} aria-pressed={endMode === "known"} className={`flex-1 px-3 py-2 ${endMode === "known" ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>Datum bekannt</button>
      </div>
      <input type="hidden" name="endMode" value={endMode} />
      {endMode === "known" && (
        <label className="flex flex-col gap-1 max-w-xs"><span className="label-xs">Geplantes Mietende<span className="text-bad"> *</span></span>
          <input name="plannedEndAt" type="datetime-local" required min={minEnd} value={plannedEndAt} onChange={(e) => setPlannedEndAt(e.target.value)} className="input" />
        </label>
      )}
      <div aria-live="polite" className="text-sm">
        {!r ? <p className="text-ink-3">Prüfe Verfügbarkeit…</p>
          : r.error ? <p className="text-bad">{r.error}</p>
          : (
            <div className="flex flex-col gap-1.5 rounded-md bg-panel-2 p-3">
              <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
                <span className="text-ink-3">Bisher</span><span>{r.before}</span>
                <span className="text-ink-3">Neu</span><span className="font-medium">{r.after}</span>
                <span className="text-ink-3">Mietwert</span><span className="font-mono tnum">{r.estimateBefore} → {r.estimateAfter} <span className="font-sans text-ink-3 text-xs">(Schätzung, bei offenem Ende bis heute)</span></span>
              </div>
              {r.unchanged && <p className="text-ink-3">Das geplante Mietende ist unverändert.</p>}
              {r.conflict && <p role="alert" className="text-bad">{r.conflict}</p>}
            </div>
          )}
      </div>
      <label className="flex flex-col gap-1"><span className="label-xs">Grund der Änderung (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} placeholder="z. B. Reparaturende laut Werkstatt verschoben" className="input" /></label>
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || blocked} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Mietende speichern"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Wiedervorlagen
// ---------------------------------------------------------------------------

export function FollowUpCreateForm({ action, assignees, minDate }: { action: Action; assignees: { id: string; name: string }[]; minDate: string }) {
  const [open, setOpen] = useState(false);
  const { state, formAction, pending } = useCaseAction(action, () => setOpen(false));
  if (!open) return <div className="flex flex-col gap-2"><div><button type="button" className="btn !py-1.5" onClick={() => setOpen(true)}>Wiedervorlage anlegen</button></div><Feedback state={state} /></div>;
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={`${grid} rounded-lg border border-line bg-panel-2/50 p-3`} aria-label="Wiedervorlage anlegen">
      <Text name="title" label="Worum geht es?" required full placeholder="z. B. Schadennummer bei der Versicherung nachfragen" />
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Fällig am<span className="text-bad"> *</span></span><input name="dueDate" type="date" required min={minDate} defaultValue={minDate} className="input" /></label>
      <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Zuständig (optional)</span>
        <select name="assigneeUserId" defaultValue="" className="input"><option value="">– niemand Bestimmtes –</option>{assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 min-w-0 md:col-span-2"><span className="label-xs">Notiz (optional)</span><textarea name="note" rows={2} maxLength={1000} className="input" /></label>
      <div className="md:col-span-2"><Feedback state={state} /></div>
      <FormButtons pending={pending} onCancel={() => setOpen(false)} label="Wiedervorlage anlegen" />
    </form>
  );
}

export function FollowUpActions({ done, cancel }: { done: Action; cancel: Action }) {
  const [mode, setMode] = useState<"none" | "done" | "cancel">("none");
  const doneA = useCaseAction(done, () => setMode("none"));
  const cancelA = useCaseAction(cancel, () => setMode("none"));
  if (mode === "none") return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn !py-1 text-xs" onClick={() => setMode("done")}>Erledigt</button>
        <button type="button" className="btn !py-1 text-xs" onClick={() => setMode("cancel")}>Verwerfen</button>
      </div>
      <Feedback state={doneA.state ?? cancelA.state} />
    </div>
  );
  const a = mode === "done" ? doneA : cancelA;
  return (
    <form action={a.formAction} onSubmit={submitWithoutReset(a.formAction)} className="flex flex-col gap-2 text-sm">
      {mode === "done"
        ? <label className="flex flex-col gap-1"><span className="label-xs">Ergebnis (optional)</span><input name="note" maxLength={1000} className="input" /></label>
        : <label className="flex flex-col gap-1"><span className="label-xs">Warum entfällt sie? (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} className="input" /></label>}
      <Feedback state={a.state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={a.pending} className="btn btn-primary !py-1 text-xs">{a.pending ? "Wird gespeichert…" : mode === "done" ? "Als erledigt markieren" : "Verwerfen"}</button>
        <button type="button" className="btn !py-1 text-xs" onClick={() => setMode("none")}>Abbrechen</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Fall abschließen / wieder öffnen
// ---------------------------------------------------------------------------

export function CloseCaseForm({ action, warnings }: { action: Action; warnings: { code: string; text: string }[] }) {
  const [open, setOpen] = useState(false);
  const { state, formAction, pending } = useCaseAction(action, () => setOpen(false));
  if (!open) return <div className="flex flex-col gap-2"><div><button type="button" className="btn" onClick={() => setOpen(true)}>Fall abschließen</button></div><Feedback state={state} /></div>;
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg border-2 border-brand bg-panel p-4 text-sm" aria-label="Fall abschließen">
      <div className="font-medium">Fall abschließen?</div>
      {warnings.length > 0 ? (
        <div className="rounded-md bg-amber-soft text-amber px-3 py-2 flex flex-col gap-1">
          <span className="font-medium">Offene Punkte:</span>
          <ul className="list-disc pl-5">{warnings.map((w) => <li key={w.code}>{w.text}</li>)}</ul>
        </div>
      ) : <p className="text-ink-3">Keine offenen Punkte erkannt.</p>}
      <p className="text-ink-3">Abgeschlossene Fälle bleiben vollständig erhalten und sind danach nur noch lesbar. Nichts wird gelöscht.</p>
      <label className="flex flex-col gap-1"><span className="label-xs">Grund des Abschlusses (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} className="input" /></label>
      {warnings.length > 0 && (
        <label className="flex items-start gap-2"><input type="checkbox" name="acknowledge" value="1" required className="mt-0.5" /> <span>Ich schließe den Fall bewusst trotz der offenen Punkte ab. Die Punkte werden am Fall festgehalten.</span></label>
      )}
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird abgeschlossen…" : "Fall abschließen"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
    </form>
  );
}

export function ReopenCaseForm({ action }: { action: Action }) {
  const [open, setOpen] = useState(false);
  const { state, formAction, pending } = useCaseAction(action, () => setOpen(false));
  if (!open) return <div className="flex flex-col gap-2"><div><button type="button" className="btn !py-1.5" onClick={() => setOpen(true)}>Fall wieder öffnen</button></div><Feedback state={state} /></div>;
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg border-2 border-brand bg-panel p-4 text-sm" aria-label="Fall wieder öffnen">
      <div className="font-medium">Fall wieder öffnen?</div>
      <label className="flex flex-col gap-1"><span className="label-xs">Grund (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} placeholder="z. B. Versicherung meldet sich erneut" className="input" /></label>
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird geöffnet…" : "Wieder öffnen"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Phase F: Abrechnung (Rechnung erstellen mit Vorschau, Restforderung, Kürzung), Dokumente (Upload, Archivieren)
// ---------------------------------------------------------------------------

type PreviewFn = (input: { periodEnd: string }) => Promise<AccidentPreviewResult>;

function PreviewTable({ p }: { p: AccidentPreviewResult }) {
  if (!p.items) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-panel-2 p-3 text-sm min-w-0">
      <div className="font-medium">{p.typeLabel} · Leistungszeitraum {p.period}</div>
      <div className="text-xs text-ink-3">{p.days} {p.days === 1 ? "Miettag" : "Miettage"} in dieser Rechnung{p.priorDays ? ` (seit der Übergabe ${p.totalDays}, davon ${p.priorDays} bereits abgerechnet)` : ""} · Einzelpreise {p.pricesIncludeTax ? "brutto" : "netto"}</div>
      <ul className="flex flex-col gap-1">
        {p.items.map((i, n) => (
          <li key={n} className="flex flex-wrap justify-between gap-x-3 border-b border-line-soft pb-1">
            <span className="min-w-0 break-words flex-1">{i.description}</span>
            <span className="font-mono tnum text-xs text-ink-3 shrink-0">{i.quantity} {i.unit} × {i.unitPrice}</span>
            <span className="font-mono tnum shrink-0">{i.gross}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-between gap-3 font-semibold"><span>Rechnungsbetrag (brutto)</span><span className="font-mono tnum">{p.gross}</span></div>
      <div className="text-xs text-ink-3">netto {p.net} · Umsatzsteuer {p.tax}</div>
    </div>
  );
}

/**
 * Zwischen- oder Schlussrechnung als Entwurf: Empfänger bewusst wählen (Versicherung aus der Fallakte, Mieter aus dem Vertrag,
 * anderer Empfänger manuell). Zwischenrechnung: erst nach berechneter Vorschau für genau diesen Stichtag. Nach dem Erstellen
 * geht es in den Rechnungsentwurf (Prüfen, Abschließen) – abgeschlossen wird dort, nicht hier.
 */
export function AccidentInvoiceCreateForm({ action, preview, mode, insurer, renter, nonce, minEnd, maxEnd, finalPreview }: { action: Action; preview?: PreviewFn; mode: "INTERIM" | "FINAL"; insurer: { name: string | null; hasEmail: boolean; hasAddress: boolean }; renter: { name: string; hasEmail: boolean }; nonce: string; minEnd?: string; maxEnd?: string; finalPreview?: AccidentPreviewResult | null }) {
  const { state, formAction, pending } = useCaseAction(action);
  const [role, setRole] = useState<"INSURER" | "RENTER" | "OTHER">(insurer.name ? "INSURER" : "RENTER");
  const [otherType, setOtherType] = useState("COMPANY");
  const [end, setEnd] = useState(maxEnd ?? "");
  const [pv, setPv] = useState<AccidentPreviewResult | null>(null);
  const [pvFor, setPvFor] = useState<string | null>(null);
  const [checking, start] = useTransition();
  const interim = mode === "INTERIM";
  const previewReady = !interim || (!!pv && !pv.error && pvFor === end);
  const check = () => { if (!preview) return; const at = end; start(async () => { setPv(await preview({ periodEnd: at })); setPvFor(at); }); };
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 text-sm" aria-label={interim ? "Zwischenrechnung erstellen" : "Schlussrechnung erstellen"}>
      <input type="hidden" name="nonce" value={nonce} />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="label-xs mb-1">Rechnungsempfänger</legend>
        <label className={`flex items-start gap-2 ${insurer.name ? "" : "opacity-60"}`}><input type="radio" name="recipientRole" value="INSURER" checked={role === "INSURER"} disabled={!insurer.name} onChange={() => setRole("INSURER")} className="mt-1" /><span>Versicherung{insurer.name ? `: ${insurer.name}` : " (in der Fallakte noch nicht erfasst)"}<span className="block text-xs text-ink-3">Anschrift, Schadennummer und Geschädigter aus der Fallakte (Kopie, später unveränderlich).</span></span></label>
        <label className="flex items-start gap-2"><input type="radio" name="recipientRole" value="RENTER" checked={role === "RENTER"} onChange={() => setRole("RENTER")} className="mt-1" /><span>Mieter / Geschädigter: {renter.name}<span className="block text-xs text-ink-3">Anschrift aus dem Mietvertrag.</span></span></label>
        <label className="flex items-start gap-2"><input type="radio" name="recipientRole" value="OTHER" checked={role === "OTHER"} onChange={() => setRole("OTHER")} className="mt-1" /><span>Anderer Empfänger<span className="block text-xs text-ink-3">Rechnungsdaten hier erfassen – keine Kundenanlage.</span></span></label>
      </fieldset>
      {role === "INSURER" && !insurer.hasAddress && <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Die Anschrift der Versicherung ist unvollständig. Vor dem Abschluss im Schadenfall ergänzen (oder im Rechnungsentwurf).</p>}
      {role === "INSURER" && !insurer.hasEmail && <p className="rounded-md bg-info-soft text-info px-3 py-2">Für die Versicherung ist keine E-Mail-Adresse hinterlegt: Die Rechnung wird nicht per E-Mail versendet – auch nicht ersatzweise an den Mieter. Das PDF steht zum Herunterladen bereit.</p>}
      {role === "RENTER" && !renter.hasEmail && <p className="rounded-md bg-info-soft text-info px-3 py-2">Im Mietvertrag ist keine E-Mail-Adresse hinterlegt: kein Versand per E-Mail.</p>}
      {role === "OTHER" && (
        <div className={grid}>
          <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Art</span><select name="otherType" value={otherType} onChange={(e) => setOtherType(e.target.value)} className="input"><option value="COMPANY">Firma</option><option value="PRIVATE">Privatperson</option></select></label>
          {otherType === "COMPANY" ? <Text name="otherCompanyName" label="Firma" required /> : <Text name="otherLastName" label="Nachname" required maxLength={100} />}
          {otherType === "COMPANY" ? <Text name="otherLastName" label="Ansprechpartner (Nachname, optional)" maxLength={100} /> : <Text name="otherFirstName" label="Vorname" maxLength={100} />}
          <Text name="otherStreet" label="Straße und Hausnummer" required />
          <Text name="otherZip" label="PLZ" required maxLength={20} />
          <Text name="otherCity" label="Ort" required maxLength={100} />
          <Text name="otherCountry" label="Land (z. B. DE)" defaultValue="DE" maxLength={2} />
          <Text name="otherEmail" label="E-Mail (optional, für den Versand)" type="email" maxLength={320} />
        </div>
      )}
      {interim && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1"><span className="label-xs">Stichtag (abgerechnet wird bis hier, nicht in der Zukunft)</span><input type="datetime-local" name="periodEnd" value={end} min={minEnd} max={maxEnd} onChange={(e) => setEnd(e.target.value)} required className="input" /></label>
          <button type="button" className="btn" disabled={checking || !end} onClick={check}>{checking ? "Wird berechnet…" : "Vorschau berechnen"}</button>
        </div>
      )}
      {interim && pv?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2">{pv.error}</p>}
      {interim && pv && !pv.error && pvFor === end && <PreviewTable p={pv} />}
      {interim && pv && pvFor !== end && <p className="text-xs text-amber">Der Stichtag wurde geändert – bitte die Vorschau neu berechnen.</p>}
      {!interim && finalPreview && <PreviewTable p={finalPreview} />}
      <Feedback state={state} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || !previewReady} className="btn btn-primary">{pending ? "Wird erstellt…" : interim ? "Zwischenrechnung als Entwurf erstellen" : "Schlussrechnung als Entwurf erstellen"}</button>
        <span className="text-xs text-ink-3">Es entsteht ein Entwurf ohne Nummer; abgeschlossen wird im Rechnungsentwurf.</span>
      </div>
    </form>
  );
}

/** Restforderung an den Mieter – nur bewusst, mit ausdrücklicher Bestätigung der Doppelforderungs-Wirkung. */
export function RemainderForm({ action, maxCents, invoiceNumber, insurerName, nonce }: { action: Action; maxCents: number; invoiceNumber: string; insurerName: string; nonce: string }) {
  const [open, setOpen] = useState(false);
  const { state, formAction, pending } = useCaseAction(action, () => setOpen(false));
  const max = (maxCents / 100).toFixed(2).replace(".", ",");
  if (!open) return <div className="flex flex-col gap-1"><div><button type="button" className="btn !py-1.5" onClick={() => setOpen(true)}>Restforderung an Mieter erstellen</button></div><Feedback state={state} /></div>;
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg border-2 border-amber/50 bg-panel p-4 text-sm" aria-label="Restforderung an den Mieter">
      <div className="font-medium">Restforderung an den Mieter zur Rechnung {invoiceNumber}</div>
      <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Rent-Base entscheidet nicht, ob der Mieter den Betrag schuldet, und bucht nichts um. Die Rechnung {invoiceNumber} an {insurerName} bleibt unverändert offen. Derselbe Betrag ist danach in zwei Rechnungen enthalten – wird der Mieter in Anspruch genommen, die Versicherungsrechnung per Gutschrift mindern.</p>
      <label className="flex flex-col gap-1 max-w-xs"><span className="label-xs">Betrag (brutto, höchstens {max} €)</span><input name="amount" inputMode="decimal" defaultValue={max} required className="input tnum" /></label>
      <input type="hidden" name="nonce" value={nonce} />
      <label className="flex items-start gap-2"><input type="checkbox" name="acknowledge" value="1" required className="mt-0.5" /> <span>Mir ist bewusst, dass der Betrag zugleich in der Versicherungsrechnung enthalten bleibt.</span></label>
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird erstellt…" : "Restforderung als Entwurf erstellen"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
    </form>
  );
}

/** Kürzung dokumentieren – reine Dokumentation, optional mit Versichererschreiben dieses Falls verknüpft. */
export function AdjustmentForm({ action, maxCents, letters, today }: { action: Action; maxCents: number; letters: { id: string; fileName: string; date: string }[]; today: string }) {
  const [open, setOpen] = useState(false);
  const { state, formAction, pending } = useCaseAction(action, () => setOpen(false));
  if (!open) return <div className="flex flex-col gap-1"><div><button type="button" className="btn !py-1.5" onClick={() => setOpen(true)}>Kürzung dokumentieren</button></div><Feedback state={state} /></div>;
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg border-2 border-brand bg-panel p-4 text-sm" aria-label="Kürzung dokumentieren">
      <div className="font-medium">Kürzung der Versicherung dokumentieren</div>
      <p className="text-ink-3">Nur Dokumentation: Die Versicherung erkennt diesen Betrag derzeit nicht an. Rechnungsbetrag, Steuer, Zahlungen und offene Forderung bleiben unverändert.</p>
      <div className={grid}>
        <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Grund <span className="text-bad">*</span></span><select name="reasonKind" required defaultValue="" className="input"><option value="" disabled>Bitte wählen</option>{Object.entries(INVOICE_ADJUSTMENT_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Betrag in € (höchstens {(maxCents / 100).toFixed(2).replace(".", ",")}) <span className="text-bad">*</span></span><input name="amount" inputMode="decimal" required className="input tnum" /></label>
        <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Datum des Schreibens / der Entscheidung <span className="text-bad">*</span></span><input type="date" name="decidedAt" max={today} defaultValue={today} required className="input" /></label>
        <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Versichererschreiben (optional)</span><select name="documentId" defaultValue="" className="input"><option value="">– ohne Verknüpfung –</option>{letters.map((l) => <option key={l.id} value={l.id}>{l.fileName} ({l.date})</option>)}</select></label>
        <label className="flex flex-col gap-1 min-w-0 md:col-span-2"><span className="label-xs">Notiz (optional)</span><textarea name="note" rows={2} maxLength={1000} className="input" /></label>
      </div>
      {letters.length === 0 && <p className="text-xs text-ink-3">Noch kein Schreiben der Versicherung hochgeladen (Bereich „Dokumente“).</p>}
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Kürzung dokumentieren"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
    </form>
  );
}

/** Aktion mit Pflichtgrund (Kürzung stornieren, Dokument archivieren). */
export function CaseReasonForm({ action, label, question, submitLabel, explanation, danger = false }: { action: Action; label: string; question: string; submitLabel: string; explanation?: string; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  const { state, formAction, pending } = useCaseAction(action, () => setOpen(false));
  if (!open) return <div className="inline-flex flex-col gap-1"><div><button type="button" className={`btn !py-1 text-xs ${danger ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>{label}</button></div><Feedback state={state} /></div>;
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-2 rounded-lg border-2 p-3 text-sm ${danger ? "border-bad/40 bg-bad-soft/30" : "border-brand bg-panel"}`}>
      <div className="font-medium [overflow-wrap:anywhere]">{question}</div>
      {explanation && <p className="text-ink-3">{explanation}</p>}
      <label className="flex flex-col gap-1"><span className="label-xs">Grund (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} className="input" /></label>
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={`btn ${danger ? "btn-danger" : "btn-primary"}`}>{pending ? "Wird gespeichert…" : submitLabel}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
    </form>
  );
}

/** Upload eines Falldokuments (PDF/Bild bis 8 MB, privat gespeichert) – über die API-Route, nicht über eine Server-Aktion. */
export function AccidentDocumentUploader({ caseId, defaultType = "INSURER_LETTER" }: { caseId: string; defaultType?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || !form.current) return;
    setBusy(true); setError(null); setOk(null);
    let n = 0;
    try {
      const fd = new FormData(form.current);
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.set("file", file, file.name);
        body.set("type", String(fd.get("type") ?? defaultType));
        if (fd.get("note")) body.set("note", String(fd.get("note")));
        const res = await fetch(`/api/accident-cases/${caseId}/documents`, { method: "POST", body });
        if (!res.ok) throw new Error(`„${file.name}“: ${((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Das Dokument konnte nicht gespeichert werden."}`);
        n++;
      }
      form.current.reset();
      setOk(n === 1 ? "Dokument hochgeladen." : `${n} Dokumente hochgeladen.`);
      router.refresh();
    } catch (e) {
      // bereits gespeicherte Dateien sofort anzeigen – ein erneuter Versuch nur mit den fehlenden Dateien
      setError(n > 0 ? `${n} ${n === 1 ? "Dokument wurde" : "Dokumente wurden"} gespeichert, danach: ${(e as Error).message}` : (e as Error).message);
      if (n > 0) router.refresh();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <form ref={form} method="post" onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-2 text-sm" aria-label="Dokument hochladen">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,240px)_1fr_auto] gap-2 items-end">
        <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Art</span><select name="type" className="input" defaultValue={defaultType}>{Object.entries(ACCIDENT_CASE_DOCUMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="flex flex-col gap-1 min-w-0"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={500} className="input" placeholder="z. B. Kürzungsschreiben vom …" /></label>
        <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Wird hochgeladen…" : "Dokument hochladen"}</button>
      </div>
      <p className="text-xs text-ink-3">PDF oder Bild (JPEG, PNG, WebP) bis 8 MB, privat gespeichert. Keine Texterkennung und kein Versand – Inhalte werden bei Bedarf manuell erfasst.</p>
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2">{error}</p>}
      {ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2">{ok}</p>}
    </form>
  );
}

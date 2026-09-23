"use client";

// Formulare des Behörden- und Bußgeldmanagements. Jede Entscheidung mit Außenwirkung (Fahrer bestimmen, Antwort
// freigeben, übermitteln) verlangt eine ausdrückliche Bestätigung; nach Erfolg lädt die Seite die Serverdaten neu.

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { AUTHORITY_CASE_TYPES, AUTHORITY_DOCUMENT_TYPES, AUTHORITY_DRIVER_NOTICE, AUTHORITY_RESPONSE_TYPES, SUBMISSION_METHODS } from "@/lib/constants";
import type { AuthState } from "./actions";

type Action = (prev: AuthState, formData: FormData) => Promise<AuthState>;

export function Feedback({ state }: { state: AuthState }) {
  if (!state) return null;
  return (
    <div className="flex flex-col gap-1">
      {state.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>}
      {state.ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>}
      {state.warnings?.map((w, i) => <p key={i} role="alert" className="text-amber bg-amber-soft rounded-md px-3 py-2 text-sm">{w}</p>)}
    </div>
  );
}

function useAuthAction(action: Action) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: AuthState, fd: FormData) => {
    const res = await action(prev, fd);
    if (res?.ok) router.refresh();
    return res;
  }, undefined);
  return { state, formAction, pending };
}

const Field = ({ label, children, className = "", hint }: { label: string; children: React.ReactNode; className?: string; hint?: string }) => (
  <label className={`flex flex-col gap-1 ${className}`}><span className="label-xs">{label}</span>{children}{hint && <span className="text-xs text-ink-3">{hint}</span>}</label>
);

// ---------------------------------------------------------------------------
// Schreiben erfassen / Vorgangsdaten bearbeiten
// ---------------------------------------------------------------------------

export type CaseValues = { type: string; authorityName: string; authorityDepartment: string; authorityReference: string; authorityAddress: string; authorityEmail: string; authorityPortalUrl: string; offenseType: string; offenseDescription: string; offenseDate: string; offenseTime: string; offenseLocation: string; licensePlate: string; responseDeadline: string; noticeAmount: string; notes: string };

export function CaseForm({ action, values, submitLabel, collapsible = false }: { action: Action; values?: Partial<CaseValues>; submitLabel: string; collapsible?: boolean }) {
  const { state, formAction, pending } = useAuthAction(action);
  const [open, setOpen] = useState(!collapsible);
  const [timeUnknown, setTimeUnknown] = useState(values ? !values.offenseTime : false);
  if (collapsible && !open) return <div className="inline-flex flex-col gap-1"><button type="button" className="btn !py-1.5" onClick={() => setOpen(true)}>Vorgangsdaten bearbeiten</button><Feedback state={state} /></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-4 ${collapsible ? "rounded-lg bg-panel-2 p-4" : ""}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Vorgangsart"><select name="type" defaultValue={values?.type ?? "SPEEDING"} className="input">{Object.entries(AUTHORITY_CASE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Kennzeichen laut Schreiben" hint="genau so wie im Schreiben – Rent-Base vergleicht ohne Leer- und Bindestriche"><input name="licensePlate" required defaultValue={values?.licensePlate ?? ""} maxLength={20} className="input font-mono" placeholder="z. B. HB-AB 1234" /></Field>
        <Field label="Behörde" className="sm:col-span-2"><input name="authorityName" required minLength={2} defaultValue={values?.authorityName ?? ""} maxLength={160} className="input" placeholder="z. B. Stadtamt Bremen, Bußgeldstelle" /></Field>
        <Field label="Abteilung / Sachgebiet (optional)"><input name="authorityDepartment" defaultValue={values?.authorityDepartment ?? ""} maxLength={160} className="input" /></Field>
        <Field label="Aktenzeichen der Behörde"><input name="authorityReference" required defaultValue={values?.authorityReference ?? ""} maxLength={80} className="input font-mono" /></Field>
        <Field label="Anschrift der Behörde (optional)" className="sm:col-span-2" hint="für den Postversand und die Antwort-PDF"><textarea name="authorityAddress" rows={2} defaultValue={values?.authorityAddress ?? ""} maxLength={400} className="input" /></Field>
        <Field label="E-Mail der Behörde (optional)" hint="nur, wenn die Behörde sie im Schreiben ausdrücklich angibt"><input name="authorityEmail" type="email" defaultValue={values?.authorityEmail ?? ""} maxLength={160} className="input" /></Field>
        <Field label="Portaladresse (optional)" hint="vollständige https-Adresse aus dem Schreiben; Zugangsdaten werden nicht gespeichert"><input name="authorityPortalUrl" defaultValue={values?.authorityPortalUrl ?? ""} maxLength={300} className="input" placeholder="https://…" /></Field>
        <Field label="Tatdatum"><input name="offenseDate" type="date" required defaultValue={values?.offenseDate ?? ""} className="input" /></Field>
        <Field label="Tatzeit (Uhrzeit)" hint={timeUnknown ? "Ohne Uhrzeit wird nur der Tattag verglichen – die Zuordnung ist dann nur tagesgenau." : undefined}>
          <div className="flex flex-wrap items-center gap-3">
            <input name="offenseTime" type="time" defaultValue={timeUnknown ? "" : values?.offenseTime ?? ""} disabled={timeUnknown} className="input" />
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={timeUnknown} onChange={(e) => setTimeUnknown(e.target.checked)} /> Zeit unbekannt</label>
          </div>
        </Field>
        <Field label="Tatort (optional)"><input name="offenseLocation" defaultValue={values?.offenseLocation ?? ""} maxLength={200} className="input" /></Field>
        <Field label="Verstoß laut Schreiben (optional)"><input name="offenseType" defaultValue={values?.offenseType ?? ""} maxLength={160} className="input" placeholder="z. B. 21 km/h zu schnell innerorts" /></Field>
        <Field label="Beschreibung (optional)" className="sm:col-span-2"><textarea name="offenseDescription" rows={2} defaultValue={values?.offenseDescription ?? ""} maxLength={2000} className="input" /></Field>
        <Field label="Antwortfrist laut Schreiben (optional)" hint="nur eintragen, wenn im Schreiben eine Frist genannt ist"><input name="responseDeadline" type="date" defaultValue={values?.responseDeadline ?? ""} className="input" /></Field>
        <Field label="Betrag laut Schreiben in € (optional)" hint="nur Information – es entsteht keine Rechnung, Forderung oder Belastung"><input name="noticeAmount" inputMode="decimal" defaultValue={values?.noticeAmount ?? ""} className="input tnum" placeholder="0,00" /></Field>
        <Field label="Notizen zum Schreiben (optional)" className="sm:col-span-2"><textarea name="notes" rows={2} defaultValue={values?.notes ?? ""} maxLength={2000} className="input" /></Field>
      </div>
      <p className="text-xs text-ink-3">Nach dem Speichern prüft Rent-Base Kennzeichen und Tatzeit gegen Flotte und Vermietungen. Es wird dabei nie eine Person als Fahrer festgelegt.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : submitLabel}</button>
        {collapsible && <button type="button" className="btn" onClick={() => setOpen(false)}>Schließen</button>}
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function SimpleButton({ action, label, pendingLabel, danger = false, hidden }: { action: Action; label: string; pendingLabel: string; danger?: boolean; hidden?: Record<string, string> }) {
  const { state, formAction, pending } = useAuthAction(action);
  return (
    <form action={formAction} className="inline-flex flex-col gap-1">
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" disabled={pending} className={`btn !py-1.5 ${danger ? "btn-danger" : ""}`}>{pending ? pendingLabel : label}</button>
      <Feedback state={state} />
    </form>
  );
}

/** Auswahl aus Kandidaten (Fahrzeug oder Vermietung) – bewusste Entscheidung, keine Vorauswahl bei mehreren Treffern. */
export function SelectForm({ action, name, label, options, current, submitLabel, emptyLabel, hint }: { action: Action; name: string; label: string; options: { id: string; label: string; detail?: string }[]; current: string | null; submitLabel: string; emptyLabel: string; hint?: string }) {
  const { state, formAction, pending } = useAuthAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2">
      <Field label={label} hint={hint}>
        <select name={name} defaultValue={current ?? ""} className="input">
          <option value="">{emptyLabel}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.detail ? ` · ${o.detail}` : ""}</option>)}
        </select>
      </Field>
      <div><button type="submit" disabled={pending} className="btn !py-1.5">{pending ? "…" : submitLabel}</button></div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Fahrerbestimmung – nur aus dem Vertrag oder als bewusst erfasste andere Person; „nicht feststellbar“ immer möglich
// ---------------------------------------------------------------------------

export type DriverCandidateOption = { contractDriverId: string; roleLabel: string; name: string; birthDate: string; city: string };

export function DriverForm({ action, candidates, current, currentContractDriverId }: { action: Action; candidates: DriverCandidateOption[]; current: string; currentContractDriverId: string | null }) {
  const { state, formAction, pending } = useAuthAction(action);
  const [mode, setMode] = useState<string>(current === "CONTRACT_DRIVER_SELECTED" ? "CONTRACT" : current === "OTHER_DRIVER_ENTERED" ? "OTHER" : current === "NOT_IDENTIFIABLE" ? "NOT_IDENTIFIABLE" : current === "NO_DRIVER_INFORMATION" ? "NO_INFORMATION" : "UNDETERMINED");
  const needsConfirm = mode === "CONTRACT" || mode === "OTHER";
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
      <p role="note" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">{AUTHORITY_DRIVER_NOTICE}</p>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="label-xs mb-1">Fahrerbestimmung</legend>
        <label className={`flex items-start gap-2 rounded-md px-3 py-2 ${candidates.length === 0 ? "opacity-60" : "bg-panel-2"}`}>
          <input type="radio" name="mode" value="CONTRACT" checked={mode === "CONTRACT"} onChange={() => setMode("CONTRACT")} disabled={candidates.length === 0} className="mt-1" />
          <span><span className="font-medium">Vertragsfahrer benennen</span><br /><span className="text-xs text-ink-3">{candidates.length === 0 ? "Kein finalisierter Mietvertrag mit Fahrern zugeordnet." : "Nur Personen, die im versiegelten Mietvertrag als Fahrer eingetragen sind."}</span></span>
        </label>
        {mode === "CONTRACT" && candidates.length > 0 && (
          <div className="ml-6 flex flex-col gap-1">
            {candidates.map((d) => (
              <label key={d.contractDriverId} className="flex items-start gap-2 rounded-md border border-line-soft px-3 py-2">
                <input type="radio" name="contractDriverId" value={d.contractDriverId} defaultChecked={currentContractDriverId === d.contractDriverId} required className="mt-1" />
                <span><span className="font-medium">{d.name}</span> <span className="text-xs text-ink-3">· {d.roleLabel} · geb. {d.birthDate} · {d.city}</span></span>
              </label>
            ))}
          </div>
        )}
        <label className="flex items-start gap-2 rounded-md bg-panel-2 px-3 py-2">
          <input type="radio" name="mode" value="OTHER" checked={mode === "OTHER"} onChange={() => setMode("OTHER")} className="mt-1" />
          <span><span className="font-medium">Andere Person benennen</span><br /><span className="text-xs text-ink-3">z. B. wenn der Mieter Ihnen den tatsächlichen Fahrer schriftlich mitgeteilt hat. Nur die nötigsten Angaben.</span></span>
        </label>
        {mode === "OTHER" && (
          <div className="ml-6 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="Vorname"><input name="firstName" required maxLength={80} className="input" /></Field>
            <Field label="Nachname"><input name="lastName" required maxLength={80} className="input" /></Field>
            <Field label="Geburtsdatum (optional)"><input name="birthDate" type="date" className="input" /></Field>
            <Field label="Straße (optional)"><input name="street" maxLength={120} className="input" /></Field>
            <Field label="PLZ (optional)"><input name="zip" maxLength={12} className="input" /></Field>
            <Field label="Ort (optional)"><input name="city" maxLength={80} className="input" /></Field>
          </div>
        )}
        <label className="flex items-start gap-2 rounded-md bg-panel-2 px-3 py-2">
          <input type="radio" name="mode" value="NOT_IDENTIFIABLE" checked={mode === "NOT_IDENTIFIABLE"} onChange={() => setMode("NOT_IDENTIFIABLE")} className="mt-1" />
          <span><span className="font-medium">Fahrer nicht eindeutig feststellbar</span><br /><span className="text-xs text-ink-3">Immer zulässig – z. B. bei mehreren Vertragsfahrern oder fehlender Grundlage.</span></span>
        </label>
        <label className="flex items-start gap-2 rounded-md bg-panel-2 px-3 py-2">
          <input type="radio" name="mode" value="NO_INFORMATION" checked={mode === "NO_INFORMATION"} onChange={() => setMode("NO_INFORMATION")} className="mt-1" />
          <span><span className="font-medium">Keine Fahrerinformation vorhanden</span><br /><span className="text-xs text-ink-3">z. B. keine Vermietung zur Tatzeit oder kein Vertrag mit Fahrerangaben.</span></span>
        </label>
        <label className="flex items-start gap-2 rounded-md px-3 py-2">
          <input type="radio" name="mode" value="UNDETERMINED" checked={mode === "UNDETERMINED"} onChange={() => setMode("UNDETERMINED")} className="mt-1" />
          <span className="font-medium">Noch offen lassen</span>
        </label>
      </fieldset>
      <Field label="Grundlage / Begründung (optional)" hint="intern, z. B. „Mieter hat per E-Mail vom 12.03. den Fahrer benannt“"><input name="note" maxLength={1000} className="input" /></Field>
      {needsConfirm && (
        <label className="flex items-start gap-2 rounded-md border-2 border-brand px-3 py-2 text-sm">
          <input type="checkbox" name="confirmed" value="1" required className="mt-1" />
          <span>Ich bestätige, dass für die Benennung dieser Person als Fahrer eine ausreichende Grundlage vorliegt. Die Zuordnung der Vermietung allein reicht dafür nicht.</span>
        </label>
      )}
      <div><button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Fahrerbestimmung speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Antwort vorbereiten → Vorschau prüfen → freigeben → übermitteln
// ---------------------------------------------------------------------------

export function PrepareResponseForm({ action, allowedTypes, hasEmail, hasPersons, defaultType, defaultMethod }: { action: Action; allowedTypes: string[]; hasEmail: boolean; hasPersons: boolean; defaultType: string; defaultMethod: string }) {
  const { state, formAction, pending } = useAuthAction(action);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(defaultType);
  const [method, setMethod] = useState(defaultMethod);
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Antwort vorbereiten</button><Feedback state={state} /></div>;
  const personal = type === "DRIVER_IDENTIFIED" || type === "MULTIPLE_POSSIBLE_DRIVERS";
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Antwortart" hint="nur Antwortarten, die zum aktuellen Stand passen">
          <select name="responseType" value={type} onChange={(e) => setType(e.target.value)} className="input">
            {Object.entries(AUTHORITY_RESPONSE_TYPES).filter(([k]) => allowedTypes.includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Übermittlungsweg" hint={method === "EMAIL" && !hasEmail ? "Für E-Mail muss die Behördenadresse aus dem Schreiben erfasst sein." : method === "VERIFIED_API" ? "Für diesen Empfänger gibt es keine verifizierte Schnittstelle." : undefined}>
          <select name="submissionMethod" value={method} onChange={(e) => setMethod(e.target.value)} className="input">
            {Object.entries(SUBMISSION_METHODS).map(([k, v]) => <option key={k} value={k} disabled={k === "VERIFIED_API" || (k === "EMAIL" && !hasEmail)}>{v}</option>)}
          </select>
        </Field>
        {personal && hasPersons && (
          <div className="sm:col-span-2 flex flex-col gap-1 text-sm">
            <span className="label-xs">Personendaten in der Antwort (Datensparsamkeit)</span>
            <span className="text-xs text-ink-3">Name wird immer übermittelt. Führerscheinnummer, Telefon, E-Mail, Geburtsort, Vertrags-PDF, Protokolle und Fotos werden nie automatisch beigefügt.</span>
            <label className="flex items-center gap-2"><input type="checkbox" name="includeBirthDate" value="1" defaultChecked /> Geburtsdatum aufnehmen</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="includeAddress" value="1" defaultChecked /> Anschrift aufnehmen</label>
          </div>
        )}
        <Field label={type === "CUSTOM_RESPONSE" ? "Antworttext" : "Ergänzende Angaben (optional)"} className="sm:col-span-2"><textarea name="freeText" rows={4} maxLength={4000} required={type === "CUSTOM_RESPONSE"} className="input" /></Field>
      </div>
      <p className="text-xs text-ink-3">Es entsteht ein Entwurf mit Vorschau. Erst die ausdrückliche Freigabe macht die Fassung unveränderlich; erst danach kann sie übermittelt werden.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird erstellt…" : "Entwurf erstellen"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function ApproveForm({ action, responseId, personCount }: { action: Action; responseId: string; personCount: number }) {
  const { state, formAction, pending } = useAuthAction(action);
  const [confirm, setConfirm] = useState(false);
  if (!confirm) return <div className="inline-flex flex-col gap-1"><button type="button" className="btn btn-primary" onClick={() => setConfirm(true)}>Angaben geprüft und Antwort freigeben</button><Feedback state={state} /></div>;
  return (
    <form action={formAction} className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2 text-sm">
      <input type="hidden" name="responseId" value={responseId} />
      <input type="hidden" name="confirm" value="1" />
      <div className="font-medium">Diese Fassung freigeben?</div>
      <p className="text-ink-2">Die Fassung wird unveränderlich, erhält eine Prüfsumme und wird als PDF abgelegt.{personCount > 0 ? ` Sie enthält ${personCount === 1 ? "eine Person" : `${personCount} Personen`} – bitte nur freigeben, wenn die Grundlage geprüft ist.` : " Sie enthält keine Personendaten."}</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird freigegeben…" : "Ja, Antwort freigeben"}</button>
        <button type="button" className="btn" onClick={() => setConfirm(false)}>Zurück</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function SubmitForm({ action, responseId, method, recipientEmail, retryNonce, receiptOptions, defaultSubmittedAt }: { action: Action; responseId: string; method: string; recipientEmail: string | null; /** gesetzt nach einem Fehlversuch: jeder erneute Versuch bekommt einen eigenen Schlüssel */ retryNonce: string | null; receiptOptions: { id: string; label: string }[]; defaultSubmittedAt: string }) {
  const { state, formAction, pending } = useAuthAction(action);
  const [open, setOpen] = useState(false);
  const retry = !!retryNonce;
  const label = method === "EMAIL" ? (retry ? "Versand erneut versuchen" : "Jetzt per E-Mail senden") : method === "POST" ? "Als versendet markieren" : method === "MANUAL_PORTAL" ? "Im Behördenportal übermittelt" : "Als übermittelt markieren";
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>{label}</button><Feedback state={state} /></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-3 text-sm">
      <input type="hidden" name="responseId" value={responseId} />
      <input type="hidden" name="confirm" value="1" />
      {retryNonce && <input type="hidden" name="nonce" value={retryNonce} />}
      {method === "EMAIL" ? (
        <p>Die freigegebene Antwort wird als PDF an <span className="font-medium">{recipientEmail}</span> gesendet – an keine andere Adresse. Der Versand wird im E-Mail-Protokoll festgehalten.</p>
      ) : (
        <>
          <p>{method === "POST" ? "Bitte erst die PDF ausdrucken und versenden, dann hier bestätigen." : method === "MANUAL_PORTAL" ? "Bitte die Angaben im Portal der Behörde eintragen bzw. die PDF dort hochladen, dann hier bestätigen. Zugangsdaten werden nicht gespeichert." : "Bitte den Weg der Übermittlung im Hinweis beschreiben."}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="Übermittelt am"><input name="submittedAt" type="datetime-local" required defaultValue={defaultSubmittedAt} className="input" /></Field>
            <Field label={method === "MANUAL_PORTAL" ? "Portal-Vorgangsnummer / Referenz (optional)" : "Referenz (optional)"}><input name="reference" maxLength={120} className="input" /></Field>
            {receiptOptions.length > 0 && <Field label="Nachweisdokument (optional)" hint="vorher als „Übermittlungsnachweis“ hochladen"><select name="receiptDocumentId" defaultValue="" className="input"><option value="">– keins –</option>{receiptOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></Field>}
            <Field label="Hinweis (optional)" className="sm:col-span-2"><input name="note" maxLength={500} className="input" /></Field>
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Bitte warten…" : method === "EMAIL" ? "Ja, jetzt senden" : "Ja, als übermittelt markieren"}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Aktionen mit Grund, Notizen, Dokumente
// ---------------------------------------------------------------------------

export function ConfirmReasonForm({ action, label, question, reasonLabel = "Grund", warning, danger = false, submitLabel, pendingLabel }: { action: Action; label: string; question: string; reasonLabel?: string; warning?: string | null; danger?: boolean; submitLabel: string; pendingLabel: string }) {
  const { state, formAction, pending } = useAuthAction(action);
  const [open, setOpen] = useState(false);
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className={`btn !py-1.5 ${danger ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>{label}</button><Feedback state={state} /></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-2 rounded-lg border-2 p-4 text-sm ${danger ? "border-bad/40 bg-bad-soft/30" : "border-brand bg-panel"}`}>
      <div className="font-medium">{question}</div>
      {warning && <p className="rounded-md bg-amber-soft text-amber px-3 py-2">{warning}</p>}
      <label className="flex flex-col gap-1"><span className="label-xs">{reasonLabel} (Pflicht)</span><input name="reason" required minLength={3} maxLength={500} className="input" /></label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={`btn ${danger ? "btn-danger" : "btn-primary"}`}>{pending ? pendingLabel : submitLabel}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function NoteForm({ action }: { action: Action }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: AuthState, fd: FormData) => { const res = await action(prev, fd); if (res?.ok) router.refresh(); return res; }, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Field label="Notiz zur Historie"><textarea name="note" required minLength={2} maxLength={2000} rows={2} className="input" placeholder="z. B. Rückfrage bei der Behörde am …" /></Field>
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Notiz speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

export function InternalNoteForm({ action, value }: { action: Action; value: string }) {
  const { state, formAction, pending } = useAuthAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2">
      <Field label="Interne Notiz (erscheint nie in einer Antwort)"><textarea name="internalNote" defaultValue={value} maxLength={4000} rows={3} className="input" /></Field>
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Interne Notiz speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

export function DocumentUploader({ endpoint, defaultType = "INCOMING_NOTICE" }: { endpoint: string; defaultType?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const entries = Object.entries(AUTHORITY_DOCUMENT_TYPES).filter(([k]) => k !== "RESPONSE_PDF");
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
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,220px)_1fr_auto] gap-2 items-end">
        <Field label="Dokumenttyp"><select name="type" className="input" defaultValue={defaultType}>{entries.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Beschreibung (optional)"><input name="description" maxLength={300} className="input" placeholder="z. B. Anhörungsbogen Seite 1–2" /></Field>
        <input ref={input} type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Wird hochgeladen…" : "Dokument hochladen"}</button>
      </div>
      <p className="text-xs text-ink-3">PDF oder Bild bis 8 MB, privat gespeichert. Keine Texterkennung – die Angaben des Schreibens werden manuell erfasst.</p>
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error}</p>}
      {ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{ok}</p>}
    </form>
  );
}

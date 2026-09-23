"use client";

// Formulare der Schadenakte. Entscheidungen mit Tragweite (Haftung „Kunde verantwortlich“, Kundenbelastung, Sperren,
// Schließen) verlangen einen Grund und eine ausdrückliche Bestätigung; nach Erfolg lädt die Seite die Serverdaten neu.

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { DAMAGE_CASE_DOCUMENT_TYPES, DAMAGE_CASE_PRIORITY, DAMAGE_CASE_STATUS, DAMAGE_TAX_TREATMENT_HELP, DAMAGE_TAX_TREATMENTS, LIABILITY_STATUS, type DamageCaseStatus, type DamageTaxTreatment } from "@/lib/constants";
import type { CaseState } from "./actions";

type Action = (prev: CaseState, formData: FormData) => Promise<CaseState>;

function Feedback({ state }: { state: CaseState }) {
  if (state?.error) return <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>;
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  return null;
}

function useCaseAction(action: Action) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: CaseState, fd: FormData) => {
    const res = await action(prev, fd);
    if (res?.ok) router.refresh();
    return res;
  }, undefined);
  return { state, formAction, pending };
}

/** Einfacher Aktionsknopf (z. B. „Schadenakte eröffnen“): sperrt sich während der Ausführung, leitet der Server weiter, endet er hier. */
export function ActionButton({ action, label, pendingLabel, primary = false, small = false }: { action: Action; label: string; pendingLabel: string; primary?: boolean; small?: boolean }) {
  const { state, formAction, pending } = useCaseAction(action);
  return (
    <form action={formAction} className="inline-flex flex-col gap-1">
      <button type="submit" disabled={pending} className={`btn ${primary ? "btn-primary" : ""} ${small ? "!py-1.5" : ""}`}>{pending ? pendingLabel : label}</button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Status und Priorität
// ---------------------------------------------------------------------------

export function StatusForm({ action, current, allowed }: { action: Action; current: string; allowed: DamageCaseStatus[] }) {
  const { state, formAction, pending } = useCaseAction(action);
  if (allowed.length === 0) return null;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col gap-1"><span className="label-xs">Neuer Status</span>
          <select name="to" className="input" defaultValue={allowed[0]}>{allowed.map((s) => <option key={s} value={s}>{DAMAGE_CASE_STATUS[s]}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1 grow"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={500} className="input" /></label>
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Status ändern"}</button>
      </div>
      <p className="text-xs text-ink-3">Aktuell: {DAMAGE_CASE_STATUS[current as DamageCaseStatus] ?? current}. Ein Statuswechsel sperrt oder befreit das Fahrzeug nicht; das sind eigene Aktionen.</p>
      <Feedback state={state} />
    </form>
  );
}

export function PriorityForm({ action, current }: { action: Action; current: string }) {
  const { state, formAction, pending } = useCaseAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-wrap gap-2 items-end">
      <label className="flex flex-col gap-1"><span className="label-xs">Priorität</span>
        <select name="priority" className="input" defaultValue={current}>{Object.entries(DAMAGE_CASE_PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
      <button type="submit" disabled={pending} className="btn">{pending ? "…" : "Speichern"}</button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Haftung: bewusste Entscheidung, bei „Kunde verantwortlich“ mit Pflichtbegründung und Rückfrage
// ---------------------------------------------------------------------------

export function LiabilityForm({ action, current, currentNote, locked }: { action: Action; current: string; currentNote: string | null; locked: boolean }) {
  const { state, formAction, pending } = useCaseAction(action);
  const [status, setStatus] = useState(current);
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const isCustomer = status === "CUSTOMER_RESPONSIBILITY_CONFIRMED";
  if (locked) return <p className="text-sm text-ink-3">Die Kundenbelastung ist festgelegt; die Haftungsentscheidung ist damit festgeschrieben. Korrekturen laufen über die Schadenabrechnung (Fassungen).</p>;
  const toConfirm = () => { if (form.current?.reportValidity()) setConfirm(true); };
  return (
    <form ref={form} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,260px)_1fr] gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Haftung</span>
          <select name="status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setConfirm(false); }}>
            {Object.entries(LIABILITY_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1"><span className="label-xs">Begründung{isCustomer ? " (Pflicht)" : " (optional)"}</span>
          <input name="note" defaultValue={currentNote ?? ""} required={isCustomer} minLength={isCustomer ? 3 : undefined} maxLength={1000} className="input" placeholder={isCustomer ? "z. B. Schaden im Rückgabeprotokoll als neu dokumentiert, Mieter hat Verursachung schriftlich bestätigt" : "Anmerkung zur Einschätzung"} onChange={() => setConfirm(false)} />
        </label>
      </div>
      {isCustomer && !confirm && <p className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Diese Entscheidung bedeutet: Der Mieter wird für diesen Schaden verantwortlich gemacht. Erst danach ist „Schaden dem Kunden berechnen“ möglich. Rent-Base leitet keine Haftung aus dem Rückgabeprotokoll ab; die Entscheidung trifft der Mitarbeiter.</p>}
      {!confirm && (
        <div><button type="button" className="btn btn-primary" onClick={isCustomer ? toConfirm : () => form.current?.requestSubmit()} disabled={pending}>{pending ? "Wird gespeichert…" : "Haftung festlegen"}</button></div>
      )}
      {confirm && (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2">
          <div className="font-medium">Haftung auf „Kunde verantwortlich (bestätigt)“ setzen?</div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Ja, Kunde verantwortlich"}</button>
            <button type="button" className="btn" onClick={() => setConfirm(false)}>Zurück</button>
          </div>
        </div>
      )}
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Kosten und Reparatur
// ---------------------------------------------------------------------------

export function CostsForm({ action, estimated, actual }: { action: Action; estimated: string; actual: string }) {
  const { state, formAction, pending } = useCaseAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Kostenschätzung in €</span><input name="estimated" inputMode="decimal" defaultValue={estimated} placeholder="0,00" className="input tnum" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Tatsächliche Reparaturkosten in €</span><input name="actual" inputMode="decimal" defaultValue={actual} placeholder="0,00" className="input tnum" /></label>
      </div>
      <p className="text-xs text-ink-3">Nur Information: Kosten erzeugen keine Forderung, keine Rechnung, keine Zahlung und keine Kautionsbewegung.</p>
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Kosten speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

export function RepairForm({ action, provider, appointmentAt, completedAt }: { action: Action; provider: string; appointmentAt: string; completedAt: string }) {
  const { state, formAction, pending } = useCaseAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Werkstatt / Dienstleister</span><input name="provider" defaultValue={provider} maxLength={200} className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Reparaturtermin</span><input name="appointmentAt" type="datetime-local" defaultValue={appointmentAt} className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Reparatur abgeschlossen am</span><input name="completedAt" type="datetime-local" defaultValue={completedAt} className="input" /></label>
      </div>
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Reparaturdaten speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------

export function NoteForm({ action }: { action: Action }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: CaseState, fd: FormData) => {
    const res = await action(prev, fd);
    if (res?.ok) router.refresh();
    return res;
  }, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1"><span className="label-xs">Operative Notiz</span><textarea name="note" required minLength={2} maxLength={2000} rows={2} className="input" placeholder="z. B. Werkstatt angerufen, Termin folgt" /></label>
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Notiz speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

export function InternalNoteForm({ action, value }: { action: Action; value: string }) {
  const { state, formAction, pending } = useCaseAction(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1"><span className="label-xs">Interne Notiz (nie auf Kundenunterlagen)</span><textarea name="note" defaultValue={value} maxLength={4000} rows={3} className="input" /></label>
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Interne Notiz speichern"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Aktionen mit Grund und Rückfrage (Sperren, Freigeben, Schließen, Wiederöffnen)
// ---------------------------------------------------------------------------

export function ConfirmReasonForm({ action, label, question, reasonLabel, reasonRequired = true, warning, danger = false, submitLabel, pendingLabel }: { action: Action; label: string; question: string; reasonLabel: string; reasonRequired?: boolean; warning?: string | null; danger?: boolean; submitLabel: string; pendingLabel: string }) {
  const { state, formAction, pending } = useCaseAction(action);
  const [open, setOpen] = useState(false);
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className={`btn ${danger ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>{label}</button><Feedback state={state} /></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-2 rounded-lg border-2 p-4 text-sm ${danger ? "border-bad/40 bg-bad-soft/30" : "border-brand bg-panel"}`}>
      <div className="font-medium">{question}</div>
      {warning && <p className="rounded-md bg-amber-soft text-amber px-3 py-2">{warning}</p>}
      <label className="flex flex-col gap-1"><span className="label-xs">{reasonLabel}{reasonRequired ? " (Pflicht)" : " (optional)"}</span><input name={reasonRequired ? "reason" : "note"} required={reasonRequired} minLength={reasonRequired ? 3 : undefined} maxLength={500} className="input" /></label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={`btn ${danger ? "btn-danger" : "btn-primary"}`}>{pending ? pendingLabel : submitLabel}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Kundenbelastung: Betrag, Grundlage, steuerliche Behandlung, ausdrückliche Bestätigung
// ---------------------------------------------------------------------------

export function ChargeForm({ action, nonce, hints }: { action: Action; nonce: string; hints: { label: string; value: string }[] }) {
  const { state, formAction, pending } = useCaseAction(action);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ amount: string; basis: string; tax: string } | null>(null);
  const [tax, setTax] = useState("");
  const form = useRef<HTMLFormElement>(null);
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Schaden dem Kunden berechnen</button><Feedback state={state} /></div>;
  const toConfirm = () => {
    if (!form.current || !form.current.reportValidity()) return;
    const fd = new FormData(form.current);
    setConfirm({ amount: String(fd.get("amount") ?? ""), basis: String(fd.get("basis") ?? ""), tax: DAMAGE_TAX_TREATMENTS[String(fd.get("taxTreatment")) as keyof typeof DAMAGE_TAX_TREATMENTS] ?? "" });
  };
  return (
    <form ref={form} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 rounded-lg bg-panel-2 p-4">
      <input type="hidden" name="nonce" value={nonce} />
      <div className="font-medium">Schaden dem Kunden berechnen</div>
      {hints.length > 0 && (
        <div className="text-sm rounded-md border border-line-soft p-3 flex flex-col gap-0.5">
          <div className="label-xs">Zur Orientierung (kein Vorschlag, keine Verrechnung)</div>
          {hints.map((h) => <div key={h.label} className="flex justify-between gap-3"><span className="text-ink-3">{h.label}</span><span className="font-mono tnum">{h.value}</span></div>)}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Betrag in € (Pflicht)</span><input name="amount" inputMode="decimal" required placeholder="0,00" className="input text-xl tnum" onChange={() => setConfirm(null)} /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Steuerliche Behandlung (Pflicht)</span>
          <select name="taxTreatment" required value={tax} className="input" onChange={(e) => { setTax(e.target.value); setConfirm(null); }}>
            <option value="" disabled>Bitte auswählen</option>
            {Object.entries(DAMAGE_TAX_TREATMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {tax in DAMAGE_TAX_TREATMENT_HELP && <span className="text-xs text-ink-3">{DAMAGE_TAX_TREATMENT_HELP[tax as DamageTaxTreatment]}</span>}
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Grundlage der Kundenbelastung (Pflicht, erscheint auf der Abrechnung)</span><input name="basis" required minLength={5} maxLength={500} className="input" placeholder="z. B. Reparaturkosten laut Werkstattrechnung Nr. 4711 vom 12.09.2026" onChange={() => setConfirm(null)} /></label>
      </div>
      <p className="text-xs text-ink-3">Den Betrag legen Sie fest – Rent-Base rechnet nicht mit Selbstbeteiligung, Kaution oder Kosten. Die steuerliche Behandlung ist Ihre Entscheidung; Rent-Base trifft keine Steuerannahme. Es entsteht eine eigene Schadenabrechnung als Entwurf; die Mietrechnung bleibt unverändert. Kaution und Forderung werden nicht miteinander verrechnet.</p>
      {!confirm && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={toConfirm}>Weiter zur Bestätigung</button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
      )}
      {confirm && (
        <div className="rounded-lg border-2 border-brand bg-panel p-4 flex flex-col gap-2">
          <input type="hidden" name="confirm" value="1" />
          <div className="text-sm font-medium">Dem Kunden berechnen</div>
          <div className="text-3xl font-semibold font-mono tnum tracking-tight">{confirm.amount} €</div>
          <div className="text-sm">{confirm.tax}</div>
          <div className="text-sm text-ink-2">Grundlage: {confirm.basis}</div>
          <div className="text-xs text-ink-3">Danach wird der Entwurf der Schadenabrechnung geöffnet. Die Rechnungsnummer vergibt das System erst beim Abschluss der Abrechnung.</div>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="submit" disabled={pending} className="btn btn-primary !py-2.5">{pending ? "Wird erstellt…" : "Ja, Schadenabrechnung erstellen"}</button>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>Zurück</button>
          </div>
        </div>
      )}
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Uploads: Fotos und Dokumente über die geschützten API-Routen
// ---------------------------------------------------------------------------

const MAX_EDGE = 2000;
async function downscale(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

export function CasePhotoUploader({ caseId }: { caseId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const caption = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.set("file", await downscale(file), "foto.jpg");
        if (caption.current?.value) body.set("caption", caption.current.value);
        const res = await fetch(`/api/damage-cases/${caseId}/photos`, { method: "POST", body });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Das Foto konnte nicht gespeichert werden.");
      }
      if (caption.current) caption.current.value = "";
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col gap-1 grow"><span className="label-xs">Beschreibung (optional)</span><input ref={caption} maxLength={120} className="input" placeholder="z. B. Detailaufnahme, nach Reparatur" /></label>
        <input ref={input} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Wird hochgeladen…" : "Foto aufnehmen / hochladen"}</button>
      </div>
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error}</p>}
    </div>
  );
}

export function CaseDocumentUploader({ caseId }: { caseId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || !form.current) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData(form.current);
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.set("file", file, file.name);
        body.set("type", String(fd.get("type") ?? "OTHER"));
        if (fd.get("note")) body.set("note", String(fd.get("note")));
        const res = await fetch(`/api/damage-cases/${caseId}/documents`, { method: "POST", body });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Das Dokument konnte nicht gespeichert werden.");
      }
      form.current.reset();
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
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col gap-1"><span className="label-xs">Dokumenttyp</span>
          <select name="type" className="input" defaultValue="ESTIMATE">{Object.entries(DAMAGE_CASE_DOCUMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1 grow"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={300} className="input" placeholder="z. B. KV Werkstatt Müller vom 12.09." /></label>
        <input ref={input} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => upload(e.target.files)} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Wird hochgeladen…" : "Dokument hochladen"}</button>
      </div>
      <p className="text-xs text-ink-3">PDF oder Bild bis 8 MB. Beträge werden nicht ausgelesen; Kosten tragen Sie unter „Kosten“ ein.</p>
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error}</p>}
    </form>
  );
}

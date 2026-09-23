"use client";

// Editor für Mietbedingungen: Textfeld mit Markdown-Teilmenge, Werkzeugleiste (tastaturbedienbar) und Vorschau aus demselben
// Parser, der Vertragsansicht und PDF speist. Kein HTML, keine Skripte. Veröffentlichen und Archivieren mit Rückfrage.

import { useActionState, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui";
import { TermsBlocksView } from "@/components/terms-view";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { TERMS_TEMPLATE_NOTICE } from "@/lib/constants";
import { parseTerms } from "@/lib/terms-markdown";
import type { TermsState } from "./actions";

type Action = (prev: TermsState, fd: FormData) => Promise<TermsState>;

function Feedback({ state }: { state: TermsState }) {
  if (!state) return null;
  return (
    <>
      <FormError error={state.error} />
      {state.ok && <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>}
    </>
  );
}

export function CreateDraftForm({ action, hasLegacy, proposedLabel }: { action: Action; hasLegacy: boolean; proposedLabel: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Versionsbezeichnung</span><input name="label" defaultValue={proposedLabel} maxLength={40} className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Titel</span><input name="title" defaultValue="Allgemeine Mietbedingungen" maxLength={160} className="input" /></label>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Ausgangspunkt</span>
          <select name="source" defaultValue={hasLegacy ? "legacy" : "template"} className="input">
            {hasLegacy && <option value="legacy">Bisheriger Mietbedingungstext (vor der Versionierung)</option>}
            <option value="template">Strukturvorlage (nur Gliederung, ohne Klauseln)</option>
            <option value="empty">Leer</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-ink-3">{TERMS_TEMPLATE_NOTICE}. Rent-Base erzeugt keine Klauseln und macht keine Aussage zur rechtlichen Wirksamkeit.</p>
      <div><button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird angelegt…" : "Entwurf anlegen"}</button></div>
      <Feedback state={state} />
    </form>
  );
}

type DraftValues = { label: string; title: string; content: string; changeNote: string; effectiveFrom: string };

export function DraftEditor({ action, values }: { action: Action; values: DraftValues }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: TermsState, fd: FormData) => { const r = await action(prev, fd); if (r?.ok) router.refresh(); return r; }, undefined);
  const [content, setContent] = useState(values.content);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const area = useRef<HTMLTextAreaElement>(null);
  const blocks = useMemo(() => parseTerms(content), [content]);

  // Werkzeugleiste: Einfügen an der Cursorposition; der Ref wird nur im Ereignis gelesen, nie beim Rendern
  const insertAt = (kind: [string, string, boolean]) => () => insert(kind[0], kind[1], kind[2]);
  function insert(prefix: string, suffix = "", block = false) {
    const el = area.current;
    if (!el) return;
    const start = el.selectionStart, end = el.selectionEnd;
    const selected = content.slice(start, end);
    let before = content.slice(0, start);
    if (block && before.length && !before.endsWith("\n")) before += "\n";
    const next = `${before}${prefix}${selected || (block ? "Text" : "Text")}${suffix}${content.slice(end)}`;
    setContent(next);
    requestAnimationFrame(() => { el.focus(); const pos = before.length + prefix.length; el.setSelectionRange(pos, pos + (selected || "Text").length); });
  }
  const tool = (label: string, title: string, kind: [string, string, boolean]) => <button type="button" className="btn !py-1 !px-2 text-xs" title={title} aria-label={title} onClick={insertAt(kind)}>{label}</button>;

  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Versionsbezeichnung</span><input name="label" defaultValue={values.label} required maxLength={40} className="input" /></label>
        <label className="flex flex-col gap-1 md:col-span-2"><span className="label-xs">Titel</span><input name="title" defaultValue={values.title} required maxLength={160} className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Gültig ab (optional)</span><input name="effectiveFrom" type="date" defaultValue={values.effectiveFrom} className="input" /><span className="text-xs text-ink-3">Leer = ab Veröffentlichung. Beim Vertrag zählt immer die tatsächlich gewählte Fassung.</span></label>
        <label className="flex flex-col gap-1 md:col-span-2"><span className="label-xs">Änderungshinweis (optional, intern)</span><input name="changeNote" defaultValue={values.changeNote} maxLength={500} className="input" placeholder="z. B. Abschnitt Auslandsfahrten überarbeitet" /></label>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Formatierung">
        {tool("H1", "Hauptüberschrift", ["# ", "", true])}
        {tool("H2", "Abschnittsüberschrift", ["## ", "", true])}
        {tool("H3", "Unterüberschrift", ["### ", "", true])}
        {tool("• Liste", "Aufzählung", ["- ", "", true])}
        {tool("1. Liste", "Nummerierte Liste", ["1. ", "", true])}
        {tool("Fett", "Fett", ["**", "**", false])}
        <span className="flex-1" />
        <div className="flex gap-1" role="tablist" aria-label="Ansicht">
          <button type="button" role="tab" aria-selected={tab === "edit"} className={`btn !py-1 !px-2 text-xs ${tab === "edit" ? "!bg-brand !text-brand-ink !border-brand" : ""}`} onClick={() => setTab("edit")}>Bearbeiten</button>
          <button type="button" role="tab" aria-selected={tab === "preview"} className={`btn !py-1 !px-2 text-xs ${tab === "preview" ? "!bg-brand !text-brand-ink !border-brand" : ""}`} onClick={() => setTab("preview")}>Vorschau</button>
        </div>
      </div>
      <div className={`grid grid-cols-1 ${tab === "edit" ? "xl:grid-cols-2" : ""} gap-3 items-start`}>
        <label className={`flex flex-col gap-1 ${tab === "preview" ? "hidden xl:flex" : ""}`}>
          <span className="label-xs">Text (Markdown-Teilmenge: #, ##, ###, -, 1., **fett**)</span>
          <textarea ref={area} name="content" value={content} onChange={(e) => setContent(e.target.value)} rows={28} className="input font-mono text-[13px] leading-relaxed" spellCheck />
          <span className="text-xs text-ink-3">{content.length.toLocaleString("de-DE")} Zeichen · Absätze durch Leerzeile trennen. HTML ist nicht erlaubt.</span>
        </label>
        <div className={`rounded-lg border border-line-soft bg-panel p-4 max-h-[42rem] overflow-y-auto ${tab === "edit" ? "hidden xl:block" : ""}`} aria-label="Vorschau">
          <div className="label-xs mb-2">Vorschau (so erscheint der Text im Vertrag und im PDF)</div>
          <TermsBlocksView blocks={blocks} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Entwurf speichern"}</button>
        <span className="text-xs text-ink-3">Speichern ändert nichts an Verträgen. Erst die Veröffentlichung macht die Fassung für neue Verträge verfügbar.</span>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function ConfirmForm({ action, label, question, hint, submitLabel, pendingLabel = "Bitte warten…", danger = false, withReason = false, fields }: { action: Action; label: string; question: string; hint?: string; submitLabel: string; pendingLabel?: string; danger?: boolean; withReason?: boolean; fields?: React.ReactNode }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: TermsState, fd: FormData) => { const r = await action(prev, fd); if (r?.ok) router.refresh(); return r; }, undefined);
  const [open, setOpen] = useState(false);
  if (!open) return <div className="inline-flex flex-col gap-1"><button type="button" className={`btn ${danger ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>{label}</button><Feedback state={state} /></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className={`flex flex-col gap-2 rounded-lg border-2 p-4 text-sm ${danger ? "border-bad/40 bg-bad-soft/30" : "border-brand bg-panel"}`}>
      <input type="hidden" name="confirm" value="1" />
      <div className="font-medium">{question}</div>
      {hint && <p className="text-ink-2">{hint}</p>}
      {fields}
      {withReason && <label className="flex flex-col gap-1"><span className="label-xs">Grund (optional)</span><input name="reason" maxLength={300} className="input" /></label>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={`btn ${danger ? "btn-danger" : "btn-primary"}`}>{pending ? pendingLabel : submitLabel}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

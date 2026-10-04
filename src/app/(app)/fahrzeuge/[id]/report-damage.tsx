"use client";

// Befehl 27: „+ Schaden erfassen“ in der Fahrzeugakte – Schaden ohne Übergabe-/Rückgabeprotokoll. Position wie bei der
// Übergabe auf der Fahrzeugskizze antippen; Fotos werden nach dem Speichern einzeln hochgeladen (verkleinert wie bei
// Protokollfotos). Scheitert ein Foto, bleibt der Schaden gespeichert und das Foto kann erneut gewählt werden.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, FormError } from "@/components/ui";
import { DAMAGE_KINDS, DAMAGE_SEVERITY } from "@/lib/constants";
import { SKETCH_CANVAS_WIDTH, type SketchInfo } from "@/lib/handover-view";
import { downscale } from "../../buchungen/[id]/uebergabe/photo-uploader";
import type { ReportDamageState } from "./damage-actions";

type Marker = { view: string; posX: number; posY: number };

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function uploadDamagePhoto(damageId: string, file: File) {
  const body = new FormData();
  body.set("file", await downscale(file), "foto.jpg");
  const res = await fetch(`/api/damages/${damageId}/photos`, { method: "POST", body });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Das Foto konnte nicht gespeichert werden.");
}

export function ReportDamageButton({ action, sketch, existing }: { action: (prev: ReportDamageState, fd: FormData) => Promise<ReportDamageState>; sketch: SketchInfo | null; existing: Marker[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const views = sketch?.views ?? [];
  const [viewKey, setViewKey] = useState(views[0]?.key ?? "FRONT");
  const [pos, setPos] = useState<{ posX: number; posY: number } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const view = views.find((v) => v.key === viewKey) ?? views[0];

  function reset() { setOpen(false); setPos(null); setFiles([]); setError(null); setSavedId(null); }

  async function uploadAll(id: string, list: File[]) {
    const failed: File[] = [];
    let last = "";
    for (const f of list) { try { await uploadDamagePhoto(id, f); } catch (e) { failed.push(f); last = (e as Error).message; } }
    setFiles(failed);
    if (failed.length) { setError(`Der Schaden ist gespeichert, aber ${failed.length} Foto(s) konnten nicht hochgeladen werden: ${last}`); return false; }
    return true;
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      // Schaden bereits gespeichert (z. B. Foto-Upload fehlgeschlagen): nur die restlichen Fotos erneut senden
      if (savedId) { if (await uploadAll(savedId, files)) { reset(); router.refresh(); } return; }
      if (!pos) { setError("Bitte die Stelle des Schadens auf der Skizze antippen."); return; }
      fd.set("view", view?.key ?? viewKey);
      fd.set("posX", String(pos.posX));
      fd.set("posY", String(pos.posY));
      const res = await action(undefined, fd);
      if (res?.error || !res?.damageId) { setError(res?.error ?? "Der Schaden konnte nicht gespeichert werden."); return; }
      setSavedId(res.damageId);
      if (files.length === 0 || (await uploadAll(res.damageId, files))) { reset(); router.refresh(); }
    });
  }

  if (!open) return <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>+ Schaden erfassen</button>;

  const box = view?.box;
  return (
    <form onSubmit={submit} className="card p-4 flex flex-col gap-3 w-full">
      <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Schaden erfassen (ohne Protokoll)</h3><span className="text-xs text-ink-3">Herkunft: manuell erfasst</span></div>
      <fieldset disabled={pending || !!savedId} className="flex flex-col gap-3 min-w-0">
        {sketch && view && box ? (
          <>
            <div role="tablist" aria-label="Fahrzeugbereich" className="grid grid-cols-3 md:grid-cols-6 gap-1.5">
              {views.map((v) => (
                <button key={v.key} type="button" role="tab" aria-selected={v.key === view.key} onClick={() => { setViewKey(v.key); setPos(null); }} className={`rounded-md border px-2 min-h-[44px] text-[13px] font-medium truncate ${v.key === view.key ? "bg-brand text-brand-ink border-brand" : "bg-panel border-line hover:bg-panel-2/60"}`}>{v.label.replace(/\s*\(.*\)\s*$/, "")}</button>
              ))}
            </div>
            <div className="rounded-lg border border-line bg-white p-2 max-w-[640px]">
              <div className="relative overflow-hidden" style={{ aspectRatio: `${box[2]} / ${box[3]}` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={sketch.assetPath} alt="" draggable={false} className="absolute max-w-none h-auto select-none pointer-events-none" style={{ width: `${(SKETCH_CANVAS_WIDTH / box[2]) * 100}%`, left: `${(-box[0] / box[2]) * 100}%`, top: `${(-box[1] / box[3]) * 100}%` }} />
                <svg
                  viewBox={`${box[0]} ${box[1]} ${box[2]} ${box[3]}`}
                  role="img"
                  aria-label={`Fahrzeugskizze ${view.label} – Stelle des Schadens antippen`}
                  className="absolute inset-0 w-full h-full cursor-crosshair select-none"
                  style={{ touchAction: "manipulation" }}
                  onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPos({ posX: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), posY: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }); }}
                >
                  {existing.filter((m) => m.view === view.key).map((m, i) => <circle key={i} cx={box[0] + m.posX * box[2]} cy={box[1] + m.posY * box[3]} r={box[2] * 0.025} fill="#4a5568" stroke="#fff" strokeWidth={box[2] * 0.004} />)}
                  {pos && <g style={{ pointerEvents: "none" }}><circle cx={box[0] + pos.posX * box[2]} cy={box[1] + pos.posY * box[3]} r={box[2] * 0.048} fill="none" stroke="#b23a32" strokeWidth={box[2] * 0.007} /><circle cx={box[0] + pos.posX * box[2]} cy={box[1] + pos.posY * box[3]} r={box[2] * 0.017} fill="#b23a32" /></g>}
                </svg>
              </div>
            </div>
            <p className="text-xs text-ink-3">{pos ? "Stelle markiert. Zum Ändern erneut antippen." : "Stelle des Schadens auf der Skizze antippen. Graue Punkte: bereits bekannte Schäden."}</p>
          </>
        ) : <p className="text-sm text-ink-3">Für dieses Fahrzeug ist keine Skizze hinterlegt.</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Schadenart" htmlFor="rd-kind"><select id="rd-kind" name="kind" defaultValue="SCRATCH" className="input">{Object.entries(DAMAGE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Schweregrad" htmlFor="rd-severity"><select id="rd-severity" name="severity" defaultValue="MINOR" className="input">{Object.entries(DAMAGE_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Größe (optional)" htmlFor="rd-size"><input id="rd-size" name="size" maxLength={60} className="input" placeholder="z. B. ca. 12 cm" /></Field>
          <Field label="Festgestellt am" htmlFor="rd-at"><input id="rd-at" name="discoveredAt" type="datetime-local" defaultValue={nowLocal()} className="input tnum" /></Field>
          <Field label="Beschreibung" htmlFor="rd-desc" full><textarea id="rd-desc" name="description" required minLength={3} maxLength={1000} rows={2} className="input" placeholder="z. B. Delle Tür hinten links, beim Waschen entdeckt" /></Field>
          <Field label="Interne Notiz (optional)" htmlFor="rd-note" full><textarea id="rd-note" name="note" maxLength={1000} rows={2} className="input" placeholder="z. B. wer, wo, Zusammenhang" /></Field>
        </div>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <span className="label-xs">Fotos</span>
        <div className="flex flex-wrap gap-2">
          <label className="btn cursor-pointer">Foto aufnehmen<input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const f = Array.from(e.target.files ?? []); setFiles((x) => [...x, ...f]); e.target.value = ""; }} /></label>
          <label className="btn cursor-pointer">Foto auswählen<input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => { const f = Array.from(e.target.files ?? []); setFiles((x) => [...x, ...f]); e.target.value = ""; }} /></label>
        </div>
        {files.length > 0 && <span className="text-xs text-ink-2">{files.length} Foto(s) ausgewählt{savedId ? " – noch nicht hochgeladen" : ""}</span>}
      </div>
      <FormError error={error ?? undefined} />
      <p className="text-xs text-ink-3">Die Verantwortlichkeit bleibt zunächst offen. Es entsteht keine Belastung und keine Rechnung; über „Schadenakte eröffnen“ geht es bei Bedarf weiter.</p>
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
        <button type="button" className="btn justify-center" disabled={pending} onClick={() => { reset(); if (savedId) router.refresh(); }}>{savedId ? "Ohne weitere Fotos schließen" : "Abbrechen"}</button>
        <button type="submit" className="btn btn-primary justify-center" disabled={pending}>{pending ? "Wird gespeichert…" : savedId ? "Fotos erneut hochladen" : "Schaden speichern"}</button>
      </div>
    </form>
  );
}

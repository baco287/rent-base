"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DAMAGE_KINDS, DAMAGE_SEVERITY } from "@/lib/constants";
import { SKETCH_CANVAS_WIDTH, type DamageSymbol, type DocDamage, type SketchInfo } from "@/lib/handover-view";
import { PhotoUploader, uploadHandoverPhoto } from "./photo-uploader";

export type DamagePayload = { view: string; posX: number; posY: number; kind: string; severity: string; size: string; description: string };
type Result = { error?: string } | undefined;

export type DamageActions = {
  /** liefert die ID des neuen Schadens, damit Fotos direkt bei der Erfassung zugeordnet werden (Befehl 20.7) */
  add: (payload: DamagePayload) => Promise<Result | { id: string }>;
  update: (damageId: string, payload: Partial<DamagePayload>) => Promise<Result>;
  remove: (damageId: string) => Promise<Result>;
};

const EXISTING_COLOR = "#4a5568";
const NEW_COLOR = "#b23a32";
const RETURN_COLOR = "#8a5a00";

const SYMBOL_COLOR: Record<DamageSymbol, string> = { circle: EXISTING_COLOR, diamond: NEW_COLOR, triangle: RETURN_COLOR };

/** Kleines Symbol für Legende und Liste: Kreis, Raute oder Dreieck, immer mit Farbe UND Form unterscheidbar. */
export function MarkerIcon({ symbol, index, size = 14 }: { symbol: DamageSymbol; index?: number; size?: number }) {
  const fill = SYMBOL_COLOR[symbol];
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="inline shrink-0 align-[-2px]" aria-hidden="true">
      {symbol === "circle" && <circle cx="7" cy="7" r="6.5" fill={fill} />}
      {symbol === "diamond" && <rect x="2.3" y="2.3" width="9.4" height="9.4" transform="rotate(45 7 7)" fill={fill} />}
      {symbol === "triangle" && <path d="M7 0.8 L13.6 12.6 L0.4 12.6 Z" fill={fill} />}
      {index != null && <text x="7" y={symbol === "triangle" ? 8.4 : 7} textAnchor="middle" dominantBaseline="central" fontSize={symbol === "triangle" ? 6.2 : 7} fontWeight="700" fill="#fff">{index}</text>}
    </svg>
  );
}

export function legendFor(type: "PICKUP" | "RETURN"): { symbol: DamageSymbol; text: string }[] {
  return type === "PICKUP"
    ? [{ symbol: "circle", text: "Bereits dokumentiert" }, { symbol: "diamond", text: "Neu entdeckt, gilt als Vorschaden" }]
    : [{ symbol: "circle", text: "Vor Mietbeginn dokumentiert" }, { symbol: "diamond", text: "Bei Übergabe dokumentierter Vorschaden" }, { symbol: "triangle", text: "Bei Rückgabe neu festgestellt" }];
}

/**
 * Fahrzeugskizze mit Schäden. Positionen sind normalisiert (0 bis 1) relativ zur Ansicht, nie Pixel.
 * Kreis = vor der Miete bekannt, Raute = bei Übergabe dokumentierter Vorschaden, Dreieck = bei Rückgabe festgestellt.
 * So sind die Einstufungen auch ohne Farbe unterscheidbar.
 */
/**
 * activeView/onViewChange (Befehl 20.7): die gewählte Fahrzeugansicht kann von außen geführt werden, damit der Vergleich
 * „Übergabe vorher / Rückgabe jetzt“ auf beiden Skizzen dieselbe Ansicht zeigt.
 */
export function DamageMap({ sketch, damages, handoverId, editable, actions, pickup, type, title, activeView, onViewChange }: { sketch: SketchInfo | null; damages: DocDamage[]; handoverId: string; editable: boolean; actions?: DamageActions; pickup?: boolean; type?: "PICKUP" | "RETURN"; title?: string; activeView?: string; onViewChange?: (key: string) => void }) {
  const router = useRouter();
  const kind: "PICKUP" | "RETURN" = type ?? (pickup === false ? "RETURN" : "PICKUP");
  const views = sketch?.views ?? [];
  const [internalView, setInternalView] = useState(views[0]?.key ?? "FRONT");
  const viewKey = activeView ?? internalView;
  const setViewKey = (key: string) => { setInternalView(key); onViewChange?.(key); };
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<{ view: string; posX: number; posY: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  // Fotos, die beim Speichern eines neuen Schadens nicht hochgeladen werden konnten: bleiben zum erneuten Versuch erhalten
  const [retry, setRetry] = useState<{ damageId: string; files: File[] } | null>(null);

  const view = views.find((v) => v.key === viewKey) ?? views[0];
  const current = damages.find((d) => d.id === selected) ?? null;
  const inView = damages.filter((d) => d.view === view?.key);
  const countFor = (key: string) => damages.filter((d) => d.view === key).length;

  function run(fn: () => Promise<Result>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (res?.error) setError(res.error);
      else after?.();
    });
  }

  /** Fotos nacheinander dem Schaden zuordnen; scheitert eines, bleibt der Schaden gespeichert und die Dateien bleiben zum erneuten Versuch. */
  async function uploadDamagePhotos(damageId: string, files: File[]) {
    const failed: File[] = [];
    let lastError = "";
    for (const f of files) {
      try { await uploadHandoverPhoto(handoverId, f, "DAMAGE", damageId); } catch (e) { failed.push(f); lastError = (e as Error).message; }
    }
    if (failed.length > 0) {
      setRetry({ damageId, files: failed });
      setError(`Der Schaden ist gespeichert, aber ${failed.length === 1 ? "ein Foto konnte" : `${failed.length} Fotos konnten`} nicht hochgeladen werden: ${lastError} Die Aufnahmen sind nicht verloren – bitte „Fotos erneut hochladen“.`);
    } else setRetry(null);
    router.refresh();
  }

  function addWithPhotos(values: { kind: string; severity: string; size: string; description: string }, files: File[]) {
    if (!pending || !actions) return;
    setError(null);
    startTransition(async () => {
      const res = await actions.add({ ...pending, ...values });
      if (res && "error" in res && res.error) { setError(res.error); return; }
      const id = res && "id" in res ? res.id : null;
      setPending(null);
      if (id) {
        setSelected(id);
        if (files.length > 0) await uploadDamagePhotos(id, files);
      }
    });
  }

  function tap(e: React.MouseEvent<SVGSVGElement>) {
    if (!editable || !view || !actions) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const posX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const posY = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    if (moving && current && current.marker === "NEW") {
      run(() => actions.update(current.id, { view: view.key, posX, posY }), () => setMoving(false));
      return;
    }
    setSelected(null);
    setPending({ view: view.key, posX, posY });
  }

  if (!sketch || !view) return <p className="text-sm text-ink-3">Für dieses Fahrzeug ist keine Skizze hinterlegt.</p>;
  const [bx, by, bw, bh] = view.box;
  const r = bw * 0.032;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
      <div className="flex flex-col gap-2.5">
        {title && <div className="font-semibold text-sm">{title}</div>}
        {/* Fahrzeugbereiche als Raster: sofort erkennbar und mit dem Daumen erreichbar (kein seitliches Scrollen), Anzahl je Bereich */}
        <div role="tablist" aria-label="Fahrzeugansicht" className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
          {views.map((v) => {
            const n = countFor(v.key);
            const on = v.key === view.key;
            return (
              <button key={v.key} type="button" role="tab" aria-selected={on} onClick={() => { setViewKey(v.key); setPending(null); }} className={`flex flex-col items-center justify-center gap-0.5 rounded-md border px-2 py-2 min-h-[52px] text-sm font-medium ${on ? "bg-brand text-brand-ink border-brand" : "bg-panel border-line hover:bg-panel-2/60"}`}>
                <span>{v.label}</span>
                <span className={`text-[11px] font-normal ${on ? "text-brand-ink/80" : n > 0 ? "text-ink-2" : "text-ink-3"}`}>{n === 0 ? "keine Schäden" : n === 1 ? "1 Schaden" : `${n} Schäden`}</span>
              </button>
            );
          })}
        </div>

        <div className="rounded-lg border border-line bg-white p-2">
          {/* Die Skizze liegt als normales Bild unter der Markierungsebene und wird auf den Rahmen der Ansicht
              zugeschnitten. Die Höhe folgt dem Seitenverhältnis der Datei, das klappt in jedem Browser gleich. */}
          <div className="relative overflow-hidden" style={{ aspectRatio: `${bw} / ${bh}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sketch.assetPath}
              alt=""
              draggable={false}
              className="absolute max-w-none h-auto select-none pointer-events-none"
              style={{ width: `${(SKETCH_CANVAS_WIDTH / bw) * 100}%`, left: `${(-bx / bw) * 100}%`, top: `${(-by / bh) * 100}%` }}
            />
          <svg
            viewBox={`${bx} ${by} ${bw} ${bh}`}
            onClick={tap}
            role="img"
            aria-label={`Fahrzeugskizze ${view.label}`}
            className={`absolute inset-0 w-full h-full select-none ${editable ? (moving ? "cursor-move" : "cursor-crosshair") : ""}`}
            style={{ touchAction: "manipulation" }}
          >
            {inView.map((d) => {
              const cx = bx + d.posX * bw;
              const cy = by + d.posY * bh;
              const color = SYMBOL_COLOR[d.symbol];
              const active = d.id === selected;
              return (
                <g
                  key={d.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Schaden ${d.index}: ${d.kindLabel}, ${d.viewLabel}, ${d.markerLabel}`}
                  onClick={(e) => { e.stopPropagation(); setPending(null); setMoving(false); setSelected(d.id); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setPending(null); setMoving(false); setSelected(d.id); } }}
                  className="cursor-pointer outline-none focus-visible:[&>*:first-child]:stroke-[#1a6fd1]"
                >
                  {active && <circle cx={cx} cy={cy} r={r * 1.8} fill="none" stroke={color} strokeWidth={bw * 0.006} strokeDasharray={`${bw * 0.012} ${bw * 0.008}`} />}
                  {d.symbol === "diamond" && <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} transform={`rotate(45 ${cx} ${cy})`} fill={color} stroke="#fff" strokeWidth={bw * 0.005} />}
                  {d.symbol === "triangle" && <path d={`M${cx} ${cy - r * 1.45} L${cx + r * 1.4} ${cy + r * 1.05} L${cx - r * 1.4} ${cy + r * 1.05} Z`} fill={color} stroke="#fff" strokeWidth={bw * 0.005} strokeLinejoin="round" />}
                  {d.symbol === "circle" && <circle cx={cx} cy={cy} r={r} fill={color} stroke="#fff" strokeWidth={bw * 0.005} />}
                  <text x={cx} y={d.symbol === "triangle" ? cy + r * 0.3 : cy} textAnchor="middle" dominantBaseline="central" fontSize={r * 1.15} fontWeight="700" fill="#fff" style={{ pointerEvents: "none" }}>{d.index}</text>
                </g>
              );
            })}
            {pending && pending.view === view.key && (
              <g style={{ pointerEvents: "none" }}>
                <circle cx={bx + pending.posX * bw} cy={by + pending.posY * bh} r={r * 1.5} fill="none" stroke={kind === "RETURN" ? RETURN_COLOR : NEW_COLOR} strokeWidth={bw * 0.007} />
                <circle cx={bx + pending.posX * bw} cy={by + pending.posY * bh} r={r * 0.35} fill={kind === "RETURN" ? RETURN_COLOR : NEW_COLOR} />
              </g>
            )}
          </svg>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-2">
          {legendFor(kind).map((l) => <span key={l.symbol} className="inline-flex items-center gap-1.5"><MarkerIcon symbol={l.symbol} />{l.text}</span>)}
          {editable && <span className="text-ink-3">{moving ? "Jetzt auf die neue Stelle tippen." : "Auf die Skizze tippen, um einen Schaden zu markieren."}</span>}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error}</p>}

        {pending && editable && actions && (
          <DamageEditor
            key={`new-${pending.posX}-${pending.posY}`}
            title={`${kind === "RETURN" ? "Bei Rückgabe festgestellter Schaden" : "Neuer Schaden"} · ${view.label}`}
            busy={busy}
            submitLabel="Schaden speichern"
            onCancel={() => setPending(null)}
            withPhotos
            onSubmit={(v, files) => addWithPhotos(v, files ?? [])}
          />
        )}

        {retry && current && retry.damageId === current.id && (
          <div className="rounded-md bg-amber-soft px-3 py-2.5 text-sm flex flex-wrap items-center gap-2">
            <span className="text-amber">{retry.files.length === 1 ? "1 Foto" : `${retry.files.length} Fotos`} noch nicht hochgeladen.</span>
            <button type="button" className="btn !py-1.5" disabled={busy} onClick={() => startTransition(async () => { await uploadDamagePhotos(retry.damageId, retry.files); })}>Fotos erneut hochladen</button>
            <button type="button" className="text-xs underline text-ink-3" onClick={() => setRetry(null)}>Verwerfen</button>
          </div>
        )}

        {current && !pending && (
          <div className="card p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span className="font-semibold">Schaden {current.index}</span>
              <span className={`chip ${current.symbol === "triangle" ? "bg-amber-soft text-amber" : current.symbol === "diamond" ? "bg-bad-soft text-bad" : "bg-panel-2 text-ink-2"}`}>{current.markerLabel}</span>
            </div>
            {current.marker === "NEW" && editable && actions ? (
              <>
                <DamageEditor
                  key={current.id}
                  busy={busy}
                  initial={{ kind: current.kind, severity: current.severity, size: current.size ?? "", description: current.description }}
                  submitLabel="Änderungen speichern"
                  onSubmit={(v) => run(() => actions.update(current.id, v))}
                  bare
                />
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={`btn ${moving ? "!bg-brand !text-brand-ink !border-brand" : ""}`} onClick={() => setMoving((m) => !m)} disabled={busy}>{moving ? "Verschieben abbrechen" : "Auf der Skizze verschieben"}</button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => run(() => actions.remove(current.id), () => setSelected(null))}>Schaden löschen</button>
                </div>
                <PhotoUploader handoverId={handoverId} category="DAMAGE" label="Fotos des Schadens" handoverDamageId={current.id} photos={current.photos} editable required compact />
              </>
            ) : (
              <>
                <dl className="grid grid-cols-[92px_1fr] gap-y-1 text-sm">
                  <dt className="text-ink-3">Ansicht</dt><dd>{current.viewLabel}</dd>
                  <dt className="text-ink-3">Art</dt><dd>{current.kindLabel}</dd>
                  <dt className="text-ink-3">Schwere</dt><dd>{current.severityLabel}</dd>
                  <dt className="text-ink-3">Größe</dt><dd>{current.size || "–"}</dd>
                  <dt className="text-ink-3">Beschreibung</dt><dd>{current.description}</dd>
                </dl>
                {current.photos.length > 0 && <PhotoUploader handoverId={handoverId} category="DAMAGE" label="Fotos" photos={current.photos} editable={false} compact />}
                {current.marker !== "NEW" && editable && <p className="text-xs text-ink-3">Dieser Schaden ist bereits in der Fahrzeugakte dokumentiert und wird im Protokoll unverändert festgehalten.</p>}
                {current.marker === "NEW" && kind === "RETURN" && <p className="text-xs text-ink-3">Festgestellt heißt nicht verursacht: Das Protokoll hält den Zustand fest. Über Verantwortung und Kosten wird gesondert entschieden.</p>}
              </>
            )}
          </div>
        )}

        {/* Liste aller Schäden – bewusst von den Fahrzeugansichten abgesetzt: sie ist keine Fahrzeugseite */}
        <div className="card border-dashed">
          <div className="px-3.5 py-2.5 border-b border-line-soft bg-panel-2/60 flex items-center gap-2"><span className="font-semibold text-sm">Liste aller Schäden</span><span className="chip bg-panel-2 text-ink-2">{damages.length}</span><span className="text-[11px] text-ink-3">alle Ansichten</span></div>
          {damages.length === 0 ? (
            <p className="px-3.5 py-3 text-sm text-ink-3">Keine Schäden dokumentiert.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {damages.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => { setViewKey(d.view); setPending(null); setMoving(false); setSelected(d.id); }} className={`w-full text-left px-3.5 py-2 flex items-start gap-2.5 hover:bg-panel-2/60 ${d.id === selected ? "bg-panel-2" : ""}`}>
                    <span className="mt-0.5 shrink-0"><MarkerIcon symbol={d.symbol} index={d.index} size={20} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">{d.kindLabel} · {d.viewLabel}</span>
                      <span className="block text-xs text-ink-3 truncate">{d.description}</span>
                    </span>
                    {d.marker === "NEW" && d.photos.length === 0 && <span className="chip bg-amber-soft text-amber">Foto fehlt</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * withPhotos (Befehl 20.7): bei der Neuanlage können Fotos direkt aufgenommen oder ausgewählt werden; sie werden nach dem
 * Speichern des Schadens diesem zugeordnet (dieselbe Speicherlogik wie „Fotos des Schadens“, keine doppelte Ablage).
 */
function DamageEditor({ title, initial, busy, submitLabel, onSubmit, onCancel, bare = false, withPhotos = false }: { title?: string; initial?: { kind: string; severity: string; size: string; description: string }; busy: boolean; submitLabel: string; onSubmit: (v: { kind: string; severity: string; size: string; description: string }, files?: File[]) => void; onCancel?: () => void; bare?: boolean; withPhotos?: boolean }) {
  const [kind, setKind] = useState(initial?.kind ?? "SCRATCH");
  const [severity, setSeverity] = useState(initial?.severity ?? "MINOR");
  const [size, setSize] = useState(initial?.size ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | null) => { if (list) setFiles((f) => [...f, ...Array.from(list)]); };
  const body = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ kind, severity, size, description }, withPhotos ? files : undefined);
      }}
      className="flex flex-col gap-2.5"
    >
      {title && <div className="font-semibold">{title}</div>}
      <div className="grid grid-cols-2 gap-2.5">
        <label className="flex flex-col gap-1"><span className="label-xs">Art</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="input">{Object.entries(DAMAGE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1"><span className="label-xs">Schweregrad</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="input">{Object.entries(DAMAGE_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
      </div>
      <label className="flex flex-col gap-1"><span className="label-xs">Größe</span>
        <input value={size} onChange={(e) => setSize(e.target.value)} className="input" placeholder="z. B. ca. 5 cm" />
      </label>
      <label className="flex flex-col gap-1"><span className="label-xs">Beschreibung</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} required minLength={3} rows={2} className="input" placeholder="z. B. Kratzer an der Stoßstange unten links" />
      </label>
      {withPhotos && (
        <div className={`rounded-lg border p-2.5 flex flex-col gap-2 ${files.length === 0 ? "border-amber bg-amber-soft/40" : "border-line bg-panel"}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-[13px]">Fotos <span className="text-ink-3 font-normal">· mindestens ein Foto ist Pflicht</span></span>
            {files.length > 0 ? <span className="chip bg-good-soft text-good">{files.length}</span> : <span className="chip bg-amber-soft text-amber">fehlt</span>}
          </div>
          {files.length > 0 && (
            <ul className="grid grid-cols-3 gap-2">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={URL.createObjectURL(f)} alt={`Foto ${i + 1}`} className="w-full aspect-[4/3] object-cover rounded-md border border-line bg-panel-2" onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)} />
                  <button type="button" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))} aria-label={`Foto ${i + 1} entfernen`} className="absolute top-1 right-1 size-7 rounded-full bg-black/60 text-white text-sm leading-none">×</button>
                </li>
              ))}
            </ul>
          )}
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} aria-label="Foto aufnehmen" />
          <input ref={fileInput} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} aria-label="Foto auswählen" />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => cameraInput.current?.click()} disabled={busy} className="btn justify-center !py-2.5">Foto aufnehmen</button>
            <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className="btn justify-center !py-2.5">Foto auswählen</button>
          </div>
          <p className="text-[11px] text-ink-3">Die Fotos werden beim Speichern direkt diesem Schaden zugeordnet. Ohne Foto kann das Protokoll nicht abgeschlossen werden; die Schadendaten gehen bei einem Uploadproblem nicht verloren.</p>
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary">{busy ? "Wird gespeichert…" : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} className="btn">Abbrechen</button>}
      </div>
    </form>
  );
  return bare ? body : <div className="card p-3.5 border-bad/40">{body}</div>;
}

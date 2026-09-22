"use client";

import { useState, useTransition } from "react";
import { DAMAGE_KINDS, DAMAGE_SEVERITY } from "@/lib/constants";
import { SKETCH_CANVAS_WIDTH, type DamageSymbol, type DocDamage, type SketchInfo } from "@/lib/handover-view";
import { PhotoUploader } from "./photo-uploader";

export type DamagePayload = { view: string; posX: number; posY: number; kind: string; severity: string; size: string; description: string };
type Result = { error?: string } | undefined;

export type DamageActions = {
  add: (payload: DamagePayload) => Promise<Result>;
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
export function DamageMap({ sketch, damages, handoverId, editable, actions, pickup, type, title }: { sketch: SketchInfo | null; damages: DocDamage[]; handoverId: string; editable: boolean; actions?: DamageActions; pickup?: boolean; type?: "PICKUP" | "RETURN"; title?: string }) {
  const kind: "PICKUP" | "RETURN" = type ?? (pickup === false ? "RETURN" : "PICKUP");
  const views = sketch?.views ?? [];
  const [viewKey, setViewKey] = useState(views[0]?.key ?? "FRONT");
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<{ view: string; posX: number; posY: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

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
        <div role="tablist" aria-label="Fahrzeugansicht" className="flex gap-1.5 overflow-x-auto pb-0.5">
          {views.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={v.key === view.key} onClick={() => { setViewKey(v.key); setPending(null); }} className={`btn !py-2 shrink-0 ${v.key === view.key ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>
              {v.label}
              {countFor(v.key) > 0 && <span className={`ml-1 rounded-full px-1.5 text-[11px] ${v.key === view.key ? "bg-white/25" : "bg-panel-2"}`}>{countFor(v.key)}</span>}
            </button>
          ))}
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
                <g key={d.id} onClick={(e) => { e.stopPropagation(); setPending(null); setMoving(false); setSelected(d.id); }} className="cursor-pointer">
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
            onSubmit={(v) => run(() => actions.add({ ...pending, ...v }), () => setPending(null))}
          />
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

        <div className="card">
          <div className="px-3.5 py-2.5 border-b border-line-soft font-semibold text-sm">Alle Schäden ({damages.length})</div>
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

function DamageEditor({ title, initial, busy, submitLabel, onSubmit, onCancel, bare = false }: { title?: string; initial?: { kind: string; severity: string; size: string; description: string }; busy: boolean; submitLabel: string; onSubmit: (v: { kind: string; severity: string; size: string; description: string }) => void; onCancel?: () => void; bare?: boolean }) {
  const [kind, setKind] = useState(initial?.kind ?? "SCRATCH");
  const [severity, setSeverity] = useState(initial?.severity ?? "MINOR");
  const [size, setSize] = useState(initial?.size ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const body = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ kind, severity, size, description });
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
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary">{busy ? "Wird gespeichert…" : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} className="btn">Abbrechen</button>}
      </div>
    </form>
  );
  return bare ? body : <div className="card p-3.5 border-bad/40">{body}</div>;
}

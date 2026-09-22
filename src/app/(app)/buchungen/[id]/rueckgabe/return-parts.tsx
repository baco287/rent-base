"use client";

// Client-Bausteine des Rückgabe-Assistenten: Vorher-/Nachher-Vergleich der Skizze, Fotovergleich, Zusatzkosten.
// Rechnen tut hier nichts: Beträge und Vorschläge kommen fertig vom Server.

import { useState, useTransition } from "react";
import { CHARGE_UNITS, EXTRA_CHARGE_TYPES } from "@/lib/constants";
import type { DocDamage, HandoverDocument } from "@/lib/handover-view";
import type { ChargeRow, Proposal, ReturnHint } from "@/lib/returns";
import { DamageMap, MarkerIcon, type DamageActions } from "../uebergabe/damage-map";
import { PhotoUploader } from "../uebergabe/photo-uploader";

type Result = { error?: string } | undefined;

/**
 * Übergabezustand und Rückgabezustand nebeneinander. Auf dem Smartphone ein Umschalter, damit beide Skizzen
 * groß bleiben. Die Beschriftung sagt immer, welcher Zustand gerade zu sehen ist.
 */
export function CompareDamages({ pickup, current, handoverId, actions }: { pickup: HandoverDocument; current: HandoverDocument; handoverId: string; actions: DamageActions }) {
  const [side, setSide] = useState<"pickup" | "return">("return");
  const tab = (key: "pickup" | "return", label: string) => (
    <button type="button" role="tab" aria-selected={side === key} onClick={() => setSide(key)} className={`btn flex-1 !py-2.5 ${side === key ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{label}</button>
  );
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Zustand" className="flex gap-2 xl:hidden">
        {tab("pickup", `Übergabe (vorher)`)}
        {tab("return", `Rückgabe (jetzt)`)}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <div className={`card p-4 ${side === "pickup" ? "" : "hidden xl:block"}`}>
          <div className="mb-2 flex items-center gap-2"><span className="chip bg-panel-2 text-ink-2">Übergabe · vorher</span><span className="text-xs text-ink-3">Protokoll {pickup.number}, unveränderlich</span></div>
          <DamageMap sketch={pickup.sketch} damages={pickup.damages} handoverId={pickup.number} editable={false} type="PICKUP" />
        </div>
        <div className={`card p-4 ${side === "return" ? "" : "hidden xl:block"}`}>
          <div className="mb-2 flex items-center gap-2"><span className="chip bg-amber-soft text-amber">Rückgabe · jetzt</span><span className="text-xs text-ink-3">Auf die Skizze tippen, um einen neuen Schaden zu markieren</span></div>
          <DamageMap sketch={current.sketch} damages={current.damages} handoverId={handoverId} editable type="RETURN" actions={actions} />
        </div>
      </div>
    </div>
  );
}

/** Übergabefoto neben dem Rückgabefoto je Kategorie. Auf dem Smartphone untereinander. */
export function ComparePhotos({ categories, pickupPhotos, returnPhotos, handoverId }: { categories: { key: string; label: string; required: boolean }[]; pickupPhotos: Record<string, { id: string; url: string }[]>; returnPhotos: Record<string, { id: string; url: string }[]>; handoverId: string }) {
  return (
    <div className="flex flex-col gap-3">
      {categories.map((c) => {
        const before = pickupPhotos[c.key] ?? [];
        return (
          <div key={c.key} className="card p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs font-semibold text-ink-2">{c.label} · Übergabe (vorher)</div>
              {before.length === 0 ? (
                <div className="aspect-[4/3] rounded-md border border-dashed border-line bg-panel-2 flex items-center justify-center text-xs text-ink-3">kein Übergabefoto</div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {before.map((p) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className={`block ${before.length === 1 ? "col-span-2" : ""}`}><img src={p.url} alt={`${c.label}, Übergabe`} loading="lazy" className="w-full aspect-[4/3] object-cover rounded-md border border-line bg-panel-2" /></a>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs font-semibold text-amber">{c.label} · Rückgabe (jetzt)</div>
              <PhotoUploader handoverId={handoverId} category={c.key} label={c.label} photos={returnPhotos[c.key] ?? []} editable required={c.required} compact />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });

export type ChargeActions = {
  confirm: (key: "EXTRA_MILEAGE" | "FUEL") => Promise<Result>;
  add: (payload: unknown) => Promise<Result>;
  remove: (chargeId: string) => Promise<Result>;
};

/** Zusatzkosten: Vorschläge des Systems bestätigen, eigene Positionen erfassen, Positionen entfernen. */
export function ChargesEditor({ proposals, hints, charges, total, deposit, newDamages, actions }: { proposals: Proposal[]; hints: ReturnHint[]; charges: ChargeRow[]; total: number; deposit: number; newDamages: DocDamage[]; actions: ChargeActions }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const run = (fn: () => Promise<Result>, after?: () => void) => { setError(null); start(async () => { const r = await fn(); if (r?.error) setError(r.error); else after?.(); }); };
  const damageOf = (id: string | null) => newDamages.find((d) => d.id === id);

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error}</p>}

      {(proposals.length > 0 || hints.length > 0) && (
        <div className="card">
          <div className="px-4 py-2.5 border-b border-line-soft font-semibold text-sm">Vorschläge aus dem Vergleich</div>
          <ul className="divide-y divide-line-soft">
            {proposals.map((p) => (
              <li key={p.key} className="px-4 py-3 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{EXTRA_CHARGE_TYPES[p.draft.type]}</span>
                  <span className="text-sm text-ink-2">{p.draft.description}</span>
                  <span className="flex-1" />
                  <span className="font-mono tnum font-semibold">{eur(p.draft.amount)}</span>
                </div>
                <div className="text-xs text-ink-3 font-mono tnum">{p.draft.formula}</div>
                {p.confirmed ? (
                  <div className="flex items-center gap-2"><span className="chip bg-good-soft text-good">Bestätigt</span><span className="text-xs text-ink-3">steht unten in den Positionen</span></div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" disabled={busy} className="btn btn-primary" onClick={() => run(() => actions.confirm(p.key))}>Als Position übernehmen</button>
                    <span className="text-xs text-ink-3">Nur ein Vorschlag. Ohne Bestätigung wird nichts berechnet.</span>
                  </div>
                )}
              </li>
            ))}
            {hints.map((h) => <li key={h.code} className="px-4 py-2.5 text-sm text-ink-2 bg-amber-soft/40">{h.text}</li>)}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2"><span className="font-semibold text-sm">Bestätigte Positionen</span><span className="flex-1" /><span className="font-mono tnum font-semibold">{eur(total)}</span></div>
        {charges.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-3">Noch keine Zusatzkosten erfasst.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {charges.map((c) => {
              const d = damageOf(c.handoverDamageId);
              return (
                <li key={c.id} className="px-4 py-2.5 flex flex-col gap-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="font-medium">{c.typeLabel}</span>
                    <span className="text-sm text-ink-2 flex-1 min-w-[10ch]">{c.description}{d ? ` (Schaden ${d.index})` : ""}</span>
                    <span className="font-mono tnum font-semibold">{eur(c.amount)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                    <span className="font-mono tnum">{c.formula}</span>
                    <span>{c.source === "PROPOSAL" ? "aus Vorschlag bestätigt" : "manuell erfasst"}</span>
                    {c.internalNote && <span>intern: {c.internalNote}</span>}
                    <button type="button" disabled={busy} className="underline text-bad" onClick={() => run(() => actions.remove(c.id))}>entfernen</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="px-4 py-2.5 border-t border-line-soft flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="text-ink-3">Kaution laut Vertrag</span><span className="font-mono tnum">{eur(deposit)}</span>
          <span className="text-xs text-ink-3">Zusatzkosten und Kaution werden getrennt ausgewiesen und nicht verrechnet.</span>
        </div>
      </div>

      {open ? (
        <ChargeForm busy={busy} newDamages={newDamages} onCancel={() => setOpen(false)} onSubmit={(payload) => run(() => actions.add(payload), () => setOpen(false))} />
      ) : (
        <div><button type="button" className="btn" onClick={() => setOpen(true)}>Zusatzkosten hinzufügen</button></div>
      )}
    </div>
  );
}

function ChargeForm({ busy, newDamages, onSubmit, onCancel }: { busy: boolean; newDamages: DocDamage[]; onSubmit: (payload: unknown) => void; onCancel: () => void }) {
  const [type, setType] = useState<string>("CLEANING");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<string>("pauschal");
  const [unitPrice, setUnitPrice] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [handoverDamageId, setHandoverDamageId] = useState("");
  const parse = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
  const q = parse(quantity);
  const p = parse(unitPrice);
  const amount = Number.isFinite(q) && Number.isFinite(p) ? Math.round(q * p * 100) / 100 : null;
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ type, description, quantity: q, unit, unitPrice: p, internalNote: internalNote || undefined, handoverDamageId: type === "DAMAGE" && handoverDamageId ? handoverDamageId : undefined }); }}
      className="card p-4 flex flex-col gap-3"
    >
      <div className="font-semibold">Neue Position</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="label-xs">Art</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="input">{Object.entries(EXTRA_CHARGE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        {type === "DAMAGE" && (
          <label className="flex flex-col gap-1"><span className="label-xs">Zu Schaden (bei Rückgabe festgestellt)</span>
            <select value={handoverDamageId} onChange={(e) => setHandoverDamageId(e.target.value)} className="input">
              <option value="">ohne Zuordnung</option>
              {newDamages.map((d) => <option key={d.id} value={d.id}>{d.index}: {d.kindLabel}, {d.viewLabel}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Beschreibung (für den Mieter sichtbar)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} required minLength={3} className="input" placeholder={type === "MISSING_ACCESSORY" ? "z. B. Zweitschlüssel fehlt" : type === "LATE_RETURN" ? "z. B. Verspätete Rückgabe, 3 Stunden" : "z. B. Innenreinigung wegen starker Verschmutzung"} />
        </label>
        <label className="flex flex-col gap-1"><span className="label-xs">Menge</span>
          <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" required className="input tnum" />
        </label>
        <label className="flex flex-col gap-1"><span className="label-xs">Einheit</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} className="input">{CHARGE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1"><span className="label-xs">Einzelpreis in €</span>
          <input value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} inputMode="decimal" required className="input tnum" placeholder="0,00" />
        </label>
        <div className="flex flex-col gap-1"><span className="label-xs">Betrag</span><div className="input bg-panel-2 font-mono tnum font-semibold">{amount == null ? "–" : eur(amount)}</div></div>
        <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Interne Notiz (nicht auf Dokumenten)</span>
          <input value={internalNote} onChange={(e) => setInternalNote(e.target.value)} className="input" />
        </label>
      </div>
      {type === "DAMAGE" && <p className="text-xs text-ink-3">Diese Position hält nur eine Kostenposition zum Schaden fest. Sie ist keine Feststellung, dass der Mieter den Schaden verursacht hat.</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary">{busy ? "Wird gespeichert…" : "Position speichern"}</button>
        <button type="button" className="btn" onClick={onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}

/** Kompakte Rückgabe-Zusammenfassung vor der Unterschrift. */
export function ReturnSummary({ doc, attention }: { doc: HandoverDocument; attention: string[] }) {
  const c = doc.comparison;
  const existing = doc.damages.filter((d) => d.marker !== "NEW").length;
  const fresh = doc.damages.filter((d) => d.marker === "NEW");
  return (
    <div className="card p-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {c?.rows.map((r) => <div key={r.label} className="flex justify-between gap-3"><span className="text-ink-3">{r.label}</span><span className={`font-mono tnum ${r.attention ? "text-bad font-semibold" : ""}`}>{r.pickup} → {r.ret} ({r.diff})</span></div>)}
      <div className="flex justify-between gap-3"><span className="text-ink-3">Vorher dokumentierte Schäden</span><span>{existing}</span></div>
      <div className="flex justify-between gap-3"><span className="text-ink-3">Bei Rückgabe neu festgestellt</span><span className={fresh.length > 0 ? "text-amber font-semibold inline-flex items-center gap-1.5" : ""}>{fresh.length > 0 && <MarkerIcon symbol="triangle" />}{fresh.length}</span></div>
      <div className="flex justify-between gap-3"><span className="text-ink-3">Checkliste</span><span>{doc.checklist.filter((x) => !x.missing).length} von {doc.checklist.length}{attention.length > 0 ? `, ${attention.length} auffällig` : ""}</span></div>
      <div className="flex justify-between gap-3"><span className="text-ink-3">Zusatzkosten</span><span className="font-mono tnum font-semibold">{c?.charges.length ?? 0} Positionen, {c?.chargesTotal ?? "0,00 €"}</span></div>
      <div className="flex justify-between gap-3"><span className="text-ink-3">Kaution laut Vertrag</span><span className="font-mono tnum">{c?.deposit}</span></div>
      {attention.length > 0 && <ul className="md:col-span-2 list-disc pl-5 text-ink-2">{attention.map((a) => <li key={a}>{a}</li>)}</ul>}
    </div>
  );
}

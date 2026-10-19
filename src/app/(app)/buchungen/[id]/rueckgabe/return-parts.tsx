"use client";

// Client-Bausteine des Rückgabe-Assistenten: Vorher-/Nachher-Vergleich der Skizze, Fotovergleich, Zusatzkosten.
// Rechnen tut hier nichts: Beträge und Vorschläge kommen fertig vom Server. Mehrkilometer-Kulanz: die Betragsvorschau parst nur
// die Eingabe (parseEuroInput, dieselbe reine Funktion wie der Server); entschieden und gerechnet wird ausschließlich serverseitig.

import { useId, useState, useTransition, type FormEvent, type TransitionStartFunction } from "react";
import { CHARGE_UNITS, EXTRA_CHARGE_TYPES } from "@/lib/constants";
import { fmtDateTime } from "@/lib/format";
import { parseEuroInput } from "@/lib/money";
import type { DocDamage, HandoverDocument } from "@/lib/handover-view";
import type { ChargeRow, MileageBilling, MileageBillingState, Proposal, ProposalKey, ReturnHint } from "@/lib/returns";
import { DamageMap, MarkerIcon, type DamageActions } from "../uebergabe/damage-map";
import { PhotoUploader } from "../uebergabe/photo-uploader";

type Result = { error?: string } | undefined;

/**
 * Übergabezustand und Rückgabezustand nebeneinander. Auf dem Smartphone ein Umschalter, damit beide Skizzen
 * groß bleiben. Die Beschriftung sagt immer, welcher Zustand gerade zu sehen ist.
 */
export function CompareDamages({ pickup, current, handoverId, actions }: { pickup: HandoverDocument; current: HandoverDocument; handoverId: string; actions: DamageActions }) {
  const [side, setSide] = useState<"pickup" | "return">("return");
  // Befehl 20.7: dieselbe Fahrzeugansicht auf beiden Skizzen (vorher/jetzt), damit der Vergleich Bereich für Bereich klappt
  const [view, setView] = useState<string | undefined>(undefined);
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
          <DamageMap sketch={pickup.sketch} damages={pickup.damages} handoverId={pickup.number} editable={false} type="PICKUP" activeView={view} onViewChange={setView} />
        </div>
        <div className={`card p-4 ${side === "return" ? "" : "hidden xl:block"}`}>
          <div className="mb-2 flex items-center gap-2"><span className="chip bg-amber-soft text-amber">Rückgabe · jetzt</span><span className="text-xs text-ink-3">Auf die Skizze tippen, um einen neuen Schaden zu markieren</span></div>
          <DamageMap sketch={current.sketch} damages={current.damages} handoverId={handoverId} editable type="RETURN" actions={actions} activeView={view} onViewChange={setView} />
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
  confirm: (key: ProposalKey) => Promise<Result>;
  /** Befehl 20.9: „Nicht berechnen“ (undo = wieder öffnen) */
  dismiss: (key: ProposalKey, undo: boolean) => Promise<Result>;
  add: (payload: unknown) => Promise<Result>;
  remove: (chargeId: string) => Promise<Result>;
  /** Mehrkilometer-Kulanz: individuell festlegen oder erlassen (nur Inhaber/Disposition, serverseitig geprüft) */
  decideMileage: (payload: unknown) => Promise<Result>;
  /** Mehrkilometer-Kulanz: Entscheidung zurücknehmen (nur Inhaber/Disposition) */
  revokeMileage: (payload: unknown) => Promise<Result>;
};

/**
 * Zusatzkosten: Mehrkilometer-Abrechnung, Vorschläge des Systems bestätigen, eigene Positionen erfassen, Positionen entfernen.
 * taxMode: Preise des Mandanten brutto (true), netto (false) oder noch nicht festgelegt (null).
 */
export function ChargesEditor({ proposals, hints, charges, total, deposit, newDamages, actions, mileage, canDecideMileage, renterSigned, taxMode, mileageIssues }: { proposals: Proposal[]; hints: ReturnHint[]; charges: ChargeRow[]; total: number; deposit: number; newDamages: DocDamage[]; actions: ChargeActions; mileage: MileageBilling | null; canDecideMileage: boolean; renterSigned: boolean; taxMode: boolean | null; mileageIssues: string[] }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const run = (fn: () => Promise<Result>, after?: () => void) => { setError(null); start(async () => { const r = await fn(); if (r?.error) setError(r.error); else after?.(); }); };
  const damageOf = (id: string | null) => newDamages.find((d) => d.id === id);
  // Mehrkilometer-Kulanz: Mehrkilometer und der Hinweis „unbegrenzte Kilometer“ stehen in der eigenen Karte, nicht in der Vorschlagsliste
  const otherProposals = proposals.filter((p) => p.key !== "EXTRA_MILEAGE");
  const otherHints = hints.filter((h) => h.code !== "KM_UNLIMITED");

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error}</p>}

      {mileage && <MileageBillingCard mileage={mileage} canDecide={canDecideMileage} renterSigned={renterSigned} taxMode={taxMode} issues={mileageIssues} busy={busy} start={start} actions={actions} />}

      {(otherProposals.length > 0 || otherHints.length > 0) && (
        <div className="card">
          <div className="px-4 py-2.5 border-b border-line-soft font-semibold text-sm">Vorschläge aus dem Vergleich</div>
          <ul className="divide-y divide-line-soft">
            {otherProposals.map((p) => {
              const accessory = p.key.startsWith("ACCESSORY_");
              return (
              <li key={p.key} className={`px-4 py-3 flex flex-col gap-1.5 ${p.dismissed ? "opacity-70" : ""}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{accessory ? "Fehlendes Zubehör erkannt" : EXTRA_CHARGE_TYPES[p.draft.type]}</span>
                  <span className="text-sm text-ink-2">{p.draft.description}</span>
                  <span className="flex-1" />
                  <span className="font-mono tnum font-semibold">{eur(p.draft.amount)}</span>
                </div>
                {p.facts && p.facts.length > 0 && (
                  <ul className="text-xs text-ink-2 flex flex-wrap gap-x-3 gap-y-0.5">{p.facts.map((f) => <li key={f}>· {f}</li>)}</ul>
                )}
                <div className="text-xs text-ink-3 font-mono tnum">{accessory ? `Vorgeschlagener Betrag: ${eur(p.draft.amount)}` : p.draft.formula}</div>
                {p.confirmed ? (
                  <div className="flex items-center gap-2"><span className="chip bg-good-soft text-good">Übernommen</span><span className="text-xs text-ink-3">steht unten in den Positionen</span></div>
                ) : p.dismissed ? (
                  <div className="flex flex-wrap items-center gap-2"><span className="chip bg-panel-2 text-ink-2">Nicht berechnet</span><span className="text-xs text-ink-3">bewusst entschieden, keine Position</span><button type="button" disabled={busy} className="text-xs underline text-ink-3" onClick={() => run(() => actions.dismiss(p.key, true))}>Doch prüfen</button></div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" disabled={busy} className="btn btn-primary" onClick={() => run(() => actions.confirm(p.key))}>Übernehmen</button>
                    <button type="button" disabled={busy} className="btn" onClick={() => run(() => actions.dismiss(p.key, false))}>Nicht berechnen</button>
                    <span className="text-xs text-ink-3">Nur ein Vorschlag. Ohne „Übernehmen“ wird nichts berechnet.</span>
                  </div>
                )}
              </li>
              );
            })}
            {otherHints.map((h) => <li key={h.code} className="px-4 py-2.5 text-sm text-ink-2 bg-amber-soft/40">{h.text}</li>)}
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
                    {c.decision ? (
                      // Mehrkilometer-Kulanz: entschiedene Position – Änderung nur über „Entscheidung zurücknehmen“ in der Mehrkilometer-Abrechnung
                      <span className="chip bg-info-soft text-info">{c.decision.kind === "WAIVED" ? "aus Kulanz erlassen" : `individuell festgelegt (regulär ${eur(c.decision.regularAmount)})`}</span>
                    ) : (
                      <span>{c.source === "PROPOSAL" ? "aus Vorschlag bestätigt" : "manuell erfasst"}</span>
                    )}
                    {c.internalNote && <span>intern: {c.internalNote}</span>}
                    {!c.decision && <button type="button" disabled={busy} className="underline text-bad" onClick={() => run(() => actions.remove(c.id))}>entfernen</button>}
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
          {/* Mehrkilometer-Kulanz: Mehrkilometer nie als manuelle Position – sie entstehen nur über die Mehrkilometer-Abrechnung */}
          <select value={type} onChange={(e) => setType(e.target.value)} className="input">{Object.entries(EXTRA_CHARGE_TYPES).filter(([k]) => k !== "EXTRA_MILEAGE").map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
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

// ---------------------------------------------------------------------------
// Mehrkilometer-Kulanz: Mehrkilometer-Abrechnung (Schritt 7) und schreibgeschützte Ansicht der abgeschlossenen Rückgabe
// ---------------------------------------------------------------------------

type MileageMode = "REGULAR" | "CUSTOM" | "WAIVED";

/** Kennzeichnung der Beträge nach Steuermodus des Mandanten; ohne Festlegung (null) keine Kennzeichnung. */
const taxLabel = (taxMode: boolean | null) => (taxMode === true ? "brutto" : taxMode === false ? "netto zzgl. USt" : null);
const kmText = (n: number) => `${n.toLocaleString("de-DE")} km`;

type StateInfo = { chip: string; tone: string; text: string };
const MILEAGE_STATE: Record<MileageBillingState, StateInfo> = {
  // „noch nicht entschieden“ steht als Blocker in der Fehlerliste von Schritt 7 – die Karte wiederholt ihn nicht, sie sagt, was zu tun ist
  OPEN: { chip: "offen", tone: "bg-amber-soft text-amber", text: "Noch nicht entschieden – bitte unten eine Abrechnungsentscheidung treffen." },
  DISMISSED_LEGACY: { chip: "offen", tone: "bg-amber-soft text-amber", text: "Früher ohne Begründung „nicht berechnet“ – das zählt nicht mehr. Bitte unten neu entscheiden." },
  LEGACY_MANUAL: { chip: "bitte prüfen", tone: "bg-amber-soft text-amber", text: "Mehrkilometer manuell erfasst – bitte die Position unten entfernen und hier entscheiden." },
  REGULAR: { chip: "regulär berechnet", tone: "bg-good-soft text-good", text: "Regulär berechnet laut Vertrag." },
  CUSTOM: { chip: "individuell", tone: "bg-info-soft text-info", text: "Individueller Betrag festgelegt." },
  WAIVED: { chip: "erlassen", tone: "bg-info-soft text-info", text: "aus Kulanz erlassen" },
  NONE: { chip: "keine Forderung", tone: "bg-panel-2 text-ink-2", text: "Keine Forderung: Die gefahrenen Kilometer liegen innerhalb der Inklusivkilometer." },
  // Preis je Mehrkilometer 0 € – keine Forderung, nichts zu entscheiden, kein Blocker
  ZERO_RATE: { chip: "keine Forderung", tone: "bg-panel-2 text-ink-2", text: "Keine Forderung: Preis je Mehrkilometer laut Vertrag 0,00 €. Es ist nichts zu entscheiden." },
  UNLIMITED: { chip: "keine Forderung", tone: "bg-panel-2 text-ink-2", text: "Keine Forderung: Unbegrenzte Kilometer vereinbart. Der Kilometerstand wird trotzdem dokumentiert." },
  NO_READING: { chip: "keine Forderung", tone: "bg-panel-2 text-ink-2", text: "Keine Forderung, solange der Rückgabe-Kilometerstand fehlt oder unter dem Übergabestand liegt (Schritt 2)." },
};
/** Manuelle Altposition, obwohl laut Vertrag keine Mehrkilometer-Forderung anfällt – nur entfernen, nichts zu entscheiden. */
const LEGACY_MANUAL_NO_CLAIM: StateInfo = { ...MILEAGE_STATE.LEGACY_MANUAL, text: "Mehrkilometer manuell erfasst, nach dem aktuellen Stand fällt aber keine Mehrkilometer-Forderung an – bitte die Position unten entfernen." };

/** Abgeschlossene Altprotokolle (vor der Mehrkilometer-Abrechnung): offene, „nicht berechnete“ oder manuelle Mehrkilometer neutral benennen. */
const SEALED_STATE: Partial<Record<MileageBillingState, StateInfo>> = {
  OPEN: { chip: "nicht berechnet", tone: "bg-panel-2 text-ink-2", text: "Nicht berechnet (abgeschlossen ohne Entscheidung)." },
  DISMISSED_LEGACY: { chip: "nicht berechnet", tone: "bg-panel-2 text-ink-2", text: "Nicht berechnet (ohne Begründung, vor Einführung der Mehrkilometer-Abrechnung)." },
  LEGACY_MANUAL: { chip: "manuell erfasst", tone: "bg-panel-2 text-ink-2", text: "Als manuelle Position erfasst." },
};
const stateInfo = (mileage: Pick<MileageBilling, "state" | "regularAmount">, sealed: boolean): StateInfo => {
  const s = sealed ? SEALED_STATE[mileage.state] : undefined;
  if (s) return s;
  return mileage.state === "LEGACY_MANUAL" && !(mileage.regularAmount > 0) ? LEGACY_MANUAL_NO_CLAIM : MILEAGE_STATE[mileage.state];
};

function MileageStateChip({ mileage, sealed = false }: { mileage: Pick<MileageBilling, "state" | "regularAmount">; sealed?: boolean }) {
  const s = stateInfo(mileage, sealed);
  return <span className={`chip ${s.tone}`}>{s.chip}</span>;
}

/**
 * Steuermodus der Entscheidungsbeträge aus dem gespeicherten Entscheidungsstand, nicht aus der heutigen Mandanteneinstellung.
 * Ältere Entscheidungen ohne gespeicherten Modus kennen nur „netto“ sicher (netPrices); sonst die heutige Einstellung, außer sie ist
 * „netto“ – dann war es bei der Entscheidung nicht netto, und die Kennzeichnung bleibt weg.
 */
function decisionTaxMode(d: NonNullable<MileageBilling["decision"]>, current: boolean | null): boolean | null {
  if (d.pricesIncludeTax !== undefined) return d.pricesIncludeTax;
  if (d.netPrices) return false;
  return current === false ? null : current;
}

/**
 * Zahlen der Abrechnung und, falls entschieden, Betrag, Begründung, Mitarbeiter und Zeitpunkt (intern, nie auf Kundendokumenten).
 * Mobil: Entscheidung, Begründung und Entscheider über die volle Breite und linksbündig, rechtsbündig erst ab sm;
 * jeder Wert darf schrumpfen (min-w-0) – kein waagrechtes Scrollen. Freitext (Entscheidung, Begründung, Entscheider) bricht auch
 * lange Wörter (overflow-wrap:anywhere); Zahlenwerte brechen nur zwischen Wörtern, damit „brutto“ nicht zerteilt wird.
 */
function MileageFacts({ mileage, taxMode, sealed = false }: { mileage: MileageBilling; taxMode: boolean | null; sealed?: boolean }) {
  const d = mileage.decision;
  // Beträge der Entscheidung nach deren Stand; abgeschlossen gilt dieser Stand für die ganze Karte, im Entwurf die aktuellen Werte
  // nach der Mandanteneinstellung (ohne Entscheidung immer die Einstellung)
  const decisionTax = d ? decisionTaxMode(d, taxMode) : taxMode;
  const factsTax = sealed && d ? decisionTax : taxMode;
  const moneyIn = (n: number, mode: boolean | null) => { const t = taxLabel(mode); return <>{eur(n)}{t && <span className="ml-1 whitespace-nowrap text-xs font-normal text-ink-3">{t}</span>}</>; };
  const money = (n: number) => moneyIn(n, factsTax);
  const agreed = (n: number) => moneyIn(n, decisionTax);
  const decisionText = mileage.state === "CUSTOM" && d ? <>individuell {agreed(d.agreedAmount)} (Kulanznachlass {agreed(d.deviation)})</> : stateInfo(mileage, sealed).text;
  const value = "min-w-0 font-mono tnum text-right";
  const wideTerm = "col-span-2 sm:col-span-1 text-ink-3";
  const wideValue = "col-span-2 sm:col-span-1 min-w-0 [overflow-wrap:anywhere] sm:text-right";
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      <dt className="text-ink-3">Tatsächlich gefahren</dt>
      <dd className={value}>{mileage.drivenKm != null ? kmText(mileage.drivenKm) : "–"}</dd>
      <dt className="text-ink-3">Inklusivkilometer laut Vertrag</dt>
      <dd className={value}>{mileage.includedKm == null ? "unbegrenzt" : <>{kmText(mileage.includedKm)}<span className="block text-xs text-ink-3">{mileage.rentalDays} {mileage.rentalDays === 1 ? "Tag" : "Tage"} × {kmText(mileage.kmIncludedPerDay)}</span></>}</dd>
      {mileage.includedKm != null && (
        <>
          <dt className="text-ink-3">Berechnete Mehrkilometer</dt>
          <dd className={value}>{kmText(mileage.extraKm)}</dd>
          <dt className="text-ink-3">Regulärer Mehrkilometerpreis</dt>
          <dd className={value}>{money(mileage.extraKmRate)} <span className="text-xs text-ink-3">je km</span></dd>
          <dt className="text-ink-3">Regulärer Gesamtbetrag</dt>
          <dd className={`${value} font-semibold`}>{money(mileage.regularAmount)}</dd>
        </>
      )}
      <dt className={`${wideTerm} border-t border-line-soft pt-1.5`}>Abrechnungsentscheidung</dt>
      <dd className={`${wideValue} sm:border-t sm:border-line-soft sm:pt-1.5 font-medium`}>{decisionText}</dd>
      {mileage.state === "REGULAR" && mileage.chargedAmount != null && (
        <>
          <dt className="text-ink-3">Berechnet</dt>
          <dd className={`${value} font-semibold`}>{money(mileage.chargedAmount)}</dd>
        </>
      )}
      {d && (
        <>
          <dt className="text-ink-3">{d.kind === "CUSTOM" ? "Individueller Betrag" : "Berechnet"}</dt>
          <dd className={`${value} font-semibold`}>{agreed(d.agreedAmount)}<span className="block text-xs font-normal text-ink-3">regulär bei Entscheidung {eur(d.regularAmount)}</span></dd>
          <dt className={wideTerm}>Begründung der Abweichung</dt>
          <dd className={wideValue}>{d.reason || "–"}</dd>
          <dt className={wideTerm}>Entschieden von</dt>
          <dd className={wideValue}>{d.decidedByName || "–"}{d.decidedAt ? `, ${fmtDateTime(d.decidedAt)}` : ""}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * Mehrkilometer-Abrechnung in Schritt 7: „Regulär berechnen“ für jede Rolle. „Individuellen Betrag festlegen“ und „Aus Kulanz
 * erlassen“ (Pflichtbegründung) erscheinen nur für Inhaber und Disposition (canDecide vom Server); die Server Action prüft die Rolle erneut.
 */
function MileageBillingCard({ mileage, canDecide, renterSigned, taxMode, issues, busy, start, actions }: { mileage: MileageBilling; canDecide: boolean; renterSigned: boolean; taxMode: boolean | null; issues: string[]; busy: boolean; start: TransitionStartFunction; actions: Pick<ChargeActions, "confirm" | "decideMileage" | "revokeMileage"> }) {
  const ids = useId();
  const [mode, setMode] = useState<MileageMode>("REGULAR");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [signatureLoss, setSignatureLoss] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Gesperrt wird über das gemeinsame busy des Zusatzkosten-Bereichs (kein Doppelklick, auch nicht über andere Knöpfe);
  // die Beschriftung „Wird gespeichert…/zurückgenommen…“ folgt nur der eigenen Aktion dieser Karte
  const [pending, setPending] = useState<"decide" | "revoke" | null>(null);
  const reset = () => { setMode("REGULAR"); setAmount(""); setReason(""); setSignatureLoss(false); };
  const submit = (kind: "decide" | "revoke", fn: () => Promise<Result>) => {
    setError(null);
    setPending(kind);
    start(async () => {
      try {
        const r = await fn();
        if (r?.error) setError(r.error);
        else reset();
      } finally {
        setPending(null);
      }
    });
  };

  const regularCents = Math.round(mileage.regularAmount * 100);
  const undecided = mileage.state === "OPEN" || mileage.state === "DISMISSED_LEGACY";
  const decided = mileage.state === "REGULAR" || mileage.state === "CUSTOM" || mileage.state === "WAIVED";
  // Abweichen nur bei einer echten Forderung (regulär > 0 €); regulär 0 € ist der Zustand ZERO_RATE ohne Formular (Absicherung)
  const canDeviate = canDecide && regularCents > 0;
  const deviating = mode !== "REGULAR";
  const reasonLength = reason.trim().length;
  const parsed = mode === "CUSTOM" ? parseEuroInput(amount) : null;
  const amountProblem = mode !== "CUSTOM" ? null : parsed == null ? "Bitte gültigen Betrag eingeben (z. B. 50,00)." : parsed === 0 ? "Für 0 € bitte „Aus Kulanz erlassen“ wählen." : parsed >= regularCents ? `Der Betrag muss unter dem regulären Betrag von ${eur(mileage.regularAmount)} liegen – sonst „Regulär berechnen“ wählen.` : null;
  const preview = mode === "CUSTOM" ? (parsed != null && !amountProblem ? `berechnet ${eur(parsed / 100)}, Kulanznachlass ${eur((regularCents - parsed) / 100)}` : amountProblem) : mode === "WAIVED" ? `berechnet ${eur(0)}, erlassen ${eur(mileage.regularAmount)}` : null;
  const submitBlocked = busy || (deviating && (reasonLength < 10 || reasonLength > 500 || !!amountProblem || (renterSigned && !signatureLoss)));
  const submitLabel = mode === "CUSTOM" ? "Betrag festlegen" : mode === "WAIVED" ? "Erlass speichern" : "Regulär berechnen";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitBlocked) return;
    if (mode === "REGULAR") submit("decide", () => actions.confirm("EXTRA_MILEAGE"));
    else submit("decide", () => actions.decideMileage({ mode, amount: mode === "CUSTOM" ? amount : undefined, reason: reason.trim(), seenRegularCents: regularCents, confirmSignatureLoss: renterSigned ? signatureLoss : undefined }));
  };
  const option = (value: MileageMode, label: string, sub: string) => (
    <label key={value} className="cursor-pointer">
      <input type="radio" name={`${ids}-mode`} value={value} checked={mode === value} onChange={() => { setMode(value); setError(null); }} className="peer sr-only" />
      <span className="flex min-h-[52px] flex-col justify-center rounded-md border border-line bg-panel px-3 py-2 text-sm peer-checked:border-brand peer-checked:bg-brand-soft peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-info">
        <span className="font-semibold">{label}</span>
        <span className="text-xs text-ink-3">{sub}</span>
      </span>
    </label>
  );
  const signatureConfirm = renterSigned && (
    <div className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm flex flex-col gap-2">
      <p>Der Mieter hat bereits unterschrieben. Die Änderung verwirft seine Unterschrift; er muss danach erneut unterschreiben.</p>
      <label className="flex items-start gap-2 text-ink cursor-pointer">
        <input type="checkbox" checked={signatureLoss} onChange={(e) => setSignatureLoss(e.target.checked)} disabled={busy} className="mt-0.5 h-5 w-5 shrink-0" />
        <span>Verstanden – die Unterschrift des Mieters wird verworfen.</span>
      </label>
    </div>
  );

  return (
    <section className="card" aria-labelledby={`${ids}-title`}>
      <div className="px-4 py-2.5 border-b border-line-soft flex flex-wrap items-center gap-2">
        <h3 id={`${ids}-title`} className="font-semibold text-sm">Mehrkilometer-Abrechnung</h3>
        <span className="flex-1" />
        <MileageStateChip mileage={mileage} />
      </div>
      <div className="p-4 flex flex-col gap-3">
        {/* veraltet/doppelt/manuell nur hier (Schritt 7 blendet diese Codes in der Fehlerliste aus) – alle, nicht nur die erste */}
        {issues.length > 0 && (
          <div role="alert" className="rounded-md bg-bad-soft text-bad px-3 py-2 text-sm flex flex-col gap-1">
            {issues.map((m) => <p key={m}>{m}</p>)}
          </div>
        )}
        {mileage.policy === "INDIVIDUAL" && <p className="text-sm text-ink-2"><span className="font-medium">Individuelle Kilometerregel laut Vertrag:</span> {mileage.policyNote || "ohne Beschreibung"} <span className="text-xs text-ink-3">(berechnet wird mit Freikilometern und Preis je km aus dem Vertrag)</span></p>}
        <MileageFacts mileage={mileage} taxMode={taxMode} />

        {undecided && (
          <form onSubmit={onSubmit} className="flex flex-col gap-3 border-t border-line-soft pt-3">
            <fieldset className="flex flex-col gap-2" disabled={busy}>
              <legend className="label-xs mb-1.5">Abrechnungsentscheidung</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {option("REGULAR", "Regulär berechnen", `${eur(mileage.regularAmount)} laut Vertrag`)}
                {canDeviate && option("CUSTOM", "Individuellen Betrag festlegen", "niedriger als regulär, mit Begründung")}
                {canDeviate && option("WAIVED", "Aus Kulanz erlassen", `${eur(0)}, mit Begründung`)}
              </div>
              {!canDecide && <p className="text-xs text-ink-3">Individueller Betrag oder Erlass nur durch Inhaber oder Disposition.</p>}
            </fieldset>

            {mode === "CUSTOM" && (
              <label className="flex flex-col gap-1">
                <span className="label-xs">Individueller Betrag in €{taxLabel(taxMode) ? ` (${taxLabel(taxMode)})` : ""}</span>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" disabled={busy} aria-describedby={`${ids}-preview`} aria-invalid={amount !== "" && !!amountProblem} className="input tnum !text-xl !font-semibold !min-h-[52px] max-w-[16rem]" placeholder="z. B. 50,00" />
              </label>
            )}
            {deviating && (
              <p id={`${ids}-preview`} aria-live="polite" className={`text-sm ${mode === "CUSTOM" && amountProblem ? (amount === "" ? "text-ink-3" : "text-bad") : "text-ink-2 font-medium"}`}>{preview}</p>
            )}
            {deviating && (
              // Aufbau wie Field (components/ui.tsx) – der Zähler steht außerhalb des <label>, sonst würde er Teil des
              // zugänglichen Namens der Textarea (bei jedem Tastendruck neu) und doppelt angesagt
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-reason`} className="label-xs">Begründung der Abweichung (Pflicht, intern)</label>
                <textarea id={`${ids}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} disabled={busy} aria-describedby={`${ids}-reason-hint`} className="input" placeholder="z. B. Stammkunde, Umweg wegen Vollsperrung nachgewiesen" />
                <span id={`${ids}-reason-hint`} className={`text-xs ${reasonLength > 0 && reasonLength < 10 ? "text-bad" : "text-ink-3"}`}>{reasonLength}/500 Zeichen, mindestens 10. Erscheint nicht auf Protokoll oder Rechnung des Kunden.</span>
              </div>
            )}
            {deviating && signatureConfirm}
            {!deviating && renterSigned && <p className="text-xs text-ink-3">Der Mieter hat bereits unterschrieben; nach der Entscheidung unterschreibt er erneut.</p>}
            <div>
              <button type="submit" disabled={submitBlocked} className="btn btn-primary w-full sm:w-auto !py-2.5">{pending === "decide" ? "Wird gespeichert…" : submitLabel}</button>
            </div>
          </form>
        )}

        {decided && canDecide && (
          <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
            {signatureConfirm}
            <div>
              <button type="button" disabled={busy || (renterSigned && !signatureLoss)} className="btn w-full sm:w-auto !py-2.5" onClick={() => submit("revoke", () => actions.revokeMileage({ confirmSignatureLoss: renterSigned ? signatureLoss : undefined }))}>{pending === "revoke" ? "Wird zurückgenommen…" : "Entscheidung zurücknehmen"}</button>
            </div>
          </div>
        )}
        {decided && !canDecide && mileage.state !== "REGULAR" && <p className="text-xs text-ink-3">Änderungen an einem individuellen Betrag oder Erlass nur durch Inhaber oder Disposition.</p>}
        {decided && renterSigned && <p className="text-xs text-ink-3">Ist der Mieter nicht mehr vor Ort, wird eine spätere Kulanz im Rechnungsentwurf (am PC) berücksichtigt – dort darf der Betrag nicht über der Entscheidung liegen.</p>}
        {error && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3 py-2 text-sm">{error}</p>}
      </div>
    </section>
  );
}

/**
 * Abgeschlossene Rückgabe: Mehrkilometer-Abrechnung schreibgeschützt für interne Rollen (Begründung, Mitarbeiter, Zeitpunkt; nicht
 * im PDF). taxMode ist die heutige Mandanteneinstellung – mit Entscheidung kennzeichnet die Karte nach deren gespeichertem Stand.
 */
export function MileageBillingSealed({ mileage, taxMode }: { mileage: MileageBilling; taxMode: boolean | null }) {
  return (
    <section className="card" aria-label="Mehrkilometer-Abrechnung">
      <div className="px-4 py-2.5 border-b border-line-soft flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-sm">Mehrkilometer-Abrechnung</h2>
        <span className="flex-1" />
        <MileageStateChip mileage={mileage} sealed />
        <span className="text-xs text-ink-3">intern, nicht auf Kundendokumenten</span>
      </div>
      <div className="p-4 flex flex-col gap-3">
        {mileage.policy === "INDIVIDUAL" && <p className="text-sm text-ink-2"><span className="font-medium">Individuelle Kilometerregel laut Vertrag:</span> {mileage.policyNote || "ohne Beschreibung"}</p>}
        <MileageFacts mileage={mileage} taxMode={taxMode} sealed />
      </div>
    </section>
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

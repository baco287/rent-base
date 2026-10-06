"use client";

// Befehl 29: Tarifeditor. Ein Tarif gilt für die angehakten Fahrzeuggruppen, jede mit eigenen Preisstufen (frei wählbare Dauern
// in ganzen Tagen). Kilometer und Kaution gelten für alle Gruppen, optional abweichend je Gruppe. Gespeichert wird als neue
// Revision; bestehende Buchungen und Verträge behalten ihren eingefrorenen Stand.

import { useActionState, useMemo, useState } from "react";
import { FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import type { TariffFormState } from "./actions";

type KmState = { policy: "FREE_KILOMETERS" | "UNLIMITED"; kmIncludedPerDay: string; extraKmRate: string };
type TierRow = { days: string; price: string; label: string };
type GroupState = { assigned: boolean; tiers: TierRow[]; deposit: string; kmOn: boolean; km: KmState; isDefault: boolean };
export type EditorGroup = { id: string; name: string; vehicles: number; defaultElsewhere: string | null };
export type EditorInitial = {
  name: string;
  code: string;
  description: string;
  sortOrder: string;
  km: KmState;
  deposit: string;
  groups: Record<string, { tiers: TierRow[]; deposit: string; km: KmState | null; isDefault: boolean }>;
};

const STANDARD_TIERS: TierRow[] = [{ days: "1", price: "", label: "" }, { days: "5", price: "", label: "" }, { days: "7", price: "", label: "" }, { days: "30", price: "", label: "" }];

function KmFields({ value, onChange, idPrefix, canEdit }: { value: KmState; onChange: (k: KmState) => void; idPrefix: string; canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm" role="radiogroup" aria-label="Kilometerregel">
        <label className="flex items-center gap-2"><input type="radio" checked={value.policy === "FREE_KILOMETERS"} onChange={() => onChange({ ...value, policy: "FREE_KILOMETERS" })} disabled={!canEdit} /> Freikilometer je Miettag</label>
        <label className="flex items-center gap-2"><input type="radio" checked={value.policy === "UNLIMITED"} onChange={() => onChange({ ...value, policy: "UNLIMITED" })} disabled={!canEdit} /> Unbegrenzte Kilometer</label>
      </div>
      {value.policy === "FREE_KILOMETERS" && (
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <label className="flex flex-col gap-1" htmlFor={`${idPrefix}-km`}><span className="label-xs">km je Miettag</span><input id={`${idPrefix}-km`} inputMode="numeric" value={value.kmIncludedPerDay} onChange={(e) => onChange({ ...value, kmIncludedPerDay: e.target.value })} disabled={!canEdit} className="input tnum" /></label>
          <label className="flex flex-col gap-1" htmlFor={`${idPrefix}-rate`}><span className="label-xs">Mehrkilometer €/km</span><input id={`${idPrefix}-rate`} inputMode="decimal" value={value.extraKmRate} onChange={(e) => onChange({ ...value, extraKmRate: e.target.value })} disabled={!canEdit} className="input tnum" placeholder="0,25" /></label>
        </div>
      )}
    </div>
  );
}

export function TariffEditor({ action, groups, initial, mode, createKey, expectedRevisionId, canEdit }: { action: (prev: TariffFormState, fd: FormData) => Promise<TariffFormState>; groups: EditorGroup[]; initial: EditorInitial; mode: "create" | "edit"; createKey?: string; expectedRevisionId?: string; canEdit: boolean }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [km, setKm] = useState<KmState>(initial.km);
  const [deposit, setDeposit] = useState(initial.deposit);
  const [gs, setGs] = useState<Record<string, GroupState>>(() =>
    Object.fromEntries(groups.map((g) => {
      const i = initial.groups[g.id];
      return [g.id, { assigned: !!i, tiers: i?.tiers.length ? i.tiers : STANDARD_TIERS.map((t) => ({ ...t })), deposit: i?.deposit ?? "", kmOn: !!i?.km, km: i?.km ?? { policy: "FREE_KILOMETERS", kmIncludedPerDay: "", extraKmRate: "" }, isDefault: i?.isDefault ?? false }];
    })),
  );
  const update = (id: string, f: (g: GroupState) => GroupState) => setGs((p) => ({ ...p, [id]: f(p[id]) }));

  const content = useMemo(() => JSON.stringify({
    km,
    deposit,
    groups: groups.filter((g) => gs[g.id].assigned).map((g) => ({ groupId: g.id, tiers: gs[g.id].tiers, deposit: gs[g.id].deposit, km: gs[g.id].kmOn ? gs[g.id].km : null })),
    defaults: groups.filter((g) => gs[g.id].assigned && gs[g.id].isDefault).map((g) => g.id),
  }), [km, deposit, gs, groups]);

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-4">
      <input type="hidden" name="content" value={content} />
      {createKey && <input type="hidden" name="createKey" value={createKey} />}
      {expectedRevisionId && <input type="hidden" name="expectedRevisionId" value={expectedRevisionId} />}

      <section className="rounded-lg border border-line p-4 flex flex-col gap-3" aria-label="Allgemein">
        <h2 className="font-semibold">Allgemein</h2>
        <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_100px] gap-3">
          <label className="flex flex-col gap-1"><span className="label-xs">Name</span><input name="name" defaultValue={initial.name} required maxLength={60} disabled={!canEdit} className="input" placeholder="z. B. PLUS, CITY 100, LANGZEIT" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Interner Code (optional)</span><input name="code" defaultValue={initial.code} maxLength={30} disabled={!canEdit} className="input" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Reihenfolge</span><input name="sortOrder" inputMode="numeric" defaultValue={initial.sortOrder} disabled={!canEdit} className="input tnum" /></label>
        </div>
        <label className="flex flex-col gap-1"><span className="label-xs">Beschreibung (optional, intern)</span><textarea name="description" defaultValue={initial.description} maxLength={500} rows={2} disabled={!canEdit} className="input" /></label>
        {mode === "create" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" value="1" defaultChecked disabled={!canEdit} /> Aktiv – wird für neue Buchungen angeboten</label>}
      </section>

      <section className="rounded-lg border border-line p-4 flex flex-col gap-3" aria-label="Kilometer und Kaution">
        <h2 className="font-semibold">Kilometer und Kaution</h2>
        <KmFields value={km} onChange={setKm} idPrefix="km" canEdit={canEdit} />
        <label className="flex flex-col gap-1 max-w-[200px]"><span className="label-xs">Kaution €</span><input inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} disabled={!canEdit} className="input tnum" placeholder="0,00" /></label>
        <p className="text-xs text-ink-3">Vorschlag für neue Buchungen. In einer Buchung kann mit Grund abgewichen werden (auch 0 €).</p>
      </section>

      <section className="rounded-lg border border-line p-4 flex flex-col gap-3" aria-label="Fahrzeuggruppen und Preisstufen">
        <h2 className="font-semibold">Fahrzeuggruppen und Preisstufen</h2>
        {groups.length === 0 && <p className="text-sm text-ink-3">Noch keine Fahrzeuggruppen angelegt. Tarife gelten je Fahrzeuggruppe.</p>}
        {groups.map((g) => {
          const st = gs[g.id];
          return (
            <div key={g.id} className={`rounded-md border p-3 flex flex-col gap-3 ${st.assigned ? "border-brand/50" : "border-line-soft"}`}>
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <input type="checkbox" checked={st.assigned} onChange={(e) => update(g.id, (x) => ({ ...x, assigned: e.target.checked, isDefault: e.target.checked ? x.isDefault : false }))} disabled={!canEdit} />
                <span className="font-semibold">{g.name}</span>
                <span className="text-xs text-ink-3">{g.vehicles} {g.vehicles === 1 ? "Fahrzeug" : "Fahrzeuge"}</span>
              </label>
              {st.assigned && (
                <>
                  <div className="flex flex-col gap-2">
                    <div className="hidden sm:grid grid-cols-[90px_140px_1fr_40px] gap-2 label-xs"><span>Dauer (Tage)</span><span>Preis € brutto</span><span>Bezeichnung (optional)</span><span /></div>
                    {st.tiers.map((t, i) => (
                      <div key={i} className="grid grid-cols-[80px_1fr_40px] sm:grid-cols-[90px_140px_1fr_40px] gap-2 items-center">
                        <input aria-label="Dauer in Tagen" inputMode="numeric" value={t.days} onChange={(e) => update(g.id, (x) => ({ ...x, tiers: x.tiers.map((r, j) => (j === i ? { ...r, days: e.target.value } : r)) }))} disabled={!canEdit} className="input tnum" />
                        <input aria-label="Preis in Euro" inputMode="decimal" value={t.price} onChange={(e) => update(g.id, (x) => ({ ...x, tiers: x.tiers.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)) }))} disabled={!canEdit} className="input tnum" placeholder="0,00" />
                        <input aria-label="Bezeichnung" value={t.label} onChange={(e) => update(g.id, (x) => ({ ...x, tiers: x.tiers.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)) }))} disabled={!canEdit} maxLength={40} className="input col-span-2 sm:col-span-1 order-last sm:order-none" placeholder={t.days === "1" ? "Tag" : t.days ? `${t.days} Tage` : ""} />
                        <button type="button" aria-label="Preisstufe entfernen" onClick={() => update(g.id, (x) => ({ ...x, tiers: x.tiers.filter((_, j) => j !== i) }))} disabled={!canEdit || st.tiers.length <= 1} className="btn !px-2 !py-1.5 justify-center">×</button>
                      </div>
                    ))}
                    <div><button type="button" onClick={() => update(g.id, (x) => ({ ...x, tiers: [...x.tiers, { days: "", price: "", label: "" }] }))} disabled={!canEdit} className="btn !py-1.5 text-sm">+ Preisstufe</button></div>
                    <p className="text-xs text-ink-3">Je Buchung wird die günstigste Kombination der Stufen berechnet (ein Block darf mehr Tage abdecken als gebucht).</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={st.isDefault} onChange={(e) => update(g.id, (x) => ({ ...x, isDefault: e.target.checked }))} disabled={!canEdit} /> Standardtarif dieser Gruppe (bei neuen Buchungen vorausgewählt){g.defaultElsewhere && !st.isDefault ? <span className="text-xs text-ink-3">· derzeit: {g.defaultElsewhere}</span> : null}</label>
                  <details className="text-sm" open={st.kmOn || !!st.deposit}>
                    <summary className="cursor-pointer text-ink-2">Abweichende Kaution oder Kilometer für diese Gruppe</summary>
                    <div className="flex flex-col gap-3 pt-2 pl-1">
                      <label className="flex flex-col gap-1 max-w-[200px]"><span className="label-xs">Kaution € (leer = wie Tarif)</span><input inputMode="decimal" value={st.deposit} onChange={(e) => update(g.id, (x) => ({ ...x, deposit: e.target.value }))} disabled={!canEdit} className="input tnum" /></label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={st.kmOn} onChange={(e) => update(g.id, (x) => ({ ...x, kmOn: e.target.checked }))} disabled={!canEdit} /> Abweichende Kilometerregel</label>
                      {st.kmOn && <KmFields value={st.km} onChange={(k) => update(g.id, (x) => ({ ...x, km: k }))} idPrefix={`g-${g.id}`} canEdit={canEdit} />}
                    </div>
                  </details>
                </>
              )}
            </div>
          );
        })}
      </section>

      {mode === "edit" && canEdit && (
        <label className="flex flex-col gap-1"><span className="label-xs">Änderungsnotiz (optional, intern)</span><input name="note" maxLength={300} className="input" placeholder="z. B. Preise Saison 2027" /></label>
      )}
      <FormError error={state?.error} />
      {state?.ok && <p role="status" className="rounded-md bg-good-soft text-good px-3 py-2 text-sm">{state.ok}</p>}
      {canEdit && (
        <div className="flex flex-col sm:flex-row gap-2">
          <button type="submit" disabled={pending} className="btn btn-primary justify-center">{pending ? "Wird gespeichert…" : mode === "create" ? "Tarif anlegen" : "Änderungen speichern"}</button>
        </div>
      )}
    </form>
  );
}

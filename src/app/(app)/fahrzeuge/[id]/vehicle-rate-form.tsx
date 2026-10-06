"use client";

// Befehl 29: Fahrzeugpreis je Tarif. Leer = Preis aus der Fahrzeuggruppe; nur abweichende Stufen werden gespeichert.
import { useActionState, useState } from "react";
import { FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { fmtCents } from "@/lib/money";
import type { TariffFormState } from "../../einstellungen/tarife/actions";

type Tier = { days: number; cents: number; label: string | null };
const euro = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
const label = (t: { days: number; label?: string | null }) => t.label || (t.days === 1 ? "Tag" : `${t.days} Tage`);

export function VehicleRateForm({
  action,
  groupTiers,
  override,
}: {
  action: (prev: TariffFormState, fd: FormData) => Promise<TariffFormState>;
  groupTiers: Tier[];
  override: { tiers: { days: number; cents: number | null }[]; depositCents: number | null; km: { policy: string; kmIncludedPerDay: number | null; extraKmRateCents: number | null } | null; note: string | null } | null;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const extraInit = (override?.tiers ?? []).filter((t) => !groupTiers.some((g) => g.days === t.days) && t.cents != null).map((t) => ({ days: String(t.days), price: euro(t.cents) }));
  const [extra, setExtra] = useState(extraInit);
  const [kmMode, setKmMode] = useState(override?.km?.policy ?? "");
  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-2">
        {groupTiers.map((t) => {
          const o = override?.tiers.find((x) => x.days === t.days);
          return (
            <div key={t.days} className="grid grid-cols-[1fr_120px] sm:grid-cols-[140px_110px_130px_1fr] gap-2 items-center">
              <span className="font-medium">{label(t)}</span>
              <span className="font-mono tnum text-ink-3 text-right sm:text-left">Gruppe {fmtCents(t.cents)}</span>
              <input name={`tier_${t.days}`} aria-label={`Fahrzeugpreis ${label(t)}`} inputMode="decimal" defaultValue={o?.cents != null ? euro(o.cents) : ""} placeholder="wie Gruppe" className="input tnum" />
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" name={`off_${t.days}`} value="1" defaultChecked={o != null && o.cents == null} /> für dieses Fahrzeug nicht anbieten</label>
            </div>
          );
        })}
        {extra.map((r, i) => (
          <div key={i} className="grid grid-cols-[90px_1fr_40px] sm:grid-cols-[140px_130px_40px] gap-2 items-center">
            <input aria-label="Dauer in Tagen" inputMode="numeric" value={r.days} onChange={(e) => setExtra((p) => p.map((x, j) => (j === i ? { ...x, days: e.target.value } : x)))} placeholder="Tage" className="input tnum" />
            <input aria-label="Preis" name={/^\d{1,4}$/.test(r.days) ? `tier_${r.days}` : undefined} inputMode="decimal" value={r.price} onChange={(e) => setExtra((p) => p.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} placeholder="0,00" className="input tnum" />
            <button type="button" aria-label="Stufe entfernen" onClick={() => setExtra((p) => p.filter((_, j) => j !== i))} className="btn !px-2 !py-1.5 justify-center">×</button>
          </div>
        ))}
        <div><button type="button" onClick={() => setExtra((p) => [...p, { days: "", price: "" }])} className="btn !py-1.5 text-xs">+ zusätzliche Stufe nur für dieses Fahrzeug</button></div>
      </div>
      <details open={override?.depositCents != null || !!override?.km}>
        <summary className="cursor-pointer text-ink-2">Abweichende Kaution oder Kilometer (optional)</summary>
        <div className="flex flex-col gap-2 pt-2">
          <label className="flex flex-col gap-1 max-w-[200px]"><span className="label-xs">Kaution € (leer = wie Tarif/Gruppe)</span><input name="deposit" inputMode="decimal" defaultValue={euro(override?.depositCents)} className="input tnum" /></label>
          <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Kilometer">
            <label className="flex items-center gap-2"><input type="radio" name="kmMode" value="" checked={kmMode === ""} onChange={() => setKmMode("")} /> wie Tarif</label>
            <label className="flex items-center gap-2"><input type="radio" name="kmMode" value="FREE_KILOMETERS" checked={kmMode === "FREE_KILOMETERS"} onChange={() => setKmMode("FREE_KILOMETERS")} /> Freikilometer</label>
            <label className="flex items-center gap-2"><input type="radio" name="kmMode" value="UNLIMITED" checked={kmMode === "UNLIMITED"} onChange={() => setKmMode("UNLIMITED")} /> Unbegrenzt</label>
          </div>
          {kmMode === "FREE_KILOMETERS" && (
            <div className="grid grid-cols-2 gap-2 max-w-md">
              <label className="flex flex-col gap-1"><span className="label-xs">km je Miettag</span><input name="kmIncludedPerDay" inputMode="numeric" defaultValue={override?.km?.kmIncludedPerDay ?? ""} required className="input tnum" /></label>
              <label className="flex flex-col gap-1"><span className="label-xs">Mehrkilometer €/km</span><input name="extraKmRate" inputMode="decimal" defaultValue={euro(override?.km?.extraKmRateCents)} required className="input tnum" /></label>
            </div>
          )}
        </div>
      </details>
      <label className="flex flex-col gap-1"><span className="label-xs">Notiz (optional)</span><input name="note" defaultValue={override?.note ?? ""} maxLength={300} className="input" /></label>
      <FormError error={state?.error} />
      {state?.ok && <p role="status" className="text-good text-sm">{state.ok}</p>}
      <div><button type="submit" disabled={pending} className="btn">{pending ? "Wird gespeichert…" : "Fahrzeugpreis speichern"}</button></div>
      <p className="text-xs text-ink-3">Alle Felder leer = Preis aus der Fahrzeuggruppe. Gilt für neue Buchungen; bestehende Buchungen und Verträge behalten ihren Stand.</p>
    </form>
  );
}

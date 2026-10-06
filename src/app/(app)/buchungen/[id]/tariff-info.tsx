// Befehl 29: interne Tarifinformation einer Buchung – Tarif und Revision, regulärer Tarifpreis, vereinbarter Preis mit Abweichung,
// Kilometer- und Kautionsvereinbarung jeweils mit Grund, wer und wann. Nur für die Mitarbeiter (nicht im Kundendokument).
import { fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { priceDeviation } from "@/lib/booking-price";
import { kmRuleText, tiersText, type TariffSnapshot } from "@/lib/tariffs";

const who = (x: { at: string; byName: string | null }) => `${x.byName ?? "–"}, ${fmtDateTime(new Date(x.at))}`;

export function TariffInfo({ snapshot, regularCents }: { snapshot: TariffSnapshot; regularCents: number }) {
  const a = snapshot.agreed;
  const dev = a.price ? priceDeviation(regularCents, a.price.cents) : null;
  return (
    <div className="px-4 pb-4 text-sm flex flex-col gap-1.5" aria-label="Miettarif">
      <div className="label-xs pt-2 border-t border-line-soft">Miettarif</div>
      <div className="flex flex-wrap justify-between gap-x-3"><span><b>{snapshot.ratePlanName}</b> <span className="text-ink-3">· Revision {snapshot.revision}{snapshot.vehicleTierDays.length ? " · Individueller Fahrzeugpreis" : " · Preis aus Fahrzeuggruppe"}</span></span></div>
      <div className="text-xs text-ink-3 break-words">{tiersText(snapshot.tiers)}</div>
      <div className="flex justify-between gap-3"><span>Regulärer Tarifpreis</span><span className="font-mono tnum">{fmtCents(regularCents)}</span></div>
      {a.price && dev && (
        <>
          <div className="flex justify-between gap-3 font-semibold"><span>Vereinbarter Mietpreis</span><span className="font-mono tnum">{fmtCents(a.price.cents)}</span></div>
          <div className="flex justify-between gap-3"><span>Abweichung</span><span className="font-mono tnum">{dev.cents >= 0 ? "+" : "−"}{fmtCents(Math.abs(dev.cents))}{dev.percent != null ? ` (${dev.percent >= 0 ? "+" : "−"}${Math.abs(dev.percent).toFixed(1).replace(".", ",")} %)` : ""}</span></div>
          <div className="text-xs text-ink-3">Grund: {a.price.reason} · {who(a.price)}</div>
        </>
      )}
      <div className="flex justify-between gap-3 pt-1"><span>Kilometer</span><span className="text-right">{a.km ? kmRuleText(a.km) : kmRuleText(snapshot.km)}</span></div>
      {a.km && <div className="text-xs text-ink-3">Tarif: {kmRuleText(snapshot.km)} · Grund: {a.km.reason} · {who(a.km)}</div>}
      <div className="flex justify-between gap-3"><span>Kaution</span><span className="font-mono tnum">{fmtCents(a.deposit ? a.deposit.cents : snapshot.deposit.cents)}</span></div>
      {a.deposit && <div className="text-xs text-ink-3">Tarif: {fmtCents(snapshot.deposit.cents)} · Grund: {a.deposit.reason} · {who(a.deposit)}</div>}
    </div>
  );
}

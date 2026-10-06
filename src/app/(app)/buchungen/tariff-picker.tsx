"use client";

// Befehl 29: Tarifauswahl der Buchung. Angebote kommen vom Server (dieselbe Engine wie beim Speichern), als Karten statt Tabelle
// (mobil lesbar). Darunter regulärer Tarifpreis, vereinbarter Mietpreis und Abweichung – kein „Rabatt“, weil der vereinbarte Preis
// auch höher sein kann. Abweichungen (Preis, Kilometer, Kaution) nur bewusst mit Grund; ein vereinbarter Sonderpreis wird bei einem
// Tarif- oder Fahrzeugwechsel nie still überschrieben.

import { useEffect, useRef, useState } from "react";
import { fmtCents, toCents } from "@/lib/money";
import type { TariffChoices } from "@/lib/tariffs";
import type { TariffOffer, TariffQuoteResult } from "./actions";

export type TariffTotals = { totalCents: number; depositCents: number; ready: boolean };

function cents(input: string): number | null {
  try {
    const c = toCents(input.trim());
    return c >= 0 ? c : null;
  } catch {
    return null;
  }
}
const euroText = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));

type Card = { value: string; title: string; badge?: string; price: number; priceText: string; kmText: string; includedKm: number | null; depositCents: number; note?: string; source?: string };

export function TariffPicker({
  quote,
  vehicleId,
  startAt,
  endAt,
  customerId,
  bookingId,
  bookingVehicleId,
  legacy,
  initial,
  onTotals,
}: {
  quote: (input: { vehicleId: string; startAt: string; endAt: string; customerId?: string | null; bookingId?: string | null }) => Promise<TariffQuoteResult>;
  vehicleId: string;
  startAt: string;
  endAt: string;
  customerId: string | null;
  bookingId?: string;
  /** Fahrzeug der bestehenden Buchung (eingefrorener Tarif nur bei gleichem Fahrzeug) */
  bookingVehicleId?: string;
  /** Buchung ohne Tarif (Altbestand): bisherige Preisvereinbarung als eigene Auswahl */
  legacy?: { totalCents: number; text: string; depositCents: number } | null;
  initial?: TariffChoices;
  onTotals: (t: TariffTotals) => void;
}) {
  // Ergebnis gehört zu genau einer Eingabe (key); passt es nicht zur aktuellen Eingabe, wird gerade neu gerechnet
  const key = JSON.stringify([vehicleId, startAt, endAt, customerId, bookingId ?? null]);
  const [data, setData] = useState<{ key: string; result: TariffQuoteResult } | null>(null);
  const [picked, setPicked] = useState<string>("");
  const seq = useRef(0);
  const prevAgreed = initial?.price.mode === "INDIVIDUAL";
  const [priceOn, setPriceOn] = useState(initial?.price.mode === "INDIVIDUAL");
  const [price, setPrice] = useState(initial?.price.mode === "INDIVIDUAL" ? euroText(initial.price.cents) : "");
  const [priceReason, setPriceReason] = useState(initial?.price.mode === "INDIVIDUAL" ? initial.price.reason : "");
  const [kmOn, setKmOn] = useState(initial?.km.mode === "INDIVIDUAL");
  const [kmPolicy, setKmPolicy] = useState<"FREE_KILOMETERS" | "UNLIMITED">(initial?.km.mode === "INDIVIDUAL" ? initial.km.policy : "FREE_KILOMETERS");
  const [kmPerDay, setKmPerDay] = useState(initial?.km.mode === "INDIVIDUAL" && initial.km.kmIncludedPerDay != null ? String(initial.km.kmIncludedPerDay) : "");
  const [kmRate, setKmRate] = useState(initial?.km.mode === "INDIVIDUAL" ? euroText(initial.km.extraKmRateCents) : "");
  const [kmReason, setKmReason] = useState(initial?.km.mode === "INDIVIDUAL" ? initial.km.reason : "");
  const [depOn, setDepOn] = useState(initial?.deposit.mode === "INDIVIDUAL");
  const [dep, setDep] = useState(initial?.deposit.mode === "INDIVIDUAL" ? euroText(initial.deposit.cents) : "");
  const [depReason, setDepReason] = useState(initial?.deposit.mode === "INDIVIDUAL" ? initial.deposit.reason : "");
  const [priceConfirm, setPriceConfirm] = useState<"" | "KEEP" | "TARIFF">("");

  const sameVehicle = !!bookingId && vehicleId === bookingVehicleId;

  // Vorschau neu rechnen, sobald Fahrzeug, Zeitraum oder Kunde (Rabatt) sich ändern (State nur im asynchronen Rückruf)
  useEffect(() => {
    if (!vehicleId) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      quote({ vehicleId, startAt, endAt, customerId, bookingId: bookingId ?? null }).then((r) => {
        if (n === seq.current) setData({ key, result: r });
      });
    }, 250);
    return () => clearTimeout(t);
  }, [quote, key, vehicleId, startAt, endAt, customerId, bookingId]);
  const result = vehicleId && data?.key === key ? data.result : null;
  const loading = !!vehicleId && data?.key !== key;

  const cards: Card[] = [];
  if (result) {
    if (result.current && sameVehicle)
      cards.push({ value: "KEEP", title: result.current.name, badge: "Tarif dieser Buchung", price: result.current.regularCents, priceText: result.current.priceText, kmText: result.current.kmText, includedKm: result.current.includedKm, depositCents: result.current.depositCents, note: result.current.stale ? `Eingefrorener Stand (Revision ${result.current.revision}); der Tarif wurde inzwischen geändert.` : `Eingefrorener Stand (Revision ${result.current.revision}).` });
    if (legacy && sameVehicle) cards.push({ value: "LEGACY", title: "Bisherige Preisvereinbarung", badge: "ohne Tarif", price: legacy.totalCents, priceText: legacy.text, kmText: "laut Buchung", includedKm: null, depositCents: legacy.depositCents, note: "Buchung vor Einführung der Miettarife – Preise bleiben unverändert." });
    for (const o of result.offers) cards.push({ value: o.ratePlanId, title: o.name, badge: o.isDefault ? "Standard" : undefined, price: o.regularCents, priceText: o.priceText, kmText: o.kmText, includedKm: o.includedKm, depositCents: o.depositCents, source: o.priceSource });
  }
  // gültige Auswahl: eigene Wahl, sonst eingefrorener Tarif der Buchung, sonst Standard (bzw. einziger Tarif)
  const selected = cards.some((c) => c.value === picked) ? picked : cards.find((c) => c.value === "KEEP" || c.value === "LEGACY")?.value ?? result?.defaultRatePlanId ?? "";
  const setSelected = setPicked;

  const card = cards.find((c) => c.value === selected) ?? null;
  const offer: TariffOffer | null = result?.offers.find((o) => o.ratePlanId === selected) ?? null;
  const regular = card?.price ?? 0;
  const agreed = priceOn ? cents(price) : null;
  const total = selected === "LEGACY" ? legacy?.totalCents ?? 0 : agreed ?? regular;
  const tariffDeposit = card && card.depositCents >= 0 ? card.depositCents : 0;
  const deposit = depOn ? cents(dep) ?? 0 : tariffDeposit;
  const changedAway = prevAgreed && selected !== "KEEP" && selected !== "";
  const ready = !!card && (!priceOn || agreed != null) && (!changedAway || !priceOn || priceConfirm === "KEEP");

  useEffect(() => {
    onTotals({ totalCents: total, depositCents: deposit, ready });
  }, [onTotals, total, deposit, ready]);

  const diff = agreed != null ? agreed - regular : 0;
  const pct = agreed != null && regular > 0 ? `${diff >= 0 ? "+" : "−"}${Math.abs((diff / regular) * 100).toFixed(1).replace(".", ",")} %` : null;
  const days = result?.offers[0]?.days ?? result?.current?.days ?? 0;

  return (
    <fieldset className="md:col-span-2 rounded-lg border border-line p-4 flex flex-col gap-3">
      <legend className="label-xs px-1">Miettarif</legend>
      <input type="hidden" name="ratePlanId" value={selected} />
      <input type="hidden" name="seenRevisionId" value={offer?.revisionId ?? ""} />
      <input type="hidden" name="seenRegularCents" value={offer ? String(offer.regularCents) : ""} />
      {!vehicleId && <p className="text-sm text-ink-3">Bitte zuerst ein Fahrzeug wählen – dann erscheinen die Tarife seiner Fahrzeuggruppe.</p>}
      {vehicleId && result?.problem && cards.length === 0 && <p role="alert" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">{result.problem} Tarife pflegt der Inhaber unter Einstellungen → Miettarife.</p>}
      {vehicleId && (loading || result) && (
        <p className="text-xs text-ink-3" aria-live="polite">{loading ? "Preise werden berechnet…" : days ? `${days} ${days === 1 ? "Miettag" : "Miettage"}${result?.discountPercent ? ` · inkl. Kundenrabatt ${result.discountPercent} %` : ""}` : ""}</p>
      )}
      {cards.length > 0 && (
        <div role="radiogroup" aria-label="Miettarif" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {cards.map((c) => (
            <label key={c.value} className={`rounded-lg border p-3 cursor-pointer flex flex-col gap-1 min-w-0 ${selected === c.value ? "border-brand ring-2 ring-brand/30 bg-panel" : "border-line bg-panel hover:border-ink-3"}`}>
              <input type="radio" name="tariffChoice" value={c.value} checked={selected === c.value} onChange={() => setSelected(c.value)} className="sr-only" />
              <span className="flex items-start justify-between gap-2">
                <span className="font-semibold break-words">{c.title}</span>
                {c.badge && <span className="chip bg-info-soft text-info shrink-0">{c.badge}</span>}
              </span>
              <span className="font-mono tnum text-xl font-semibold">{fmtCents(c.price)}</span>
              <span className="text-xs text-ink-3">{c.priceText}</span>
              <span className="text-xs">{c.kmText}{c.includedKm != null ? ` · ${c.includedKm.toLocaleString("de-DE")} km inklusive` : ""}</span>
              {c.depositCents >= 0 && <span className="text-xs">Kaution {fmtCents(c.depositCents)}</span>}
              {c.source && c.source !== "Preis aus Fahrzeuggruppe" && <span className="text-[11px] text-info">{c.source}</span>}
              {c.note && <span className="text-[11px] text-ink-3">{c.note}</span>}
            </label>
          ))}
        </div>
      )}

      {card && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm tnum">
          <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Regulärer Tarifpreis</div><div className="font-mono font-semibold">{fmtCents(regular)}</div></div>
          <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Vereinbarter Mietpreis</div><div className="font-mono font-semibold">{fmtCents(total)}</div></div>
          <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Abweichung</div><div className={`font-mono font-semibold ${diff !== 0 ? "text-info" : ""}`}>{agreed == null ? "–" : `${diff >= 0 ? "+" : "−"}${fmtCents(Math.abs(diff))}${pct ? ` (${pct})` : ""}`}</div></div>
        </div>
      )}

      {card && selected !== "LEGACY" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={priceOn} onChange={(e) => setPriceOn(e.target.checked)} /> Individuellen Mietpreis vereinbaren</label>
            <input type="hidden" name="priceMode" value={priceOn ? "INDIVIDUAL" : "TARIFF"} />
            {priceOn && (
              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3 pl-6">
                <label className="flex flex-col gap-1"><span className="label-xs">Vereinbarter Mietpreis €</span><input name="agreedPrice" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" required className="input tnum" /></label>
                <label className="flex flex-col gap-1"><span className="label-xs">Grund (Pflicht)</span><input name="priceReason" value={priceReason} onChange={(e) => setPriceReason(e.target.value)} minLength={3} maxLength={300} required placeholder="z. B. Stammkunde, Privatvermietung" className="input" /></label>
                <p className="text-xs text-ink-3 sm:col-span-2">Gilt nur für diese Buchung; der Tarif bleibt unverändert. 0,00 € ist zulässig.</p>
              </div>
            )}
            {priceOn && changedAway && (
              <div role="alert" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm flex flex-col gap-1.5 ml-6">
                <span>Für diese Buchung wurde ein individueller Preis vereinbart. Bitte bewusst entscheiden:</span>
                <label className="flex items-center gap-2"><input type="radio" name="priceConfirm" value="KEEP" checked={priceConfirm === "KEEP"} onChange={() => setPriceConfirm("KEEP")} /> Individuellen Preis beibehalten</label>
                <label className="flex items-center gap-2"><input type="radio" name="priceConfirm" value="TARIFF" checked={priceConfirm === "TARIFF"} onChange={() => { setPriceConfirm("TARIFF"); setPriceOn(false); }} /> Neuen Tarifpreis übernehmen</label>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={kmOn} onChange={(e) => setKmOn(e.target.checked)} /> Abweichende Kilometervereinbarung</label>
            <input type="hidden" name="kmMode" value={kmOn ? "INDIVIDUAL" : "TARIFF"} />
            {kmOn && (
              <div className="flex flex-col gap-3 pl-6">
                <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="Kilometerregel">
                  <label className="flex items-center gap-2"><input type="radio" name="kmPolicyOverride" value="FREE_KILOMETERS" checked={kmPolicy === "FREE_KILOMETERS"} onChange={() => setKmPolicy("FREE_KILOMETERS")} /> Freikilometer je Miettag</label>
                  <label className="flex items-center gap-2"><input type="radio" name="kmPolicyOverride" value="UNLIMITED" checked={kmPolicy === "UNLIMITED"} onChange={() => setKmPolicy("UNLIMITED")} /> Unbegrenzte Kilometer</label>
                </div>
                {kmPolicy === "FREE_KILOMETERS" && (
                  <div className="grid grid-cols-2 gap-3 sm:max-w-md">
                    <label className="flex flex-col gap-1"><span className="label-xs">Freikilometer je Tag</span><input name="kmIncludedOverride" inputMode="numeric" value={kmPerDay} onChange={(e) => setKmPerDay(e.target.value)} required className="input tnum" /></label>
                    <label className="flex flex-col gap-1"><span className="label-xs">Mehrkilometer €/km</span><input name="extraKmRateOverride" inputMode="decimal" value={kmRate} onChange={(e) => setKmRate(e.target.value)} required className="input tnum" /></label>
                  </div>
                )}
                <label className="flex flex-col gap-1"><span className="label-xs">Grund (Pflicht)</span><input name="kmReason" value={kmReason} onChange={(e) => setKmReason(e.target.value)} minLength={3} maxLength={300} required className="input" placeholder="z. B. Urlaubsfahrt vereinbart" /></label>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={depOn} onChange={(e) => setDepOn(e.target.checked)} /> Abweichende Kaution</label>
            <input type="hidden" name="depositMode" value={depOn ? "INDIVIDUAL" : "TARIFF"} />
            {depOn && (
              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3 pl-6">
                <label className="flex flex-col gap-1"><span className="label-xs">Vereinbarte Kaution €</span><input name="depositOverride" inputMode="decimal" value={dep} onChange={(e) => setDep(e.target.value)} placeholder="0,00" required className="input tnum" /></label>
                <label className="flex flex-col gap-1"><span className="label-xs">Grund (Pflicht)</span><input name="depositReason" value={depReason} onChange={(e) => setDepReason(e.target.value)} minLength={3} maxLength={300} required className="input" placeholder="z. B. Sondervereinbarung" /></label>
              </div>
            )}
          </div>
        </div>
      )}
    </fieldset>
  );
}

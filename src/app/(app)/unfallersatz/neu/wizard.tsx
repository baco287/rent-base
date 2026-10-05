"use client";

// Befehl 29 Phase C: Unfallersatz-Wizard. Ein einziges Formular mit sechs Schritten: nicht sichtbare Schritte bleiben im
// Formular (hidden), damit beim Vor- und Zurückspringen nichts verloren geht und am Ende alles in einer Anlage gesendet
// wird. Der Browser prüft je Schritt mit demselben Schema wie der Server (lib/accident-wizard); verbindlich prüft der Server.
// Bestehende Bausteine: CustomerPicker und CustomerFields (Kunde), Feld- und Fehlerkomponenten, Preislogik (rentalDays).

import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { FormError, Plate } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { CustomerFields, emptyCustomer } from "../../kunden/customer-fields";
import { CustomerPicker } from "../../buchungen/customer-picker";
import type { CustomerOption, VehicleOption } from "../../buchungen/booking-form";
import type { PartnerOption } from "@/lib/business-partners";
import { PartnerName, emptyPartner, type PartnerState } from "../partner-field";
import { ACCIDENT_WIZARD_STEPS, TARIFF_ROWS, moneyField, stepOfField, validateWizardStep, type WizardData, type WizardError } from "@/lib/accident-wizard";
import { accidentPricePreview, type AccidentPricePreview, type PreviewTariffItem } from "@/lib/accident-pricing";
import { ACCIDENT_DAMAGE_KINDS, ACCIDENT_LIABILITY_STATUS, ACCIDENT_TARIFF_KINDS, type AccidentTariffKind } from "@/lib/constants";
import { fmtCents } from "@/lib/money";
import { parseLocalDateTime } from "@/lib/time";
import type { AccidentWizardState, AvailabilityResult } from "./actions";

/** Eingegebener Betrag einheitlich formatiert („55“ → „55,00 €“); Ungültiges bleibt sichtbar, wie es eingegeben wurde. */
function eur(raw: string): string {
  const { cents } = moneyField(raw, "");
  return cents === null ? (raw.trim() ? `${raw.trim()} €` : fmtCents(0)) : fmtCents(cents);
}

type Partners = { insurers: PartnerOption[]; workshops: PartnerOption[]; lawyers: PartnerOption[] };
type TariffRowState = { on: boolean; amount: string; mode: "day" | "once"; label: string };

const fmtDT = (raw: string) => {
  const d = parseLocalDateTime(raw);
  return d ? d.toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
};
const fmtD = (raw: string) => (/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.split("-").reverse().join(".") : "–");

export function AccidentWizard({ action, availabilityAction, vehicles, partners, initialCustomer, initialVehicleId, defaultStartAt, nonce, pricesIncludeTax }: {
  action: (prev: AccidentWizardState, fd: FormData) => Promise<AccidentWizardState>;
  availabilityAction: (input: { startAt: string; endMode: string; plannedEndAt: string }) => Promise<AvailabilityResult>;
  vehicles: VehicleOption[];
  partners: Partners;
  initialCustomer: CustomerOption | null;
  initialVehicleId: string;
  defaultStartAt: string;
  nonce: string;
  pricesIncludeTax: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(1);
  const [reached, setReached] = useState(1);
  const [errors, setErrors] = useState<WizardError[]>([]);
  const [snap, setSnap] = useState<WizardData>({});

  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");
  const [customer, setCustomer] = useState<CustomerOption | null>(initialCustomer);
  const [liability, setLiability] = useState("UNKNOWN");
  const [insurer, setInsurer] = useState<PartnerState>(emptyPartner);
  const [workshop, setWorkshop] = useState<PartnerState>(emptyPartner);
  const [lawyer, setLawyer] = useState<PartnerState>(emptyPartner);
  const [showWorkshop, setShowWorkshop] = useState(false);
  const [showLawyer, setShowLawyer] = useState(false);

  const firstVehicle = vehicles.find((v) => v.id === initialVehicleId);
  const [vehicleId, setVehicleId] = useState(initialVehicleId);
  const [startAt, setStartAt] = useState(defaultStartAt);
  const [endMode, setEndMode] = useState<"open" | "known">("open");
  const [plannedEndAt, setPlannedEndAt] = useState("");
  const [vehicleFilter, setVehicleFilter] = useState("");
  // Ergebnis gehört zu genau einem Zeitraum (key); ältere Antworten blockieren oder zeigen nichts
  const [availability, setAvailability] = useState<AvailabilityResult & { loading?: boolean; key?: string }>({});

  const [dailyRate, setDailyRate] = useState(firstVehicle?.dailyRate ?? "");
  const [dailyTouched, setDailyTouched] = useState(false);
  // selbst geänderte Konditionen überschreibt ein späterer Fahrzeugwechsel nicht
  const [condTouched, setCondTouched] = useState({ deposit: false, km: false, extraKm: false });
  const [deposit, setDeposit] = useState(firstVehicle?.deposit ?? "0,00");
  const [km, setKm] = useState(firstVehicle?.kmIncludedPerDay ?? "200");
  const [extraKm, setExtraKm] = useState(firstVehicle?.extraKmRate ?? "0,25");
  const [tariff, setTariff] = useState<Record<AccidentTariffKind, TariffRowState>>(() => Object.fromEntries(TARIFF_ROWS.map((r) => [r.kind, { on: false, amount: "", mode: r.perDay ? "day" : "once", label: "" }])) as Record<AccidentTariffKind, TariffRowState>);

  // Server meldet einen Fehler: zum betroffenen Schritt springen, Eingaben bleiben stehen (Zustand beim Rendern angleichen)
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state?.error) {
      setErrors(state.errors?.length ? state.errors : [{ field: null, message: state.error }]);
      if (state.step) setStep(state.step);
    }
  }
  useEffect(() => {
    if (state?.error) topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [state]);

  // Verfügbarkeit der Flotte für den gewählten Zeitraum (verzögert, nur lesend; verbindlich prüft die Anlage)
  const availKey = `${startAt}|${endMode}|${endMode === "known" ? plannedEndAt : ""}`;
  useEffect(() => {
    if (step !== 4 && step !== 6) return;
    let cancelled = false;
    const key = `${startAt}|${endMode}|${endMode === "known" ? plannedEndAt : ""}`;
    const t = setTimeout(async () => {
      setAvailability((a) => ({ ...a, loading: true }));
      try {
        const res = await availabilityAction({ startAt, endMode, plannedEndAt });
        if (!cancelled) setAvailability({ ...res, loading: false, key });
      } catch {
        if (!cancelled) setAvailability({ error: "Die Verfügbarkeit konnte gerade nicht geprüft werden.", loading: false, key });
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [step, startAt, endMode, plannedEndAt, availabilityAction]);
  const avail: AvailabilityResult & { loading?: boolean } = availability.key === availKey ? availability : { loading: true };

  const read = (): WizardData => {
    const out: WizardData = {};
    if (!formRef.current) return out;
    for (const [k, v] of new FormData(formRef.current).entries()) if (typeof v === "string") out[k] = v;
    return out;
  };
  const errOf = (field: string) => errors.find((e) => e.field === field)?.message;
  const inv = (field: string) => (errOf(field) ? { "aria-invalid": true as const, "aria-describedby": `err-${field}` } : {});
  const invCls = (field: string) => (errOf(field) ? " !border-bad" : "");

  function go(target: number) {
    if (target === step) return;
    if (target > step) {
      for (let s = step; s < target; s++) {
        const errs = validateWizardStep(s, read());
        // Schritt 4: ein bekanntermaßen belegtes Fahrzeug gleich hier melden (verbindlich prüft trotzdem die Anlage)
        const known = s === 4 && vehicleId ? avail.vehicles?.[vehicleId] : undefined;
        if (known && !known.free) errs.push({ field: "vehicleId", message: known.text });
        if (errs.length) {
          setErrors(errs);
          setStep(s);
          requestAnimationFrame(() => {
            const el = errs[0].field ? (formRef.current?.querySelector(`[name="${errs[0].field}"]`) as HTMLElement | null) : null;
            if (el && el.offsetParent) el.focus(); else topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
          return;
        }
      }
    }
    setErrors([]);
    setSnap(read());
    setStep(target);
    setReached((r) => Math.max(r, target));
    requestAnimationFrame(() => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (step < 6) { e.preventDefault(); go(step + 1); return; }
    const all = validateWizardStep(6, read());
    if (all.length) { e.preventDefault(); setErrors(all); setStep(stepOfField(all[0].field)); return; }
    submitWithoutReset(formAction)(e);
  }

  function pickVehicle(v: VehicleOption) {
    setVehicleId(v.id);
    if (!dailyTouched) setDailyRate(v.dailyRate);
    if (!condTouched.deposit) setDeposit(v.deposit);
    if (!condTouched.km) setKm(v.kmIncludedPerDay);
    if (!condTouched.extraKm) setExtraKm(v.extraKmRate);
  }

  const vehicle = vehicles.find((v) => v.id === vehicleId) ?? null;
  const preview = useMemo<AccidentPricePreview | null>(() => {
    const start = parseLocalDateTime(startAt);
    const end = endMode === "known" ? parseLocalDateTime(plannedEndAt) : null;
    const daily = moneyField(dailyRate, "Tagessatz").cents;
    if (!start || daily == null || (endMode === "known" && (!end || !(end > start)))) return null;
    const items: PreviewTariffItem[] = TARIFF_ROWS.flatMap((r) => {
      const t = tariff[r.kind];
      const cents = t.on ? moneyField(t.amount, "Betrag").cents : null;
      return t.on && cents ? [{ label: r.kind === "OTHER" ? t.label || "Sonstige Position" : ACCIDENT_TARIFF_KINDS[r.kind], perDay: t.mode === "day", unitPriceCents: cents, quantityHundredths: 100 }] : [];
    });
    return accidentPricePreview({ startAt: start, endAt: end, dailyRateCents: daily, items });
  }, [startAt, endMode, plannedEndAt, dailyRate, tariff]);

  const filtered = vehicles.filter((v) => v.id === vehicleId || !vehicleFilter.trim() || `${v.plate} ${v.label} ${v.group}`.toLowerCase().includes(vehicleFilter.trim().toLowerCase()));
  const groups = Array.from(new Set(filtered.map((v) => v.group)));
  const stepErrors = errors.filter((e) => step === 6 || stepOfField(e.field) === step || e.field === null);

  return (
    // action = Server Action (POST) auch vor dem Laden des Skripts: nie ein klassisches GET mit Eingaben in der Adresszeile
    <form ref={formRef} action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-4 max-w-4xl" aria-label="Unfallersatz anlegen">
      <div ref={topRef} className="scroll-mt-20" />
      <input type="hidden" name="nonce" value={nonce} />
      <Progress current={step} reached={reached} onJump={go} />

      {stepErrors.length > 0 && (
        <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">
          {stepErrors.length === 1 ? stepErrors[0].message : (
            <ul className="list-disc pl-4 flex flex-col gap-0.5">{stepErrors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
          )}
        </div>
      )}

      {/* 1 Kunde */}
      <Step hidden={step !== 1} title="Kunde" hint="Mieter bzw. Geschädigter – vorhandenen Kunden suchen oder neu anlegen.">
        <div className="flex rounded-md border border-line overflow-hidden text-[13px] font-medium max-w-md" role="group" aria-label="Kunde">
          <button type="button" onClick={() => setCustomerMode("existing")} aria-pressed={customerMode === "existing"} className={`flex-1 px-3 py-2 ${customerMode === "existing" ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>Bestehender Kunde</button>
          <button type="button" onClick={() => setCustomerMode("new")} aria-pressed={customerMode === "new"} className={`flex-1 px-3 py-2 ${customerMode === "new" ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>Neuer Kunde</button>
        </div>
        <input type="hidden" name="customerMode" value={customerMode} />
        {/* beide Varianten bleiben eingebunden: ein Wechsel verwirft keine Eingaben (maßgeblich ist customerMode) */}
        <div hidden={customerMode !== "existing"} className="flex flex-col gap-1">
          <label htmlFor="customerId" className="label-xs">Kunde suchen</label>
          <CustomerPicker value={customer} onChange={setCustomer} />
          {errOf("customerId") && <span id="err-customerId" className="text-xs text-bad">{errOf("customerId")}</span>}
        </div>
        <div hidden={customerMode !== "new"} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 rounded-lg border border-line bg-bg/60 p-4">
          <CustomerFields values={emptyCustomer} prefix="c_" compact />
        </div>
      </Step>

      {/* 2 Schadenfall */}
      <Step hidden={step !== 2} title="Schadenfall" hint="Nur, was die Vermietung braucht. Keine medizinischen oder sonstigen Unfalldetails.">
        <Group title="Beschädigtes Fahrzeug">
          <Input name="damagedPlate" label="Kennzeichen" required inv={inv} invCls={invCls} err={errOf} className="uppercase font-mono" autoComplete="off" />
          <Input name="damagedMake" label="Hersteller" required inv={inv} invCls={invCls} err={errOf} placeholder="z. B. Opel" />
          <Input name="damagedModel" label="Modell" required inv={inv} invCls={invCls} err={errOf} placeholder="z. B. Astra" />
          <Choice name="damagedDrivable" label="Fahrbereit" options={[["1", "Ja"], ["0", "Nein"]]} inv={inv} err={errOf} />
          <Choice name="damageKind" label="Schadenart" options={Object.entries(ACCIDENT_DAMAGE_KINDS)} defaultValue="UNKNOWN" inv={inv} err={errOf} full />
          <Input name="damagedFirstRegistration" label="Erstzulassung (optional)" type="date" inv={inv} invCls={invCls} err={errOf} />
          <Input name="damagedVehicleClass" label="Fahrzeugklasse (optional)" inv={inv} invCls={invCls} err={errOf} placeholder="z. B. Kompaktklasse" />
          <Input name="damagedLocation" label="Standort (optional)" inv={inv} invCls={invCls} err={errOf} placeholder="z. B. Autohaus Müller, Bremen" full />
        </Group>
        <Group title="Unfall">
          <Input name="accidentDate" label="Unfalldatum" type="date" required inv={inv} invCls={invCls} err={errOf} />
          <Input name="accidentPlace" label="Unfallort (optional)" inv={inv} invCls={invCls} err={errOf} />
          <Input name="opponentPlate" label="Gegnerisches Kennzeichen (optional)" inv={inv} invCls={invCls} err={errOf} className="uppercase font-mono" autoComplete="off" />
          <Input name="opponentName" label="Name des Unfallgegners (optional)" inv={inv} invCls={invCls} err={errOf} />
          <Input name="policeFileNumber" label="Polizeiliches Aktenzeichen (optional)" inv={inv} invCls={invCls} err={errOf} />
          <div className="md:col-span-2 flex flex-col gap-1">
            <label htmlFor="accidentNote" className="label-xs">Interne Notiz (optional, nur intern)</label>
            <textarea id="accidentNote" name="accidentNote" rows={2} maxLength={2000} className={`input${invCls("accidentNote")}`} {...inv("accidentNote")} />
          </div>
        </Group>
      </Step>

      {/* 3 Versicherung, Werkstatt, Anwalt */}
      <Step hidden={step !== 3} title="Versicherung" hint="Gegnerische Haftpflichtversicherung. Die Schadennummer kann später ergänzt werden.">
        <Group title="Gegnerische Versicherung">
          <PartnerName kind="insurer" label="Versicherung" options={partners.insurers} value={insurer} onChange={setInsurer} required err={errOf} inv={inv} invCls={invCls} />
          <Input name="insurerClaimNumber" label="Schadennummer (optional)" inv={inv} invCls={invCls} err={errOf} className="font-mono" autoComplete="off" />
          <Controlled name="insurerContactName" label="Ansprechpartner (optional)" value={insurer.contactName} onChange={(v) => setInsurer({ ...insurer, contactName: v })} inv={inv} invCls={invCls} err={errOf} />
          <Controlled name="insurerPhone" label="Telefon (optional)" type="tel" value={insurer.phone} onChange={(v) => setInsurer({ ...insurer, phone: v })} inv={inv} invCls={invCls} err={errOf} />
          <Controlled name="insurerEmail" label="E-Mail (optional)" type="email" value={insurer.email} onChange={(v) => setInsurer({ ...insurer, email: v })} inv={inv} invCls={invCls} err={errOf} />
          <Controlled name="insurerStreet" label="Straße und Hausnummer (optional)" value={insurer.street} onChange={(v) => setInsurer({ ...insurer, street: v })} inv={inv} invCls={invCls} err={errOf} />
          <div className="grid grid-cols-[110px_1fr] gap-3 md:col-span-2">
            <Controlled name="insurerZip" label="PLZ" value={insurer.zip} onChange={(v) => setInsurer({ ...insurer, zip: v })} inv={inv} invCls={invCls} err={errOf} inputMode="numeric" />
            <Controlled name="insurerCity" label="Ort" value={insurer.city} onChange={(v) => setInsurer({ ...insurer, city: v })} inv={inv} invCls={invCls} err={errOf} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="liabilityStatus" className="label-xs">Haftungsstatus</label>
            <select id="liabilityStatus" name="liabilityStatus" value={liability} onChange={(e) => setLiability(e.target.value)} className="input">
              {Object.entries(ACCIDENT_LIABILITY_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span className="text-xs text-ink-3">Angabe laut Versicherung – Rent-Base bewertet die Haftung nicht.</span>
          </div>
          {liability === "QUOTA" ? (
            <Input name="liabilityQuotaPercent" label="Haftungsquote des Gegners in %" inputMode="numeric" required inv={inv} invCls={invCls} err={errOf} placeholder="z. B. 75" />
          ) : <div className="hidden md:block" />}
        </Group>

        <Optional title="Werkstatt (optional)" open={showWorkshop} onToggle={setShowWorkshop}>
          <PartnerName kind="workshop" label="Werkstatt / Firma" options={partners.workshops} value={workshop} onChange={setWorkshop} err={errOf} inv={inv} invCls={invCls} />
          <Controlled name="workshopContactName" label="Ansprechpartner" value={workshop.contactName} onChange={(v) => setWorkshop({ ...workshop, contactName: v })} inv={inv} invCls={invCls} err={errOf} />
          <Controlled name="workshopPhone" label="Telefon" type="tel" value={workshop.phone} onChange={(v) => setWorkshop({ ...workshop, phone: v })} inv={inv} invCls={invCls} err={errOf} />
          <Controlled name="workshopEmail" label="E-Mail" type="email" value={workshop.email} onChange={(v) => setWorkshop({ ...workshop, email: v })} inv={inv} invCls={invCls} err={errOf} />
          <Input name="repairStartAt" label="Geplanter Reparaturbeginn" type="date" inv={inv} invCls={invCls} err={errOf} />
          <Input name="repairEndAt" label="Voraussichtliches Reparaturende" type="date" inv={inv} invCls={invCls} err={errOf} />
        </Optional>
        <Optional title="Rechtsanwalt / Kanzlei (optional)" open={showLawyer} onToggle={setShowLawyer}>
          <PartnerName kind="lawyer" label="Kanzlei / Firma" options={partners.lawyers} value={lawyer} onChange={setLawyer} err={errOf} inv={inv} invCls={invCls} />
          <Controlled name="lawyerContactName" label="Ansprechpartner" value={lawyer.contactName} onChange={(v) => setLawyer({ ...lawyer, contactName: v })} inv={inv} invCls={invCls} err={errOf} />
          <Controlled name="lawyerPhone" label="Telefon" type="tel" value={lawyer.phone} onChange={(v) => setLawyer({ ...lawyer, phone: v })} inv={inv} invCls={invCls} err={errOf} />
          <Controlled name="lawyerEmail" label="E-Mail" type="email" value={lawyer.email} onChange={(v) => setLawyer({ ...lawyer, email: v })} inv={inv} invCls={invCls} err={errOf} />
        </Optional>
      </Step>

      {/* 4 Fahrzeug & Zeitraum */}
      <Step hidden={step !== 4} title="Fahrzeug & Zeitraum" hint="Ersatzfahrzeug aus der eigenen Flotte. Die Verfügbarkeit wird für den gewählten Zeitraum geprüft.">
        <Group title="Zeitraum">
          <Controlled name="startAt" label="Mietbeginn" type="datetime-local" value={startAt} onChange={setStartAt} inv={inv} invCls={invCls} err={errOf} required />
          <div className="flex flex-col gap-1">
            <span className="label-xs">Mietende</span>
            <div className="flex rounded-md border border-line overflow-hidden text-[13px] font-medium" role="radiogroup" aria-label="Mietende">
              {([["open", "Mietende offen"], ["known", "Datum bekannt"]] as const).map(([k, l]) => (
                <label key={k} className={`flex-1 px-3 py-2 text-center cursor-pointer ${endMode === k ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>
                  <input type="radio" name="endMode" value={k} checked={endMode === k} onChange={() => setEndMode(k)} className="sr-only" />{l}
                </label>
              ))}
            </div>
            <span className="text-xs text-ink-3">{endMode === "open" ? "Kein Rückgabedatum – das Fahrzeug bleibt bis zur Rückgabe belegt." : "Geplantes Ende, später in der Fallakte änderbar."}</span>
          </div>
          {endMode === "known" && <Controlled name="plannedEndAt" label="Geplantes Mietende" type="datetime-local" value={plannedEndAt} onChange={setPlannedEndAt} inv={inv} invCls={invCls} err={errOf} required min={startAt} />}
        </Group>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <span className="label-xs flex-1">Ersatzfahrzeug</span>
            {vehicles.length > 6 && <input type="search" value={vehicleFilter} onChange={(e) => setVehicleFilter(e.target.value)} placeholder="Kennzeichen oder Modell filtern" aria-label="Fahrzeuge filtern" className="input !py-1.5 w-full sm:w-64" />}
          </div>
          {avail.error && <p className="text-xs text-amber bg-amber-soft rounded-md px-3 py-2">{avail.error}</p>}
          {errOf("vehicleId") && <span id="err-vehicleId" className="text-xs text-bad">{errOf("vehicleId")}</span>}
          {vehicles.length === 0 ? <p className="text-sm text-ink-3">In der Flotte ist kein Fahrzeug angelegt.</p> : (
            <div className="flex flex-col gap-3 max-h-[440px] overflow-y-auto pr-1" role="radiogroup" aria-label="Ersatzfahrzeug">
              {groups.map((g) => (
                <div key={g} className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-ink-3">{g}</span>
                  {filtered.filter((v) => v.group === g).map((v) => {
                    const a = avail.vehicles?.[v.id];
                    const sel = v.id === vehicleId;
                    return (
                      <label key={v.id} className={`rounded-lg border px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 cursor-pointer ${sel ? "border-brand bg-brand-soft/50" : "border-line hover:bg-panel-2"}`}>
                        <input type="radio" name="vehicleId" value={v.id} checked={sel} onChange={() => pickVehicle(v)} className="size-4 shrink-0" {...inv("vehicleId")} />
                        <Plate>{v.plate}</Plate>
                        <span className="font-medium min-w-0 break-words">{v.label}</span>
                        <span className="text-xs text-ink-3 tnum">{v.dailyRate} €/Tag</span>
                        <span className="flex-1" />
                        {avail.loading && !a ? <span className="chip bg-panel-2 text-ink-3">prüfe…</span> : a ? <span className={`chip ${a.free ? "bg-good-soft text-good" : "bg-bad-soft text-bad"}`}>{a.free ? "frei" : "nicht verfügbar"}</span> : null}
                        {a && !a.free && <span className="basis-full text-xs text-bad">{a.text}</span>}
                      </label>
                    );
                  })}
                </div>
              ))}
              {filtered.length === 0 && <p className="text-sm text-ink-3">Kein Fahrzeug passt zum Filter.</p>}
            </div>
          )}
        </div>
      </Step>

      {/* 5 Tarif */}
      <Step hidden={step !== 5} title="Tarif" hint={`Abgerechnet wird je Miettag zum Tagessatz, ohne Kundenrabatt. Beträge ${pricesIncludeTax ? "brutto" : "netto (zzgl. USt.)"} wie auf der Rechnung.`}>
        <Group title="Grundmiete">
          <Controlled name="dailyRate" label="Tagessatz €" value={dailyRate} onChange={(v) => { setDailyRate(v); setDailyTouched(true); }} inputMode="decimal" inv={inv} invCls={invCls} err={errOf} required hint={vehicle ? `Vorschlag aus ${vehicle.plate}: ${vehicle.dailyRate} €` : undefined} />
          <div className="hidden md:block" />
        </Group>
        <div className="flex flex-col gap-2">
          <span className="label-xs">Weitere Positionen (nur angehakte werden gespeichert)</span>
          {TARIFF_ROWS.map((r) => {
            const t = tariff[r.kind];
            const set = (patch: Partial<TariffRowState>) => setTariff({ ...tariff, [r.kind]: { ...t, ...patch } });
            return (
              <div key={r.kind} className={`rounded-lg border px-3 py-2.5 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_120px_150px] gap-2 items-center ${t.on ? "border-brand/60" : "border-line"}`}>
                <label className="flex items-center gap-2 min-w-0">
                  <input type="checkbox" name={`t_${r.kind}_on`} value="1" checked={t.on} onChange={(e) => set({ on: e.target.checked })} className="size-4 shrink-0" />
                  {r.kind === "OTHER" ? (
                    <input name="t_OTHER_label" value={t.label} onChange={(e) => set({ label: e.target.value, on: e.target.value ? true : t.on })} placeholder="Sonstige Position (Bezeichnung)" aria-label="Bezeichnung der sonstigen Position" maxLength={200} className={`input !py-1.5 min-w-0 flex-1${invCls("t_OTHER_label")}`} {...inv("t_OTHER_label")} />
                  ) : <span className="font-medium">{ACCIDENT_TARIFF_KINDS[r.kind]}</span>}
                </label>
                <input name={`t_${r.kind}_amount`} value={t.amount} onChange={(e) => set({ amount: e.target.value, on: e.target.value ? true : t.on })} inputMode="decimal" placeholder="0,00 €" aria-label={`Betrag ${ACCIDENT_TARIFF_KINDS[r.kind]}`} className={`input !py-1.5 tnum${invCls(`t_${r.kind}_amount`)}`} {...inv(`t_${r.kind}_amount`)} />
                <select name={`t_${r.kind}_mode`} value={t.mode} onChange={(e) => set({ mode: e.target.value as "day" | "once" })} aria-label={`Abrechnung ${ACCIDENT_TARIFF_KINDS[r.kind]}`} className="input !py-1.5">
                  <option value="day">je Miettag</option>
                  <option value="once">einmalig</option>
                </select>
              </div>
            );
          })}
        </div>
        <Group title="Weitere Konditionen">
          <Controlled name="deposit" label="Kaution €" value={deposit} onChange={(v) => { setDeposit(v); setCondTouched((t) => ({ ...t, deposit: true })); }} inputMode="decimal" inv={inv} invCls={invCls} err={errOf} hint="0 = keine Kaution" />
          <Controlled name="kmIncludedPerDay" label="Freikilometer je Tag" value={km} onChange={(v) => { setKm(v); setCondTouched((t) => ({ ...t, km: true })); }} inputMode="numeric" inv={inv} invCls={invCls} err={errOf} hint={vehicle ? `Leer = laut Fahrzeug (${vehicle.kmIncludedPerDay || "0"} km)` : undefined} />
          <Controlled name="extraKmRate" label="Preis je Mehrkilometer €" value={extraKm} onChange={(v) => { setExtraKm(v); setCondTouched((t) => ({ ...t, extraKm: true })); }} inputMode="decimal" inv={inv} invCls={invCls} err={errOf} hint={vehicle ? `Leer = laut Fahrzeug (${eur(vehicle.extraKmRate || "0")})` : undefined} />
        </Group>
        <PricePreview preview={preview} />
      </Step>

      {/* 6 Prüfen */}
      <Step hidden={step !== 6} title="Prüfen" hint="Alles auf einen Blick. Über „Ändern“ geht es zurück zum Schritt – die Eingaben bleiben erhalten.">
        <div className="grid grid-cols-1 @3xl:grid-cols-2 gap-3">
          <Summary title="Kunde" onEdit={() => go(1)}>
            <Row label="Mieter / Geschädigter">{customerMode === "existing" ? customer?.label ?? "–" : `${snap.c_firstName ?? ""} ${snap.c_lastName ?? ""}`.trim() || "–"}{customerMode === "new" && <span className="chip bg-info-soft text-info ml-1.5">neu</span>}</Row>
          </Summary>
          <Summary title="Schadenfall" onEdit={() => go(2)}>
            <Row label="Beschädigtes Fahrzeug">{[snap.damagedPlate?.toUpperCase(), snap.damagedMake, snap.damagedModel].filter(Boolean).join(" · ") || "–"}</Row>
            <Row label="Schadenart">{ACCIDENT_DAMAGE_KINDS[(snap.damageKind ?? "UNKNOWN") as keyof typeof ACCIDENT_DAMAGE_KINDS]} · {snap.damagedDrivable === "1" ? "fahrbereit" : snap.damagedDrivable === "0" ? "nicht fahrbereit" : "–"}</Row>
            <Row label="Unfalldatum">{fmtD(snap.accidentDate ?? "")}</Row>
          </Summary>
          <Summary title="Versicherung" onEdit={() => go(3)}>
            <Row label="Versicherung">{insurer.name || "–"}{insurer.partnerId && <span className="chip bg-panel-2 text-ink-2 ml-1.5">Adressbuch</span>}</Row>
            <Row label="Schadennummer">{snap.insurerClaimNumber || <span className="text-ink-3">noch nicht bekannt</span>}</Row>
            <Row label="Haftung">{ACCIDENT_LIABILITY_STATUS[liability as keyof typeof ACCIDENT_LIABILITY_STATUS]}{liability === "QUOTA" && snap.liabilityQuotaPercent ? ` · Gegner ${snap.liabilityQuotaPercent} %` : ""}</Row>
            {workshop.name && <Row label="Werkstatt">{workshop.name}{snap.repairEndAt ? ` · Reparaturende ca. ${fmtD(snap.repairEndAt)}` : ""}</Row>}
            {lawyer.name && <Row label="Rechtsanwalt">{lawyer.name}</Row>}
          </Summary>
          <Summary title="Ersatzfahrzeug & Zeitraum" onEdit={() => go(4)}>
            <Row label="Ersatzfahrzeug">{vehicle ? <><Plate>{vehicle.plate}</Plate> <span className="break-words">{vehicle.label}</span></> : "–"}</Row>
            <Row label="Mietbeginn">{fmtDT(startAt)}</Row>
            <Row label="Mietende">{endMode === "open" ? <span className="chip bg-amber-soft text-amber">offen – bis zur Rückgabe</span> : fmtDT(plannedEndAt)}</Row>
            {vehicle && avail.vehicles?.[vehicle.id] && !avail.vehicles[vehicle.id].free && <Row label="Verfügbarkeit"><span className="text-bad">{avail.vehicles[vehicle.id].text}</span></Row>}
          </Summary>
          <Summary title="Tarif" onEdit={() => go(5)} wide>
            <Row label="Tagessatz">{dailyRate ? eur(dailyRate) : "–"}</Row>
            <Row label="Positionen">{TARIFF_ROWS.filter((r) => tariff[r.kind].on).map((r) => `${r.kind === "OTHER" ? tariff.OTHER.label || "Sonstige Position" : ACCIDENT_TARIFF_KINDS[r.kind]} ${eur(tariff[r.kind].amount)} ${tariff[r.kind].mode === "day" ? "je Tag" : "einmalig"}`).join(" · ") || "keine"}</Row>
            <Row label="Kaution · Kilometer">{moneyField(deposit, "").cents ? eur(deposit) : "keine Kaution"} · {km.trim() ? km : `${vehicle?.kmIncludedPerDay || "0"} (laut Fahrzeug)`} km/Tag frei · {extraKm.trim() ? eur(extraKm) : `${eur(vehicle?.extraKmRate || "0")} (laut Fahrzeug)`} je Mehrkilometer</Row>
          </Summary>
        </div>
        <PricePreview preview={preview} />
        <p className="text-xs text-ink-3">Mit der Anlage entstehen Buchung (Mietart Unfallersatz), Fallakte mit Fallnummer, Tarif und Mietvertragsentwurf in einem Vorgang. Danach geht es mit Mietvertrag und Übergabe auf der Buchung weiter.</p>
      </Step>

      <FormError error={undefined} />
      <div className="sticky bottom-0 z-10 card px-3 py-2.5 flex items-center gap-2 bg-panel/95 backdrop-blur">
        {step > 1 ? <button type="button" onClick={() => go(step - 1)} className="btn !py-2.5" disabled={pending}>Zurück</button> : <Link href="/buchungen" className="btn !py-2.5">Abbrechen</Link>}
        <span className="flex-1 text-xs text-ink-3 text-center hidden sm:block">Schritt {step} von {ACCIDENT_WIZARD_STEPS.length}</span>
        {step < 6 ? (
          <button type="submit" className="btn btn-primary !py-2.5 !px-5 ml-auto">Weiter</button>
        ) : (
          // auf schmalen Bildschirmen umbrechen statt die Seite zu verbreitern
          <button type="submit" disabled={pending} className="btn btn-primary !py-2.5 !px-4 ml-auto min-w-0 flex-1 sm:flex-none justify-center text-center !whitespace-normal leading-tight">{pending ? "Wird angelegt…" : "Unfallersatzfall anlegen & Übergabe vorbereiten"}</button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function Progress({ current, reached, onJump }: { current: number; reached: number; onJump: (n: number) => void }) {
  return (
    <nav aria-label="Fortschritt" className="card p-2.5 md:p-3">
      <ol className="flex flex-wrap gap-1.5">
        {ACCIDENT_WIZARD_STEPS.map((label, i) => {
          const n = i + 1;
          const st = n === current ? "current" : n <= reached ? "done" : "todo";
          const cls = st === "current" ? "bg-brand text-brand-ink border-brand" : st === "done" ? "bg-good-soft text-good border-transparent hover:underline" : "bg-panel-2 text-ink-3 border-transparent";
          return (
            <li key={label}>
              <button type="button" disabled={st === "todo"} onClick={() => onJump(n)} aria-current={st === "current" ? "step" : undefined} className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12.5px] font-medium ${cls} disabled:cursor-default`}>
                <span className="font-mono tnum text-[11px] opacity-80">{n}</span>
                <span className={`whitespace-nowrap ${st === "current" ? "" : "hidden xl:inline"}`}>{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Step({ hidden, title, hint, children }: { hidden: boolean; title: string; hint?: string; children: ReactNode }) {
  return (
    <section hidden={hidden} aria-label={title} className="@container card p-4 md:p-5 flex flex-col gap-4 min-w-0">
      <header className="flex flex-col gap-0.5">
        <h2 className="text-lg font-semibold">{title}</h2>
        {hint && <p className="text-sm text-ink-3">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2 min-w-0">
      <legend className="text-sm font-semibold mb-1">{title}</legend>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">{children}</div>
    </fieldset>
  );
}

function Optional({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: (v: boolean) => void; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line-soft bg-bg/40">
      <button type="button" onClick={() => onToggle(!open)} aria-expanded={open} className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-ink-2 font-medium text-left">
        <span aria-hidden className="font-mono w-3">{open ? "−" : "+"}</span>{title}
      </button>
      {/* Felder bleiben im Formular, auch wenn eingeklappt – so geht nichts verloren */}
      <div hidden={!open} className="px-3 pb-3 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">{children}</div>
    </div>
  );
}

type ErrProps = { inv: (f: string) => object; invCls: (f: string) => string; err: (f: string) => string | undefined };

function Input({ name, label, type = "text", required, full, className = "", inv, invCls, err, ...rest }: { name: string; label: string; type?: string; required?: boolean; full?: boolean; className?: string; placeholder?: string; inputMode?: "decimal" | "numeric"; autoComplete?: string } & ErrProps) {
  return (
    <div className={`flex flex-col gap-1 min-w-0 ${full ? "md:col-span-2" : ""}`}>
      <label htmlFor={name} className="label-xs">{label}{required && <span className="text-bad"> *</span>}</label>
      <input id={name} name={name} type={type} className={`input ${className}${invCls(name)}`} {...inv(name)} {...rest} />
      {err(name) && <span id={`err-${name}`} className="text-xs text-bad">{err(name)}</span>}
    </div>
  );
}

function Controlled({ name, label, value, onChange, type = "text", required, hint, min, inv, invCls, err, inputMode }: { name: string; label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean; hint?: string; min?: string; inputMode?: "decimal" | "numeric" } & ErrProps) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label htmlFor={name} className="label-xs">{label}{required && <span className="text-bad"> *</span>}</label>
      <input id={name} name={name} type={type} value={value} onChange={(e) => onChange(e.target.value)} min={min} inputMode={inputMode} className={`input tnum${invCls(name)}`} {...inv(name)} />
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
      {err(name) && <span id={`err-${name}`} className="text-xs text-bad">{err(name)}</span>}
    </div>
  );
}

function Choice({ name, label, options, defaultValue, full, inv, err }: { name: string; label: string; options: [string, string][]; defaultValue?: string; full?: boolean; inv: (f: string) => object; err: (f: string) => string | undefined }) {
  return (
    <fieldset className={`flex flex-col gap-1 min-w-0 ${full ? "md:col-span-2" : ""}`} {...inv(name)}>
      <legend className="label-xs mb-1">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([v, l]) => (
          <label key={v} className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm cursor-pointer has-[:checked]:border-brand has-[:checked]:bg-brand-soft/50">
            <input type="radio" name={name} value={v} defaultChecked={v === defaultValue} className="size-4" />{l}
          </label>
        ))}
      </div>
      {err(name) && <span id={`err-${name}`} className="text-xs text-bad">{err(name)}</span>}
    </fieldset>
  );
}

function Summary({ title, onEdit, wide, children }: { title: string; onEdit: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`rounded-lg border border-line p-3 flex flex-col gap-1.5 min-w-0 ${wide ? "@3xl:col-span-2" : ""}`}>
      <div className="flex items-center gap-2"><h3 className="font-semibold text-sm flex-1">{title}</h3><button type="button" onClick={onEdit} className="btn !py-1 !px-2.5 text-xs">Ändern</button></div>
      <dl className="grid grid-cols-[120px_minmax(0,1fr)] sm:grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">{children}</dl>
    </section>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="text-ink-3">{label}</dt><dd className="min-w-0 break-words">{children}</dd></>;
}

/** Preisvorschau: bekanntes Ende = voraussichtlicher Gesamtbetrag; offenes Ende = laufende Tageskosten, kein erfundener Gesamtbetrag. */
function PricePreview({ preview }: { preview: AccidentPricePreview | null }) {
  return (
    <section aria-label="Preisvorschau" className="rounded-lg bg-panel-2 p-3.5 flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2"><h3 className="font-semibold flex-1">Preisvorschau</h3><span className="chip bg-panel text-ink-2">Vorschau</span></div>
      {!preview ? <p className="text-ink-3">Für die Vorschau bitte Mietbeginn, Mietende bzw. „offen“ und den Tagessatz angeben.</p> : preview.kind === "KNOWN_END" ? (
        <>
          <ul className="flex flex-col gap-1 tnum">
            {preview.lines.map((l, i) => <li key={i} className="flex justify-between gap-3"><span className="min-w-0 break-words">{l.label} <span className="text-ink-3">· {l.detail}</span></span><span className="font-mono shrink-0">{fmtCents(l.cents)}</span></li>)}
          </ul>
          <div className="flex justify-between gap-3 pt-2 border-t border-line font-semibold tnum"><span>Voraussichtlich ({preview.days} {preview.days === 1 ? "Miettag" : "Miettage"})</span><span className="font-mono">{fmtCents(preview.totalCents)}</span></div>
        </>
      ) : (
        <>
          <p className="flex items-center gap-2"><span className="chip bg-amber-soft text-amber">Mietende offen</span><span className="text-ink-3">Kein Gesamtbetrag – abgerechnet wird nach tatsächlicher Mietdauer.</span></p>
          <ul className="flex flex-col gap-1 tnum">
            {preview.perDayLines.map((l, i) => <li key={`d${i}`} className="flex justify-between gap-3"><span className="min-w-0 break-words">{l.label} <span className="text-ink-3">· {l.detail}</span></span><span className="font-mono shrink-0">{fmtCents(l.cents)}</span></li>)}
            <li className="flex justify-between gap-3 font-semibold pt-1 border-t border-line"><span>Laufende Kosten je Miettag</span><span className="font-mono">{fmtCents(preview.perDayCents)}</span></li>
            {preview.oneOffLines.map((l, i) => <li key={`o${i}`} className="flex justify-between gap-3"><span className="min-w-0 break-words">{l.label} <span className="text-ink-3">· {l.detail}</span></span><span className="font-mono shrink-0">{fmtCents(l.cents)}</span></li>)}
          </ul>
          {preview.elapsed && <p className="tnum">Aktueller Zwischenstand seit Mietbeginn: <b>{preview.elapsed.days} {preview.elapsed.days === 1 ? "Miettag" : "Miettage"} = {fmtCents(preview.elapsed.cents)}</b> <span className="text-ink-3">(Stand jetzt)</span></p>}
        </>
      )}
      <p className="text-xs text-ink-3">Vorschau zur Orientierung. Maßgeblich ist die Abrechnung nach tatsächlicher Mietdauer. Keine Aussage zur Erstattungsfähigkeit durch die Versicherung.</p>
    </section>
  );
}

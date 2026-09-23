"use client";

// Formulare der Geschäftsregeln: ein Formular je Bereich, nicht ein riesiges. Beträge sind Richtwerte oder Vertragsvorgaben,
// nie automatische Belastungen. Dieselbe Komponente dient auch den Abweichungen an Gruppe und Fahrzeug (mode "override").

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { ADDITIONAL_DRIVER_FEE_TYPES, COUNTRIES, FUEL_POLICIES, KM_POLICIES, LATE_RETURN_RULES, OUT_OF_HOURS_RETURN, PETS_POLICIES } from "@/lib/constants";
import type { BusinessRules } from "@/lib/business-rules";

export type RulesState = { error?: string; ok?: string } | undefined;
type Action = (prev: RulesState, fd: FormData) => Promise<RulesState>;
const eur = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));

function useRules(action: Action) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: RulesState, fd: FormData) => { const r = await action(prev, fd); if (r?.ok) router.refresh(); return r; }, undefined);
  return { state, formAction, pending };
}
function Feedback({ state }: { state: RulesState }) {
  if (!state) return null;
  return (<>{state.error && <FormError error={state.error} />}{state.ok && <p role="status" className="md:col-span-2 text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>}</>);
}
function Submit({ pending, label = "Speichern" }: { pending: boolean; label?: string }) {
  return <div className="md:col-span-2"><button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : label}</button></div>;
}
const Toggle = ({ name, label, checked, hint }: { name: string; label: string; checked: boolean; hint?: string }) => (
  <label className="flex items-start gap-2 text-sm py-1"><input type="checkbox" name={name} value="1" defaultChecked={checked} className="mt-1" /><span>{label}{hint && <span className="block text-xs text-ink-3">{hint}</span>}</span></label>
);

/** Ein Bereich der Mandantenregeln. `v` sind die aufgelösten Werte, `section` der Schlüssel der Aktion. */
export function RulesSectionForm({ action, section, v }: { action: Action; section: string; v: BusinessRules }) {
  const { state, formAction, pending } = useRules(action);
  const [feeType, setFeeType] = useState(v.additionalDriverFeeType);
  const [fuelRule, setFuelRule] = useState(v.fuelRule);
  const [abroad, setAbroad] = useState(v.abroadAllowed);
  const [late, setLate] = useState(v.lateReturnRule);
  const [authFee, setAuthFee] = useState(v.authorityHandlingFeeEnabled);
  const cls = "grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 p-5";
  switch (section) {
    case "fahrer": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <Field label="Mindestalter Fahrer (Jahre)" htmlFor="minimumDriverAge" hint="Kalendergenau am Mietbeginn geprüft, für alle Vertragsfahrer. Standard 18."><input id="minimumDriverAge" name="minimumDriverAge" type="number" min={16} max={99} defaultValue={v.minimumDriverAge} className="input tnum" /></Field>
        <Field label="Mindestdauer Führerscheinbesitz (Monate)" htmlFor="minimumLicenseHoldingMonths" hint="0 = keine Mindestdauer (aktuelle Geschäftsentscheidung). Eine gültige Fahrerlaubnis ist immer erforderlich."><input id="minimumLicenseHoldingMonths" name="minimumLicenseHoldingMonths" type="number" min={0} max={600} defaultValue={v.minimumLicenseHoldingMonths} className="input tnum" /></Field>
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "zusatzfahrer": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <div className="md:col-span-2"><Toggle name="additionalDriversAllowed" label="Zusatzfahrer erlaubt" checked={v.additionalDriversAllowed} /></div>
        <Field label="Preisregel" htmlFor="additionalDriverFeeType"><select id="additionalDriverFeeType" name="additionalDriverFeeType" value={feeType} onChange={(e) => setFeeType(e.target.value as BusinessRules["additionalDriverFeeType"])} className="input">{Object.entries(ADDITIONAL_DRIVER_FEE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {feeType !== "FREE" && <Field label="Preis in €" htmlFor="additionalDriverFeeCents" hint="Erscheint im Vertrag als eigene Position, nie im Basispreis."><input id="additionalDriverFeeCents" name="additionalDriverFeeCents" inputMode="decimal" defaultValue={eur(v.additionalDriverFeeCents)} className="input tnum" /></Field>}
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "kaution": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <Field label="Kaution Standard in € (optional)" htmlFor="depositCents" hint="Vorgabe für neue Buchungen und Verträge, wenn Fahrzeug und Fahrzeuggruppe keine eigene Kaution (über 0) tragen. Reihenfolge: Fahrzeug → Gruppe → dieser Standard. Es entsteht nie eine Kautionsbewegung."><input id="depositCents" name="depositCents" inputMode="decimal" defaultValue={eur(v.depositCents)} className="input tnum" /></Field>
        <Field label="Selbstbeteiligung in € (optional)" htmlFor="deductibleCents" hint="Vertragswert. Erzeugt bei einem Schaden nie automatisch eine Forderung; die Schadenakte entscheidet."><input id="deductibleCents" name="deductibleCents" inputMode="decimal" defaultValue={eur(v.deductibleCents)} className="input tnum" /></Field>
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "kilometer": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <Field label="Kilometerregel" htmlFor="kmPolicy" hint="Freikilometer je Tag und Mehrkilometerpreis stehen wie bisher an Fahrzeuggruppe und Fahrzeug."><select id="kmPolicy" name="kmPolicy" defaultValue={v.kmPolicy} className="input">{Object.entries(KM_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "tanken": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <Field label="Tank-/Laderegel" htmlFor="fuelRule" hint="Verbrenner rechnen in Achteln, Elektro in Prozent, Plug-in-Hybride in beidem (bestehende Energielogik)."><select id="fuelRule" name="fuelRule" value={fuelRule} onChange={(e) => setFuelRule(e.target.value as BusinessRules["fuelRule"])} className="input">{Object.entries(FUEL_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {fuelRule === "MINIMUM_LEVEL" && <Field label="Mindestfüllstand Tank (Achtel 0–8)" htmlFor="fuelMinimumEighths"><input id="fuelMinimumEighths" name="fuelMinimumEighths" type="number" min={0} max={8} defaultValue={v.fuelMinimumEighths ?? ""} className="input tnum" /></Field>}
        {fuelRule === "MINIMUM_LEVEL" && <Field label="Mindestladestand Batterie (%)" htmlFor="batteryMinimumPercent"><input id="batteryMinimumPercent" name="batteryMinimumPercent" type="number" min={0} max={100} defaultValue={v.batteryMinimumPercent ?? ""} className="input tnum" /></Field>}
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "ausland": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <div className="md:col-span-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="abroadAllowed" value="1" checked={abroad} onChange={(e) => setAbroad(e.target.checked)} /> Auslandsfahrten erlaubt</label></div>
        {abroad && (
          <div className="md:col-span-2 flex flex-col gap-1">
            <span className="label-xs">Freigabeliste (erlaubte Länder)</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{Object.entries(COUNTRIES).filter(([k]) => k !== "OTHER").map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name="abroadCountries" value={k} defaultChecked={v.abroadCountries.includes(k)} /> {l}</label>)}</div>
            <span className="text-xs text-ink-3">Im Vertrag werden die konkret genehmigten Länder eingefroren – nur aus dieser Liste.</span>
          </div>
        )}
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "rauchen": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <div><Toggle name="smokingAllowed" label="Rauchen im Fahrzeug erlaubt" checked={v.smokingAllowed} /></div>
        <Field label="Tiere" htmlFor="petsPolicy"><select id="petsPolicy" name="petsPolicy" defaultValue={v.petsPolicy} className="input">{Object.entries(PETS_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "rueckgabe": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <Field label="Verspätete Rückgabe" htmlFor="lateReturnRule" hint="Rent-Base dokumentiert vereinbarte und tatsächliche Rückgabe. Eine Belastung entsteht nie allein aus der Zeitdifferenz, sondern nur über den bestätigten Zusatzkostenprozess."><select id="lateReturnRule" name="lateReturnRule" value={late} onChange={(e) => setLate(e.target.value as BusinessRules["lateReturnRule"])} className="input">{Object.entries(LATE_RETURN_RULES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {late === "CONFIGURED_FEE" && <Field label="Richtwert in €" htmlFor="lateReturnFeeCents" hint="Vorschlag für den Mitarbeiter, keine automatische Berechnung."><input id="lateReturnFeeCents" name="lateReturnFeeCents" inputMode="decimal" defaultValue={eur(v.lateReturnFeeCents)} className="input tnum" /></Field>}
        <Field label="Rückgabe außerhalb der Öffnungszeiten" htmlFor="outOfHoursReturn"><select id="outOfHoursReturn" name="outOfHoursReturn" defaultValue={v.outOfHoursReturn} className="input">{Object.entries(OUT_OF_HOURS_RETURN).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Anweisung (optional)" htmlFor="outOfHoursInstructions" full><input id="outOfHoursInstructions" name="outOfHoursInstructions" defaultValue={v.outOfHoursInstructions ?? ""} maxLength={500} className="input" placeholder="z. B. Schlüssel in den Briefkasten am Haupteingang" /></Field>
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "reinigung": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <p className="md:col-span-2 text-xs text-ink-3">Richtwerte. Bei der Rückgabe dokumentiert der Mitarbeiter den Sachverhalt, Rent-Base schlägt den Richtwert vor, der Mitarbeiter bestätigt oder ändert – über den bestehenden Zusatzkostenprozess. Keine automatische Belastung.</p>
        <Field label="Außergewöhnliche Verschmutzung in €" htmlFor="cleaningHeavySoilingCents"><input id="cleaningHeavySoilingCents" name="cleaningHeavySoilingCents" inputMode="decimal" defaultValue={eur(v.cleaningHeavySoilingCents)} className="input tnum" /></Field>
        <Field label="Rauchen in €" htmlFor="cleaningSmokingCents"><input id="cleaningSmokingCents" name="cleaningSmokingCents" inputMode="decimal" defaultValue={eur(v.cleaningSmokingCents)} className="input tnum" /></Field>
        <Field label="Tierhaare in €" htmlFor="cleaningPetHairCents"><input id="cleaningPetHairCents" name="cleaningPetHairCents" inputMode="decimal" defaultValue={eur(v.cleaningPetHairCents)} className="input tnum" /></Field>
        <Field label="Sonstige Sonderreinigung in €" htmlFor="cleaningSpecialCents"><input id="cleaningSpecialCents" name="cleaningSpecialCents" inputMode="decimal" defaultValue={eur(v.cleaningSpecialCents)} className="input tnum" /></Field>
        <Field label="Hinweis Schlüssel und Zubehör (optional)" htmlFor="keysAccessoriesNote" full hint="Fehlende Schlüssel oder Zubehör werden in der Checkliste dokumentiert; keine automatische Forderung."><input id="keysAccessoriesNote" name="keysAccessoriesNote" defaultValue={v.keysAccessoriesNote ?? ""} maxLength={500} className="input" /></Field>
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "behoerden": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <p className="md:col-span-2 text-xs text-ink-3">Vorbereitet, standardmäßig deaktiviert. Auch wenn aktiviert: Ein Behördenvorgang verändert nie Rechnung, Zahlung oder Kaution. Eine Weiterbelastung wäre ein späterer, bewusster Zusatzkosten-Schritt.</p>
        <div className="md:col-span-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="authorityHandlingFeeEnabled" value="1" checked={authFee} onChange={(e) => setAuthFee(e.target.checked)} /> Bearbeitungsentgelt für Behördenanfragen als Vertragswert führen</label></div>
        {authFee && <Field label="Bearbeitungsentgelt in €" htmlFor="authorityHandlingFeeCents"><input id="authorityHandlingFeeCents" name="authorityHandlingFeeCents" inputMode="decimal" defaultValue={eur(v.authorityHandlingFeeCents)} className="input tnum" /></Field>}
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    case "nutzung": return (
      <form onSubmit={submitWithoutReset(formAction)} className={cls}>
        <p className="md:col-span-2 text-xs text-ink-3">Nicht eingetragene Fahrer, Fahren ohne Fahrerlaubnis, Alkohol/Drogen, Rennen und rechtswidrige Nutzung sind nie gestattet; die Formulierung dazu gehört in den Text der Mietbedingungen. Hier nur die konfigurierbaren Sondernutzungen.</p>
        <div><Toggle name="trailerAllowed" label="Anhängerbetrieb erlaubt" checked={v.trailerAllowed} /></div>
        <div><Toggle name="towingAllowed" label="Abschleppen erlaubt" checked={v.towingAllowed} /></div>
        <div><Toggle name="commercialPassengerTransportAllowed" label="Gewerbliche Personenbeförderung erlaubt" checked={v.commercialPassengerTransportAllowed} /></div>
        <Field label="Hinweis Sondernutzung (optional)" htmlFor="specialUseNote" full><input id="specialUseNote" name="specialUseNote" defaultValue={v.specialUseNote ?? ""} maxLength={500} className="input" /></Field>
        <Feedback state={state} /><Submit pending={pending} />
      </form>
    );
    default: return null;
  }
}

export function PrivacyForm({ action, value }: { action: Action; value: string }) {
  const { state, formAction, pending } = useRules(action);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 p-5">
      <Field label="Verweis auf Datenschutzinformationen (optional)" htmlFor="privacyNoticeReference" full hint="Adresse oder kurzer Text. Wird getrennt von den Mietbedingungen geführt und nicht mit ihnen vermischt."><input id="privacyNoticeReference" name="privacyNoticeReference" defaultValue={value} maxLength={500} className="input" placeholder="https://…/datenschutz" /></Field>
      <Feedback state={state} /><Submit pending={pending} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Abweichungen an Fahrzeuggruppe und Fahrzeug: je Schlüssel „wie Standard“ oder eigener Wert
// ---------------------------------------------------------------------------

export type OverrideValues = { deductible: string; kmPolicy: string; fuelRule: string; fuelMinimumEighths: string; batteryMinimumPercent: string; abroad: "" | "1" | "0"; abroadCountries: string[]; smoking: "" | "1" | "0"; petsPolicy: string; additionalDrivers: "" | "1" | "0"; additionalDriverFeeType: string; additionalDriverFee: string; trailer: "" | "1" | "0"; towing: "" | "1" | "0" };

export function OverrideForm({ action, values, inherited, scopeLabel }: { action: Action; values: OverrideValues; inherited: BusinessRules; scopeLabel: string }) {
  const { state, formAction, pending } = useRules(action);
  const [open, setOpen] = useState(Object.values(values).some((x) => (Array.isArray(x) ? x.length > 0 : x !== "")));
  const [fuelRule, setFuelRule] = useState(values.fuelRule);
  const [abroad, setAbroad] = useState(values.abroad);
  const [feeType, setFeeType] = useState(values.additionalDriverFeeType);
  const tri = (name: string, label: string, current: string, yes: string, no: string, inheritedValue: boolean, onChange?: (v: "" | "1" | "0") => void) => (
    <Field label={label} htmlFor={`ov-${name}`} hint={`Standard: ${inheritedValue ? yes : no}`}>
      <select id={`ov-${name}`} name={name} defaultValue={current} onChange={(e) => onChange?.(e.target.value as "" | "1" | "0")} className="input"><option value="">wie Standard</option><option value="1">{yes}</option><option value="0">{no}</option></select>
    </Field>
  );
  if (!open) return <div className="p-4 text-sm flex flex-col gap-2"><p className="text-ink-3">Keine Abweichungen: Es gelten die Geschäftsregeln des Vermieters.</p><div><button type="button" className="btn !py-1.5" onClick={() => setOpen(true)}>Abweichende Regeln festlegen</button></div></div>;
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 p-5">
      <p className="md:col-span-2 text-xs text-ink-3">Nur gesetzte Werte weichen vom Standard ab ({scopeLabel}). Leer = wie Standard. Abgeschlossene Verträge bleiben unverändert.</p>
      <Field label="Selbstbeteiligung in €" htmlFor="ov-deductible" hint={`Standard: ${inherited.deductibleCents != null ? eur(inherited.deductibleCents) + " €" : "keine"}`}><input id="ov-deductible" name="deductible" inputMode="decimal" defaultValue={values.deductible} className="input tnum" placeholder="wie Standard" /></Field>
      <Field label="Kilometerregel" htmlFor="ov-kmPolicy" hint={`Standard: ${KM_POLICIES[inherited.kmPolicy]}`}><select id="ov-kmPolicy" name="kmPolicy" defaultValue={values.kmPolicy} className="input"><option value="">wie Standard</option>{Object.entries(KM_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Tank-/Laderegel" htmlFor="ov-fuelRule" hint={`Standard: ${FUEL_POLICIES[inherited.fuelRule]}`}><select id="ov-fuelRule" name="fuelRule" value={fuelRule} onChange={(e) => setFuelRule(e.target.value)} className="input"><option value="">wie Standard</option>{Object.entries(FUEL_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      {fuelRule === "MINIMUM_LEVEL" && <Field label="Mindestfüllstand Tank (Achtel)" htmlFor="ov-fuelMin"><input id="ov-fuelMin" name="fuelMinimumEighths" type="number" min={0} max={8} defaultValue={values.fuelMinimumEighths} className="input tnum" /></Field>}
      {fuelRule === "MINIMUM_LEVEL" && <Field label="Mindestladestand Batterie (%)" htmlFor="ov-battMin"><input id="ov-battMin" name="batteryMinimumPercent" type="number" min={0} max={100} defaultValue={values.batteryMinimumPercent} className="input tnum" /></Field>}
      {tri("abroad", "Auslandsfahrten", values.abroad, "erlaubt", "nicht erlaubt", inherited.abroadAllowed, setAbroad)}
      {abroad === "1" && <div className="md:col-span-2 flex flex-wrap gap-x-4 gap-y-1 text-sm"><span className="basis-full label-xs">Erlaubte Länder (leer = Liste des Standards)</span>{Object.entries(COUNTRIES).filter(([k]) => k !== "OTHER").map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name="abroadCountries" value={k} defaultChecked={values.abroadCountries.includes(k)} /> {l}</label>)}</div>}
      {tri("smoking", "Rauchen", values.smoking, "erlaubt", "nicht erlaubt", inherited.smokingAllowed)}
      <Field label="Tiere" htmlFor="ov-pets" hint={`Standard: ${PETS_POLICIES[inherited.petsPolicy]}`}><select id="ov-pets" name="petsPolicy" defaultValue={values.petsPolicy} className="input"><option value="">wie Standard</option>{Object.entries(PETS_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      {tri("additionalDrivers", "Zusatzfahrer", values.additionalDrivers, "erlaubt", "nicht erlaubt", inherited.additionalDriversAllowed)}
      <Field label="Zusatzfahrer-Preisregel" htmlFor="ov-feeType" hint={`Standard: ${ADDITIONAL_DRIVER_FEE_TYPES[inherited.additionalDriverFeeType]}${inherited.additionalDriverFeeType !== "FREE" ? ` ${eur(inherited.additionalDriverFeeCents)} €` : ""}`}><select id="ov-feeType" name="additionalDriverFeeType" value={feeType} onChange={(e) => setFeeType(e.target.value)} className="input"><option value="">wie Standard</option>{Object.entries(ADDITIONAL_DRIVER_FEE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      {feeType && feeType !== "FREE" && <Field label="Zusatzfahrer-Preis in €" htmlFor="ov-fee"><input id="ov-fee" name="additionalDriverFee" inputMode="decimal" defaultValue={values.additionalDriverFee} className="input tnum" /></Field>}
      {tri("trailer", "Anhängerbetrieb", values.trailer, "erlaubt", "nicht erlaubt", inherited.trailerAllowed)}
      {tri("towing", "Abschleppen", values.towing, "erlaubt", "nicht erlaubt", inherited.towingAllowed)}
      <Feedback state={state} />
      <div className="md:col-span-2 flex flex-wrap gap-2 items-center"><button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Abweichungen speichern"}</button><button type="submit" name="clear" value="1" disabled={pending} className="btn">Alle Abweichungen entfernen</button></div>
    </form>
  );
}

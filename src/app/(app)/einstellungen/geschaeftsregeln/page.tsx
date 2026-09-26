import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { DEFAULT_BUSINESS_RULES, RULE_KEYS, resolveRules, ruleConsistencyIssues, sanitizeRules } from "@/lib/business-rules";
import { ADDITIONAL_DRIVER_FEE_TYPES, COUNTRIES, FUEL_POLICIES, KEY_DROP_LEGAL_HINT, KEY_DROP_PHOTO_CATEGORIES, KM_POLICIES, LATE_RETURN_RULES, OUT_OF_HOURS_RETURN, PETS_POLICIES, PHOTO_CATEGORIES } from "@/lib/constants";
import { updateBusinessRulesAction, updateKeyDropSettingsAction, updatePrivacyReferenceAction } from "./actions";
import { KeyDropSettingsForm, PrivacyForm, RulesSectionForm } from "./rules-forms";
import { keyDropSettingsOf } from "@/lib/key-drop";

export const metadata = { title: "Geschäftsregeln" };

const SECTIONS: { key: string; title: string }[] = [
  { key: "fahrer", title: "Fahrer" }, { key: "zusatzfahrer", title: "Zusatzfahrer" }, { key: "kaution", title: "Kaution und Selbstbeteiligung" }, { key: "kilometer", title: "Kilometer" },
  { key: "tanken", title: "Tank und Laden" }, { key: "ausland", title: "Ausland" }, { key: "rauchen", title: "Rauchen und Tiere" }, { key: "rueckgabe", title: "Rückgabe" },
  { key: "reinigung", title: "Reinigung, Schlüssel und Zubehör" }, { key: "behoerden", title: "Behörden" }, { key: "nutzung", title: "Sonstige Nutzung" },
];
const eur = (c: number | null) => (c == null ? "–" : (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" }));

/** Geschäftsregeln des Mandanten in Bereichen. Inhaber bearbeitet, andere Rollen sehen die geltenden Standardwerte. */
export default async function BusinessRulesPage() {
  const { tenant, user } = await requireSession();
  const isOwner = user.role === "OWNER";
  const v = resolveRules(tenant.businessRules, null, null).values;
  const set = Object.keys(sanitizeRules(tenant.businessRules, RULE_KEYS)).length;
  const problems = ruleConsistencyIssues(v);
  const keyDrop = keyDropSettingsOf(tenant.keyDropSettings);
  void DEFAULT_BUSINESS_RULES;

  return (
    <>
      <PageHeader title="Geschäftsregeln" sub="Operative Standardwerte für neue Mietverträge – kein Ersatz für den Text der Mietbedingungen">
        <Link href="/einstellungen" className="btn">Einstellungen</Link>
        <Link href="/einstellungen/mietbedingungen" className="btn">Mietbedingungen</Link>
      </PageHeader>
      <Content>
        <div className="rounded-md bg-panel-2 px-3.5 py-2.5 text-sm text-ink-2 flex flex-wrap gap-x-4 gap-y-1 items-center">
          <span>Priorität: Standard des Vermieters → Fahrzeuggruppe → Fahrzeug → Mietvertrag. Der konkreteste Wert gewinnt; im Vertrag ist die Herkunft sichtbar.</span>
          <Chip>{set} von {RULE_KEYS.length} Werten gesetzt</Chip>
        </div>
        {problems.length > 0 && <div role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm"><div className="font-medium">Widersprüche in den Regeln</div><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        <p className="text-xs text-ink-3">Keine Regel erzeugt automatisch eine Rechnung, Zusatzkosten, eine Kautionsbewegung oder eine Schadenforderung. Änderungen wirken nie auf abgeschlossene Verträge; offene Entwürfe zeigen einen Hinweis und übernehmen neue Werte nur auf Wunsch.</p>

        {isOwner ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
            {SECTIONS.map((s) => <Card key={s.key} title={s.title}><RulesSectionForm action={updateBusinessRulesAction.bind(null, s.key)} section={s.key} v={v} /></Card>)}
            <Card title="Datenschutz"><PrivacyForm action={updatePrivacyReferenceAction} value={tenant.privacyNoticeReference ?? ""} /></Card>
            <Card title="Rückgabe: kontaktlos / Schlüsselbox" right={tenant.keyDropEnabled ? <Chip tone="good">erlaubt</Chip> : <Chip>aus</Chip>}><KeyDropSettingsForm action={updateKeyDropSettingsAction} v={{ enabled: tenant.keyDropEnabled, ...keyDrop, defaultInstructions: keyDrop.defaultInstructions ?? "", parkingNote: keyDrop.parkingNote ?? "", keyNote: keyDrop.keyNote ?? "", photoOptions: KEY_DROP_PHOTO_CATEGORIES.map((c) => ({ key: c, label: PHOTO_CATEGORIES[c] })), legalHint: KEY_DROP_LEGAL_HINT }} /></Card>
          </div>
        ) : (
          <Card title="Geltende Standardwerte">
            <dl className="p-4 grid grid-cols-[minmax(160px,40%)_1fr] gap-y-1.5 text-sm">
              <dt className="label-xs">Mindestalter</dt><dd>{v.minimumDriverAge} Jahre{v.minimumLicenseHoldingMonths > 0 ? `, Führerschein seit ${v.minimumLicenseHoldingMonths} Monaten` : ""}</dd>
              <dt className="label-xs">Zusatzfahrer</dt><dd>{v.additionalDriversAllowed ? `${ADDITIONAL_DRIVER_FEE_TYPES[v.additionalDriverFeeType]}${v.additionalDriverFeeType !== "FREE" ? ` ${eur(v.additionalDriverFeeCents)}` : ""}` : "nicht erlaubt"}</dd>
              <dt className="label-xs">Kaution / Selbstbeteiligung</dt><dd>{eur(v.depositCents)} / {eur(v.deductibleCents)}</dd>
              <dt className="label-xs">Kilometer</dt><dd>{KM_POLICIES[v.kmPolicy]}</dd>
              <dt className="label-xs">Tank/Laden</dt><dd>{FUEL_POLICIES[v.fuelRule]}</dd>
              <dt className="label-xs">Ausland</dt><dd>{v.abroadAllowed ? v.abroadCountries.map((c) => COUNTRIES[c as keyof typeof COUNTRIES] ?? c).join(", ") : "nicht erlaubt"}</dd>
              <dt className="label-xs">Rauchen / Tiere</dt><dd>{v.smokingAllowed ? "erlaubt" : "nicht erlaubt"} / {PETS_POLICIES[v.petsPolicy]}</dd>
              <dt className="label-xs">Verspätete Rückgabe</dt><dd>{LATE_RETURN_RULES[v.lateReturnRule]}</dd>
              <dt className="label-xs">Rückgabe außerhalb Öffnungszeiten</dt><dd>{OUT_OF_HOURS_RETURN[v.outOfHoursReturn]}</dd>
              <dt className="label-xs">Kontaktlose Rückgabe</dt><dd>{tenant.keyDropEnabled ? `erlaubt (${keyDrop.label})` : "nicht freigeschaltet"}</dd>
            </dl>
            <p className="px-4 pb-3 text-xs text-ink-3">Ändern kann diese Werte nur der Inhaber.</p>
          </Card>
        )}
      </Content>
    </>
  );
}

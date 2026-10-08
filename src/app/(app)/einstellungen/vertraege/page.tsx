import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Chip, Content } from "@/components/ui";
import { RULE_KEYS, resolveRules, ruleConsistencyIssues, sanitizeRules } from "@/lib/business-rules";
import { COUNTRIES, FUEL_POLICIES, KM_POLICIES, PETS_POLICIES } from "@/lib/constants";
import { fmtDate } from "@/lib/format";
import { termsOverview } from "@/lib/rental-terms";
import { TermsStatusChip } from "../mietbedingungen/chips";
import { SettingsHeader } from "../settings-ui";

export const metadata = { title: "Verträge & Dokumente" };

const eur = (c: number | null) => (c == null ? "–" : (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" }));

/**
 * Befehl 29.3.1: Übersicht der Kategorie „Verträge & Dokumente“ – rein lesend. Trennt den juristischen Text
 * (Mietbedingungen, versioniert) von den operativen Standardwerten (Geschäftsregeln). Bearbeitet wird unverändert auf
 * /einstellungen/mietbedingungen und /einstellungen/geschaeftsregeln.
 */
export default async function ContractsSettingsPage() {
  const { tenant, user, supportSession } = await requireSession();
  const isOwner = user.role === "OWNER" && !supportSession;
  const terms = await termsOverview(tenant.id);
  const v = resolveRules(tenant.businessRules, null, null).values;
  const set = Object.keys(sanitizeRules(tenant.businessRules, RULE_KEYS)).length;
  const problems = ruleConsistencyIssues(v);
  const recent = terms.versions.slice(0, 4);

  return (
    <>
      <SettingsHeader title="Verträge & Dokumente" sub="Was in neuen Mietverträgen gilt: der juristische Text der Mietbedingungen und die operativen Standardwerte der Geschäftsregeln. Abgeschlossene Verträge behalten immer ihren damaligen Stand." />
      <Content className="max-w-[1180px]">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-stretch">
          <section className="card flex flex-col" aria-labelledby="vd-terms">
            <header className="px-5 pt-4 pb-3.5 border-b border-line-soft">
              <p className="label-xs !text-info">Juristischer Text · versioniert</p>
              <h2 id="vd-terms" className="mt-1 font-sans text-base font-semibold flex flex-wrap items-center gap-2">
                Mietbedingungen
                {terms.active ? <Chip tone="good">Version {terms.active.label} aktiv</Chip> : <Chip tone="amber">nicht veröffentlicht</Chip>}
              </h2>
              <p className="mt-1 text-[12.5px] text-ink-3">Neue Mietverträge frieren genau die aktive Fassung ein. Veröffentlichte Fassungen werden nie geändert oder gelöscht.</p>
            </header>
            <div className="px-5 py-3.5 flex-1 flex flex-col gap-3 text-sm">
              {!terms.active && (
                <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Noch keine Mietbedingungen veröffentlicht. {terms.legacy.text ? "Neue Verträge nutzen bis dahin den bisherigen, unversionierten Text." : "Neue Verträge enthalten bis dahin keinen Bedingungstext."}</p>
              )}
              {terms.active && <p>Gültig {terms.active.effectiveFrom ? `seit ${fmtDate(terms.active.effectiveFrom)}` : terms.active.publishedAt ? `seit Veröffentlichung am ${fmtDate(terms.active.publishedAt)}` : ""}.</p>}
              {terms.draft && <p className="text-ink-2">Offener Entwurf: Version {terms.draft.label} (noch nicht veröffentlicht).</p>}
              {recent.length > 0 && (
                <ul className="divide-y divide-line-soft border-y border-line-soft">
                  {recent.map((t) => (
                    <li key={t.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Link href={`/einstellungen/mietbedingungen/${t.id}`} className="font-mono tnum font-medium hover:underline">{t.label}</Link>
                      <TermsStatusChip status={t.status} active={t.isActive} pending={t.effectivePending} />
                      <span className="flex-1 text-xs text-ink-3">{t.publishedAt ? `veröffentlicht ${fmtDate(t.publishedAt)}` : "Entwurf"}</span>
                      <span className="font-mono tnum text-xs text-ink-2">{t.usedInContracts} {t.usedInContracts === 1 ? "Vertrag" : "Verträge"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <footer className="px-5 py-3 border-t border-line-soft flex flex-wrap gap-2">
              <Link href="/einstellungen/mietbedingungen" className="btn btn-primary">Mietbedingungen und Fassungen</Link>
              {isOwner && terms.draft && <Link href={`/einstellungen/mietbedingungen/${terms.draft.id}`} className="btn">Entwurf {terms.draft.label} öffnen</Link>}
            </footer>
          </section>

          <section className="card flex flex-col" aria-labelledby="vd-rules">
            <header className="px-5 pt-4 pb-3.5 border-b border-line-soft">
              <p className="label-xs !text-good">Operative Standardwerte</p>
              <h2 id="vd-rules" className="mt-1 font-sans text-base font-semibold flex flex-wrap items-center gap-2">
                Geschäftsregeln
                <Chip>{set} von {RULE_KEYS.length} Werten gesetzt</Chip>
                {problems.length > 0 && <Chip tone="amber">{problems.length === 1 ? "1 Widerspruch" : `${problems.length} Widersprüche`}</Chip>}
              </h2>
              <p className="mt-1 text-[12.5px] text-ink-3">Vorbelegung für neue Mietverträge. Ersetzt nicht den Text der Mietbedingungen; Fahrzeuggruppe, Fahrzeug und Vertrag können abweichen.</p>
            </header>
            <div className="px-5 py-3.5 flex-1 flex flex-col gap-3 text-sm">
              <dl className="grid grid-cols-[minmax(120px,40%)_1fr] gap-x-3 gap-y-1.5">
                <dt className="label-xs pt-0.5">Mindestalter</dt><dd>{v.minimumDriverAge} Jahre{v.minimumLicenseHoldingMonths > 0 ? `, Führerschein seit ${v.minimumLicenseHoldingMonths} Monaten` : ""}</dd>
                <dt className="label-xs pt-0.5">Kaution / SB</dt><dd>{eur(v.depositCents)} / {eur(v.deductibleCents)}</dd>
                <dt className="label-xs pt-0.5">Kilometer</dt><dd>{KM_POLICIES[v.kmPolicy]}</dd>
                <dt className="label-xs pt-0.5">Tank / Laden</dt><dd>{FUEL_POLICIES[v.fuelRule]}</dd>
                <dt className="label-xs pt-0.5">Ausland</dt><dd>{v.abroadAllowed ? v.abroadCountries.map((c) => COUNTRIES[c as keyof typeof COUNTRIES] ?? c).join(", ") : "nicht erlaubt"}</dd>
                <dt className="label-xs pt-0.5">Rauchen / Tiere</dt><dd>{v.smokingAllowed ? "erlaubt" : "nicht erlaubt"} / {PETS_POLICIES[v.petsPolicy]}</dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Chip>Datenschutz-Verweis: {tenant.privacyNoticeReference ? "hinterlegt" : "keiner"}</Chip>
                <Chip tone={tenant.keyDropEnabled ? "good" : "grey"}>Kontaktlose Rückgabe: {tenant.keyDropEnabled ? "erlaubt" : "aus"}</Chip>
              </div>
            </div>
            <footer className="px-5 py-3 border-t border-line-soft flex flex-wrap gap-2">
              <Link href="/einstellungen/geschaeftsregeln" className="btn btn-primary">{isOwner ? "Geschäftsregeln bearbeiten" : "Geschäftsregeln ansehen"}</Link>
            </footer>
          </section>
        </div>
        <p className="rounded-md bg-panel-2 px-3.5 py-2.5 text-[12.5px] text-ink-2">
          Für Buchungen mit Miettarif gelten Kilometerregel und Kaution aus dem <Link href="/einstellungen/tarife" className="underline">Miettarif</Link>; die Geschäftsregeln gelten für ältere Buchungen ohne Tarif. Keine Regel erzeugt automatisch Rechnungen, Zusatzkosten oder Kautionsbewegungen.
        </p>
      </Content>
    </>
  );
}

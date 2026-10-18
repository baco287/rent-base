// Bausteine des Vertragsassistenten ohne eigenen Zustand (werden auf dem Server gerendert).
import Link from "next/link";
import type { ReactNode } from "react";
import type { ContractDocument, DocRow, DocSection } from "@/lib/contract-view";
import type { Issue } from "@/lib/contract-checks";
import { COUNTRIES } from "@/lib/constants";
import { Card, Chip, Field, type FieldIssue } from "@/components/ui";
import { ContractTermsText } from "@/components/terms-view";
import { CardsGrid, KeyValueList, Note, WizardCard } from "./wizard-layout";
import type { ContractIconName } from "./contract-icons";
import type { EditCardKey, EditTarget, GroupedDocument, RowGroup } from "./summary-map";

/** Prüfergebnis: Fehler verhindern den Abschluss, Hinweise nicht. */
export function IssueList({ issues, areas, okText }: { issues: Issue[]; areas?: Issue["area"][]; okText?: string }) {
  const list = areas ? issues.filter((i) => areas.includes(i.area)) : issues;
  const errors = list.filter((i) => i.severity === "error");
  const warnings = list.filter((i) => i.severity === "warning");
  if (list.length === 0) return okText ? <p className="rounded-md bg-good-soft text-good px-3 py-2 text-sm font-medium">{okText}</p> : null;
  return (
    <div className="flex flex-col gap-2">
      {errors.length > 0 && (
        <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">
          <div className="font-semibold mb-1">{errors.length === 1 ? "1 Punkt verhindert den Abschluss" : `${errors.length} Punkte verhindern den Abschluss`}</div>
          <ul className="list-disc pl-5 flex flex-col gap-0.5">{errors.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">
          <div className="font-semibold mb-1">Hinweise</div>
          <ul className="list-disc pl-5 flex flex-col gap-0.5">{warnings.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

export type DriverValues = {
  customerId: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  licenseNumber: string;
  licenseClass: string;
  licenseIssuedAt: string;
  licenseValidUntil: string;
  licenseCountry: string;
  licenseIssuedBy: string;
};

export const emptyDriver: DriverValues = {
  customerId: "", firstName: "", lastName: "", birthDate: "", street: "", zip: "", city: "", country: "DE",
  licenseNumber: "", licenseClass: "B", licenseIssuedAt: "", licenseValidUntil: "", licenseCountry: "DE", licenseIssuedBy: "",
};

/**
 * Eingabefelder für einen Fahrer. prefix trennt mehrere Fahrerformulare auf einer Seite.
 * Befehl 29.6 (alle optional – ohne sie unverändert, z. B. im Nachtrag): section rendert nur „Person“ (mit dem verborgenen
 * customerId, genau einmal) bzw. „Führerschein“ ohne eigenes Raster (das liefert die Karte); marks: Zeichen je Feld;
 * issues: Prüfhinweise je Feldname mit Präfix (aria-describedby, aria-invalid nur bei Fehlern).
 */
export function DriverFields({ values: v, prefix = "", section, marks, issues }: { values: DriverValues; prefix?: string; section?: "person" | "license"; marks?: Partial<Record<keyof DriverValues, "save" | "close">>; issues?: Partial<Record<string, FieldIssue>> }) {
  const n = (name: string) => `${prefix}${name}`;
  const countries = Object.entries(COUNTRIES).map(([k, l]) => <option key={k} value={k}>{l}</option>);
  const f = (k: keyof DriverValues) => ({ mark: marks?.[k], issue: issues?.[n(k)] });
  const a = (k: keyof DriverValues) => ({ "aria-invalid": issues?.[n(k)]?.error ? true : undefined, "aria-describedby": issues?.[n(k)]?.describedBy || undefined });
  const person = (
    <>
      <input type="hidden" name={n("customerId")} value={v.customerId} />
      <Field label="Vorname" htmlFor={n("firstName")} {...f("firstName")}><input id={n("firstName")} name={n("firstName")} defaultValue={v.firstName} required {...a("firstName")} className="input" autoComplete="off" /></Field>
      <Field label="Nachname" htmlFor={n("lastName")} {...f("lastName")}><input id={n("lastName")} name={n("lastName")} defaultValue={v.lastName} required {...a("lastName")} className="input" autoComplete="off" /></Field>
      <Field label="Geburtsdatum" htmlFor={n("birthDate")} {...f("birthDate")}><input id={n("birthDate")} name={n("birthDate")} type="date" defaultValue={v.birthDate} required {...a("birthDate")} className="input" /></Field>
      <Field label="Land" htmlFor={n("country")} {...f("country")}><select id={n("country")} name={n("country")} defaultValue={v.country || "DE"} {...a("country")} className="input">{countries}</select></Field>
      <Field label="Straße und Hausnummer" htmlFor={n("street")} full {...f("street")}><input id={n("street")} name={n("street")} defaultValue={v.street} required {...a("street")} className="input" /></Field>
      <Field label="PLZ" htmlFor={n("zip")} {...f("zip")}><input id={n("zip")} name={n("zip")} defaultValue={v.zip} required {...a("zip")} className="input" inputMode="numeric" /></Field>
      <Field label="Ort" htmlFor={n("city")} {...f("city")}><input id={n("city")} name={n("city")} defaultValue={v.city} required {...a("city")} className="input" /></Field>
    </>
  );
  const license = (
    <>
      <Field label="Führerscheinnummer" htmlFor={n("licenseNumber")} {...f("licenseNumber")}><input id={n("licenseNumber")} name={n("licenseNumber")} defaultValue={v.licenseNumber} required {...a("licenseNumber")} className="input font-mono uppercase" autoComplete="off" /></Field>
      <Field label="Führerscheinklasse" htmlFor={n("licenseClass")} {...f("licenseClass")}><input id={n("licenseClass")} name={n("licenseClass")} defaultValue={v.licenseClass} required {...a("licenseClass")} className="input" /></Field>
      <Field label="Ausgestellt am" htmlFor={n("licenseIssuedAt")} {...f("licenseIssuedAt")}><input id={n("licenseIssuedAt")} name={n("licenseIssuedAt")} type="date" defaultValue={v.licenseIssuedAt} required {...a("licenseIssuedAt")} className="input" /></Field>
      <Field label="Gültig bis" htmlFor={n("licenseValidUntil")} {...f("licenseValidUntil")}><input id={n("licenseValidUntil")} name={n("licenseValidUntil")} type="date" defaultValue={v.licenseValidUntil} required {...a("licenseValidUntil")} className="input" /></Field>
      <Field label="Ausstellungsland" htmlFor={n("licenseCountry")} {...f("licenseCountry")}><select id={n("licenseCountry")} name={n("licenseCountry")} defaultValue={v.licenseCountry || "DE"} {...a("licenseCountry")} className="input">{countries}</select></Field>
      <Field label="Ausstellende Behörde (optional)" htmlFor={n("licenseIssuedBy")} {...f("licenseIssuedBy")}><input id={n("licenseIssuedBy")} name={n("licenseIssuedBy")} defaultValue={v.licenseIssuedBy} {...a("licenseIssuedBy")} className="input" /></Field>
    </>
  );
  if (section === "person") return person;
  if (section === "license") return license;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      {person}
      {license}
    </div>
  );
}

type Price = ContractDocument["price"];
const priceRow = "flex justify-between gap-3 py-1.5 border-b border-line-soft";

/**
 * Befehl 29.6: Aufbau des Mietpreises aus dem Vertragsdokument (doc.price) – keine eigene Rechnung.
 * "conditions": wie bisher die Karte „So entsteht der Mietpreis“ in Schritt 4 (kurzes Label „Abweichend vereinbart“).
 * "document": zeilengenau die Preis-Karte von ContractDocumentView (Test sichert die Gleichheit ab).
 */
export function PriceBreakdown({ price, variant, accident = false, className = "text-sm flex flex-col" }: { price: Price; variant: "conditions" | "document"; accident?: boolean; className?: string }) {
  if (variant === "document") {
    return (
      <div className={className}>
        <div className="text-xs text-ink-3 pb-1">{price.durationText}</div>
        {price.lines.map((l, i) => (
          <div key={i} className={priceRow}><span>{i > 0 ? "+ " : ""}{l.text}</span><span className="font-mono tnum">{l.amount}</span></div>
        ))}
        <div className={priceRow}><span>{price.subtotalLabel}</span><span className="font-mono tnum">{price.subtotal}</span></div>
        {price.discount && <div className={priceRow}><span>{price.discount.text}</span><span className="font-mono tnum">{price.discount.amount}</span></div>}
        {price.agreed && (
          <>
            <div className={`${priceRow} text-ink-3`}><span>Berechneter Mietpreis</span><span className="font-mono tnum line-through">{price.calculated}</span></div>
            <div className={priceRow}><span>{price.agreed.text}</span><span className="font-mono tnum">{price.agreed.amount}</span></div>
          </>
        )}
        {price.extras.map((e, i) => <div key={`x${i}`} className={priceRow}><span>+ {e.text}</span><span className="font-mono tnum">{e.amount}</span></div>)}
        <div className="flex justify-between gap-3 py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>Gesamtmietpreis (brutto)</span><span className={price.openEnd ? "text-right" : "font-mono tnum"}>{price.total}</span></div>
        {price.totalNote && <p className="text-xs text-ink-2 pb-1">{price.totalNote}</p>}
        <div className="flex justify-between gap-3 py-1.5 text-ink-2"><span>{price.deposit === "keine" ? "Kaution" : "Kaution, wird zurückgezahlt"}</span><span className="font-mono tnum">{price.deposit}</span></div>
      </div>
    );
  }
  return (
    <div className={className}>
      <div className="text-xs text-ink-2 pb-1">{price.durationText}</div>
      {price.lines.map((l, i) => <div key={i} className={priceRow}><span className="min-w-0 [overflow-wrap:anywhere]">{i > 0 ? "+ " : ""}{l.text}</span><span className="font-mono tnum whitespace-nowrap">{l.amount}</span></div>)}
      <div className={priceRow}><span>{price.subtotalLabel}</span><span className="font-mono tnum whitespace-nowrap">{price.subtotal}</span></div>
      {price.discount && <div className={priceRow}><span>{price.discount.text}</span><span className="font-mono tnum whitespace-nowrap">{price.discount.amount}</span></div>}
      {price.agreed && <div className={priceRow}><span>Abweichend vereinbart</span><span className="font-mono tnum whitespace-nowrap">{price.agreed.amount}</span></div>}
      {price.extras.map((e, i) => <div key={`x${i}`} className={priceRow}><span className="min-w-0 [overflow-wrap:anywhere]">+ {e.text}</span><span className="font-mono tnum whitespace-nowrap">{e.amount}</span></div>)}
      <div className="flex justify-between gap-3 py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>Gesamtmietpreis</span><span className={price.openEnd ? "text-right" : "font-mono tnum whitespace-nowrap"}>{price.total}</span></div>
      {price.totalNote && <p className="text-xs text-ink-2 pb-1">{price.totalNote}</p>}
      <div className="flex justify-between gap-3 py-1.5 text-ink-2"><span>Kaution</span><span className="font-mono tnum whitespace-nowrap">{price.deposit}</span></div>
      <p className="text-xs text-ink-2 mt-2">{accident ? "Tarif aus der Fallakte (Tagessatz, Positionen je Miettag und einmalige Positionen) – hier nur zur Ansicht. Kein Kundenrabatt, keine Wochen- oder Monatsstaffel." : "Die Berechnung aktualisiert sich nach „Speichern & weiter“. Es gilt die günstigste Kombination der hinterlegten Preisstufen."}</p>
    </div>
  );
}

const docRows = (rows: DocRow[]) => rows.map((r) => ({ label: r.label, value: r.missing ? "fehlt" : r.value, bad: r.missing }));
function Groups({ groups }: { groups: RowGroup[] }) {
  const filled = groups.filter((g) => g.rows.length > 0);
  if (filled.length === 1) return <KeyValueList rows={docRows(filled[0]!.rows)} />;
  return (
    <>
      {filled.map((g) => (
        <div key={`${g.source}:${g.title}`} className="flex flex-col gap-1.5">
          <h4 className="text-[12.5px] font-semibold text-ink-2">{g.title}</h4>
          <KeyValueList rows={docRows(g.rows)} />
        </div>
      ))}
    </>
  );
}
function EditLink({ target, title }: { target: EditTarget; title: string }) {
  if (!target) return null;
  return (
    <Link href={target.href} aria-label={target.text === "Bearbeiten" ? `${title} bearbeiten` : `${title}: ${target.text}`} className="shrink-0 rounded text-[13px] font-medium text-brand hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info">
      {target.text}
    </Link>
  );
}

/**
 * Schritt 6: das Vertragsdokument (doc) als Karten. Jede Zeile aus doc.sections und doc.rules steht genau einmal
 * (Zuordnung in summary-map.ts, Ausnahmen nach E5); Labels und Werte unverändert. Keine Eingaben.
 */
export function SummaryCards({ doc, grouped, targets, accident, caseHref, tariffLocked }: { doc: ContractDocument; grouped: GroupedDocument; targets: Record<EditCardKey, EditTarget>; accident: boolean; caseHref: string | null; tariffLocked: boolean }) {
  const c = grouped.cards;
  const card = (key: EditCardKey, id: string, icon: ContractIconName, title: string, body: ReactNode, right?: ReactNode) => (
    <WizardCard key={id} id={id} icon={icon} title={title} right={right ?? <EditLink target={targets[key]} title={title} />}>{body}</WizardCard>
  );
  return (
    <CardsGrid>
      {card("renter", "k6-kunde", "user", "Kunde", <Groups groups={c.renter.groups} />)}
      {card("driver", "k6-fahrer", "id", "Fahrer", <>{c.driver.subtitle && <p className="text-[12.5px] font-medium text-ink-2">{c.driver.subtitle}</p>}<Groups groups={c.driver.groups} /></>)}
      {card("vehicle", "k6-fahrzeug", "car", "Fahrzeug", <Groups groups={c.vehicle.groups} />)}
      {card("period", "k6-zeitraum", "calendar", "Mietzeitraum & Übergabeort", <><Groups groups={c.period.groups} />{accident && caseHref && <Link href={caseHref} className="text-[12.5px] text-brand underline underline-offset-2">Geplantes Ende in der Fallakte</Link>}</>)}
      {card("price", "k6-preis", "tag", "Miettarif und Preise", <>{c.price.groups.length > 0 && <Groups groups={c.price.groups} />}<PriceBreakdown price={doc.price} variant="document" /></>, accident && !caseHref ? <span className="text-[12.5px] text-ink-2">Tarif laut Fallakte</span> : undefined)}
      {card("km", "k6-km", "gauge", "Kilometer & Nutzung", <><Groups groups={c.km.groups} />{tariffLocked && <Note icon="lock">Kilometer laut Buchung – Änderung in der Buchung.</Note>}</>)}
      {card("deposit", "k6-kaution", "shield", "Kaution & Selbstbeteiligung", <><Groups groups={c.deposit.groups} /><p className="text-[12px] text-ink-2">Nicht Teil des Mietpreises und wird nicht addiert.</p></>)}
      {c.abroad.groups.length > 0 && card("abroad", "k6-ausland", "globe", "Auslandsfahrten", <Groups groups={c.abroad.groups} />)}
      {card("additional", "k6-zusatzfahrer", "users", "Zusatzfahrer", (
        <>
          {doc.additionalDrivers.length === 0 ? (
            <p className="text-sm text-ink-2">Keine Zusatzfahrer. Nur die oben genannte Person darf das Fahrzeug führen.</p>
          ) : (
            doc.additionalDrivers.map((s) => (
              <div key={s.key} className="flex flex-col gap-1.5">
                <h4 className="text-[12.5px] font-semibold text-ink-2">{s.title}</h4>
                <KeyValueList rows={docRows(s.rows)} />
              </div>
            ))
          )}
          {c.additional.groups.length > 0 && <div className="border-t border-line-soft pt-2.5"><Groups groups={c.additional.groups} /></div>}
        </>
      ))}
      {c.other.groups.length > 0 && card("other", "k6-weitere", "sliders", "Weitere Vertragskonditionen", <Groups groups={c.other.groups} />)}
      {card("agreements", "k6-vereinbarungen", "file", "Individuelle Vereinbarungen", doc.individualAgreements ? <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{doc.individualAgreements}</p> : <p className="text-sm text-ink-2">Keine individuellen Vereinbarungen.</p>)}
      {card("terms", "k6-agb", "file", "Mietbedingungen", (
        <>
          <p className="text-sm font-medium [overflow-wrap:anywhere]">{doc.terms.title}</p>
          <p className="text-[12.5px] text-ink-2">{doc.terms.text ? "Kenntnisnahme und Unterschrift in Schritt 7." : "Keine Mietbedingungen hinterlegt."}</p>
        </>
      ), doc.terms.version ? <Chip tone={doc.terms.legacy ? "grey" : "info"}>{doc.terms.legacy ? `Altbestand ${doc.terms.version}` : `Version ${doc.terms.version}`}</Chip> : undefined)}
    </CardsGrid>
  );
}

function SectionCard({ s }: { s: DocSection }) {
  return (
    <Card title={s.title}>
      <dl className="px-4 py-3 grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
        {s.rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-ink-3">{r.label}</dt>
            <dd className={r.missing ? "text-bad font-medium" : "font-medium break-words"}>{r.missing ? "fehlt" : r.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Darstellung des Vertrags aus der gemeinsamen Dokumentstruktur. Dieselbe Struktur speist später das PDF. */
export function ContractDocumentView({ doc, showSignatures = true }: { doc: ContractDocument; showSignatures?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="card px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <div>
          <div className="font-display text-xl font-semibold">{doc.title} {doc.number}</div>
          <div className="text-xs text-ink-3">{doc.landlord.name}{doc.landlord.address ? ` · ${doc.landlord.address}` : ""}{doc.landlord.contact ? ` · ${doc.landlord.contact}` : ""}</div>
        </div>
        <span className="flex-1" />
        {doc.status === "SIGNED" ? <Chip tone="good">Unterschrieben am {doc.signedAt}</Chip> : doc.status === "CANCELLED" ? <Chip tone="grey">Storniert</Chip> : <Chip tone="amber">Entwurf</Chip>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {doc.sections.map((s) => <SectionCard key={s.key} s={s} />)}
        {doc.additionalDrivers.length === 0 ? (
          <Card title="Zusatzfahrer"><p className="px-4 py-3 text-sm text-ink-3">Keine Zusatzfahrer. Nur die oben genannte Person darf das Fahrzeug führen.</p></Card>
        ) : (
          doc.additionalDrivers.map((s) => <SectionCard key={s.key} s={s} />)
        )}

        <Card title="Preis">
          <div className="px-4 py-3 text-sm flex flex-col">
            <div className="text-xs text-ink-3 pb-1">{doc.price.durationText}</div>
            {doc.price.lines.map((l, i) => (
              <div key={i} className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{i > 0 ? "+ " : ""}{l.text}</span><span className="font-mono tnum">{l.amount}</span></div>
            ))}
            <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{doc.price.subtotalLabel}</span><span className="font-mono tnum">{doc.price.subtotal}</span></div>
            {doc.price.discount && <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{doc.price.discount.text}</span><span className="font-mono tnum">{doc.price.discount.amount}</span></div>}
            {doc.price.agreed && (
              <>
                <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft text-ink-3"><span>Berechneter Mietpreis</span><span className="font-mono tnum line-through">{doc.price.calculated}</span></div>
                <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{doc.price.agreed.text}</span><span className="font-mono tnum">{doc.price.agreed.amount}</span></div>
              </>
            )}
            {doc.price.extras.map((e, i) => <div key={`x${i}`} className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>+ {e.text}</span><span className="font-mono tnum">{e.amount}</span></div>)}
            <div className="flex justify-between gap-3 py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>Gesamtmietpreis (brutto)</span><span className={doc.price.openEnd ? "text-right" : "font-mono tnum"}>{doc.price.total}</span></div>
            {doc.price.totalNote && <p className="text-xs text-ink-2 pb-1">{doc.price.totalNote}</p>}
            <div className="flex justify-between gap-3 py-1.5 text-ink-2"><span>{doc.price.deposit === "keine" ? "Kaution" : "Kaution, wird zurückgezahlt"}</span><span className="font-mono tnum">{doc.price.deposit}</span></div>
          </div>
        </Card>

        {doc.rules && <SectionCard s={doc.rules} />}
        <Card title="Individuelle Vereinbarungen">
          {doc.individualAgreements ? <p className="px-4 py-3 text-sm whitespace-pre-wrap">{doc.individualAgreements}</p> : <p className="px-4 py-3 text-sm text-ink-3">Keine individuellen Vereinbarungen.</p>}
        </Card>
        <Card title={doc.terms.title} right={doc.terms.version ? <Chip tone={doc.terms.legacy ? "grey" : "info"}>{doc.terms.legacy ? `Altbestand ${doc.terms.version}` : `Version ${doc.terms.version}`}</Chip> : undefined}>
          {doc.terms.text ? (
            <details className="px-4 py-3 text-sm">
              <summary className="cursor-pointer font-medium">Bedingungen anzeigen</summary>
              <div className="mt-2 max-h-96 overflow-y-auto pr-1"><ContractTermsText blocks={doc.terms.blocks} text={doc.terms.text} compact /></div>
              {doc.terms.acknowledgedAt && <p className="mt-2 text-xs text-ink-3">Zur Kenntnisnahme bereitgestellt am {doc.terms.acknowledgedAt}.</p>}
            </details>
          ) : (
            <p className="px-4 py-3 text-sm text-ink-3">Keine Mietbedingungen hinterlegt. Der Inhaber veröffentlicht sie unter Einstellungen → Mietbedingungen.</p>
          )}
        </Card>
      </div>

      {showSignatures && doc.signatures.length > 0 && (
        <Card title="Unterschriften">
          <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {doc.signatures.map((s) => (
              <figure key={s.role} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.imageUrl} alt={`Unterschrift ${s.roleLabel}`} className="h-28 w-full object-contain rounded-md border border-line bg-white" />
                <figcaption className="text-xs text-ink-2">{s.roleLabel}: {s.signerName} · {s.signedAt}</figcaption>
              </figure>
            ))}
          </div>
        </Card>
      )}
      {/* Prüfsumme des unterschriebenen Inhalts bleibt gespeichert und geprüft; im Tagesgeschäft nicht angezeigt (Befehl 20.8) */}
    </div>
  );
}

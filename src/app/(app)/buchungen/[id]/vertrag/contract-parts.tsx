// Bausteine des Vertragsassistenten ohne eigenen Zustand (werden auf dem Server gerendert).
import type { ContractDocument, DocSection } from "@/lib/contract-view";
import type { Issue } from "@/lib/contract-checks";
import { COUNTRIES } from "@/lib/constants";
import { Card, Chip, Field } from "@/components/ui";

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

/** Eingabefelder für einen Fahrer. prefix trennt mehrere Fahrerformulare auf einer Seite. */
export function DriverFields({ values: v, prefix = "" }: { values: DriverValues; prefix?: string }) {
  const n = (name: string) => `${prefix}${name}`;
  const countries = Object.entries(COUNTRIES).map(([k, l]) => <option key={k} value={k}>{l}</option>);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      <input type="hidden" name={n("customerId")} value={v.customerId} />
      <Field label="Vorname" htmlFor={n("firstName")}><input id={n("firstName")} name={n("firstName")} defaultValue={v.firstName} required className="input" autoComplete="off" /></Field>
      <Field label="Nachname" htmlFor={n("lastName")}><input id={n("lastName")} name={n("lastName")} defaultValue={v.lastName} required className="input" autoComplete="off" /></Field>
      <Field label="Geburtsdatum" htmlFor={n("birthDate")}><input id={n("birthDate")} name={n("birthDate")} type="date" defaultValue={v.birthDate} required className="input" /></Field>
      <Field label="Land" htmlFor={n("country")}><select id={n("country")} name={n("country")} defaultValue={v.country || "DE"} className="input">{countries}</select></Field>
      <Field label="Straße und Hausnummer" htmlFor={n("street")} full><input id={n("street")} name={n("street")} defaultValue={v.street} required className="input" /></Field>
      <Field label="PLZ" htmlFor={n("zip")}><input id={n("zip")} name={n("zip")} defaultValue={v.zip} required className="input" inputMode="numeric" /></Field>
      <Field label="Ort" htmlFor={n("city")}><input id={n("city")} name={n("city")} defaultValue={v.city} required className="input" /></Field>
      <Field label="Führerscheinnummer" htmlFor={n("licenseNumber")}><input id={n("licenseNumber")} name={n("licenseNumber")} defaultValue={v.licenseNumber} required className="input font-mono uppercase" autoComplete="off" /></Field>
      <Field label="Führerscheinklasse" htmlFor={n("licenseClass")}><input id={n("licenseClass")} name={n("licenseClass")} defaultValue={v.licenseClass} required className="input" /></Field>
      <Field label="Ausgestellt am" htmlFor={n("licenseIssuedAt")}><input id={n("licenseIssuedAt")} name={n("licenseIssuedAt")} type="date" defaultValue={v.licenseIssuedAt} required className="input" /></Field>
      <Field label="Gültig bis" htmlFor={n("licenseValidUntil")}><input id={n("licenseValidUntil")} name={n("licenseValidUntil")} type="date" defaultValue={v.licenseValidUntil} required className="input" /></Field>
      <Field label="Ausstellungsland" htmlFor={n("licenseCountry")}><select id={n("licenseCountry")} name={n("licenseCountry")} defaultValue={v.licenseCountry || "DE"} className="input">{countries}</select></Field>
      <Field label="Ausstellende Behörde (optional)" htmlFor={n("licenseIssuedBy")}><input id={n("licenseIssuedBy")} name={n("licenseIssuedBy")} defaultValue={v.licenseIssuedBy} className="input" /></Field>
    </div>
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
            <div className="text-xs text-ink-3 pb-1">Mietdauer {doc.price.days} {doc.price.days === 1 ? "Tag" : "Tage"}</div>
            {doc.price.lines.map((l, i) => (
              <div key={i} className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{i > 0 ? "+ " : ""}{l.text}</span><span className="font-mono tnum">{l.amount}</span></div>
            ))}
            <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>Zwischensumme</span><span className="font-mono tnum">{doc.price.subtotal}</span></div>
            {doc.price.discount && <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{doc.price.discount.text}</span><span className="font-mono tnum">{doc.price.discount.amount}</span></div>}
            {doc.price.agreed && (
              <>
                <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft text-ink-3"><span>Berechneter Mietpreis</span><span className="font-mono tnum line-through">{doc.price.calculated}</span></div>
                <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{doc.price.agreed.text}</span><span className="font-mono tnum">{doc.price.agreed.amount}</span></div>
              </>
            )}
            <div className="flex justify-between gap-3 py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>Gesamtmietpreis (brutto)</span><span className="font-mono tnum">{doc.price.total}</span></div>
            <div className="flex justify-between gap-3 py-1.5 text-ink-2"><span>Kaution, wird zurückgezahlt</span><span className="font-mono tnum">{doc.price.deposit}</span></div>
          </div>
        </Card>

        <Card title="Mietbedingungen" right={doc.terms.version ? <Chip>Fassung {doc.terms.version}</Chip> : undefined}>
          {doc.terms.text ? (
            <details className="px-4 py-3 text-sm">
              <summary className="cursor-pointer font-medium">Bedingungen anzeigen</summary>
              <p className="mt-2 whitespace-pre-wrap text-ink-2 max-h-80 overflow-y-auto">{doc.terms.text}</p>
            </details>
          ) : (
            <p className="px-4 py-3 text-sm text-ink-3">Keine Mietbedingungen hinterlegt. Der Text lässt sich unter Einstellungen eintragen.</p>
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
      {doc.contentHash && <p className="text-[11px] text-ink-3 font-mono break-all">Prüfsumme des unterschriebenen Inhalts: {doc.contentHash}</p>}
    </div>
  );
}

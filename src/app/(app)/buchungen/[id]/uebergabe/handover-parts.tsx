// Bausteine des Übergabe-Assistenten ohne eigenen Zustand (werden auf dem Server gerendert).
import { Fragment } from "react";
import type { HandoverDocument } from "@/lib/handover-view";
import type { HandoverIssue } from "@/lib/handovers";
import { Card, Chip } from "@/components/ui";
import { DamageMap } from "./damage-map";

export const PICKUP_STEPS = ["Übersicht", "Kilometer & Energie", "Schäden", "Fotos", "Checkliste", "Fahrer & Dokumente", "Unterschrift", "Abschluss"] as const;
export const RETURN_STEPS = ["Übersicht", "Kilometer & Mietdauer", "Tank / Batterie", "Fahrzeugzustand", "Fotos", "Checkliste", "Zusatzkosten", "Unterschrift", "Abschluss"] as const;

/** Vergleichstabelle Übergabe/Rückgabe, gemeinsam für Assistent, Protokollansicht und Abschluss. */
export function ComparisonTable({ doc }: { doc: HandoverDocument }) {
  const c = doc.comparison;
  if (!c) return null;
  return (
    <Card title={`Vergleich mit der Übergabe ${c.pickupNumber}`}>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-ink-3 border-b border-line-soft"><th className="px-4 py-2 font-medium"></th><th className="px-2 py-2 font-medium text-right">Übergabe</th><th className="px-2 py-2 font-medium text-right">Rückgabe</th><th className="px-4 py-2 font-medium text-right">Differenz</th></tr></thead>
        <tbody>
          {c.rows.map((r) => (
            <tr key={r.label} className="border-b border-line-soft">
              <td className="px-4 py-2 text-ink-2">{r.label}</td>
              <td className="px-2 py-2 text-right font-mono tnum">{r.pickup}</td>
              <td className="px-2 py-2 text-right font-mono tnum font-semibold">{r.ret}</td>
              <td className={`px-4 py-2 text-right font-mono tnum ${r.attention ? "text-bad font-semibold" : ""}`}>{r.diff}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="px-4 py-3 grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-ink-3">Mietbeginn</dt><dd className="font-mono tnum">{c.time.start}</dd>
        <dt className="text-ink-3">Geplante Rückgabe</dt><dd className="font-mono tnum">{c.time.plannedEnd}</dd>
        <dt className="text-ink-3">Tatsächliche Rückgabe</dt><dd className="font-mono tnum">{c.time.actualEnd}</dd>
        <dt className="text-ink-3">Verspätung</dt><dd className={c.time.late ? "text-bad font-medium" : ""}>{c.time.late ?? "keine"}</dd>
        {c.mileageBasis && <><dt className="text-ink-3">Kilometer laut Vertrag</dt><dd>{c.mileageBasis}</dd></>}
        <dt className="text-ink-3">Tankregelung</dt><dd>{c.fuelPolicy}</dd>
      </dl>
    </Card>
  );
}

/** Bestätigte Zusatzkosten und Kaution, getrennt ausgewiesen. */
export function ChargesTable({ doc }: { doc: HandoverDocument }) {
  const c = doc.comparison;
  if (!c) return null;
  return (
    <Card title="Zusatzkosten" right={<Chip tone={c.charges.length > 0 ? "amber" : "grey"}>{c.charges.length === 0 ? "keine" : c.chargesTotal}</Chip>}>
      {c.charges.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-3">Es wurden keine Zusatzkosten erfasst.</p>
      ) : (
        <ul className="divide-y divide-line-soft text-sm">
          {c.charges.map((x, i) => (
            <li key={i} className="px-4 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="font-medium">{x.typeLabel}</span>
              <span className="flex-1 min-w-[12ch] text-ink-2">{x.description}{x.damageIndex ? ` (Schaden Nr. ${x.damageIndex})` : ""}</span>
              <span className="text-xs text-ink-3 font-mono tnum">{x.formula}</span>
              <span className="font-mono tnum font-semibold">{x.amount}</span>
            </li>
          ))}
          <li className="px-4 py-2 flex justify-between font-semibold"><span>Gesamt Zusatzkosten</span><span className="font-mono tnum">{c.chargesTotal}</span></li>
        </ul>
      )}
      <dl className="px-4 py-3 border-t border-line-soft grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-ink-3">Kaution laut Vertrag</dt><dd className="font-mono tnum">{c.deposit}</dd>
        <dt className="text-ink-3">Selbstbeteiligung</dt><dd className="font-mono tnum">{c.deductible}</dd>
        <dt className="text-ink-3">Kautionsabrechnung</dt><dd>offen, wird gesondert abgerechnet</dd>
      </dl>
      {c.charges.some((x) => x.damageIndex) && <p className="px-4 pb-3 text-xs text-ink-3">Eine Kostenposition zu einem Schaden ist nur die vom Vermieter erfasste Position, keine Feststellung darüber, wer den Schaden verursacht hat.</p>}
    </Card>
  );
}

/** Prüfergebnis: Fehler verhindern den Abschluss, Hinweise nicht. */
export function HandoverIssueList({ issues, areas, okText }: { issues: HandoverIssue[]; areas?: HandoverIssue["area"][]; okText?: string }) {
  const list = areas ? issues.filter((i) => areas.includes(i.area)) : issues;
  const errors = list.filter((i) => i.severity === "error");
  const warnings = list.filter((i) => i.severity === "warning");
  if (list.length === 0) return okText ? <p className="rounded-md bg-good-soft text-good px-3 py-2 text-sm font-medium">{okText}</p> : null;
  return (
    <div className="flex flex-col gap-2">
      {errors.length > 0 && (
        <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">
          <div className="font-semibold mb-1">{errors.length === 1 ? "1 Punkt ist noch offen" : `${errors.length} Punkte sind noch offen`}</div>
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

/** Tankanzeige in Achteln, nur Darstellung. */
export function FuelGauge({ eighths }: { eighths: number | null }) {
  return (
    <div className="flex gap-1" aria-label={eighths == null ? "Tankstand nicht erfasst" : `Tankstand ${eighths} von 8`}>
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} className={`h-4 flex-1 rounded-sm border ${eighths != null && i < eighths ? "bg-brand border-brand" : "bg-panel-2 border-line"}`} />
      ))}
    </div>
  );
}

/** Darstellung des Protokolls aus der gemeinsamen Dokumentstruktur. Dieselbe Struktur speist später das PDF. */
/** Befehl 20.6: Angaben des Kunden bei kontaktloser Rückgabe – getrennt von der Mitarbeiterkontrolle. */
export function KeyDropCustomerCard({ k }: { k: NonNullable<HandoverDocument["keyDrop"]> }) {
  return (
    <Card title="Angaben des Kunden bei kontaktloser Rückgabe" right={k.confirmedAt ? <Chip tone="info">Gemeldet {k.confirmedAt}</Chip> : <Chip tone="amber">Keine Kundenmeldung</Chip>}>
      <div className="p-4 flex flex-col gap-3 text-sm">
        {k.exceptionReason && !k.confirmedAt && <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Kontrolle ohne Kundenbestätigung (Ausnahme). Grund: {k.exceptionReason}</p>}
        <dl className="grid grid-cols-[minmax(130px,40%)_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-ink-3">Rückgabeart</dt><dd>Kontaktlos ({k.label})</dd>
          <dt className="text-ink-3">Vereinbarter Ort</dt><dd className="break-words">{k.agreedLocation}</dd>
          {k.customerRows.map((r) => <Fragment key={r.label}><dt className="text-ink-3">{r.label}</dt><dd className="break-words">{r.value}</dd></Fragment>)}
          {k.signerName && <><dt className="text-ink-3">Bestätigt von</dt><dd>{k.signerName}</dd></>}
        </dl>
        {k.confirmationText && <p className="text-xs text-ink-2">„{k.confirmationText}“</p>}
        {k.signatureId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/signatures/${k.signatureId}`} alt="Bestätigung des Kunden" className="h-20 w-full max-w-xs object-contain rounded-md border border-line bg-white" />
        )}
        {k.photos.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {k.photos.map((p) => (
              <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.caption} className="aspect-[4/3] w-full object-cover rounded-md border border-line" />
                <span className="text-xs text-ink-3">{p.caption.replace("Kunde: ", "")}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

export function HandoverDocumentView({ doc, handoverId, showSignatures = true }: { doc: HandoverDocument; handoverId: string; showSignatures?: boolean }) {
  const existing = doc.damages.filter((d) => d.marker === "EXISTING").length;
  const pickupNew = doc.damages.filter((d) => d.marker === "PICKUP_NEW").length;
  const fresh = doc.damages.filter((d) => d.marker === "NEW").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="card px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <div>
          <div className="font-display text-xl font-semibold">{doc.title} {doc.number}</div>
          <div className="text-xs text-ink-3">Begonnen {doc.startedAt} · durchgeführt von {doc.employeeName}</div>
        </div>
        <span className="flex-1" />
        {doc.status === "FINALIZED" ? <Chip tone="good">Finalisiert am {doc.finalizedAt}</Chip> : <Chip tone="amber">Entwurf</Chip>}
      </div>

      {doc.keyDrop && <KeyDropCustomerCard k={doc.keyDrop} />}
      {doc.keyDrop && <p className="rounded-md bg-panel-2 px-3.5 py-2.5 text-sm text-ink-2">Nachträgliche Fahrzeugkontrolle durch den Vermieter. Der Kunde war bei der Kontrolle nicht anwesend; seine Bestätigung betrifft nur die Abgabe, nicht die folgenden Feststellungen.</p>}

      {doc.type === "RETURN" && <ComparisonTable doc={doc} />}

      {doc.driverChecks.length > 0 && (
        <Card title="Fahrer- und Führerscheinprüfung">
          <ul className="divide-y divide-line-soft text-sm">
            {doc.driverChecks.map((d) => (
              <li key={d.name} className="px-4 py-2.5 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="font-medium">{d.name}</span>
                  <Chip tone="info">{d.roleLabel}</Chip>
                  <Chip tone={d.statusLabel === "Bestätigt" ? "good" : d.statusLabel === "Blockiert" ? "bad" : "amber"}>{d.statusLabel}</Chip>
                </div>
                <div className="text-xs text-ink-2 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>Identität im Original geprüft: {d.identityOriginalSeen ? "Ja" : "Nein"}</span>
                  <span>Führerschein im Original geprüft: {d.licenseOriginalSeen ? "Ja" : "Nein"}</span>
                  {d.requiredLicenseClass && <span>Fahrerlaubnisklasse geprüft: {d.requiredLicenseClass}{d.licenseClassSatisfied === false ? " (nicht erfüllt)" : ""}</span>}
                  <span>Gültigkeit geprüft: {d.licenseValid === true ? "Ja" : d.licenseValid === false ? "Nein" : "–"}</span>
                  {d.checkedAtLabel && <span>Geprüft am {d.checkedAtLabel}{d.checkedByName ? ` durch ${d.checkedByName}` : ""}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Card title="Kilometer und Energie">
          <dl className="px-4 py-3 grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
            {doc.readings.map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-ink-3">{r.label}</dt>
                <dd className={r.missing ? "text-bad font-medium" : "font-medium font-mono tnum"}>{r.missing ? "fehlt" : r.value}</dd>
              </div>
            ))}
            {doc.notes && <><dt className="text-ink-3">Bemerkung</dt><dd>{doc.notes}</dd></>}
          </dl>
        </Card>

        <Card title="Checkliste" right={<Chip>{doc.checklist.filter((c) => !c.missing).length} von {doc.checklist.length}</Chip>}>
          <ul className="divide-y divide-line-soft text-sm">
            {doc.checklist.map((c) => (
              <li key={c.label} className="px-4 py-2 flex items-start gap-3">
                <span className="flex-1">{c.label}{c.note && <span className="block text-xs text-ink-3">{c.note}</span>}</span>
                {c.missing ? <Chip tone="bad">fehlt</Chip> : c.ok === false ? <Chip tone="bad">{c.result}</Chip> : c.ok === true ? <Chip tone="good">{c.result}</Chip> : <span className="font-medium">{c.result || "–"}</span>}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Fahrzeugzustand" right={doc.type === "PICKUP" ? <><Chip>{existing} bereits dokumentiert</Chip><Chip tone={fresh > 0 ? "bad" : "grey"}>{fresh} neu entdeckt</Chip></> : <><Chip>{existing} vor Mietbeginn</Chip><Chip>{pickupNew} bei Übergabe</Chip><Chip tone={fresh > 0 ? "amber" : "grey"}>{fresh} bei Rückgabe festgestellt</Chip></>}>
        <div className="p-4">
          <DamageMap sketch={doc.sketch} damages={doc.damages} handoverId={handoverId} editable={false} type={doc.type} />
          {doc.sketch && <p className="text-[11px] text-ink-3 mt-2">Skizze: {doc.sketch.name}, Fassung {doc.sketch.version}</p>}
        </div>
      </Card>

      <Card title="Fotos" right={doc.missingPhotoCategories.length > 0 ? <Chip tone="bad">{doc.missingPhotoCategories.length} fehlen</Chip> : <Chip tone="good">{doc.photos.length}</Chip>}>
        {doc.photos.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-3">Noch keine Fotos aufgenommen.</p>
        ) : (
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {doc.photos.map((p) => (
              <figure key={p.id} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.categoryLabel} loading="lazy" className="w-full aspect-[4/3] object-cover rounded-md border border-line bg-panel-2" />
                <figcaption className="text-xs text-ink-2">{p.categoryLabel}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {doc.missingPhotoCategories.length > 0 && <p className="px-4 pb-3 text-sm text-bad">Es fehlen: {doc.missingPhotoCategories.join(", ")}</p>}
      </Card>

      {doc.type === "RETURN" && <ChargesTable doc={doc} />}

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
      {doc.contentHash && <p className="text-[11px] text-ink-3 font-mono break-all">Prüfsumme des versiegelten Protokolls: {doc.contentHash}</p>}
    </div>
  );
}

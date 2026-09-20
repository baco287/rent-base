// Bausteine des Übergabe-Assistenten ohne eigenen Zustand (werden auf dem Server gerendert).
import type { HandoverDocument } from "@/lib/handover-view";
import type { HandoverIssue } from "@/lib/handovers";
import { Card, Chip } from "@/components/ui";
import { DamageMap } from "./damage-map";

export const PICKUP_STEPS = ["Übersicht", "Kilometer & Energie", "Schäden", "Fotos", "Checkliste", "Unterschrift", "Abschluss"] as const;

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
export function HandoverDocumentView({ doc, handoverId, showSignatures = true }: { doc: HandoverDocument; handoverId: string; showSignatures?: boolean }) {
  const existing = doc.damages.filter((d) => d.marker === "EXISTING").length;
  const fresh = doc.damages.length - existing;
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

      <Card title="Fahrzeugzustand" right={<><Chip>{existing} bereits dokumentiert</Chip><Chip tone={fresh > 0 ? "bad" : "grey"}>{fresh} neu entdeckt</Chip></>}>
        <div className="p-4">
          <DamageMap sketch={doc.sketch} damages={doc.damages} handoverId={handoverId} editable={false} pickup={doc.type === "PICKUP"} />
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

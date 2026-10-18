// Befehl 29.6: Vertragsübersicht des Assistenten (Server-Komponenten). Zeigt den zuletzt GESPEICHERTEN Stand aus dem
// Vertragsdokument (doc) – keine Live-Berechnung, keine zweite Preisengine. Steht zweimal im DOM (Seitenleiste ab 1280 px,
// aufklappbar darunter) und enthält deshalb keine id-Attribute und keine Formularfelder.
import Link from "next/link";
import type { ReactNode } from "react";
import type { DocRow } from "@/lib/contract-view";
import { Chip } from "@/components/ui";
import { ContractIcon } from "./contract-icons";
import { KeyValueList, SummaryCard } from "./wizard-layout";
import type { OverviewData, ReadinessRow } from "./summary-map";

const row = "flex justify-between gap-3 border-b border-line-soft py-1.5 text-[13px]";
const Amount = ({ text, amount, strong = false }: { text: string; amount: string; strong?: boolean }) => (
  <div className={strong ? "mt-1 flex justify-between gap-3 border-t-2 border-ink pt-2 text-[14px] font-semibold" : row}>
    <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    <span className="whitespace-nowrap font-mono tnum">{amount}</span>
  </div>
);
/** Zwischenüberschrift: h3 in der Seitenleiste (unter der h2), h4 in der aufklappbaren Übersicht (unter einer unsichtbaren h3). */
type Level = 3 | 4;
const Sub = ({ level, children }: { level: Level; children: ReactNode }) => (level === 3 ? <h3 className="label-xs mt-1 !font-sans">{children}</h3> : <h4 className="label-xs mt-1">{children}</h4>);

/** Kaution und Selbstbeteiligung mit Originallabel – nicht Teil des Mietpreises. */
function Outside({ rows, level }: { rows: DocRow[]; level: Level }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col">
      <Sub level={level}>Außerhalb des Mietpreises</Sub>
      {rows.map((r) => <Amount key={r.label} text={r.label} amount={r.value} />)}
      <p className="mt-1.5 text-[12px] text-ink-2">Nicht Teil des Mietpreises, wird nicht addiert.</p>
    </div>
  );
}

/** Inhalt der Vertragsübersicht in den Schritten 1–5. stand "full": mit Hinweis auf „Speichern & weiter“. */
/** Gesamtmietpreis aus dem Vertragsdokument; bei offenem Ende der Text des Dokuments und darunter der Satz je Miettag. */
function Total({ p }: { p: OverviewData["price"] }) {
  return p.openEnd ? (
    <>
      <div className="mt-1 flex justify-between gap-3 border-t-2 border-ink pt-2 text-[14px] font-semibold"><span>Gesamtmietpreis</span><span className="text-right">{p.total}</span></div>
      {p.perDay && <p className="text-[12px] text-ink-2">{p.perDay}</p>}
    </>
  ) : (
    <Amount strong text="Gesamtmietpreis" amount={p.total} />
  );
}

export function OverviewBody({ data, stand, level = 3 }: { data: OverviewData; stand: "full" | "short"; level?: Level }) {
  const p = data.price;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div><Chip tone="amber">Entwurf</Chip></div>
        <p className="text-[12px] text-ink-2">{stand === "full" ? "Stand: zuletzt gespeichert. Änderungen erscheinen nach „Speichern & weiter“." : "Stand: zuletzt gespeichert"}</p>
      </div>
      <KeyValueList
        rows={[
          { label: "Fahrzeug", value: <><span className="font-mono">{data.vehicle.plate}</span><span className="block font-normal text-ink-2">{data.vehicle.title}</span></> },
          { label: "Zeitraum", value: <><span className="tnum">{data.period.from} – {data.period.to}</span><span className="block font-normal text-ink-2">{data.period.duration}</span></> },
          { label: "Tarif", value: data.tariff },
        ]}
      />
      <div className="flex flex-col">
        <Sub level={level}>Mietpreis</Sub>
        {p.lines.map((l, i) => <Amount key={i} text={l.text} amount={l.amount} />)}
        {p.discount && <Amount text={p.discount.text} amount={p.discount.amount} />}
        {p.agreed && <Amount text={p.agreed.text} amount={p.agreed.amount} />}
        {p.extras.map((e, i) => <Amount key={`x${i}`} text={e.text} amount={e.amount} />)}
        <Total p={p} />
      </div>
      <Outside rows={data.outside} level={level} />
    </>
  );
}

const READY_ICON = { ok: { name: "check", cls: "text-good" }, open: { name: "alert", cls: "text-amber" }, na: { name: "info", cls: "text-ink-2" } } as const;

/** Schritte 6 und 7: Bereitschaft je Bereich (nur Fehler zählen) und die Beträge. */
export function ReadinessBody({ rows, price, outside, level = 3 }: { rows: ReadinessRow[]; price: OverviewData["price"]; outside: DocRow[]; level?: Level }) {
  return (
    <>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {rows.map((r) => (
          <li key={r.label} className="flex items-start gap-2">
            <ContractIcon name={READY_ICON[r.state].name} size={16} className={`mt-px ${READY_ICON[r.state].cls}`} />
            <span className="min-w-0">{r.label}: <span className={r.state === "open" ? "font-medium" : ""}>{r.text}</span></span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col">
        <Total p={price} />
      </div>
      <Outside rows={outside} level={level} />
    </>
  );
}

/** Kurzübersicht für Schritt 7 (unter 1280 px sichtbar in der Hauptspalte, ab 1280 px in der Seitenleiste). Texte wie bisher. */
export function Step7Brief({ renter, plate, startAt, endAt, total, perDay, oneOff, deposit, href }: { renter: string; plate: string; startAt: string; endAt: string | null; total: string; perDay: string; oneOff: boolean; deposit: string; href: string }) {
  return (
    <SummaryCard label="Kurzübersicht" icon="file" title="Kurzübersicht">
      <KeyValueList
        rows={[
          { label: "Mieter", value: renter },
          { label: "Fahrzeug", value: <span className="font-mono">{plate}</span> },
          ...(endAt ? [{ label: "Zeitraum", value: <span className="tnum">{startAt} bis {endAt}</span> }] : [{ label: "Mietbeginn", value: <span className="tnum">{startAt}</span> }, { label: "Mietende", value: "offen – bis zur Rückgabe" }]),
          endAt ? { label: "Gesamtmietpreis", value: <span className="font-mono tnum">{total}</span> } : { label: "Mietpreis", value: <>{perDay} je Miettag{oneOff ? " zzgl. einmaliger Positionen" : ""}</> },
          { label: "Kaution", value: <span className="font-mono tnum">{deposit}</span> },
        ]}
      />
      <Link href={href} className="text-[13px] font-medium text-brand underline underline-offset-2">Vollständige Zusammenfassung ansehen</Link>
    </SummaryCard>
  );
}

/** Seitenleiste ab 1280 px: sticky, scrollt bei Überhöhe in sich (per Tastatur erreichbar). */
export function SummaryAside({ title, icon, children, extra }: { title: string; icon: "file" | "check"; children: ReactNode; extra?: ReactNode }) {
  return (
    <aside aria-label="Vertragsübersicht" tabIndex={0} className="sticky top-6 hidden max-h-[calc(100dvh-3rem)] flex-col gap-3 self-start overflow-y-auto overscroll-contain rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info xl:flex print:hidden">
      <section className="card min-w-0">
        <header className="flex items-center gap-3 px-4 pt-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><ContractIcon name={icon} /></span>
          <h2 className="!font-sans text-[15px] font-semibold">{title}</h2>
        </header>
        <div className="flex flex-col gap-3 px-4 pb-4 pt-3.5">{children}</div>
      </section>
      {extra}
    </aside>
  );
}

/** Unter 1280 px: aufklappbar unter dem Fortschritt. In <summary> nur Text (keine Überschrift, keine interaktiven Elemente). */
export function SummaryDisclosure({ title, figure, children }: { title: string; figure: string; children: ReactNode }) {
  return (
    <details className="card group overflow-hidden xl:hidden print:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-info [&::-webkit-details-marker]:hidden">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><ContractIcon name="file" /></span>
        <span className="flex-1 text-[15px] font-semibold">{title}</span>
        <span className="min-w-0 text-right font-mono text-[13px] tnum">{figure}</span>
        <ContractIcon name="chevron-down" size={16} className="text-ink-2 transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-line-soft px-4 py-3.5 md:grid-cols-2 [&>*]:min-w-0">
        <h3 className="sr-only">{title}</h3>
        {children}
      </div>
    </details>
  );
}

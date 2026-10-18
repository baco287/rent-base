// Befehl 29.6: Darstellungsbausteine des Mietvertragsassistenten (Karten, Raster, Stepper, Aktionsleiste).
// Ohne "use client" und ohne Hooks – werden auf dem Server gerendert; ActionBar rendern die Client-Formulare selbst.
// Keine Fachlogik: alle Werte kommen fertig aus page.tsx bzw. summary-map.ts.
import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { FormError } from "@/components/ui";
import { ContractIcon, type ContractIconName } from "./contract-icons";
import { WIZARD_STEPS } from "./steps";

/**
 * Eingabe-/Anzeigekarte eines Schritts. id ist ausdrücklich vergeben (eindeutig je Seite) und nie aus dem Titel abgeleitet;
 * der Titel ist eine h3 mit id `${id}-titel`. Ohne Titel benennt `label` die Karte (aria-label).
 */
export function WizardCard({ id, icon, title, right, label, className = "", bodyClassName, children }: { id: string; icon?: ContractIconName; title?: ReactNode; right?: ReactNode; label?: string; className?: string; bodyClassName?: string; children: ReactNode }) {
  const titleId = `${id}-titel`;
  return (
    <section id={id} aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : label} className={`card min-w-0 scroll-mt-4 ${className}`}>
      {title && (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-4 md:px-[18px]">
          {icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><ContractIcon name={icon} /></span>}
          <h3 id={titleId} className="flex-1 break-words hyphens-auto !font-sans text-[15px] font-semibold">{title}</h3>
          {right && <span className="ml-auto">{right}</span>}
        </header>
      )}
      <div className={bodyClassName ?? `flex flex-col gap-3 px-4 pb-4 md:px-[18px] ${title ? "pt-3.5" : "pt-4"}`}>{children}</div>
    </section>
  );
}

/** Karte der Vertragsübersicht: gleiche Optik, aber ohne jede id (die Übersicht steht zweimal im DOM). */
export function SummaryCard({ label, icon, title, right, children }: { label: string; icon?: ContractIconName; title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="card min-w-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-4">
        {icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><ContractIcon name={icon} /></span>}
        <h3 className="flex-1 break-words hyphens-auto !font-sans text-[15px] font-semibold">{title}</h3>
        {right && <span className="ml-auto">{right}</span>}
      </header>
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3.5">{children}</div>
    </section>
  );
}

/**
 * Kartenraster über eine Container-Abfrage: 1 Spalte, 2 ab 776 px Containerbreite (2 × 380 + 16), 3 ab 1172 px (nur max=3).
 * Der Container sitzt nur um das Raster – nie auf der Hauptspalte und nie um die Aktionsleiste. Kein dense: DOM- = Tab-Reihenfolge.
 */
export function CardsGrid({ max = 3, children }: { max?: 2 | 3; children: ReactNode }) {
  return (
    <div className="@container/cards min-w-0">
      <div className={`grid grid-cols-1 items-start gap-4 @min-[776px]/cards:grid-cols-2 ${max === 3 ? "@min-[1172px]/cards:grid-cols-3" : ""}`}>{children}</div>
    </div>
  );
}
/** Breite Karte (Fahrzeug & Nutzung, Zusatzfahrer hinzufügen): bei 2 Spalten volle Breite, bei 3 Spalten zwei Spalten. */
export const SPAN_WIDE = "@min-[776px]/cards:col-span-2";
export const SPAN_FULL = "col-span-full";

type StepState = "done" | "current" | "todo";
const stateOf = (n: number, current: number, reached: number): StepState => (n === current ? "current" : n <= reached ? "done" : "todo");
const STATE_TEXT: Record<StepState, string> = { done: "erledigt", current: "aktueller Schritt", todo: "noch offen" };
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";

/**
 * Fortschritt ab 640 px: Kreise mit Verbindungslinien. Erledigte und der aktuelle Schritt sind Links auf ?schritt=n (wie bisher,
 * speichert nicht); offene Schritte sind nicht anklickbar. Unter xl ist nur das aktuelle Label sichtbar (die übrigen sr-only).
 */
export function ContractStepper({ bookingId, current, reached }: { bookingId: string; current: number; reached: number }) {
  const base = `/buchungen/${bookingId}/vertrag`;
  return (
    <nav aria-label="Fortschritt" className="card hidden px-4 py-3.5 sm:block print:hidden">
      <ol className="-m-1 flex items-center overflow-x-auto p-1">
        {WIZARD_STEPS.map((label, i) => {
          const n = i + 1;
          const state = stateOf(n, current, reached);
          const circle = (
            <span aria-hidden="true" className={`grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] font-mono text-[12px] font-semibold ${state === "done" ? "border-brand bg-brand text-brand-ink" : state === "current" ? "border-brand bg-panel text-brand ring-4 ring-brand-soft" : "border-line bg-panel text-ink-3"}`}>
              {state === "done" ? <ContractIcon name="check" size={15} /> : n}
            </span>
          );
          const text = (
            <span className={`whitespace-nowrap text-[13px] ${state === "current" ? "font-semibold text-brand" : state === "done" ? "font-medium text-ink sr-only xl:not-sr-only" : "text-ink-2 sr-only xl:not-sr-only"}`}>
              {label}{state !== "current" && <span className="sr-only"> ({STATE_TEXT[state]})</span>}
            </span>
          );
          return (
            <li key={label} className={`flex items-center ${n < WIZARD_STEPS.length ? "flex-auto" : "shrink-0"}`}>
              {state === "todo" ? (
                <span className="flex shrink-0 items-center gap-2">{circle}{text}</span>
              ) : (
                <Link href={`${base}?schritt=${n}`} aria-current={state === "current" ? "step" : undefined} className={`flex shrink-0 items-center gap-2 rounded-md ${focusRing} ${state === "done" ? "hover:underline underline-offset-2" : ""}`}>
                  {circle}{text}
                </Link>
              )}
              {n < WIZARD_STEPS.length && <span aria-hidden="true" className={`mx-2.5 h-0.5 min-w-3 flex-1 rounded xl:mx-1.5 ${n < reached ? "bg-brand" : "bg-line"}`} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Fortschritt unter 640 px: „Schritt n von 7“ (aria-hidden, die h2 trägt denselben Text), die Schrittüberschrift, ein Balken
 * und „Alle Schritte“ mit denselben Links wie oben. Keine Pfeil-Links (sie würden ungespeicherte Eingaben verwerfen).
 */
export function MobileProgress({ bookingId, current, reached, heading }: { bookingId: string; current: number; reached: number; heading: ReactNode }) {
  const base = `/buchungen/${bookingId}/vertrag`;
  return (
    <div className="flex flex-col gap-2 sm:contents print:hidden">
      <span aria-hidden="true" className="text-[11.5px] text-ink-2 sm:hidden">Schritt {current} von {WIZARD_STEPS.length}</span>
      {heading}
      <div aria-hidden="true" className="grid grid-cols-7 gap-1 sm:hidden">
        {WIZARD_STEPS.map((label, i) => {
          const state = stateOf(i + 1, current, reached);
          return <span key={label} className={`h-1 rounded ${state === "done" ? "bg-brand" : state === "current" ? "bg-brand/55" : "bg-line"}`} />;
        })}
      </div>
      <details className="group/steps sm:hidden">
        <summary className={`inline-flex cursor-pointer list-none items-center gap-1 rounded text-[13px] font-medium text-brand [&::-webkit-details-marker]:hidden ${focusRing}`}>
          Alle Schritte <ContractIcon name="chevron-down" size={15} className="transition-transform group-open/steps:rotate-180" />
        </summary>
        <ol className="mt-2 flex flex-col gap-1 rounded-lg border border-line bg-panel p-2">
          {WIZARD_STEPS.map((label, i) => {
            const n = i + 1;
            const state = stateOf(n, current, reached);
            const inner = (
              <>
                <span aria-hidden="true" className={`grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] font-mono text-[11px] font-semibold ${state === "done" ? "border-brand bg-brand text-brand-ink" : state === "current" ? "border-brand text-brand" : "border-line text-ink-3"}`}>
                  {state === "done" ? <ContractIcon name="check" size={13} /> : n}
                </span>
                <span className={state === "current" ? "font-semibold text-brand" : state === "done" ? "text-ink" : "text-ink-2"}>{label}</span>
                {state !== "current" && <span className="sr-only"> ({STATE_TEXT[state]})</span>}
              </>
            );
            return (
              <li key={label}>
                {state === "todo" ? (
                  <span className="flex min-h-11 items-center gap-2.5 px-2 text-[13.5px]">{inner}</span>
                ) : (
                  <Link href={`${base}?schritt=${n}`} aria-current={state === "current" ? "step" : undefined} className={`flex min-h-11 items-center gap-2.5 rounded-md px-2 text-[13.5px] hover:bg-panel-2 ${focusRing}`}>{inner}</Link>
                )}
              </li>
            );
          })}
        </ol>
      </details>
    </div>
  );
}

/**
 * Aktionsleiste am unteren Rand der Hauptspalte – sticky auf allen Breiten (mobil randlos), nie fixed.
 * Wird von StepForm (variant "page") bzw. FinalizeForm (variant "bar") im selben <form> gerendert (Formular display: contents).
 * status (z. B. Abschlussgrund) ist auf allen Breiten sichtbar; info verschwindet mobil.
 */
export function ActionBar({ barRef, left, status, statusId, info, right, error }: { barRef?: Ref<HTMLDivElement>; left?: ReactNode; status?: ReactNode; statusId?: string; info?: string; right?: ReactNode; error?: string }) {
  return (
    <div
      ref={barRef}
      data-action-bar=""
      className="sticky bottom-0 z-20 mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-line bg-panel/95 px-4 py-3 shadow-[0_-6px_18px_rgba(15,27,45,0.06)] backdrop-blur print:hidden max-sm:-mx-5 max-sm:rounded-none max-sm:border-x-0 max-sm:pb-[calc(10px+env(safe-area-inset-bottom))] max-sm:group-data-[typing=true]/wizard:static"
    >
      {error && <div className="basis-full"><FormError error={error} /></div>}
      {left}
      {statusId !== undefined && (
        <span id={statusId} aria-live="polite" className="min-w-0 text-[12.5px] text-ink-2 max-sm:order-first max-sm:basis-full sm:flex-1">{status}</span>
      )}
      <span className={`min-w-0 text-[12.5px] text-ink-2 max-sm:hidden ${statusId !== undefined ? "" : "flex-1"}`}>{info}</span>
      {right}
    </div>
  );
}
export const BAR_BACK = `btn !py-2.5 max-sm:min-h-11 max-sm:min-w-11 justify-center ${focusRing}`;
export const BAR_NEXT = `btn btn-primary !py-2.5 !px-5 justify-center text-center max-sm:min-h-11 max-sm:flex-1 max-sm:whitespace-normal ${focusRing}`;

/** Hinweisbox (Erklärtext) mit Symbol. */
export function Note({ icon = "info", children, className = "" }: { icon?: ContractIconName; children: ReactNode; className?: string }) {
  return (
    <div className={`flex gap-2 rounded-lg bg-panel-2 px-3 py-2.5 text-[12.5px] text-ink-2 ${className}`}>
      <ContractIcon name={icon} size={16} className="mt-px" />
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/** Prüfhinweise, die eine ganze Karte betreffen (z. B. „Kaution darf nicht negativ sein.“) – dieselben Texte wie im Banner oben. */
export function CardIssueNote({ issues }: { issues: { code: string; message: string; severity: "error" | "warning" }[] | undefined }) {
  if (!issues?.length) return null;
  return (
    <ul className="col-span-full flex flex-col gap-1 rounded-md bg-panel-2 px-3 py-2 text-[12.5px]">
      {issues.map((i) => (
        <li key={i.code + i.message} className={`flex items-start gap-1.5 ${i.severity === "error" ? "font-medium text-bad" : "text-ink-2"}`}>
          <ContractIcon name={i.severity === "error" ? "alert" : "info"} size={14} className={`mt-px ${i.severity === "error" ? "" : "text-amber"}`} />
          <span className="min-w-0"><span className="sr-only">{i.severity === "error" ? "Fehler: " : "Hinweis: "}</span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Gesperrter Wert (laut Buchung bzw. Fallakte) – nur Anzeige, ohne Formularfelder. */
export function LockedBox({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-1 rounded-lg bg-panel-2 px-3 py-2.5 text-sm [overflow-wrap:anywhere] ${className}`}>{children}</div>;
}

/** Herkunft eines Wertes („Quelle: …“) bzw. Sperrhinweis. */
export function SourceHint({ locked = false, children }: { locked?: boolean; children: ReactNode }) {
  return (
    <span className="flex items-start gap-1 text-[11px] text-ink-2">
      <ContractIcon name={locked ? "lock" : "info"} size={12} className="mt-0.5" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** Beschriftete Werte (Anzeige). Werte umbrechen auch bei langen Wörtern. */
export function KeyValueList({ rows }: { rows: { label: ReactNode; value: ReactNode; mono?: boolean; bad?: boolean }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <dt className="min-w-0 break-words hyphens-auto text-ink-2">{r.label}</dt>
          <dd className={`min-w-0 [overflow-wrap:anywhere] ${r.bad ? "font-medium text-bad" : "font-medium"} ${r.mono ? "font-mono tnum" : ""}`}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Initialen (dekorativ). */
export function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
  return <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-semibold text-brand">{initials}</span>;
}

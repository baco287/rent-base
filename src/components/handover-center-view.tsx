// Befehl 29.7: gemeinsame Darstellung der Übergabe- und Rückgabezentrale (Server Component, keine Server Action).
// Kennzahlen, Suche, Filterleiste, Datumsfilter, Tabelle ab xl, Karten darunter, Paginierung. Aus der Liste wird nichts
// ausgelöst – jede Aktion ist ein Link auf eine bestehende Seite, die Rolle, Mandant und Stand selbst prüft.
// Suche und Datumsfilter laufen über next/form (GET, ohne JavaScript ein normales Formular); beide Formulare sind per key an
// den Adresszustand gekoppelt, damit nach einer Navigation im Client keine veralteten Eingaben stehen bleiben.
import Link from "next/link";
import Form from "next/form";
import type { ReactNode } from "react";
import { Card, Chip, Content, Plate } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";
import {
  CENTER_FILTERS, DAY_PARAM_MAX, DAY_PARAM_MIN, centerHref, usesDates,
  type CenterFilter, type CenterKind, type CenterRow, type CenterState, type CenterStatus, type CenterTone, type HandoverCenter,
} from "@/lib/handover-center";

const BADGE_TONE: Record<CenterTone, string> = {
  good: "bg-good-soft text-good",
  amber: "bg-amber-soft text-amber",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
  grey: "bg-panel-2 text-ink-2",
};
// Prüfbefund UI-5: kleine Hinweistexte mit ausreichendem Kontrast – „grau“ als ink-2 (ink-3 läge bei text-xs unter 4,5:1)
const TEXT_TONE: Record<CenterTone, string> = { good: "text-good", amber: "text-amber", bad: "text-bad", info: "text-ink-2", grey: "text-ink-2" };

const WORD: Record<CenterKind, { one: string; many: string; protocol: string }> = {
  PICKUP: { one: "Übergabe", many: "Übergaben", protocol: "Übergabeprotokolle" },
  RETURN: { one: "Rückgabe", many: "Rückgaben", protocol: "Rückgabeprotokolle" },
};

/** Leerzustand je Filter (ohne Suche und Datum) */
const EMPTY: Record<CenterKind, Partial<Record<CenterFilter, string>>> = {
  PICKUP: {
    heute: "Heute sind keine Übergaben geplant.",
    ueberfaellig: "Aktuell gibt es keine überfälligen Übergaben.",
    anstehend: "Ab morgen sind keine Übergaben geplant.",
    in_bearbeitung: "Gerade ist keine Übergabe begonnen.",
    abgeschlossen: "Noch keine abgeschlossenen Übergabeprotokolle.",
  },
  RETURN: {
    heute: "Heute sind keine Rückgaben geplant.",
    ueberfaellig: "Aktuell gibt es keine überfälligen Rückgaben.",
    anstehend: "Ab morgen sind keine Rückgaben geplant.",
    in_bearbeitung: "Gerade ist keine Rückgabe begonnen.",
    offenes_ende: "Keine Unfallersatzmiete mit offenem Mietende.",
    abgeschlossen: "Noch keine abgeschlossenen Rückgabeprotokolle.",
  },
};

export function HandoverCenterView({ c }: { c: HandoverCenter }) {
  const state: CenterState = { filter: c.filter, q: c.q, von: c.von, bis: c.bis };
  const href = (over: Partial<CenterState> & { seite?: number }) => centerHref(c.kind, state, over);
  const k = c.kpis;
  const w = WORD[c.kind];
  const id = c.kind === "PICKUP" ? "ue" : "rg";
  const filterLabel = CENTER_FILTERS[c.filter];
  const showOpenEnd = c.kind === "RETURN" && ((k.openEnd ?? 0) > 0 || c.filter === "offenes_ende");
  // Prüfbefund UI-1: next/form navigiert im Client, der Seitenbaum bleibt bei neuen Suchparametern erhalten – ein bereits
  // bearbeitetes Feld zeigte sonst nach „Suche löschen“, einer Kachel oder einem Filterwechsel den alten Wert. Der Schlüssel
  // aus dem Adresszustand baut die Formulare bei jeder Änderung neu auf (defaultValue greift wieder). Bewusst nicht natives
  // <form>: so bleibt die Navigation ohne Neuaufbau des Layouts (keine zusätzlichen Zählabfragen je Suche, Plan R7/R15).
  const formKey = `${c.filter}|${c.q}|${c.von}|${c.bis}`;

  return (
    <Content>
      {/* Kennzahlen: nur echte Daten des Mandanten, unabhängig von Suche und Filter */}
      <section aria-label="Kennzahlen" className={`grid gap-3 ${c.kind === "PICKUP" ? "grid-cols-2 lg:grid-cols-4" : showOpenEnd ? "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5" : "grid-cols-2 lg:grid-cols-4"}`}>
        <KpiTile href={href({ filter: "heute", q: "" })} label="Heute geplant" value={k.today} tone={k.today > 0 ? "amber" : undefined}
          detail={c.kind === "RETURN" && (k.keyDropPending ?? 0) > 0 ? `davon ${k.keyDropPending} Kontrolle ausstehend` : c.kind === "PICKUP" ? "Abholungen heute" : "Rückgaben heute"} />
        <KpiTile href={href({ filter: "ueberfaellig", q: "" })} label="Überfällig" value={k.overdue}
          tone={k.overdue > 0 ? (c.kind === "RETURN" ? "bad" : "amber") : undefined}
          detail={c.kind === "PICKUP" ? "Abholtermin verstrichen" : "Mietende überschritten"} />
        <KpiTile href={href({ filter: "anstehend", q: "", von: "", bis: k.soonBis })} label="Nächste 7 Tage" value={k.soon} detail={`ab morgen bis ${fmtDate(k.soonUntil)}`} />
        <KpiTile href={href({ filter: "in_bearbeitung", q: "" })} label="In Bearbeitung" value={k.inProgress} detail={`${w.one} begonnen`} />
        {showOpenEnd && (
          <KpiTile href={href({ filter: "offenes_ende", q: "" })} label="Offenes Mietende" value={k.openEnd ?? 0}
            detail={(k.openEndExceeded ?? 0) > 0 ? <span className="text-bad">davon {k.openEndExceeded} geplantes Mietende überschritten</span> : "Unfallersatz · Vertrag bis zur Rückgabe"} />
        )}
      </section>

      <Form action={c.path} role="search" key={`suche|${formKey}`} className="flex flex-col sm:flex-row gap-2">
        {c.filter !== "heute" && <input type="hidden" name="filter" value={c.filter} />}
        {c.von && <input type="hidden" name="von" value={c.von} />}
        {c.bis && <input type="hidden" name="bis" value={c.bis} />}
        <label className="sr-only" htmlFor={`${id}-q`}>{w.many} durchsuchen</label>
        <input id={`${id}-q`} name="q" defaultValue={c.q} maxLength={80} placeholder="Kennzeichen, Kunde, Buchungsnummer, Fahrzeug" className="input flex-1 min-w-0" />
        <div className="flex gap-2">
          <button className="btn btn-primary justify-center flex-1 sm:flex-none">Suchen</button>
          {c.q && <Link href={href({ q: "" })} className="btn justify-center flex-1 sm:flex-none">Suche löschen</Link>}
        </div>
      </Form>

      <nav aria-label="Filter" className="flex flex-wrap gap-2">
        {c.filters.map((f) => (
          <Link key={f} href={href({ filter: f })} aria-current={f === c.filter ? "page" : undefined} className={`btn !py-1.5 ${f === c.filter ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>
            {CENTER_FILTERS[f]}
          </Link>
        ))}
      </nav>

      {usesDates(c.filter) && (
        <Form action={c.path} key={`zeitraum|${formKey}`} className="flex flex-wrap items-end gap-2" aria-label="Zeitraum">
          <input type="hidden" name="filter" value={c.filter} />
          {c.q && <input type="hidden" name="q" value={c.q} />}
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={`${id}-von`} className="label-xs">{c.filter === "abgeschlossen" ? "Abgeschlossen von" : "von"}</label>
            <input id={`${id}-von`} type="date" name="von" defaultValue={c.von} min={DAY_PARAM_MIN} max={DAY_PARAM_MAX} className="input" />
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={`${id}-bis`} className="label-xs">bis (einschließlich)</label>
            <input id={`${id}-bis`} type="date" name="bis" defaultValue={c.bis} min={DAY_PARAM_MIN} max={DAY_PARAM_MAX} className="input" />
          </div>
          <div className="flex gap-2">
            <button className="btn">Anwenden</button>
            {(c.von || c.bis) && <Link href={href({ von: "", bis: "" })} className="btn">Zurücksetzen</Link>}
          </div>
        </Form>
      )}
      {/* Prüfbefunde UI-2/UI-5: Rolle status am Container (die Liste behält ihre Semantik), lesbarer Text auf Amber-Fläche */}
      {c.notes.length > 0 && (
        <div role="status" className="text-xs text-ink-2 bg-amber-soft border-l-4 border-l-amber rounded-md px-3 py-2">
          <ul className="flex flex-col gap-1">
            {c.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      )}
      {c.viewer.support && <p className="text-xs text-ink-2">Supportmodus: nur lesend – Assistenten und Protokolle sind gesperrt, geöffnet werden kann nur die Buchung.</p>}

      {/* Prüfbefund UI-3: lange Suchbegriffe ohne Leerzeichen brechen um (kein horizontales Scrollen auf dem Handy) */}
      <Card title={<>{filterLabel}{c.q && <> · Suche „<span className="[overflow-wrap:anywhere]">{c.q}</span>“</>}</>} right={<Chip>{c.total}</Chip>}>
        {c.rows.length === 0 ? (
          <EmptyState c={c} href={href} />
        ) : (
          <>
            {/* Handy, Tablet und schmaler Desktop: Karten (keine gequetschte Tabelle, kein horizontales Scrollen) */}
            <ul className="xl:hidden divide-y divide-line-soft">
              {c.rows.map((r) => <RowCard key={r.key} r={r} />)}
            </ul>
            {/* Desktop: kompakte Tabelle mit festen Spalten (ab xl – daneben steht die 232 px breite Seitenleiste) */}
            <div className="hidden xl:block overflow-x-auto">
              <table className="w-full text-[13.5px] table-fixed">
                <caption className="sr-only">{w.many} – {filterLabel}</caption>
                <thead>
                  <tr className="text-left">
                    {/* Prüfbefund UI-4: die textreiche Spalte „Hinweise“ bekommt den Rest (bei 1280 px etwa 280 px) */}
                    <th className="label-xs px-3 py-2 border-b border-line w-[12%]">Fahrzeug</th>
                    <th className="label-xs px-3 py-2 border-b border-line w-[15%]">Kunde · Buchung</th>
                    <th className="label-xs px-3 py-2 border-b border-line w-[14%]">Termin</th>
                    <th className="label-xs px-3 py-2 border-b border-line w-[13%]">Status</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Hinweise</th>
                    <th className="label-xs px-3 py-2 border-b border-line w-[176px]">Aktionen</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((r) => (
                    <tr key={r.key} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60 align-top">
                      <td className="px-3 py-2.5 min-w-0">
                        <Plate>{r.vehicle.plate}</Plate>
                        <div className="text-xs text-ink-3 truncate mt-1" title={r.vehicle.label}>{r.vehicle.label}</div>
                      </td>
                      <td className="px-3 py-2.5 min-w-0">
                        <div className="truncate font-medium" title={r.customer}>{r.customer}</div>
                        <Link href={r.booking.href} className="font-mono tnum text-xs hover:underline">{r.booking.number}</Link>
                        <Chips r={r} />
                      </td>
                      <td className="px-3 py-2.5"><Termin r={r} /></td>
                      <td className="px-3 py-2.5 min-w-0"><StatusBadge s={r.status} /></td>
                      <td className="px-3 py-2.5 min-w-0"><Hints r={r} /></td>
                      <td className="px-3 py-2.5"><RowActions r={r} layout="column" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {c.pages > 1 && (
        <nav aria-label="Seiten" className="flex flex-wrap items-center gap-2 text-sm">
          {c.page > 1 && <Link href={href({ seite: c.page - 1 })} className="btn !py-1.5">Zurück</Link>}
          <span className="text-ink-3">Seite {c.page} von {c.pages} · {c.total} {c.total === 1 ? "Eintrag" : "Einträge"}</span>
          {c.page < c.pages && <Link href={href({ seite: c.page + 1 })} className="btn !py-1.5">Weiter</Link>}
        </nav>
      )}
      <p className="text-xs text-ink-3 max-w-[80ch]">Alle Prüfungen (Vertrag, Fahrer, Verfügbarkeit, Unterschriften) laufen im Assistenten; aus dieser Liste wird nichts ausgelöst.</p>
    </Content>
  );
}

function KpiTile({ href, label, value, detail, tone }: { href: string; label: string; value: number; detail: ReactNode; tone?: "amber" | "bad" }) {
  return (
    <Link href={href} className={`rounded-lg px-3.5 py-2.5 flex flex-col gap-0.5 min-w-0 hover:ring-1 hover:ring-line ${tone === "bad" ? "bg-bad-soft" : tone === "amber" ? "bg-amber-soft" : "bg-panel-2"}`}>
      <span className="label-xs">{label}</span>
      <span className={`font-display text-2xl font-semibold leading-tight tnum ${tone === "bad" ? "text-bad" : tone === "amber" ? "text-amber" : ""}`}>{value}</span>
      <span className="text-xs text-ink-2 break-words">{detail}</span>
    </Link>
  );
}

/** Status als Text mit Farbe (nicht nur Farbe); bricht um – .chip aus ui.tsx bricht nie um und hat kein className. */
function StatusBadge({ s }: { s: CenterStatus }) {
  return (
    <span className="flex flex-col items-start gap-0.5 min-w-0">
      <span className={`chip !whitespace-normal max-w-full ${BADGE_TONE[s.tone]}`}>{s.label}</span>
      {s.detail && <span className="text-xs text-ink-3 break-words">{s.detail}</span>}
    </span>
  );
}

function Chips({ r }: { r: CenterRow }) {
  if (r.chips.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {r.chips.map((x) => <span key={x.label} className={`chip !whitespace-normal max-w-full ${BADGE_TONE[x.tone]}`}>{x.label}</span>)}
    </span>
  );
}

function Termin({ r, inline = false }: { r: CenterRow; inline?: boolean }) {
  const planned = (
    <>
      {r.planned.at && <span className="tnum">{fmtDateTime(r.planned.at)}</span>}
      {r.planned.text && <span className={r.planned.at ? "text-xs text-ink-3" : "font-medium"}>{r.planned.at ? ` ${r.planned.text}` : r.planned.text}</span>}
      {r.planned.before && <span className="text-xs text-ink-3"> (vorher {fmtDateTime(r.planned.before)})</span>}
    </>
  );
  const actual = r.actual.length === 0 ? <span className="text-ink-3">–</span> : r.actual.map((a, i) => <span key={a.label} className="tnum">{i > 0 && " · "}{a.label} {fmtDateTime(a.at)}</span>);
  if (inline) {
    return (
      <div className="text-sm flex flex-col gap-0.5 min-w-0 break-words">
        <span><span className="text-ink-3">Geplant: </span>{planned}</span>
        <span><span className="text-ink-3">Tatsächlich: </span>{actual}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="label-xs">Geplant</span>
      <span className="break-words">{planned}</span>
      <span className="label-xs mt-1">Tatsächlich</span>
      <span className="text-xs break-words">{actual}</span>
    </div>
  );
}

function Hints({ r }: { r: CenterRow }) {
  if (r.hints.length === 0) return <span className="text-xs text-ink-3">–</span>;
  return (
    <ul className="flex flex-col gap-1 text-xs min-w-0">
      {r.hints.map((h) => <li key={h.text} className={`break-words ${TEXT_TONE[h.tone]}`}>{h.text}</li>)}
    </ul>
  );
}

const ACTION_BTN = "btn !py-1.5 text-[13px] min-h-11 xl:min-h-0 min-w-0 w-full justify-center text-center !whitespace-normal";

/** Primäraktion (Assistent, Protokoll, Vertrag) oben bzw. links, darunter „Buchung öffnen“ – gleiche Breite. */
function RowActions({ r, layout }: { r: CenterRow; layout: "column" | "bar" }) {
  return (
    <div className={layout === "column" ? "flex flex-col gap-1.5" : "grid grid-cols-1 sm:grid-cols-2 gap-2"}>
      {r.action && <Link href={r.action.href} className={`${ACTION_BTN} btn-primary`}>{r.action.label}</Link>}
      <Link href={r.open.href} className={`${ACTION_BTN} ${layout === "bar" && !r.action ? "sm:col-span-2" : ""}`}>{r.open.label}</Link>
    </div>
  );
}

function RowCard({ r }: { r: CenterRow }) {
  return (
    <li className="px-4 py-3 flex flex-col gap-2 min-w-0">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <Plate>{r.vehicle.plate}</Plate>
        <span className="text-sm text-ink-2 min-w-0 break-words">{r.vehicle.label}</span>
        <StatusBadge s={r.status} />
      </div>
      <div className="text-sm min-w-0 break-words">
        <span className="font-medium">{r.customer}</span>
        <span className="text-ink-3"> · </span>
        <Link href={r.booking.href} className="font-mono tnum hover:underline">Buchung {r.booking.number}</Link>
        <Chips r={r} />
      </div>
      <Termin r={r} inline />
      {r.hints.length > 0 && <Hints r={r} />}
      <RowActions r={r} layout="bar" />
    </li>
  );
}

function EmptyState({ c, href }: { c: HandoverCenter; href: (over: Partial<CenterState> & { seite?: number }) => string }) {
  const filtered = !!c.q || c.dated;
  const label = CENTER_FILTERS[c.filter];
  const text = filtered
    ? c.q ? `Keine Treffer für „${c.q}“ in „${label}“.` : `Keine Einträge im gewählten Zeitraum in „${label}“.`
    : EMPTY[c.kind][c.filter] ?? "Keine Einträge.";
  // Prüfbefund UI-6: Beschriftung nach Wirkung – der gewählte Reiter (Filter) bleibt bewusst erhalten
  const resetLabel = c.q && c.dated ? "Suche und Zeitraum zurücksetzen" : c.q ? "Suche löschen" : "Zeitraum zurücksetzen";
  const links: { href: string; label: string }[] = filtered
    ? [{ href: href({ q: "", von: "", bis: "" }), label: resetLabel }]
    : [
      ...(c.filter === "heute" && c.kpis.overdue > 0 ? [{ href: href({ filter: "ueberfaellig" }), label: `${c.kpis.overdue} überfällige ansehen` }] : []),
      { href: "/buchungen", label: "Zu den Buchungen" },
      { href: "/dispo", label: "Dispo-Kalender" },
    ];
  return (
    <div className="px-4 py-6 text-center text-sm text-ink-2 flex flex-col items-center gap-3">
      <p className="max-w-full [overflow-wrap:anywhere]">{text}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {links.map((l) => <Link key={l.href} href={l.href} className="btn !py-1.5">{l.label}</Link>)}
      </div>
    </div>
  );
}

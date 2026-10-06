import Link from "next/link";
import { requireFeature } from "@/lib/auth";
import { caseFileAccess } from "@/lib/accident-case-file";
import { accidentCenter, CENTER_FILTERS, centerFilters, TASK_GROUP_LABELS, TASK_VIEWS, type CenterRow, type CenterTask, type CenterTasks, type TaskViewKey } from "@/lib/accident-center";
import { Card, Chip, Content, Empty, PageHeader, Plate } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { completeFollowUpAction } from "./[id]/actions";
import { FollowUpDoneAction } from "./[id]/case-forms";

export const metadata = { title: "Unfallersatz" };

/**
 * Befehl 29 Phase G: Unfallersatz-Zentrale – das tägliche Arbeitscockpit. Nur mit freigeschaltetem Modul (Modul-Layout und hier).
 * Inhaber und Disposition: vollständige Sicht mit Versicherung, Abrechnung und Wiedervorlagen. Hof und Supportmodus: operative Sicht –
 * Versicherungs-, Finanz- und Wiedervorlagendaten werden serverseitig gar nicht geladen (accidentCenter). Suche, Filter und Seite
 * stehen in der Adresse (filter, q, seite). Bearbeitet wird in der Fallakte; aus der Liste gibt es nur sichere Links.
 * Phase H: Wiedervorlagen als Arbeitsliste (eigene kleine Filter, Adresse aufgaben=…) mit „Erledigen“ über dieselbe Server-Aktion
 * wie in der Fallakte; nur Vollsicht.
 */
export default async function AccidentCenterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant, user, supportSession } = await requireFeature("ACCIDENT_REPLACEMENT");
  const sp = await searchParams;
  // Supportmodus läuft als YARD (auth.getSession) → operative Sicht
  const access = supportSession ? "OPERATIONAL" : caseFileAccess(user.role);
  const full = access === "FULL";
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const page = Math.max(1, parseInt(one(sp.seite) ?? "1", 10) || 1);
  const c = await accidentCenter(tenant.id, { access, filter: one(sp.filter), q: one(sp.q), page, tasks: one(sp.aufgaben), userId: user.id });
  const qs = (over: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | number | null> = { filter: c.filter === "offen" ? null : c.filter, q: c.q || null, seite: null, aufgaben: c.tasks?.view ?? null, ...over };
    for (const [k, v] of Object.entries(merged)) if (v != null && v !== "" && !(k === "filter" && v === "offen") && !(k === "seite" && v === 1)) p.set(k, String(v));
    const s = p.toString();
    return s ? `/unfallersatz?${s}` : "/unfallersatz";
  };
  const k = c.kpis;
  const filtered = c.filter !== "offen" || !!c.q;

  return (
    <>
      <PageHeader title="Unfallersatz" sub="Ersatzmieten, Schadenfälle, Abrechnung und offene Aufgaben im Blick behalten.">
        {full && <Link href="/unfallersatz/neu" className="btn btn-primary !py-2.5 w-full sm:w-auto justify-center text-center">+ Unfallersatzfall</Link>}
      </PageHeader>
      <Content>
        {/* Kennzahlen: nur operative Größen aus echten Daten; kaufmännische nur in der Vollsicht (für den Hof nicht geladen) */}
        <section aria-label="Kennzahlen" className={`grid grid-cols-2 sm:grid-cols-3 ${full ? "lg:grid-cols-5" : ""} gap-3`}>
          <KpiTile href={qs({ filter: "offen", q: null })} label="Offene Fälle" value={String(k.open)} detail="nicht abgeschlossen" />
          <KpiTile href={qs({ filter: "laufend", q: null })} label="Laufende Mieten" value={String(k.running)} detail="übergeben, noch nicht zurück" />
          {!full && <KpiTile href={qs({ filter: "uebergabe", q: null })} label="Reserviert / Übergabe offen" value={String(k.reserved)} detail="noch nicht übergeben" />}
          {full && <KpiTile href={qs({ filter: "abzurechnen", q: null })} label="Abzurechnen" value={String(k.toInvoice ?? 0)} detail="zurückgegeben, Schlussrechnung fehlt" tone={(k.toInvoice ?? 0) > 0 ? "amber" : undefined} />}
          {full && <KpiTile href={qs({ filter: "rechnung_offen", q: null })} label="Offene Forderungen" value={fmtCents(k.receivablesCents ?? 0)} detail={`${k.receivablesCases ?? 0} ${k.receivablesCases === 1 ? "Fall" : "Fälle"} · Kürzungen mindern nicht`} tone={(k.receivablesCents ?? 0) > 0 ? "amber" : undefined} />}
          {full && <KpiTile href={`${qs({ aufgaben: "faellig" })}#wiedervorlagen`} label="Fällige Wiedervorlagen" value={String(k.followUpsDue ?? 0)} detail="heute und überfällig" tone={(k.followUpsDue ?? 0) > 0 ? "bad" : undefined} />}
        </section>

        {/* Phase H: Arbeitsliste der Wiedervorlagen – nur Vollsicht, nur wenn es offene Fälle gibt */}
        {c.tasks && k.open > 0 && <TaskBoard t={c.tasks} qs={qs} />}

        <form action="/unfallersatz" role="search" className="flex flex-col sm:flex-row gap-2">
          {c.filter !== "offen" && <input type="hidden" name="filter" value={c.filter} />}
          {c.tasks?.view && <input type="hidden" name="aufgaben" value={c.tasks.view} />}
          <label className="sr-only" htmlFor="ue-q">Unfallersatzfälle durchsuchen</label>
          <input id="ue-q" name="q" defaultValue={c.q} maxLength={80} placeholder={full ? "Fallnummer, Kunde, Kennzeichen, Versicherung, Schadennummer" : "Fallnummer, Kunde, Kennzeichen"} className="input flex-1 min-w-0" />
          <div className="flex gap-2">
            <button className="btn btn-primary justify-center flex-1 sm:flex-none">Suchen</button>
            {c.q && <Link href={qs({ q: null })} className="btn justify-center flex-1 sm:flex-none">Suche löschen</Link>}
          </div>
        </form>

        <nav aria-label="Filter" className="flex gap-1.5 flex-wrap">
          {centerFilters(c.access).map((f) => (
            <Link key={f} href={qs({ filter: f })} aria-current={f === c.filter ? "page" : undefined} className={`btn !py-1.5 ${f === c.filter ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>
              {CENTER_FILTERS[f]}{c.counts[f] != null && <span className="ml-1.5 tnum opacity-75">{c.counts[f]}</span>}
            </Link>
          ))}
        </nav>

        <Card title={`${CENTER_FILTERS[c.filter]}${c.q ? ` · Suche „${c.q}“` : ""}`} right={<Chip>{c.total}</Chip>}>
          {!c.anyCases ? (
            <Empty action={full ? { href: "/unfallersatz/neu", label: "Ersten Unfallersatzfall anlegen" } : undefined}>Noch keine Unfallersatzfälle.</Empty>
          ) : c.rows.length === 0 ? (
            <Empty action={filtered ? { href: "/unfallersatz", label: "Filter zurücksetzen" } : undefined}>{filtered ? "Keine Fälle entsprechen den gewählten Filtern." : "Keine offenen Unfallersatzfälle."}</Empty>
          ) : (
            <>
              {/* Handy, Tablet und schmaler Desktop: Karten (keine gequetschte Tabelle) */}
              <ul className="xl:hidden divide-y divide-line-soft">
                {c.rows.map((r) => <CaseCard key={r.id} r={r} full={full} />)}
              </ul>
              {/* Desktop: kompakte Tabelle (feste Spaltenbreiten, lange Namen gekürzt mit Tooltip) */}
              <div className="hidden xl:block overflow-x-auto">
                <table className="w-full text-[13.5px] table-fixed">
                  <thead>
                    <tr className="text-left">
                      <th className="label-xs px-3 py-2 border-b border-line w-[19%]">Fall · Kunde</th>
                      <th className="label-xs px-3 py-2 border-b border-line w-[12%]">Fahrzeug</th>
                      {full && <th className="label-xs px-3 py-2 border-b border-line w-[16%]">Versicherung</th>}
                      <th className="label-xs px-3 py-2 border-b border-line w-[14%]">Zeitraum</th>
                      <th className="label-xs px-3 py-2 border-b border-line">Stand · Nächster Schritt</th>
                      {/* Phase H: eigene, feste Aktionsspalte – Primäraktion oben, darunter „Fall öffnen“ */}
                      <th className="label-xs px-3 py-2 border-b border-line w-[164px]">Aktionen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.rows.map((r) => (
                      <tr key={r.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60 align-top">
                        <td className="px-3 py-2.5 min-w-0">
                          <Link href={`/unfallersatz/${r.id}`} className="font-mono tnum font-semibold hover:underline whitespace-nowrap">{r.caseNumber}</Link>
                          <div className="truncate" title={r.customer.name}>{r.customer.name}</div>
                        </td>
                        <td className="px-3 py-2.5 min-w-0">
                          <Plate>{r.vehicle.plate}</Plate>
                          <div className="text-xs text-ink-3 truncate mt-1" title={r.vehicle.label}>{r.vehicle.label}</div>
                          {r.full && r.full.damagedPlate && <div className="text-xs text-ink-3 truncate" title={`beschädigt ${r.full.damagedPlate}`}>beschädigt <span className="font-mono">{r.full.damagedPlate}</span></div>}
                        </td>
                        {full && <td className="px-3 py-2.5 min-w-0"><InsuranceFacts r={r} /></td>}
                        <td className="px-3 py-2.5"><PeriodText r={r} stacked /></td>
                        <td className="px-3 py-2.5 min-w-0"><div className="flex flex-col gap-1.5"><StatusFacts r={r} /><NextStepFacts r={r} /></div></td>
                        <td className="px-3 py-2.5"><RowActions r={r} full={full} layout="column" /></td>
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
            {c.page > 1 && <Link href={qs({ seite: c.page - 1 })} className="btn !py-1.5">Zurück</Link>}
            <span className="text-ink-3">Seite {c.page} von {c.pages} · {c.total} {c.total === 1 ? "Fall" : "Fälle"}</span>
            {c.page < c.pages && <Link href={qs({ seite: c.page + 1 })} className="btn !py-1.5">Weiter</Link>}
          </nav>
        )}
        {c.truncated && <p className="text-xs text-ink-3">Es gibt mehr offene Fälle, als hier gemeinsam priorisiert werden. Bitte über Suche oder Filter eingrenzen.</p>}
        <p className="text-xs text-ink-3 max-w-[80ch]">{full ? "Sortiert nach Handlungsbedarf: überfällige Wiedervorlagen und kritische Punkte zuerst, dann heute Fälliges, Abzurechnendes, offene Rechnungen, anstehende Übergaben und Rückgaben, laufende und reservierte Mieten. Bearbeitet wird in der Fallakte." : "Sortiert nach Dringlichkeit: überschrittenes Mietende, anstehende Übergaben und Rückgaben, laufende und reservierte Mieten. Details in der Fallakte."}</p>
      </Content>
    </>
  );
}

function KpiTile({ href, label, value, detail, tone }: { href: string; label: string; value: string; detail: string; tone?: "amber" | "bad" }) {
  return (
    <Link href={href} className={`rounded-lg px-3.5 py-3 flex flex-col gap-0.5 min-w-0 hover:ring-1 hover:ring-line ${tone === "bad" ? "bg-bad-soft" : tone === "amber" ? "bg-amber-soft" : "bg-panel-2"}`}>
      <span className="label-xs">{label}</span>
      <span className={`font-display text-3xl font-semibold leading-tight tnum ${tone === "bad" ? "text-bad" : tone === "amber" ? "text-amber" : ""}`}>{value}</span>
      <span className="text-xs text-ink-2">{detail}</span>
    </Link>
  );
}

/** Zeitraum: offenes Ende ohne künstliches Enddatum, geplantes Ende, tatsächlicher Zeitraum nach Rückgabe */
function PeriodText({ r, stacked = false }: { r: CenterRow; stacked?: boolean }) {
  const p = r.period;
  const daysText = p.days != null ? `${p.days} ${p.days === 1 ? "Miettag" : "Miettage"}` : null;
  const sep = stacked ? null : " · ";
  const second = (parts: (string | React.ReactNode | null)[]) => {
    const items = parts.filter(Boolean);
    if (items.length === 0) return null;
    return stacked ? <span className="block text-xs text-ink-3">{items.map((x, i) => <span key={i}>{i > 0 && " · "}{x}</span>)}</span> : <span className="text-ink-3">{items.map((x, i) => <span key={i}>{sep}{x}</span>)}</span>;
  };
  if (p.kind === "CANCELLED") return <span className="text-ink-3">storniert</span>;
  if (p.kind === "ACTUAL") return <span className="tnum">{fmtDate(p.from)} → {fmtDate(p.until)}{second([daysText])}</span>;
  const started = r.booking.status === "ACTIVE";
  if (p.kind === "OPEN") return <span className="tnum">{started ? "seit" : "ab"} {fmtDate(p.from)}{stacked ? <span className="block font-medium">Mietende offen</span> : <> · <span className="font-medium">Mietende offen</span></>}{second([daysText])}</span>;
  return <span className="tnum">{fmtDate(p.from)} → {fmtDate(p.until)}{second(["geplant", daysText])}</span>;
}

function InsuranceFacts({ r }: { r: CenterRow }) {
  if (!r.full) return null;
  const f = r.full;
  const unclear = f.liability.status === "UNKNOWN" || f.liability.status === "REPORTED" || f.liability.status === "UNCLEAR";
  return (
    <div className="flex flex-col gap-0.5 text-xs min-w-0">
      <span className="block text-[13.5px] truncate" title={f.insurerName ?? undefined}>{f.insurerName ?? <span className="text-ink-3">Versicherung fehlt</span>}</span>
      {f.claimNumber ? <span className="block font-mono text-ink-2 truncate" title={f.claimNumber}>{f.claimNumber}</span> : <span className="text-amber">Schadennummer fehlt</span>}
      {r.status === "OPEN" && (unclear ? <span className="text-amber">Haftung ungeklärt</span> : f.liability.status === "QUOTA" && f.liability.quotaPercent != null ? <span className="text-ink-3">Haftung {f.liability.quotaPercent} %</span> : <span className="text-ink-3">{f.liability.label}</span>)}
    </div>
  );
}

/** Hauptzustand (abgeleitet) und – in der Vollsicht – kompakter Abrechnungsstand */
function StatusFacts({ r }: { r: CenterRow }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Chip tone={r.status === "CLOSED" ? "grey" : r.mainStatus.tone}>{r.mainStatus.label}</Chip>
      {r.status === "CLOSED" && r.closedAt && <span className="text-xs text-ink-3 whitespace-nowrap">am {fmtDate(r.closedAt)}</span>}
      <BillingLine r={r} />
    </div>
  );
}

/** Abrechnung kompakt (nur Vollsicht, nur wenn abgerechnet wird oder werden muss) – Details in der Fallakte → Abrechnung */
function BillingLine({ r }: { r: CenterRow }) {
  const b = r.full?.billing;
  if (!b || r.status !== "OPEN" || !(r.booking.status === "RETURNED" || b.active > 0 || b.drafts > 0)) return null;
  return (
    <span className="text-xs text-ink-2">
      {b.active === 0 ? (b.drafts > 0 ? "Rechnung im Entwurf" : "noch nicht abgerechnet") : <>{fmtCents(b.grossCents)} fakturiert · {b.economicOpenCents > 0 ? <span className="text-amber">{fmtCents(b.economicOpenCents)} offen</span> : <span className="text-good">bezahlt</span>}</>}
      {b.reducedCents > 0 && <> · Kürzung {fmtCents(b.reducedCents)}</>}
      {b.doubleClaimCents > 0 && <> · <span className="text-bad">Doppelforderung</span></>}
    </span>
  );
}

const stepColor = { bad: "text-bad", amber: "text-amber", info: "text-info", grey: "text-ink-3" } as const;

/** Wichtigster nächster Schritt (aus der Fallakte) und Zahl weiterer – nicht alle Warnungen in die Zeile */
function NextStepFacts({ r }: { r: CenterRow }) {
  if (r.status === "CLOSED") return <span className="text-xs text-ink-3">Fallakte lesbar · Wiedereröffnen dort</span>;
  if (!r.lead) return <span className="text-xs text-ink-3">kein Handlungsbedarf</span>;
  const others = r.steps.filter((s) => s !== r.lead && s.code !== "CLOSED");
  const next = r.full?.followUps;
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className={`font-medium ${stepColor[r.lead.tone]}`} title={r.lead.text}>{r.lead.short}</span>
      {r.more > 0 && <span className="text-xs text-ink-3" title={others.map((s) => s.short).join(" · ")}>+{r.more} {r.more === 1 ? "weiterer" : "weitere"}</span>}
      {next && next.nextDueAt && next.overdue + next.today === 0 && <span className="text-xs text-ink-3">Wiedervorlage {fmtDate(next.nextDueAt)}</span>}
    </div>
  );
}

const ACTION_BTN = "btn !py-1.5 text-[13px] justify-center text-center w-full";

/**
 * Phase H: Aktionsfläche je Fall. Operative Primäraktion (Übergabe, Rückgabe, Abrechnung – aus actionOf, für den Hof ohne
 * Abrechnung) dunkel oben, darunter „Fall öffnen“; gleiche Breite und Höhe. Ohne Primäraktion nur „Fall öffnen“ – kein Platzhalter.
 * Desktop: Spalte; Handy/Tablet: volle Breite unter der Karte. „+ Wiedervorlage“ nur Vollsicht bei offenem Fall (fallbezogen).
 */
function RowActions({ r, full, layout }: { r: CenterRow; full: boolean; layout: "column" | "bar" }) {
  const followUp = full && r.status === "OPEN";
  return (
    <div className={layout === "column" ? "flex flex-col gap-1.5" : `grid gap-2 ${r.action ? "grid-cols-2" : "grid-cols-1"}`}>
      {r.action && <Link href={r.action.href} className={`${ACTION_BTN} btn-primary`}>{r.action.label}</Link>}
      <Link href={`/unfallersatz/${r.id}`} className={ACTION_BTN}>Fall öffnen</Link>
      {followUp && <Link href={`/unfallersatz/${r.id}?wv=neu#wiedervorlagen`} className={`text-xs text-ink-2 underline text-center ${layout === "bar" && r.action ? "col-span-2" : ""}`}>+ Wiedervorlage</Link>}
    </div>
  );
}

/** Phase H: Wiedervorlagen-Arbeitsliste – überfällig, heute, demnächst (7 Tage); eigene Filter, unabhängig von Fallfilter und Suche */
function TaskBoard({ t, qs }: { t: CenterTasks; qs: (over: Record<string, string | number | null>) => string }) {
  const link = (view: string | null) => `${qs({ aufgaben: view })}#wiedervorlagen`;
  const active = (view: string | null) => t.view === view || (view === null && t.view === "alle");
  const groups = (["OVERDUE", "TODAY", "SOON", "LATER"] as const).map((g) => ({ g, items: t.items.filter((x) => x.group === g) })).filter((x) => x.items.length > 0);
  const empty = t.view === "heute" ? "Heute ist im Unfallersatz nichts nachzufassen."
    : t.view === "ueberfaellig" ? "Keine überfälligen Wiedervorlagen."
    : t.view === "demnaechst" ? "In den nächsten 7 Tagen steht nichts an."
    : t.view === "meine" ? "Ihnen sind keine offenen Wiedervorlagen zugewiesen."
    : "Keine fälligen Wiedervorlagen.";
  const summary = [t.counts.ueberfaellig > 0 ? `${t.counts.ueberfaellig} überfällig` : null, t.counts.heute > 0 ? `${t.counts.heute} heute` : null, t.counts.demnaechst > 0 ? `${t.counts.demnaechst} demnächst` : null].filter(Boolean).join(" · ");
  return (
    <Card id="wiedervorlagen" title="Wiedervorlagen" right={summary ? <span className={`text-xs ${t.counts.ueberfaellig > 0 ? "text-bad font-medium" : "text-ink-2"}`}>{summary}</span> : <span className="text-xs text-ink-3">nichts fällig</span>}>
      <nav aria-label="Wiedervorlagen filtern" className="px-3.5 pt-3 flex gap-1.5 flex-wrap">
        <Link href={link(null)} aria-current={active(null) ? "page" : undefined} className={`btn !py-1 text-xs ${active(null) ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>Übersicht<span className="ml-1.5 tnum opacity-75">{t.counts.uebersicht}</span></Link>
        {(Object.keys(TASK_VIEWS) as TaskViewKey[]).map((v) => (
          <Link key={v} href={link(v)} aria-current={t.view === v ? "page" : undefined} className={`btn !py-1 text-xs ${t.view === v ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>
            {TASK_VIEWS[v]}<span className="ml-1.5 tnum opacity-75">{t.counts[v]}</span>
          </Link>
        ))}
      </nav>
      {t.items.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-3">
          {empty}
          {(t.view === "heute" || t.view === "demnaechst") && t.counts.ueberfaellig > 0 && <> Offen bleiben <Link href={link("ueberfaellig")} className="underline text-bad">{t.counts.ueberfaellig} überfällige</Link>.</>}
        </p>
      ) : (
        <div className="pt-2">
          {groups.map(({ g, items }) => (
            <section key={g} aria-label={TASK_GROUP_LABELS[g]}>
              <h3 className={`px-4 pt-2 pb-1 label-xs ${g === "OVERDUE" ? "!text-bad" : g === "TODAY" ? "!text-amber" : ""}`}>{TASK_GROUP_LABELS[g]} · {items.length}</h3>
              <ul className="divide-y divide-line-soft">{items.map((x) => <TaskItem key={x.id} x={x} />)}</ul>
            </section>
          ))}
        </div>
      )}
      {(t.more > 0 || t.view === "alle" || t.later > 0) && (
        <div className="px-4 py-3 border-t border-line-soft flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {t.more > 0 && (t.view === null ? <Link href={link("alle")} className="underline">Weitere Wiedervorlagen anzeigen ({t.more})</Link> : <span className="text-ink-3">{t.more} weitere – bitte über die Filter eingrenzen.</span>)}
          {t.view === "alle" && <Link href={link(null)} className="underline">Weniger anzeigen</Link>}
          {t.later > 0 && <span className="text-xs text-ink-3">{t.later} später fällig – in der jeweiligen Fallakte.</span>}
        </div>
      )}
    </Card>
  );
}

/** Eine Wiedervorlage: Fälligkeit (Text, nicht nur Farbe), Fall, Kunde, Aufgabe, Notiz, Zuständigkeit; Erledigen und Fall öffnen */
function TaskItem({ x }: { x: CenterTask }) {
  const bar = x.group === "OVERDUE" ? "border-l-bad" : x.group === "TODAY" ? "border-l-amber" : "border-l-transparent";
  return (
    <li className={`px-4 py-3 border-l-4 ${bar} flex flex-col sm:flex-row sm:items-start gap-3`}>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Chip tone={x.group === "OVERDUE" ? "bad" : x.group === "TODAY" ? "amber" : "grey"}>{x.dueText}</Chip>
          <Link href={`/unfallersatz/${x.caseId}`} className="font-mono tnum font-semibold hover:underline whitespace-nowrap">{x.caseNumber}</Link>
          <span className="min-w-0 truncate basis-full sm:basis-auto" title={x.customerName}><span className="hidden sm:inline">· </span>{x.customerName}</span>
        </div>
        <p className="font-medium break-words">„{x.title}“</p>
        {x.note && <p className="text-xs text-ink-2 truncate" title={x.note}>{x.note}</p>}
        <p className="text-xs text-ink-3">Zuständig: {x.assigneeName ? <span className={x.mine ? "font-medium text-ink-2" : ""}>{x.assigneeName}{x.mine ? " (Sie)" : ""}</span> : "niemand Bestimmtes"}</p>
      </div>
      {/* Handy: nebeneinander (geöffnetes Erledigen-Formular in voller Breite); ab sm: feste Spalte untereinander */}
      <div className="grid grid-cols-2 has-[form]:grid-cols-1 gap-2 sm:flex sm:flex-col sm:gap-1.5 sm:w-[180px] shrink-0">
        <FollowUpDoneAction done={completeFollowUpAction.bind(null, x.caseId, x.id)} />
        <Link href={`/unfallersatz/${x.caseId}#wiedervorlagen`} className={ACTION_BTN}>Fall öffnen</Link>
      </div>
    </li>
  );
}

function CaseCard({ r, full }: { r: CenterRow; full: boolean }) {
  return (
    <li className="px-4 py-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/unfallersatz/${r.id}`} className="font-mono tnum font-semibold hover:underline">{r.caseNumber}</Link>
          <div className="font-medium break-words">{r.customer.name}</div>
        </div>
        <Chip tone={r.status === "CLOSED" ? "grey" : r.mainStatus.tone}>{r.mainStatus.label}</Chip>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Plate>{r.vehicle.plate}</Plate>
        <span className="text-ink-3 text-xs">{r.vehicle.label}</span>
        {r.full && r.full.damagedPlate && <span className="text-xs text-ink-3">· beschädigt <span className="font-mono">{r.full.damagedPlate}</span></span>}
      </div>
      <div className="text-sm"><PeriodText r={r} /></div>
      {full && r.full && (r.full.insurerName || r.status === "OPEN") && (
        <div className="text-xs text-ink-2 break-words">
          {r.full.insurerName ?? "Versicherung fehlt"} · {r.full.claimNumber ? <span className="font-mono">{r.full.claimNumber}</span> : <span className="text-amber">Schadennummer fehlt</span>}
        </div>
      )}
      <BillingLine r={r} />
      {r.status === "CLOSED" && r.closedAt && <span className="text-xs text-ink-3">abgeschlossen am {fmtDate(r.closedAt)}</span>}
      <NextStepFacts r={r} />
      {/* Phase H: Aktionen unter der Karte in voller Breite */}
      <RowActions r={r} full={full} layout="bar" />
    </li>
  );
}


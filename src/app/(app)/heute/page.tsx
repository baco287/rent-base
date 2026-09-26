import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { fmtCents } from "@/lib/money";
import { fmtDateTime, fmtTime } from "@/lib/format";
import { keyDropsToInspect } from "@/lib/key-drop";
import { Card, Chip, Content, KPI, PageHeader, Plate } from "@/components/ui";
import { caseCounts } from "@/lib/damage-cases";
import { HORIZONS, loadDashboard, TASK_AREAS, TASK_GROUPS, type DashboardTask, type Horizon, type TaskGroup } from "@/lib/dashboard";
import { zonedDayStartPlus } from "@/lib/time";
import { OpenSearchButton } from "./quick-search";

export const metadata = { title: "Heute" };

/** Dauer seit der Rückgabemeldung, grob (Befehl 20.6). */
function sinceText(from: Date, now: Date) {
  const min = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (min < 60) return `${min} Min.`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} Std.` : `${Math.floor(h / 24)} Tagen`;
}

const groupTone: Record<TaskGroup, "bad" | "amber" | "info" | "grey"> = { OVERDUE: "bad", TODAY: "amber", SOON: "info", NOTE: "grey" };

function TaskRow({ t }: { t: DashboardTask }) {
  return (
    <li className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="label-xs w-20 shrink-0">{TASK_AREAS[t.area]}</span>
      <div className="flex-1 min-w-0">
        <Link href={t.href} className="font-medium hover:underline">{t.title}</Link>
        <div className="text-xs text-ink-3">{t.detail}</div>
      </div>
      {t.plate && <Plate>{t.plate}</Plate>}
      <Chip tone={groupTone[t.group]}>{t.status}</Chip>
    </li>
  );
}

/**
 * Operatives Dashboard: „Was braucht heute Aufmerksamkeit?“ Alle Aufgaben stammen aus lib/dashboard.ts (Kalendertage
 * in Europe/Berlin, zentrale Summierungen, keine Automatik). Gruppen: Überfällig · Heute · Bald · Hinweise.
 */
export default async function TodayPage({ searchParams }: PageProps<"/heute">) {
  const { tenant, user } = await requireSession();
  const sp = await searchParams;
  const horizon: Horizon = (HORIZONS.find((h) => h.key === sp.zeitraum)?.key ?? "heute") as Horizon;
  const d = await loadDashboard(tenant.id, { horizon });
  const keyDrops = await keyDropsToInspect(tenant.id);
  const { counts: c, now } = d;

  // Auslastung 7 Tage und Flotte (Bestand)
  const weekEnd = zonedDayStartPlus(now, 7);
  const [vehicles, weekBookings, damage] = await Promise.all([
    db.vehicle.findMany({ where: { tenantId: tenant.id, status: { not: "INACTIVE" } }, select: { id: true, status: true } }),
    db.booking.findMany({ where: { tenantId: tenant.id, status: { in: ["RESERVED", "ACTIVE"] }, startAt: { lt: weekEnd }, endAt: { gt: d.range.start } }, select: { startAt: true, endAt: true } }),
    caseCounts(tenant.id),
  ]);
  const weekMs = weekEnd.getTime() - d.range.start.getTime();
  const bookedMs = weekBookings.reduce((sum, b) => sum + (Math.min(b.endAt.getTime(), weekEnd.getTime()) - Math.max(b.startAt.getTime(), d.range.start.getTime())), 0);
  const fleet = vehicles.filter((v) => v.status === "AVAILABLE").length || vehicles.length;
  const utilization = fleet ? Math.round((bookedMs / (weekMs * fleet)) * 100) : 0;

  const kw = (() => {
    const x = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const day = x.getUTCDay() || 7;
    x.setUTCDate(x.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
    return Math.ceil(((x.getTime() - y0.getTime()) / 86400000 + 1) / 7);
  })();
  const attention = d.groups.OVERDUE.length + d.groups.TODAY.length;
  const visibleGroups = TASK_GROUPS.filter((g) => g.key !== "SOON" || horizon !== "heute");

  return (
    <>
      <PageHeader title={now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" })} sub={`KW ${kw}`}>
        <OpenSearchButton />
        <Link href="/fahrzeuge" className="btn">Fahrzeug suchen</Link>
        <Link href="/kunden/neu" className="btn">+ Neuer Kunde</Link>
        {user.role !== "YARD" && <Link href="/buchungen/neu" className="btn btn-primary">+ Neue Buchung</Link>}
      </PageHeader>
      <Content>
        {sp.fehler === "rechte" && <Chip tone="bad">Dafür fehlen deiner Rolle die Rechte.</Chip>}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPI label="Abholungen heute" value={c.pickupsToday} detail={d.events.find((e) => e.kind === "PICKUP") ? `nächste um ${fmtTime(d.events.find((e) => e.kind === "PICKUP")!.at)}` : "keine"} hot={c.pickupsToday > 0} />
          <KPI label="Rückgaben heute" value={c.returnsToday} detail={c.overdueReturns ? `${c.overdueReturns} überfällig` : "keine überfällig"} hot={c.overdueReturns > 0} />
          <KPI label="Aktive Mieten" value={c.activeRentals} detail={`Auslastung 7 Tage ${utilization} % · ${vehicles.length} Fahrzeuge`} />
          <KPI label="Flotte" value={vehicles.length} detail={`${c.vehiclesInWorkshop} in Werkstatt`} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPI label="Offene Rechnungen" value={c.openInvoices} detail={<Link href="/rechnungen?filter=offen" className="underline">{fmtCents(c.openInvoiceCents)} offen</Link>} hot={c.openInvoices > 0} />
          <KPI label="Überfällige Rechnungen" value={c.overdueInvoices} detail={`${fmtCents(c.overdueInvoiceCents)} · Fälligkeit überschritten`} hot={c.overdueInvoices > 0} />
          <KPI label="Rechnungserstattungen offen" value={c.refundsOpen} detail={<Link href="/auszahlungen?filter=offen&quelle=rechnung" className="underline">{fmtCents(c.refundsOpenCents)} noch auszuzahlen</Link>} hot={c.refundsOpen > 0} />
          <KPI label="Kautionsauszahlungen offen" value={c.depositPayoutsOpen} detail={<Link href="/auszahlungen?filter=offen&quelle=kaution" className="underline">{fmtCents(c.depositPayoutsOpenCents)} freigegeben, noch nicht ausgezahlt</Link>} hot={c.depositPayoutsOpen > 0} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPI label="Offene Kautionen" value={c.depositsHeld} detail={`nach Rückgabe noch nicht entschieden · ${c.depositsExpected} unterwegs ohne Eingang`} hot={c.depositsHeld > 0} />
          <KPI label="Offene Schadenakten" value={c.damagesOpen} detail={<Link href="/schaeden?filter=offen" className="underline">{c.damagesUnderReview} in Prüfung · {c.damagesInRepair} in Reparatur · {damage.blocked} wegen Schaden gesperrt</Link>} hot={c.damagesOpen > 0 || damage.blocked > 0} />
          <KPI label="Haftung ungeklärt" value={c.damagesLiabilityUnclear} detail={<Link href="/schaeden?filter=haftung_ungeklaert" className="underline">offene Akten ohne Bewertung</Link>} hot={c.damagesLiabilityUnclear > 0} />
          <KPI label="Wartung" value={c.maintenanceOverdue} detail={<Link href="/fahrzeuge/wartung?filter=ueberfaellig" className="underline">fällig/überfällig · {c.maintenanceSoon} bald · {c.maintenanceAppointmentsToday} Termine heute</Link>} hot={c.maintenanceOverdue > 0} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPI label="Behördenfristen" value={c.authorityOverdue + c.authorityDueSoon} detail={<Link href="/behoerden?frist=bald" className="underline">{c.authorityOverdue} überfällig · {c.authorityDueSoon} heute oder ≤ 3 Tage</Link>} hot={c.authorityOverdue > 0} />
          <KPI label="Behörden: Bearbeitung" value={c.authorityReceived + c.authorityAssignment + c.authorityReview + c.authorityReady} detail={<Link href="/behoerden" className="underline">{c.authorityReceived} neu · {c.authorityAssignment} Zuordnung · {c.authorityReview} Prüfung · {c.authorityReady} versandbereit</Link>} hot={c.authorityAssignment + c.authorityReady > 0} />
          <KPI label="E-Mail-Probleme" value={c.emailsFailed} detail={c.emailsFailed > 0 ? "fehlgeschlagene Sendungen, erneut senden auf der Buchung" : "keine fehlgeschlagenen Sendungen"} hot={c.emailsFailed > 0} />
          <KPI label="Fehlende Dokumente" value={c.documentsMissing} detail={c.documentsMissing > 0 ? "PDF noch nicht erzeugt" : "alle vorgesehenen PDFs vorhanden"} hot={c.documentsMissing > 0} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold mr-2">Was braucht Aufmerksamkeit?</h2>
          <nav aria-label="Zeitraum" className="flex gap-1.5">
            {HORIZONS.map((h) => <Link key={h.key} href={h.key === "heute" ? "/heute" : `/heute?zeitraum=${h.key}`} aria-current={h.key === horizon ? "page" : undefined} className={`btn !py-1.5 ${h.key === horizon ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{h.label}</Link>)}
          </nav>
          <span className="text-xs text-ink-3">{attention === 0 ? "Nichts Dringendes." : `${attention} Punkt${attention === 1 ? "" : "e"} überfällig oder heute`}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {visibleGroups.map((g) => {
            const rows = d.groups[g.key];
            return (
              <Card key={g.key} title={g.label} right={<Chip tone={rows.length ? g.tone : "good"}>{rows.length}</Chip>} className={g.key === "NOTE" && rows.length > 12 ? "lg:col-span-2" : ""}>
                {rows.length === 0 ? (
                  <p className="p-4 text-sm text-ink-3">{g.key === "OVERDUE" ? "Nichts überfällig." : g.key === "TODAY" ? "Heute steht nichts an." : g.key === "SOON" ? `Nichts fällig bis ${HORIZONS.find((h) => h.key === horizon)?.label}.` : "Keine Hinweise."}</p>
                ) : (
                  <ul className="divide-y divide-line-soft">{rows.map((t) => <TaskRow key={t.key} t={t} />)}</ul>
                )}
              </Card>
            );
          })}
        </div>

        {keyDrops.length > 0 && (
          <Card title="Schlüsselbox-Rückgaben zu prüfen" right={<Chip tone="amber">{keyDrops.length}</Chip>}>
            <ul className="divide-y divide-line-soft">
              {keyDrops.map((k) => (
                <li key={k.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Plate>{k.plate}</Plate>
                  <Link href={`/buchungen/${k.bookingId}/rueckgabe`} className="font-medium hover:underline">{k.vehicle}</Link>
                  <span className="text-ink-2">{k.customer}</span>
                  <span className="text-ink-3">Abgabe laut Kunde {k.dropOffAt ? fmtDateTime(k.dropOffAt) : "–"} · geplantes Mietende {fmtDateTime(k.plannedEnd)}</span>
                  <Chip tone="amber">{k.confirmedAt ? `seit ${sinceText(k.confirmedAt, now)}` : "gemeldet"}</Chip>
                  {k.inspectionStarted && <Chip tone="info">Kontrolle begonnen</Chip>}
                  {k.nextBooking && <Chip tone="bad">Folgebuchung {k.nextBooking.number} ab {fmtDateTime(k.nextBooking.startAt)}</Chip>}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Heute auf dem Hof" right={<Chip>{d.events.length} Termine</Chip>}>
          {d.events.length === 0 ? (
            <p className="p-4 text-ink-3 text-sm">Heute keine Abholungen oder Rückgaben.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {d.events.map((e) => (
                <li key={e.kind + e.bookingId} className="px-4 py-2.5 grid grid-cols-[52px_1fr_auto] gap-3 items-center">
                  <span className="font-mono tnum font-medium text-ink-2">{fmtTime(e.at)}</span>
                  <div className="min-w-0">
                    <Link href={`/buchungen/${e.bookingId}`} className="font-medium hover:underline">{e.kind === "PICKUP" ? "Abholung" : "Rückgabe"} · {e.customer}</Link>
                    <div className="text-xs text-ink-3 truncate">{e.vehicle} · Nr. {e.bookingNumber}{e.licenseMissing ? " · Führerschein fehlt" : ""}</div>
                  </div>
                  <Plate>{e.plate}</Plate>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <p className="text-xs text-ink-3">Kalendertage gelten in Europe/Berlin. Beträge stammen aus der zentralen Belegsummierung; das Dashboard löst keine Mahnung, Gutschrift, Auszahlung, Kautionsfreigabe, Haftungsentscheidung oder Behördenantwort aus.</p>
      </Content>
    </>
  );
}

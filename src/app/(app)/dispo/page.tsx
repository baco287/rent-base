import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime, fmtTime, toDateInput } from "@/lib/format";
import { Chip, Content, Empty, PageHeader, Plate } from "@/components/ui";
import { AGREED_EXTENSION_SELECT, agreedEndOf, isOverdue, occupiedUntil, occupyingWhere } from "@/lib/bookings";
import { isFeatureEnabled } from "@/lib/features";
import { accidentBarTime, accidentBarTitle, isAccidentRental } from "@/lib/accident-dispo";

export const metadata = { title: "Dispo-Kalender" };

const DAYS = 14;
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export default async function DispoPage({ searchParams }: PageProps<"/dispo">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;

  const today = startOfDay(new Date());
  let from = today;
  if (typeof sp.ab === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.ab)) {
    const [y, m, d] = sp.ab.split("-").map(Number);
    from = startOfDay(new Date(y, m - 1, d));
  }
  const to = addDays(from, DAYS);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(from, i));

  const [vehicles, bookings, accidentOn] = await Promise.all([
    db.vehicle.findMany({ where: { tenantId: tenant.id, status: { not: "INACTIVE" } }, include: { group: true }, orderBy: [{ group: { sortOrder: "asc" } }, { plate: "asc" }] }),
    db.booking.findMany({
      // Befehl 27: überfällige laufende Mieten bleiben sichtbar, bis die Rückgabe abgeschlossen ist (zentrale Definition)
      where: { tenantId: tenant.id, ...occupyingWhere(from, to, new Date()) },
      // Befehl 28: vereinbarte, noch nicht unterschriebene Verlängerung (reserviert das Fahrzeug bereits)
      include: { customer: true, contractAmendments: AGREED_EXTENSION_SELECT, accidentCase: { select: { id: true, caseNumber: true } } },
    }),
    // Praxistest: Link in die Unfallersatz-Fallakte nur mit freigeschaltetem Modul (die Kennzeichnung „Unfallersatz/UE“ immer)
    isFeatureEnabled(tenant.id, "ACCIDENT_REPLACEMENT"),
  ]);
  const accidentRows = bookings.filter((b) => isAccidentRental(b) && b.accidentCase).sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const plateOf = new Map(vehicles.map((v) => [v.id, v.plate]));
  const byVehicle = new Map<string, typeof bookings>();
  for (const b of bookings) {
    const list = byVehicle.get(b.vehicleId) ?? [];
    list.push(b);
    byVehicle.set(b.vehicleId, list);
  }

  const now = new Date();
  const rangeMs = to.getTime() - from.getTime();
  const pct = (d: Date) => Math.min(100, Math.max(0, ((d.getTime() - from.getTime()) / rangeMs) * 100));
  const fmtRange = `${from.toLocaleDateString("de-DE", { day: "numeric", month: "long" })} bis ${addDays(to, -1).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" })}`;

  return (
    <>
      <PageHeader title="Dispo-Kalender" sub={fmtRange}>
        <Link href={`/dispo?ab=${toDateInput(addDays(from, -7))}`} className="btn">‹ Woche</Link>
        <Link href="/dispo" className="btn">Heute</Link>
        <Link href={`/dispo?ab=${toDateInput(addDays(from, 7))}`} className="btn">Woche ›</Link>
        <Link href="/buchungen/neu" className="btn btn-primary">+ Neue Buchung</Link>
      </PageHeader>
      <Content>
        <div className="flex gap-4 flex-wrap text-xs text-ink-2">
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 bg-info-soft border border-info" />Reserviert</span>
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 bg-brand" />Unterwegs</span>
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 bg-bad-soft border border-bad" />Rückgabe überfällig</span>
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 border border-amber" style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--amber-soft) 0 3px, transparent 3px 6px)" }} />Verlängerung vereinbart – Unterschrift fehlt</span>
          <span><i className="inline-block size-3 rounded-sm align-[-2px] mr-1.5 bg-panel-2 border border-line" style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, var(--line) 3px 6px)" }} />Werkstatt / gesperrt</span>
          <span><b className="font-semibold text-ink">UE</b> = Unfallersatz (im Balken als Text gekennzeichnet)</span>
        </div>

        {vehicles.length === 0 ? (
          <div className="card"><Empty action={{ href: "/fahrzeuge/neu", label: "Erstes Fahrzeug anlegen" }}>Der Kalender zeigt Fahrzeuge als Zeilen. Noch sind keine angelegt.</Empty></div>
        ) : (
          <div className="card overflow-x-auto">
            <div className="grid text-xs min-w-[1000px]" style={{ gridTemplateColumns: `200px repeat(${DAYS}, minmax(58px, 1fr))` }}>
              <div className="sticky left-0 z-10 bg-panel-2 px-2.5 py-2 border-b border-line label-xs self-end">Fahrzeug</div>
              {days.map((d) => {
                const isToday = d.getTime() === today.getTime();
                const we = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <Link
                    key={d.toISOString()}
                    href={`/buchungen/neu?tag=${toDateInput(d)}`}
                    title="Buchung an diesem Tag anlegen"
                    className={`px-1 py-1.5 text-center border-b border-l border-line-soft font-semibold ${isToday ? "bg-amber-soft text-amber" : we ? "bg-bg text-ink-3" : "bg-panel-2 text-ink-3"} hover:underline`}
                  >
                    {WD[d.getDay()]}
                    <b className={`block font-mono text-[13px] ${isToday ? "text-amber" : "text-ink"}`}>{d.getDate()}.</b>
                  </Link>
                );
              })}

              {vehicles.map((v, i) => {
                const list = byVehicle.get(v.id) ?? [];
                const blocked = v.status === "WORKSHOP" || v.status === "BLOCKED";
                const groupName = v.group?.name ?? "Ohne Gruppe";
                const newGroup = i === 0 || (vehicles[i - 1].group?.name ?? "Ohne Gruppe") !== groupName;
                return (
                  <div key={v.id} className="contents">
                    {newGroup && (
                      <div className="col-span-full sticky left-0 bg-panel-2 px-2.5 py-1 border-b border-line label-xs !text-ink-2">
                        {groupName}
                      </div>
                    )}
                    <div className="sticky left-0 z-10 bg-panel px-2.5 py-2 border-b border-line-soft flex flex-col gap-0.5 justify-center">
                      <Link href={`/fahrzeuge/${v.id}`}><Plate>{v.plate}</Plate></Link>
                      <small className="text-ink-3 truncate">{v.make} {v.model}</small>
                    </div>
                    <div className="relative border-b border-line-soft h-12" style={{ gridColumn: `2 / span ${DAYS}` }}>
                      <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, minmax(58px, 1fr))` }}>
                        {days.map((d) => (
                          <div key={d.toISOString()} className={`border-l border-line-soft ${d.getTime() === today.getTime() ? "bg-amber/8" : ""}`} />
                        ))}
                      </div>
                      {blocked && (
                        <div className="absolute inset-y-2 left-0.5 right-0.5 rounded-md border border-line text-ink-2 flex items-center px-2 font-medium" style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--panel-2) 0 6px, var(--line-soft) 6px 12px)" }}>
                          {v.status === "WORKSHOP" ? "Werkstatt" : "Gesperrt"}
                        </div>
                      )}
                      {list.map((b) => {
                        const agreedEnd = agreedEndOf(b);
                        const occ = { status: b.status, endAt: b.endAt, agreedEndAt: agreedEnd };
                        const left = pct(b.startAt);
                        const overdue = isOverdue(occ, now);
                        // Befehl 28: Hauptbalken bis zum vertraglichen Ende (bzw. überfällig bis jetzt), vereinbarte Verlängerung als eigenes Segment
                        // Befehl 29: offenes Mietende (Unfallersatz) – der Balken läuft bis zum Ende des Dispo-Fensters
                        const extension = agreedEnd && b.endAt && agreedEnd > b.endAt && !overdue ? { from: pct(b.endAt), to: pct(agreedEnd) } : null;
                        const right = extension && b.endAt ? pct(b.endAt) : pct(occupiedUntil(occ, now) ?? to);
                        const endText = b.endAt ? fmtTime(b.endAt) : "offen";
                        // Praxistest: Unfallersatz textlich kennzeichnen (Farbe bleibt Status); breite Balken „Unfallersatz“, schmale „UE“
                        const ue = isAccidentRental(b);
                        const cls = overdue
                          ? "bg-bad-soft text-bad border-bad/50"
                          : b.status === "ACTIVE"
                            ? "bg-brand text-brand-ink border-transparent"
                            : "bg-info-soft text-info border-info/40";
                        return (
                          <span key={b.id} className="contents">
                          {extension && (
                            <Link
                              href={`/buchungen/${b.id}`}
                              title={`${b.number} · Verlängerung vereinbart – Unterschrift fehlt · reserviert bis ${fmtDateTime(agreedEnd!)}`}
                              className="absolute top-2 h-8 rounded-md border border-amber text-amber px-2 flex items-center font-medium whitespace-nowrap overflow-hidden text-[12px]"
                              style={{ left: `calc(${extension.from}% + 1px)`, width: `calc(${Math.max(extension.to - extension.from, 1.5)}% - 3px)`, backgroundImage: "repeating-linear-gradient(135deg, var(--amber-soft) 0 6px, var(--panel) 6px 12px)" }}
                            >
                              Verlängerung vereinbart – Unterschrift fehlt
                            </Link>
                          )}
                          <Link
                            href={`/buchungen/${b.id}`}
                            title={ue ? accidentBarTitle(b, b.accidentCase?.caseNumber ?? null, customerName(b.customer), overdue) : `${b.number} · ${customerName(b.customer)} · ${fmtTime(b.startAt)} bis ${endText}${overdue ? ` · Rückgabe überfällig (geplant ${fmtDateTime(b.endAt)})` : ""}`}
                            className={`absolute top-2 h-8 rounded-md border px-2 flex items-center gap-2 font-medium whitespace-nowrap overflow-hidden text-[12px] ${cls}${ue ? " @container" : ""}`}
                            style={{ left: `calc(${left}% + 2px)`, width: `calc(${Math.max(right - left, 1.5)}% - 4px)` }}
                          >
                            {overdue && <b className="font-semibold">Rückgabe überfällig</b>}
                            {ue && <b className="font-semibold"><span className="@[18rem]:hidden">UE<span className="sr-only"> (Unfallersatz)</span></span><span className="hidden @[18rem]:inline">Unfallersatz</span><span aria-hidden="true"> ·</span></b>}
                            {customerName(b.customer)}
                            <small className="opacity-80 font-normal">{overdue ? `geplant ${fmtDateTime(agreedEnd && b.endAt && agreedEnd > b.endAt ? agreedEnd : b.endAt)}` : ue ? accidentBarTime(b, from) : b.endAt ? fmtTime(b.startAt) : `${fmtTime(b.startAt)} · Mietende offen`}</small>
                          </Link>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* Praxistest: Unfallersatzmieten im Zeitraum mit Weg in die Fallakte (der Balken führt weiterhin zur Buchung). Nur Fallnummer,
            Fahrzeug, Kunde und Zeitraum – keine Versicherungs- oder Finanzdaten. */}
        {accidentOn && accidentRows.length > 0 && (
          <section id="unfallersatz" aria-label="Unfallersatz im Zeitraum" className="card scroll-mt-20">
            <div className="px-4 pt-3 pb-1 flex items-center gap-2"><h2 className="text-sm font-semibold">Unfallersatz im Zeitraum</h2><Chip tone="info">{accidentRows.length}</Chip><Link href="/unfallersatz" className="ml-auto text-xs underline">Alle Fälle in der Unfallersatz-Zentrale</Link></div>
            <ul className="divide-y divide-line-soft">
              {accidentRows.map((b) => (
                <li key={b.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                  <Chip tone="info">Unfallersatz {b.accidentCase!.caseNumber}</Chip>
                  {plateOf.has(b.vehicleId) && <Plate>{plateOf.get(b.vehicleId) as string}</Plate>}
                  <span className="font-medium min-w-0 break-words">{customerName(b.customer)}</span>
                  <span className="text-ink-3 min-w-0">{b.status === "ACTIVE" ? "unterwegs" : "reserviert"} · ab {fmtDateTime(b.startAt)} · {b.endAt ? `geplant bis ${fmtDateTime(b.endAt)}` : "Mietende offen"}</span>
                  <span className="flex flex-wrap gap-2 sm:ml-auto">
                    <Link href={`/unfallersatz/${b.accidentCase!.id}`} className="btn btn-primary !py-1.5 text-xs">Unfallersatzfall öffnen</Link>
                    <Link href={`/buchungen/${b.id}`} className="btn !py-1.5 text-xs">Buchung {b.number}</Link>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="text-xs text-ink-3 max-w-[70ch]">Klick auf einen Balken öffnet die Buchung, Klick auf einen Tag legt eine neue Buchung an diesem Tag an. Doppelbelegungen werden beim Speichern abgelehnt.{accidentOn && accidentRows.length > 0 ? " Unfallersatzfälle öffnen sich über die Liste „Unfallersatz im Zeitraum“." : ""}</p>
      </Content>
    </>
  );
}

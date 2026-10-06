import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFeature } from "@/lib/auth";
import { CASE_FILE_TABS, caseFileAccess, caseFileHeader, caseFileTabs, contractStep, resolveCaseFileTab, type CaseFileTab } from "@/lib/accident-case-file";
import { Chip, Content, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { BillingTab, DamageTab, DocumentsTab, HistoryTab, OverviewTab, RentalTab } from "./case-tabs";

export const metadata = { title: "Unfallersatzfall" };

/**
 * Befehl 29 Phase D: Fallakte eines Unfallersatzfalls – die operative Hauptansicht. Nur mit freigeschaltetem Modul (hier und im
 * Modul-Layout geprüft) und nur für Fälle des eigenen Mandanten (sonst 404). Inhaber und Disposition sehen und verwalten alles;
 * Hofmitarbeiter (und der Supportmodus) bekommen eine operative Sicht, deren Daten serverseitig gar nicht erst geladen werden.
 */
export default async function AccidentCasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant, user } = await requireFeature("ACCIDENT_REPLACEMENT");
  const { id } = await params;
  const sp = await searchParams;
  const access = caseFileAccess(user.role);
  const h = await caseFileHeader(tenant.id, id, access);
  if (!h) notFound();
  const tab: CaseFileTab = resolveCaseFileTab(sp.tab, access);
  const href = (t: CaseFileTab) => `/unfallersatz/${h.id}${t === "uebersicht" ? "" : `?tab=${t}`}`;
  const b = h.booking;
  const full = access === "FULL";
  const open = h.status === "OPEN";
  const bookingHref = `/buchungen/${b.id}`;
  const pickupReady = b.status === "RESERVED" && b.contract?.status === "SIGNED";
  const pickupDone = b.handovers.some((x) => x.type === "PICKUP" && x.status === "FINALIZED");
  const returnDone = b.handovers.some((x) => x.type === "RETURN" && x.status === "FINALIZED");
  const canReturn = b.status === "ACTIVE" && b.contract?.status === "SIGNED" && pickupDone && !returnDone;
  // Phase E: vor der Übergabe der Vertragsschritt (vorbereiten, öffnen, unterschreiben) – im bestehenden Vertragsassistenten
  const contract = contractStep(h.status, b);
  return (
    <>
      <PageHeader title={h.caseNumber} sub={h.customer.name}>
        <Chip tone={h.mainStatus.tone}>{h.mainStatus.label}</Chip>
        {h.openEnd && open && <Chip tone="info">Mietende offen</Chip>}
        <Link href={bookingHref} className="btn">Buchung öffnen</Link>
        {full && open && (contract.kind === "PREPARE" || contract.kind === "OPEN" || contract.kind === "SIGN") && <Link href={contract.href!} className="btn btn-primary">{contract.label}</Link>}
        {open && pickupReady && <Link href={`${bookingHref}/uebergabe`} className="btn btn-primary">{b.handovers.some((x) => x.type === "PICKUP" && x.status === "DRAFT") ? "Übergabe fortsetzen" : "Übergabe starten"}</Link>}
        {open && canReturn && <Link href={`${bookingHref}/rueckgabe`} className="btn btn-primary">{b.handovers.some((x) => x.type === "RETURN" && x.status === "DRAFT") ? "Rückgabe fortsetzen" : "Rückgabe starten"}</Link>}
        {full && open && (b.status === "RESERVED" || b.status === "ACTIVE") && <Link href={`/unfallersatz/${h.id}?tab=miete#mietdauer`} className="btn">Mietdauer aktualisieren</Link>}
      </PageHeader>
      <Content>
        {sp.angelegt === "1" && (
          <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">
            Unfallersatzfall {h.caseNumber} ist angelegt. Das Ersatzfahrzeug ist ab {fmtDateTime(b.startAt)} {b.endAt ? `bis ${fmtDateTime(b.endAt)}` : "mit offenem Mietende"} disponiert.
          </p>
        )}
        {!open && (
          <p role="status" className="rounded-md bg-panel-2 text-ink-2 px-3.5 py-2.5 text-sm">
            <span className="font-medium">Abgeschlossen</span>{h.closedAt ? ` am ${fmtDateTime(h.closedAt)}` : ""}{h.closedByName ? ` von ${h.closedByName}` : ""}. Die Fallakte ist nur noch lesbar; Vertrag, Übergabe und Rückgabe sind gesperrt, bis der Fall wieder geöffnet wird.
          </p>
        )}
        {!full && <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">Operative Ansicht: Fahrzeug, Zeitraum, Übergabe und Rückgabe. Versicherung, Abrechnung und Fallverwaltung liegen bei der Disposition.</p>}

        <section aria-label="Eckdaten" className="card p-4 grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-x-5 gap-y-3 text-sm">
          <Fact label="Ersatzfahrzeug"><span>{h.vehicle.make} {h.vehicle.model}</span> <span className="font-mono whitespace-nowrap">{h.vehicle.plate}</span></Fact>
          <Fact label="Mietbeginn">{fmtDateTime(b.actualPickupAt ?? b.startAt)}{b.actualPickupAt ? "" : <span className="text-ink-3"> (geplant)</span>}</Fact>
          <Fact label="Mietende">{b.status === "CANCELLED" ? <span className="text-ink-3">entfällt (storniert)</span> : b.actualReturnAt ? fmtDateTime(b.actualReturnAt) : b.endAt ? <>{fmtDateTime(b.endAt)} <span className="text-ink-3">(geplant)</span></> : <span className="font-medium">offen</span>}</Fact>
          {h.insurer && (
            <>
              <Fact label="Versicherung">{h.insurer.name ?? <span className="text-ink-3">nicht erfasst</span>}</Fact>
              <Fact label="Schadennummer">{h.insurer.claimNumber ?? <Chip tone="amber">fehlt</Chip>}</Fact>
              <Fact label="Haftung">{h.insurer.liabilityLabel}</Fact>
            </>
          )}
        </section>

        {/* umbrechend statt seitlich scrollend: der aktive Bereich bleibt auch auf dem Handy sichtbar */}
        <nav aria-label="Bereiche der Fallakte" className="flex flex-wrap gap-1.5">
          {caseFileTabs(access).map((t) => (
            <Link key={t} href={href(t)} aria-current={t === tab ? "page" : undefined} className={`btn !py-1.5 shrink-0 ${t === tab ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{CASE_FILE_TABS[t]}</Link>
          ))}
        </nav>

        {tab === "uebersicht" && <OverviewTab tenantId={tenant.id} h={h} access={access} newFollowUp={sp.wv === "neu"} />}
        {tab === "schadenfall" && full && <DamageTab tenantId={tenant.id} h={h} />}
        {tab === "miete" && <RentalTab tenantId={tenant.id} h={h} access={access} role={user.role} />}
        {tab === "dokumente" && <DocumentsTab tenantId={tenant.id} h={h} access={access} />}
        {tab === "abrechnung" && full && <BillingTab tenantId={tenant.id} h={h} />}
        {tab === "verlauf" && <HistoryTab tenantId={tenant.id} h={h} access={access} />}
      </Content>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="label-xs">{label}</span>
      <span className="break-words">{children}</span>
    </div>
  );
}

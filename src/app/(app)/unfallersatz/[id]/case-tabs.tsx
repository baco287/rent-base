// Befehl 29 Phase D: Bereiche der Unfallersatz-Fallakte (Server-Komponenten). Jeder Bereich lädt nur seine Daten – und für die
// operative Sicht (YARD, Supportmodus) nur die operativen (lib/accident-case-file.ts). Bearbeitungen nur bei offenem Fall und
// nur in der Vollsicht; was die Fachlogik ohnehin ablehnen würde, wird gar nicht erst angeboten.

import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card, Chip, KPI } from "@/components/ui";
import {
  caseFileBilling, caseFileDamage, caseFileDocuments, caseFileHistory, caseFileOverview, caseFileRental, type CaseDocumentView, type CaseFileAccess, type CaseFileHeader, type FollowUpView,
} from "@/lib/accident-case-file";
import { ACCIDENT_DAMAGE_KINDS, ACCIDENT_LIABILITY_STATUS, ACCIDENT_TARIFF_KINDS, BOOKING_STATUS, INVOICE_CHAIN_STATUS, PAYMENT_METHODS, type AccidentLiabilityStatus, type AccidentTariffKind, type BookingStatus } from "@/lib/constants";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { invoiceHref } from "@/lib/invoice-links";
import { fmtCents } from "@/lib/money";
import { toDateInputValue, toDateTimeInputValue } from "@/lib/time";
import {
  archiveAccidentDocumentAction, cancelAccidentAdjustmentAction, cancelAccidentPaymentAction, cancelFollowUpAction, closeCaseAction, completeFollowUpAction, createAccidentInvoiceAction,
  createAccidentRemainderAction, createFollowUpAction, previewAccidentInvoiceAction, previewAccidentPaymentAction, previewPlannedEndAction, recordAccidentAdjustmentAction,
  recordAccidentPaymentAction, reopenCaseAction, setLiabilityAction, updateAccidentAction, updateDamagedVehicleAction, updateInsurerAction, updateLawyerAction, updatePlannedEndAction,
  updateWorkshopAction,
} from "./actions";
import { PaymentForm, ReasonForm } from "../../buchungen/[id]/finanzen/money-forms";
import {
  AccidentDocumentUploader, AccidentEditor, AccidentInvoiceCreateForm, AdjustmentForm, CaseReasonForm, CloseCaseForm, RemainderForm, DamagedVehicleEditor, FollowUpActions, FollowUpCreateForm, InsurerEditor, LawyerEditor, LiabilityEditor, PlannedEndForm, ReopenCaseForm, WorkshopEditor,
} from "./case-forms";

type Header = NonNullable<CaseFileHeader>;
type Tone = "good" | "amber" | "bad" | "info" | "grey";

const toneDot: Record<Tone, string> = { bad: "bg-bad", amber: "bg-amber", info: "bg-info", good: "bg-good", grey: "bg-ink-3" };

/** Begriff/Wert-Liste, die auf schmalen Bildschirmen untereinander umbricht. */
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="p-4 grid grid-cols-1 sm:grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="label-xs sm:self-center pt-1.5 sm:pt-0">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? <span className="text-ink-3">–</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
const dash = (v: string | null | undefined) => (v && v.trim() ? v : null);

// ---------------------------------------------------------------------------
// Übersicht
// ---------------------------------------------------------------------------

export async function OverviewTab({ tenantId, h, access }: { tenantId: string; h: Header; access: CaseFileAccess }) {
  const o = await caseFileOverview(tenantId, h, access);
  const full = access === "FULL";
  const open = h.status === "OPEN";
  const fin = h.fin;
  const netGross = o.pricesIncludeTax === false ? "netto" : "brutto";
  const openFollowUps = o.followUps.filter((f) => f.status === "OPEN");
  const doneFollowUps = o.followUps.filter((f) => f.status !== "OPEN");
  return (
    <>
      <section aria-label="Kennzahlen" className={`grid grid-cols-2 ${full ? "xl:grid-cols-4" : ""} gap-3`}>
        <KPI label="Mietdauer" value={o.duration ? <span className="text-xl">{o.duration.days} {o.duration.days === 1 ? "Miettag" : "Miettage"}</span> : <span className="text-xl text-ink-3">{h.booking.status === "CANCELLED" ? "storniert" : "noch nicht übergeben"}</span>}
          detail={o.duration ? (o.duration.running ? `seit ${fmtDateTime(h.booking.actualPickupAt)} – läuft` : `${fmtDateTime(h.booking.actualPickupAt)} bis ${fmtDateTime(h.booking.actualReturnAt)}`) : h.booking.status === "CANCELLED" ? "Buchung storniert" : `geplanter Beginn ${fmtDateTime(h.booking.startAt)}`} />
        {full && (
          <>
            <KPI label={`Aktueller Mietwert (${netGross})`} value={o.rentValue ? <span className="text-xl">{fmtCents(o.rentValue.cents)}</span> : <span className="text-xl text-ink-3">–</span>}
              detail={o.rentValue ? `${o.rentValue.days} × ${fmtCents(o.rentValue.perDayCents)} je Miettag${o.rentValue.oneOffCents ? ` + ${fmtCents(o.rentValue.oneOffCents)} einmalig` : ""}${o.duration?.running ? " · Stand jetzt" : ""}` : h.booking.status === "CANCELLED" ? "kein Mietwert (storniert)" : "ab der Übergabe nach Tarif des Falls"} />
            <KPI label="Rechnungsstatus" value={<span className="text-xl">{!fin || (fin.active === 0 && fin.drafts === 0) ? "Noch nicht abgerechnet" : fin.active === 0 ? "Entwurf" : `${fin.active} ${fin.active === 1 ? "Rechnung" : "Rechnungen"}`}</span>}
              detail={[fin && fin.active > 0 ? `${fmtCents(fin.grossCents)} gestellt` : null, fin && fin.drafts > 0 ? `${fin.drafts} ${fin.drafts === 1 ? "Entwurf" : "Entwürfe"}` : null, fin && fin.invoices.length > fin.active ? `${fin.invoices.length - fin.active} storniert/gutgeschrieben` : null].filter(Boolean).join(" · ") || undefined} />
            <KPI label="Offener Betrag" hot={Boolean(fin && fin.active > 0 && fin.openCents > 0)}
              value={fin && fin.active > 0 ? <span className="text-xl">{fmtCents(fin.economicOpenCents)}</span> : <span className="text-xl text-ink-3">–</span>}
              detail={fin && fin.active > 0 ? `${fmtCents(fin.paidCents)} bezahlt${fin.reducedCents ? ` · Kürzungen ${fmtCents(fin.reducedCents)} dokumentiert (mindern die Forderung nicht)` : ""}` : "erst mit abgeschlossener Rechnung"} />
          </>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Card title="Nächste Schritte">
          {o.steps.length === 0 ? (
            <p className="p-4 text-sm text-good">Aktuell keine offenen Schritte.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {o.steps.map((s) => (
                <li key={s.code} className="px-4 py-2.5 flex items-start gap-2.5 text-sm">
                  <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneDot[s.tone]}`} />
                  <span className="flex-1 min-w-0">{s.text}</span>
                  {s.href && <Link href={s.href} className="btn !py-1 text-xs shrink-0">Öffnen</Link>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Kunde" right={<Link href={`/kunden/${h.customer.id}`} className="btn !py-1 text-xs">Kundenakte</Link>}>
          <Facts rows={[["Mieter / Geschädigter", h.customer.name], ["Telefon", h.customer.phone ? <a href={`tel:${h.customer.phone}`} className="underline">{h.customer.phone}</a> : null]]} />
        </Card>
      </div>

      {full && (
        <Card title="Wiedervorlagen" right={openFollowUps.length > 0 ? <Chip tone={!open ? "grey" : openFollowUps.some((f) => f.due === "OVERDUE") ? "bad" : openFollowUps.some((f) => f.due === "TODAY") ? "amber" : "grey"}>{openFollowUps.length} offen</Chip> : undefined}>
          <div className="p-4 flex flex-col gap-3">
            {openFollowUps.length === 0 && <p className="text-sm text-ink-3">Keine offenen Wiedervorlagen.</p>}
            {openFollowUps.length > 0 && (
              <ul className="flex flex-col gap-2">
                {openFollowUps.map((f) => <FollowUpItem key={f.id} f={f} caseId={h.id} canAct={open} />)}
              </ul>
            )}
            {open && <FollowUpCreateForm action={createFollowUpAction.bind(null, h.id)} assignees={o.assignees} minDate={toDateInputValue(new Date())} />}
            {doneFollowUps.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-ink-2">Erledigte und verworfene ({doneFollowUps.length})</summary>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {doneFollowUps.map((f) => (
                    <li key={f.id} className="rounded-md bg-panel-2 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{f.title}</span><Chip tone={f.status === "DONE" ? "good" : "grey"}>{f.status === "DONE" ? "Erledigt" : "Verworfen"}</Chip></div>
                      <div className="text-xs text-ink-3">{f.doneAt ? fmtDateTime(f.doneAt) : ""}{f.doneByName ? ` · ${f.doneByName}` : ""}{f.doneNote ? ` · ${f.doneNote}` : ""}</div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </Card>
      )}

      {full && (
        <Card title={open ? "Fall abschließen" : "Abgeschlossen"}>
          <div className="p-4 flex flex-col gap-3 text-sm">
            {open ? (
              <>
                <p className="text-ink-3">Abschließen, wenn Miete, Abrechnung und Klärung mit der Versicherung erledigt sind. Offene Punkte werden vorher angezeigt und am Fall festgehalten.</p>
                <CloseCaseForm action={closeCaseAction.bind(null, h.id)} warnings={o.closeWarnings} />
              </>
            ) : (
              <>
                <p>Abgeschlossen{h.closedAt ? ` am ${fmtDateTime(h.closedAt)}` : ""}{h.closedByName ? ` von ${h.closedByName}` : ""}.{h.closeReason ? ` Grund: ${h.closeReason}` : ""}</p>
                <p className="text-ink-3">Der Fall ist nur noch lesbar. Wiederöffnen ist mit Grund möglich und wird im Verlauf festgehalten.</p>
                <ReopenCaseForm action={reopenCaseAction.bind(null, h.id)} />
              </>
            )}
          </div>
        </Card>
      )}
    </>
  );
}

function FollowUpItem({ f, caseId, canAct }: { f: FollowUpView; caseId: string; canAct: boolean }) {
  // geschlossener Fall: offen gebliebene Wiedervorlagen neutral (bewusst beim Abschluss offen gelassen, keine Handlung mehr möglich)
  const tone = !canAct ? "border-line bg-panel-2" : f.due === "OVERDUE" ? "border-bad/50 bg-bad-soft/40" : f.due === "TODAY" ? "border-amber/50 bg-amber-soft/40" : "border-line bg-panel";
  return (
    <li className={`rounded-md border px-3 py-2.5 flex flex-col sm:flex-row sm:items-start gap-2 ${tone}`}>
      <div className="flex-1 min-w-0 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words">{f.title}</span>
          {!canAct ? <Chip tone="grey">beim Abschluss offen · fällig war {fmtDate(f.dueAt)}</Chip> : f.due === "OVERDUE" ? <Chip tone="bad">überfällig seit {fmtDate(f.dueAt)}</Chip> : f.due === "TODAY" ? <Chip tone="amber">heute fällig</Chip> : <span className="text-xs text-ink-3">fällig am {fmtDate(f.dueAt)}</span>}
        </div>
        <div className="text-xs text-ink-3">{f.assigneeName ? `Zuständig: ${f.assigneeName}` : "ohne Zuständigen"}{f.createdByName ? ` · angelegt von ${f.createdByName}` : ""}</div>
        {f.note && <p className="text-xs text-ink-2 mt-0.5 break-words">{f.note}</p>}
      </div>
      {canAct && <FollowUpActions done={completeFollowUpAction.bind(null, caseId, f.id)} cancel={cancelFollowUpAction.bind(null, caseId, f.id)} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Schadenfall (nur Vollsicht)
// ---------------------------------------------------------------------------

export async function DamageTab({ tenantId, h }: { tenantId: string; h: Header }) {
  const { case: c, partners } = await caseFileDamage(tenantId, h.id);
  const editable = h.status === "OPEN";
  const liability = (c.liabilityStatus in ACCIDENT_LIABILITY_STATUS ? c.liabilityStatus : "UNKNOWN") as AccidentLiabilityStatus;
  const dateIn = (d: Date | null) => (d ? toDateInputValue(d) : "");
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      <Card title="Beschädigtes Fahrzeug">
        <div className="pb-4 px-0">
          <DamagedVehicleEditor action={updateDamagedVehicleAction.bind(null, h.id)} editable={editable}
            values={{ damagedPlate: c.damagedPlate, damagedMake: c.damagedMake, damagedModel: c.damagedModel, damagedDrivable: c.damagedDrivable, damagedFirstRegistration: dateIn(c.damagedFirstRegistration), damagedVehicleClass: c.damagedVehicleClass ?? "", damagedLocation: c.damagedLocation ?? "", damageKind: c.damageKind }}
            view={<Facts rows={[
              ["Kennzeichen", <span key="p" className="font-mono">{c.damagedPlate}</span>], ["Hersteller / Modell", `${c.damagedMake} ${c.damagedModel}`], ["Erstzulassung", c.damagedFirstRegistration ? fmtDate(c.damagedFirstRegistration) : null],
              ["Fahrzeugklasse", dash(c.damagedVehicleClass)], ["Fahrbereit", c.damagedDrivable ? "ja" : "nein"], ["Standort", dash(c.damagedLocation)], ["Schadenart", ACCIDENT_DAMAGE_KINDS[c.damageKind as keyof typeof ACCIDENT_DAMAGE_KINDS] ?? c.damageKind],
            ]} />} />
        </div>
      </Card>

      <Card title="Unfall">
        <div className="pb-4">
          <AccidentEditor action={updateAccidentAction.bind(null, h.id)} editable={editable}
            values={{ accidentDate: dateIn(c.accidentAt), accidentPlace: c.accidentPlace ?? "", opponentPlate: c.opponentPlate ?? "", opponentName: c.opponentName ?? "", policeFileNumber: c.policeFileNumber ?? "", accidentNote: c.accidentNote ?? "", maxDate: toDateInputValue(new Date()) }}
            view={<Facts rows={[
              ["Unfalldatum", c.accidentAt ? fmtDate(c.accidentAt) : null], ["Unfallort", dash(c.accidentPlace)], ["Gegnerisches Kennzeichen", c.opponentPlate ? <span key="o" className="font-mono">{c.opponentPlate}</span> : null],
              ["Unfallgegner", dash(c.opponentName)], ["Polizei-Aktenzeichen", dash(c.policeFileNumber)], ["Interne Notiz", c.accidentNote ? <span key="n" className="whitespace-pre-line">{c.accidentNote}</span> : null],
            ]} />} />
        </div>
      </Card>

      <Card title="Versicherung" right={!c.insurerClaimNumber ? <Chip tone="amber">Schadennummer fehlt</Chip> : undefined}>
        <div className="pb-4">
          <InsurerEditor action={updateInsurerAction.bind(null, h.id)} editable={editable} options={partners.insurers}
            values={{ partnerId: "", name: c.insurerName ?? "", contactName: c.insurerContactName ?? "", phone: c.insurerPhone ?? "", email: c.insurerEmail ?? "", street: c.insurerStreet ?? "", zip: c.insurerZip ?? "", city: c.insurerCity ?? "", claimNumber: c.insurerClaimNumber ?? "" }}
            view={<Facts rows={[
              ["Versicherung", dash(c.insurerName)], ["Schadennummer", dash(c.insurerClaimNumber)], ["Ansprechpartner", dash(c.insurerContactName)], ["Telefon", dash(c.insurerPhone)], ["E-Mail", dash(c.insurerEmail)],
              ["Anschrift", [c.insurerStreet, [c.insurerZip, c.insurerCity].filter(Boolean).join(" ")].filter((x) => x && x.trim()).join(", ") || null],
            ]} />} />
        </div>
        <div className="border-t border-line-soft pb-4">
          <LiabilityEditor action={setLiabilityAction.bind(null, h.id)} editable={editable}
            values={{ status: liability, quota: c.liabilityQuotaPercent != null ? String(c.liabilityQuotaPercent) : "", note: c.liabilityNote ?? "" }}
            view={<Facts rows={[["Haftungsstatus", ACCIDENT_LIABILITY_STATUS[liability]], ["Haftungsquote", c.liabilityQuotaPercent != null ? `${c.liabilityQuotaPercent} % (Gegner)` : null], ["Notiz", dash(c.liabilityNote)]]} />} />
        </div>
      </Card>

      <div className="flex flex-col gap-4">
        <Card title="Werkstatt" right={<span className="text-xs text-ink-3">optional</span>}>
          <div className="pb-4">
            <WorkshopEditor action={updateWorkshopAction.bind(null, h.id)} editable={editable} options={partners.workshops} present={Boolean(c.workshopName)}
              values={{ partnerId: "", name: c.workshopName ?? "", contactName: c.workshopContactName ?? "", phone: c.workshopPhone ?? "", email: c.workshopEmail ?? "", street: "", zip: "", city: "", repairStartAt: dateIn(c.repairStartAt), repairEndAt: dateIn(c.repairEndAt) }}
              view={c.workshopName ? <Facts rows={[["Werkstatt", c.workshopName], ["Ansprechpartner", dash(c.workshopContactName)], ["Telefon", dash(c.workshopPhone)], ["E-Mail", dash(c.workshopEmail)], ["Reparaturbeginn", c.repairStartAt ? fmtDate(c.repairStartAt) : null], ["Reparaturende (voraussichtlich)", c.repairEndAt ? fmtDate(c.repairEndAt) : null]]} /> : <p className="px-4 pt-4 text-sm text-ink-3">Keine Werkstatt erfasst.</p>} />
          </div>
        </Card>
        <Card title="Rechtsanwalt" right={<span className="text-xs text-ink-3">optional</span>}>
          <div className="pb-4">
            <LawyerEditor action={updateLawyerAction.bind(null, h.id)} editable={editable} options={partners.lawyers} present={Boolean(c.lawyerFirm)}
              values={{ partnerId: "", name: c.lawyerFirm ?? "", contactName: c.lawyerContactName ?? "", phone: c.lawyerPhone ?? "", email: c.lawyerEmail ?? "", street: "", zip: "", city: "" }}
              view={c.lawyerFirm ? <Facts rows={[["Kanzlei", c.lawyerFirm], ["Ansprechpartner", dash(c.lawyerContactName)], ["Telefon", dash(c.lawyerPhone)], ["E-Mail", dash(c.lawyerEmail)]]} /> : <p className="px-4 pt-4 text-sm text-ink-3">Kein Rechtsanwalt erfasst.</p>} />
          </div>
        </Card>
      </div>
      <p className="text-xs text-ink-3 xl:col-span-2">Bearbeitet wird immer die Kopie im Fall. Das Adressbuch ändert sich nur, wenn beim Speichern „Angaben auch ins Adressbuch übernehmen“ gewählt ist.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Miete
// ---------------------------------------------------------------------------

export async function RentalTab({ tenantId, h, access }: { tenantId: string; h: Header; access: CaseFileAccess }) {
  const r = await caseFileRental(tenantId, h, access);
  const b = h.booking;
  const bookingHref = `/buchungen/${b.id}`;
  const pickupDone = b.handovers.find((x) => x.type === "PICKUP" && x.status === "FINALIZED");
  const returnDone = b.handovers.find((x) => x.type === "RETURN" && x.status === "FINALIZED");
  const netGross = r.pricesIncludeTax === false ? "netto" : "brutto";
  const full = access === "FULL";
  // Phase E: Vertrag vorbereiten / öffnen / unterschreiben nur mit Vollsicht (Vertragsassistent: Inhaber, Disposition); ansehen auch der Hof,
  // sobald der Vertrag abgeschlossen ist
  const contractAction = r.contract.href && (full ? r.contract.kind !== "NONE" : r.contract.kind === "VIEW" && (b.contract?.status === "SIGNED" || b.contract?.status === "CANCELLED")) ? r.contract : null;
  const rent = r.tariff?.rent ?? null;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      <Card title="Ersatzfahrzeug und Zeitraum" right={<Link href={bookingHref} className="btn !py-1 text-xs">Buchung {b.number}</Link>}>
        <Facts rows={[
          ["Ersatzfahrzeug", <span key="v">{h.vehicle.make} {h.vehicle.model} · <span className="font-mono">{h.vehicle.plate}</span></span>],
          ["Buchungsnummer", <Link key="b" href={bookingHref} className="underline">{b.number}</Link>],
          ["Mietstatus", BOOKING_STATUS[b.status as BookingStatus] ?? b.status],
          ["Mietbeginn (geplant)", fmtDateTime(b.startAt)],
          ["Mietende", b.status === "CANCELLED" ? "entfällt (storniert)" : b.actualReturnAt ? `zurückgegeben ${fmtDateTime(b.actualReturnAt)}` : b.endAt ? `geplant ${fmtDateTime(b.endAt)}` : "offen (bis zur Rückgabe)"],
          ["Übergabe", pickupDone ? `${pickupDone.number} · ${fmtDateTime(pickupDone.finalizedAt)}` : b.handovers.some((x) => x.type === "PICKUP" && x.status === "DRAFT") ? "begonnen, noch nicht abgeschlossen" : "noch nicht erfolgt"],
          ["Rückgabe", returnDone ? `${returnDone.number} · ${fmtDateTime(returnDone.finalizedAt)}` : b.handovers.some((x) => x.type === "RETURN" && x.status === "DRAFT") ? "begonnen, noch nicht abgeschlossen" : "noch nicht erfolgt"],
          ["Mietdauer", r.duration ? `${r.duration.days} ${r.duration.days === 1 ? "Miettag" : "Miettage"}${r.duration.running ? " (läuft)" : ""}` : null],
          ["Mietvertrag", r.contract.text],
        ]} />
        <div className="px-4 pb-4 flex flex-wrap gap-2">
          {contractAction && <Link href={contractAction.href!} className={`btn ${contractAction.kind === "VIEW" ? "" : "btn-primary"}`}>{contractAction.label}</Link>}
          {h.status === "OPEN" && (r.pickup.kind === "START" || r.pickup.kind === "CONTINUE") && <Link href={`${bookingHref}/uebergabe`} className="btn btn-primary">{r.pickup.label}</Link>}
          {r.pickup.kind === "VIEW" && <Link href={`${bookingHref}/uebergabe`} className="btn">{r.pickup.label}</Link>}
          {h.status === "OPEN" && (r.ret.kind === "START" || r.ret.kind === "CONTINUE") && <Link href={`${bookingHref}/rueckgabe`} className="btn btn-primary">{r.ret.label}</Link>}
          {r.ret.kind === "VIEW" && <Link href={`${bookingHref}/rueckgabe`} className="btn">{r.ret.label}</Link>}
        </div>
        {h.status === "OPEN" && b.status === "RESERVED" && b.contract?.status !== "SIGNED" && <p className="px-4 pb-4 -mt-2 text-xs text-ink-3">Die Übergabe ist möglich, sobald der Mietvertrag unterschrieben und abgeschlossen ist.</p>}
        {h.status === "OPEN" && b.status === "RETURNED" && <p className="px-4 pb-4 -mt-2 text-xs text-ink-3">Fahrzeug zurückgegeben. Abgerechnet wird im Bereich „Abrechnung“; der Fall bleibt offen, bis er bewusst abgeschlossen wird.</p>}
      </Card>

      {r.canChangeEnd && (
        <Card title="Mietdauer" className="scroll-mt-20">
          <div id="mietdauer" className="p-4 flex flex-col gap-2 text-sm">
            <p className="text-ink-3">Aktuell: {b.endAt ? `geplant bis ${fmtDateTime(b.endAt)}` : "Mietende offen – das Fahrzeug bleibt bis zur Rückgabe belegt"}.</p>
            <PlannedEndForm action={updatePlannedEndAction.bind(null, h.id)} preview={previewPlannedEndAction.bind(null, h.id)} currentEnd={b.endAt ? toDateTimeInputValue(b.endAt) : ""} minEnd={toDateTimeInputValue(b.startAt)} />
          </div>
        </Card>
      )}

      {r.tariff && (
        <Card title="Tarif" right={<span className="text-xs text-ink-3">Beträge {netGross}</span>}>
          <div className="p-4 flex flex-col gap-3 text-sm">
            <ul className="flex flex-col divide-y divide-line-soft">
              <li className="flex justify-between gap-3 py-1.5"><span>Tagessatz <span className="text-ink-3">· je Miettag</span></span><span className="font-mono tnum">{fmtCents(r.tariff.dailyRateCents)}</span></li>
              {r.tariff.items.filter((i) => i.perDay).map((i, n) => <li key={`d${n}`} className="flex justify-between gap-3 py-1.5"><span className="min-w-0 break-words">{i.label || ACCIDENT_TARIFF_KINDS[i.kind as AccidentTariffKind]} <span className="text-ink-3">· je Miettag</span></span><span className="font-mono tnum shrink-0">{i.unitPriceCents > 0 ? fmtCents(i.unitPriceCents) : "inklusive"}</span></li>)}
              <li className="flex justify-between gap-3 py-1.5 font-medium"><span>Je Miettag zusammen</span><span className="font-mono tnum">{fmtCents(r.tariff.perDayCents)}</span></li>
              {r.tariff.items.filter((i) => !i.perDay).map((i, n) => <li key={`o${n}`} className="flex justify-between gap-3 py-1.5"><span className="min-w-0 break-words">{i.label || ACCIDENT_TARIFF_KINDS[i.kind as AccidentTariffKind]} <span className="text-ink-3">· {i.quantityHundredths === 100 ? "einmalig" : `${(i.quantityHundredths / 100).toLocaleString("de-DE")} ×`}</span></span><span className="font-mono tnum shrink-0">{i.unitPriceCents > 0 ? fmtCents(i.unitPriceCents) : "inklusive"}</span></li>)}
            </ul>
            <div className="text-xs text-ink-3">Kaution {r.tariff.depositCents ? fmtCents(r.tariff.depositCents) : "keine"} · {r.tariff.kmIncludedPerDay != null ? `${r.tariff.kmIncludedPerDay} km je Miettag frei` : "Freikilometer laut Fahrzeug"} · {r.tariff.extraKmRateCents != null ? `${fmtCents(r.tariff.extraKmRateCents)} je Mehrkilometer` : "Mehrkilometer laut Fahrzeug"}{r.tariff.kmFromContract ? " (laut Mietvertrag)" : ""}</div>
            <div className="rounded-md bg-panel-2 p-3 flex flex-col gap-1">
              <div className="label-xs">Preisstand</div>
              {rent && rent.phase !== "NONE" ? (
                <>
                  <div className="flex justify-between gap-3"><span>{rent.phase === "FINAL" ? "Endwert" : "Bisher"} ({rent.value.days} {rent.value.days === 1 ? "Miettag" : "Miettage"}{rent.phase === "FINAL" ? "" : ", Stand jetzt"})</span><span className="font-mono tnum font-medium">{fmtCents(rent.value.cents)}</span></div>
                  <p className="text-xs text-ink-3">{rent.value.days} × {fmtCents(rent.value.perDayCents)} je Miettag{rent.value.oneOffCents ? ` + ${fmtCents(rent.value.oneOffCents)} einmalig` : ""} · {rent.phase === "FINAL" ? `Übergabe ${fmtDateTime(rent.from)} bis Rückgabe ${fmtDateTime(rent.until)}` : `seit Übergabe ${fmtDateTime(rent.from)}`}</p>
                </>
              ) : <p className="text-ink-3">{b.status === "CANCELLED" ? "Buchung storniert – kein Mietwert." : "Noch nicht übergeben – noch kein Ist-Wert. Der Mietwert entsteht ab der Übergabe."}</p>}
              {r.tariff.planned && <div className="flex justify-between gap-3 text-ink-2"><span>Voraussichtlich bis geplantem Ende ({r.tariff.planned.days} {r.tariff.planned.days === 1 ? "Miettag" : "Miettage"})</span><span className="font-mono tnum">{fmtCents(r.tariff.planned.cents)}</span></div>}
              {r.tariff.overdue && <p className="text-bad">Geplantes Mietende überschritten – der Mietwert wächst bis zur Rückgabe weiter.</p>}
              {!r.tariff.planned && !r.tariff.overdue && !b.actualReturnAt && b.status !== "CANCELLED" && <p className="text-ink-3">Mietende offen: kein Gesamtbetrag – abgerechnet wird nach tatsächlicher Mietdauer.</p>}
              <p className="text-xs text-ink-3">Orientierung nach Tarif des Falls, ohne Zusatzkosten aus der Rückgabe. Keine Aussage zur Erstattungsfähigkeit.</p>
            </div>
            <p className="text-xs text-ink-3">{r.tariff.frozen ? "Tarif laut unterschriebenem Mietvertrag – eingefroren, hier nur angezeigt." : "Tarif des Falls – wird mit dem Mietvertrag unterschrieben und danach eingefroren. Hier nur angezeigt."}</p>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Dokumente (Phase F): Vertragsunterlagen für alle Sichten; Unfallersatz- und Versicherungsdokumente, Rechnungsbelege und das
// Archiv nur in der Vollsicht. Hochladen und Archivieren nur bei offenem Fall (der Server prüft dasselbe).
// ---------------------------------------------------------------------------

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function BookingDocList({ items, empty }: { items: { id: string; typeLabel: string; version: number; fileName: string; createdAt: Date }[]; empty: string }) {
  if (items.length === 0) return <p className="p-4 text-sm text-ink-3">{empty}</p>;
  return (
    <ul className="divide-y divide-line-soft">
      {items.map((x) => (
        <li key={x.id} className="px-4 py-2.5 flex flex-wrap items-center gap-2 text-sm">
          <span className="flex-1 min-w-0"><span className="font-medium">{x.typeLabel}</span>{x.version > 1 ? <span className="text-ink-3"> · Fassung {x.version}</span> : null}<span className="block text-xs text-ink-3 break-all">{x.fileName} · {fmtDateTime(x.createdAt)}</span></span>
          <a href={`/api/documents/${x.id}`} target="_blank" rel="noopener" className="btn !py-1 text-xs">Öffnen</a>
          <a href={`/api/documents/${x.id}?download=1`} className="btn !py-1 text-xs">Herunterladen</a>
        </li>
      ))}
    </ul>
  );
}

function CaseDocItem({ d, caseId, canArchive }: { d: CaseDocumentView; caseId: string; canArchive: boolean }) {
  const linked = d.adjustments.filter((a) => a.status === "CONFIRMED");
  return (
    <li className="px-4 py-2.5 text-sm flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{d.typeLabel}</span>
        {d.archivedAt && <Chip tone="grey">archiviert</Chip>}
        <span className="ml-auto flex flex-wrap gap-2">
          <a href={`/api/accident-documents/${d.id}`} target="_blank" rel="noopener" className="btn !py-1 text-xs">Öffnen</a>
          <a href={`/api/accident-documents/${d.id}?download=1`} className="btn !py-1 text-xs">Herunterladen</a>
        </span>
      </div>
      <div className="text-xs text-ink-3 break-all">{d.fileName} · {kb(d.sizeBytes)} · {fmtDateTime(d.createdAt)}{d.createdByName ? ` · hochgeladen von ${d.createdByName}` : ""}</div>
      {d.note && <p className="text-xs text-ink-2 break-words">{d.note}</p>}
      {d.adjustments.length > 0 && <p className="text-xs text-ink-2">Verknüpft mit {d.adjustments.map((a) => `Kürzung ${fmtCents(a.amountCents)} (${a.reasonLabel}) zu Rechnung ${a.invoiceNumber ?? ""}${a.status !== "CONFIRMED" ? ", storniert" : ""}`).join("; ")}</p>}
      {d.archivedAt && <p className="text-xs text-ink-3">Archiviert am {fmtDateTime(d.archivedAt)}{d.archivedByName ? ` von ${d.archivedByName}` : ""}: {d.archiveReason}</p>}
      {canArchive && !d.archivedAt && <CaseReasonForm action={archiveAccidentDocumentAction.bind(null, caseId, d.id)} label="Archivieren" question={`„${d.fileName}“ archivieren?`} submitLabel="Archivieren" explanation={`Das Dokument wird nicht gelöscht, sondern als archiviert gekennzeichnet und bleibt abrufbar.${linked.length ? " Die Verknüpfung mit der Kürzung bleibt erhalten." : ""}`} />}
    </li>
  );
}

export async function DocumentsTab({ tenantId, h, access }: { tenantId: string; h: Header; access: CaseFileAccess }) {
  const d = await caseFileDocuments(tenantId, h, access);
  const full = access === "FULL";
  const canEdit = full && d.caseOpen;
  return (
    <div className="flex flex-col gap-4">
      {canEdit && <Card title="Dokument hochladen"><div className="p-4"><AccidentDocumentUploader caseId={h.id} /></div></Card>}
      {full && !d.caseOpen && <p className="rounded-md bg-panel-2 text-ink-2 px-3.5 py-2.5 text-sm">Der Fall ist abgeschlossen: Hochladen und Archivieren erst nach dem Wiederöffnen. Alle Dokumente bleiben abrufbar.</p>}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <Card title="Vertragsunterlagen" right={<Chip>{d.contract.length}</Chip>}>
          <BookingDocList items={d.contract} empty="Noch keine Unterlagen erzeugt. Mietvertrag, Übergabe- und Rückgabeprotokoll sowie Nachträge erscheinen hier, sobald sie abgeschlossen sind." />
        </Card>
        {full && (
          <Card title="Unfallersatz" right={<Chip>{d.accident.length}</Chip>}>
            {d.accident.length === 0 ? <p className="p-4 text-sm text-ink-3">Noch keine Abtretung bzw. Zahlungsanweisung und keine sonstigen Fallunterlagen.</p> : <ul className="divide-y divide-line-soft">{d.accident.map((x) => <CaseDocItem key={x.id} d={x} caseId={h.id} canArchive={canEdit} />)}</ul>}
          </Card>
        )}
        {full && (
          <Card title="Versicherung" right={<Chip>{d.insurer.length}</Chip>}>
            {d.insurer.length === 0 ? <p className="p-4 text-sm text-ink-3">Noch keine Schreiben der Versicherung (z. B. Kürzungsschreiben).</p> : <ul className="divide-y divide-line-soft">{d.insurer.map((x) => <CaseDocItem key={x.id} d={x} caseId={h.id} canArchive={canEdit} />)}</ul>}
          </Card>
        )}
        {full && (
          <Card title="Rechnungen und Belege" right={<Chip>{d.billing.length}</Chip>}>
            <BookingDocList items={d.billing} empty="Noch keine Rechnungs-PDFs. Sie entstehen beim Abschluss einer Rechnung." />
          </Card>
        )}
      </div>
      {full && d.archived.length > 0 && (
        <details className="card">
          <summary className="px-4 py-3 cursor-pointer text-sm font-medium">Archivierte Dokumente ({d.archived.length})</summary>
          <ul className="divide-y divide-line-soft border-t border-line-soft">{d.archived.map((x) => <CaseDocItem key={x.id} d={x} caseId={h.id} canArchive={false} />)}</ul>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Abrechnung (Phase F, nur Vollsicht): Finanzübersicht, Abrechnungsstatus, Zwischen-/Schlussrechnung mit Vorschau, je Rechnung
// Zahlungen, Kürzungen und Restforderung. Nur Aktionen, die tatsächlich möglich sind; der Server prüft alles erneut.
// ---------------------------------------------------------------------------

const toneChip: Record<Tone, "good" | "amber" | "bad" | "info" | "grey"> = { good: "good", amber: "amber", bad: "bad", info: "info", grey: "grey" };

function Tile({ label, value, tone, sub }: { label: string; value: string; tone?: "bad" | "good"; sub?: string }) {
  return <div className="rounded-md bg-panel-2 p-2.5 min-w-0"><div className="label-xs">{label}</div><div className={`font-mono tnum ${tone === "bad" ? "text-bad font-semibold" : tone === "good" ? "text-good" : ""}`}>{value}</div>{sub && <div className="text-[11px] text-ink-3">{sub}</div>}</div>;
}

export async function BillingTab({ tenantId, h }: { tenantId: string; h: Header }) {
  const bill = await caseFileBilling(tenantId, h);
  const f = bill.fin;
  const a = bill.actions;
  const b = h.booking;
  const today = toDateInputValue(new Date());
  const now = toDateTimeInputValue(new Date());
  const letters = bill.letters.map((l) => ({ id: l.id, fileName: l.fileName, date: fmtDate(l.createdAt) }));
  const fp = a.finalPreview;
  const finalPreview = fp ? { typeLabel: fp.typeLabel, period: `${fmtDateTime(fp.periodStart)} bis ${fmtDateTime(fp.end)}`, days: fp.days, totalDays: fp.totalDays, priorDays: fp.priorDays, items: fp.items.map((i) => ({ description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: fmtCents(i.unitPriceCents), gross: fmtCents(i.grossCents) })), net: fmtCents(fp.netCents), tax: fmtCents(fp.taxCents), gross: fmtCents(fp.grossCents), pricesIncludeTax: fp.pricesIncludeTax } : null;
  const createProps = { action: createAccidentInvoiceAction.bind(null, h.id), insurer: { name: bill.recipients.insurer.name, hasEmail: bill.recipients.insurer.hasEmail, hasAddress: bill.recipients.insurer.hasAddress }, renter: bill.recipients.renter, nonce: randomUUID() };
  return (
    <>
      <section aria-label="Finanzübersicht" className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <KPI label="Fakturiert (wirksam)" value={<span className="text-xl">{fmtCents(f.grossCents)}</span>} detail={f.remainderCents > 0 ? `davon Restforderung an den Mieter ${fmtCents(f.remainderCents)}` : "abgeschlossene Rechnungen nach Gutschriften/Storno"} />
        <KPI label="Bezahlt" value={<span className="text-xl">{fmtCents(f.paidCents)}</span>} />
        <KPI label="Offen" hot={f.economicOpenCents > 0} value={<span className="text-xl">{fmtCents(f.economicOpenCents)}</span>} detail={[f.doubleClaimCents > 0 ? "ohne doppelt geforderte Beträge" : "tatsächlich offene Forderungen", f.feesOpenCents > 0 ? `zzgl. Mahngebühren ${fmtCents(f.feesOpenCents)}` : null, f.refundOpenCents > 0 ? `Guthaben ${fmtCents(f.refundOpenCents)} zu erstatten` : null].filter(Boolean).join(" · ")} />
        <KPI label="Dokumentierte Kürzungen" value={<span className="text-xl">{fmtCents(f.reducedCents)}</span>} detail="separat – mindern die offene Forderung nicht" />
      </section>
      <div className="flex flex-wrap gap-1.5" aria-label="Abrechnungsstatus">{bill.flags.map((x) => <Chip key={x.label} tone={toneChip[x.tone]}>{x.label}</Chip>)}</div>
      {bill.warnings.map((w) => <p key={w.code + w.text} role={w.code === "REDUCTION_OPEN" || w.code === "FEES_OPEN" ? undefined : "alert"} className={`rounded-md px-3.5 py-2.5 text-sm ${w.code === "REDUCTION_OPEN" || w.code === "FEES_OPEN" ? "bg-amber-soft text-amber" : "bg-bad-soft text-bad"}`}>{w.text}</p>)}

      <Card title="Abrechnen">
        <div className="p-4 flex flex-col gap-3 text-sm">
          {!bill.open ? (
            <p className="text-ink-2">Der Fall ist abgeschlossen. Neue Rechnungen, Zahlungen, Kürzungen und Restforderungen sind erst nach dem Wiederöffnen möglich. Rechnungen, PDFs und Belege bleiben abrufbar.</p>
          ) : a.hasDraft ? (
            <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Es ist ein Rechnungsentwurf offen. Bitte zuerst abschließen oder verwerfen (siehe „Rechnungsentwürfe“).</p>
          ) : a.canFinal ? (
            a.finalPreviewError ? <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2">{a.finalPreviewError}</p> : (
              <>
                <p className="text-ink-2">Schlussrechnung nach der Rückgabe: tatsächliche Mietdauer von der Übergabe ({fmtDateTime(b.actualPickupAt)}) bis zur Rückgabe ({fmtDateTime(b.actualReturnAt)}){f.billedUntil ? `; bereits abgerechnet bis ${fmtDateTime(f.billedUntil)} – berechnet wird nur der Rest` : ""}.</p>
                <AccidentInvoiceCreateForm {...createProps} mode="FINAL" finalPreview={finalPreview} />
              </>
            )
          ) : a.interimBlockedReason ? (
            <p className="text-ink-2">{a.interimBlockedReason}</p>
          ) : a.canInterim ? (
            <>
              <p className="text-ink-2">Die Miete läuft. Eine Zwischenrechnung rechnet die tatsächliche Mietdauer bis zu einem Stichtag ab (nicht in der Zukunft); die Schlussrechnung nach der Rückgabe berechnet nur den Rest.</p>
              <AccidentInvoiceCreateForm {...createProps} mode="INTERIM" preview={previewAccidentInvoiceAction.bind(null, h.id)} minEnd={a.interimMin} maxEnd={a.interimMax} />
            </>
          ) : f.finalBilled ? (
            <p className="text-good">Die Miete ist vollständig abgerechnet (Schlussrechnung). Weitere Forderungen nur als Restforderung zu einer gekürzten Versicherungsrechnung; Korrekturen über Gutschrift bzw. Storno in der Rechnung.</p>
          ) : b.status === "RESERVED" ? (
            <p className="text-ink-3">Abgerechnet wird ab der Übergabe des Fahrzeugs.</p>
          ) : b.status === "CANCELLED" ? (
            <p className="text-ink-3">Die Buchung ist storniert – es gibt keine Miete abzurechnen.</p>
          ) : null}
          <p className="text-xs text-ink-3">Grundlage: Tarif des unterschriebenen Mietvertrags und tatsächliche Mietdauer ab der Übergabe. Rent-Base trifft keine Aussage zur Erstattungsfähigkeit oder Haftung.</p>
        </div>
      </Card>

      {bill.drafts.length > 0 && (
        <Card title="Rechnungsentwürfe">
          <ul className="divide-y divide-line-soft">
            {bill.drafts.map((d) => (
              <li key={d.id} className="px-4 py-2.5 flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1 min-w-0">{d.typeLabel} (Entwurf vom {fmtDateTime(d.createdAt)}) · {d.roleLabel} · <span className="font-mono tnum">{fmtCents(d.grossCents)}</span><span className="block text-xs text-ink-3">Leistungszeitraum {fmtDateTime(d.periodStart)} bis {fmtDateTime(d.periodEnd)} · ohne Nummer, zählt noch nicht als abgerechnet</span></span>
                <Link href={invoiceHref({ id: d.id, bookingId: b.id, kind: "ACCIDENT_REPLACEMENT" })} className="btn btn-primary !py-1 text-xs">Entwurf öffnen</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {bill.invoices.length === 0 && bill.drafts.length === 0 && <Card title="Rechnungen"><p className="p-4 text-sm text-ink-3">Noch keine Unfallersatz-Rechnung vorhanden.</p></Card>}
      {bill.invoices.map((i) => (
        <Card key={i.id} title={<Link href={invoiceHref({ id: i.id, bookingId: b.id, kind: "ACCIDENT_REPLACEMENT" })} className="underline">{i.typeLabel} {i.number ?? ""}</Link>} right={<><Chip tone="info">{i.roleLabel}</Chip>{i.chain !== "NONE" && <Chip tone={i.chain === "CANCELLED" ? "bad" : "grey"}>{INVOICE_CHAIN_STATUS[i.chain]}</Chip>}{!i.neutralized && <Chip tone={i.openCents === 0 ? "good" : "amber"}>{i.paymentStatusLabel}</Chip>}</>}>
          <div className="p-4 flex flex-col gap-3 text-sm">
            <div className="text-xs text-ink-3 break-words">{i.recipientName}{i.servicePeriodStart && i.servicePeriodEnd ? ` · Leistungszeitraum ${fmtDateTime(i.servicePeriodStart)} bis ${fmtDateTime(i.servicePeriodEnd)}` : ""}{i.issueDate ? ` · Rechnungsdatum ${fmtDate(i.issueDate)}` : ""}{i.remainderOfNumber ? ` · Restforderung zu Rechnung ${i.remainderOfNumber}` : ""}</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <Tile label="Rechnungsbetrag" value={fmtCents(i.invoiceCents)} />
              <Tile label="Gutschrift/Storno" value={i.creditedCents + i.cancelledCents > 0 ? `− ${fmtCents(i.creditedCents + i.cancelledCents)}` : "–"} />
              <Tile label="Bezahlt" value={fmtCents(i.paidCents)} tone={i.paidCents > 0 ? "good" : undefined} />
              <Tile label="Offen" value={fmtCents(i.openCents)} tone={i.openCents > 0 ? "bad" : undefined} />
              <Tile label="Kürzung (dok.)" value={fmtCents(i.reducedCents)} sub="mindert nicht" />
            </div>
            {!i.recipientEmail && <p className="text-xs text-ink-3">Beim Rechnungsempfänger ist keine E-Mail-Adresse hinterlegt – kein Versand per E-Mail (kein Rückgriff auf den Mieter). Das PDF steht in der Rechnung bereit.</p>}
            <div className="flex flex-col gap-2">
              <div className="label-xs">Zahlungen</div>
              {i.payments.length === 0 ? <p className="text-ink-3">Noch keine Zahlung erfasst.</p> : (
                <ul className="flex flex-col gap-1">
                  {i.payments.map((p) => (
                    <li key={p.id} className="rounded-md bg-panel-2 px-3 py-1.5 flex flex-col gap-0.5">
                      <div className="flex flex-wrap justify-between gap-x-3"><span>{fmtDate(p.paidAt)} · {p.type === "DEPOSIT_OFFSET" ? "Kautionsverrechnung" : PAYMENT_METHODS[p.method as keyof typeof PAYMENT_METHODS] ?? p.method}{p.reference ? ` · ${p.reference}` : ""}{p.createdByName ? ` · erfasst von ${p.createdByName}` : ""}</span><span className={`font-mono tnum ${p.status === "CANCELLED" ? "line-through text-ink-3" : ""}`}>{fmtCents(p.amountCents)}</span></div>
                      {p.status === "CANCELLED" && <div className="text-xs text-bad">Storniert{p.cancelledAt ? ` am ${fmtDateTime(p.cancelledAt)}` : ""}{p.cancelledByName ? ` von ${p.cancelledByName}` : ""}: {p.cancellationReason}</div>}
                      {bill.open && p.status === "CONFIRMED" && p.type !== "DEPOSIT_OFFSET" && <ReasonForm variant="button" action={cancelAccidentPaymentAction.bind(null, h.id)} id={p.id} label="Zahlung stornieren" confirmLabel="Zahlung stornieren" question={`Zahlung über ${fmtCents(p.amountCents)} wirklich stornieren?`} explanation="Die Zahlung wird nicht gelöscht, sondern als storniert gekennzeichnet. Die Forderung ist danach wieder offen." />}
                    </li>
                  ))}
                </ul>
              )}
              {bill.open && !i.neutralized && i.openCents > 0 && <PaymentForm action={recordAccidentPaymentAction.bind(null, h.id, i.id)} preview={previewAccidentPaymentAction.bind(null, h.id)} targetId={i.id} targetField={null} nonce={randomUUID()} defaultWhen={now} />}
            </div>
            {i.recipientRole === "INSURER" && i.billingType !== "REMAINDER" && (
              <div className="flex flex-col gap-2">
                <div className="label-xs">Dokumentierte Kürzungen</div>
                {i.adjustments.length === 0 ? <p className="text-ink-3">Keine.</p> : (
                  <ul className="flex flex-col gap-1">
                    {i.adjustments.map((x) => (
                      <li key={x.id} className="rounded-md bg-panel-2 px-3 py-1.5 flex flex-col gap-0.5">
                        <div className="flex flex-wrap justify-between gap-x-3"><span>{fmtDate(x.decidedAt)} · {x.reasonLabel}{x.note ? ` · ${x.note}` : ""}{x.createdByName ? ` · erfasst von ${x.createdByName}` : ""}</span><span className={`font-mono tnum ${x.status !== "CONFIRMED" ? "line-through text-ink-3" : ""}`}>{fmtCents(x.amountCents)}</span></div>
                        {x.document && <div className="text-xs break-all"><a href={`/api/accident-documents/${x.document.id}`} target="_blank" rel="noopener" className="underline">Schreiben: {x.document.fileName}</a>{x.document.archivedAt ? " (archiviert)" : ""}</div>}
                        {x.status !== "CONFIRMED" && <div className="text-xs text-bad">Storniert{x.cancelledAt ? ` am ${fmtDateTime(x.cancelledAt)}` : ""}{x.cancelledByName ? ` von ${x.cancelledByName}` : ""}: {x.cancellationReason}</div>}
                        {bill.open && x.status === "CONFIRMED" && <CaseReasonForm action={cancelAccidentAdjustmentAction.bind(null, h.id, x.id)} label="Kürzung stornieren" question={`Kürzung über ${fmtCents(x.amountCents)} stornieren?`} submitLabel="Kürzung stornieren" explanation="Die Kürzung wird nicht gelöscht, sondern mit Grund als storniert gekennzeichnet und bleibt nachvollziehbar." danger />}
                      </li>
                    ))}
                  </ul>
                )}
                {i.reducedCents > 0 && <p className="text-xs text-ink-3">Kürzungen sind nur dokumentiert: Rechnungsbetrag, Steuer, Zahlungen und offene Forderung bleiben unverändert.</p>}
                {bill.open && i.adjustableCents > 0 && <AdjustmentForm action={recordAccidentAdjustmentAction.bind(null, h.id, i.id)} maxCents={i.adjustableCents} letters={letters} today={today} />}
                {i.remainders.length > 0 && <p className="text-xs text-ink-2">Restforderung an den Mieter: {i.remainders.map((r) => `${r.number ?? "Entwurf"} über ${fmtCents(r.grossCents)}${r.neutralized ? " (storniert)" : r.openCents > 0 ? ` (offen ${fmtCents(r.openCents)})` : " (bezahlt)"}`).join("; ")}</p>}
                {bill.open && !a.hasDraft && i.remainderAvailableCents > 0 && <RemainderForm action={createAccidentRemainderAction.bind(null, h.id, i.id)} maxCents={i.remainderAvailableCents} invoiceNumber={i.number ?? ""} insurerName={i.recipientName} nonce={randomUUID()} />}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><Link href={invoiceHref({ id: i.id, bookingId: b.id, kind: "ACCIDENT_REPLACEMENT" })} className="btn !py-1 text-xs">Rechnung öffnen</Link><span className="text-xs text-ink-3">PDF, Gutschrift/Storno, Mahnung</span></div>
          </div>
        </Card>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

export async function HistoryTab({ tenantId, h, access }: { tenantId: string; h: Header; access: CaseFileAccess }) {
  const entries = await caseFileHistory(tenantId, h.id, access);
  return (
    <Card title="Verlauf" right={<span className="text-xs text-ink-3">{entries.length} Einträge</span>}>
      {entries.length === 0 ? <p className="p-4 text-sm text-ink-3">Noch keine Einträge.</p> : (
        <ul className="divide-y divide-line-soft">
          {entries.map((e) => (
            <li key={e.id} className="px-4 py-2.5 grid grid-cols-1 sm:grid-cols-[150px_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-sm">
              <span className="font-mono tnum text-xs text-ink-3 sm:pt-0.5">{fmtDateTime(e.at)}</span>
              <div className="min-w-0">
                <div className="font-medium">{e.label}{e.userName ? <span className="font-normal text-ink-3"> · {e.userName}</span> : null}</div>
                {(e.from || e.to) && <div className="text-ink-2 break-words">{e.from ? `${e.from} → ` : ""}{e.to ?? ""}</div>}
                {e.reason && <div className="text-ink-2 break-words">Grund: {e.reason}</div>}
                {e.note && <div className="text-ink-3 text-xs break-words">{e.note}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, PageHeader, Plate, VehicleStatusChip } from "@/components/ui";
import { AUTHORITY_CASE_STATUS, AUTHORITY_CASE_TYPES, AUTHORITY_DOCUMENT_TYPES, AUTHORITY_EVENT_TYPES, AUTHORITY_RESPONSE_TYPES, ASSIGNMENT_STATUS, SUBMISSION_METHODS, type AuthorityCaseStatus, type AuthorityCaseType, type AuthorityDocumentType, type AuthorityResponseType, type SubmissionMethod } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { authorityCaseView, buildResponsePdfData } from "@/lib/authority";
import { customerName, fmtDate, fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { toDateInputValue, toDateTimeInputValue, zonedParts } from "@/lib/time";
import { addNoteAction, approveResponseAction, archiveDocumentAction, assignBookingAction, assignVehicleAction, cancelCaseAction, closeCaseAction, prepareResponseAction, rematchAction, reopenCaseAction, setDriverAction, setInternalNoteAction, submitResponseAction, updateCaseAction } from "../actions";
import { AuthorityStatusChip, AuthorityTypeChip, DeadlineChip, DriverChip, RentalMatchChip, ResponseStatusChip, VehicleMatchChip } from "../chips";
import { ApproveForm, CaseForm, ConfirmReasonForm, DocumentUploader, DriverForm, InternalNoteForm, NoteForm, PrepareResponseForm, SelectForm, SimpleButton, SubmitForm } from "../authority-forms";

export const metadata = { title: "Behördenvorgang" };

const eur = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const timeValue = (d: Date) => { const p = zonedParts(d); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };

export default async function AuthorityCasePage({ params, searchParams }: PageProps<"/behoerden/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  let c: Awaited<ReturnType<typeof authorityCaseView>>;
  try {
    c = await authorityCaseView(tenant.id, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const canManage = user.role !== "YARD";
  const open = c.status !== "CLOSED" && c.status !== "CANCELLED";
  const r = c.currentResponse;
  const submitted = c.responses.some((x) => x.status === "SUBMITTED");
  const hasDriver = c.driverDeterminationStatus === "CONTRACT_DRIVER_SELECTED" || c.driverDeterminationStatus === "OTHER_DRIVER_ENTERED";
  const allowedTypes = [
    ...(hasDriver ? ["DRIVER_IDENTIFIED"] : []),
    ...(c.driverCandidates.length > 0 ? ["MULTIPLE_POSSIBLE_DRIVERS"] : []),
    ...(c.bookingId ? ["DRIVER_NOT_IDENTIFIABLE"] : []),
    ...(!c.bookingId && c.vehicleId ? ["NO_MATCHING_RENTAL"] : []),
    ...(!c.vehicleId ? ["VEHICLE_NOT_IN_FLEET"] : []),
    "CUSTOM_RESPONSE",
  ];
  const preview = r ? buildResponsePdfData(c, r) : null;
  const receiptOptions = c.activeDocuments.filter((d) => d.type === "SUBMISSION_RECEIPT").map((d) => ({ id: d.id, label: d.fileName }));
  const vehicleOptions = (c.plateHits.length > 0 ? c.plateHits : c.vehicleOptions).map((v) => ({ id: v.id, label: v.plate, detail: `${v.make} ${v.model}` }));

  return (
    <>
      <PageHeader title={`Behördenvorgang ${c.caseNumber}`} sub={<><AuthorityTypeChip type={c.type} /> <Plate>{c.licensePlateSnapshot}</Plate> · {c.authorityName} · Az. <span className="font-mono">{c.authorityReference}</span></>}>
        <AuthorityStatusChip status={c.status} />
        <DeadlineChip level={c.deadline.level} text={c.deadline.text} />
        <Link href="/behoerden" className="btn">Übersicht</Link>
      </PageHeader>
      <Content>
        {sp.neu === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Vorgang {c.caseNumber} angelegt. Fahrzeug und Vermietung wurden automatisch geprüft – die Fahrerbestimmung bleibt eine bewusste Entscheidung.</p>}
        {open && (c.deadline.level === "OVERDUE" || c.deadline.level === "DUE") && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm font-medium">Antwortfrist {c.deadline.text} (Antwort bis {fmtDate(c.responseDeadline!)}).</p>}
        {c.status === "CLOSED" && <p className="rounded-md bg-panel-2 px-3.5 py-2.5 text-sm">Abgeschlossen {c.closedAt ? fmtDateTime(c.closedAt) : ""}{c.closedByName ? ` von ${c.closedByName}` : ""}: {c.closeReason}</p>}
        {c.status === "CANCELLED" && <p className="rounded-md bg-panel-2 px-3.5 py-2.5 text-sm">Storniert: {c.closeReason}</p>}
        {!canManage && <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">Lesender Zugriff: Zuordnung, Fahrerbestimmung, Freigabe und Übermittlung entscheidet die Disposition.</p>}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card title="Schreiben" right={<Chip>{AUTHORITY_CASE_TYPES[c.type as AuthorityCaseType]}</Chip>}>
            <dl className="p-4 grid grid-cols-[150px_1fr] gap-y-1.5 text-sm">
              <dt className="label-xs self-center">Behörde</dt><dd>{c.authorityName}{c.authorityDepartment ? <span className="text-ink-3"> · {c.authorityDepartment}</span> : null}</dd>
              <dt className="label-xs self-center">Aktenzeichen</dt><dd className="font-mono">{c.authorityReference}</dd>
              {c.authorityAddress && <><dt className="label-xs self-start">Anschrift</dt><dd className="whitespace-pre-line">{c.authorityAddress}</dd></>}
              <dt className="label-xs self-center">E-Mail</dt><dd>{c.authorityEmail ?? <span className="text-ink-3">– (kein E-Mail-Versand möglich)</span>}</dd>
              <dt className="label-xs self-center">Portal</dt><dd>{c.portal.ok ? <a href={c.portal.href!} target="_blank" rel="noopener noreferrer" className="underline break-all">{c.portal.host}</a> : c.authorityPortalUrl ? <span className="text-amber">Adresse ungültig (nur https) – nicht verlinkt</span> : "–"}</dd>
              <dt className="label-xs self-center">Kennzeichen</dt><dd><Plate>{c.licensePlateSnapshot}</Plate> <span className="text-xs text-ink-3">Vergleichsschlüssel {c.licensePlateNormalized}</span></dd>
              <dt className="label-xs self-center">Tatzeit</dt><dd>{c.offenseText}{!c.offenseTimeKnown && <span className="text-xs text-amber"> · Zuordnung nur tagesgenau</span>}</dd>
              <dt className="label-xs self-center">Tatort</dt><dd>{c.offenseLocation ?? "–"}</dd>
              <dt className="label-xs self-center">Verstoß</dt><dd>{c.offenseType ?? "–"}</dd>
              {c.offenseDescription && <><dt className="label-xs self-start">Beschreibung</dt><dd className="whitespace-pre-line">{c.offenseDescription}</dd></>}
              <dt className="label-xs self-center">Antwortfrist</dt><dd>{c.responseDeadline ? <>Antwort bis {fmtDate(c.responseDeadline)} <DeadlineChip level={c.deadline.level} text={c.deadline.text} /></> : <span className="text-ink-3">keine Frist im Schreiben hinterlegt</span>}</dd>
              <dt className="label-xs self-center">Betrag laut Schreiben</dt><dd>{c.noticeAmountCents != null ? <><span className="font-mono tnum">{fmtCents(c.noticeAmountCents)}</span> <span className="text-xs text-ink-3">nur Information – keine Rechnung, Forderung oder Belastung</span></> : "–"}</dd>
              {c.notes && <><dt className="label-xs self-start">Notizen</dt><dd className="whitespace-pre-line">{c.notes}</dd></>}
              <dt className="label-xs self-center">Angelegt</dt><dd>{fmtDateTime(c.createdAt)}{c.createdByName ? ` von ${c.createdByName}` : ""}</dd>
            </dl>
            {canManage && open && (
              <div className="px-4 pb-4">
                <CaseForm action={updateCaseAction.bind(null, c.id)} collapsible submitLabel="Speichern" values={{ type: c.type, authorityName: c.authorityName, authorityDepartment: c.authorityDepartment ?? "", authorityReference: c.authorityReference, authorityAddress: c.authorityAddress ?? "", authorityEmail: c.authorityEmail ?? "", authorityPortalUrl: c.authorityPortalUrl ?? "", offenseType: c.offenseType ?? "", offenseDescription: c.offenseDescription ?? "", offenseDate: toDateInputValue(c.offenseAt), offenseTime: c.offenseTimeKnown ? timeValue(c.offenseAt) : "", offenseLocation: c.offenseLocation ?? "", licensePlate: c.licensePlateSnapshot, responseDeadline: c.responseDeadline ? toDateInputValue(c.responseDeadline) : "", noticeAmount: eur(c.noticeAmountCents), notes: c.notes ?? "" }} />
              </div>
            )}
          </Card>

          <div className="flex flex-col gap-4">
            <Card title="Fahrzeugzuordnung" right={<VehicleMatchChip status={c.vehicleMatch} />}>
              <div className="p-4 flex flex-col gap-3 text-sm">
                {c.vehicle ? (
                  <div className="flex flex-wrap items-center gap-2"><Plate>{c.vehicle.plate}</Plate><Link href={`/fahrzeuge/${c.vehicle.id}?tab=behoerden`} className="underline">{c.vehicle.make} {c.vehicle.model}</Link><VehicleStatusChip status={c.vehicle.status} /></div>
                ) : (
                  <p className="text-ink-3">{c.vehicleMatch === "AMBIGUOUS" ? "Mehrere Fahrzeuge tragen dieses Kennzeichen – bitte bewusst auswählen." : c.vehicleMatch === "NO_MATCH" ? "Kein Fahrzeug der Flotte trägt dieses Kennzeichen. Möglich: Schreibfehler im Schreiben, altes Kennzeichen oder fremdes Fahrzeug." : "Noch kein Fahrzeug zugeordnet."}</p>
                )}
                {c.vehicleMatch === "AMBIGUOUS" && c.plateHits.length > 0 && <ul className="flex flex-col gap-1">{c.plateHits.map((v) => <li key={v.id} className="flex items-center gap-2"><Plate>{v.plate}</Plate><span>{v.make} {v.model}</span></li>)}</ul>}
                {canManage && open && (
                  <div className="flex flex-col gap-2">
                    <SelectForm action={assignVehicleAction.bind(null, c.id)} name="vehicleId" label={c.vehicleId ? "Fahrzeug ändern (manuell)" : "Fahrzeug manuell zuordnen"} options={vehicleOptions} current={c.vehicleId} submitLabel="Zuordnung speichern" emptyLabel="– kein Fahrzeug –" hint={c.plateHits.length > 0 ? "Vorauswahl auf Fahrzeuge mit passendem Kennzeichen eingeschränkt." : "Manuelle Zuordnung nur, wenn das Kennzeichen im Schreiben erkennbar abweicht (z. B. Tippfehler)."} />
                    <div><SimpleButton action={rematchAction.bind(null, c.id)} label="Automatische Zuordnung erneut prüfen" pendingLabel="…" /></div>
                  </div>
                )}
              </div>
            </Card>

            <Card title="Vermietung zur Tatzeit" right={<RentalMatchChip status={c.rentalMatch} dayOnly={c.rentalMatchDayOnly} />}>
              <div className="p-4 flex flex-col gap-3 text-sm">
                <div className="text-xs text-ink-3">Zuordnungsstand: {ASSIGNMENT_STATUS[c.assignmentStatus as keyof typeof ASSIGNMENT_STATUS] ?? c.assignmentStatus}</div>
                {c.booking ? (
                  <div className="rounded-md bg-panel-2 p-3 flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2"><Link href={`/buchungen/${c.booking.id}`} className="btn !py-1.5 font-mono tnum">{c.booking.number}</Link><span>{customerName(c.booking.customer)}</span>{c.booking.contract?.status === "SIGNED" ? <Chip tone="good">Vertrag {c.booking.contract.number}</Chip> : <Chip tone="amber">kein finalisierter Vertrag</Chip>}</div>
                    <div className="text-xs text-ink-2">{c.booking.actualPickupAt ? `Tatsächlich übergeben ${fmtDateTime(c.booking.actualPickupAt)} · ${c.booking.actualReturnAt ? `zurückgegeben ${fmtDateTime(c.booking.actualReturnAt)}` : "Rückgabe noch offen (laufende Miete)"}` : `Geplant ${fmtDateTime(c.booking.startAt)} – ${fmtDateTime(c.booking.endAt)} (keine finalisierte Übergabe)`}</div>
                    <p className="text-xs text-amber">Die Vermietung belegt nur, wer das Fahrzeug gemietet hat – nicht, wer es zur Tatzeit gefahren hat.</p>
                  </div>
                ) : (
                  <p className="text-ink-3">{!c.vehicleId ? "Ohne Fahrzeugzuordnung kann keine Vermietung gesucht werden." : c.rentalCandidates.length > 1 ? "Mehrere Vermietungen kommen in Frage – keine automatische Auswahl. Bitte prüfen und bewusst zuordnen." : "Zur Tatzeit wurde keine Vermietung dieses Fahrzeugs gefunden."}</p>
                )}
                {c.rentalCandidates.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="label-xs">Gefundene Vermietungen ({c.rentalCandidates.length})</div>
                    <ul className="divide-y divide-line-soft">{c.rentalCandidates.map((k) => <li key={k.bookingId} className="py-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"><Link href={`/buchungen/${k.bookingId}`} className="font-mono tnum underline">{k.bookingNumber}</Link><Chip tone={k.basis === "ACTUAL" ? "good" : "amber"}>{k.basis === "ACTUAL" ? "tatsächliche Zeiten" : "nur geplant"}</Chip><span className="text-xs text-ink-3">{fmtDateTime(k.windowStart)} – {k.windowEnd ? fmtDateTime(k.windowEnd) : "laufend"} · {k.explanation}</span>{k.bookingId === c.bookingId && <Chip tone="info">zugeordnet</Chip>}</li>)}</ul>
                  </div>
                )}
                {canManage && open && c.vehicleId && (
                  <SelectForm action={assignBookingAction.bind(null, c.id)} name="bookingId" label="Vermietung zuordnen" options={c.rentalCandidates.map((k) => ({ id: k.bookingId, label: k.bookingNumber, detail: k.basis === "ACTUAL" ? "tatsächliche Zeiten" : "nur geplant" }))} current={c.bookingId} submitLabel="Zuordnung speichern" emptyLabel="– keine Vermietung –" hint="Halboffen: eine Tatzeit exakt zum Rückgabezeitpunkt zählt nicht mehr zur beendeten Miete." />
                )}
              </div>
            </Card>
          </div>
        </div>

        <Card title="Fahrerbestimmung" right={<DriverChip status={c.driverDeterminationStatus} />}>
          <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
            <div className="flex flex-col gap-3">
              <div className="label-xs">Fahrerkandidaten aus dem finalisierten Mietvertrag</div>
              {c.driverCandidates.length === 0 ? (
                <p className="text-ink-3">{c.bookingId ? "Zur zugeordneten Buchung gibt es keinen finalisierten Mietvertrag mit Fahrerangaben." : "Keine Vermietung zugeordnet – daher keine Kandidaten."}</p>
              ) : (
                <ul className="flex flex-col gap-1">{c.driverCandidates.map((d) => <li key={d.contractDriverId} className={`rounded-md px-3 py-2 ${c.driverContractDriverId === d.contractDriverId ? "bg-info-soft" : "bg-panel-2"}`}><span className="font-medium">{d.firstName} {d.lastName}</span> <span className="text-xs text-ink-3">· {d.roleLabel} · geb. {fmtDate(d.birthDate)} · {d.zip} {d.city}</span>{c.driverContractDriverId === d.contractDriverId && <Chip tone="info">bestimmt</Chip>}</li>)}</ul>
              )}
              {c.driverCandidates.length > 1 && <p className="text-xs text-amber">Mehrere Vertragsfahrer: Rent-Base hebt keinen als „wahrscheinlichsten Fahrer“ hervor.</p>}
              {c.driver && (
                <div className="rounded-md border border-line-soft p-3">
                  <div className="label-xs">Bestimmte Person</div>
                  <div className="font-medium">{c.driver.firstName} {c.driver.lastName}</div>
                  <div className="text-xs text-ink-3">{c.driver.source === "CONTRACT_DRIVER" ? (c.driver.role === "PRIMARY_DRIVER" ? "vertraglicher Hauptfahrer" : "zusätzlicher Vertragsfahrer") : "andere Person (manuell erfasst)"}{c.driver.birthDate ? ` · geb. ${fmtDate(new Date(`${c.driver.birthDate}T12:00:00`))}` : ""}{c.driver.city ? ` · ${c.driver.zip ?? ""} ${c.driver.city}` : ""}</div>
                  {c.driverNote && <div className="text-xs text-ink-2 mt-1">Grundlage: {c.driverNote}</div>}
                  {c.driverCustomerId && <Link href={`/kunden/${c.driverCustomerId}`} className="text-xs underline">Kundenakte</Link>}
                </div>
              )}
              {!c.driver && c.driverNote && <div className="text-xs text-ink-2">Begründung: {c.driverNote}</div>}
            </div>
            <div>
              {canManage && open ? (
                <DriverForm action={setDriverAction.bind(null, c.id)} candidates={c.driverCandidates.map((d) => ({ contractDriverId: d.contractDriverId, roleLabel: d.roleLabel, name: `${d.firstName} ${d.lastName}`, birthDate: fmtDate(d.birthDate), city: d.city }))} current={c.driverDeterminationStatus} currentContractDriverId={c.driverContractDriverId} />
              ) : (
                <p className="text-xs text-ink-3">{open ? "Die Fahrerbestimmung trifft die Disposition." : "Keine Änderung nach dem Abschluss."}</p>
              )}
              {submitted && open && canManage && <p className="text-xs text-ink-3 mt-2">Eine Änderung wirkt nur auf neue Antwortfassungen; die übermittelte Fassung bleibt unverändert.</p>}
            </div>
          </div>
        </Card>

        <Card title="Antwort an die Behörde" right={r ? <ResponseStatusChip status={r.status} /> : <Chip>keine Fassung</Chip>}>
          <div className="p-4 flex flex-col gap-4 text-sm">
            {r && preview && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Fassung {r.version}</span><ResponseStatusChip status={r.status} /><Chip>{AUTHORITY_RESPONSE_TYPES[r.responseType as AuthorityResponseType]}</Chip><Chip tone="info">{SUBMISSION_METHODS[r.submissionMethod as SubmissionMethod]}</Chip>
                  {r.pdfDocumentId && <a href={`/api/authority-documents/${r.pdfDocumentId}`} target="_blank" rel="noopener noreferrer" className="btn !py-1.5">Antwort-PDF öffnen</a>}
                </div>
                <div className="text-xs text-ink-3">Erstellt {fmtDateTime(r.createdAt)} von {r.createdByName}{r.approvedAt ? ` · freigegeben ${fmtDateTime(r.approvedAt)} von ${r.approvedByName}` : ""}{r.submittedAt ? ` · übermittelt ${fmtDateTime(r.submittedAt)} von ${r.submittedByName}` : ""}{r.contentHash ? ` · Prüfsumme ${r.contentHash.slice(0, 16)}…` : ""}</div>
                {r.status === "FAILED" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3 py-2">Übermittlung fehlgeschlagen: {r.failureReason}. Der Vorgang bleibt offen; ein erneuter Versuch ist möglich.</p>}
                <div className="rounded-lg border border-line-soft bg-panel p-4 flex flex-col gap-2" aria-label="Vorschau der Antwort">
                  <div className="text-xs text-ink-3">Vorschau – genau dieser Inhalt geht an die Behörde</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
                    <div><span className="label-xs">Empfänger</span><br />{preview.recipient.name}{preview.recipient.department ? `, ${preview.recipient.department}` : ""}{preview.recipient.addressLines.length ? <><br />{preview.recipient.addressLines.join(", ")}</> : null}{preview.recipient.email ? <><br />{preview.recipient.email}</> : null}</div>
                    <div><span className="label-xs">Absender</span><br />{preview.sender.name}{preview.sender.addressLines.length ? <><br />{preview.sender.addressLines.join(", ")}</> : null}</div>
                    <div><span className="label-xs">Ihr Aktenzeichen</span><br />{preview.authorityReference}</div>
                    <div><span className="label-xs">Fahrzeug / Tatzeit</span><br />{preview.vehicle.plate}{preview.vehicle.description ? ` · ${preview.vehicle.description}` : ""}<br />{preview.offense.atText}{preview.offense.location ? ` · ${preview.offense.location}` : ""}</div>
                    {preview.rental && <div className="sm:col-span-2"><span className="label-xs">Vermietung</span><br />Buchung {preview.rental.bookingNumber}{preview.rental.contractNumber ? ` · Vertrag ${preview.rental.contractNumber}` : ""} · {preview.rental.windowText}<br /><span className="text-ink-3">{preview.rental.basisText}</span></div>}
                  </div>
                  <div className="font-medium mt-1">{preview.responseTypeLabel}</div>
                  {preview.statement && <p>{preview.statement}</p>}
                  {preview.persons.map((p, i) => <div key={i} className="rounded-md bg-panel-2 p-2"><div className="text-xs font-medium">{p.role}</div><dl className="grid grid-cols-[120px_1fr] text-xs gap-y-0.5">{p.fields.map((f) => <div key={f.label} className="contents"><dt className="text-ink-3">{f.label}</dt><dd>{f.value}</dd></div>)}</dl></div>)}
                  {preview.freeText && <p className="whitespace-pre-line">{preview.freeText}</p>}
                  {preview.persons.length === 0 && <p className="text-xs text-ink-3">Diese Antwort enthält keine Personendaten.</p>}
                </div>
                {canManage && open && r.status === "DRAFT" && <ApproveForm action={approveResponseAction.bind(null, c.id)} responseId={r.id} personCount={preview.persons.length} />}
                {canManage && open && (r.status === "APPROVED" || r.status === "FAILED") && (
                  <div className="flex flex-col gap-2">
                    {r.submissionMethod === "POST" && <p className="rounded-md bg-info-soft text-info px-3 py-2">Für Postversand vorbereitet: PDF öffnen, ausdrucken, versenden – danach als versendet markieren.</p>}
                    {r.submissionMethod === "MANUAL_PORTAL" && <p className="rounded-md bg-info-soft text-info px-3 py-2">Manuelle Übermittlung im Behördenportal{c.portal.ok ? <> (<a href={c.portal.href!} target="_blank" rel="noopener noreferrer" className="underline">{c.portal.host}</a>)</> : ""} – Rent-Base füllt kein Portal aus und speichert keine Zugangsdaten.</p>}
                    <SubmitForm action={submitResponseAction.bind(null, c.id)} responseId={r.id} method={r.submissionMethod} recipientEmail={(r.recipientSnapshot as { email: string | null }).email} retryNonce={r.status === "FAILED" ? crypto.randomUUID().slice(0, 12) : null} receiptOptions={receiptOptions} defaultSubmittedAt={toDateTimeInputValue(new Date())} />
                  </div>
                )}
                {!canManage && r.status !== "SUBMITTED" && <p className="text-xs text-ink-3">Freigabe und Übermittlung entscheidet die Disposition.</p>}
              </div>
            )}
            {!r && <p className="text-ink-3">Noch keine Antwortfassung. Reihenfolge: Zuordnung prüfen → Fahrerbestimmung → Antwort vorbereiten → Vorschau prüfen → freigeben → übermitteln.</p>}
            {canManage && open && !submitted && <PrepareResponseForm action={prepareResponseAction.bind(null, c.id)} allowedTypes={allowedTypes} hasEmail={!!c.authorityEmail} hasPersons={hasDriver || c.driverCandidates.length > 0} defaultType={hasDriver ? "DRIVER_IDENTIFIED" : !c.vehicleId ? "VEHICLE_NOT_IN_FLEET" : !c.bookingId ? "NO_MATCHING_RENTAL" : c.driverCandidates.length > 1 ? "MULTIPLE_POSSIBLE_DRIVERS" : "DRIVER_NOT_IDENTIFIABLE"} defaultMethod={c.authorityEmail ? "EMAIL" : "POST"} />}
            {canManage && open && submitted && <p className="text-xs text-ink-3">Nach einer Übermittlung sind neue Fassungen nicht vorgesehen. Für eine Korrektur den Vorgang abschließen und ein neues Schreiben erfassen oder den Sachverhalt in der Historie dokumentieren.</p>}
            {c.responses.filter((x) => x.id !== r?.id).length > 0 && (
              <details className="text-xs text-ink-3"><summary className="cursor-pointer">Frühere Fassungen ({c.responses.filter((x) => x.id !== r?.id).length})</summary>
                <ul className="mt-1 flex flex-col gap-1">{c.responses.filter((x) => x.id !== r?.id).map((x) => <li key={x.id} className="flex flex-wrap items-center gap-2">Fassung {x.version} <ResponseStatusChip status={x.status} /> {AUTHORITY_RESPONSE_TYPES[x.responseType as AuthorityResponseType]} · {fmtDateTime(x.createdAt)}{x.pdfDocumentId && <a href={`/api/authority-documents/${x.pdfDocumentId}`} target="_blank" rel="noopener noreferrer" className="underline">PDF</a>}</li>)}</ul>
              </details>
            )}
            <p className="text-xs text-ink-3">Es wird nie automatisch ein Fahrer gemeldet. Jede Fassung wird vor der Freigabe angezeigt; freigegebene Fassungen sind unveränderlich – Korrekturen sind neue Fassungen.</p>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card title="Übermittlungsnachweise" right={<Chip>{c.receipts.length}</Chip>}>
            <div className="p-4 text-sm">
              {c.receipts.length === 0 ? <p className="text-ink-3">Noch keine Übermittlung.</p> : (
                <ul className="divide-y divide-line-soft">{c.receipts.map((x) => <li key={x.id} className="py-2 flex flex-col gap-0.5"><div className="flex flex-wrap items-center gap-2"><Chip tone="good">{SUBMISSION_METHODS[x.method as SubmissionMethod] ?? x.method}</Chip><span className="font-mono tnum text-xs">{fmtDateTime(x.submittedAt)}</span>{x.reference && <span className="text-xs">Ref. {x.reference}</span>}</div><div className="text-xs text-ink-3">{x.note ?? ""}{x.createdByName ? ` · bestätigt von ${x.createdByName}` : ""}{x.documentId && <> · <a href={`/api/authority-documents/${x.documentId}`} target="_blank" rel="noopener noreferrer" className="underline">Nachweisdokument</a></>}</div></li>)}</ul>
              )}
            </div>
          </Card>

          <Card title="Dokumente" right={<Chip>{c.activeDocuments.length}</Chip>}>
            <div className="p-4 flex flex-col gap-3 text-sm">
              {c.activeDocuments.length === 0 && <p className="text-ink-3">Noch kein Dokument – z. B. das Behördenschreiben als PDF oder Foto.</p>}
              <ul className="divide-y divide-line-soft">
                {c.activeDocuments.map((d) => (
                  <li key={d.id} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Chip tone={d.type === "RESPONSE_PDF" ? "info" : "grey"}>{AUTHORITY_DOCUMENT_TYPES[d.type as AuthorityDocumentType] ?? d.type}</Chip>
                    <a href={`/api/authority-documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline break-all">{d.fileName}</a>
                    <span className="text-xs text-ink-3">{kb(d.sizeBytes)} · {fmtDateTime(d.createdAt)}{d.createdByName ? ` von ${d.createdByName}` : ""}</span>
                    {d.note && <span className="text-xs text-ink-2">{d.note}</span>}
                    {canManage && open && d.type !== "RESPONSE_PDF" && <ConfirmReasonForm action={archiveDocumentAction.bind(null, c.id, d.id)} label="Archivieren" question={`„${d.fileName}“ archivieren? Datei und Eintrag bleiben nachvollziehbar erhalten.`} submitLabel="Archivieren" pendingLabel="…" danger />}
                  </li>
                ))}
              </ul>
              {c.archivedDocuments.length > 0 && <details className="text-xs text-ink-3"><summary className="cursor-pointer">{c.archivedDocuments.length} archivierte Dokumente</summary><ul className="mt-1 flex flex-col gap-1">{c.archivedDocuments.map((d) => <li key={d.id}><a href={`/api/authority-documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="underline">{d.fileName}</a> · archiviert {fmtDateTime(d.archivedAt!)} von {d.archivedByName ?? "–"}: {d.archiveReason}</li>)}</ul></details>}
              {canManage && c.status !== "CANCELLED" && <DocumentUploader endpoint={`/api/authority-cases/${c.id}/documents`} defaultType={c.activeDocuments.some((d) => d.type === "INCOMING_NOTICE") ? "CORRESPONDENCE" : "INCOMING_NOTICE"} />}
            </div>
          </Card>
        </div>

        <Card title="Abschluss">
          <div className="p-4 flex flex-wrap gap-3 items-start text-sm">
            {canManage && open && <ConfirmReasonForm action={closeCaseAction.bind(null, c.id)} label="Vorgang abschließen" question="Vorgang abschließen?" reasonLabel="Abschlussgrund" warning={!submitted ? "Es wurde keine Antwort übermittelt. Bitte den Grund festhalten (z. B. telefonisch erledigt, Bescheid bezahlt, keine Antwort erforderlich)." : null} submitLabel="Ja, abschließen" pendingLabel="Wird abgeschlossen…" />}
            {canManage && open && !submitted && <ConfirmReasonForm action={cancelCaseAction.bind(null, c.id)} label="Vorgang stornieren" question="Vorgang stornieren (z. B. Doppelerfassung)? Er bleibt in der Historie sichtbar." reasonLabel="Stornogrund" submitLabel="Ja, stornieren" pendingLabel="…" danger />}
            {canManage && !open && <ConfirmReasonForm action={reopenCaseAction.bind(null, c.id)} label="Vorgang wieder öffnen" question="Vorgang wieder öffnen?" reasonLabel="Grund" submitLabel="Ja, wieder öffnen" pendingLabel="…" />}
            {!open && <p className="text-ink-3">Der Vorgang ist {AUTHORITY_CASE_STATUS[c.status as AuthorityCaseStatus].toLowerCase()}.</p>}
            {!canManage && <p className="text-xs text-ink-3">Abschluss und Wiederöffnen entscheidet die Disposition.</p>}
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card title="Notizen">
            <div className="p-4 flex flex-col gap-4">
              {canManage ? <NoteForm action={addNoteAction.bind(null, c.id)} /> : <p className="text-sm text-ink-3">Notizen ergänzt die Disposition.</p>}
              {canManage && <InternalNoteForm action={setInternalNoteAction.bind(null, c.id)} value={c.internalNote ?? ""} />}
            </div>
          </Card>
          <Card title="Historie" right={<Chip>{c.events.length}</Chip>}>
            <ul className="divide-y divide-line-soft text-sm">
              {c.events.map((e) => (
                <li key={e.id} className="px-4 py-2 flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2"><span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(e.createdAt)}</span><span className="font-medium">{AUTHORITY_EVENT_TYPES[e.type as keyof typeof AUTHORITY_EVENT_TYPES] ?? e.type}</span>{e.userName && <span className="text-xs text-ink-3">{e.userName}</span>}</div>
                  {e.note && <div className="text-xs text-ink-2 whitespace-pre-line">{e.note}</div>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </Content>
    </>
  );
}

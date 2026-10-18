import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { getContractState } from "@/lib/contracts";
import { buildContractDocument } from "@/lib/contract-view";
import { customerToFormValues } from "@/lib/customer-form-values";
import { hasErrors } from "@/lib/contract-checks";
import { pickupAction } from "@/lib/booking-status";
import { startPickupAction } from "../uebergabe/actions";
import { DRIVER_ROLES, FUELS, RULE_SOURCES, VEHICLE_STATUS, driveClassOf, type Fuel, type VehicleStatus } from "@/lib/constants";
import { sourceText, type RuleKey } from "@/lib/business-rules";
import { readTariffSnapshot } from "@/lib/tariffs";
import { abroadSummary } from "@/lib/abroad";
import { requiredLicenseClassFor } from "@/lib/driver-verification";
import { tierLabel } from "@/lib/pricing";
import { fmtCents } from "@/lib/money";
import { ContractTermsText } from "@/components/terms-view";
import { customerName, fmtDate, fmtDateTime, fmtEur, fmtInt, toDateInput, toDateTimeInput } from "@/lib/format";
import { Card, Chip, Content, Field, PageHeader, Plate } from "@/components/ui";
import { CustomerFields } from "../../../kunden/customer-fields";
import { CONTRACT_CUSTOMER_CARDS } from "../../../kunden/customer-sections";
import {
  acknowledgeTermsAction,
  addDriverAction,
  adoptDefaultsAction,
  adoptTermsAction,
  finalizeContractAction,
  navigateStepAction,
  removeDriverAction,
  removeSignatureAction,
  saveConditionsStepAction,
  saveCustomerStepAction,
  saveDriverStepAction,
  saveSignatureAction,
  startContractAction,
} from "./actions";
import { ContractDocumentView, DriverFields, IssueList, PriceBreakdown, SummaryCards, emptyDriver, type DriverValues } from "./contract-parts";
import { AbroadRuleFields, AcknowledgeForm, ActionButton, DriverFeeFields, DriverModeSection, FinalizeForm, FuelRuleFields, InlineForm, KmPolicyField, NavButton, SignatureForm, StepForm, UsageRuleFields } from "./wizard-ui";
import { WIZARD_STEPS } from "./steps";
import { WizardShell } from "./wizard-shell";
import { Avatar, BAR_BACK, CardIssueNote, CardsGrid, ContractStepper, KeyValueList, LockedBox, MobileProgress, Note, SPAN_WIDE, SourceHint, WizardCard } from "./wizard-layout";
import { ContractIcon } from "./contract-icons";
import { buildOverviewData, buildReadiness, driverCheckState, editTargets, fieldIssues, groupDocumentRows, tariffLabel } from "./summary-map";
import { OverviewBody, ReadinessBody, Step7Brief, SummaryAside, SummaryDisclosure } from "./summary-panel";
import { isFeatureEnabled } from "@/lib/features";
import { ACCIDENT_CASE_CLOSED_MESSAGE } from "@/lib/accident-replacement-events";

export const metadata = { title: "Mietvertrag" };

const dec = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? "" : v.toString().replace(".", ","));

export default async function ContractPage({ params, searchParams }: PageProps<"/buchungen/[id]/vertrag">) {
  // Ansehen dürfen alle Mitarbeiter; erstellen und bearbeiten nur Inhaber und Disponent (siehe unten und actions.ts)
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const canEdit = user.role !== "YARD";
  const { id } = await params;
  const sp = await searchParams;

  const booking = await db.booking.findFirst({ where: { id, tenantId: tenant.id }, include: { customer: true, vehicle: { include: { group: true } }, contract: { select: { id: true, status: true } } } });
  if (!booking) notFound();
  // Befehl 29 Phase E: Unfallersatz – Mietende offen („bis zur Rückgabe“), Tarif aus der Fallakte; geschlossener Fall sperrt den Vertrag
  const accident = booking.rentalType === "ACCIDENT_REPLACEMENT";
  const accidentCase = accident ? await db.accidentReplacementCase.findFirst({ where: { tenantId: tenant.id, bookingId: booking.id }, select: { id: true, caseNumber: true, status: true } }) : null;
  const caseHref = accidentCase && (await isFeatureEnabled(tenant.id, "ACCIDENT_REPLACEMENT")) ? `/unfallersatz/${accidentCase.id}` : null;
  const caseClosed = accidentCase?.status === "CLOSED";
  const caseLink = caseHref ? <Link href={caseHref} className="btn">Zur Fallakte</Link> : null;
  const closedNotice = caseClosed ? <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm font-medium">{ACCIDENT_CASE_CLOSED_MESSAGE} Vertrag, Übergabe und Rückgabe sind gesperrt, bis der Fall {accidentCase!.caseNumber} in der Fallakte wieder geöffnet wird.</p> : null;
  // Hofmitarbeiter: kein Vertragsentwurf und keine Neuanlage, nur der abgeschlossene Vertrag ist einsehbar
  if (!canEdit && booking.contract?.status !== "SIGNED" && booking.contract?.status !== "CANCELLED") redirect(`/buchungen/${booking.id}?hinweis=${encodeURIComponent("Mietverträge erstellen und bearbeiten nur Inhaber und Disponenten.")}`);

  // Noch kein Vertrag: klare Startaktion
  if (!booking.contract) {
    const start = startContractAction.bind(null, booking.id);
    return (
      <>
        <PageHeader title="Mietvertrag" sub={`Buchung ${booking.number}`}>{caseLink}<Link href={`/buchungen/${booking.id}`} className="btn">Zur Buchung</Link></PageHeader>
        <Content>
          {closedNotice}
          <Card className="p-5 max-w-2xl flex flex-col gap-3">
            <p>Für {customerName(booking.customer)} und <Plate>{booking.vehicle.plate}</Plate> gibt es noch keinen Mietvertrag.</p>
            {booking.status === "RESERVED" && !caseClosed ? (
              <form action={start}><button className="btn btn-primary !py-2.5">Mietvertrag erstellen</button></form>
            ) : caseClosed ? (
              <p className="text-sm text-ink-3">Der Mietvertrag kann erst nach dem Wiederöffnen des Falls angelegt werden.</p>
            ) : (
              <p className="text-sm text-ink-3">Ein Vertrag wird nur für reservierte Buchungen angelegt.</p>
            )}
          </Card>
        </Content>
      </>
    );
  }

  const state = await getContractState(tenant.id, booking.contract.id);
  const { contract, signatures, issues, hash, terms, rules } = state;
  const doc = buildContractDocument(contract, tenant, signatures);
  const snap = rules.snapshot;
  const sourceOf = (key: RuleKey) => snap?.sources[key] ?? rules.resolved.sources[key];
  const sourceLabel = (key: string) => sourceText(sourceOf(key as RuleKey), { groupName: rules.resolved.groupName, vehiclePlate: rules.resolved.vehiclePlate });
  const badge = (key: string) => <span className="text-[11px] text-ink-2">Quelle: {sourceLabel(key)}</span>;
  // Befehl 29: Tarifbuchung – Preis, Kaution und Kilometer stehen in der Buchung (Abweichung dort mit Grund), hier nur Anzeige
  const tariffLocked = Boolean(booking.ratePlanId);
  const tariffName = tariffLocked ? readTariffSnapshot(booking.tariffSnapshot)?.ratePlanName ?? null : null;
  /** Quelle bei Tarifbuchungen: Miettarif oder – mit Grund in der Buchung – individuell vereinbart */
  const tariffSource = (overridden: boolean) => (overridden ? "Buchung (individuell vereinbart)" : `Miettarif${tariffName ? ` ${tariffName}` : ""}`);
  // Befehl 29.5: Selbstbeteiligung einer Tarifbuchung (ab 29.5) steht in der Buchung – hier nur Anzeige; ältere Buchungen wie bisher
  const deductibleLocked = booking.deductibleCents != null;
  const deductibleSource = booking.deductibleOverrideReason ? tariffSource(true) : readTariffSnapshot(booking.tariffSnapshot)?.deductible?.source === "TARIFF" ? tariffSource(false) : `Geschäftsregel, bei der Buchung übernommen (Miettarif${tariffName ? ` ${tariffName}` : ""} ohne eigene Vorgabe)`;
  const ruleSources = Object.fromEntries(["kmPolicy", "fuelRule", "petsPolicy", "smokingAllowed", "abroadAllowed", "additionalDriverFeeType", "additionalDriverFeeCents"].map((k) => [k, sourceLabel(k)]));
  const depositSource = rules.depositSource;
  const termsHint = terms.newerAvailable && terms.active && contract.status === "DRAFT" ? (step: number) => (
    <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm flex flex-wrap items-center gap-3">
      <span>Eine neuere Mietbedingungen-Fassung ist verfügbar (Version {terms.active!.label}). Dieser Entwurf behält Version {contract.termsVersion}, bis sie bewusst übernommen wird. Beim Wechsel werden Kenntnisnahme und Unterschriften zurückgesetzt.</span>
      <ActionButton action={adoptTermsAction.bind(null, booking.id, step)} label={`Version ${terms.active!.label} übernehmen`} className="btn !py-1.5" />
    </div>
  ) : () => null;

  // Abgeschlossen oder storniert: nur noch Anzeige
  if (contract.status !== "DRAFT") {
    // Befehl 21: nach dem Abschluss ist die Übergabe der nächste Schritt – bestehender Entwurf wird fortgesetzt, nie dupliziert
    const handovers = await db.handover.findMany({ where: { tenantId: tenant.id, bookingId: booking.id, correctsId: null }, select: { type: true, status: true } });
    const next = contract.status === "SIGNED" ? pickupAction(booking, contract, handovers) : { kind: "NONE" as const, label: "" };
    // Befehl 25: der Vertrag selbst bleibt unverändert; wirksame Nachträge werden hier nur genannt (Stand auf der Buchungsseite)
    const signedAmendments = contract.status === "SIGNED" ? await db.contractAmendment.findMany({ where: { tenantId: tenant.id, contractId: contract.id, status: "SIGNED" }, orderBy: { sequenceNo: "asc" }, select: { id: true, number: true, signedAt: true } }) : [];
    return (
      <>
        <PageHeader title={`Mietvertrag ${contract.number}`} sub={`Buchung ${booking.number}`}>
          {contract.status === "SIGNED" && booking.status === "RESERVED" && !caseClosed && <Chip tone="good">Bereit zur Übergabe</Chip>}
          {caseLink}
          <Link href={`/buchungen/${booking.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content>
          {closedNotice}
          {sp.abgeschlossen === "1" && <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">Der Mietvertrag ist abgeschlossen und versiegelt. Die Buchung ist bereit zur Übergabe.</p>}
          {(next.kind === "START" || next.kind === "CONTINUE") && !caseClosed && (
            <section aria-label="Nächster Schritt" className="rounded-xl border-2 border-brand bg-panel p-4 md:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
              <div className="flex-1 min-w-0">
                <div className="label-xs text-ink-3">Nächster Schritt</div>
                <div className="text-lg font-semibold leading-snug">Jetzt auf dem Tablet mit der Übergabe weitermachen</div>
                <p className="text-sm text-ink-2 mt-0.5">{next.kind === "CONTINUE" ? "Die Übergabe wurde bereits begonnen und wird fortgesetzt." : "Kilometerstand, Fahrzeugzustand, Fotos, Fahrerprüfung und Unterschrift – direkt am Fahrzeug."}</p>
              </div>
              {next.kind === "CONTINUE"
                ? <Link href={`/buchungen/${booking.id}/uebergabe`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">Übergabe fortsetzen</Link>
                : <form action={startPickupAction.bind(null, booking.id)}><button className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">Übergabe starten</button></form>}
            </section>
          )}
          {next.kind === "VIEW" && <p className="text-sm text-ink-2">Die Übergabe ist abgeschlossen. <Link href={`/buchungen/${booking.id}/uebergabe`} className="underline">Übergabeprotokoll anzeigen</Link></p>}
          {signedAmendments.length > 0 && (
            <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">
              Dieser Vertrag wurde durch {signedAmendments.length === 1 ? "einen Nachtrag" : `${signedAmendments.length} Nachträge`} geändert: {signedAmendments.map((n, i) => <span key={n.id}>{i > 0 && ", "}<Link href={`/buchungen/${booking.id}/nachtrag/${n.id}`} className="underline font-mono tnum">{n.number}</Link>{n.signedAt ? ` (${fmtDate(n.signedAt)})` : ""}</span>)}. Unten steht der ursprüngliche Vertragstext; der aktuell vereinbarte Stand steht auf der <Link href={`/buchungen/${booking.id}#vertrag`} className="underline">Buchungsseite</Link>.
            </p>
          )}
          <ContractDocumentView doc={doc} />
        </Content>
      </>
    );
  }

  // Befehl 29 Phase E: geschlossener Unfallersatzfall – der Entwurf ist eingefroren und wird nur angezeigt (Aktionen serverseitig gesperrt)
  if (caseClosed) {
    return (
      <>
        <PageHeader title={`Mietvertrag ${contract.number}`} sub={`Buchung ${booking.number} · ${customerName(booking.customer)}`}>
          <Chip tone="amber">Entwurf</Chip>
          {caseLink}
          <Link href={`/buchungen/${booking.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content className="max-w-5xl">
          {closedNotice}
          <ContractDocumentView doc={doc} showSignatures={false} />
        </Content>
      </>
    );
  }

  const reached = Math.max(1, contract.wizardStep);
  const requested = typeof sp.schritt === "string" ? parseInt(sp.schritt, 10) : reached;
  const step = Math.min(7, Math.max(1, Number.isFinite(requested) ? requested : reached));
  const needCustomers = step === 2 || step === 5;
  const customers = needCustomers ? await db.customer.findMany({ where: { tenantId: tenant.id }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: 500 }) : [];
  const fromCustomer = needCustomers && typeof sp.vonKunde === "string" ? customers.find((c) => c.id === sp.vonKunde) : undefined;
  const prefill: DriverValues | null = fromCustomer
    ? {
        customerId: fromCustomer.id, firstName: fromCustomer.firstName, lastName: fromCustomer.lastName, birthDate: toDateInput(fromCustomer.birthDate),
        street: fromCustomer.street ?? "", zip: fromCustomer.zip ?? "", city: fromCustomer.city ?? "", country: fromCustomer.country,
        licenseNumber: fromCustomer.licenseNumber ?? "", licenseClass: fromCustomer.licenseClass ?? "", licenseIssuedAt: toDateInput(fromCustomer.licenseIssuedAt),
        licenseValidUntil: toDateInput(fromCustomer.licenseValidUntil), licenseCountry: fromCustomer.country, licenseIssuedBy: fromCustomer.licenseIssuedBy ?? "",
      }
    : null;

  const primary = contract.drivers.find((d) => d.role === "PRIMARY_DRIVER");
  const additional = contract.drivers.filter((d) => d.role === "ADDITIONAL_DRIVER");
  const driverValues = (d: NonNullable<typeof primary>): DriverValues => ({
    customerId: d.customerId ?? "", firstName: d.firstName, lastName: d.lastName, birthDate: toDateInput(d.birthDate), street: d.street, zip: d.zip, city: d.city, country: d.country,
    licenseNumber: d.licenseNumber, licenseClass: d.licenseClass, licenseIssuedAt: toDateInput(d.licenseIssuedAt), licenseValidUntil: toDateInput(d.licenseValidUntil), licenseCountry: d.licenseCountry, licenseIssuedBy: d.licenseIssuedBy ?? "",
  });
  const pickCustomerForm = (hint: string) =>
    customers.length > 0 && (
      <form method="get" className="flex flex-wrap items-end gap-2 rounded-lg bg-panel-2 p-3">
        <input type="hidden" name="schritt" value={step} />
        <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
          <label htmlFor="vonKunde" className="label-xs">{hint}</label>
          <select id="vonKunde" name="vonKunde" defaultValue={fromCustomer?.id ?? ""} className="input">
            <option value="">Bitte wählen…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.lastName}, {c.firstName}{c.number ? ` · ${c.number}` : ""}</option>)}
          </select>
        </div>
        <button className="btn">Daten übernehmen</button>
      </form>
    );

  const renterSig = signatures.find((s) => s.role === "RENTER");
  const employeeSig = signatures.find((s) => s.role === "EMPLOYEE");
  const blocking = hasErrors(issues);
  const v = booking.vehicle;

  // Befehl 29.6: Kartenlayout mit Stepper, Vertragsübersicht (zuletzt gespeicherter Stand aus doc) und Aktionsleiste.
  // Nur Darstellung – Felder, Aktionen und Prüfungen wie bisher.
  const tariffSnap = readTariffSnapshot(booking.tariffSnapshot);
  const abroadLockedText = !accident && booking.abroadAllowed != null ? abroadSummary(booking) : null;
  const href = (n: number) => `/buchungen/${booking.id}/vertrag?schritt=${n}`;
  const overview = buildOverviewData(doc, contract, { tariff: tariffLabel({ ratePlanId: booking.ratePlanId, snapshot: tariffSnap, accident }) });
  const figure = doc.price.openEnd ? `${doc.price.subtotal} je Miettag` : doc.price.total;
  const readiness = step >= 6 ? buildReadiness(issues, terms, !!renterSig, step) : null;
  // dieselbe Übersicht zweimal: Seitenleiste (Zwischenüberschriften h3) und aufklappbar (h4 unter einer unsichtbaren h3)
  const summaryBody = (level: 3 | 4) => (readiness ? <ReadinessBody rows={readiness} price={overview.price} outside={overview.outside} level={level} /> : <OverviewBody data={overview} stand={step === 3 || step === 5 ? "short" : "full"} level={level} />);
  const brief = step === 7 ? (
    <Step7Brief renter={customerName(booking.customer)} plate={v.plate} startAt={fmtDateTime(contract.startAt)} endAt={contract.endAt ? fmtDateTime(contract.endAt) : null} total={doc.price.total} perDay={doc.price.subtotal} oneOff={doc.price.extras.length > 0} deposit={doc.price.deposit} href={href(6)} />
  ) : null;
  // Kartenkörper mit Container-Abfrage (Innenraster) bzw. Viewport-Raster (Karten mit Field „full“, Kunden- und Fahrerfelder)
  const CQ_BODY = "@container/karte px-4 pb-4 pt-3.5 md:px-[18px]";
  const CQ_GRID2 = "grid grid-cols-1 gap-x-4 gap-y-3.5 @min-[448px]/karte:grid-cols-2";
  const VP_BODY = "grid grid-cols-1 gap-x-4 gap-y-3.5 px-4 pb-4 pt-3.5 md:grid-cols-2 md:px-[18px]";
  const hint = "text-[11px] text-ink-2";
  const stepTitle = WIZARD_STEPS[step - 1];

  return (
    <>
      <PageHeader title={`Mietvertrag ${contract.number}`} sub={`Buchung ${booking.number} · ${customerName(booking.customer)}`}>
        {accident && <Chip tone="info">Unfallersatz{accidentCase ? ` ${accidentCase.caseNumber}` : ""}</Chip>}
        <Chip tone="amber">Entwurf</Chip>
        {caseLink}
        <Link href={`/buchungen/${booking.id}`} className="btn">Zur Buchung</Link>
      </PageHeader>
      <Content className="w-full max-w-[1680px] mx-auto">
        <WizardShell>
          {closedNotice}
          <ContractStepper bookingId={booking.id} current={step} reached={reached} />
          <MobileProgress bookingId={booking.id} current={step} reached={reached} heading={<h2 className="text-lg font-semibold leading-snug sm:sr-only"><span className="max-sm:sr-only">Schritt {step} von 7: </span>{stepTitle}</h2>} />
          <SummaryDisclosure title={readiness ? "Bereit zur Unterschrift?" : "Vertragsübersicht"} figure={figure}>{summaryBody(4)}</SummaryDisclosure>

          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex min-w-0 flex-col gap-4">
              {step === 1 && (() => {
                const c = booking.customer;
                const values = customerToFormValues(c);
                const ci = fieldIssues(issues, "CUSTOMER");
                const renterDrives = contract.driverMode === "RENTER";
                const marks: Record<string, "save" | "close" | "either"> = {
                  firstName: "save", lastName: "save", companyName: "save",
                  phone: "either", email: "either", street: "close", zip: "close", city: "close", country: "close", birthDate: "close", idNumber: "close",
                  ...(renterDrives ? { licenseNumber: "close", licenseClass: "close", licenseIssuedAt: "close", licenseValidUntil: "close" } : {}),
                };
                return (
                  <>
                    <WizardCard id="kunde-kopf" label="Mieter" bodyClassName="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5 md:px-[18px]">
                      <Avatar name={customerName(c)} />
                      <div className="min-w-0 flex-1 basis-56">
                        <div className="text-base font-semibold [overflow-wrap:anywhere]">{customerName(c)}</div>
                        {c.type === "COMPANY" && <div className="text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">Ansprechpartner {c.firstName} {c.lastName}{c.city ? ` · ${c.city}` : ""}</div>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip>{c.number ?? "ohne Kundennummer"}</Chip>
                        {c.blocked ? <Chip tone="bad">Gesperrt</Chip> : <Chip tone="good">Nicht gesperrt</Chip>}
                        {c.discountPercent > 0 && !accident && <Chip tone="info">{c.discountPercent} % Rabatt</Chip>}
                        {accident && <Chip tone="info">Unfallersatz: ohne Kundenrabatt</Chip>}
                      </div>
                      <Link href={`/kunden/${c.id}`} target="_blank" rel="noopener" className="rounded text-[13px] font-medium text-brand underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info">Kundenakte öffnen (neuer Tab)</Link>
                    </WizardCard>
                    {c.blocked && (
                      <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-3 font-medium">
                        Dieser Kunde ist gesperrt{c.blockReason ? `: ${c.blockReason}` : ""}. Der Vertrag lässt sich vorbereiten, aber nicht abschließen. Die Sperre hebt der Inhaber in der Kundenverwaltung auf.
                      </p>
                    )}
                    <IssueList issues={issues} areas={["CUSTOMER"]} okText="Die Daten des Mieters sind vollständig." />
                    <StepForm variant="page" action={saveCustomerStepAction.bind(null, booking.id)} step={1} info="Prüfung und Übersicht zeigen den zuletzt gespeicherten Stand.">
                      <CardsGrid>
                        {CONTRACT_CUSTOMER_CARDS.map((card) => {
                          const only = [card.section] as const;
                          return (
                            <WizardCard key={card.id} id={card.id} icon={card.icon} title={card.title} bodyClassName={VP_BODY}>
                              <CustomerFields values={values} compact sections={only} headings={false} marks={marks} issues={ci.fields} />
                            </WizardCard>
                          );
                        })}
                      </CardsGrid>
                      <Note>Änderungen werden direkt beim Kunden gespeichert. Sperre, Rabatt und Notizen pflegen Sie in der Kundenakte. <span aria-hidden="true">Zeichen: <span className="text-bad">*</span> Pflichtfeld, ° für den Abschluss nötig (Telefon oder E-Mail: eine Angabe genügt).</span></Note>
                    </StepForm>
                  </>
                );
              })()}

              {step === 2 && (() => {
                const c = booking.customer;
                const savedOther = contract.driverMode === "OTHER";
                const di = fieldIssues(issues, "DRIVER", { enabled: savedOther && !!primary && !prefill });
                const check = driverCheckState({ savedMode: contract.driverMode, prefill: !!prefill, issues });
                const driverVals = prefill ?? (savedOther && primary ? driverValues(primary) : emptyDriver);
                const required = { firstName: "save", lastName: "save", birthDate: "save", street: "save", zip: "save", city: "save", licenseNumber: "save", licenseClass: "save", licenseIssuedAt: "save", licenseValidUntil: "save" } as const;
                const chip = check === "valid" ? <Chip tone="good"><ContractIcon name="check" size={13} />gültig am Mietbeginn</Chip> : check === "check" ? <Chip tone="bad"><ContractIcon name="alert" size={13} />Angaben prüfen (siehe oben)</Chip> : <Chip>wird nach dem Speichern geprüft</Chip>;
                return (
                  <>
                    <IssueList issues={issues} areas={["DRIVER"]} okText="Die Fahrerdaten sind vollständig und der Führerschein ist am Mietbeginn gültig." />
                    {pickCustomerForm("Abweichenden Fahrer aus bestehendem Kunden übernehmen")}
                    <StepForm variant="page" action={saveDriverStepAction.bind(null, booking.id)} step={2}>
                      <DriverModeSection
                        initial={prefill ? "OTHER" : (contract.driverMode as "RENTER" | "OTHER")}
                        renterSummary={
                          <CardsGrid>
                            <WizardCard id="fahrer-mieter" icon="user" title="Hauptfahrer" right={chip}>
                              <div className="flex items-start gap-3">
                                <Avatar name={`${c.firstName} ${c.lastName}`} />
                                <div className="min-w-0 text-sm">
                                  <div className="font-semibold [overflow-wrap:anywhere]">{c.firstName} {c.lastName}</div>
                                  <div className={c.birthDate ? "text-ink-2" : "font-medium text-bad"}>{c.birthDate ? `geb. ${fmtDate(c.birthDate)}` : "Geburtsdatum fehlt"}</div>
                                  <div className="text-ink-2 [overflow-wrap:anywhere]">{[c.street, [c.zip, c.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "Anschrift fehlt"}</div>
                                </div>
                              </div>
                            </WizardCard>
                            <WizardCard id="fahrer-mieter-fs" icon="id" title="Führerschein">
                              <KeyValueList
                                rows={[
                                  { label: "Nummer", value: c.licenseNumber ?? "fehlt", mono: !!c.licenseNumber, bad: !c.licenseNumber },
                                  { label: "Klasse", value: c.licenseClass ?? "?" },
                                  { label: "Ausgestellt", value: c.licenseIssuedAt ? `${fmtDate(c.licenseIssuedAt)}${c.licenseIssuedBy ? ` · ${c.licenseIssuedBy}` : ""}` : "fehlt", bad: !c.licenseIssuedAt },
                                  { label: "Gültig bis", value: c.licenseValidUntil ? fmtDate(c.licenseValidUntil) : "fehlt", bad: !c.licenseValidUntil },
                                ]}
                              />
                              <p className="text-xs text-ink-2">Fehlende Angaben werden in Schritt 1 beim Kunden ergänzt. Beim Abschluss wird eine eigene Kopie dieser Daten am Vertrag gespeichert.</p>
                            </WizardCard>
                            <WizardCard id="fahrer-pruefung" icon="shield" title="Fahrerprüfung">
                              <p className="text-sm text-ink-2">Ausweis und Führerschein werden bei der Übergabe am Fahrzeug geprüft. Hier werden keine Dokumente angezeigt.</p>
                            </WizardCard>
                          </CardsGrid>
                        }
                      >
                        <CardsGrid>
                          <WizardCard id="fahrer-anders" icon="user" title="Persönliche Daten" bodyClassName={VP_BODY}>
                            <CardIssueNote issues={di.cards["fahrer-anders"]} />
                            <DriverFields values={driverVals} prefix="d_" section="person" marks={required} issues={di.fields} />
                          </WizardCard>
                          <WizardCard id="fahrer-anders-fs" icon="id" title="Führerschein" bodyClassName={VP_BODY}>
                            <DriverFields values={driverVals} prefix="d_" section="license" marks={required} issues={di.fields} />
                          </WizardCard>
                        </CardsGrid>
                        <p aria-hidden="true" className="text-[12px] text-ink-2">Zeichen: <span className="text-bad">*</span> Pflichtfeld</p>
                      </DriverModeSection>
                    </StepForm>
                  </>
                );
              })()}

              {step === 3 && (
                <>
                  <IssueList issues={issues} areas={["VEHICLE", "PERIOD"]} okText="Das Fahrzeug ist vermietbar und im Zeitraum frei." />
                  <CardsGrid>
                    <WizardCard id="k3-fahrzeug" icon="car" title="Fahrzeug" right={<Chip tone={v.status === "AVAILABLE" ? "good" : "bad"}>{VEHICLE_STATUS[v.status as VehicleStatus] ?? v.status}</Chip>}>
                      <KeyValueList
                        rows={[
                          { label: "Kennzeichen", value: <Plate>{v.plate}</Plate> },
                          { label: "Fahrzeug", value: `${v.make} ${v.model}` },
                          { label: "Fahrzeuggruppe", value: v.group?.name ?? "–" },
                          { label: "Antrieb", value: FUELS[v.fuel as Fuel] ?? v.fuel },
                          { label: "Kilometerstand", value: `${fmtInt(v.mileage)} km`, mono: true },
                          { label: "Führerscheinklasse", value: requiredLicenseClassFor(v, v.group) ?? "nicht festgelegt" },
                        ]}
                      />
                      <p className="text-[12px] text-ink-2">Ein anderes Fahrzeug wählen Sie in der Buchung, der Vertrag übernimmt es automatisch.</p>
                    </WizardCard>
                    {accident ? (
                      <WizardCard id="k3-zeitraum" icon="calendar" title="Mietzeitraum und Tarif">
                        <KeyValueList
                          rows={[
                            { label: "Mietbeginn", value: fmtDateTime(contract.startAt), mono: true },
                            { label: "Mietende", value: "offen – bis zur Rückgabe" },
                            { label: "Geplantes Ende", value: booking.endAt ? <><span className="font-mono tnum">{fmtDateTime(booking.endAt)}</span> <span className="font-normal text-ink-2">(nur Disposition, nicht Vertragsinhalt)</span></> : "offen" },
                            ...doc.price.lines.map((l) => ({ label: l.text, value: l.amount, mono: true })),
                            { label: doc.price.subtotalLabel, value: doc.price.subtotal, mono: true },
                            ...doc.price.extras.map((e) => ({ label: e.text, value: e.amount, mono: true })),
                            { label: "Kaution", value: doc.price.deposit, mono: true },
                          ]}
                        />
                      </WizardCard>
                    ) : (
                      <WizardCard id="k3-zeitraum" icon="calendar" title="Mietzeitraum">
                        <KeyValueList
                          rows={[
                            { label: "Mietbeginn", value: fmtDateTime(contract.startAt), mono: true },
                            { label: "Geplante Rückgabe", value: fmtDateTime(contract.endAt), mono: true },
                            { label: "Mietdauer", value: `${doc.price.days} ${doc.price.days === 1 ? "Tag" : "Tage"}` },
                          ]}
                        />
                        <p className="text-[12px] text-ink-2">Zeitraum ändern Sie im nächsten Schritt (Konditionen).</p>
                      </WizardCard>
                    )}
                    <WizardCard id="k3-orte" icon="pin" title="Abholung & Rückgabe">
                      <KeyValueList rows={[{ label: "Abholort", value: contract.pickupLocation ?? "–" }, { label: "Rückgabeort", value: contract.returnLocation ?? "wie Abholort" }]} />
                    </WizardCard>
                    {!accident && (tariffLocked ? (
                      tariffSnap ? (
                        <WizardCard id="k3-tarif" icon="tag" title={`Miettarif ${tariffSnap.ratePlanName}`}>
                          <p className="text-[12.5px] text-ink-2">Revision {tariffSnap.revision} (eingefroren bei der Buchung)</p>
                          <KeyValueList rows={tariffSnap.tiers.map((t) => ({ label: t.label || tierLabel(t.days), value: fmtCents(t.cents), mono: true }))} />
                        </WizardCard>
                      ) : (
                        <WizardCard id="k3-tarif" icon="tag" title="Miettarif laut Buchung">
                          <p className="text-sm text-ink-2">Stufen nicht verfügbar</p>
                        </WizardCard>
                      )
                    ) : (
                      <WizardCard id="k3-tarif" icon="tag" title="Preisstufen (ohne Tarif)">
                        <KeyValueList
                          rows={[
                            { label: "Tag", value: fmtEur(booking.dailyRate), mono: true },
                            { label: "Woche (5 Tage)", value: booking.workWeekRate ? fmtEur(booking.workWeekRate) : "–", mono: true },
                            { label: "Kalenderwoche (7 Tage)", value: booking.weeklyRate ? fmtEur(booking.weeklyRate) : "–", mono: true },
                            { label: "Monat", value: booking.monthlyRate ? fmtEur(booking.monthlyRate) : "–", mono: true },
                          ]}
                        />
                      </WizardCard>
                    ))}
                  </CardsGrid>
                  {accident && <Note>Mietbeginn, geplantes Mietende und Tarif stehen in der Fallakte. Das geplante Ende ist nur ein Dispositionswert – der Vertrag läuft bis zur Rückgabe. Kaution und Kilometer legen Sie im nächsten Schritt fest.</Note>}
                  <StepForm variant="page" action={navigateStepAction.bind(null, booking.id, 3)} step={3} nextLabel="Weiter"><span className="sr-only">Keine Eingaben in diesem Schritt</span></StepForm>
                </>
              )}

              {step === 4 && (() => {
                const ki = fieldIssues(issues, "CONDITIONS");
                const agreedHint = booking.abroadAllowed && (booking.abroadSurchargeCents ?? 0) > 0 ? "Leer lassen, dann gilt die Berechnung oben. Ohne Auslandsfahrt-Aufpreis – der wird zusätzlich berechnet." : "Leer lassen, dann gilt die Berechnung oben";
                const deductibleBase = tariffSnap?.deductible ? `${tariffSnap.deductible.source === "TARIFF" ? `Miettarif${tariffName ? ` ${tariffName}` : ""}` : "Geschäftsregel"}: ${fmtCents(tariffSnap.deductible.cents)}` : null;
                return (
                  <>
                    <IssueList issues={issues} areas={["CONDITIONS", "PRICE"]} />
                    {sp.standard === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Aktuelle Standardwerte übernommen. Individuell angepasste Werte blieben erhalten.</p>}
                    {rules.newerDefaults && (
                      <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm flex flex-wrap items-center gap-3">
                        <span>Für diesen Vertragsentwurf sind neuere Standardwerte verfügbar. Sie werden nicht automatisch übernommen.</span>
                        <ActionButton action={adoptDefaultsAction.bind(null, booking.id)} label="Aktuelle Standardwerte übernehmen" className="btn !py-1.5" />
                      </div>
                    )}
                    {termsHint(4)}
                    <StepForm variant="page" action={saveConditionsStepAction.bind(null, booking.id)} step={4} info="Preis und Übersicht aktualisieren sich nach dem Speichern.">
                      <input type="hidden" name="rulesPresent" value="1" />
                      <CardsGrid>
                        {/* A Mietzeitraum */}
                        <WizardCard id="k4-a" icon="calendar" title="Mietzeitraum" bodyClassName={CQ_BODY}>
                          <div className={CQ_GRID2}>
                            {accident ? (
                              <>
                                {/* Unfallersatz: Mietbeginn steht in der Fallakte; das Mietende ist offen – kein Datumsfeld, kein Ersatzdatum */}
                                <div className="flex flex-col gap-1"><span className="label-xs">Mietbeginn</span><span className="input bg-panel-2 font-mono tnum">{fmtDateTime(contract.startAt)}</span><span className={hint}>laut Fallakte</span></div>
                                <div className="flex flex-col gap-1"><span className="label-xs">Mietende</span><span className="input bg-panel-2">offen – bis zur Rückgabe</span><span className={hint}>{booking.endAt ? `geplant ${fmtDateTime(booking.endAt)} – nur Disposition, ändern in der Fallakte` : "geplantes Ende ändern Sie in der Fallakte"}</span></div>
                              </>
                            ) : (
                              <>
                                <Field label="Mietbeginn" htmlFor="startAt" mark="save"><input id="startAt" name="startAt" type="datetime-local" defaultValue={toDateTimeInput(contract.startAt)} required className="input tnum" /></Field>
                                <Field label="Geplante Rückgabe" htmlFor="endAt" mark="save"><input id="endAt" name="endAt" type="datetime-local" defaultValue={toDateTimeInput(contract.endAt)} required className="input tnum" /></Field>
                                <p className={`col-span-full ${hint}`}>{doc.price.days} {doc.price.days === 1 ? "Tag" : "Tage"} · Änderung prüft die Verfügbarkeit des Fahrzeugs</p>
                              </>
                            )}
                          </div>
                        </WizardCard>

                        {/* B Abholung & Rückgabe */}
                        <WizardCard id="k4-b" icon="pin" title="Abholung & Rückgabe" bodyClassName={CQ_BODY}>
                          <div className={CQ_GRID2}>
                            <Field label="Abholort" htmlFor="pickupLocation" issue={ki.fields.pickupLocation}><input id="pickupLocation" name="pickupLocation" defaultValue={contract.pickupLocation ?? [tenant.street, tenant.city].filter(Boolean).join(", ")} aria-describedby={ki.fields.pickupLocation?.describedBy || undefined} className="input" /></Field>
                            <Field label="Rückgabeort" htmlFor="returnLocation" hint="Leer bedeutet: wie Abholort"><input id="returnLocation" name="returnLocation" defaultValue={contract.returnLocation ?? ""} className="input" /></Field>
                          </div>
                        </WizardCard>

                        {/* C Preis & Tarif – Reihenfolge: gesperrte Box, Berechnung, Felder */}
                        <WizardCard id="k4-c" icon="tag" title="Preis & Tarif" right={accident ? <Chip tone="info">Fallakte</Chip> : tariffLocked ? <Chip>Tarif</Chip> : undefined}>
                          <CardIssueNote issues={ki.cards["k4-c"]} />
                          {!accident && tariffLocked && (
                            <LockedBox>
                              <span className="font-semibold">{tariffSnap ? <>Miettarif {tariffSnap.ratePlanName} · Revision {tariffSnap.revision}</> : "Miettarif laut Buchung"}</span>
                              <SourceHint locked>laut Buchung – Tarif und Preis ändern Sie in der Buchung (mit Grund)</SourceHint>
                              <span><b>Mietpreis:</b> {booking.agreedPriceCents != null ? `individuell vereinbart ${(booking.agreedPriceCents / 100).toFixed(2).replace(".", ",")} €` : "Tarifpreis"} laut Buchung. Ein abweichender Preis wird in der Buchung mit Grund festgelegt.</span>
                              <input type="hidden" name="agreedTotal" value={booking.agreedPriceCents != null ? (booking.agreedPriceCents / 100).toFixed(2).replace(".", ",") : ""} />
                              <input type="hidden" name="agreedTotalNote" value={booking.priceOverrideReason ?? ""} />
                              {booking.priceOverrideReason && <span className="text-[12.5px] text-ink-2">Abweichung in der Buchung: „{booking.priceOverrideReason}“</span>}
                            </LockedBox>
                          )}
                          {tariffLocked && tariffSnap && (
                            <details className="group/stufen rounded-lg border border-line-soft px-3 py-2">
                              <summary className="cursor-pointer list-none text-[13px] font-medium text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info [&::-webkit-details-marker]:hidden">Preisstufen ansehen</summary>
                              <div className="pt-2"><KeyValueList rows={tariffSnap.tiers.map((t) => ({ label: t.label || tierLabel(t.days), value: fmtCents(t.cents), mono: true }))} /></div>
                            </details>
                          )}
                          <div className="flex flex-col gap-1">
                            <h4 className="text-[13px] font-semibold">So entsteht der Mietpreis</h4>
                            <PriceBreakdown price={doc.price} variant="conditions" accident={accident} />
                          </div>
                          {!accident && !tariffLocked && <Field label="Abweichend vereinbarter Gesamtmietpreis € (optional)" htmlFor="agreedTotal" hint={agreedHint}><input id="agreedTotal" name="agreedTotal" inputMode="decimal" defaultValue={dec(contract.agreedTotal)} className="input tnum" /></Field>}
                          {!accident && !tariffLocked && <Field label="Begründung für den abweichenden Preis" htmlFor="agreedTotalNote"><input id="agreedTotalNote" name="agreedTotalNote" defaultValue={contract.agreedTotalNote ?? ""} className="input" placeholder="z. B. Sonderpreis Stammkunde" /></Field>}
                        </WizardCard>

                        {/* D Kaution & Selbstbeteiligung – die beiden Eingabefelder unverändert */}
                        <WizardCard id="k4-d" icon="shield" title="Kaution & Selbstbeteiligung" bodyClassName={CQ_BODY}>
                          <div className={CQ_GRID2}>
                            <CardIssueNote issues={ki.cards["k4-d"]} />
                            <Field label="Kaution €" htmlFor="deposit" mark="save"><input id="deposit" name="deposit" inputMode="decimal" defaultValue={dec(contract.deposit)} required readOnly={tariffLocked} className={`input tnum ${tariffLocked ? "bg-panel-2" : ""}`} />{tariffLocked && <span className={`block ${hint}`}>laut Buchung (Miettarif) – Änderung in der Buchung mit Grund</span>}<span className={hint}>{accident ? "laut Fallakte; 0 = keine Kaution" : tariffLocked ? <>Quelle: {tariffSource(!!booking.depositOverrideReason)}</> : <>Quelle: {sourceText(depositSource, { groupName: rules.resolved.groupName, vehiclePlate: rules.resolved.vehiclePlate })}</>}</span></Field>
                            <Field label="Selbstbeteiligung im Schadenfall €" htmlFor="deductible" mark="save"><input id="deductible" name="deductible" inputMode="decimal" defaultValue={dec(contract.deductible)} required readOnly={deductibleLocked} className={`input tnum ${deductibleLocked ? "bg-panel-2" : ""}`} />{deductibleLocked ? <><span className={`block ${hint}`}>laut Buchung – Änderung in der Buchung mit Grund</span><span className={hint}>Quelle: {deductibleSource}</span></> : badge("deductibleCents")}</Field>
                            {tariffLocked && booking.depositOverrideReason && <div className="col-span-full"><Note>Abweichung in der Buchung (Kaution): „{booking.depositOverrideReason}“{tariffSnap ? ` (Miettarif: ${fmtCents(tariffSnap.deposit.cents)})` : ""}</Note></div>}
                            {deductibleLocked && booking.deductibleOverrideReason && <div className="col-span-full"><Note>Abweichung in der Buchung (Selbstbeteiligung): „{booking.deductibleOverrideReason}“{deductibleBase ? ` (${deductibleBase})` : ""}</Note></div>}
                            <p className="col-span-full text-[12px] text-ink-2">Beides ist nicht Teil des Mietpreises und wird nicht addiert.</p>
                          </div>
                        </WizardCard>

                        {/* E Fahrzeug & Nutzung */}
                        <WizardCard id="k4-e" icon="gauge" title="Fahrzeug & Nutzung" className={SPAN_WIDE} bodyClassName={CQ_BODY}>
                          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 @min-[480px]/karte:grid-cols-2 @min-[768px]/karte:grid-cols-4">
                            <CardIssueNote issues={ki.cards["k4-e"]} />
                            <KmPolicyField value={snap?.values.kmPolicy ?? rules.resolved.values.kmPolicy} note={snap?.values.kmPolicyNote ?? ""} kmLocked={tariffLocked} source={ruleSources.kmPolicy} />
                            <Field label="Freikilometer pro Tag" htmlFor="kmIncludedPerDay" mark="save"><input id="kmIncludedPerDay" name="kmIncludedPerDay" inputMode="numeric" defaultValue={contract.kmIncludedPerDay} required readOnly={tariffLocked} className={`input tnum ${tariffLocked ? "bg-panel-2" : ""}`} />{tariffLocked && <span className={`block ${hint}`}>laut Buchung (Miettarif) – Änderung in der Buchung mit Grund</span>}<span className={hint}>Quelle: {tariffLocked ? tariffSource(!!booking.kmOverrideReason) : Number(booking.vehicle.kmIncludedPerDay) === contract.kmIncludedPerDay ? sourceText("VEHICLE", { vehiclePlate: rules.resolved.vehiclePlate }) : booking.kmIncludedPerDay === contract.kmIncludedPerDay ? "Buchung" : RULE_SOURCES.CONTRACT}</span></Field>
                            <Field label="Mehrkilometer € je km" htmlFor="extraKmRate" mark="save"><input id="extraKmRate" name="extraKmRate" inputMode="decimal" defaultValue={dec(contract.extraKmRate)} required readOnly={tariffLocked} className={`input tnum ${tariffLocked ? "bg-panel-2" : ""}`} />{tariffLocked && <span className={`block ${hint}`}>laut Buchung (Miettarif) – Änderung in der Buchung mit Grund</span>}<span className={hint}>Quelle: {tariffLocked ? tariffSource(!!booking.kmOverrideReason) : Number(booking.vehicle.extraKmRate) === Number(contract.extraKmRate) ? sourceText("VEHICLE", { vehiclePlate: rules.resolved.vehiclePlate }) : Number(booking.extraKmRate ?? NaN) === Number(contract.extraKmRate) ? "Buchung" : RULE_SOURCES.CONTRACT}</span></Field>
                            {tariffLocked && booking.kmOverrideReason && <div className="col-span-full"><Note>Abweichung in der Buchung (Kilometer): „{booking.kmOverrideReason}“</Note></div>}
                            <FuelRuleFields
                              driveClass={driveClassOf(v.fuel)} fuelPolicy={contract.fuelPolicy} fuelPolicyNote={contract.fuelPolicyNote ?? ""}
                              fuelMinimumEighths={snap?.values.fuelMinimumEighths != null ? String(snap.values.fuelMinimumEighths) : ""} batteryMinimumPercent={snap?.values.batteryMinimumPercent != null ? String(snap.values.batteryMinimumPercent) : ""}
                              fuelPricePerLiter={dec(contract.fuelPricePerLiter)} source={ruleSources.fuelRule} noteIssue={ki.fields.fuelPolicyNote}
                            />
                            <UsageRuleFields petsPolicy={snap?.values.petsPolicy ?? "BY_APPROVAL"} smokingAllowed={snap?.values.smokingAllowed ?? false} sources={ruleSources} />
                          </div>
                        </WizardCard>

                        {/* F Auslandsfahrten */}
                        <WizardCard id="k4-f" icon="globe" title="Auslandsfahrten">
                          <CardIssueNote issues={ki.cards["k4-f"]} />
                          <AbroadRuleFields
                            abroadAllowed={snap?.values.abroadAllowed ?? false} abroadCountries={snap?.values.abroadCountries ?? []} allowedCountries={rules.resolved.values.abroadCountries} abroadPossible={rules.resolved.values.abroadAllowed}
                            abroadLocked={abroadLockedText} source={ruleSources.abroadAllowed}
                          />
                        </WizardCard>

                        {/* G Weitere Konditionen */}
                        <WizardCard id="k4-g" icon="sliders" title="Weitere Konditionen" bodyClassName={CQ_BODY}>
                          <div className={CQ_GRID2}>
                          <DriverFeeFields
                            driverFeeNote={accident ? "Beim Unfallersatz gilt keine Zusatzfahrer-Gebühr aus den Geschäftsregeln. Kosten für Zusatzfahrer nur als Position im Tarif der Fallakte." : undefined}
                            allowed={snap?.values.additionalDriversAllowed ?? true} feeType={snap?.values.additionalDriverFeeType ?? "FREE"} fee={snap ? (snap.values.additionalDriverFeeCents / 100).toFixed(2).replace(".", ",") : ""} sources={ruleSources}
                          />
                          <div className="col-span-full"><Field label="Individuelle Vereinbarungen (Teil des Vertrags)" htmlFor="individualAgreements" hint="Wird dem Mieter vor der Unterschrift angezeigt und mit dem Vertrag eingefroren."><textarea id="individualAgreements" name="individualAgreements" defaultValue={contract.individualAgreements ?? ""} rows={3} maxLength={6000} className="input" placeholder="z. B. Kindersitz inklusive, Rückgabe am Sonntag nach Absprache" /></Field></div>
                          <div className="col-span-full"><Field label="Interne Notiz (erscheint nicht im Vertrag)" htmlFor="internalNote"><textarea id="internalNote" name="internalNote" defaultValue={contract.internalNote ?? ""} rows={2} className="input" /></Field></div>
                          </div>
                        </WizardCard>
                      </CardsGrid>
                      <p aria-hidden="true" className="text-[12px] text-ink-2">Zeichen: <span className="text-bad">*</span> Pflichtfeld</p>
                    </StepForm>
                  </>
                );
              })()}

              {step === 5 && (() => {
                // Befehl 20.8: Standard ist „kein Zusatzfahrer“ – das Formular erscheint erst auf Wunsch (?zusatzfahrer=1 oder Kundenübernahme).
                // Vorhandene Zusatzfahrer (ContractDriver) bleiben immer sichtbar und maßgeblich.
                const wantsAdd = sp.zusatzfahrer === "1" || !!fromCustomer;
                const addHref = `/buchungen/${booking.id}/vertrag?schritt=5&zusatzfahrer=1`;
                const required = { firstName: "save", lastName: "save", birthDate: "save", street: "save", zip: "save", city: "save", licenseNumber: "save", licenseClass: "save", licenseIssuedAt: "save", licenseValidUntil: "save" } as const;
                return (
                  <>
                    <IssueList issues={issues} areas={["ADDITIONAL_DRIVER"]} />
                    <CardsGrid>
                      {additional.length > 0 && (
                        <WizardCard id="k5-liste" icon="users" title="Zusatzfahrer" right={<Chip>{additional.length}</Chip>}>
                          <ul className="flex flex-col divide-y divide-line-soft">
                            {additional.map((d) => (
                              <li key={d.id} className="flex items-center gap-3 py-2.5 first:pt-0">
                                <Avatar name={`${d.firstName} ${d.lastName}`} />
                                <div className="min-w-0 flex-1">
                                  <div className="font-medium [overflow-wrap:anywhere]">{d.firstName} {d.lastName} <span className="font-normal text-ink-2">· {DRIVER_ROLES.ADDITIONAL_DRIVER}</span></div>
                                  <div className="text-xs text-ink-2">geb. {fmtDate(d.birthDate)} · Führerschein {d.licenseNumber}, Klasse {d.licenseClass}, gültig bis {d.licenseValidUntil ? fmtDate(d.licenseValidUntil) : "?"}</div>
                                </div>
                                <form action={removeDriverAction.bind(null, booking.id, d.id)}><button className="btn btn-danger !py-1" aria-label={`Zusatzfahrer ${d.firstName} ${d.lastName} entfernen`}>Entfernen</button></form>
                              </li>
                            ))}
                          </ul>
                          {!wantsAdd && <div><Link href={addHref} className="btn">+ Weiteren Zusatzfahrer hinzufügen</Link></div>}
                        </WizardCard>
                      )}
                      {additional.length === 0 && !wantsAdd && (
                        <WizardCard id="k5-frage" icon="users" title="Gibt es einen Zusatzfahrer?">
                          <p className="text-sm text-ink-2">Standard: Nur der Hauptfahrer darf das Fahrzeug führen. Ein Zusatzfahrer wird nur bei Bedarf mit seinen Führerscheindaten in den Vertrag aufgenommen.</p>
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <Link href={addHref} className="btn justify-center !py-2.5">+ Zusatzfahrer hinzufügen</Link>
                            <NavButton action={navigateStepAction.bind(null, booking.id, 5)} label="Nein, nur der Hauptfahrer" />
                          </div>
                        </WizardCard>
                      )}
                      {wantsAdd && (
                        <WizardCard id="k5-neu" icon="plus" className={SPAN_WIDE} title={additional.length > 0 ? "Weiteren Zusatzfahrer hinzufügen" : "Zusatzfahrer hinzufügen"} right={<Link href={`/buchungen/${booking.id}/vertrag?schritt=5`} className="rounded text-[13px] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info">Abbrechen</Link>}>
                          {pickCustomerForm("Daten aus bestehendem Kunden übernehmen (optional)")}
                          <InlineForm key={prefill?.customerId ?? "leer"} action={addDriverAction.bind(null, booking.id)} submitLabel="Zusatzfahrer hinzufügen">
                            <h4 className="text-[13px] font-semibold">Person</h4>
                            <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 md:grid-cols-2"><DriverFields values={prefill ?? emptyDriver} prefix="a_" section="person" marks={required} /></div>
                            <h4 className="text-[13px] font-semibold">Führerschein</h4>
                            <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 md:grid-cols-2"><DriverFields values={prefill ?? emptyDriver} prefix="a_" section="license" marks={required} /></div>
                            <p className="text-[12px] text-ink-2"><span aria-hidden="true" className="text-bad">*</span> Pflichtfeld</p>
                          </InlineForm>
                        </WizardCard>
                      )}
                    </CardsGrid>
                    <StepForm variant="page" action={navigateStepAction.bind(null, booking.id, 5)} step={5} nextLabel="Weiter zur Zusammenfassung"><span className="sr-only">Navigation</span></StepForm>
                  </>
                );
              })()}

              {step === 6 && (
                <>
                  {/* Befehl 20.7: nur Punkte, die hier behebbar sind – Mietbedingungen und Unterschrift folgen bestimmungsgemäß in Schritt 7 */}
                  <IssueList issues={issues} areas={["CUSTOMER", "DRIVER", "ADDITIONAL_DRIVER", "VEHICLE", "PERIOD", "PRICE", "CONDITIONS"]} okText="Alle Pflichtangaben sind vollständig. Der Vertrag kann unterschrieben werden." />
                  {issues.some((i) => i.area === "SIGNATURE") && <Note>Die Kenntnisnahme der Mietbedingungen und die Unterschrift folgen im nächsten Schritt.</Note>}
                  {sp.fassung === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Mietbedingungen-Fassung {contract.termsVersion} übernommen. Die Kenntnisnahme muss erneut bestätigt werden.</p>}
                  {termsHint(6)}
                  <p className="text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">Vermieter: {doc.landlord.name}{doc.landlord.address ? ` · ${doc.landlord.address}` : ""}{doc.landlord.contact ? ` · ${doc.landlord.contact}` : ""}</p>
                  <SummaryCards
                    doc={doc}
                    grouped={groupDocumentRows(doc)}
                    targets={editTargets({ bookingId: booking.id, tariffLocked, deductibleLocked, abroadLocked: !!abroadLockedText, accident, caseHref })}
                    accident={accident}
                    caseHref={caseHref}
                    tariffLocked={tariffLocked}
                  />
                  <StepForm variant="page" action={navigateStepAction.bind(null, booking.id, 6)} step={6} nextLabel="Weiter zur Unterschrift"><span className="sr-only">Navigation</span></StepForm>
                </>
              )}

              {step === 7 && (
                <>
                  <IssueList issues={issues} okText="Alle Prüfungen bestanden." />
                  <div className="xl:hidden">{brief}</div>
                  {doc.individualAgreements && <WizardCard id="k7-vereinbarungen" icon="file" title="Individuelle Vereinbarungen"><p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{doc.individualAgreements}</p></WizardCard>}
                  {sp.fassung === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Mietbedingungen-Fassung {contract.termsVersion} übernommen. Die Kenntnisnahme muss erneut bestätigt werden.</p>}
                  {termsHint(7)}
                  <WizardCard id="k7-agb" icon="file" title={doc.terms.title} right={terms.acknowledged ? <Chip tone="good">Kenntnisnahme bestätigt</Chip> : terms.selected ? <Chip tone="amber">Kenntnisnahme fehlt</Chip> : doc.terms.text ? <Chip tone="grey">Altbestand</Chip> : <Chip tone="grey">keine</Chip>}>
                    <div className="flex flex-col gap-3 text-sm">
                      {doc.terms.text ? (
                        <details className="rounded-md border border-line-soft p-3">
                          <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info">Mietbedingungen{doc.terms.version ? ` Version ${doc.terms.version}` : ""} anzeigen</summary>
                          <div className="mt-2 max-h-[28rem] overflow-y-auto pr-1"><ContractTermsText blocks={doc.terms.blocks} text={doc.terms.text} compact headingOffset={1} /></div>
                        </details>
                      ) : (
                        <p className="text-ink-2">{terms.featureActive ? "Diesem Vertrag ist keine Mietbedingungen-Fassung zugeordnet." : "Noch keine Mietbedingungen veröffentlicht (Einstellungen → Mietbedingungen). Der Vertrag enthält keinen Bedingungstext."}</p>
                      )}
                      {terms.selected && !terms.acknowledged && canEdit && <AcknowledgeForm action={acknowledgeTermsAction.bind(null, booking.id)} version={contract.termsVersion ?? ""} />}
                      {terms.acknowledged && <p className="text-xs text-ink-2">Zur Kenntnisnahme bereitgestellt am {fmtDateTime(terms.acknowledgedAt!)}{terms.acknowledgedByName ? ` (bestätigt von ${terms.acknowledgedByName})` : ""} – Version {contract.termsVersion}.</p>}
                    </div>
                  </WizardCard>
                  <Note icon="lock">Die Unterschrift gilt für genau diesen Vertragsstand (Kennung {hash.slice(0, 12)}) einschließlich Mietbedingungen{contract.termsVersion ? ` Version ${contract.termsVersion}` : ""}, Geschäftsregeln und individueller Vereinbarungen. Wird danach etwas am Vertrag geändert, wird sie verworfen und der Mieter unterschreibt erneut.</Note>

                  <CardsGrid max={2}>
                    <WizardCard id="k7-mieter" icon="pen" title="Unterschrift Mieter" right={renterSig ? <Chip tone="good">Erfasst</Chip> : <Chip tone="amber">Fehlt</Chip>}>
                      {renterSig ? (
                        <>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/signatures/${renterSig.id}`} alt="Unterschrift Mieter" className="h-32 w-full object-contain rounded-md border border-line bg-white" />
                          <div className="text-xs text-ink-2">{renterSig.signerName} · {fmtDateTime(renterSig.signedAt)}</div>
                          <form action={removeSignatureAction.bind(null, booking.id, "RENTER")}><button className="btn">Neu unterschreiben</button></form>
                        </>
                      ) : terms.selected && !terms.acknowledged ? (
                        <p className="text-sm text-ink-2">Die Unterschrift des Mieters ist erst nach der Kenntnisnahme der Mietbedingungen möglich (siehe oben).</p>
                      ) : (
                        <SignatureForm action={saveSignatureAction.bind(null, booking.id)} role="RENTER" defaultName={`${booking.customer.firstName} ${booking.customer.lastName}`} seenHash={hash} />
                      )}
                    </WizardCard>
                    <WizardCard id="k7-vermieter" icon="pen" title="Unterschrift Vermieter (optional)" right={employeeSig ? <Chip tone="good">Erfasst</Chip> : <Chip>Optional</Chip>}>
                      {employeeSig ? (
                        <>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/signatures/${employeeSig.id}`} alt="Unterschrift Vermieter" className="h-32 w-full object-contain rounded-md border border-line bg-white" />
                          <div className="text-xs text-ink-2">{employeeSig.signerName} · {fmtDateTime(employeeSig.signedAt)}</div>
                          <form action={removeSignatureAction.bind(null, booking.id, "EMPLOYEE")}><button className="btn">Neu unterschreiben</button></form>
                        </>
                      ) : (
                        <SignatureForm action={saveSignatureAction.bind(null, booking.id)} role="EMPLOYEE" defaultName={user.name} seenHash={hash} />
                      )}
                    </WizardCard>
                  </CardsGrid>

                  <FinalizeForm
                    variant="bar"
                    action={finalizeContractAction.bind(null, booking.id)}
                    disabled={blocking || !renterSig}
                    reason={blocking ? "Es gibt noch offene Punkte, siehe oben." : !renterSig ? "Es fehlt noch die Unterschrift des Mieters." : undefined}
                    left={<Link href={href(6)} className={BAR_BACK}><ContractIcon name="chevron-left" size={16} /><span className="max-sm:sr-only">Zurück</span></Link>}
                  />
                </>
              )}
            </div>
            <SummaryAside title={readiness ? "Bereit zur Unterschrift?" : "Vertragsübersicht"} icon={readiness ? "check" : "file"} extra={brief}>{summaryBody(3)}</SummaryAside>
          </div>
        </WizardShell>
      </Content>
    </>
  );
}

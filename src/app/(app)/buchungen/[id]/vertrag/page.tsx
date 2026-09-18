import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { getContractState } from "@/lib/contracts";
import { buildContractDocument } from "@/lib/contract-view";
import { customerToFormValues } from "@/lib/customer-form-values";
import { hasErrors } from "@/lib/contract-checks";
import { DRIVER_ROLES, FUELS, FUEL_POLICIES, VEHICLE_STATUS, type Fuel, type VehicleStatus } from "@/lib/constants";
import { customerName, fmtDate, fmtDateTime, fmtEur, fmtInt, toDateInput, toDateTimeInput } from "@/lib/format";
import { Card, Chip, Content, Field, PageHeader, Plate } from "@/components/ui";
import { CustomerFields } from "../../../kunden/customer-fields";
import {
  addDriverAction,
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
import { ContractDocumentView, DriverFields, IssueList, emptyDriver, type DriverValues } from "./contract-parts";
import { DriverModeSection, FinalizeForm, InlineForm, SignatureForm, StepForm, WizardProgress } from "./wizard-ui";
import { WIZARD_STEPS } from "./steps";

export const metadata = { title: "Mietvertrag" };

const dec = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? "" : v.toString().replace(".", ","));

export default async function ContractPage({ params, searchParams }: PageProps<"/buchungen/[id]/vertrag">) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const { id } = await params;
  const sp = await searchParams;

  const booking = await db.booking.findFirst({ where: { id, tenantId: tenant.id }, include: { customer: true, vehicle: { include: { group: true } }, contract: { select: { id: true } } } });
  if (!booking) notFound();

  // Noch kein Vertrag: klare Startaktion
  if (!booking.contract) {
    const start = startContractAction.bind(null, booking.id);
    return (
      <>
        <PageHeader title="Mietvertrag" sub={`Buchung ${booking.number}`}><Link href={`/buchungen/${booking.id}`} className="btn">Zur Buchung</Link></PageHeader>
        <Content>
          <Card className="p-5 max-w-2xl flex flex-col gap-3">
            <p>Für {customerName(booking.customer)} und <Plate>{booking.vehicle.plate}</Plate> gibt es noch keinen Mietvertrag.</p>
            {booking.status === "RESERVED" ? (
              <form action={start}><button className="btn btn-primary !py-2.5">Mietvertrag erstellen</button></form>
            ) : (
              <p className="text-sm text-ink-3">Ein Vertrag wird nur für reservierte Buchungen angelegt.</p>
            )}
          </Card>
        </Content>
      </>
    );
  }

  const state = await getContractState(tenant.id, booking.contract.id);
  const { contract, signatures, issues, hash } = state;
  const doc = buildContractDocument(contract, tenant, signatures);

  // Abgeschlossen oder storniert: nur noch Anzeige
  if (contract.status !== "DRAFT") {
    return (
      <>
        <PageHeader title={`Mietvertrag ${contract.number}`} sub={`Buchung ${booking.number}`}>
          {contract.status === "SIGNED" && booking.status === "RESERVED" && <Chip tone="good">Bereit zur Übergabe</Chip>}
          <Link href={`/buchungen/${booking.id}`} className="btn">Zur Buchung</Link>
        </PageHeader>
        <Content>
          {sp.abgeschlossen === "1" && <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">Der Mietvertrag ist abgeschlossen und versiegelt. Die Buchung ist bereit zur Übergabe.</p>}
          <ContractDocumentView doc={doc} />
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

  return (
    <>
      <PageHeader title={`Mietvertrag ${contract.number}`} sub={`Buchung ${booking.number} · ${customerName(booking.customer)}`}>
        <Chip tone="amber">Entwurf</Chip>
        <Link href={`/buchungen/${booking.id}`} className="btn">Zur Buchung</Link>
      </PageHeader>
      <Content className="max-w-5xl">
        <WizardProgress bookingId={booking.id} current={step} reached={reached} />
        <h2 className="text-lg font-semibold -mb-1">Schritt {step} von 7: {WIZARD_STEPS[step - 1]}</h2>

        {step === 1 && (
          <>
            <Card className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="font-semibold text-base">{customerName(booking.customer)}</span>
              <Chip>{booking.customer.number ?? "ohne Kundennummer"}</Chip>
              {booking.customer.blocked ? <Chip tone="bad">Gesperrt</Chip> : <Chip tone="good">Nicht gesperrt</Chip>}
              {booking.customer.discountPercent > 0 && <Chip tone="info">{booking.customer.discountPercent} % Rabatt</Chip>}
            </Card>
            {booking.customer.blocked && (
              <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-3 font-medium">
                Dieser Kunde ist gesperrt{booking.customer.blockReason ? `: ${booking.customer.blockReason}` : ""}. Der Vertrag lässt sich vorbereiten, aber nicht abschließen. Die Sperre hebt der Inhaber in der Kundenverwaltung auf.
              </p>
            )}
            <IssueList issues={issues} areas={["CUSTOMER"]} okText="Die Daten des Mieters sind vollständig." />
            <Card className="p-4 md:p-5">
              <StepForm action={saveCustomerStepAction.bind(null, booking.id)} step={1}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
                  <CustomerFields values={customerToFormValues(booking.customer)} compact />
                </div>
              </StepForm>
            </Card>
          </>
        )}

        {step === 2 && (
          <>
            <IssueList issues={issues} areas={["DRIVER"]} okText="Die Fahrerdaten sind vollständig und der Führerschein ist am Mietbeginn gültig." />
            {pickCustomerForm("Abweichenden Fahrer aus bestehendem Kunden übernehmen")}
            <Card className="p-4 md:p-5">
              <StepForm action={saveDriverStepAction.bind(null, booking.id)} step={2}>
                <DriverModeSection
                  initial={prefill ? "OTHER" : (contract.driverMode as "RENTER" | "OTHER")}
                  renterSummary={
                    <dl className="grid grid-cols-[minmax(130px,35%)_1fr] gap-x-3 gap-y-1.5 text-sm rounded-lg bg-panel-2 p-3.5">
                      <dt className="text-ink-3">Fahrer</dt><dd className="font-medium">{booking.customer.firstName} {booking.customer.lastName}</dd>
                      <dt className="text-ink-3">Führerschein</dt><dd className="font-medium">{booking.customer.licenseNumber ? `${booking.customer.licenseNumber} · Klasse ${booking.customer.licenseClass ?? "?"}` : "fehlt"}</dd>
                      <dt className="text-ink-3">Gültig bis</dt><dd className="font-medium">{booking.customer.licenseValidUntil ? fmtDate(booking.customer.licenseValidUntil) : "fehlt"}</dd>
                      <dt className="text-ink-3 col-span-2 text-xs pt-1">Fehlende Angaben werden in Schritt 1 beim Kunden ergänzt. Beim Abschluss wird eine eigene Kopie dieser Daten am Vertrag gespeichert.</dt>
                    </dl>
                  }
                >
                  <DriverFields values={prefill ?? (contract.driverMode === "OTHER" && primary ? driverValues(primary) : emptyDriver)} prefix="d_" />
                </DriverModeSection>
              </StepForm>
            </Card>
          </>
        )}

        {step === 3 && (
          <>
            <IssueList issues={issues} areas={["VEHICLE", "PERIOD"]} okText="Das Fahrzeug ist vermietbar und im Zeitraum frei." />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <Card title="Fahrzeug" right={<Chip tone={v.status === "AVAILABLE" ? "good" : "bad"}>{VEHICLE_STATUS[v.status as VehicleStatus] ?? v.status}</Chip>}>
                <dl className="px-4 py-3 grid grid-cols-[minmax(120px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Kennzeichen</dt><dd><Plate>{v.plate}</Plate></dd>
                  <dt className="text-ink-3">Fahrzeug</dt><dd className="font-medium">{v.make} {v.model}</dd>
                  <dt className="text-ink-3">Fahrzeuggruppe</dt><dd className="font-medium">{v.group?.name ?? "–"}</dd>
                  <dt className="text-ink-3">Antrieb</dt><dd className="font-medium">{FUELS[v.fuel as Fuel] ?? v.fuel}</dd>
                  <dt className="text-ink-3">Kilometerstand</dt><dd className="font-medium font-mono tnum">{fmtInt(v.mileage)} km</dd>
                </dl>
              </Card>
              <Card title="Mietzeitraum und Preise">
                <dl className="px-4 py-3 grid grid-cols-[minmax(120px,40%)_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Mietbeginn</dt><dd className="font-medium font-mono tnum">{fmtDateTime(contract.startAt)}</dd>
                  <dt className="text-ink-3">Geplante Rückgabe</dt><dd className="font-medium font-mono tnum">{fmtDateTime(contract.endAt)}</dd>
                  <dt className="text-ink-3">Mietdauer</dt><dd className="font-medium">{doc.price.days} {doc.price.days === 1 ? "Tag" : "Tage"}</dd>
                  <dt className="text-ink-3">Tag</dt><dd className="font-mono tnum">{fmtEur(booking.dailyRate)}</dd>
                  <dt className="text-ink-3">Woche (5 Tage)</dt><dd className="font-mono tnum">{booking.workWeekRate ? fmtEur(booking.workWeekRate) : "–"}</dd>
                  <dt className="text-ink-3">Kalenderwoche (7 Tage)</dt><dd className="font-mono tnum">{booking.weeklyRate ? fmtEur(booking.weeklyRate) : "–"}</dd>
                  <dt className="text-ink-3">Monat</dt><dd className="font-mono tnum">{booking.monthlyRate ? fmtEur(booking.monthlyRate) : "–"}</dd>
                  <dt className="text-ink-3">Kaution</dt><dd className="font-mono tnum">{fmtEur(contract.deposit)}</dd>
                </dl>
              </Card>
            </div>
            <p className="text-xs text-ink-3">Zeitraum und Kaution ändern Sie im nächsten Schritt. Ein anderes Fahrzeug wählen Sie in der Buchung, der Vertrag übernimmt es automatisch.</p>
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, booking.id, 3)} step={3} nextLabel="Weiter"><span className="sr-only">Keine Eingaben in diesem Schritt</span></StepForm></Card>
          </>
        )}

        {step === 4 && (
          <>
            <IssueList issues={issues} areas={["CONDITIONS", "PRICE"]} />
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4 items-start">
              <Card className="p-4 md:p-5">
                <StepForm action={saveConditionsStepAction.bind(null, booking.id)} step={4}>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
                    <Field label="Mietbeginn" htmlFor="startAt"><input id="startAt" name="startAt" type="datetime-local" defaultValue={toDateTimeInput(contract.startAt)} required className="input tnum" /></Field>
                    <Field label="Geplante Rückgabe" htmlFor="endAt"><input id="endAt" name="endAt" type="datetime-local" defaultValue={toDateTimeInput(contract.endAt)} required className="input tnum" /></Field>
                    <Field label="Abholort" htmlFor="pickupLocation"><input id="pickupLocation" name="pickupLocation" defaultValue={contract.pickupLocation ?? [tenant.street, tenant.city].filter(Boolean).join(", ")} className="input" /></Field>
                    <Field label="Rückgabeort" htmlFor="returnLocation" hint="Leer bedeutet: wie Abholort"><input id="returnLocation" name="returnLocation" defaultValue={contract.returnLocation ?? ""} className="input" /></Field>
                    <Field label="Kaution €" htmlFor="deposit"><input id="deposit" name="deposit" inputMode="decimal" defaultValue={dec(contract.deposit)} required className="input tnum" /></Field>
                    <Field label="Selbstbeteiligung €" htmlFor="deductible"><input id="deductible" name="deductible" inputMode="decimal" defaultValue={dec(contract.deductible)} required className="input tnum" /></Field>
                    <Field label="Freikilometer pro Tag" htmlFor="kmIncludedPerDay"><input id="kmIncludedPerDay" name="kmIncludedPerDay" inputMode="numeric" defaultValue={contract.kmIncludedPerDay} required className="input tnum" /></Field>
                    <Field label="Mehrkilometer € je km" htmlFor="extraKmRate"><input id="extraKmRate" name="extraKmRate" inputMode="decimal" defaultValue={dec(contract.extraKmRate)} required className="input tnum" /></Field>
                    <Field label="Tankregelung" htmlFor="fuelPolicy">
                      <select id="fuelPolicy" name="fuelPolicy" defaultValue={contract.fuelPolicy} className="input">
                        {Object.entries(FUEL_POLICIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </Field>
                    <Field label="Preis je fehlendem Liter € (optional)" htmlFor="fuelPricePerLiter"><input id="fuelPricePerLiter" name="fuelPricePerLiter" inputMode="decimal" defaultValue={dec(contract.fuelPricePerLiter)} className="input tnum" /></Field>
                    <Field label="Beschreibung bei individueller Tankregelung" htmlFor="fuelPolicyNote" full><input id="fuelPolicyNote" name="fuelPolicyNote" defaultValue={contract.fuelPolicyNote ?? ""} className="input" placeholder="Nur bei „Individuelle Regelung“ nötig" /></Field>
                    <Field label="Abweichend vereinbarter Gesamtmietpreis € (optional)" htmlFor="agreedTotal" hint="Leer lassen, dann gilt die Berechnung rechts"><input id="agreedTotal" name="agreedTotal" inputMode="decimal" defaultValue={dec(contract.agreedTotal)} className="input tnum" /></Field>
                    <Field label="Begründung für den abweichenden Preis" htmlFor="agreedTotalNote"><input id="agreedTotalNote" name="agreedTotalNote" defaultValue={contract.agreedTotalNote ?? ""} className="input" placeholder="z. B. Sonderpreis Stammkunde" /></Field>
                    <Field label="Interne Notiz (erscheint nicht im Vertrag)" htmlFor="internalNote" full><textarea id="internalNote" name="internalNote" defaultValue={contract.internalNote ?? ""} rows={2} className="input" /></Field>
                  </div>
                </StepForm>
              </Card>
              <Card title="So entsteht der Mietpreis">
                <div className="px-4 py-3 text-sm flex flex-col">
                  <div className="text-xs text-ink-3 pb-1">Mietdauer {doc.price.days} {doc.price.days === 1 ? "Tag" : "Tage"}</div>
                  {doc.price.lines.map((l, i) => <div key={i} className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{i > 0 ? "+ " : ""}{l.text}</span><span className="font-mono tnum">{l.amount}</span></div>)}
                  <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>Zwischensumme</span><span className="font-mono tnum">{doc.price.subtotal}</span></div>
                  {doc.price.discount && <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>{doc.price.discount.text}</span><span className="font-mono tnum">{doc.price.discount.amount}</span></div>}
                  {doc.price.agreed && <div className="flex justify-between gap-3 py-1.5 border-b border-line-soft"><span>Abweichend vereinbart</span><span className="font-mono tnum">{doc.price.agreed.amount}</span></div>}
                  <div className="flex justify-between gap-3 py-2 mt-1 border-t-2 border-ink font-semibold text-base"><span>Gesamtmietpreis</span><span className="font-mono tnum">{doc.price.total}</span></div>
                  <div className="flex justify-between gap-3 py-1.5 text-ink-2"><span>Kaution</span><span className="font-mono tnum">{doc.price.deposit}</span></div>
                  <p className="text-xs text-ink-3 mt-2">Die Berechnung aktualisiert sich nach „Speichern &amp; weiter“. Es gilt die günstigste Kombination der hinterlegten Preisstufen.</p>
                </div>
              </Card>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <IssueList issues={issues} areas={["ADDITIONAL_DRIVER"]} />
            <Card title="Zusatzfahrer" right={<Chip>{additional.length}</Chip>}>
              {additional.length === 0 ? (
                <p className="px-4 py-3 text-sm text-ink-3">Keine Zusatzfahrer. Das ist in Ordnung: dann darf nur der Fahrer aus Schritt 2 das Fahrzeug führen.</p>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {additional.map((d) => (
                    <li key={d.id} className="px-4 py-2.5 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{d.firstName} {d.lastName} <span className="text-ink-3 font-normal">· {DRIVER_ROLES.ADDITIONAL_DRIVER}</span></div>
                        <div className="text-xs text-ink-3">geb. {fmtDate(d.birthDate)} · Führerschein {d.licenseNumber}, Klasse {d.licenseClass}, gültig bis {d.licenseValidUntil ? fmtDate(d.licenseValidUntil) : "?"}</div>
                      </div>
                      <form action={removeDriverAction.bind(null, booking.id, d.id)}><button className="btn btn-danger !py-1">Entfernen</button></form>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Zusatzfahrer hinzufügen">
              <div className="p-4 md:p-5 flex flex-col gap-4">
                {pickCustomerForm("Daten aus bestehendem Kunden übernehmen (optional)")}
                <InlineForm key={prefill?.customerId ?? "leer"} action={addDriverAction.bind(null, booking.id)} submitLabel="Zusatzfahrer hinzufügen">
                  <DriverFields values={prefill ?? emptyDriver} prefix="a_" />
                </InlineForm>
              </div>
            </Card>
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, booking.id, 5)} step={5} nextLabel="Weiter zur Zusammenfassung"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 6 && (
          <>
            <IssueList issues={issues} okText="Alle Pflichtangaben sind vollständig. Der Vertrag kann unterschrieben werden." />
            <ContractDocumentView doc={doc} showSignatures={false} />
            <Card className="p-4 md:p-5"><StepForm action={navigateStepAction.bind(null, booking.id, 6)} step={6} nextLabel="Weiter zur Unterschrift"><span className="sr-only">Navigation</span></StepForm></Card>
          </>
        )}

        {step === 7 && (
          <>
            <IssueList issues={issues} okText="Alle Prüfungen bestanden." />
            <Card className="px-4 py-3 text-sm flex flex-wrap gap-x-6 gap-y-1">
              <span>Mieter: <b>{customerName(booking.customer)}</b></span>
              <span>Fahrzeug: <b>{v.plate}</b></span>
              <span>Zeitraum: <b>{fmtDateTime(contract.startAt)}</b> bis <b>{fmtDateTime(contract.endAt)}</b></span>
              <span>Gesamtmietpreis: <b>{doc.price.total}</b></span>
              <span>Kaution: <b>{doc.price.deposit}</b></span>
              <Link href={`/buchungen/${booking.id}/vertrag?schritt=6`} className="underline underline-offset-2">Vollständige Zusammenfassung ansehen</Link>
            </Card>
            <p className="text-xs text-ink-3">Die Unterschrift gilt für genau diesen Vertragsstand (Kennung {hash.slice(0, 12)}). Wird danach etwas am Vertrag geändert, wird sie verworfen und der Mieter unterschreibt erneut.</p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              <Card title="Unterschrift Mieter" right={renterSig ? <Chip tone="good">Erfasst</Chip> : <Chip tone="amber">Fehlt</Chip>}>
                <div className="p-4 flex flex-col gap-3">
                  {renterSig ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/signatures/${renterSig.id}`} alt="Unterschrift Mieter" className="h-32 w-full object-contain rounded-md border border-line bg-white" />
                      <div className="text-xs text-ink-2">{renterSig.signerName} · {fmtDateTime(renterSig.signedAt)}</div>
                      <form action={removeSignatureAction.bind(null, booking.id, "RENTER")}><button className="btn">Neu unterschreiben</button></form>
                    </>
                  ) : (
                    <SignatureForm action={saveSignatureAction.bind(null, booking.id)} role="RENTER" defaultName={`${booking.customer.firstName} ${booking.customer.lastName}`} seenHash={hash} />
                  )}
                </div>
              </Card>
              <Card title="Unterschrift Vermieter (optional)" right={employeeSig ? <Chip tone="good">Erfasst</Chip> : <Chip>Optional</Chip>}>
                <div className="p-4 flex flex-col gap-3">
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
                </div>
              </Card>
            </div>

            <Card className="p-4 md:p-5 flex flex-col gap-3">
              <FinalizeForm
                action={finalizeContractAction.bind(null, booking.id)}
                disabled={blocking || !renterSig}
                reason={blocking ? "Es gibt noch offene Punkte, siehe oben." : !renterSig ? "Es fehlt noch die Unterschrift des Mieters." : undefined}
              />
              <div><Link href={`/buchungen/${booking.id}/vertrag?schritt=6`} className="btn">Zurück</Link></div>
            </Card>
          </>
        )}
      </Content>
    </>
  );
}

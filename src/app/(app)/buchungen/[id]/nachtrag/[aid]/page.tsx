// Befehl 25: Seite eines Nachtrags. Entwurf: Änderungen, Fahrer (mit Fahrerprüfung), Zusammenfassung alt/neu, Prüfpunkte,
// Unterschrift, Wirksam machen, Verwerfen. Unterschrieben: versiegelter Inhalt, PDF, Versand. Alles aus lib/amendments.
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { AMENDMENT_AGREED_CHANNELS, AMENDMENT_HELP, AMENDMENT_STATUS, DRIVER_ROLES, KM_POLICIES, DRIVER_VERIFICATION_STATUS, type AmendmentStatus, type DriverRole, type DriverVerificationStatus } from "@/lib/constants";
import { getAmendmentState, type AmendmentSnapshot } from "@/lib/amendments";
import { DRIVER_BLOCKER_LABELS, driverVerificationOverview } from "@/lib/driver-verification";
import { fmtDate, fmtDateTime, toDateTimeInput } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { toDateInputValue } from "@/lib/time";
import { DriverFields, emptyDriver } from "../../vertrag/contract-parts";
import { FinalizeForm, InlineForm, SignatureForm } from "../../vertrag/wizard-ui";
import { DriverCheckForm, RepeatVerificationForm } from "../../uebergabe/driver-forms";
import { addAmendmentDriverAction, agreeAmendmentAction, createAmendmentDocumentAction, discardAmendmentAction, withdrawAgreedAmendmentAction, dropAmendmentDriverAction, removeAmendmentSignatureAction, repeatAmendmentDriverAction, saveAmendmentChangesAction, saveAmendmentSignatureAction, sendAmendmentAction, setDriverRemovalAction, signAmendmentAction, verifyAmendmentDriverAction } from "../actions";
import { ChangesForm, ConfirmForm, MessageForm } from "../amendment-forms";

export const metadata = { title: "Nachtrag zum Mietvertrag" };

const tone: Record<AmendmentStatus, "amber" | "good" | "grey"> = { DRAFT: "amber", AGREED: "amber", SIGNED: "good", DISCARDED: "grey" };
const statusTone: Record<DriverVerificationStatus, "good" | "amber" | "bad" | "info" | "grey"> = { NOT_STARTED: "grey", IN_PROGRESS: "amber", CONFIRMED: "good", BLOCKED: "bad" };
const dec = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? "" : Number(v).toLocaleString("de-DE", { minimumFractionDigits: 2 }));

export default async function AmendmentPage({ params, searchParams }: PageProps<"/buchungen/[id]/nachtrag/[aid]">) {
  const { tenant, user, supportSession } = await requireRole("DISPO", "YARD");
  const { id, aid } = await params;
  const sp = await searchParams;
  const row = await db.contractAmendment.findFirst({ where: { id: aid, tenantId: tenant.id, bookingId: id }, select: { id: true, status: true } });
  if (!row) notFound();
  const canEdit = user.role !== "YARD" && !supportSession;
  if (!canEdit && (row.status === "DRAFT" || row.status === "AGREED")) redirect(`/buchungen/${id}?hinweis=${encodeURIComponent("Nachträge erstellen und bearbeiten nur Inhaber und Disponenten.")}#vertrag`);

  const { amendment: a, effective: eff, changes, issues, hash, addedDrivers, removedDrivers } = await getAmendmentState(tenant.id, aid);
  const b = a.booking;
  const back = <Link href={`/buchungen/${id}#vertrag`} className="btn">Zur Buchung</Link>;
  const hint = typeof sp.hinweis === "string" ? <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{sp.hinweis}</p> : null;

  // Unterschrieben: versiegelter Inhalt aus dem Snapshot
  if (a.status === "SIGNED") {
    const snap = a.snapshot as unknown as AmendmentSnapshot;
    const [doc, mails] = await Promise.all([
      db.document.findFirst({ where: { tenantId: tenant.id, amendmentId: a.id, type: "CONTRACT_AMENDMENT" }, orderBy: { version: "desc" } }),
      db.emailLog.findMany({ where: { tenantId: tenant.id, amendmentId: a.id }, orderBy: { createdAt: "desc" }, take: 5 }),
    ]);
    const recipient = snap.customer.email?.trim() || null;
    return (
      <>
        <PageHeader title={`Nachtrag ${a.number}`} sub={<>{snap.sequenceNo}. Nachtrag zum Mietvertrag {a.contract.number} · Buchung {b.number} · <Chip tone="good">Unterschrieben und wirksam</Chip></>}>{back}</PageHeader>
        <Content>
          {hint}
          {sp.wirksam === "1" && <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Der Nachtrag ist unterschrieben und wirksam. Buchung, Rückgabe, Kaution und Abrechnung verwenden ab jetzt den neuen Stand. Es wurde nichts versendet.</p>}
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
            <div className="flex flex-col gap-4 min-w-0">
              <Card title="Geänderte Vereinbarungen" right={<span className="text-xs text-ink-3">wirksam seit {fmtDateTime(new Date(snap.signedAt))}</span>}>
                <ChangesTable changes={snap.changes} />
                <p className="px-4 pb-4 text-sm text-ink-2">Alle übrigen Vereinbarungen des Mietvertrags und früherer Nachträge bleiben unverändert bestehen.</p>
              </Card>
              <Card title="Stand nach diesem Nachtrag">
                <dl className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div><dt className="text-ink-3">Geplante Rückgabe</dt><dd className="font-mono tnum">{fmtDateTime(new Date(snap.after.endAt))}</dd></div>
                  <div><dt className="text-ink-3">Gesamtmietpreis</dt><dd className="font-mono tnum">{fmtCents(snap.after.totalCents)}</dd></div>
                  <div><dt className="text-ink-3">Kilometer</dt><dd className="font-mono tnum">{snap.after.kmPolicy === "UNLIMITED" ? KM_POLICIES.UNLIMITED : `${snap.after.kmIncludedPerDay.toLocaleString("de-DE")} km/Tag · ${snap.after.extraKmRate.toLocaleString("de-DE", { minimumFractionDigits: 2 })} €/km`}</dd></div>
                  <div><dt className="text-ink-3">Vereinbarte Kaution</dt><dd className="font-mono tnum">{fmtCents(snap.after.depositCents)}</dd></div>
                  <div><dt className="text-ink-3">Rückgabeort</dt><dd>{snap.after.returnLocation ?? "wie Abholort"}</dd></div>
                  <div><dt className="text-ink-3">Fahrer</dt><dd>{snap.after.drivers.map((d) => `${d.name}${d.role === "PRIMARY_DRIVER" ? " (Hauptfahrer)" : ""}`).join(", ")}</dd></div>
                </dl>
              </Card>
              <Card title="Unterschriften">
                <ul className="p-4 text-sm flex flex-col gap-1">
                  {snap.signatures.map((s) => <li key={s.role}>{s.role === "RENTER" ? "Mieter" : "Vermieter"}: <b>{s.signerName}</b> · {fmtDateTime(new Date(s.signedAt))}</li>)}
                  <li className="text-xs text-ink-3 pt-1">Wirksam gemacht von {snap.signedByName} · Prüfsumme <span className="font-mono break-all">{a.contentHash}</span></li>
                </ul>
              </Card>
            </div>
            <div className="flex flex-col gap-4">
              <Card title="Dokument">
                <div className="p-4 text-sm flex flex-col gap-2">
                  {doc ? (
                    <>
                      <div className="break-all">{doc.fileName}</div>
                      <div className="text-xs text-ink-3">erstellt am {fmtDateTime(doc.createdAt)} · Version {doc.version}</div>
                      <div className="flex flex-wrap gap-2"><a href={`/api/documents/${doc.id}`} target="_blank" rel="noopener noreferrer" className="btn">Anzeigen</a><a href={`/api/documents/${doc.id}?download=1`} className="btn">Herunterladen</a></div>
                    </>
                  ) : (
                    <>
                      <Chip tone="amber">PDF noch nicht erzeugt</Chip>
                      {canEdit && <form action={createAmendmentDocumentAction.bind(null, id, a.id)}><button className="btn btn-primary">Nachtrags-PDF erzeugen</button></form>}
                    </>
                  )}
                </div>
              </Card>
              <Card title="Versand an den Mieter">
                <div className="p-4 text-sm flex flex-col gap-3">
                  {mails.length === 0 && <p className="text-ink-3">Noch nicht versendet. Der Versand erfolgt nur nach bewusster Bestätigung.</p>}
                  {mails.map((m) => <div key={m.id} className="flex flex-wrap items-center gap-2"><Chip tone={m.status === "SENT" ? "good" : m.status === "FAILED" ? "bad" : "amber"}>{m.status === "SENT" ? "versendet" : m.status === "FAILED" ? "fehlgeschlagen" : "ausstehend"}</Chip><span className="text-xs text-ink-3">{fmtDateTime(m.sentAt ?? m.createdAt)} · {m.recipient}</span>{m.error && <span className="text-xs text-bad">{m.error}</span>}</div>)}
                  {canEdit && (recipient ? (
                    <MessageForm action={sendAmendmentAction.bind(null, id, a.id)} submitLabel={mails.some((m) => m.status === "SENT") ? "Nachtrag erneut senden" : "Nachtrag per E-Mail senden"} pendingLabel="Wird gesendet…" confirm={`Nachtrag ${a.number} als PDF an ${recipient} senden?`} className="btn btn-primary">
                      <input type="hidden" name="nonce" value={randomUUID()} />
                      <span className="text-xs text-ink-3">An: {recipient}</span>
                    </MessageForm>
                  ) : <p className="text-ink-3">Im Vertrag ist keine E-Mail-Adresse des Mieters hinterlegt.</p>)}
                </div>
              </Card>
              <Card title="Hinweis"><p className="p-4 text-sm text-ink-2">Ein wirksamer Nachtrag wird nicht geändert oder gelöscht. Soll etwas korrigiert werden, wird ein neuer Nachtrag erstellt.</p></Card>
            </div>
          </div>
        </Content>
      </>
    );
  }

  if (a.status === "DISCARDED") {
    return (
      <>
        <PageHeader title="Nachtrag (verworfen)" sub={<>Mietvertrag {a.contract.number} · Buchung {b.number} · <Chip>Verworfen</Chip></>}>{back}</PageHeader>
        <Content><Card className="p-5 text-sm">Dieser Entwurf wurde {a.discardedAt ? `am ${fmtDateTime(a.discardedAt)} ` : ""}verworfen und hat keine Wirkung. Der Mietvertrag {a.contract.number} und alle wirksamen Nachträge bleiben unverändert.</Card></Content>
      </>
    );
  }

  // Entwurf
  const overview = addedDrivers.length ? await driverVerificationOverview(tenant.id, { amendmentId: a.id }) : [];
  const errors = issues.filter((i) => i.severity === "error");
  const renterSig = a.signatures.find((s) => s.role === "RENTER" && s.contentHash === hash);
  const employeeSig = a.signatures.find((s) => s.role === "EMPLOYEE" && s.contentHash === hash);
  const readyToSign = errors.length === 0;
  const canFinalize = readyToSign && !!renterSig;
  const renterName = `${(a.contract.customerSnapshot as { firstName?: string; lastName?: string }).firstName ?? ""} ${(a.contract.customerSnapshot as { firstName?: string; lastName?: string }).lastName ?? ""}`.trim();
  const fullCheckFor = typeof sp.pruefung === "string" ? sp.pruefung : null;
  // Befehl 28: vorab vereinbart (Unterschrift ausstehend) – Inhalt fest, Fahrzeug reserviert, vertraglich erst mit Unterschrift
  const agreed = a.status === "AGREED";
  const periodChange = !!a.newEndAt || !!a.newStartAt;
  const agreeErrors = errors.filter((i) => i.code !== "SIGNATURE" && i.code !== "SIGNATURE_STALE");
  const canAgree = canEdit && a.status === "DRAFT" && periodChange && addedDrivers.length === 0 && removedDrivers.length === 0 && agreeErrors.length === 0;

  return (
    <>
      <PageHeader title="Nachtrag zum Mietvertrag" sub={<>Mietvertrag {a.contract.number} · Buchung {b.number} · <Chip tone={tone[a.status as AmendmentStatus] ?? "amber"}>{AMENDMENT_STATUS[a.status as AmendmentStatus] ?? a.status}</Chip></>}>{back}</PageHeader>
      <Content>
        {hint}
        {agreed ? (
          <section aria-label="Vereinbart – Unterschrift ausstehend" className="rounded-xl border-2 border-amber bg-amber-soft/60 p-4 flex flex-col gap-1.5">
            <div className="font-semibold text-amber">Vereinbart – Unterschrift ausstehend</div>
            <p className="text-sm">{a.agreedChannel ? AMENDMENT_AGREED_CHANNELS[a.agreedChannel as keyof typeof AMENDMENT_AGREED_CHANNELS] ?? "Vorab" : "Vorab"} vereinbart am {a.agreedAt ? fmtDateTime(a.agreedAt) : "–"}{a.agreedByName ? ` von ${a.agreedByName}` : ""}{a.agreedNote ? ` · ${a.agreedNote}` : ""}.</p>
            <p className="text-sm">{a.newEndAt ? <>Das Fahrzeug ist bis <b className="font-mono tnum">{fmtDateTime(a.newEndAt)}</b> für diese Miete reserviert. </> : null}Vertraglich wirksam – mit Preis, Rechnung und Kaution – wird die Änderung erst mit der Unterschrift. Bis dahin gilt der bisherige Vertragsstand.</p>
            {sp.vereinbart === "1" && <p role="status" className="text-sm text-good font-medium">Gespeichert: der neue Zeitraum ist ab sofort in Verfügbarkeit und Disposition reserviert.</p>}
          </section>
        ) : (
          <p className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm">{AMENDMENT_HELP.NO_EFFECT_DRAFT} {AMENDMENT_HELP.ORIGINAL_UNCHANGED}</p>
        )}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-4 items-start">
          <div className="flex flex-col gap-4 min-w-0">
            <Card title="1. Was wird geändert?">
              <div className="p-4">
                <ChangesForm
                  action={saveAmendmentChangesAction.bind(null, id, a.id)}
                  locked={!canEdit || agreed}
                  values={{ newStartAt: toDateTimeInput(a.newStartAt), newEndAt: toDateTimeInput(a.newEndAt), priceDeltaCents: a.priceDeltaCents, priceProposalCents: a.priceProposalCents, priceReason: a.priceReason ?? "", newKmIncludedPerDay: a.newKmIncludedPerDay, newExtraKmRate: a.newExtraKmRate != null ? dec(a.newExtraKmRate) : "", newKmPolicy: a.newKmPolicy, newDepositCents: a.newDepositCents, newReturnLocation: a.newReturnLocation, agreementText: a.agreementText }}
                  current={{ startAt: fmtDateTime(eff.startAt), canChangeStart: b.status === "RESERVED", endAt: fmtDateTime(eff.endAt), totalEur: dec(eff.totalCents / 100), kmIncludedPerDay: eff.kmIncludedPerDay, extraKmRateEur: dec(eff.extraKmRate), kmPolicy: eff.kmPolicy, kmPolicyLabel: KM_POLICIES[eff.kmPolicy], depositEur: dec(eff.depositCents / 100), returnLocation: eff.returnLocation ?? eff.pickupLocation ?? "wie Abholort" }}
                />
              </div>
            </Card>

            <div id="fahrer" className="scroll-mt-20">
              <Card title="2. Fahrer" right={<Chip tone={addedDrivers.length || removedDrivers.length ? "info" : "grey"}>{addedDrivers.length || removedDrivers.length ? `${addedDrivers.length} aufgenommen · ${removedDrivers.length} herausgenommen` : "unverändert"}</Chip>}>
                <div className="p-4 flex flex-col gap-4 text-sm">
                  <div className="flex flex-col gap-1.5">
                    <div className="label-xs">Fahrer laut wirksamem Vertragsstand</div>
                    {eff.drivers.map((d) => {
                      const removed = removedDrivers.some((r) => r.id === d.id);
                      return (
                        <div key={d.id} className={`flex flex-wrap items-center gap-2 py-1.5 border-b border-line-soft ${removed ? "line-through text-ink-3" : ""}`}>
                          <span className="font-medium">{d.firstName} {d.lastName}</span>
                          <Chip tone="info">{DRIVER_ROLES[d.role as DriverRole] ?? d.role}</Chip>
                          <span className="text-xs text-ink-3">geb. {fmtDate(d.birthDate)} · Klasse {d.licenseClass}</span>
                          <span className="flex-1" />
                          {canEdit && d.role !== "PRIMARY_DRIVER" && (
                            <form action={setDriverRemovalAction.bind(null, id, a.id, d.id, !removed)}><button className="btn !py-1.5">{removed ? "Herausnahme zurücknehmen" : "Mit diesem Nachtrag herausnehmen"}</button></form>
                          )}
                        </div>
                      );
                    })}
                    {removedDrivers.length > 0 && <p className="text-xs text-ink-3">Herausgenommene Fahrer bleiben in der Historie des Vertrags sichtbar; sie gelten nach Unterschrift nicht mehr als vereinbarte Fahrer.</p>}
                  </div>

                  {addedDrivers.length > 0 && (
                    <div className="flex flex-col gap-3">
                      <div className="label-xs">Mit diesem Nachtrag aufgenommen – Fahrerprüfung erforderlich</div>
                      {addedDrivers.map((d) => {
                        const view = overview.find((o) => o.driver.contractDriverId === d.id);
                        const v = view?.verification ?? null;
                        const status = view?.status ?? "NOT_STARTED";
                        const name = `${d.firstName} ${d.lastName}`;
                        const defaults = {
                          licenseNumber: v?.licenseNumberSnapshot ?? d.licenseNumber, licenseCountry: v?.licenseCountrySnapshot ?? d.licenseCountry,
                          licenseIssuedAt: toDateInputValue(v?.licenseIssuedAtSnapshot ?? d.licenseIssuedAt), licenseValidUntil: v?.licenseValidUntilSnapshot ? toDateInputValue(v.licenseValidUntilSnapshot) : d.licenseValidUntil ? toDateInputValue(d.licenseValidUntil) : "",
                          licenseClasses: v?.licenseClassesSnapshot.length ? v.licenseClassesSnapshot : [d.licenseClass].filter(Boolean),
                          internationalPermitPresented: v?.internationalPermitPresented ?? false, translationPresented: v?.translationPresented ?? false, notes: v?.notes ?? null,
                          manualReviewRequired: v?.manualReviewRequired ?? false, deviatesFromCustomer: v?.deviatesFromCustomer ?? false,
                        };
                        return (
                          <details key={d.id} className="card overflow-hidden" open={status !== "CONFIRMED"}>
                            <summary className="cursor-pointer list-none px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 select-none [&::-webkit-details-marker]:hidden">
                              <span className="font-semibold">{name}</span>
                              <Chip tone="info">Zusatzfahrer</Chip>
                              <Chip tone={statusTone[status]}>{DRIVER_VERIFICATION_STATUS[status]}</Chip>
                              <span className="flex-1" />
                              {canEdit && !v && <form action={dropAmendmentDriverAction.bind(null, id, a.id, d.id)}><button className="btn !py-1.5">Entfernen</button></form>}
                            </summary>
                            <div className="px-4 pb-4 pt-3 border-t border-line-soft flex flex-col gap-3">
                              {status === "CONFIRMED" && v ? (
                                <div className="rounded-md bg-good-soft px-3.5 py-3 text-sm"><p className="font-medium text-good">{v.checkKind === "REPEAT" ? "Wiederholungsprüfung bestätigt." : "Identität und Führerschein bestätigt."}</p><p className="text-xs text-ink-2">Klasse {v.licenseClassesSnapshot.join(", ")}{view?.requiredLicenseClass ? ` (erforderlich: ${view.requiredLicenseClass})` : ""} · geprüft {v.verifiedAt ? fmtDateTime(v.verifiedAt) : "–"} von {v.verifiedByName ?? "–"}</p></div>
                              ) : !canEdit ? <p className="text-ink-3">Prüfung noch offen.</p> : !v && view?.repeat && fullCheckFor !== d.id ? (
                                <div className="flex flex-col gap-3">
                                  <div className="rounded-md bg-info-soft px-3.5 py-3 text-sm"><p className="font-medium text-info">{name} · Bereits vollständig geprüft (Buchung {view.repeat.bookingNumber}, {view.repeat.verifiedAt ? fmtDateTime(view.repeat.verifiedAt) : "–"})</p><p className="text-xs text-ink-2">Klasse {view.repeat.licenseClasses.join(", ") || "–"} · gültig bis {view.repeat.licenseValidUntil ? fmtDate(view.repeat.licenseValidUntil) : "nicht angegeben"}</p></div>
                                  {view.repeat.eligible ? <RepeatVerificationForm action={repeatAmendmentDriverAction.bind(null, id, a.id, d.id)} /> : <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm"><div className="font-semibold mb-1">Schnellbestätigung nicht möglich</div><ul className="list-disc pl-5">{view.repeat.reasons.map((r) => <li key={r}>{r}</li>)}</ul></div>}
                                  <div><a href={`/buchungen/${id}/nachtrag/${a.id}?pruefung=${d.id}#fahrer`} className="btn w-full justify-center sm:w-auto">Daten neu prüfen</a></div>
                                </div>
                              ) : (
                                <>
                                  {(v?.blockedReasons ?? []).length > 0 && <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm"><div className="font-semibold mb-1">Prüfung noch nicht möglich</div><ul className="list-disc pl-5">{v!.blockedReasons.map((r) => <li key={r}>{DRIVER_BLOCKER_LABELS[r] ?? r}</li>)}</ul></div>}
                                  <DriverCheckForm action={verifyAmendmentDriverAction.bind(null, id, a.id, d.id)} driverName={name} requiredClass={view?.requiredLicenseClass ?? null} defaultDocumentType={v?.identityDocumentType ?? null} defaults={defaults} />
                                </>
                              )}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  )}

                  {canEdit && !agreed && (
                    <details className="rounded-md border border-line-soft">
                      <summary className="cursor-pointer px-3 py-2.5 font-medium">+ Zusatzfahrer aufnehmen</summary>
                      <div className="p-3 pt-1">
                        <InlineForm action={addAmendmentDriverAction.bind(null, id, a.id)} submitLabel="Zusatzfahrer aufnehmen">
                          <DriverFields values={emptyDriver} prefix="a_" />
                          <p className="text-xs text-ink-3">Der Fahrer wird erst mit der Unterschrift des Nachtrags wirksam und muss vorher wie bei der Übergabe geprüft werden (Ausweis und Führerschein im Original).</p>
                        </InlineForm>
                      </div>
                    </details>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <Card title="Zusammenfassung alt / neu">
              {changes.length === 0 ? <p className="p-4 text-sm text-ink-3">Noch keine Änderung erfasst.</p> : <ChangesTable changes={changes} />}
              {changes.length > 0 && <p className="px-4 pb-4 text-xs text-ink-3">Alle übrigen Vereinbarungen bleiben unverändert. Was hier steht, wird so unterschrieben.</p>}
            </Card>
            <Card title="Prüfung" right={<Chip tone={errors.length ? "amber" : "good"}>{errors.length ? `${errors.length} offen` : "bereit"}</Chip>}>
              <ul className="p-4 text-sm flex flex-col gap-1.5">
                {errors.length === 0 && <li className="text-good">Alle Voraussetzungen erfüllt. Der Nachtrag kann unterschrieben werden.</li>}
                {issues.map((i) => <li key={i.code} className={i.severity === "error" ? "text-bad" : "text-amber"}>{i.message}</li>)}
              </ul>
            </Card>
            <div id="unterschrift" className="scroll-mt-20">
              <Card title="3. Unterschrift">
                <div className="p-4 flex flex-col gap-4 text-sm">
                  {!readyToSign && <p className="text-ink-3">Unterschrieben wird erst, wenn alle Prüfpunkte erfüllt sind.</p>}
                  {readyToSign && canEdit && (
                    <>
                      {renterSig ? (
                        <div className="flex flex-wrap items-center gap-2"><Chip tone="good">Mieter unterschrieben</Chip><span>{renterSig.signerName} · {fmtDateTime(renterSig.signedAt)}</span><form action={removeAmendmentSignatureAction.bind(null, id, a.id, "RENTER")}><button className="btn !py-1">Entfernen</button></form></div>
                      ) : (
                        <SignatureForm action={saveAmendmentSignatureAction.bind(null, id, a.id)} role="RENTER" defaultName={renterName} seenHash={hash} />
                      )}
                      <details className="rounded-md border border-line-soft">
                        <summary className="cursor-pointer px-3 py-2.5 text-ink-2">Unterschrift Vermieter (optional)</summary>
                        <div className="p-3 pt-1">
                          {employeeSig ? (
                            <div className="flex flex-wrap items-center gap-2"><Chip tone="good">Vermieter unterschrieben</Chip><span>{employeeSig.signerName}</span><form action={removeAmendmentSignatureAction.bind(null, id, a.id, "EMPLOYEE")}><button className="btn !py-1">Entfernen</button></form></div>
                          ) : (
                            <SignatureForm action={saveAmendmentSignatureAction.bind(null, id, a.id)} role="EMPLOYEE" defaultName={user.name} seenHash={hash} />
                          )}
                        </div>
                      </details>
                    </>
                  )}
                  {canEdit && (
                    <FinalizeForm action={signAmendmentAction.bind(null, id, a.id)} disabled={!canFinalize} reason={!renterSig ? "Die Unterschrift des Mieters fehlt." : undefined} label="Nachtrag unterschreiben und wirksam machen" pendingLabel="Nachtrag wird wirksam gemacht…" />
                  )}
                  <p className="text-xs text-ink-3">Mit dem Wirksamwerden erhält der Nachtrag seine Nummer, der Inhalt wird versiegelt, Buchung und Kaution übernehmen den neuen Stand. Es wird nichts automatisch bezahlt, erstattet oder versendet.</p>
                </div>
              </Card>
            </div>
            {canEdit && a.status === "DRAFT" && periodChange && (
              <Card title="Telefonisch / extern vereinbart?">
                <div className="p-4 flex flex-col gap-2 text-sm">
                  <p className="text-ink-3">Wenn der Kunde die Änderung des Mietzeitraums bereits zugesagt hat (z. B. am Telefon), aber noch nicht unterschreiben kann: als <b>vereinbart</b> speichern. Das Fahrzeug wird sofort reserviert; Preis und Rechnung ändern sich erst mit der Unterschrift.</p>
                  {canAgree ? (
                    <MessageForm action={agreeAmendmentAction.bind(null, id, a.id)} submitLabel="Als vereinbart speichern – Fahrzeug reservieren" pendingLabel="Wird gespeichert…" className="btn btn-primary">
                      <label className="flex flex-col gap-1"><span className="label-xs">Vereinbart</span>
                        <select name="channel" required defaultValue="" className="input">
                          <option value="" disabled>bitte wählen</option>
                          {Object.entries(AMENDMENT_AGREED_CHANNELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1"><span className="label-xs">Notiz (optional)</span><input name="note" maxLength={500} className="input" placeholder="z. B. Anruf 15:05, Kunde bestätigt Verlängerung bis morgen 18:00" /></label>
                    </MessageForm>
                  ) : (
                    <p className="text-amber">{addedDrivers.length || removedDrivers.length ? "Fahreränderungen werden nicht vorab vereinbart." : agreeErrors.length ? `Erst möglich, wenn die Prüfung bestanden ist: ${agreeErrors[0].message}` : "Bitte zuerst die Änderung speichern."}</p>
                  )}
                </div>
              </Card>
            )}
            {canEdit && agreed && (
              <Card title="Vereinbarte Änderung zurücknehmen">
                <div className="p-4 flex flex-col gap-2 text-sm">
                  <p className="text-ink-3">Der Kunde möchte doch nicht? Die Reservierung entfällt, der Mietvertrag gilt unverändert, es entsteht kein Betrag. Die Zurücknahme wird mit Grund protokolliert.</p>
                  <MessageForm action={withdrawAgreedAmendmentAction.bind(null, id, a.id)} submitLabel="Vereinbarung zurücknehmen" pendingLabel="Wird zurückgenommen…" confirm="Die vereinbarte Änderung zurücknehmen? Die Reservierung wird aufgehoben.">
                    <label className="flex flex-col gap-1"><span className="label-xs">Grund (Pflicht)</span><textarea name="reason" required minLength={3} maxLength={500} rows={2} className="input" placeholder="z. B. Kunde hat abgesagt, bringt das Fahrzeug doch planmäßig zurück" /></label>
                  </MessageForm>
                </div>
              </Card>
            )}
            {canEdit && a.status === "DRAFT" && (
              <Card title="Entwurf verwerfen">
                <div className="p-4 flex flex-col gap-2 text-sm">
                  <p className="text-ink-3">Ein verworfener Entwurf hat keine Wirkung und verbraucht keine Nummer.</p>
                  <ConfirmForm action={discardAmendmentAction.bind(null, id, a.id)} label="Nachtrag verwerfen" question="Diesen Nachtrag-Entwurf verwerfen? Der Vertrag bleibt unverändert." />
                </div>
              </Card>
            )}
          </div>
        </div>
      </Content>
    </>
  );
}

function ChangesTable({ changes }: { changes: { kind: string; label: string; before: string; after: string; note?: string | null }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-ink-3"><th className="px-4 py-2 font-medium">Vereinbarung</th><th className="px-2 py-2 font-medium">bisher</th><th className="px-2 py-2 font-medium pr-4">neu</th></tr></thead>
        <tbody>
          {changes.map((c, i) => (
            <tr key={`${c.kind}-${i}`} className="border-t border-line-soft align-top">
              <td className="px-4 py-2 font-medium">{c.label}</td>
              <td className="px-2 py-2 text-ink-2 whitespace-pre-wrap">{c.before}</td>
              <td className="px-2 py-2 pr-4 font-medium whitespace-pre-wrap">{c.after}{c.note && <span className="block text-xs text-ink-3 font-normal">{c.note}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

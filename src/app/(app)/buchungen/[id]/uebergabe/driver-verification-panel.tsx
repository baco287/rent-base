// Schritt „Fahrer & Dokumente prüfen" (Phase 19.5): jeder laut finalisiertem Vertrag vorgesehene Fahrer wird
// getrennt identifiziert und seine Fahrerlaubnis anhand des Originaldokuments geprüft. Mieter und Fahrer sind
// fachlich getrennt – hier stehen alle vertraglichen Fahrer, nicht nur der Mieter. Eine Dokumentkopie ist immer
// optional; Pflicht ist ausschließlich die dokumentierte Originalprüfung.
import { Card, Chip } from "@/components/ui";
import { DRIVER_ROLES, DRIVER_VERIFICATION_STATUS, IDENTITY_DOCUMENT_TYPES, type DriverRole, type DriverVerificationStatus, type IdentityDocumentType } from "@/lib/constants";
import { driverVerificationOverview, listDriverDocumentCopies, type DriverVerificationView } from "@/lib/driver-verification";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { toDateInputValue } from "@/lib/time";
import { confirmDriverVerificationAction, repeatDriverVerificationAction, saveIdentityCheckAction, saveLicenseCheckAction, startDriverVerificationAction, updateCustomerLicenseAction } from "./driver-actions";
import { ConfirmDriverButton, DriverDocumentUploader, IdentityCheckForm, LicenseCheckForm, RepeatVerificationForm, StartDriverVerificationButton, UpdateCustomerLicenseButton } from "./driver-forms";

const statusTone: Record<DriverVerificationStatus, "good" | "amber" | "bad" | "info" | "grey"> = { NOT_STARTED: "grey", IN_PROGRESS: "amber", CONFIRMED: "good", BLOCKED: "bad" };

const BLOCKER_LABELS: Record<string, string> = {
  IDENTITY_NAME_MISMATCH: "Identität: Name stimmt nicht überein.",
  IDENTITY_BIRTHDATE_MISMATCH: "Identität: Geburtsdatum stimmt nicht überein.",
  LICENSE_INVALID: "Führerschein: als ungültig markiert.",
  LICENSE_NAME_MISMATCH: "Führerschein: Name stimmt nicht überein.",
  LICENSE_EXPIRED: "Führerschein: abgelaufen.",
  LICENSE_EXPIRES_BEFORE_RETURN: "Führerschein: läuft vor der geplanten Rückgabe ab.",
  LICENSE_CLASS_INSUFFICIENT: "Führerschein: erforderliche Fahrerlaubnisklasse fehlt.",
  LICENSE_NO_REQUIRED_CLASS_CONFIGURED: "Für dieses Fahrzeug ist keine erforderliche Fahrerlaubnisklasse hinterlegt. Bitte in den Fahrzeug- oder Gruppendaten konfigurieren.",
  LICENSE_MANUAL_REVIEW_OPEN: "Ausländischer Führerschein: manuelle Prüfung noch nicht bestätigt.",
  LICENSE_DEVIATES_FROM_CUSTOMER: "Die vorgelegten Daten unterscheiden sich von den Kundendaten und sind noch nicht bestätigt.",
};

function DriverCard({ bookingId, handoverId, view, role, copies }: { bookingId: string; handoverId: string; view: DriverVerificationView; role: string; copies: { id: string; documentKind: string; side: string; contractDriverId: string; verificationId: string }[] }) {
  const v = view.verification;
  const name = `${view.driver.firstName} ${view.driver.lastName}`;
  const confirmed = view.status === "CONFIRMED";
  const idCopies = copies.filter((c) => c.contractDriverId === view.driver.contractDriverId && c.documentKind === "IDENTITY");
  const licCopies = copies.filter((c) => c.contractDriverId === view.driver.contractDriverId && c.documentKind === "LICENSE");
  const blockers = (v?.blockedReasons ?? []).map((r) => BLOCKER_LABELS[r] ?? r);
  const canConfirm = !!v && v.status !== "CONFIRMED" && v.identityOriginalSeen && v.identityNameMatched === true && v.identityBirthDateMatched === true && v.licenseOriginalSeen && v.licenseDocumentValid === true && v.licenseNameMatched === true && v.licenseClassSatisfied === true && v.blockedReasons.length === 0;
  const canUpdateCustomer = role !== "YARD" && !!v?.customerId && !!v?.licenseOriginalSeen;

  return (
    <details className="card overflow-hidden" open={!confirmed}>
      <summary className="cursor-pointer list-none px-4 py-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 select-none [&::-webkit-details-marker]:hidden">
        <span className="font-semibold text-[15px]">{name}</span>
        <Chip tone="info">{DRIVER_ROLES[view.driver.role as DriverRole]}</Chip>
        <Chip tone={statusTone[view.status]}>{DRIVER_VERIFICATION_STATUS[view.status]}</Chip>
        <span className="flex-1" />
        <span className="text-ink-3 text-xs">{confirmed ? "Zuklappen" : "Aufklappen"}</span>
      </summary>
      <div className="px-4 pb-4 flex flex-col gap-4 border-t border-line-soft pt-4">
        {confirmed && v ? (
          <div className="rounded-md bg-good-soft px-3.5 py-3 flex flex-col gap-1.5 text-sm">
            <p className="font-medium text-good">{v.checkKind === "REPEAT" ? "Wiederholungsprüfung für diese Übergabe bestätigt." : "Identität und Führerschein bestätigt."}</p>
            {v.checkKind === "REPEAT" && v.notes && <p className="text-xs text-ink-2">{v.notes}</p>}
            <dl className="grid grid-cols-[minmax(140px,45%)_1fr] gap-x-3 gap-y-1 text-ink-2">
              <dt className="text-ink-3">Dokument</dt><dd>{IDENTITY_DOCUMENT_TYPES[v.identityDocumentType as IdentityDocumentType] ?? v.identityDocumentType}</dd>
              <dt className="text-ink-3">Fahrerlaubnisklassen</dt><dd>{v.licenseClassesSnapshot.join(", ")}{v.requiredLicenseClassSnapshot ? ` (erforderlich: ${v.requiredLicenseClassSnapshot})` : ""}</dd>
              <dt className="text-ink-3">Gültig bis</dt><dd>{v.licenseValidUntilSnapshot ? fmtDate(v.licenseValidUntilSnapshot) : "nicht angegeben"}</dd>
              <dt className="text-ink-3">Geprüft am</dt><dd>{v.verifiedAt ? fmtDateTime(v.verifiedAt) : "–"}</dd>
              <dt className="text-ink-3">Geprüft von</dt><dd>{v.verifiedByName ?? "–"}</dd>
            </dl>
            {(idCopies.length > 0 || licCopies.length > 0) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                {idCopies.length > 0 && <DriverDocumentUploader handoverId={handoverId} verificationId={v.id} contractDriverId={view.driver.contractDriverId} documentKind="IDENTITY" copies={idCopies} editable={false} />}
                {licCopies.length > 0 && <DriverDocumentUploader handoverId={handoverId} verificationId={v.id} contractDriverId={view.driver.contractDriverId} documentKind="LICENSE" copies={licCopies} editable={false} />}
              </div>
            )}
          </div>
        ) : !v && view.repeat ? (
          // Befehl 20.9: bekannter Fahrer – Stammdaten aus der letzten vollständigen Prüfung, Bestätigung für DIESE Übergabe
          <div className="flex flex-col gap-3">
            <div className="rounded-md bg-info-soft px-3.5 py-3 flex flex-col gap-1.5 text-sm">
              <p className="font-medium text-info">{name} · Bereits vollständig geprüft</p>
              <dl className="grid grid-cols-[minmax(140px,45%)_1fr] gap-x-3 gap-y-1 text-ink-2">
                <dt className="text-ink-3">Führerschein</dt><dd>Klasse {view.repeat.licenseClasses.join(", ") || "–"}{view.requiredLicenseClass ? ` (erforderlich: ${view.requiredLicenseClass})` : ""}</dd>
                <dt className="text-ink-3">Gültig bis</dt><dd>{view.repeat.licenseValidUntil ? fmtDate(view.repeat.licenseValidUntil) : "nicht angegeben"}</dd>
                <dt className="text-ink-3">Ausweis</dt><dd>{IDENTITY_DOCUMENT_TYPES[view.repeat.identityDocumentType as IdentityDocumentType] ?? view.repeat.identityDocumentType ?? "–"}</dd>
                <dt className="text-ink-3">Zuletzt vollständig geprüft</dt><dd>{view.repeat.verifiedAt ? fmtDateTime(view.repeat.verifiedAt) : "–"}{view.repeat.verifiedByName ? ` von ${view.repeat.verifiedByName}` : ""} · Buchung {view.repeat.bookingNumber}</dd>
              </dl>
            </div>
            {view.repeat.eligible ? (
              <>
                <p className="text-xs text-ink-2">Für diese Übergabe wird ein eigener Prüfvermerk (Wiederholungs-/Sichtprüfung) mit Bezug auf die letzte Prüfung dokumentiert. Die alte Prüfung bleibt unverändert.</p>
                <RepeatVerificationForm action={repeatDriverVerificationAction.bind(null, bookingId, handoverId, view.driver.contractDriverId)} />
              </>
            ) : (
              <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">
                <div className="font-semibold mb-1">Schnellbestätigung nicht möglich</div>
                <ul className="list-disc pl-5">{view.repeat.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            )}
            <StartDriverVerificationButton action={startDriverVerificationAction.bind(null, bookingId, handoverId, view.driver.contractDriverId)} label={view.repeat.eligible ? "Daten haben sich geändert – vollständige Prüfung" : `Vollständige Prüfung für ${name} beginnen`} />
          </div>
        ) : !v ? (
          <StartDriverVerificationButton action={startDriverVerificationAction.bind(null, bookingId, handoverId, view.driver.contractDriverId)} label={`Prüfung für ${name} beginnen`} />
        ) : (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-sm">1 · Identität prüfen</h3>
              <IdentityCheckForm
                action={saveIdentityCheckAction.bind(null, bookingId, v.id)}
                defaultDocumentType={v.identityDocumentType}
                defaultNameMatched={v.identityNameMatched}
                defaultBirthMatched={v.identityBirthDateMatched}
                defaultNotes={v.notes}
                disabled={false}
              />
              <DriverDocumentUploader handoverId={handoverId} verificationId={v.id} contractDriverId={view.driver.contractDriverId} documentKind="IDENTITY" copies={idCopies} editable />
            </section>
            <section className="flex flex-col gap-2 pt-2 border-t border-line-soft">
              <h3 className="font-semibold text-sm">2 · Führerschein prüfen</h3>
              <LicenseCheckForm
                action={saveLicenseCheckAction.bind(null, bookingId, v.id)}
                requiredClass={view.requiredLicenseClass}
                defaults={{
                  documentValid: v.licenseDocumentValid, nameMatched: v.licenseNameMatched,
                  licenseNumber: v.licenseNumberSnapshot ?? view.driver.licenseNumber, licenseCountry: v.licenseCountrySnapshot ?? view.driver.licenseCountry,
                  licenseIssuedAt: toDateInputValue(v.licenseIssuedAtSnapshot ?? view.driver.licenseIssuedAt),
                  licenseValidUntil: v.licenseValidUntilSnapshot ? toDateInputValue(v.licenseValidUntilSnapshot) : view.driver.licenseValidUntil ? toDateInputValue(view.driver.licenseValidUntil) : "",
                  licenseClasses: v.licenseClassesSnapshot.length ? v.licenseClassesSnapshot : [view.driver.licenseClass].filter(Boolean),
                  internationalPermitPresented: v.internationalPermitPresented, translationPresented: v.translationPresented, notes: v.notes,
                  manualReviewRequired: v.manualReviewRequired, deviatesFromCustomer: v.deviatesFromCustomer,
                }}
                disabled={false}
              />
              <DriverDocumentUploader handoverId={handoverId} verificationId={v.id} contractDriverId={view.driver.contractDriverId} documentKind="LICENSE" copies={licCopies} editable />
              {canUpdateCustomer && v.deviatesFromCustomer && <UpdateCustomerLicenseButton action={updateCustomerLicenseAction.bind(null, bookingId, v.id)} />}
            </section>
            <section className="pt-2 border-t border-line-soft">
              <h3 className="font-semibold text-sm mb-2">3 · Prüfung bestätigen</h3>
              <ConfirmDriverButton action={confirmDriverVerificationAction.bind(null, bookingId, v.id)} disabled={!canConfirm} blockers={blockers} />
            </section>
          </>
        )}
      </div>
    </details>
  );
}

export async function DriverVerificationSection({ tenantId, bookingId, handoverId, role }: { tenantId: string; bookingId: string; handoverId: string; role: string }) {
  const [overview, copies] = await Promise.all([driverVerificationOverview(tenantId, handoverId), listDriverDocumentCopies(tenantId, handoverId)]);
  const openCount = overview.filter((o) => o.status !== "CONFIRMED").length;
  return (
    <>
      <Card title="Fahrer & Dokumente" right={<Chip tone={openCount ? "amber" : "good"}>{openCount ? `${openCount} offen` : "vollständig"}</Chip>}>
        <p className="px-4 pt-3 pb-1 text-sm text-ink-2 max-w-[75ch]">Jeder im Mietvertrag vorgesehene Fahrer wird einzeln identifiziert; seine Fahrerlaubnis wird anhand des vorgelegten Originaldokuments geprüft. Eine Dokumentkopie ist optional und ersetzt die Prüfung nicht.</p>
      </Card>
      <div className="flex flex-col gap-3">
        {overview.map((o) => <DriverCard key={o.driver.contractDriverId} bookingId={bookingId} handoverId={handoverId} view={o} role={role} copies={copies} />)}
      </div>
    </>
  );
}

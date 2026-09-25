// Schnellweg „Prüfen & senden“: Für eindeutige Fälle schlägt Rent-Base die passende Antwort vor (Antwortart, Versandweg,
// ggf. den einzigen Vertragsfahrer) und zeigt genau den Inhalt, der an die Behörde geht. Ein Klick mit ausdrücklicher
// Bestätigung erledigt dann Fahrerbestimmung → Entwurf → Freigabe → (bei E-Mail) Versand. Es wird nie ohne diese
// Bestätigung eine Person benannt; bei mehreren Fahrern, mehreren Vermietungen, mehrdeutigen Kennzeichen oder nur
// geplanten Zeiten gibt es keinen Schnellweg, sondern den normalen, bewussten Ablauf.

import { recordAudit, type Actor } from "@/lib/audit";
import { db } from "@/lib/db";
import { approveResponse, authorityCaseView, previewResponse, prepareResponse, setDriver, submitResponse, type AuthorityCaseView, type DriverCandidate, type DriverSnapshot, type SubmitResult } from "@/lib/authority";
import type { AuthorityResponseType, SubmissionMethod } from "@/lib/constants";
import { DomainError, contentHash } from "@/lib/integrity";
import type { AuthorityResponsePdfData } from "@/lib/pdf/authority-pdf";
import type { MailTransport } from "@/lib/mail";
import type { StorageDriver } from "@/lib/storage";

export type QuickPlan =
  | { available: false; reason: string }
  | {
      available: true;
      responseType: AuthorityResponseType;
      submissionMethod: SubmissionMethod;
      /** Person, die mit der Bestätigung als Fahrer bestimmt wird (nur wenn noch nicht bestimmt) */
      driverToConfirm: DriverCandidate | null;
      /** warum dieser Vorschlag – für die Anzeige */
      because: string[];
      /** Hinweise, die vor dem Klick gelesen werden sollten */
      warnings: string[];
      /** Stand, auf dem der Vorschlag beruht; ändert sich der Vorgang, wird der Klick abgelehnt */
      fingerprint: string;
    };

const OPEN = ["RECEIVED", "ASSIGNMENT_REQUIRED", "REVIEW_REQUIRED"];

/** Rein aus dem Vorgangsstand abgeleitet – speichert nichts. */
export function planQuickResponse(c: AuthorityCaseView): QuickPlan {
  if (!OPEN.includes(c.status)) return { available: false, reason: "Für diesen Vorgang gibt es bereits eine Antwort oder er ist abgeschlossen." };
  if (c.responses.some((r) => r.status !== "SUPERSEDED")) return { available: false, reason: "Es gibt bereits eine Antwortfassung – bitte im normalen Ablauf weiterarbeiten." };
  if (c.vehicleMatch === "AMBIGUOUS") return { available: false, reason: "Mehrere Fahrzeuge tragen dieses Kennzeichen. Bitte zuerst das Fahrzeug zuordnen." };
  if (c.rentalMatch === "AMBIGUOUS" || (!c.bookingId && c.rentalCandidates.length > 1)) return { available: false, reason: "Mehrere Vermietungen kommen in Frage. Bitte zuerst die Vermietung zuordnen." };

  const because: string[] = [];
  const warnings: string[] = [];
  let responseType: AuthorityResponseType;
  let driverToConfirm: DriverCandidate | null = null;

  if (!c.vehicleId) {
    if (c.vehicleMatch !== "NO_MATCH") return { available: false, reason: "Noch kein Fahrzeug zugeordnet." };
    responseType = "VEHICLE_NOT_IN_FLEET";
    because.push(`Kein Fahrzeug der Flotte trägt das Kennzeichen ${c.licensePlateSnapshot}.`);
    warnings.push("Bitte das Kennzeichen im Schreiben mit der Erfassung vergleichen – ein Tippfehler würde zu einer falschen Antwort führen.");
  } else if (!c.bookingId) {
    responseType = "NO_MATCHING_RENTAL";
    because.push(`Das Fahrzeug ${c.vehicle?.plate ?? ""} war zur Tatzeit laut Rent-Base nicht vermietet.`);
    if (!c.offenseTimeKnown) warnings.push("Die Uhrzeit ist unbekannt – geprüft wurde nur der Tattag.");
  } else {
    if (c.rentalMatch === "PLANNED_PERIOD") return { available: false, reason: "Zur Vermietung gibt es keine abgeschlossene Übergabe (nur geplante Zeiten). Bitte manuell prüfen." };
    if (c.booking?.contract?.status !== "SIGNED" || c.driverCandidates.length === 0) return { available: false, reason: "Zur Vermietung gibt es keinen abgeschlossenen Mietvertrag mit Fahrern. Bitte manuell antworten." };
    because.push(`Tatzeit liegt in der Vermietung ${c.booking.number}${c.rentalMatch === "ACTUAL_PERIOD" ? " (tatsächliche Übergabe- und Rückgabezeit)" : " (manuell zugeordnet)"}.`);
    if (c.rentalMatchDayOnly) warnings.push("Die Uhrzeit ist unbekannt – die Vermietung passt nur tagesgenau.");
    if (c.driverDeterminationStatus === "CONTRACT_DRIVER_SELECTED" || c.driverDeterminationStatus === "OTHER_DRIVER_ENTERED") {
      responseType = "DRIVER_IDENTIFIED";
      because.push(`Fahrer wurde bereits bestimmt: ${c.driver?.firstName} ${c.driver?.lastName}.`);
    } else if (c.driverDeterminationStatus === "NOT_IDENTIFIABLE" || c.driverDeterminationStatus === "NO_DRIVER_INFORMATION") {
      responseType = "DRIVER_NOT_IDENTIFIABLE";
      because.push("Der Fahrer wurde als nicht feststellbar eingestuft.");
    } else if (c.driverCandidates.length === 1) {
      responseType = "DRIVER_IDENTIFIED";
      driverToConfirm = c.driverCandidates[0];
      because.push(`Im Mietvertrag ${c.booking.contract.number} ist nur eine Person als Fahrer eingetragen: ${driverToConfirm.firstName} ${driverToConfirm.lastName}.`);
    } else {
      responseType = "MULTIPLE_POSSIBLE_DRIVERS";
      because.push(`Im Mietvertrag ${c.booking.contract.number} sind ${c.driverCandidates.length} Fahrer eingetragen; Rent-Base wählt keinen davon aus.`);
      warnings.push("Wenn Sie wissen, wer gefahren ist, bestimmen Sie den Fahrer bitte unten bewusst – dann wird nur diese Person benannt.");
    }
  }

  const submissionMethod: SubmissionMethod = c.authorityEmail ? "EMAIL" : c.portal.ok ? "MANUAL_PORTAL" : "POST";
  because.push(submissionMethod === "EMAIL" ? `Versand per E-Mail an ${c.authorityEmail} (Adresse aus dem Schreiben).` : submissionMethod === "MANUAL_PORTAL" ? "Keine E-Mail-Adresse erfasst, aber ein Behördenportal – Antwort-PDF wird für das Portal vorbereitet." : "Keine E-Mail-Adresse erfasst – Antwort-PDF wird für den Postversand vorbereitet.");
  if (submissionMethod === "POST" && !c.authorityAddress) warnings.push("Die Anschrift der Behörde fehlt – für den Postversand bitte oben ergänzen.");
  if (c.deadline.level === "OVERDUE") warnings.push(`Die Antwortfrist ist ${c.deadline.text}.`);

  const fingerprint = contentHash({ updatedAt: c.updatedAt.toISOString(), vehicleId: c.vehicleId, bookingId: c.bookingId, contractId: c.contractId, driver: c.driverDeterminationStatus, driverId: c.driverContractDriverId, candidates: c.driverCandidates.map((d) => d.contractDriverId), responseType, submissionMethod, email: c.authorityEmail });
  return { available: true, responseType, submissionMethod, driverToConfirm, because, warnings, fingerprint };
}

const snapshotOf = (d: DriverCandidate): DriverSnapshot => ({ source: "CONTRACT_DRIVER", role: d.role, firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate.toISOString().slice(0, 10), street: d.street, zip: d.zip, city: d.city, country: d.country });

/** Vorschau des Schnellwegs: genau der Inhalt, der nach der Bestätigung freigegeben würde. */
export async function quickPreview(tenantId: string, c: AuthorityCaseView, plan: Extract<QuickPlan, { available: true }>, opts: { includeBirthDate: boolean; includeAddress: boolean }): Promise<AuthorityResponsePdfData> {
  return previewResponse(tenantId, c.id, { responseType: plan.responseType, submissionMethod: plan.submissionMethod, includeBirthDate: opts.includeBirthDate, includeAddress: opts.includeAddress }, plan.driverToConfirm ? snapshotOf(plan.driverToConfirm) : null);
}

export type QuickInput = { fingerprint: string; confirmed: boolean; includeBirthDate: boolean; includeAddress: boolean; transport?: MailTransport; storage?: StorageDriver };
export type QuickResult = { responseId: string; version: number; method: SubmissionMethod; submit: SubmitResult | null };

/**
 * Führt den Vorschlag aus. Jeder Schritt ist der normale, geprüfte Einzelschritt (eigene Transaktion, Historie, Audit);
 * bricht ein späterer Schritt ab (z. B. E-Mail-Fehler), bleibt der Vorgang im erreichten Zwischenstand und kann im
 * normalen Ablauf fortgesetzt werden.
 */
export async function runQuickResponse(tenantId: string, caseId: string, actor: Actor, input: QuickInput): Promise<QuickResult> {
  const view = await authorityCaseView(tenantId, caseId);
  const plan = planQuickResponse(view);
  if (!plan.available) throw new DomainError(plan.reason);
  if (plan.fingerprint !== input.fingerprint) throw new DomainError("Der Vorgang wurde zwischenzeitlich geändert. Bitte die Seite neu laden und den Vorschlag erneut prüfen.");
  const naming = plan.responseType === "DRIVER_IDENTIFIED" || plan.responseType === "MULTIPLE_POSSIBLE_DRIVERS";
  if (!input.confirmed) throw new DomainError(naming ? "Bitte bestätigen Sie ausdrücklich, dass für die Benennung eine ausreichende Grundlage vorliegt und die Angaben geprüft sind." : "Bitte bestätigen Sie ausdrücklich, dass die Angaben geprüft sind.");

  if (plan.driverToConfirm) {
    await setDriver(tenantId, caseId, actor, { mode: "CONTRACT", contractDriverId: plan.driverToConfirm.contractDriverId, confirmed: true, note: "Einziger Fahrer laut Mietvertrag – über „Prüfen & senden“ bestätigt" });
  }
  const draft = await prepareResponse(tenantId, caseId, actor, { responseType: plan.responseType, submissionMethod: plan.submissionMethod, includeBirthDate: input.includeBirthDate, includeAddress: input.includeAddress });
  const approved = await approveResponse(tenantId, draft.id, actor, { storage: input.storage });
  await db.$transaction((tx) => recordAudit(tx, tenantId, actor, { action: "AUTHORITY_QUICK_RESPONSE", bookingId: view.bookingId, details: { caseNumber: view.caseNumber, responseType: plan.responseType, method: plan.submissionMethod, driverConfirmed: !!plan.driverToConfirm } }));
  const submit = plan.submissionMethod === "EMAIL" ? await submitResponse(tenantId, approved.id, actor, { transport: input.transport, storage: input.storage }) : null;
  return { responseId: approved.id, version: approved.version, method: plan.submissionMethod, submit };
}

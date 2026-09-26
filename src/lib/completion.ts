// „Vor Abschluss prüfen“: eine einzige serverseitige Quelle für die offenen Punkte einer Übergabe oder Rückgabe.
// Grundlage sind exakt die Regeln, mit denen finalizeHandover abschließt (collectIssues in handovers.ts) – die Karte
// erfindet keine eigene Geschäftslogik. Blocker verhindern den Abschluss, Hinweise nicht (z. B. Kaution, Entscheidung Phase 9).
// Zusätzlich als Hinweis: Zusatzkosten-Vorschläge der Rückgabe, die weder bestätigt noch verworfen wurden.

import { getHandoverState, type HandoverIssue } from "@/lib/handovers";
import { getReturnComparison } from "@/lib/returns";

export type CompletionItem = { code: string; message: string; step: number; stepLabel: string; blocking: boolean };
export type CompletionStatus = { type: "PICKUP" | "RETURN"; blockers: CompletionItem[]; warnings: CompletionItem[]; renterSigned: boolean; ready: boolean };

const PICKUP_STEP_LABELS = ["Übersicht", "Kilometer & Energie", "Schäden", "Fotos", "Checkliste", "Fahrer & Dokumente", "Unterschrift", "Abschluss"];
const RETURN_STEP_LABELS = ["Übersicht", "Kilometer & Mietdauer", "Tank / Batterie", "Fahrzeugzustand", "Fotos", "Checkliste", "Zusatzkosten", "Unterschrift", "Abschluss"];

/** Zu welchem Schritt des Assistenten ein Punkt gehört (damit jeder offene Punkt direkt dorthin führt). */
function stepOf(type: "PICKUP" | "RETURN", issue: Pick<HandoverIssue, "area" | "code">): number {
  if (type === "PICKUP") {
    switch (issue.area) {
      case "READINGS": return 2;
      case "DAMAGES": return 3;
      case "PHOTOS": return 4;
      case "CHECKLIST": return 5;
      case "DRIVERS": return 6;
      case "SIGNATURE": return 7;
      default: return 1;
    }
  }
  switch (issue.area) {
    case "READINGS": return issue.code.startsWith("MILEAGE") ? 2 : 3;
    case "DAMAGES": return 4;
    case "PHOTOS": return 5;
    case "CHECKLIST": return 6;
    case "CHARGES": return 7;
    case "SIGNATURE": return 8;
    default: return 1;
  }
}

export async function getHandoverCompletionStatus(tenantId: string, handoverId: string): Promise<CompletionStatus> {
  const { handover, signatures, issues, hash } = await getHandoverState(tenantId, handoverId);
  const type = handover.type as "PICKUP" | "RETURN";
  const labels = type === "PICKUP" ? PICKUP_STEP_LABELS : RETURN_STEP_LABELS;
  const all: HandoverIssue[] = [...issues];
  // Unterschrift: dieselbe Regel wie beim Abschluss (requireSignature), hier ohne Bilddaten
  const renter = signatures.find((s) => s.role === "RENTER");
  if (handover.status === "DRAFT" && handover.returnMode === "KEY_DROP") {
    // Befehl 20.6: keine Kundenunterschrift unter die Kontrolle; die Kundenmeldung (oder der Ausnahmegrund) prüft collectIssues
    if (renter) all.push({ area: "SIGNATURE", code: "KEY_DROP_RENTER_SIGNATURE", severity: "error", message: "Bei der kontaktlosen Rückgabe unterschreibt der Kunde nicht unter die Feststellungen der Kontrolle." });
    if (signatures.some((s) => s.role === "EMPLOYEE" && s.contentHash !== hash)) all.push({ area: "SIGNATURE", code: "SIGNATURE_STALE_EMPLOYEE", severity: "error", message: "Die Unterschrift des Mitarbeiters passt nicht mehr zum Protokoll." });
  } else if (handover.status === "DRAFT") {
    if (!renter) all.push({ area: "SIGNATURE", code: "SIGNATURE_MISSING", severity: "error", message: "Die Unterschrift des Mieters fehlt." });
    else if (renter.contentHash !== hash) all.push({ area: "SIGNATURE", code: "SIGNATURE_STALE", severity: "error", message: "Das Protokoll wurde nach der Unterschrift geändert. Der Mieter muss erneut unterschreiben." });
    if (signatures.some((s) => s.role === "EMPLOYEE" && s.contentHash !== hash)) all.push({ area: "SIGNATURE", code: "SIGNATURE_STALE_EMPLOYEE", severity: "error", message: "Die Unterschrift des Mitarbeiters passt nicht mehr zum Protokoll." });
  }
  if (handover.status === "DRAFT") {
    if (type === "RETURN") {
      const cmp = await getReturnComparison(tenantId, handoverId);
      for (const p of cmp.proposals) {
        if (!p.confirmed) all.push({ area: "CHARGES", code: `PROPOSAL_OPEN_${p.key}`, severity: "warning", message: `Zusatzkosten-Vorschlag „${p.draft.description}“ (${p.draft.formula}) ist weder bestätigt noch verworfen. Ohne Bestätigung wird er nicht berechnet.` });
      }
    }
  }
  const toItem = (i: HandoverIssue): CompletionItem => { const step = stepOf(type, i); return { code: i.code, message: i.message, step, stepLabel: labels[step - 1], blocking: i.severity === "error" }; };
  const blockers = all.filter((i) => i.severity === "error").map(toItem);
  const warnings = all.filter((i) => i.severity === "warning").map(toItem);
  return { type, blockers, warnings, renterSigned: handover.returnMode === "KEY_DROP" ? true : !!renter && renter.contentHash === hash, ready: blockers.length === 0 };
}

export const getPickupCompletionStatus = getHandoverCompletionStatus;
export const getReturnCompletionStatus = getHandoverCompletionStatus;

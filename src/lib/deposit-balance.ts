// Kaution: reine Saldenrechnung (Befehl 27 aus deposits.ts herausgelöst, Inhalt unverändert). Ohne Datenbank, damit
// lib/amendments (Nachträge) und lib/deposits dieselbe Rechnung nutzen, ohne sich gegenseitig zu importieren.
import type { DepositStatus } from "@/lib/constants";
import type { Cents } from "@/lib/money";

/**
 * offsetCents (Befehl 20.7): mit Forderungen verrechnete Kaution – verbraucht, nicht mehr verfügbar, kein Einbehalt.
 * Befehl 22: offsetCents ist NETTO (Verrechnungen − Rückführungen aus Kundenguthaben); alle Salden rechnen damit.
 * offsetGrossCents / offsetReturnedCents zeigen die Herkunft: 95 verrechnet, davon 40 zurückgeführt, netto 55.
 */
export type DepositBalance = { expectedCents: Cents; receivedCents: Cents; releasedCents: Cents; retainedCents: Cents; offsetCents: Cents; offsetGrossCents: Cents; offsetReturnedCents: Cents; remainingCents: Cents; status: DepositStatus };

/**
 * Status aus den Summen. Nach einer Entscheidung (Freigabe/Einbehalt/Verrechnung) ist immer die ganze erhaltene Kaution
 * zugeordnet. Verrechnete Kaution zählt für den Status wie einbehalten (kein sechster Status – alle Anzeigen schalten auf
 * die fünf bekannten Werte); die Anzeige unterscheidet über offsetCents.
 */
export function deriveDepositStatus(receivedCents: Cents, releasedCents: Cents, retainedCents: Cents, offsetCents: Cents = 0): DepositStatus {
  if (receivedCents <= 0) return "EXPECTED";
  const kept = retainedCents + offsetCents;
  const settled = releasedCents + kept;
  if (settled <= 0) return "RECEIVED";
  if (settled < receivedCents) return "PARTIALLY_RELEASED";
  if (kept === 0) return "RELEASED";
  if (releasedCents === 0) return "RETAINED";
  return "PARTIALLY_RELEASED";
}

export function balanceOf(expectedCents: Cents, events: { type: string; amountCents: number; status: string }[]): DepositBalance {
  let receivedCents = 0, releasedCents = 0, retainedCents = 0, offsetGrossCents = 0, offsetReturnedCents = 0;
  for (const e of events) {
    if (e.status !== "CONFIRMED") continue;
    if (e.type === "RECEIVED") receivedCents += e.amountCents;
    else if (e.type === "RELEASED") releasedCents += e.amountCents;
    else if (e.type === "RETAINED") retainedCents += e.amountCents;
    else if (e.type === "OFFSET") offsetGrossCents += e.amountCents;
    else if (e.type === "OFFSET_RETURN") offsetReturnedCents += e.amountCents;
  }
  const offsetCents = offsetGrossCents - offsetReturnedCents;
  return { expectedCents, receivedCents, releasedCents, retainedCents, offsetCents, offsetGrossCents, offsetReturnedCents, remainingCents: receivedCents - releasedCents - retainedCents - offsetCents, status: deriveDepositStatus(receivedCents, releasedCents, retainedCents, offsetCents) };
}

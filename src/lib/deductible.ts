// Befehl 29.5: vereinbarte Selbstbeteiligung eines unterschriebenen Mietvertrags samt Herkunft – nur zur Information (intern,
// z. B. Schadenakte). Hier wird nichts berechnet und nichts gebucht: keine Schadenforderung, keine Kautionsverrechnung, keine
// Rechnung. Maßgeblich bleiben der Vertrag und die Prüfung des konkreten Schadenfalls.
//
// Ein Nachtrag kann die Selbstbeteiligung (noch) nicht ändern – der Wert des unterschriebenen Vertrags gilt für die gesamte Miete.

import { fmtCents, toCents } from "@/lib/money";
import { deductibleSourceText, readTariffSnapshot } from "@/lib/tariffs";

export type ContractDeductibleInfo = {
  /** vereinbarte Selbstbeteiligung laut Vertrag (Cent) */
  cents: number;
  /** Herkunft in Worten, z. B. „laut Tarif PLUS, Revision 2“ oder „individuell vereinbart“ */
  origin: string;
  /** tariflicher Wert (bzw. Geschäftsregel bei Tarif ohne Vorgabe); null bei Verträgen vor 29.5 */
  tariffCents: number | null;
  /** interner Grund einer Abweichung – nie im Kundendokument */
  reason: string | null;
};

/** null, solange kein unterschriebener Vertrag vorliegt (ein Entwurf ist noch nicht vereinbart). */
export function contractDeductibleInfo(contract: { status: string; deductible: unknown; priceSnapshot: unknown } | null | undefined): ContractDeductibleInfo | null {
  if (!contract || contract.status !== "SIGNED") return null;
  const cents = toCents(contract.deductible);
  const tariff = readTariffSnapshot((contract.priceSnapshot as { tariff?: unknown } | null)?.tariff);
  const agreed = tariff?.agreed.deductible ?? null;
  if (!tariff || (!tariff.deductible && !agreed)) return { cents, origin: "laut Mietvertrag", tariffCents: null, reason: null };
  const tariffText = `Tarif ${tariff.ratePlanName}, Revision ${tariff.revision}`;
  if (agreed) {
    const base = tariff.deductible ? `${tariff.deductible.source === "TARIFF" ? "Tarifwert" : "Geschäftsregel"} ${fmtCents(tariff.deductible.cents)}` : "Tarifwert nicht erfasst";
    return { cents, origin: `individuell vereinbart (${tariffText}; ${base})`, tariffCents: tariff.deductible?.cents ?? null, reason: agreed.reason };
  }
  return { cents, origin: tariff.deductible!.source === "TARIFF" ? `laut ${tariffText}` : `${deductibleSourceText(tariff.deductible)} – ${tariffText}`, tariffCents: tariff.deductible!.cents, reason: null };
}

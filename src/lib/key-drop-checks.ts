// Befehl 20.6 (Ergänzung): Abgleich Kundenangabe ↔ nachträgliche Kontrolle und Zeitplausibilität der Kundenmeldung.
// Reine Funktionen ohne Datenbank: dieselben Hinweise im Assistenten, in „Vor Abschluss prüfen“ und im Rückgabeprotokoll.
// Hinweise sind Feststellungen, keine Bewertung und keine Forderung – sie blockieren nichts und lösen nichts aus.

import { fmtMinutes } from "@/lib/handover-view";
import { APP_TIME_ZONE } from "@/lib/time";

export const KEY_DROP_THRESHOLDS = { mileageKm: 20, fuelEighths: 1, batteryPoints: 5, timeGapMinutes: 120 } as const;

export type KeyDropCheckInput = {
  customer: { dropOffAt: Date | null; mileage: number | null; fuelEighths: number | null; batteryPercent: number | null; newDamages: boolean | null; startedAt: Date | null; confirmedAt: Date | null; firstPhotoAt: Date | null };
  inspection: { mileage: number | null; fuelEighths: number | null; batteryPercent: number | null; newDamageCount: number };
};

export type KeyDropFinding = { code: string; kind: "MILEAGE" | "ENERGY" | "DAMAGE" | "TIME"; message: string };

const at = (d: Date) => d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const km = (n: number) => `${n.toLocaleString("de-DE")} km`;
const signed = (n: number, unit: string) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toLocaleString("de-DE")}${unit}`;

export function keyDropFindings(i: KeyDropCheckInput): KeyDropFinding[] {
  const out: KeyDropFinding[] = [];
  const c = i.customer;
  const k = i.inspection;
  if (c.mileage != null && k.mileage != null && Math.abs(k.mileage - c.mileage) > KEY_DROP_THRESHOLDS.mileageKm) {
    out.push({ code: "MILEAGE_KEYDROP_DIFF", kind: "MILEAGE", message: `Kilometerstand weicht ab: Kunde ${km(c.mileage)}, Kontrolle ${km(k.mileage)} (${signed(k.mileage - c.mileage, " km")}). Maßgeblich ist der Wert der Kontrolle.` });
  }
  if (c.fuelEighths != null && k.fuelEighths != null && Math.abs(k.fuelEighths - c.fuelEighths) >= KEY_DROP_THRESHOLDS.fuelEighths) {
    out.push({ code: "FUEL_KEYDROP_DIFF", kind: "ENERGY", message: `Tankstand weicht ab: Kunde ${c.fuelEighths}/8, Kontrolle ${k.fuelEighths}/8 (${signed(k.fuelEighths - c.fuelEighths, "/8")}).` });
  }
  if (c.batteryPercent != null && k.batteryPercent != null && Math.abs(k.batteryPercent - c.batteryPercent) >= KEY_DROP_THRESHOLDS.batteryPoints) {
    out.push({ code: "BATTERY_KEYDROP_DIFF", kind: "ENERGY", message: `Batteriestand weicht ab: Kunde ${c.batteryPercent} %, Kontrolle ${k.batteryPercent} % (${signed(k.batteryPercent - c.batteryPercent, " Prozentpunkte")}).` });
  }
  if (c.newDamages === false && k.newDamageCount > 0) {
    out.push({ code: "DAMAGE_KEYDROP_UNREPORTED", kind: "DAMAGE", message: `Der Kunde hat keine neuen Schäden angegeben; bei der Kontrolle ${k.newDamageCount === 1 ? "wurde 1 neuer Schaden" : `wurden ${k.newDamageCount} neue Schäden`} festgestellt.` });
  }
  if (c.newDamages === true && k.newDamageCount === 0) {
    out.push({ code: "DAMAGE_KEYDROP_NOT_FOUND", kind: "DAMAGE", message: "Der Kunde hat neue Schäden angegeben; bei der Kontrolle wurde bisher kein neuer Schaden erfasst. Bitte die Angabe des Kunden prüfen." });
  }
  // Zeitplausibilität: Serverzeiten, die der Kunde nicht beeinflussen kann, gegen die angegebene Abgabe
  const gap = (later: Date | null, label: string, code: string) => {
    if (!c.dropOffAt || !later) return;
    const minutes = Math.round((later.getTime() - c.dropOffAt.getTime()) / 60_000);
    if (minutes > KEY_DROP_THRESHOLDS.timeGapMinutes) out.push({ code, kind: "TIME", message: `Angegebene Abgabe ${at(c.dropOffAt)}, ${label} ${at(later)} (${fmtMinutes(minutes)} später). Bitte die Abgabezeit prüfen; bei Bedarf das maßgebliche Mietende mit Begründung korrigieren.` });
  };
  gap(c.startedAt, "Rückgabelink erstmals geöffnet", "TIME_KEYDROP_LINK_LATE");
  gap(c.firstPhotoAt, "erstes Foto hochgeladen", "TIME_KEYDROP_PHOTO_LATE");
  gap(c.confirmedAt, "Meldung abgeschickt", "TIME_KEYDROP_CONFIRM_LATE");
  return out;
}

/** Maßgebliches Mietende einer kontaktlosen Rückgabe: Korrektur des Vermieters vor Kundenangabe. */
export function effectiveKeyDropEnd(h: { returnTimeOverrideAt: Date | null; customerDropOffAt: Date | null }): Date | null {
  return h.returnTimeOverrideAt ?? h.customerDropOffAt ?? null;
}

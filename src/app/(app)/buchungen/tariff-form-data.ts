// Befehl 29: Tarifauswahl und Abweichungen aus dem Buchungsformular lesen (serverseitig, ohne Vertrauen in den Browser).
// Werte in Euro werden exakt in Cent umgerechnet; Gründe sind Pflicht, sobald eine Abweichung gewählt ist (die Engine prüft erneut).

import { toCents } from "@/lib/money";
import type { TariffChoices } from "@/lib/tariffs";

export type TariffSelection =
  | { mode: "PLAN"; ratePlanId: string; seenRevisionId: string | null; seenRegularCents: number | null }
  /** bestehende Tarifbuchung: eingefrorenen Tarif behalten (nur Abweichungen ändern) */
  | { mode: "KEEP" }
  /** bestehende Buchung ohne Tarif (Altbestand): Preise unverändert lassen */
  | { mode: "LEGACY" };

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export function tariffSelectionFromForm(fd: FormData): TariffSelection | { error: string } {
  const v = str(fd, "ratePlanId");
  if (v === "KEEP") return { mode: "KEEP" };
  if (v === "LEGACY") return { mode: "LEGACY" };
  if (!v || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) return { error: "Bitte einen Miettarif wählen." };
  const seen = str(fd, "seenRegularCents");
  return { mode: "PLAN", ratePlanId: v, seenRevisionId: str(fd, "seenRevisionId") || null, seenRegularCents: /^\d{1,12}$/.test(seen) ? Number(seen) : null };
}

function euro(fd: FormData, k: string, label: string): number | { error: string } {
  const raw = str(fd, k);
  if (!raw) return { error: `${label}: bitte einen Betrag angeben (0,00 € ist zulässig).` };
  try {
    const c = toCents(raw);
    if (c < 0) return { error: `${label}: bitte einen Betrag ab 0,00 € angeben.` };
    return c;
  } catch {
    return { error: `${label}: kein gültiger Betrag.` };
  }
}

/** Abweichungen der Buchung: individueller Mietpreis, Kilometer, Kaution – jeweils „wie Tarif“ oder abweichend mit Grund. */
export function tariffChoicesFromForm(fd: FormData): TariffChoices | { error: string } {
  let price: TariffChoices["price"] = { mode: "TARIFF" };
  if (str(fd, "priceMode") === "INDIVIDUAL") {
    const c = euro(fd, "agreedPrice", "Vereinbarter Mietpreis");
    if (typeof c !== "number") return c;
    price = { mode: "INDIVIDUAL", cents: c, reason: str(fd, "priceReason") };
  }
  let km: TariffChoices["km"] = { mode: "TARIFF" };
  if (str(fd, "kmMode") === "INDIVIDUAL") {
    const reason = str(fd, "kmReason");
    if (str(fd, "kmPolicyOverride") === "UNLIMITED") km = { mode: "INDIVIDUAL", policy: "UNLIMITED", kmIncludedPerDay: null, extraKmRateCents: null, reason };
    else {
      const kmRaw = str(fd, "kmIncludedOverride").replace(/\./g, "");
      if (!/^\d{1,6}$/.test(kmRaw)) return { error: "Kilometervereinbarung: Freikilometer je Tag als ganze Zahl ab 0 angeben." };
      const rate = euro(fd, "extraKmRateOverride", "Mehrkilometerpreis");
      if (typeof rate !== "number") return rate;
      km = { mode: "INDIVIDUAL", policy: "FREE_KILOMETERS", kmIncludedPerDay: Number(kmRaw), extraKmRateCents: rate, reason };
    }
  }
  let deposit: TariffChoices["deposit"] = { mode: "TARIFF" };
  if (str(fd, "depositMode") === "INDIVIDUAL") {
    const c = euro(fd, "depositOverride", "Vereinbarte Kaution");
    if (typeof c !== "number") return c;
    deposit = { mode: "INDIVIDUAL", cents: c, reason: str(fd, "depositReason") };
  }
  return { price, km, deposit };
}

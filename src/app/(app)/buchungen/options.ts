import "server-only";
import { db } from "@/lib/db";
import { resolveDeposit } from "@/lib/business-rules";
import { defaultTariffsForVehicles } from "@/lib/tariffs";
import type { VehicleOption } from "./booking-form";

const eur = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/**
 * Auswahllisten für das Buchungsformular. Fahrzeuge sortiert nach Gruppe, dann Kennzeichen.
 * Kunden werden nicht mehr als Liste geladen (Befehl 20.7): die Auswahl läuft über die serverseitige Kundensuche.
 * Befehl 29: Die Buchung selbst rechnet über die Miettarife (Tarifauswahl in der Maske). Die Vorschlagswerte hier (Tagessatz,
 * Kaution, Kilometer) dienen dem Unfallersatz-Assistenten und kommen aus dem Standardtarif der Fahrzeuggruppe (mit Fahrzeugpreis);
 * nur ohne Standardtarif aus den Altfeldern des Fahrzeugs.
 */
export async function loadBookingOptions(tenantId: string): Promise<{ vehicles: VehicleOption[] }> {
  const [vehicles, tenant] = await Promise.all([
    db.vehicle.findMany({ where: { tenantId }, include: { group: true }, orderBy: [{ group: { sortOrder: "asc" } }, { plate: "asc" }] }),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessRules: true } }),
  ]);
  const tariffs = await defaultTariffsForVehicles(tenantId, vehicles);
  return {
    vehicles: vehicles.map((v) => {
      const t = tariffs.get(v.id) ?? null;
      const at = (d: number) => {
        const c = t?.tiers.find((x) => x.days === d)?.cents;
        return c == null ? null : (c / 100).toFixed(2);
      };
      const day = t?.tiers.find((x) => x.days === 1)?.cents ?? null;
      return {
        id: v.id,
        plate: v.plate,
        label: `${v.make} ${v.model}`,
        group: v.group?.name ?? "Ohne Gruppe",
        dailyRate: day != null ? eur(day) : v.dailyRate.toString().replace(".", ","),
        workWeekRate: t ? at(5) : v.workWeekRate?.toString() ?? null,
        weeklyRate: t ? at(7) : v.weeklyRate?.toString() ?? null,
        monthlyRate: t ? at(30) : v.monthlyRate?.toString() ?? null,
        // Vorschlag: Standardtarif, sonst Fahrzeug → Fahrzeuggruppe → Mandantenstandard (Geschäftsregeln)
        deposit: t ? eur(t.depositCents) : (resolveDeposit(tenant.businessRules, v.group, v).cents / 100).toFixed(2).replace(".", ","),
        kmIncludedPerDay: t ? String(t.km.policy === "UNLIMITED" ? 0 : t.km.kmIncludedPerDay ?? 0) : String(v.kmIncludedPerDay),
        extraKmRate: t ? eur(t.km.extraKmRateCents ?? 0) : v.extraKmRate.toString().replace(".", ","),
        status: v.status,
      };
    }),
  };
}

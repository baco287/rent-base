import "server-only";
import { db } from "@/lib/db";
import { resolveDeposit } from "@/lib/business-rules";
import type { VehicleOption } from "./booking-form";

/**
 * Auswahllisten für das Buchungsformular. Fahrzeuge sortiert nach Gruppe, dann Kennzeichen.
 * Kunden werden nicht mehr als Liste geladen (Befehl 20.7): die Auswahl läuft über die serverseitige Kundensuche.
 */
export async function loadBookingOptions(tenantId: string): Promise<{ vehicles: VehicleOption[] }> {
  const [vehicles, tenant] = await Promise.all([
    db.vehicle.findMany({ where: { tenantId }, include: { group: true }, orderBy: [{ group: { sortOrder: "asc" } }, { plate: "asc" }] }),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessRules: true } }),
  ]);
  return {
    vehicles: vehicles.map((v) => ({
      id: v.id,
      plate: v.plate,
      label: `${v.make} ${v.model}`,
      group: v.group?.name ?? "Ohne Gruppe",
      dailyRate: v.dailyRate.toString().replace(".", ","),
      workWeekRate: v.workWeekRate?.toString() ?? null,
      weeklyRate: v.weeklyRate?.toString() ?? null,
      monthlyRate: v.monthlyRate?.toString() ?? null,
      // Vorschlag: Fahrzeug → Fahrzeuggruppe → Mandantenstandard (Geschäftsregeln); im Formular änderbar
      deposit: (resolveDeposit(tenant.businessRules, v.group, v).cents / 100).toFixed(2).replace(".", ","),
      // Befehl 20.7: Kilometervereinbarung wird aus dem Fahrzeug vorgeschlagen und auf der Buchung festgehalten
      kmIncludedPerDay: String(v.kmIncludedPerDay),
      extraKmRate: v.extraKmRate.toString().replace(".", ","),
      status: v.status,
    })),
  };
}

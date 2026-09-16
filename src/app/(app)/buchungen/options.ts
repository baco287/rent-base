import "server-only";
import { db } from "@/lib/db";
import { customerName } from "@/lib/format";
import type { CustomerOption, VehicleOption } from "./booking-form";

/** Auswahllisten für das Buchungsformular. */
export async function loadBookingOptions(tenantId: string): Promise<{ vehicles: VehicleOption[]; customers: CustomerOption[] }> {
  const [vehicles, customers] = await Promise.all([
    db.vehicle.findMany({ where: { tenantId }, orderBy: [{ category: "asc" }, { plate: "asc" }] }),
    db.customer.findMany({ where: { tenantId }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] }),
  ]);
  return {
    vehicles: vehicles.map((v) => ({
      id: v.id,
      plate: v.plate,
      label: `${v.make} ${v.model}`,
      dailyRate: v.dailyRate.toString().replace(".", ","),
      deposit: v.deposit.toString().replace(".", ","),
      status: v.status,
    })),
    customers: customers.map((c) => ({
      id: c.id,
      label: c.type === "COMPANY" ? `${customerName(c)} (${c.firstName} ${c.lastName})` : `${c.lastName}, ${c.firstName}${c.city ? ` · ${c.city}` : ""}`,
      blocked: c.blocked,
      discountPercent: c.discountPercent,
    })),
  };
}

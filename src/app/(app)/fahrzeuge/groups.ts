import "server-only";
import { db } from "@/lib/db";
import type { GroupOption } from "./vehicle-form";

const dec = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? "" : v.toString().replace(".", ","));

/** Gruppen eines Mandanten als Auswahl für Formulare, Preise als Vorgabe. */
export async function loadGroupOptions(tenantId: string): Promise<GroupOption[]> {
  const groups = await db.vehicleGroup.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    dailyRate: dec(g.dailyRate),
    workWeekRate: dec(g.workWeekRate),
    weeklyRate: dec(g.weeklyRate),
    monthlyRate: dec(g.monthlyRate),
    kmIncludedPerDay: g.kmIncludedPerDay.toString(),
    extraKmRate: dec(g.extraKmRate),
    deposit: dec(g.deposit),
  }));
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { RuleError } from "@/lib/business-rules";
import { overridesFromForm } from "@/lib/business-rules-form";
import { FUELS, VEHICLE_STATUS } from "@/lib/constants";
import { normalizePlate } from "@/lib/format";

export type FormState = { error?: string } | undefined;

const num = (msg: string) =>
  z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }));
const optDate = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.date().optional());
const optInt = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().optional());
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const vehicleSchema = z.object({
  plate: z.string().trim().min(3, "Bitte das Kennzeichen eingeben.").transform(normalizePlate),
  make: z.string().trim().min(1, "Bitte die Marke eingeben."),
  model: z.string().trim().min(1, "Bitte das Modell eingeben."),
  groupId: z.string().min(1, "Bitte eine Fahrzeuggruppe wählen."),
  fuel: z.enum(Object.keys(FUELS) as [string, ...string[]]),
  status: z.enum(Object.keys(VEHICLE_STATUS) as [string, ...string[]]),
  year: optInt,
  vin: optStr,
  color: optStr,
  mileage: num("Kilometerstand muss eine Zahl sein.").pipe(z.number().int().min(0)),
  huDate: optDate,
  requiredLicenseClass: optStr,
  dailyRate: num("Tagespreis muss eine Zahl sein.").pipe(z.number().min(0)),
  workWeekRate: z.preprocess((v) => (v === "" ? undefined : v), num("Wochenpreis (5 Tage) muss eine Zahl sein.").optional()),
  weeklyRate: z.preprocess((v) => (v === "" ? undefined : v), num("Kalenderwochenpreis muss eine Zahl sein.").optional()),
  monthlyRate: z.preprocess((v) => (v === "" ? undefined : v), num("Monatspreis muss eine Zahl sein.").optional()),
  kmIncludedPerDay: num("Freikilometer müssen eine Zahl sein.").pipe(z.number().int().min(0)),
  extraKmRate: num("Mehrkilometer-Preis muss eine Zahl sein.").pipe(z.number().min(0)),
  deposit: num("Kaution muss eine Zahl sein.").pipe(z.number().min(0)),
  notes: optStr,
});

function toData(d: z.infer<typeof vehicleSchema>) {
  return {
    ...d,
    vin: d.vin ?? null,
    color: d.color ?? null,
    year: d.year ?? null,
    huDate: d.huDate ?? null,
    requiredLicenseClass: d.requiredLicenseClass ?? null,
    workWeekRate: d.workWeekRate ?? null,
    weeklyRate: d.weeklyRate ?? null,
    monthlyRate: d.monthlyRate ?? null,
    notes: d.notes ?? null,
  };
}

async function groupBelongsToTenant(groupId: string, tenantId: string) {
  return (await db.vehicleGroup.count({ where: { id: groupId, tenantId } })) === 1;
}

export async function createVehicleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO");
  const parsed = vehicleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!(await groupBelongsToTenant(parsed.data.groupId, tenant.id))) return { error: "Fahrzeuggruppe nicht gefunden." };

  let id: string;
  try {
    const v = await db.vehicle.create({ data: { tenantId: tenant.id, ...toData(parsed.data) } });
    id = v.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { error: `Das Kennzeichen ${parsed.data.plate} ist bereits angelegt.` };
    throw e;
  }
  revalidatePath("/fahrzeuge");
  redirect(`/fahrzeuge/${id}`);
}

export async function updateVehicleAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO");
  const parsed = vehicleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!(await groupBelongsToTenant(parsed.data.groupId, tenant.id))) return { error: "Fahrzeuggruppe nicht gefunden." };

  try {
    // tenantId in der where-Klausel: niemand kann fremde Fahrzeuge ändern.
    const r = await db.vehicle.updateMany({ where: { id, tenantId: tenant.id }, data: toData(parsed.data) });
    if (r.count === 0) return { error: "Fahrzeug nicht gefunden." };
    // HU/AU-Plan und HU-Datum am Fahrzeug bleiben synchron (der Plan ist die Fälligkeit, das Datum die Stammdatenansicht)
    await db.maintenancePlan.updateMany({ where: { tenantId: tenant.id, vehicleId: id, type: "HU_AU", isActive: true }, data: { nextDueDate: parsed.data.huDate ?? null } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { error: `Das Kennzeichen ${parsed.data.plate} ist bereits angelegt.` };
    throw e;
  }
  revalidatePath("/fahrzeuge");
  revalidatePath(`/fahrzeuge/${id}`);
  redirect(`/fahrzeuge/${id}?gespeichert=1`);
}

export type RulesFormState = { error?: string; ok?: string } | undefined;
/** Abweichende Geschäftsregeln des Fahrzeugs – nur der Inhaber; abgeschlossene Verträge bleiben unverändert. */
export async function updateVehicleRulesAction(id: string, _prev: RulesFormState, formData: FormData): Promise<RulesFormState> {
  const { tenant, user } = await requireRole("OWNER");
  let overrides: ReturnType<typeof overridesFromForm>;
  try {
    overrides = overridesFromForm(formData);
    const r = await db.$transaction(async (tx) => {
      const res = await tx.vehicle.updateMany({ where: { id, tenantId: tenant.id }, data: { businessRules: overrides === null ? Prisma.DbNull : overrides } });
      if (res.count) await recordAudit(tx, tenant.id, { id: user.id, name: user.name }, { action: "BUSINESS_RULES_UPDATED", details: { scope: "VEHICLE", vehicleId: id, overrides: JSON.stringify(overrides) } });
      return res;
    });
    if (r.count === 0) return { error: "Fahrzeug nicht gefunden." };
  } catch (e) {
    if (e instanceof RuleError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/fahrzeuge/${id}`);
  revalidatePath("/buchungen", "layout");
  return { ok: overrides ? "Abweichende Regeln gespeichert." : "Abweichungen entfernt – es gelten Gruppe und Standard des Vermieters." };
}

export async function deleteVehicleAction(id: string) {
  const { tenant } = await requireRole("OWNER");
  const bookings = await db.booking.count({ where: { vehicleId: id, tenantId: tenant.id } });
  if (bookings > 0) {
    // Mit Buchungshistorie nicht löschen, sondern inaktiv setzen.
    await db.vehicle.updateMany({ where: { id, tenantId: tenant.id }, data: { status: "INACTIVE" } });
  } else {
    await db.vehicle.deleteMany({ where: { id, tenantId: tenant.id } });
  }
  revalidatePath("/fahrzeuge");
  redirect("/fahrzeuge");
}

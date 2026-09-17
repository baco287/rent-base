"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";

export type FormState = { error?: string; ok?: string } | undefined;

const num = (msg: string) =>
  z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }).min(0));
const optNum = (msg: string) => z.preprocess((v) => (v === "" || v === undefined ? undefined : v), num(msg).optional());
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const groupSchema = z.object({
  name: z.string().trim().min(2, "Bitte den Namen der Gruppe eingeben."),
  description: optStr,
  sortOrder: z.preprocess((v) => (v === "" ? 0 : v), z.coerce.number().int().min(0).max(9999)),
  dailyRate: z.preprocess((v) => (v === "" ? 0 : v), num("Tagespreis muss eine Zahl sein.")),
  workWeekRate: optNum("Wochenpreis (5 Tage) muss eine Zahl sein."),
  weeklyRate: optNum("Kalenderwochenpreis muss eine Zahl sein."),
  monthlyRate: optNum("Monatspreis muss eine Zahl sein."),
  kmIncludedPerDay: z.preprocess((v) => (v === "" ? 200 : v), z.coerce.number().int().min(0)),
  extraKmRate: z.preprocess((v) => (v === "" ? 0.25 : v), num("Mehrkilometer-Preis muss eine Zahl sein.")),
  deposit: z.preprocess((v) => (v === "" ? 0 : v), num("Kaution muss eine Zahl sein.")),
});

function toData(d: z.infer<typeof groupSchema>) {
  return { ...d, description: d.description ?? null, workWeekRate: d.workWeekRate ?? null, weeklyRate: d.weeklyRate ?? null, monthlyRate: d.monthlyRate ?? null };
}

function revalidate() {
  revalidatePath("/fahrzeuge");
  revalidatePath("/fahrzeuge/gruppen");
  revalidatePath("/dispo");
}

export async function createGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO");
  const parsed = groupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    await db.vehicleGroup.create({ data: { tenantId: tenant.id, ...toData(parsed.data) } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { error: `Die Gruppe „${parsed.data.name}“ gibt es schon.` };
    throw e;
  }
  revalidate();
  return { ok: `Gruppe „${parsed.data.name}“ angelegt.` };
}

export async function updateGroupAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO");
  const parsed = groupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const r = await db.vehicleGroup.updateMany({ where: { id, tenantId: tenant.id }, data: toData(parsed.data) });
    if (r.count === 0) return { error: "Gruppe nicht gefunden." };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { error: `Die Gruppe „${parsed.data.name}“ gibt es schon.` };
    throw e;
  }
  revalidate();
  return { ok: "Gespeichert." };
}

export async function deleteGroupAction(id: string) {
  const { tenant } = await requireRole("OWNER");
  const count = await db.vehicle.count({ where: { groupId: id, tenantId: tenant.id } });
  if (count > 0) redirect("/fahrzeuge/gruppen?fehler=belegt");
  await db.vehicleGroup.deleteMany({ where: { id, tenantId: tenant.id } });
  revalidate();
  redirect("/fahrzeuge/gruppen");
}

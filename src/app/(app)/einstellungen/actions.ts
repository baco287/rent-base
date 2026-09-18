"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/constants";

export type FormState = { error?: string; ok?: string } | undefined;

const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const tenantSchema = z.object({
  name: z.string().trim().min(2, "Bitte den Firmennamen eingeben."),
  street: optStr,
  zip: optStr,
  city: optStr,
  phone: optStr,
  email: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().toLowerCase().email("Die E-Mail-Adresse ist ungültig.").optional()),
});

export async function updateTenantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("OWNER");
  const parsed = tenantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  await db.tenant.update({
    where: { id: tenant.id },
    data: { name: d.name, street: d.street ?? null, zip: d.zip ?? null, city: d.city ?? null, phone: d.phone ?? null, email: d.email ?? null },
  });
  revalidatePath("/", "layout");
  return { ok: "Firmendaten gespeichert." };
}

const termsSchema = z.object({
  rentalTermsVersion: optStr,
  rentalTermsText: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().max(60000, "Der Text ist zu lang.").optional()),
});

/** Mietbedingungen. Jeder neue Vertrag kopiert den dann gültigen Text; abgeschlossene Verträge ändern sich nicht. */
export async function updateTermsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("OWNER");
  const parsed = termsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  if (d.rentalTermsText && !d.rentalTermsVersion) return { error: "Bitte eine Fassung angeben, z. B. 2026-09." };
  await db.tenant.update({ where: { id: tenant.id }, data: { rentalTermsVersion: d.rentalTermsVersion ?? null, rentalTermsText: d.rentalTermsText ?? null } });
  revalidatePath("/einstellungen");
  return { ok: "Mietbedingungen gespeichert. Sie gelten für alle Verträge, die ab jetzt abgeschlossen werden." };
}

const userSchema = z.object({
  name: z.string().trim().min(2, "Bitte den Namen eingeben."),
  email: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse eingeben."),
  role: z.enum(Object.keys(ROLES) as [string, ...string[]]),
  password: z.string().min(10, "Das Passwort braucht mindestens 10 Zeichen."),
});

export async function createUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("OWNER");
  const parsed = userSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  try {
    await db.user.create({ data: { tenantId: tenant.id, name: d.name, email: d.email, role: d.role, passwordHash: await hashPassword(d.password) } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { error: "Diese E-Mail-Adresse wird bereits verwendet." };
    throw e;
  }
  revalidatePath("/einstellungen");
  return { ok: `${d.name} wurde angelegt.` };
}

export async function toggleUserActiveAction(userId: string) {
  const { tenant, user: me } = await requireRole("OWNER");
  if (userId === me.id) redirect("/einstellungen?fehler=selbst");
  const u = await db.user.findFirst({ where: { id: userId, tenantId: tenant.id } });
  if (!u) redirect("/einstellungen");
  await db.user.update({ where: { id: userId }, data: { active: !u.active } });
  if (u.active) await db.session.deleteMany({ where: { userId } });
  revalidatePath("/einstellungen");
  redirect("/einstellungen");
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { CUSTOMER_TYPES } from "@/lib/constants";

export type FormState = { error?: string } | undefined;

const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());
const optDate = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.date().optional());

const customerSchema = z
  .object({
    type: z.enum(Object.keys(CUSTOMER_TYPES) as [string, ...string[]]),
    companyName: optStr,
    firstName: z.string().trim().min(1, "Bitte den Vornamen eingeben."),
    lastName: z.string().trim().min(1, "Bitte den Nachnamen eingeben."),
    email: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().toLowerCase().email("Die E-Mail-Adresse ist ungültig.").optional()),
    phone: optStr,
    street: optStr,
    zip: optStr,
    city: optStr,
    birthDate: optDate,
    licenseNumber: optStr,
    licenseClass: optStr,
    licenseIssuedAt: optDate,
    licenseValidUntil: optDate,
    blocked: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
    blockReason: optStr,
    discountPercent: z.preprocess((v) => (v === "" ? 0 : v), z.coerce.number().int().min(0).max(100)),
    notes: optStr,
  })
  .refine((d) => d.type !== "COMPANY" || d.companyName, { message: "Bei Firmenkunden bitte den Firmennamen eingeben.", path: ["companyName"] });

function toData(d: z.infer<typeof customerSchema>) {
  return {
    type: d.type,
    companyName: d.type === "COMPANY" ? d.companyName ?? null : null,
    firstName: d.firstName,
    lastName: d.lastName,
    email: d.email ?? null,
    phone: d.phone ?? null,
    street: d.street ?? null,
    zip: d.zip ?? null,
    city: d.city ?? null,
    birthDate: d.birthDate ?? null,
    licenseNumber: d.licenseNumber ?? null,
    licenseClass: d.licenseClass ?? null,
    licenseIssuedAt: d.licenseIssuedAt ?? null,
    licenseValidUntil: d.licenseValidUntil ?? null,
    blocked: d.blocked,
    blockReason: d.blocked ? d.blockReason ?? null : null,
    discountPercent: d.discountPercent,
    notes: d.notes ?? null,
  };
}

export async function createCustomerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO", "YARD");
  const parsed = customerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const c = await db.customer.create({ data: { tenantId: tenant.id, ...toData(parsed.data) } });
  revalidatePath("/kunden");
  redirect(`/kunden/${c.id}`);
}

export async function updateCustomerAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO", "YARD");
  const parsed = customerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const r = await db.customer.updateMany({ where: { id, tenantId: tenant.id }, data: toData(parsed.data) });
  if (r.count === 0) return { error: "Kunde nicht gefunden." };
  revalidatePath("/kunden");
  revalidatePath(`/kunden/${id}`);
  redirect(`/kunden/${id}?gespeichert=1`);
}

export async function deleteCustomerAction(id: string) {
  const { tenant } = await requireRole("OWNER");
  const bookings = await db.booking.count({ where: { customerId: id, tenantId: tenant.id } });
  if (bookings > 0) redirect(`/kunden/${id}?fehler=buchungen`);
  await db.customer.deleteMany({ where: { id, tenantId: tenant.id } });
  revalidatePath("/kunden");
  redirect("/kunden");
}

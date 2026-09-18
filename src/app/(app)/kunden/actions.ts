"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { customerSchema, customerToData } from "@/lib/customer-schema";
import { nextCustomerNumber, withNumberRetry } from "@/lib/numbering";

export type FormState = { error?: string } | undefined;

export async function createCustomerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO", "YARD");
  const parsed = customerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const data = customerToData(parsed.data);
  const c = await withNumberRetry(() =>
    db.$transaction(async (tx) => tx.customer.create({ data: { tenantId: tenant.id, number: await nextCustomerNumber(tx, tenant.id), ...data } })),
  );
  revalidatePath("/kunden");
  redirect(`/kunden/${c.id}`);
}

export async function updateCustomerAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO", "YARD");
  const parsed = customerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const r = await db.customer.updateMany({ where: { id, tenantId: tenant.id }, data: customerToData(parsed.data) });
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

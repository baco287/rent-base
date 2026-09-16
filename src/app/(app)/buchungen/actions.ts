"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { findConflicts, nextBookingNumber } from "@/lib/bookings";
import { customerName, fmtDateTime } from "@/lib/format";

export type FormState = { error?: string } | undefined;

const num = z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number().min(0));
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const bookingSchema = z
  .object({
    vehicleId: z.string().min(1, "Bitte ein Fahrzeug wählen."),
    customerId: z.string().min(1, "Bitte einen Kunden wählen."),
    startAt: z.coerce.date({ message: "Bitte Abholung mit Datum und Uhrzeit angeben." }),
    endAt: z.coerce.date({ message: "Bitte Rückgabe mit Datum und Uhrzeit angeben." }),
    dailyRate: num,
    deposit: num,
    notes: optStr,
  })
  .refine((d) => d.endAt > d.startAt, { message: "Die Rückgabe muss nach der Abholung liegen.", path: ["endAt"] });

function revalidate(id?: string) {
  revalidatePath("/buchungen");
  revalidatePath("/dispo");
  revalidatePath("/heute");
  if (id) revalidatePath(`/buchungen/${id}`);
}

async function validateRefs(tenantId: string, vehicleId: string, customerId: string) {
  const [vehicle, customer] = await Promise.all([
    db.vehicle.findFirst({ where: { id: vehicleId, tenantId } }),
    db.customer.findFirst({ where: { id: customerId, tenantId } }),
  ]);
  if (!vehicle) return { error: "Fahrzeug nicht gefunden." };
  if (vehicle.status === "INACTIVE") return { error: "Das Fahrzeug ist inaktiv." };
  if (!customer) return { error: "Kunde nicht gefunden." };
  if (customer.blocked) return { error: `${customerName(customer)} ist gesperrt${customer.blockReason ? `: ${customer.blockReason}` : "."}` };
  return { vehicle, customer };
}

export async function createBookingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO");
  const parsed = bookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const refs = await validateRefs(tenant.id, d.vehicleId, d.customerId);
  if ("error" in refs) return refs;

  let id = "";
  const result = await db.$transaction(async (tx) => {
    const conflicts = await findConflicts(tx, tenant.id, d.vehicleId, d.startAt, d.endAt);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      return { error: `Doppelbelegung: ${refs.vehicle.plate} ist von ${fmtDateTime(c.startAt)} bis ${fmtDateTime(c.endAt)} an ${customerName(c.customer)} vergeben (Nr. ${c.number}).` };
    }
    const number = await nextBookingNumber(tx, tenant.id, d.startAt);
    const b = await tx.booking.create({
      data: { tenantId: tenant.id, number, vehicleId: d.vehicleId, customerId: d.customerId, startAt: d.startAt, endAt: d.endAt, dailyRate: d.dailyRate, deposit: d.deposit, notes: d.notes ?? null },
    });
    id = b.id;
    return undefined;
  });
  if (result?.error) return result;

  revalidate(id);
  redirect(`/buchungen/${id}`);
}

export async function updateBookingAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO");
  const parsed = bookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const existing = await db.booking.findFirst({ where: { id, tenantId: tenant.id } });
  if (!existing) return { error: "Buchung nicht gefunden." };
  if (existing.status === "RETURNED" || existing.status === "CANCELLED") return { error: "Abgeschlossene oder stornierte Buchungen können nicht mehr geändert werden." };

  const refs = await validateRefs(tenant.id, d.vehicleId, d.customerId);
  if ("error" in refs) return refs;

  const result = await db.$transaction(async (tx) => {
    const conflicts = await findConflicts(tx, tenant.id, d.vehicleId, d.startAt, d.endAt, id);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      return { error: `Doppelbelegung: ${refs.vehicle.plate} ist von ${fmtDateTime(c.startAt)} bis ${fmtDateTime(c.endAt)} an ${customerName(c.customer)} vergeben (Nr. ${c.number}).` };
    }
    await tx.booking.update({
      where: { id },
      data: { vehicleId: d.vehicleId, customerId: d.customerId, startAt: d.startAt, endAt: d.endAt, dailyRate: d.dailyRate, deposit: d.deposit, notes: d.notes ?? null },
    });
    return undefined;
  });
  if (result?.error) return result;

  revalidate(id);
  redirect(`/buchungen/${id}?gespeichert=1`);
}

/** Statuswechsel: Reserviert -> Unterwegs -> Zurückgegeben, oder Storno. Übergabe-/Rücknahmeprotokoll kommt in Etappe 2. */
export async function setBookingStatusAction(id: string, status: "ACTIVE" | "RETURNED" | "CANCELLED") {
  const { tenant } = await requireRole("DISPO", "YARD");
  const b = await db.booking.findFirst({ where: { id, tenantId: tenant.id } });
  if (!b) redirect("/buchungen");

  const allowed: Record<string, string[]> = { RESERVED: ["ACTIVE", "CANCELLED"], ACTIVE: ["RETURNED"], RETURNED: [], CANCELLED: [] };
  if (!allowed[b.status]?.includes(status)) redirect(`/buchungen/${id}?fehler=status`);

  await db.booking.update({ where: { id }, data: { status } });
  revalidate(id);
  redirect(`/buchungen/${id}`);
}

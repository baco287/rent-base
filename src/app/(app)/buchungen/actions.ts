"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { assertVehicleBookable, nextBookingNumber, vehicleStatusProblem } from "@/lib/bookings";
import { customerName, fmtDateTime } from "@/lib/format";
import { customerFieldsFromForm, customerSchema, customerToData } from "@/lib/customer-schema";
import { nextCustomerNumber, withNumberRetry } from "@/lib/numbering";
import { changeBookingStatus } from "@/lib/booking-status";
import { DomainError } from "@/lib/integrity";
import { getStorage } from "@/lib/storage";
import { parseLocalDateTime } from "@/lib/time";
import { PAYMENT_METHODS, RENTAL_PAYMENT_INTENTS, type RentalPaymentIntent } from "@/lib/constants";
import { insertRentalPayment, parseRentalAmount, type RentalPaymentInput } from "@/lib/rental-payments";

export type FormState = { error?: string } | undefined;

/**
 * Bereich „Zahlung“ der neuen Buchung. „Offen“ = keine Zahlung; sonst genau eine Zahlungsbewegung.
 * Der Status der Buchung wird danach aus den Zahlungen berechnet, nicht aus dieser Auswahl gespeichert.
 */
function initialPaymentFromForm(formData: FormData): { intent: RentalPaymentIntent; input: RentalPaymentInput | null } | { error: string } {
  const raw = String(formData.get("payIntent") ?? "NONE");
  if (!(raw in RENTAL_PAYMENT_INTENTS)) return { error: "Bitte einen Zahlungsstatus wählen." };
  const intent = raw as RentalPaymentIntent;
  if (intent === "NONE") return { intent, input: null };
  const amount = String(formData.get("payAmount") ?? "").trim();
  if (!amount) return { error: "Zahlung: Bitte den tatsächlich gezahlten Betrag eingeben." };
  try {
    parseRentalAmount(amount);
  } catch (e) {
    return { error: `Zahlung: ${e instanceof DomainError ? e.message : "Ungültiger Betrag."}` };
  }
  const method = String(formData.get("payMethod") ?? "");
  if (!(method in PAYMENT_METHODS)) return { error: "Zahlung: Bitte eine Zahlungsart wählen." };
  const paidAt = parseLocalDateTime(String(formData.get("payPaidAt") ?? ""));
  if (!paidAt) return { error: "Zahlung: Bitte ein gültiges Zahlungsdatum angeben." };
  const nonce = String(formData.get("payNonce") ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return { error: "Die Seite ist veraltet. Bitte neu laden." };
  const text = (k: string, max: number) => String(formData.get(k) ?? "").trim().slice(0, max) || null;
  return { intent, input: { amount, method, paidAt, reference: text("payReference", 120), note: text("payNote", 500), idempotencyKey: nonce } };
}

const num = z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number().min(0));
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const bookingSchema = z
  .object({
    vehicleId: z.string().min(1, "Bitte ein Fahrzeug wählen."),
    customerId: z.string().optional(),
    startAt: z.preprocess(parseLocalDateTime, z.date({ message: "Bitte Abholung mit Datum und Uhrzeit angeben." })),
    endAt: z.preprocess(parseLocalDateTime, z.date({ message: "Bitte Rückgabe mit Datum und Uhrzeit angeben." })),
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

async function validateRefs(tenantId: string, vehicleId: string, customerId: string | undefined) {
  const [vehicle, customer] = await Promise.all([
    db.vehicle.findFirst({ where: { id: vehicleId, tenantId } }),
    customerId ? db.customer.findFirst({ where: { id: customerId, tenantId } }) : Promise.resolve(null),
  ]);
  if (!vehicle) return { error: "Fahrzeug nicht gefunden." };
  const statusProblem = vehicleStatusProblem(vehicle.status);
  if (statusProblem) return { error: statusProblem };
  if (!customerId) return { vehicle, customer: null }; // neuer Kunde wird mit der Buchung angelegt
  if (!customer) return { error: "Kunde nicht gefunden." };
  if (customer.blocked) return { error: `${customerName(customer)} ist gesperrt${customer.blockReason ? `: ${customer.blockReason}` : "."}` };
  return { vehicle, customer };
}

export async function createBookingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = bookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  const pay = initialPaymentFromForm(formData);
  if ("error" in pay) return pay;

  // Kunde direkt in der Buchung anlegen: Kundendaten kommen mit Präfix "c_"
  const newCustomer = formData.get("customerMode") === "new";
  let customerData: ReturnType<typeof customerToData> | null = null;
  if (newCustomer) {
    const c = customerSchema.safeParse(customerFieldsFromForm(formData, "c_"));
    if (!c.success) return { error: `Neuer Kunde: ${c.error.issues[0].message}` };
    customerData = customerToData(c.data);
  } else if (!d.customerId) {
    return { error: "Bitte einen Kunden wählen oder einen neuen Kunden anlegen." };
  }

  const refs = await validateRefs(tenant.id, d.vehicleId, newCustomer ? undefined : d.customerId);
  if ("error" in refs) return refs;

  let id = "";
  const result = await withNumberRetry(() => db.$transaction(async (tx) => {
    const { conflicts } = await assertVehicleBookable(tx, tenant.id, d.vehicleId, d.startAt, d.endAt);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      return { error: `Doppelbelegung: ${refs.vehicle.plate} ist von ${fmtDateTime(c.startAt)} bis ${fmtDateTime(c.endAt)} an ${customerName(c.customer)} vergeben (Nr. ${c.number}).` };
    }
    // Erst nach bestandener Konfliktprüfung den Kunden anlegen, damit bei Ablehnung kein Kunde übrig bleibt.
    const customerId = customerData ? (await tx.customer.create({ data: { tenantId: tenant.id, number: await nextCustomerNumber(tx, tenant.id), ...customerData } })).id : d.customerId!;
    const number = await nextBookingNumber(tx, tenant.id, d.startAt);
    const b = await tx.booking.create({
      data: {
        tenantId: tenant.id, number, vehicleId: d.vehicleId, customerId, startAt: d.startAt, endAt: d.endAt, dailyRate: d.dailyRate, deposit: d.deposit, notes: d.notes ?? null,
        // Preisstufen des Fahrzeugs zum Buchungszeitpunkt festhalten
        workWeekRate: refs.vehicle.workWeekRate, weeklyRate: refs.vehicle.weeklyRate, monthlyRate: refs.vehicle.monthlyRate,
      },
    });
    id = b.id;
    // Erste Mietzahlung in derselben Transaktion: wird sie abgelehnt (z. B. Überzahlung), entsteht auch keine Buchung
    if (pay.input) await insertRentalPayment(tx, tenant.id, { id: user.id, name: user.name }, b.id, pay.input, { expectFull: pay.intent === "FULL" });
    return undefined;
  })).catch((e) => (e instanceof DomainError ? { error: e.message } : Promise.reject(e)));
  if (result?.error) return result;

  revalidate(id);
  if (newCustomer) revalidatePath("/kunden");
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
  if (!d.customerId) return { error: "Bitte einen Kunden wählen." };
  const contract = await db.rentalContract.findFirst({ where: { bookingId: id, tenantId: tenant.id }, select: { number: true, status: true } });
  if (contract && contract.status === "SIGNED") return { error: `Zu dieser Buchung gibt es den unterschriebenen Vertrag ${contract.number}. Zeitraum, Fahrzeug und Preis sind damit festgeschrieben.` };

  const refs = await validateRefs(tenant.id, d.vehicleId, d.customerId);
  if ("error" in refs) return refs;

  const result = await db.$transaction(async (tx) => {
    const { conflicts } = await assertVehicleBookable(tx, tenant.id, d.vehicleId, d.startAt, d.endAt, id);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      return { error: `Doppelbelegung: ${refs.vehicle.plate} ist von ${fmtDateTime(c.startAt)} bis ${fmtDateTime(c.endAt)} an ${customerName(c.customer)} vergeben (Nr. ${c.number}).` };
    }
    await tx.booking.update({
      where: { id },
      data: {
        vehicleId: d.vehicleId, customerId: d.customerId!, startAt: d.startAt, endAt: d.endAt, dailyRate: d.dailyRate, deposit: d.deposit, notes: d.notes ?? null,
        // Nur bei Fahrzeugwechsel die Stufen des neuen Fahrzeugs übernehmen, sonst bleibt der Snapshot der Buchung
        ...(existing.vehicleId !== d.vehicleId ? { workWeekRate: refs.vehicle.workWeekRate, weeklyRate: refs.vehicle.weeklyRate, monthlyRate: refs.vehicle.monthlyRate } : {}),
      },
    });
    return undefined;
  }).catch((e) => (e instanceof DomainError ? { error: e.message } : Promise.reject(e)));
  if (result?.error) return result;

  revalidate(id);
  redirect(`/buchungen/${id}?gespeichert=1`);
}

/**
 * Statuswechsel per Knopf. Die Regeln stehen in lib/booking-status.ts:
 * "Unterwegs" ist hier nicht mehr möglich, das entsteht nur durch Mietvertrag und Übergabeprotokoll.
 */
export async function setBookingStatusAction(id: string, status: "ACTIVE" | "RETURNED" | "CANCELLED") {
  // Storno und Altfall-Rücknahme sind Dispositionsentscheidungen
  const { tenant } = await requireRole("DISPO");
  try {
    const { orphanedStorageKeys } = await changeBookingStatus(tenant.id, id, status);
    // Fotos verworfener Entwürfe aufräumen; ein Fehler hier darf den Statuswechsel nicht rückgängig machen
    await Promise.all(orphanedStorageKeys.map((k) => Promise.resolve().then(() => getStorage().remove(k)).catch(() => {})));
  } catch (e) {
    if (e instanceof DomainError) redirect(`/buchungen/${id}?hinweis=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidate(id);
  redirect(`/buchungen/${id}`);
}

"use server";

// Befehl 23.1: freie Rechnung anlegen. Nur Disposition und Inhaber (requireRole blockiert Hof und Supportmodus); Kunde und
// Buchung werden serverseitig gegen den Mandanten geprüft. Ergebnis ist ein normaler Rechnungsentwurf (kind GENERAL).

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { BOOKING_STATUS } from "@/lib/constants";
import { fmtDate } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { createGeneralInvoiceDraft } from "@/lib/invoices";

export type FreeInvoiceState = { error?: string } | undefined;
export type CustomerBookingOption = { id: string; number: string; label: string };

/** Buchungen eines Kunden für den optionalen Buchungsbezug (nur eigener Mandant, neueste zuerst). */
export async function customerBookingsAction(customerId: string): Promise<CustomerBookingOption[] | { error: string }> {
  const { tenant } = await requireRole("DISPO");
  if (typeof customerId !== "string" || customerId.length > 64) return { error: "Unbekannter Kunde." };
  const rows = await db.booking.findMany({ where: { tenantId: tenant.id, customerId }, orderBy: { startAt: "desc" }, take: 50, select: { id: true, number: true, startAt: true, endAt: true, status: true, vehicle: { select: { plate: true } } } });
  return rows.map((b) => ({ id: b.id, number: b.number, label: `${b.number} · ${fmtDate(b.startAt)}–${fmtDate(b.endAt)} · ${b.vehicle.plate} · ${BOOKING_STATUS[b.status as keyof typeof BOOKING_STATUS] ?? b.status}` }));
}

const schema = z.object({
  customerId: z.string().min(1, "Bitte einen Rechnungsempfänger (Kunden) wählen.").max(64),
  bookingId: z.string().max(64).optional(),
  nonce: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Die Seite ist veraltet. Bitte neu laden."),
});

export async function createFreeInvoiceAction(_prev: FreeInvoiceState, fd: FormData): Promise<FreeInvoiceState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = schema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  let id: string;
  try {
    const res = await createGeneralInvoiceDraft(tenant.id, { id: user.id, name: user.name }, { customerId: parsed.data.customerId, bookingId: parsed.data.bookingId || null, nonce: parsed.data.nonce });
    id = res.invoice.id;
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidatePath("/rechnungen");
  redirect(`/rechnungen/${id}`);
}

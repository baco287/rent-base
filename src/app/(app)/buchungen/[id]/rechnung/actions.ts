"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { INVOICE_UNITS } from "@/lib/constants";
import { discardInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, updateInvoiceDraft } from "@/lib/invoices";
import { runInvoiceFollowUp } from "@/lib/followup";

export type InvoiceState = { error?: string; ok?: string } | undefined;

const base = (bookingId: string) => `/buchungen/${bookingId}/rechnung`;
const refresh = (bookingId: string) => { for (const p of [base(bookingId), `/buchungen/${bookingId}`, "/buchungen"]) revalidatePath(p); };

/** Rechnungen erstellen, bearbeiten und abschließen: nur Inhaber und Disponent. */
async function context(bookingId: string) {
  const { tenant, user } = await requireRole("DISPO");
  const invoice = await db.invoice.findFirst({ where: { bookingId, tenantId: tenant.id, status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "desc" } });
  if (!invoice) redirect(base(bookingId));
  return { tenant, user, invoice, actor: { id: user.id, name: user.name } };
}

function asState(e: unknown): InvoiceState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Die Rechnung ist abgeschlossen und kann nicht mehr geändert werden." };
  throw e;
}

export async function createInvoiceAction(bookingId: string) {
  const { tenant, user } = await requireRole("DISPO");
  try {
    await ensureInvoiceDraft(tenant.id, bookingId, { id: user.id, name: user.name });
  } catch (e) {
    if (e instanceof DomainError) redirect(`/buchungen/${bookingId}?hinweis=${encodeURIComponent(e.message)}`);
    throw e;
  }
  refresh(bookingId);
  redirect(base(bookingId));
}

const itemSchema = z.object({
  id: z.string().optional(),
  description: z.string().trim().min(2, "Bitte jede Position beschreiben.").max(500),
  quantity: z.string().trim().min(1, "Bitte eine Menge angeben."),
  unit: z.enum(INVOICE_UNITS),
  unitPrice: z.string().trim().min(1, "Bitte einen Einzelpreis angeben."),
  taxRate: z.string().trim().min(1, "Bitte einen Steuersatz wählen."),
});
const draftSchema = z.object({
  items: z.array(itemSchema).min(1, "Eine Rechnung braucht mindestens eine Position."),
  customerNote: z.string().trim().max(2000).optional(),
  taxNote: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(2000).optional(),
  paymentTermDays: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(0).max(365).nullable()),
});

/** Entwurf speichern. Beträge rechnet ausschließlich der Server (Cent-Arithmetik in lib/money.ts). */
export async function saveInvoiceDraftAction(bookingId: string, payload: unknown): Promise<InvoiceState> {
  const { tenant, invoice, actor } = await context(bookingId);
  const parsed = draftSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    await updateInvoiceDraft(tenant.id, invoice.id, actor, parsed.data);
  } catch (e) {
    return asState(e);
  }
  refresh(bookingId);
  return { ok: "Entwurf gespeichert." };
}

export async function discardInvoiceDraftAction(bookingId: string) {
  const { tenant, invoice } = await context(bookingId);
  try {
    await discardInvoiceDraft(tenant.id, invoice.id);
  } catch (e) {
    if (e instanceof DomainError || isImmutableError(e)) redirect(`${base(bookingId)}?hinweis=${encodeURIComponent(e instanceof DomainError ? e.message : "Die Rechnung ist abgeschlossen.")}`);
    throw e;
  }
  refresh(bookingId);
  redirect(`/buchungen/${bookingId}`);
}

/** Abschluss: Server prüft alles erneut, vergibt die Nummer und versiegelt. Danach PDF und E-Mail als Nachbearbeitung, die nie werfen. */
export async function finalizeInvoiceAction(bookingId: string, _prev: InvoiceState, _formData: FormData): Promise<InvoiceState> {
  void _formData;
  const { tenant, invoice, actor } = await context(bookingId);
  try {
    await finalizeInvoice(tenant.id, invoice.id, actor);
  } catch (e) {
    return asState(e);
  }
  await runInvoiceFollowUp(tenant.id, invoice.id, actor.id);
  refresh(bookingId);
  redirect(`${base(bookingId)}?abgeschlossen=1`);
}

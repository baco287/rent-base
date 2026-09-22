"use server";

// Rechnungen erstellen, bearbeiten (neue Fassung), abschließen, als übergeben markieren: nur Inhaber und Disponent.
// Hofmitarbeiter sehen und laden nur; das erzwingt requireRole in jeder Aktion.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { INVOICE_UNITS } from "@/lib/constants";
import { discardInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, markVersionDelivered, startInvoiceEdit, updateInvoiceDraft } from "@/lib/invoices";
import { runInvoiceFollowUp } from "@/lib/followup";
import { parseLocalDateTime } from "@/lib/time";

export type InvoiceState = { error?: string; ok?: string } | undefined;

// Eine Buchung kann mehrere Rechnungen haben: die Mietrechnung (Standard, ohne nr) und Schadenabrechnungen (nr = Rechnungs-Id).
const base = (bookingId: string, invoiceId?: string | null) => `/buchungen/${bookingId}/rechnung${invoiceId ? `?nr=${invoiceId}` : ""}`;
const withParam = (url: string, key: string, value: string) => `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
const refresh = (bookingId: string) => { for (const p of [`/buchungen/${bookingId}/rechnung`, `/buchungen/${bookingId}`, "/buchungen", "/rechnungen", "/heute", "/schaeden"]) revalidatePath(p); };

async function context(bookingId: string, invoiceId: string | null) {
  const { tenant, user } = await requireRole("DISPO");
  const invoice = invoiceId
    ? await db.invoice.findFirst({ where: { id: invoiceId, bookingId, tenantId: tenant.id, status: { in: ["DRAFT", "FINALIZED"] } } })
    : await db.invoice.findFirst({ where: { bookingId, tenantId: tenant.id, kind: "RENTAL", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "desc" } });
  if (!invoice) redirect(base(bookingId));
  const key = invoice.kind === "DAMAGE" ? invoice.id : null;
  const caseId = invoice.damageCaseId;
  return { tenant, user, invoice, key, caseId, actor: { id: user.id, name: user.name } };
}

function asState(e: unknown): InvoiceState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Diese Fassung ist abgeschlossen und kann nicht mehr geändert werden." };
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

/** „Rechnung bearbeiten“: Entwurf der nächsten Fassung aus der aktuellen Fassung; der Server bestimmt den Modus. */
export async function startInvoiceEditAction(bookingId: string, invoiceId: string | null) {
  const { tenant, invoice, key, actor } = await context(bookingId, invoiceId);
  try {
    await startInvoiceEdit(tenant.id, invoice.id, actor);
  } catch (e) {
    if (e instanceof DomainError) redirect(withParam(base(bookingId, key), "hinweis", e.message));
    throw e;
  }
  refresh(bookingId);
  redirect(base(bookingId, key));
}

const itemSchema = z.object({
  id: z.string().optional(),
  description: z.string().trim().min(2, "Bitte jede Position beschreiben.").max(500),
  quantity: z.string().trim().min(1, "Bitte eine Menge angeben."),
  unit: z.enum(INVOICE_UNITS),
  unitPrice: z.string().trim().min(1, "Bitte einen Einzelpreis angeben."),
  taxRate: z.string().trim().min(1, "Bitte einen Steuersatz wählen."),
});
const text = (max: number) => z.string().trim().max(max).optional();
const customerSchema = z.object({ type: z.enum(["PRIVATE", "COMPANY"]), number: text(40), companyName: text(200), firstName: text(100), lastName: text(100), street: text(200), zip: text(20), city: text(100), country: z.string().trim().max(2).optional(), email: text(320) }).partial();
const companySchema = z.object({ name: text(200), legalForm: text(60), street: text(200), zip: text(20), city: text(100), country: z.string().trim().max(2).optional(), email: text(320), phone: text(60), vatId: text(30), taxNumber: text(30), bankName: text(100), iban: text(40), bic: text(20), invoiceFooter: text(1000) }).partial();
const draftSchema = z.object({
  items: z.array(itemSchema).min(1, "Eine Rechnung braucht mindestens eine Position."),
  customerNote: text(2000),
  taxNote: text(1000),
  notes: text(2000),
  reason: text(500),
  paymentTermDays: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(0).max(365).nullable()),
  servicePeriodStart: z.string().optional(),
  servicePeriodEnd: z.string().optional(),
  customer: customerSchema.optional(),
  company: companySchema.optional(),
});

/** Entwurf speichern. Beträge rechnet ausschließlich der Server (Cent-Arithmetik in lib/money.ts). */
export async function saveInvoiceDraftAction(bookingId: string, invoiceId: string | null, payload: unknown): Promise<InvoiceState> {
  const { tenant, invoice, actor } = await context(bookingId, invoiceId);
  const parsed = draftSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  const start = d.servicePeriodStart ? parseLocalDateTime(d.servicePeriodStart) : null;
  const end = d.servicePeriodEnd ? parseLocalDateTime(d.servicePeriodEnd) : null;
  if ((d.servicePeriodStart && !start) || (d.servicePeriodEnd && !end)) return { error: "Bitte einen gültigen Leistungszeitraum angeben." };
  try {
    await updateInvoiceDraft(tenant.id, invoice.id, actor, { ...d, servicePeriodStart: start, servicePeriodEnd: end });
  } catch (e) {
    return asState(e);
  }
  refresh(bookingId);
  return { ok: "Entwurf gespeichert." };
}

export async function discardInvoiceDraftAction(bookingId: string, invoiceId: string | null) {
  const { tenant, invoice, key, caseId, actor } = await context(bookingId, invoiceId);
  let deleted = false;
  try {
    deleted = (await discardInvoiceDraft(tenant.id, invoice.id, actor)).invoiceDeleted;
  } catch (e) {
    if (e instanceof DomainError || isImmutableError(e)) redirect(withParam(base(bookingId, key), "hinweis", e instanceof DomainError ? e.message : "Die Fassung ist abgeschlossen."));
    throw e;
  }
  refresh(bookingId);
  if (caseId) revalidatePath(`/schaeden/${caseId}`);
  // Schadenabrechnung gelöscht: zurück zur Schadenakte, Mietrechnung gelöscht: zurück zur Buchung
  redirect(deleted ? (caseId ? `/schaeden/${caseId}` : `/buchungen/${bookingId}`) : base(bookingId, key));
}

/** Abschluss: Server prüft alles erneut, vergibt bei Fassung 1 die Nummer, versiegelt die Fassung. Danach PDF und E-Mail als Nachbearbeitung, die nie werfen. */
export async function finalizeInvoiceAction(bookingId: string, invoiceId: string | null, _prev: InvoiceState, formData: FormData): Promise<InvoiceState> {
  const { tenant, invoice, key, caseId, actor } = await context(bookingId, invoiceId);
  let version;
  try {
    version = await finalizeInvoice(tenant.id, invoice.id, actor, { confirmOverpayment: formData.get("confirmOverpayment") === "1" });
  } catch (e) {
    return asState(e);
  }
  await runInvoiceFollowUp(tenant.id, version.id, actor.id);
  refresh(bookingId);
  if (caseId) revalidatePath(`/schaeden/${caseId}`);
  redirect(withParam(base(bookingId, key), "abgeschlossen", String(version.versionNo)));
}

const deliveredSchema = z.object({ versionId: z.string().min(1), note: text(300) });

/** „Als an Kunden übergeben markieren“: hängt an der konkreten Fassung, einmalig, nie still entfernbar. */
export async function markDeliveredAction(bookingId: string, invoiceId: string | null, _prev: InvoiceState, formData: FormData): Promise<InvoiceState> {
  const { tenant, actor } = await context(bookingId, invoiceId);
  const parsed = deliveredSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const v = await markVersionDelivered(tenant.id, parsed.data.versionId, actor, parsed.data.note);
    refresh(bookingId);
    return { ok: `Fassung ${v.versionNo} ist als an den Kunden übergeben markiert.` };
  } catch (e) {
    return asState(e);
  }
}

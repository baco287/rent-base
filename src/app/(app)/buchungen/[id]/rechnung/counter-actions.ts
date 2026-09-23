"use server";

// Gutschriften und Stornobelege: anlegen, Entwurf speichern, abschließen, verwerfen – nur Inhaber und Disponent.
// Hofmitarbeiter sehen abgeschlossene Belege und laden PDFs; jede Aktion erzwingt requireRole("DISPO").
// Nichts hier erstattet, verrechnet oder zahlt aus: Es entsteht ausschließlich ein Beleg.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { INVOICE_UNITS } from "@/lib/constants";
import { createCancellationDraft, createCreditNoteDraft, discardCounterDocumentDraft, finalizeCounterDocument, updateCounterDocumentDraft, type CreditItemInput } from "@/lib/counter-documents";
import { domainFromDb } from "@/lib/db-errors";
import { runInvoiceFollowUp } from "@/lib/followup";

export type CounterState = { error?: string; ok?: string } | undefined;

const href = (bookingId: string, invoiceId: string) => `/buchungen/${bookingId}/rechnung?nr=${invoiceId}`;
const withParam = (url: string, key: string, value: string) => `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
const refresh = (bookingId: string) => { for (const p of [`/buchungen/${bookingId}/rechnung`, `/buchungen/${bookingId}`, "/buchungen", "/rechnungen", "/heute", "/schaeden"]) revalidatePath(p); };

async function context(bookingId: string, invoiceId: string) {
  const { tenant, user } = await requireRole("DISPO");
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, bookingId, tenantId: tenant.id, status: { in: ["DRAFT", "FINALIZED"] } } });
  if (!invoice) redirect(`/buchungen/${bookingId}/rechnung`);
  return { tenant, user, invoice, actor: { id: user.id, name: user.name } };
}

function asState(e: unknown): CounterState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Dieser Beleg ist abgeschlossen und kann nicht mehr geändert werden." };
  try { domainFromDb(e); } catch (d) { if (d instanceof DomainError) return { error: d.message }; }
  throw e;
}

/** „Gutschrift erstellen“ zur abgeschlossenen Rechnung: Entwurf mit allen offenen Positionen als Vorschlag. */
export async function createCreditNoteAction(bookingId: string, invoiceId: string) {
  const { tenant, invoice, actor } = await context(bookingId, invoiceId);
  let created;
  try {
    created = await createCreditNoteDraft(tenant.id, invoice.id, actor);
  } catch (e) {
    const s = asState(e);
    redirect(withParam(href(bookingId, invoice.id), "hinweis", s?.error ?? "Die Gutschrift konnte nicht angelegt werden."));
  }
  refresh(bookingId);
  redirect(href(bookingId, created.id));
}

/** „Rechnung stornieren“: Entwurf des Stornobelegs über den verbleibenden Betrag; Abschluss erst nach Grund und Bestätigung. */
export async function createCancellationAction(bookingId: string, invoiceId: string) {
  const { tenant, invoice, actor } = await context(bookingId, invoiceId);
  let created;
  try {
    created = await createCancellationDraft(tenant.id, invoice.id, actor);
  } catch (e) {
    const s = asState(e);
    redirect(withParam(href(bookingId, invoice.id), "hinweis", s?.error ?? "Der Stornobeleg konnte nicht angelegt werden."));
  }
  refresh(bookingId);
  redirect(href(bookingId, created.id));
}

const itemSchema = z.union([
  z.object({ sourceItemId: z.string().min(1), mode: z.literal("REMAINING") }),
  z.object({ sourceItemId: z.string().min(1), mode: z.literal("QUANTITY"), quantity: z.string().trim().min(1, "Bitte eine Menge angeben.") }),
  z.object({ sourceItemId: z.string().min(1), mode: z.literal("AMOUNT"), grossAmount: z.string().trim().min(1, "Bitte einen Betrag angeben.") }),
  z.object({ manual: z.literal(true), description: z.string().trim().min(2, "Bitte jede manuelle Position beschreiben.").max(500), quantity: z.string().trim().min(1), unit: z.enum(INVOICE_UNITS), unitPrice: z.string().trim().min(1, "Bitte einen Betrag angeben."), taxRate: z.string().trim().min(1, "Bitte einen Steuersatz wählen."), reason: z.string().trim().min(3, "Bitte den Grund der manuellen Position angeben.").max(300) }),
]);
const draftSchema = z.object({ items: z.array(itemSchema).min(1, "Eine Gutschrift braucht mindestens eine Position.").optional(), reason: z.string().trim().max(500).optional(), customerNote: z.string().trim().max(2000).optional(), notes: z.string().trim().max(2000).optional() });

/** Entwurf speichern. Beträge rechnet ausschließlich der Server gegen die Restbeträge der Rechnung. */
export async function saveCounterDraftAction(bookingId: string, invoiceId: string, payload: unknown): Promise<CounterState> {
  const { tenant, invoice, actor } = await context(bookingId, invoiceId);
  const parsed = draftSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    await updateCounterDocumentDraft(tenant.id, invoice.id, actor, { ...parsed.data, items: parsed.data.items as CreditItemInput[] | undefined });
  } catch (e) {
    return asState(e);
  }
  refresh(bookingId);
  return { ok: "Entwurf gespeichert." };
}

/** Abschluss mit Pflichtgrund und ausdrücklicher Bestätigung; danach PDF und E-Mail als Nachbearbeitung (wie bei Rechnungen). */
export async function finalizeCounterAction(bookingId: string, invoiceId: string, _prev: CounterState, formData: FormData): Promise<CounterState> {
  const { tenant, invoice, actor } = await context(bookingId, invoiceId);
  let version;
  try {
    version = await finalizeCounterDocument(tenant.id, invoice.id, actor, { reason: String(formData.get("reason") ?? ""), confirmed: formData.get("confirmed") === "1" });
  } catch (e) {
    return asState(e);
  }
  await runInvoiceFollowUp(tenant.id, version.id, actor.id);
  refresh(bookingId);
  redirect(withParam(href(bookingId, invoice.id), "abgeschlossen", "1"));
}

export async function discardCounterAction(bookingId: string, invoiceId: string) {
  const { tenant, invoice, actor } = await context(bookingId, invoiceId);
  let originalId = invoice.originalInvoiceId ?? invoice.id;
  try {
    originalId = (await discardCounterDocumentDraft(tenant.id, invoice.id, actor)).originalInvoiceId;
  } catch (e) {
    const s = asState(e);
    redirect(withParam(href(bookingId, invoice.id), "hinweis", s?.error ?? "Der Entwurf konnte nicht verworfen werden."));
  }
  refresh(bookingId);
  redirect(withParam(href(bookingId, originalId), "hinweis", "Der Entwurf wurde verworfen; es wurde keine Nummer vergeben."));
}

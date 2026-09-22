"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ensureContractDocument, ensureHandoverDocument, ensureInvoiceDocument } from "@/lib/documents";
import { DomainError } from "@/lib/integrity";
import { sendHandoverDocuments, sendInvoiceDocument, type SendResult } from "@/lib/rental-mail";

export type DocState = { error?: string; ok?: string } | undefined;
type HandoverKind = "PICKUP" | "RETURN";

function refresh(bookingId: string) {
  for (const p of [`/buchungen/${bookingId}`, `/buchungen/${bookingId}/uebergabe`, `/buchungen/${bookingId}/rueckgabe`, `/buchungen/${bookingId}/vertrag`, `/buchungen/${bookingId}/rechnung`]) revalidatePath(p);
}

function failure(step: string, e: unknown): DocState {
  if (e instanceof DomainError) return { error: e.message };
  console.error(`[dokumente] ${step} fehlgeschlagen`, { fehler: e instanceof Error ? e.name : "unbekannt" });
  return { error: "Das hat technisch nicht geklappt. Bitte später erneut versuchen." };
}

async function finalizedHandover(tenantId: string, bookingId: string, kind: HandoverKind) {
  return db.handover.findFirst({ where: { bookingId, tenantId, type: kind, status: "FINALIZED", correctsId: null }, orderBy: { finalizedAt: "desc" }, select: { id: true } });
}

/** Mietvertrag-PDF nachträglich erzeugen. Existiert es schon, passiert nichts (kein zweites Dokument). */
export async function generateContractPdfAction(bookingId: string, _prev: DocState, _formData: FormData): Promise<DocState> {
  void _formData;
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const contract = await db.rentalContract.findFirst({ where: { bookingId, tenantId: tenant.id }, select: { id: true } });
  if (!contract) return { error: "Zu dieser Buchung gibt es keinen Mietvertrag." };
  try {
    const res = await ensureContractDocument(tenant.id, contract.id, user.id);
    refresh(bookingId);
    return { ok: res.created ? "Mietvertrag-PDF wurde erzeugt." : "Das Mietvertrag-PDF war bereits vorhanden." };
  } catch (e) {
    return failure("Mietvertrag-PDF", e);
  }
}

/** Protokoll-PDF (Übergabe oder Rückgabe) nachträglich erzeugen, ebenfalls nur wenn es noch keines gibt. */
export async function generateHandoverPdfAction(bookingId: string, kind: HandoverKind, _prev: DocState, _formData: FormData): Promise<DocState> {
  void _formData;
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const handover = await finalizedHandover(tenant.id, bookingId, kind);
  const label = kind === "PICKUP" ? "Übergabeprotokoll" : "Rückgabeprotokoll";
  if (!handover) return { error: `Zu dieser Buchung gibt es keine abgeschlossene ${kind === "PICKUP" ? "Übergabe" : "Rückgabe"}.` };
  try {
    const res = await ensureHandoverDocument(tenant.id, handover.id, user.id);
    refresh(bookingId);
    return { ok: res.created ? `${label}-PDF wurde erzeugt.` : `Das ${label}-PDF war bereits vorhanden.` };
  } catch (e) {
    return failure(`${label}-PDF`, e);
  }
}

async function finalizedInvoice(tenantId: string, bookingId: string) {
  return db.invoice.findFirst({ where: { bookingId, tenantId, status: "FINALIZED" }, select: { id: true } });
}

/** Rechnungs-PDF nachträglich erzeugen (nur abgeschlossene Rechnung). Hofmitarbeiter dürfen das PDF erzeugen und laden. */
export async function generateInvoicePdfAction(bookingId: string, _prev: DocState, _formData: FormData): Promise<DocState> {
  void _formData;
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const invoice = await finalizedInvoice(tenant.id, bookingId);
  if (!invoice) return { error: "Zu dieser Buchung gibt es keine abgeschlossene Rechnung." };
  try {
    const res = await ensureInvoiceDocument(tenant.id, invoice.id, user.id);
    refresh(bookingId);
    return { ok: res.created ? "Rechnungs-PDF wurde erzeugt." : "Das Rechnungs-PDF war bereits vorhanden." };
  } catch (e) {
    return failure("Rechnungs-PDF", e);
  }
}

/** Rechnung erneut senden: wie bei den Protokollen mit einmaligem nonce, verschickt wird das archivierte PDF. Nur Disposition und Inhaber. */
export async function resendInvoiceAction(bookingId: string, _prev: DocState, formData: FormData): Promise<DocState> {
  const { tenant, user } = await requireRole("DISPO");
  const invoice = await finalizedInvoice(tenant.id, bookingId);
  if (!invoice) return { error: "Zu dieser Buchung gibt es keine abgeschlossene Rechnung." };
  try {
    const res = await sendInvoiceDocument(tenant.id, invoice.id, { trigger: "MANUAL", actorId: user.id, nonce: String(formData.get("nonce") ?? "") });
    refresh(bookingId);
    return sendOutcome(res);
  } catch (e) {
    return failure("Versand", e);
  }
}

function sendOutcome(res: SendResult): DocState {
  if (res.status === "SENT") return { ok: `Unterlagen wurden an ${res.log.recipient} versendet.` };
  if (res.status === "DUPLICATE") return res.log.status === "SENT" ? { ok: "Diese Anfrage wurde bereits versendet. Es wurde nichts doppelt verschickt." } : { error: "Diese Anfrage wurde bereits verarbeitet. Bitte den Stand unten prüfen." };
  return { error: `E-Mail konnte nicht versendet werden: ${(res.log.error ?? "unbekannter Fehler").replace(/\.+$/, "")}.` };
}

export async function generatePickupPdfAction(bookingId: string, prev: DocState, formData: FormData): Promise<DocState> {
  return generateHandoverPdfAction(bookingId, "PICKUP", prev, formData);
}

/**
 * "Unterlagen erneut senden". Das Formular trägt einen einmaligen Wert (nonce): Ein Doppelklick oder erneutes
 * Absenden desselben Formulars verschickt nichts ein zweites Mal. Verschickt werden die archivierten PDFs.
 */
export async function resendDocumentsAction(bookingId: string, kind: HandoverKind, _prev: DocState, formData: FormData): Promise<DocState> {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const handover = await finalizedHandover(tenant.id, bookingId, kind);
  if (!handover) return { error: `Zu dieser Buchung gibt es keine abgeschlossene ${kind === "PICKUP" ? "Übergabe" : "Rückgabe"}.` };
  try {
    const res = await sendHandoverDocuments(tenant.id, handover.id, { trigger: "MANUAL", actorId: user.id, nonce: String(formData.get("nonce") ?? "") });
    refresh(bookingId);
    return sendOutcome(res);
  } catch (e) {
    return failure("Versand", e);
  }
}

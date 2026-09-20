"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ensureContractDocument, ensurePickupDocument } from "@/lib/documents";
import { DomainError } from "@/lib/integrity";
import { sendPickupDocuments } from "@/lib/rental-mail";

export type DocState = { error?: string; ok?: string } | undefined;

function refresh(bookingId: string) {
  revalidatePath(`/buchungen/${bookingId}`);
  revalidatePath(`/buchungen/${bookingId}/uebergabe`);
  revalidatePath(`/buchungen/${bookingId}/vertrag`);
}

function failure(step: string, e: unknown): DocState {
  if (e instanceof DomainError) return { error: e.message };
  console.error(`[dokumente] ${step} fehlgeschlagen`, { fehler: e instanceof Error ? e.name : "unbekannt" });
  return { error: "Das hat technisch nicht geklappt. Bitte später erneut versuchen." };
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

/** Übergabeprotokoll-PDF nachträglich erzeugen, ebenfalls nur wenn es noch keines gibt. */
export async function generatePickupPdfAction(bookingId: string, _prev: DocState, _formData: FormData): Promise<DocState> {
  void _formData;
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const handover = await db.handover.findFirst({ where: { bookingId, tenantId: tenant.id, type: "PICKUP", status: "FINALIZED", correctsId: null }, orderBy: { finalizedAt: "desc" }, select: { id: true } });
  if (!handover) return { error: "Zu dieser Buchung gibt es keine abgeschlossene Übergabe." };
  try {
    const res = await ensurePickupDocument(tenant.id, handover.id, user.id);
    refresh(bookingId);
    return { ok: res.created ? "Übergabeprotokoll-PDF wurde erzeugt." : "Das Übergabeprotokoll-PDF war bereits vorhanden." };
  } catch (e) {
    return failure("Übergabeprotokoll-PDF", e);
  }
}

/**
 * "Unterlagen erneut senden". Das Formular trägt einen einmaligen Wert (nonce): Ein Doppelklick oder erneutes
 * Absenden desselben Formulars verschickt nichts ein zweites Mal. Verschickt werden die archivierten PDFs.
 */
export async function resendDocumentsAction(bookingId: string, _prev: DocState, formData: FormData): Promise<DocState> {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const handover = await db.handover.findFirst({ where: { bookingId, tenantId: tenant.id, type: "PICKUP", status: "FINALIZED", correctsId: null }, orderBy: { finalizedAt: "desc" }, select: { id: true } });
  if (!handover) return { error: "Zu dieser Buchung gibt es keine abgeschlossene Übergabe." };
  try {
    const res = await sendPickupDocuments(tenant.id, handover.id, { trigger: "MANUAL", actorId: user.id, nonce: String(formData.get("nonce") ?? "") });
    refresh(bookingId);
    if (res.status === "SENT") return { ok: `Unterlagen wurden an ${res.log.recipient} versendet.` };
    if (res.status === "DUPLICATE") return { ok: res.log.status === "SENT" ? "Diese Anfrage wurde bereits versendet. Es wurde nichts doppelt verschickt." : undefined, error: res.log.status === "SENT" ? undefined : "Diese Anfrage wurde bereits verarbeitet. Bitte den Stand unten prüfen." };
    return { error: `E-Mail konnte nicht versendet werden: ${res.log.error ?? "unbekannter Fehler"}.` };
  } catch (e) {
    return failure("Versand", e);
  }
}

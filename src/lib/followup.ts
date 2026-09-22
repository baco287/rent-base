// Nachbearbeitung nach einem fachlichen Abschluss: Dokument erzeugen, archivieren, E-Mail senden.
// Diese Schritte laufen bewusst NACH der abgeschlossenen Transaktion von Vertrag bzw. Übergabe und werfen nie.
// Ein Ausfall von PDF-Erzeugung, Object Storage oder SMTP lässt die Übergabe unberührt; alles ist wiederholbar.

import { ensureContractDocument, ensureInvoiceDocument, ensurePickupDocument, ensureReturnDocument } from "@/lib/documents";
import { DomainError } from "@/lib/integrity";
import { sendHandoverDocuments, sendInvoiceDocument, type SendOptions } from "@/lib/rental-mail";
import type { StorageDriver } from "@/lib/storage";

export type StepResult = { ok: boolean; error?: string };
export type PickupFollowUp = { contractDocument: StepResult; pickupDocument: StepResult; email: { status: "SENT" | "FAILED" | "DUPLICATE" | "SKIPPED"; error?: string } };

type Deps = { storage?: StorageDriver; transport?: SendOptions["transport"] };

/** Kurzer Fehlertext für die Oberfläche. Technische Details und personenbezogene Daten gehören nicht ins Log. */
function describe(step: string, id: string, e: unknown): string {
  if (e instanceof DomainError) return e.message;
  console.error(`[nachbearbeitung] ${step} fehlgeschlagen`, { id, fehler: e instanceof Error ? e.name : "unbekannt", code: (e as { code?: unknown })?.code ?? null });
  return "Technischer Fehler bei der Dokumenterzeugung. Der Vorgang kann wiederholt werden.";
}

async function step(name: string, id: string, fn: () => Promise<unknown>): Promise<StepResult> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describe(name, id, e) };
  }
}

/** Nach dem Vertragsabschluss: Mietvertrags-PDF erzeugen und archivieren. */
export function runContractFollowUp(tenantId: string, contractId: string, actorId: string | null, deps: Deps = {}): Promise<StepResult> {
  return step("Mietvertrag-PDF", contractId, () => ensureContractDocument(tenantId, contractId, actorId, { storage: deps.storage }));
}

/** Nach der finalisierten Übergabe: beide PDFs sicherstellen, dann genau einmal automatisch senden. */
export async function runPickupFollowUp(tenantId: string, handover: { id: string; contractId: string | null }, actorId: string | null, deps: Deps = {}): Promise<PickupFollowUp> {
  const contractDocument = handover.contractId
    ? await step("Mietvertrag-PDF", handover.contractId, () => ensureContractDocument(tenantId, handover.contractId!, actorId, { storage: deps.storage }))
    : { ok: false, error: "Zu dieser Übergabe gibt es keinen Mietvertrag." };
  const pickupDocument = await step("Übergabeprotokoll-PDF", handover.id, () => ensurePickupDocument(tenantId, handover.id, actorId, { storage: deps.storage }));
  if (!contractDocument.ok || !pickupDocument.ok) return { contractDocument, pickupDocument, email: { status: "SKIPPED", error: "Ohne beide Dokumente wird nichts versendet." } };
  try {
    const sent = await sendHandoverDocuments(tenantId, handover.id, { trigger: "AUTO", actorId, transport: deps.transport, storage: deps.storage });
    return { contractDocument, pickupDocument, email: { status: sent.status, error: sent.log.error ?? undefined } };
  } catch (e) {
    return { contractDocument, pickupDocument, email: { status: "FAILED", error: describe("E-Mail-Versand", handover.id, e) } };
  }
}

export type ReturnFollowUp = { returnDocument: StepResult; email: { status: "SENT" | "FAILED" | "DUPLICATE" | "SKIPPED"; error?: string } };

/** Nach der finalisierten Rückgabe: Rückgabe-PDF sicherstellen, dann genau einmal automatisch senden. Wirft nie. */
export async function runReturnFollowUp(tenantId: string, handover: { id: string }, actorId: string | null, deps: Deps = {}): Promise<ReturnFollowUp> {
  const returnDocument = await step("Rückgabeprotokoll-PDF", handover.id, () => ensureReturnDocument(tenantId, handover.id, actorId, { storage: deps.storage }));
  if (!returnDocument.ok) return { returnDocument, email: { status: "SKIPPED", error: "Ohne Dokument wird nichts versendet." } };
  try {
    const sent = await sendHandoverDocuments(tenantId, handover.id, { trigger: "AUTO", actorId, transport: deps.transport, storage: deps.storage });
    return { returnDocument, email: { status: sent.status, error: sent.log.error ?? undefined } };
  } catch (e) {
    return { returnDocument, email: { status: "FAILED", error: describe("E-Mail-Versand", handover.id, e) } };
  }
}

export type InvoiceFollowUp = { invoiceDocument: StepResult; email: { status: "SENT" | "FAILED" | "DUPLICATE" | "SKIPPED"; error?: string } };

/** Nach dem Rechnungsabschluss: PDF sicherstellen, dann genau einmal automatisch senden. Wirft nie. */
export async function runInvoiceFollowUp(tenantId: string, invoiceId: string, actorId: string | null, deps: Deps = {}): Promise<InvoiceFollowUp> {
  const invoiceDocument = await step("Rechnungs-PDF", invoiceId, () => ensureInvoiceDocument(tenantId, invoiceId, actorId, { storage: deps.storage }));
  if (!invoiceDocument.ok) return { invoiceDocument, email: { status: "SKIPPED", error: "Ohne Dokument wird nichts versendet." } };
  try {
    const sent = await sendInvoiceDocument(tenantId, invoiceId, { trigger: "AUTO", actorId, transport: deps.transport, storage: deps.storage });
    return { invoiceDocument, email: { status: sent.status, error: sent.log.error ?? undefined } };
  } catch (e) {
    return { invoiceDocument, email: { status: "FAILED", error: describe("E-Mail-Versand", invoiceId, e) } };
  }
}

// Archiv erzeugter Dokumente (PDF). Ein Dokument wird einmal erzeugt und nie überschrieben.
// Eine neue Fassung bekommt eine neue Versionsnummer und einen neuen Storage Key.
// Änderungen und Löschen blockiert zusätzlich ein Datenbank-Trigger.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import type { DocumentType } from "@/lib/constants";
import { db } from "@/lib/db";
import { loadContractDocumentData, loadHandoverDocumentData, loadInvoiceDocumentData, loadPayoutDocumentData, type HandoverData } from "@/lib/document-data";
import { DomainError, sha256 } from "@/lib/integrity";
import { isUniqueViolation } from "@/lib/numbering";
import { renderContractPdf } from "@/lib/pdf/contract-pdf";
import { renderHandoverPdf } from "@/lib/pdf/handover-pdf";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderPayoutPdf } from "@/lib/pdf/payout-pdf";
import { assertKeyBelongsToTenant, buildStorageKey, getStorage, sniffImageType, type StorageDriver } from "@/lib/storage";

type Tx = Prisma.TransactionClient;

export type DocumentInput = {
  bookingId: string;
  contractId?: string | null;
  handoverId?: string | null;
  invoiceId?: string | null;
  invoiceVersionId?: string | null;
  payoutId?: string | null;
  type: DocumentType;
  storageKey: string;
  fileName: string;
  contentType?: string;
  sizeBytes: number;
  checksum: string;
  sourceHash?: string | null;
};

export async function registerDocument(tx: Tx, tenantId: string, actorId: string | null, input: DocumentInput) {
  assertKeyBelongsToTenant(input.storageKey, tenantId);
  if (!/^[a-f0-9]{64}$/.test(input.checksum)) throw new DomainError("Die Prüfsumme des Dokuments fehlt oder ist ungültig.");
  const booking = await tx.booking.count({ where: { id: input.bookingId, tenantId } });
  if (booking !== 1) throw new DomainError("Buchung nicht gefunden.");
  if (input.contractId && (await tx.rentalContract.count({ where: { id: input.contractId, tenantId, bookingId: input.bookingId } })) !== 1) throw new DomainError("Der Vertrag gehört nicht zu dieser Buchung.");
  if (input.handoverId && (await tx.handover.count({ where: { id: input.handoverId, tenantId, bookingId: input.bookingId } })) !== 1) throw new DomainError("Das Protokoll gehört nicht zu dieser Buchung.");
  if (input.invoiceId && (await tx.invoice.count({ where: { id: input.invoiceId, tenantId, bookingId: input.bookingId } })) !== 1) throw new DomainError("Die Rechnung gehört nicht zu dieser Buchung.");
  if (input.payoutId && (await tx.payout.count({ where: { id: input.payoutId, tenantId, bookingId: input.bookingId } })) !== 1) throw new DomainError("Die Auszahlung gehört nicht zu dieser Buchung.");

  const last = await tx.document.findFirst({
    where: { tenantId, bookingId: input.bookingId, type: input.type, contractId: input.contractId ?? null, handoverId: input.handoverId ?? null, invoiceId: input.invoiceId ?? null, invoiceVersionId: input.invoiceVersionId ?? null, payoutId: input.payoutId ?? null },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return tx.document.create({
    data: {
      tenantId,
      bookingId: input.bookingId,
      contractId: input.contractId ?? null,
      handoverId: input.handoverId ?? null,
      invoiceId: input.invoiceId ?? null,
      invoiceVersionId: input.invoiceVersionId ?? null,
      payoutId: input.payoutId ?? null,
      type: input.type,
      storageKey: input.storageKey,
      fileName: input.fileName,
      contentType: input.contentType ?? "application/pdf",
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      sourceHash: input.sourceHash ?? null,
      version: (last?.version ?? 0) + 1,
      createdById: actorId,
    },
  });
}

// ---------------------------------------------------------------------------
// Erzeugen und Archivieren
// Ablauf: Dokumentdaten aus den Snapshots laden, PDF-Bytes erzeugen, SHA-256 bilden, privaten Storage Key erzeugen,
// Datei ablegen, Document-Zeile anlegen. Eine vorhandene Fassung wird nie überschrieben und nie neu erzeugt.
// ---------------------------------------------------------------------------

export type ArchivedDocument = Prisma.DocumentGetPayload<object>;
export type EnsureResult = { document: ArchivedDocument; created: boolean };
export type EnsureOptions = {
  /** Bewusst eine weitere Fassung anlegen (neue Zeile, neuer Storage Key, höhere Version). Die alte bleibt bestehen. */
  newVersion?: boolean;
  storage?: StorageDriver;
};

/** Sicherer Namensbaustein. Kundeneingaben gelangen nie ungeprüft in Dateinamen oder Pfade. */
export function safeFilePart(value: string): string {
  const map: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" };
  return value
    .replace(/[äöüÄÖÜß]/g, (c) => map[c])
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function documentFileName(type: DocumentType, contractNumber: string, plate?: string | null, version = 1): string {
  const base = type === "RENTAL_CONTRACT" ? "Mietvertrag" : type === "PICKUP_PROTOCOL" ? "Uebergabe" : type === "RETURN_PROTOCOL" ? "Rueckgabe" : type === "INVOICE" ? "Rechnung" : "Dokument";
  const parts = [base, safeFilePart(contractNumber) || "ohne-Nummer"];
  if (type !== "RENTAL_CONTRACT" && type !== "INVOICE" && plate && safeFilePart(plate)) parts.push(safeFilePart(plate));
  if (version > 1) parts.push(`v${version}`);
  return `${parts.join("_")}.pdf`;
}

type Subject = { type: DocumentType; bookingId: string; contractId: string | null; handoverId: string | null; invoiceId?: string | null; invoiceVersionId?: string | null; payoutId?: string | null };

function latestDocument(client: Tx | typeof db, tenantId: string, s: Subject) {
  return client.document.findFirst({ where: { tenantId, bookingId: s.bookingId, type: s.type, contractId: s.contractId, handoverId: s.handoverId, invoiceId: s.invoiceId ?? null, invoiceVersionId: s.invoiceVersionId ?? null, payoutId: s.payoutId ?? null }, orderBy: { version: "desc" } });
}

async function archive(tenantId: string, actorId: string | null, subject: Subject, opts: EnsureOptions, sourceHash: string, fileName: (version: number) => string, render: () => Promise<Buffer>): Promise<EnsureResult> {
  const before = await latestDocument(db, tenantId, subject);
  if (before && !opts.newVersion) return { document: before, created: false };

  const storage = opts.storage ?? getStorage(); // in Produktion ohne Object Storage: klare Fehlermeldung, nichts wird erzeugt
  const bytes = await render();
  const checksum = sha256(bytes);
  const storageKey = buildStorageKey({ tenantId, area: "documents", bookingId: subject.bookingId, contentType: "application/pdf" });
  let stored = false;
  try {
    return await db.$transaction(
      async (tx) => {
        // Zeilensperre auf dem Vertrag bzw. Protokoll: gleichzeitige Anfragen laufen nacheinander
        if (subject.payoutId) await tx.$queryRaw`SELECT "id" FROM "Payout" WHERE "id" = ${subject.payoutId} AND "tenantId" = ${tenantId} FOR UPDATE`;
        else if (subject.invoiceVersionId) await tx.$queryRaw`SELECT "id" FROM "InvoiceVersion" WHERE "id" = ${subject.invoiceVersionId} AND "tenantId" = ${tenantId} FOR UPDATE`;
        else if (subject.invoiceId) await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${subject.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
        else if (subject.handoverId) await tx.$queryRaw`SELECT "id" FROM "Handover" WHERE "id" = ${subject.handoverId} AND "tenantId" = ${tenantId} FOR UPDATE`;
        else if (subject.contractId) await tx.$queryRaw`SELECT "id" FROM "RentalContract" WHERE "id" = ${subject.contractId} AND "tenantId" = ${tenantId} FOR UPDATE`;
        const latest = await latestDocument(tx, tenantId, subject);
        if (latest && (!opts.newVersion || latest.version !== before?.version)) return { document: latest, created: false };
        await storage.put(storageKey, bytes, "application/pdf");
        stored = true;
        const document = await registerDocument(tx, tenantId, actorId, { ...subject, storageKey, fileName: fileName((latest?.version ?? 0) + 1), sizeBytes: bytes.length, checksum, sourceHash });
        return { document, created: true };
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
  } catch (e) {
    if (stored) await storage.remove(storageKey).catch(() => {});
    // Zweite Sicherung (eindeutiger Index): hat eine parallele Anfrage gewonnen, gilt deren Dokument
    if (isUniqueViolation(e)) {
      const winner = await latestDocument(db, tenantId, subject);
      if (winner) return { document: winner, created: false };
    }
    throw e;
  }
}

/** Mietvertrags-PDF: nur für abgeschlossene Verträge, einmalig je Fassung. */
export async function ensureContractDocument(tenantId: string, contractId: string, actorId: string | null, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const data = await loadContractDocumentData(tenantId, contractId);
  return archive(
    tenantId,
    actorId,
    { type: "RENTAL_CONTRACT", bookingId: data.bookingId, contractId: data.contractId, handoverId: null },
    opts,
    data.sourceHash,
    (v) => documentFileName("RENTAL_CONTRACT", data.doc.number, null, v),
    async () => (await renderContractPdf(data.doc, data.signatureImages)).bytes,
  );
}

const SKETCH_PATH = /^\/sketches\/[A-Za-z0-9._-]+\.svg$/;

/** Liest die Skizzendatei und verwendet sie nur, wenn sie der im Protokoll festgehaltenen Fassung entspricht. */
export async function loadSketchSvg(sketch: { assetPath: string; assetHash: string } | null): Promise<string | null> {
  if (!sketch || !SKETCH_PATH.test(sketch.assetPath)) return null;
  try {
    const bytes = await readFile(path.join(process.cwd(), "public", ...sketch.assetPath.split("/").filter(Boolean)));
    return sha256(bytes) === sketch.assetHash ? bytes.toString("utf8") : null;
  } catch {
    return null;
  }
}

/** Verkleinert ein Foto für das PDF. Das Original im Speicher bleibt unverändert. */
export async function shrinkPhoto(body: Uint8Array): Promise<Uint8Array | null> {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(body).rotate().resize(1100, 1100, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
  } catch {
    const type = sniffImageType(body);
    // Ohne Bildverarbeitung nur kleine Originale einbetten, die pdfkit direkt versteht
    return (type === "image/jpeg" || type === "image/png") && body.length <= 900_000 ? body : null;
  }
}

export async function loadPhotosForPdf(tenantId: string, storage: StorageDriver, files: HandoverData["photoFiles"]) {
  const out = new Map<string, Uint8Array>();
  for (const f of files) {
    try {
      assertKeyBelongsToTenant(f.storageKey, tenantId);
      const obj = await storage.get(f.storageKey);
      if (!obj || sha256(obj.body) !== f.checksum) continue; // fehlt oder weicht vom versiegelten Stand ab: nicht einbetten
      const small = await shrinkPhoto(obj.body);
      if (small) out.set(f.id, small);
    } catch {
      // ein nicht lesbares Foto verhindert das Dokument nicht
    }
  }
  return out;
}

/** Protokoll-PDF (Übergabe oder Rückgabe): nur für finalisierte Protokolle, einmalig je Fassung. */
export async function ensureHandoverDocument(tenantId: string, handoverId: string, actorId: string | null, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const data = await loadHandoverDocumentData(tenantId, handoverId);
  const type: DocumentType = data.doc.type === "RETURN" ? "RETURN_PROTOCOL" : "PICKUP_PROTOCOL";
  return archive(
    tenantId,
    actorId,
    { type, bookingId: data.bookingId, contractId: null, handoverId: data.handoverId },
    opts,
    data.sourceHash,
    (v) => documentFileName(type, data.doc.context?.contractNumber ?? data.doc.number, data.doc.context?.plate, v),
    async () => {
      const storage = opts.storage ?? getStorage();
      const [sketchSvg, photos] = await Promise.all([loadSketchSvg(data.sketch), loadPhotosForPdf(tenantId, storage, data.photoFiles)]);
      return (await renderHandoverPdf(data.doc, { sketchSvg, photos, signatures: data.signatureImages })).bytes;
    },
  );
}

export async function ensurePickupDocument(tenantId: string, handoverId: string, actorId: string | null, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const h = await db.handover.findFirst({ where: { id: handoverId, tenantId }, select: { type: true } });
  if (h && h.type !== "PICKUP") throw new DomainError("Dieses Protokoll ist keine Übergabe.");
  return ensureHandoverDocument(tenantId, handoverId, actorId, opts);
}

export async function ensureReturnDocument(tenantId: string, handoverId: string, actorId: string | null, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const h = await db.handover.findFirst({ where: { id: handoverId, tenantId }, select: { type: true } });
  if (h && h.type !== "RETURN") throw new DomainError("Dieses Protokoll ist keine Rückgabe.");
  return ensureHandoverDocument(tenantId, handoverId, actorId, opts);
}

/** Rechnungs-PDF einer abgeschlossenen Rechnungsfassung: einmalig je Fassung, ausschließlich aus InvoiceVersion und ihren Positionen. Alte Dateien bleiben. */
export async function ensureInvoiceDocument(tenantId: string, versionId: string, actorId: string | null, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const data = await loadInvoiceDocumentData(tenantId, versionId);
  // Gegenbelege (Gutschrift, Stornobeleg) sind eigene Dokumenttypen mit eigenem Dateinamen; dieselbe private, unveränderliche Archivierung
  return archive(
    tenantId,
    actorId,
    { type: data.documentType, bookingId: data.bookingId, contractId: null, handoverId: null, invoiceId: data.invoiceId, invoiceVersionId: data.versionId },
    opts,
    data.sourceHash,
    (v) => invoiceFileName(data.doc.number, data.versionNo, v, data.documentType),
    async () => (await renderInvoicePdf(data.doc)).bytes,
  );
}

/** Auszahlungsbeleg für eine abgeschlossene Auszahlung: einmalig, privat, mit Prüfsumme; nie neu erzeugt. */
export async function ensurePayoutDocument(tenantId: string, payoutId: string, actorId: string | null, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const data = await loadPayoutDocumentData(tenantId, payoutId);
  return archive(
    tenantId,
    actorId,
    { type: "PAYOUT_RECEIPT", bookingId: data.bookingId, contractId: null, handoverId: null, payoutId: data.payoutId },
    opts,
    data.sourceHash,
    (v) => `Auszahlungsbeleg_${safeFilePart(data.doc.number) || "ohne-Nummer"}${v > 1 ? `_v${v}` : ""}.pdf`,
    async () => (await renderPayoutPdf(data.doc)).bytes,
  );
}

/** Rechnung_RE-2026-000123_Fassung2.pdf, Gutschrift_GS-2026-000001.pdf, Stornobeleg_ST-2026-000001.pdf (bei mehreren Archivfassungen zusätzlich _v2). */
export function invoiceFileName(number: string, versionNo: number, archiveVersion = 1, documentType: "INVOICE" | "CREDIT_NOTE" | "CANCELLATION" = "INVOICE"): string {
  const word = documentType === "CREDIT_NOTE" ? "Gutschrift" : documentType === "CANCELLATION" ? "Stornobeleg" : "Rechnung";
  const parts = [word, safeFilePart(number) || "ohne-Nummer", ...(documentType === "INVOICE" ? [`Fassung${versionNo}`] : [])];
  if (archiveVersion > 1) parts.push(`v${archiveVersion}`);
  return `${parts.join("_")}.pdf`;
}

export class DocumentIntegrityError extends Error {}

/** Liest ein archiviertes Dokument und prüft die Prüfsumme. Der Mandant wird immer mitgeprüft. */
export async function readDocumentFile(tenantId: string, documentId: string, storage: StorageDriver = getStorage()) {
  const document = await db.document.findFirst({ where: { id: documentId, tenantId } });
  if (!document) return null;
  assertKeyBelongsToTenant(document.storageKey, tenantId);
  const obj = await storage.get(document.storageKey);
  if (!obj) throw new DocumentIntegrityError("Die Datei zu diesem Dokument wurde im Speicher nicht gefunden.");
  if (sha256(obj.body) !== document.checksum) throw new DocumentIntegrityError("Die Prüfsumme der gespeicherten Datei stimmt nicht mit dem Archiveintrag überein.");
  return { document, body: obj.body };
}

export function listBookingDocuments(tenantId: string, bookingId: string) {
  return db.document.findMany({ where: { tenantId, bookingId }, orderBy: [{ type: "asc" }, { version: "desc" }] });
}

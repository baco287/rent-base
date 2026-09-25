// Lädt die Dokumentdaten für Mietvertrag und Übergabeprotokoll. Ansicht und PDF rufen beide diese Funktionen auf.
// Grundsatz: Gelesen werden nur die im Vertrag und im Protokoll gespeicherten Kopien (Snapshots) sowie die
// dazugehörigen, zum versiegelten Inhalt passenden Unterschriften. Kunden-, Fahrzeug-, Schaden-, Preis- oder
// Vorlagen-Stammdaten werden hier bewusst nicht angefasst.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { REQUIRED_PHOTO_CATEGORIES } from "@/lib/constants";
import { buildContractDocument, landlordOf, type ContractDocumentData, type TenantLike } from "@/lib/contract-view";
import type { CustomerSnapshot, VehicleSnapshot } from "@/lib/contracts";
import { buildHandoverDocument, type HandoverContext, type HandoverDocumentData } from "@/lib/handover-view";
import { driverCheckSummaries } from "@/lib/driver-verification";
import { DomainError } from "@/lib/integrity";
import { loadSealedComparison } from "@/lib/returns";
import { buildInvoiceDocument, type InvoiceDocumentData } from "@/lib/invoice-view";
import { buildPayoutDocument, type PayoutDocumentData } from "@/lib/payout-view";

const TENANT_FIELDS = { name: true, street: true, zip: true, city: true, phone: true, email: true } as const;

type SignatureRow = { id: string; role: string; signerName: string; signedAt: Date; contentHash: string; imageData: Uint8Array | null };

/** Nur Unterschriften, die zum versiegelten Inhalt gehören. Je Rolle die letzte gültige. */
function validSignatures(rows: SignatureRow[], sealedHash: string | null): SignatureRow[] {
  const byRole = new Map<string, SignatureRow>();
  for (const s of rows) if (sealedHash && s.contentHash === sealedHash) byRole.set(s.role, s);
  return ["RENTER", "EMPLOYEE"].flatMap((r) => (byRole.has(r) ? [byRole.get(r)!] : []));
}

export type ContractData = { doc: ContractDocumentData; bookingId: string; contractId: string; sourceHash: string; signatureImages: Map<string, Uint8Array> };

export async function loadContractDocumentData(tenantId: string, contractId: string): Promise<ContractData> {
  const contract = await db.rentalContract.findFirst({ where: { id: contractId, tenantId }, include: { drivers: { orderBy: [{ role: "desc" }, { createdAt: "asc" }] } } });
  if (!contract) throw new DomainError("Vertrag nicht gefunden.");
  if (contract.status !== "SIGNED" || !contract.contentHash) throw new DomainError("Ein Vertrags-PDF gibt es erst, wenn der Mietvertrag abgeschlossen ist.");
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: TENANT_FIELDS });
  const rows = await db.signature.findMany({ where: { tenantId, contractId }, orderBy: { signedAt: "asc" }, select: { id: true, role: true, signerName: true, signedAt: true, contentHash: true, imageData: true } });
  const signatures = validSignatures(rows, contract.contentHash);
  return {
    doc: buildContractDocument(contract, tenant, signatures),
    bookingId: contract.bookingId,
    contractId: contract.id,
    sourceHash: contract.contentHash,
    signatureImages: new Map(signatures.flatMap((s) => (s.imageData ? [[s.id, s.imageData] as const] : []))),
  };
}

type ContractRef = { number: string; customerSnapshot: unknown; vehicleSnapshot: unknown; landlordSnapshot: unknown } | null;

/** Mieter, Fahrzeug und Vermieter des Protokolls aus der versiegelten Vertragskopie. */
export function handoverContext(contract: ContractRef, tenant: TenantLike, bookingNumber: string): HandoverContext {
  const c = (contract?.customerSnapshot ?? {}) as Partial<CustomerSnapshot>;
  const v = (contract?.vehicleSnapshot ?? {}) as Partial<VehicleSnapshot>;
  return {
    landlord: landlordOf(contract?.landlordSnapshot ?? null, tenant),
    contractNumber: contract?.number ?? null,
    bookingNumber,
    renterName: [c.type === "COMPANY" ? c.companyName : null, `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()].filter(Boolean).join(", "),
    renterNumber: c.number ?? null,
    vehicleTitle: `${v.make ?? ""} ${v.model ?? ""}`.trim(),
    plate: String(v.plate ?? ""),
    vehicleGroup: v.groupName ?? null,
  };
}

/** Kontext für die Ansicht eines Protokolls, auch im Entwurf. */
export async function loadHandoverContext(tenantId: string, handover: { contractId: string | null; bookingId: string }): Promise<HandoverContext> {
  const [tenant, booking, contract] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: TENANT_FIELDS }),
    db.booking.findFirst({ where: { id: handover.bookingId, tenantId }, select: { number: true } }),
    handover.contractId ? db.rentalContract.findFirst({ where: { id: handover.contractId, tenantId }, select: { number: true, customerSnapshot: true, vehicleSnapshot: true, landlordSnapshot: true } }) : null,
  ]);
  return handoverContext(contract, tenant, booking?.number ?? "");
}

export type HandoverData = {
  doc: HandoverDocumentData;
  bookingId: string;
  handoverId: string;
  contractId: string | null;
  sourceHash: string;
  signatureImages: Map<string, Uint8Array>;
  /** Fotos des versiegelten Protokolls: id, Speicherort und Prüfsumme aus der Kopie */
  photoFiles: { id: string; storageKey: string; checksum: string; contentType: string }[];
  sketch: { assetPath: string; assetHash: string } | null;
};

export async function loadHandoverDocumentData(tenantId: string, handoverId: string): Promise<HandoverData> {
  const h = await db.handover.findFirst({
    where: { id: handoverId, tenantId },
    include: { damages: { orderBy: { sortOrder: "asc" } }, checklistItems: { orderBy: { sortOrder: "asc" } }, photos: { orderBy: { uploadedAt: "asc" } } },
  });
  if (!h) throw new DomainError("Protokoll nicht gefunden.");
  if (h.status !== "FINALIZED" || !h.contentHash) throw new DomainError("Ein Protokoll-PDF gibt es erst, wenn die Übergabe abgeschlossen ist.");
  const sketch = h.sketchId ? await db.vehicleSketch.findFirst({ where: { id: h.sketchId } }) : null;
  const rows = await db.signature.findMany({ where: { tenantId, handoverId }, orderBy: { signedAt: "asc" }, select: { id: true, role: true, signerName: true, signedAt: true, contentHash: true, imageData: true } });
  const signatures = validSignatures(rows, h.contentHash);
  const context = await loadHandoverContext(tenantId, h);
  const comparison = h.type === "RETURN" ? await loadSealedComparison(db, tenantId, h.id) : null;
  const driverChecks = h.type === "PICKUP" ? await driverCheckSummaries(tenantId, h.id) : [];
  return {
    doc: buildHandoverDocument(h, sketch, signatures, [...REQUIRED_PHOTO_CATEGORIES], context, comparison, driverChecks),
    bookingId: h.bookingId,
    handoverId: h.id,
    contractId: h.contractId,
    sourceHash: h.contentHash,
    signatureImages: new Map(signatures.flatMap((s) => (s.imageData ? [[s.id, s.imageData] as const] : []))),
    photoFiles: await photoFilesOf(tenantId, h),
    // Nur wenn die Datei noch genau der im Protokoll festgehaltenen Fassung entspricht, wird sie verwendet (siehe documents.ts)
    sketch: sketch && h.sketchAssetHash ? { assetPath: sketch.assetPath, assetHash: h.sketchAssetHash } : null,
  };
}

/**
 * Alle Fotos, die das versiegelte Protokoll zeigt: die zu diesem Protokoll hochgeladenen Fotos und die Fotoverweise der
 * Schadenzeilen. Vorschäden werden mit ihren Fotos aus früheren Protokollen oder von der Fahrzeugakte kopiert – diese Fotos
 * hängen nicht an diesem Protokoll, gehören aber zum Dokument. Speicherort und Prüfsumme kommen aus der Kopie im Protokoll,
 * nie aus dem Live-Foto; beim Laden wird nur eingebettet, was der Prüfsumme entspricht.
 */
async function photoFilesOf(tenantId: string, h: { photos: { id: string; storageKey: string; checksum: string; contentType: string }[]; damages: { photoRefs: Prisma.JsonValue }[] }) {
  const files = new Map(h.photos.map((p) => [p.id, { id: p.id, storageKey: p.storageKey, checksum: p.checksum, contentType: p.contentType }]));
  const refs = h.damages.flatMap((d) => (Array.isArray(d.photoRefs) ? (d.photoRefs as { photoId?: unknown; storageKey?: unknown; checksum?: unknown }[]) : []));
  const missing = refs.filter((r) => typeof r.photoId === "string" && typeof r.storageKey === "string" && typeof r.checksum === "string" && !files.has(r.photoId));
  if (missing.length > 0) {
    // Dateityp aus der Fototabelle (nur zur Information); ein inzwischen gelöschtes Foto wird trotzdem über die Kopie versucht
    const rows = await db.photo.findMany({ where: { tenantId, id: { in: missing.map((r) => r.photoId as string) } }, select: { id: true, contentType: true } });
    const types = new Map(rows.map((p) => [p.id, p.contentType]));
    for (const r of missing) {
      const id = r.photoId as string;
      if (!files.has(id)) files.set(id, { id, storageKey: r.storageKey as string, checksum: r.checksum as string, contentType: types.get(id) ?? "image/jpeg" });
    }
  }
  return [...files.values()];
}

export type InvoiceData = { doc: InvoiceDocumentData; bookingId: string; invoiceId: string; versionId: string; versionNo: number; sourceHash: string; renterEmail: string | null; documentType: "INVOICE" | "CREDIT_NOTE" | "CANCELLATION" };

/** Rechnungsfassung für Ansicht und PDF. Nur die versiegelte Fassung selbst; Nummer, Vertrags- und Buchungsnummer sind reine Verweise. */
export async function loadInvoiceDocumentData(tenantId: string, versionId: string, opts: { allowDraft?: boolean } = {}): Promise<InvoiceData> {
  const v = await db.invoiceVersion.findFirst({ where: { id: versionId, tenantId }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  if (!v) throw new DomainError("Rechnungsfassung nicht gefunden.");
  if (!opts.allowDraft && (v.status !== "FINALIZED" || !v.contentHash)) throw new DomainError("Ein Rechnungs-PDF gibt es erst, wenn die Rechnungsfassung abgeschlossen ist.");
  const inv = await db.invoice.findFirstOrThrow({ where: { id: v.invoiceId, tenantId } });
  const [booking, contract, ret, prev, damageCase] = await Promise.all([
    db.booking.findFirst({ where: { id: inv.bookingId, tenantId }, select: { number: true } }),
    inv.contractId ? db.rentalContract.findFirst({ where: { id: inv.contractId, tenantId }, select: { number: true } }) : null,
    inv.returnHandoverId ? db.handover.findFirst({ where: { id: inv.returnHandoverId, tenantId }, select: { number: true } }) : null,
    v.supersedesVersionId ? db.invoiceVersion.findFirst({ where: { id: v.supersedesVersionId, tenantId }, select: { versionNo: true, finalizedAt: true } }) : null,
    inv.damageCaseId ? db.damageCase.findFirst({ where: { id: inv.damageCaseId, tenantId }, select: { caseNumber: true } }) : null,
  ]);
  const c = v.customerSnapshot as { email?: string | null };
  const snap = inv.originalSnapshot as { number: string; issueDate: string | null; versionNo: number; grossTotal: string; customerName: string } | null;
  return {
    doc: buildInvoiceDocument(v, { number: inv.number, kind: inv.kind, contractNumber: contract?.number ?? null, bookingNumber: booking?.number ?? null, returnNumber: ret?.number ?? null, caseNumber: damageCase?.caseNumber ?? null, isCurrent: inv.currentVersionId === v.id, supersedes: prev, documentType: inv.documentType, original: inv.documentType !== "INVOICE" && snap ? { number: snap.number, issueDate: snap.issueDate, versionNo: snap.versionNo, grossTotal: snap.grossTotal, customerName: snap.customerName } : null }),
    bookingId: inv.bookingId,
    invoiceId: inv.id,
    versionId: v.id,
    versionNo: v.versionNo,
    sourceHash: v.contentHash ?? "",
    renterEmail: typeof c.email === "string" && c.email.trim() ? c.email.trim() : null,
    documentType: inv.documentType === "CREDIT_NOTE" || inv.documentType === "CANCELLATION" ? inv.documentType : "INVOICE",
  };
}

// ---------------------------------------------------------------------------
// Auszahlungsbeleg (Phase 18): versiegelter Auszahlungsdatensatz mit Quellen-Snapshot; Firmendaten aus den Einstellungen
// ---------------------------------------------------------------------------

export type PayoutData = { doc: PayoutDocumentData; bookingId: string; payoutId: string; sourceHash: string; recipientEmail: string | null };

export async function loadPayoutDocumentData(tenantId: string, payoutId: string, opts: { allowDraft?: boolean } = {}): Promise<PayoutData> {
  const p = await db.payout.findFirst({ where: { id: payoutId, tenantId } });
  if (!p) throw new DomainError("Auszahlung nicht gefunden.");
  if (!opts.allowDraft && (p.status === "DRAFT" || !p.contentHash)) throw new DomainError("Einen Auszahlungsbeleg gibt es erst, wenn die Auszahlung als erfolgt erfasst ist.");
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { ...TENANT_FIELDS, legalForm: true, website: true } });
  const snap = p.sourceSnapshot as { customerEmail?: string | null } | null;
  return { doc: buildPayoutDocument(p, tenant), bookingId: p.bookingId, payoutId: p.id, sourceHash: p.contentHash ?? "", recipientEmail: typeof snap?.customerEmail === "string" && snap.customerEmail.trim() ? snap.customerEmail.trim() : null };
}

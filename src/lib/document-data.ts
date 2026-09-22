// Lädt die Dokumentdaten für Mietvertrag und Übergabeprotokoll. Ansicht und PDF rufen beide diese Funktionen auf.
// Grundsatz: Gelesen werden nur die im Vertrag und im Protokoll gespeicherten Kopien (Snapshots) sowie die
// dazugehörigen, zum versiegelten Inhalt passenden Unterschriften. Kunden-, Fahrzeug-, Schaden-, Preis- oder
// Vorlagen-Stammdaten werden hier bewusst nicht angefasst.

import { db } from "@/lib/db";
import { REQUIRED_PHOTO_CATEGORIES } from "@/lib/constants";
import { buildContractDocument, landlordOf, type ContractDocumentData, type TenantLike } from "@/lib/contract-view";
import type { CustomerSnapshot, VehicleSnapshot } from "@/lib/contracts";
import { buildHandoverDocument, type HandoverContext, type HandoverDocumentData } from "@/lib/handover-view";
import { DomainError } from "@/lib/integrity";
import { loadSealedComparison } from "@/lib/returns";
import { buildInvoiceDocument, type InvoiceDocumentData } from "@/lib/invoice-view";

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
  return {
    doc: buildHandoverDocument(h, sketch, signatures, [...REQUIRED_PHOTO_CATEGORIES], context, comparison),
    bookingId: h.bookingId,
    handoverId: h.id,
    contractId: h.contractId,
    sourceHash: h.contentHash,
    signatureImages: new Map(signatures.flatMap((s) => (s.imageData ? [[s.id, s.imageData] as const] : []))),
    photoFiles: h.photos.map((p) => ({ id: p.id, storageKey: p.storageKey, checksum: p.checksum, contentType: p.contentType })),
    // Nur wenn die Datei noch genau der im Protokoll festgehaltenen Fassung entspricht, wird sie verwendet (siehe documents.ts)
    sketch: sketch && h.sketchAssetHash ? { assetPath: sketch.assetPath, assetHash: h.sketchAssetHash } : null,
  };
}

export type InvoiceData = { doc: InvoiceDocumentData; bookingId: string; invoiceId: string; sourceHash: string; renterEmail: string | null };

/** Rechnung für Ansicht und PDF. Nur die versiegelte Rechnung selbst; Vertrags- und Buchungsnummer sind reine Verweise. */
export async function loadInvoiceDocumentData(tenantId: string, invoiceId: string, opts: { allowDraft?: boolean } = {}): Promise<InvoiceData> {
  const inv = await db.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  if (!opts.allowDraft && (inv.status !== "FINALIZED" || !inv.contentHash)) throw new DomainError("Ein Rechnungs-PDF gibt es erst, wenn die Rechnung abgeschlossen ist.");
  const [booking, contract, ret] = await Promise.all([
    db.booking.findFirst({ where: { id: inv.bookingId, tenantId }, select: { number: true } }),
    inv.contractId ? db.rentalContract.findFirst({ where: { id: inv.contractId, tenantId }, select: { number: true } }) : null,
    inv.returnHandoverId ? db.handover.findFirst({ where: { id: inv.returnHandoverId, tenantId }, select: { number: true } }) : null,
  ]);
  const c = inv.customerSnapshot as { email?: string | null };
  return {
    doc: buildInvoiceDocument(inv, { contractNumber: contract?.number ?? null, bookingNumber: booking?.number ?? null, returnNumber: ret?.number ?? null }),
    bookingId: inv.bookingId,
    invoiceId: inv.id,
    sourceHash: inv.contentHash ?? "",
    renterEmail: typeof c.email === "string" && c.email.trim() ? c.email.trim() : null,
  };
}

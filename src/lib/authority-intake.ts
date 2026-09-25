// Posteingang für Behördenschreiben: Datei hochladen → privat speichern → Textebene lesen (nur PDF) → Vorschläge für das
// Erfassungsformular. Nichts davon legt einen Vorgang an oder ist verbindlich; erst „Vorgang anlegen“ übernimmt die vom
// Mitarbeiter geprüften Werte und hängt die Datei als „Behördenschreiben“ an den neuen Vorgang.

import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { extractPdfText, parseAuthorityLetter, type ExtractionSuggestion } from "@/lib/authority-extraction";
import { contactKey } from "@/lib/authority-contacts";
import { DomainError, sha256 } from "@/lib/integrity";
import { MAX_DOCUMENT_BYTES, buildStorageKey, getStorage, sniffDocumentType, type StorageDriver } from "@/lib/storage";

export type UploadResult = {
  id: string;
  fileName: string;
  contentType: string;
  /** PDF mit lesbarer Textebene */
  textFound: boolean;
  suggestion: ExtractionSuggestion;
  /** Hinweise auf mögliche Doppelerfassung */
  duplicates: { caseId: string; caseNumber: string; why: string }[];
};

/** Vorschläge nur aus bekannten, eigenen Daten: Flottenkennzeichen, Adressbuch, eigene Firmendaten (zum Ausschließen). */
async function extractionContext(tenantId: string) {
  const [vehicles, contacts, tenant] = await Promise.all([
    db.vehicle.findMany({ where: { tenantId }, select: { plate: true } }),
    db.authorityContact.findMany({ where: { tenantId }, select: { name: true, department: true, address: true, email: true, portalUrl: true } }),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, email: true, zip: true, street: true } }),
  ]);
  return { fleetPlates: vehicles.map((v) => v.plate), contacts, tenant };
}

export async function uploadAuthorityLetter(tenantId: string, actor: Actor, input: { bytes: Uint8Array; fileName: string }, opts: { storage?: StorageDriver } = {}): Promise<UploadResult> {
  const { bytes } = input;
  if (bytes.length === 0) throw new DomainError("Die Datei ist leer.");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new DomainError("Das Dokument ist zu groß (maximal 8 MB).");
  const contentType = sniffDocumentType(bytes);
  if (!contentType) throw new DomainError("Bitte ein PDF oder ein Bild (JPEG, PNG, WebP) hochladen.");
  const fileName = (input.fileName || "behoerdenschreiben").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
  const checksum = sha256(bytes);

  const text = contentType === "application/pdf" ? await extractPdfText(bytes) : "";
  const suggestion = text.trim() ? parseAuthorityLetter(text, await extractionContext(tenantId)) : {};

  const storage = opts.storage ?? getStorage();
  const storageKey = buildStorageKey({ tenantId, area: "documents", contentType });
  await storage.put(storageKey, bytes, contentType);
  let id: string;
  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.authorityUpload.create({ data: { tenantId, fileName, storageKey, contentType, sizeBytes: bytes.length, checksum, textLength: text.trim().length, suggestion: suggestion as object, createdById: actor.id, createdByName: actor.name } });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_LETTER_UPLOADED", details: { uploadId: created.id, contentType, textFound: text.trim().length > 0, fields: Object.keys(suggestion).join(",") } });
      return created;
    });
    id = row.id;
  } catch (e) {
    await storage.remove(storageKey).catch(() => {});
    throw e;
  }

  // Doppelerfassung: gleiche Datei schon an einem Vorgang oder gleiches Aktenzeichen bei derselben Behörde
  const duplicates: UploadResult["duplicates"] = [];
  const sameFile = await db.authorityCaseDocument.findMany({ where: { tenantId, checksum }, select: { case: { select: { id: true, caseNumber: true } } }, take: 3 });
  for (const d of sameFile) duplicates.push({ caseId: d.case.id, caseNumber: d.case.caseNumber, why: "dieselbe Datei wurde dort bereits hochgeladen" });
  const ref = suggestion.authorityReference?.value;
  if (ref) {
    const sameRef = await db.authorityCase.findMany({ where: { tenantId, authorityReference: { equals: ref, mode: "insensitive" }, status: { not: "CANCELLED" } }, select: { id: true, caseNumber: true, authorityName: true }, take: 3 });
    const name = suggestion.authorityName?.value;
    for (const c of sameRef) if (!duplicates.some((d) => d.caseId === c.id) && (!name || contactKey(c.authorityName) === contactKey(name))) duplicates.push({ caseId: c.id, caseNumber: c.caseNumber, why: `gleiches Aktenzeichen ${ref}` });
  }
  return { id, fileName, contentType, textFound: text.trim().length > 0, suggestion, duplicates };
}

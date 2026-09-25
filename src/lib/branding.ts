// Branding eines Mandanten (Befehl 20.5): Logo für neue PDFs und geschäftliche Mails. Firmenname, Anschrift, E-Mail,
// Telefon und Website kommen aus den vorhandenen Firmendaten – hier wird nichts doppelt gespeichert.
//
// Logo-Regeln:
// - nur PNG, JPEG, WebP (am Dateianfang erkannt, nicht am gemeldeten Typ), höchstens LOGO_MAX_BYTES
// - serverseitig vollständig neu kodiert (sharp): Metadaten (EXIF, GPS, ICC-Kommentare) fallen weg, Größe begrenzt,
//   Ergebnis immer PNG (pdfkit versteht kein WebP)
// - privat unter t/<mandant>/branding/…, nie überschrieben; Ersetzen/Entfernen lässt die alte Datei stehen, weil
//   eingefrorene Dokument-Snapshots (Vertrag, Rechnungsfassung, Behördenantwort) sie weiter referenzieren
// - gelesen wird nur mit Mandantenprüfung des Schlüssels und Prüfsummenvergleich

import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { LOGO_MAX_BYTES } from "@/lib/constants";
import { DomainError, sha256 } from "@/lib/integrity";
import { logoRefOf, type LogoRef } from "@/lib/branding-ref";
import { assertKeyBelongsToTenant, buildStorageKey, getStorage, sniffImageType, type StorageDriver } from "@/lib/storage";

export { logoRefFromSnapshot, logoRefOf, type LogoRef } from "@/lib/branding-ref";

const MAX_W = 800;
const MAX_H = 400;

/** Prüft und normalisiert ein hochgeladenes Logo. Wirft DomainError mit verständlicher Meldung. */
export async function normalizeLogo(bytes: Uint8Array): Promise<{ png: Buffer; width: number; height: number }> {
  if (bytes.length === 0) throw new DomainError("Es wurde keine Datei übertragen.");
  if (bytes.length > LOGO_MAX_BYTES) throw new DomainError(`Das Logo ist zu groß (höchstens ${Math.round(LOGO_MAX_BYTES / 1024 / 1024)} MB).`);
  if (!sniffImageType(bytes)) throw new DomainError("Bitte ein Logo als PNG, JPEG oder WebP hochladen.");
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" });
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16) throw new DomainError("Das Logo ist zu klein (mindestens 16 × 16 Pixel).");
    const { data, info } = await img.rotate().resize(MAX_W, MAX_H, { fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("Das Bild konnte nicht gelesen werden. Bitte eine andere Datei wählen.");
  }
}

/** Lädt ein neues Logo hoch (oder ersetzt das bisherige). Nur der eigene Mandant, der Schlüssel entsteht serverseitig. */
export async function uploadTenantLogo(tenantId: string, actor: Actor, bytes: Uint8Array, storage: StorageDriver = getStorage()): Promise<LogoRef> {
  const { png, width, height } = await normalizeLogo(bytes);
  const key = buildStorageKey({ tenantId, area: "branding", contentType: "image/png" });
  const checksum = sha256(png);
  await storage.put(key, png, "image/png");
  try {
    await db.$transaction(async (tx) => {
      const before = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { logoStorageKey: true } });
      await tx.tenant.update({ where: { id: tenantId }, data: { logoStorageKey: key, logoChecksum: checksum, logoUpdatedAt: new Date() } });
      await recordAudit(tx, tenantId, actor, { action: "TENANT_LOGO_UPDATED", details: { replaced: Boolean(before.logoStorageKey), width, height, sizeBytes: png.length } });
    });
  } catch (e) {
    await storage.remove(key).catch(() => {});
    throw e;
  }
  return { key, checksum };
}

/** Entfernt das Logo für künftige Dokumente und Mails. Die Datei bleibt für bereits eingefrorene Dokumente erhalten. */
export async function removeTenantLogo(tenantId: string, actor: Actor): Promise<void> {
  await db.$transaction(async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { logoStorageKey: true } });
    if (!t.logoStorageKey) return;
    await tx.tenant.update({ where: { id: tenantId }, data: { logoStorageKey: null, logoChecksum: null, logoUpdatedAt: new Date() } });
    await recordAudit(tx, tenantId, actor, { action: "TENANT_LOGO_REMOVED", details: {} });
  });
}

/** Liest ein Logo: nur aus dem Bereich des Mandanten und nur, wenn die Prüfsumme stimmt. Sonst null (Dokument ohne Logo). */
export async function loadLogo(tenantId: string, ref: LogoRef | null, storage?: StorageDriver): Promise<Uint8Array | null> {
  if (!ref) return null;
  try {
    assertKeyBelongsToTenant(ref.key, tenantId);
    const obj = await (storage ?? getStorage()).get(ref.key);
    if (!obj || sha256(obj.body) !== ref.checksum) return null;
    return obj.body;
  } catch {
    return null;
  }
}

/** Aktuelles Logo des Mandanten (für Vorschau und Mails). */
export async function currentLogo(tenantId: string, storage?: StorageDriver): Promise<Uint8Array | null> {
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { logoStorageKey: true, logoChecksum: true } });
  return loadLogo(tenantId, logoRefOf(t), storage);
}

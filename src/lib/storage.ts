// Vorbereitung für den privaten Hetzner Object Storage (S3-kompatibel).
// In dieser Phase nur: Schlüssel-Konvention, erlaubte Dateitypen und die Schnittstelle, gegen die
// Upload und Anzeige später gebaut werden. Noch kein SDK, kein Netzwerkzugriff.
//
// Regeln:
// - Der Bucket bleibt privat. In der Datenbank steht ausschließlich der storageKey, nie eine URL.
// - Anzeige und Upload laufen später über zeitlich begrenzte, signierte URLs (siehe StorageDriver).
// - Jeder Schlüssel beginnt mit dem Mandanten. Ein Schlüssel wird nie wiederverwendet oder überschrieben.

import { randomBytes } from "node:crypto";

export type StorageArea = "photos" | "signatures" | "documents" | "sketches";

export const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const SIGNED_URL_TTL_SECONDS = 300;

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

function safeSegment(s: string) {
  return s.replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * Eindeutiger Schlüssel, z. B. t/<tenant>/photos/2026/09/<booking>/<zufall>.jpg
 * Der Zufallsanteil verhindert, dass ein vorhandenes Objekt überschrieben wird.
 */
export function buildStorageKey(opts: { tenantId: string; area: StorageArea; bookingId?: string; contentType: string; at?: Date }): string {
  const ext = EXT[opts.contentType];
  if (!ext) throw new Error(`Dateityp ${opts.contentType} ist nicht erlaubt.`);
  const at = opts.at ?? new Date();
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const parts = ["t", safeSegment(opts.tenantId), opts.area, String(yyyy), mm];
  if (opts.bookingId) parts.push(safeSegment(opts.bookingId));
  parts.push(`${randomBytes(12).toString("hex")}.${ext}`);
  return parts.join("/");
}

/** Prüft, dass ein Schlüssel zum Mandanten gehört. Vor jedem Lesen oder Signieren aufrufen. */
export function assertKeyBelongsToTenant(storageKey: string, tenantId: string) {
  if (!storageKey.startsWith(`t/${safeSegment(tenantId)}/`)) throw new Error("Zugriff auf fremden Speicherbereich verweigert.");
}

/** Schnittstelle für die spätere Anbindung. Eine Implementierung für Hetzner, eine für lokale Entwicklung. */
export interface StorageDriver {
  /** Signierte URL, mit der das Handy direkt in den Bucket hochlädt. */
  createUploadUrl(key: string, contentType: string, maxBytes: number): Promise<{ url: string; expiresAt: Date }>;
  /** Signierte URL zum Anzeigen oder Herunterladen. */
  createDownloadUrl(key: string, ttlSeconds?: number): Promise<{ url: string; expiresAt: Date }>;
  /** Größe und Prüfsumme des gespeicherten Objekts, zur Kontrolle nach dem Upload. */
  stat(key: string): Promise<{ sizeBytes: number; checksumSha256: string } | null>;
  /** Server legt selbst ein Objekt ab, z. B. ein erzeugtes PDF. Überschreibt nie. */
  putImmutable(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

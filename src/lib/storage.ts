// Privater Dateispeicher für Fotos, Unterschriften und Dokumente.
//
// Regeln:
// - Der Bucket bleibt privat. In der Datenbank steht ausschließlich der storageKey, nie eine URL.
// - Dateien werden nur über den App-Server gelesen und geschrieben, nach Prüfung von Sitzung und Mandant.
//   Es gibt keine öffentlichen Adressen und keine Adressen, die man weitergeben könnte.
// - Jeder Schlüssel beginnt mit dem Mandanten. Ein Schlüssel wird nie wiederverwendet oder überschrieben.
// - Produktion: ausschließlich S3-kompatibler Object Storage (Hetzner). Fehlt die Konfiguration,
//   werden Uploads abgelehnt. Der lokale Treiber ist nur für Entwicklung und Tests zugelassen.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "@/lib/integrity";

export type StorageArea = "photos" | "signatures" | "documents" | "sketches";

export const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
// Unter der 10-MB-Grenze, bis zu der Next.js Anfragen hinter dem Proxy puffert. Die App verkleinert Fotos vor dem Upload ohnehin.
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

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

/** Prüft, dass ein Schlüssel zum Mandanten gehört. Vor jedem Lesen oder Schreiben aufrufen. */
export function assertKeyBelongsToTenant(storageKey: string, tenantId: string) {
  if (!storageKey.startsWith(`t/${safeSegment(tenantId)}/`) || storageKey.includes("..")) throw new Error("Zugriff auf fremden Speicherbereich verweigert.");
}

/** Erkennt den Bildtyp am Dateianfang. Der vom Browser gemeldete Typ wird nicht geglaubt. */
export function sniffImageType(bytes: Uint8Array): (typeof ALLOWED_PHOTO_TYPES)[number] | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export interface StorageDriver {
  readonly name: "s3" | "local";
  /** Legt ein Objekt ab. Überschreibt nie: existiert der Schlüssel, ist das ein Fehler. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Liest ein Objekt vollständig. null, wenn es nicht existiert. */
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** Entfernt ein Objekt, z. B. ein im Entwurf wieder gelöschtes Foto. */
  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hetzner Object Storage (S3-kompatibel)
// ---------------------------------------------------------------------------

type S3Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };

export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) return null;
  return { endpoint: S3_ENDPOINT, region: S3_REGION || "eu-central", bucket: S3_BUCKET, accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY };
}

class S3StorageDriver implements StorageDriver {
  readonly name = "s3" as const;
  private client: import("@aws-sdk/client-s3").S3Client | null = null;
  constructor(private cfg: S3Config) {}

  private async s3() {
    const sdk = await import("@aws-sdk/client-s3");
    this.client ??= new sdk.S3Client({
      endpoint: this.cfg.endpoint,
      region: this.cfg.region,
      forcePathStyle: true, // bucket im Pfad, funktioniert mit jedem S3-kompatiblen Anbieter
      credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
    });
    return { sdk, client: this.client };
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    const { sdk, client } = await this.s3();
    // Schlüssel enthalten 96 Bit Zufall und werden nie wiederverwendet; ein Überschreiben ist damit praktisch ausgeschlossen.
    // Auf bedingtes Schreiben (If-None-Match) wird verzichtet, weil nicht jeder S3-kompatible Anbieter es unterstützt.
    await client.send(new sdk.PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string) {
    const { sdk, client } = await this.s3();
    try {
      const res = await client.send(new sdk.GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      if (!res.Body) return null;
      return { body: await res.Body.transformToByteArray(), contentType: res.ContentType ?? "application/octet-stream" };
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey" || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async remove(key: string) {
    const { sdk, client } = await this.s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

// ---------------------------------------------------------------------------
// Lokaler Treiber: nur Entwicklung und Tests. Schreibt nach .storage/ (in .gitignore).
// ---------------------------------------------------------------------------

class LocalStorageDriver implements StorageDriver {
  readonly name = "local" as const;
  constructor(private root: string) {}

  private file(key: string) {
    if (key.includes("..") || path.isAbsolute(key)) throw new Error("Ungültiger Speicherschlüssel.");
    return path.join(this.root, ...key.split("/"));
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    const f = this.file(key);
    if (await stat(f).then(() => true, () => false)) throw new Error("Objekt existiert bereits.");
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
    await writeFile(`${f}.type`, contentType);
  }

  async get(key: string) {
    const f = this.file(key);
    try {
      return { body: new Uint8Array(await readFile(f)), contentType: (await readFile(`${f}.type`, "utf8")).trim() };
    } catch {
      return null;
    }
  }

  async remove(key: string) {
    const f = this.file(key);
    await unlink(f).catch(() => {});
    await unlink(`${f}.type`).catch(() => {});
  }
}

let cached: StorageDriver | null = null;

/** Beschreibt den Speicherzustand für Oberfläche und Diagnose, ohne Zugangsdaten preiszugeben. */
export function storageStatus(env: NodeJS.ProcessEnv = process.env): { configured: boolean; driver: "s3" | "local" | "none"; missing: string[] } {
  const missing = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"].filter((k) => !env[k]);
  if (missing.length === 0) return { configured: true, driver: "s3", missing: [] };
  if (env.NODE_ENV !== "production") return { configured: true, driver: "local", missing };
  return { configured: false, driver: "none", missing };
}

/**
 * Liefert den Speichertreiber. In Produktion ohne vollständige S3-Konfiguration wird abgelehnt:
 * lieber kein Upload als Fotos von Ausweisen und Fahrzeugen an einem ungeeigneten Ort.
 */
export function getStorage(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  if (cached && env === process.env) return cached;
  const cfg = readS3Config(env);
  let driver: StorageDriver;
  if (cfg) driver = new S3StorageDriver(cfg);
  else if (env.NODE_ENV !== "production") driver = new LocalStorageDriver(path.resolve(/* turbopackIgnore: true */ env.LOCAL_STORAGE_DIR || ".storage"));
  else throw new DomainError("Der Dateispeicher ist noch nicht eingerichtet. Fotos können erst hochgeladen werden, wenn der Object Storage in den Servereinstellungen hinterlegt ist.");
  if (env === process.env) cached = driver;
  return driver;
}

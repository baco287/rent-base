// Gemeinsame Bausteine für die Sicherung der Dateien und die Prüfung einer Wiederherstellung.
// Läuft mit reinem Node im App-Container (ohne TypeScript), siehe docs/backup.md.

import { createHash } from "node:crypto";
// Im Standalone-Build liegt nur der CommonJS-Build des SDK, daher der Default-Import.
import s3sdk from "@aws-sdk/client-s3";

const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = s3sdk;

/** Präfix im Backup-Bucket, unter dem die Dateien der App liegen. Die Datenbank-Backups von Coolify liegen getrennt davon. */
export const FILES_PREFIX = "files/";
/** Merkliste im Backup-Bucket: seit wann eine gesicherte Datei im App-Bucket fehlt. */
export const MISSING_STATE_KEY = "files-state/missing.json";
/** So lange bleibt eine in der App gelöschte Datei noch im Backup. Gleich lang wie die Datenbank-Backups in S3. */
export const DEFAULT_GRACE_DAYS = 30;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Liest die Zugangsdaten eines Buckets aus der Umgebung.
 * prefix "" ergibt den App-Bucket (S3_*), prefix "BACKUP_" den Backup-Bucket (BACKUP_S3_*).
 */
export function readBucketConfig(env, prefix) {
  const names = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"].map((n) => prefix + n);
  const missing = names.filter((n) => !env[n]);
  if (missing.length) return { missing };
  return {
    missing: [],
    endpoint: env[`${prefix}S3_ENDPOINT`],
    region: env[`${prefix}S3_REGION`] || "eu-central",
    bucket: env[`${prefix}S3_BUCKET`],
    accessKeyId: env[`${prefix}S3_ACCESS_KEY`],
    secretAccessKey: env[`${prefix}S3_SECRET_KEY`],
  };
}

/** Bucket-Zugriff mit denselben Einstellungen wie src/lib/storage.ts. */
export function s3Bucket(cfg) {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    label: `${cfg.bucket} (${cfg.endpoint})`,

    /** Alle Objekte unter prefix als Map: Schlüssel ohne prefix -> Größe in Bytes. */
    async list(prefix = "") {
      const out = new Map();
      let token;
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix || undefined, ContinuationToken: token }));
        for (const o of res.Contents ?? []) out.set(o.Key.slice(prefix.length), o.Size ?? 0);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        if (!res.Body) return null;
        return { body: await res.Body.transformToByteArray(), contentType: res.ContentType ?? "application/octet-stream" };
      } catch (e) {
        if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },

    async put(key, body, contentType, metadata = {}) {
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata }));
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
  };
}

/** Führt fn für alle Einträge aus, höchstens limit gleichzeitig. */
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Kopiert alle Objekte, die im Ziel fehlen. Löscht nie etwas.
 * Schlüssel in der App werden nie wiederverwendet, ein vorhandenes Objekt gleicher Größe ist deshalb dieselbe Datei.
 * replaceDifferent: ein Zielobjekt mit abweichender Größe gilt als beschädigt und wird neu geschrieben (nur für den Backup-Bucket).
 * Jede Kopie bekommt die SHA-256-Prüfsumme als Metadatum mit, damit sie sich später gegen die Datenbank prüfen lässt.
 */
export async function copyMissing({ from, fromPrefix = "", to, toPrefix = "", replaceDifferent = false, concurrency = 4, log = () => {} }) {
  const source = await from.list(fromPrefix);
  const target = await to.list(toPrefix);
  const todo = [...source].filter(([key, size]) => !target.has(key) || (replaceDifferent && target.get(key) !== size));
  log(`${source.size} Objekte in der Quelle, ${source.size - todo.length} bereits vorhanden, ${todo.length} zu kopieren.`);

  let copied = 0;
  let bytes = 0;
  const failed = [];
  await eachLimited(todo, concurrency, async ([key, size]) => {
    try {
      const obj = await from.get(fromPrefix + key);
      if (!obj) throw new Error("in der Quelle nicht mehr vorhanden");
      if (obj.body.length !== size) throw new Error(`gelesen ${obj.body.length} Bytes statt ${size}`);
      await to.put(toPrefix + key, obj.body, obj.contentType, { sha256: sha256Hex(obj.body) });
      copied++;
      bytes += size;
      if (copied % 200 === 0) log(`… ${copied} von ${todo.length} kopiert`);
    } catch (e) {
      failed.push({ key, error: e?.message ?? String(e) });
    }
  });
  return { total: source.size, alreadyPresent: source.size - todo.length, copied, bytes, failed };
}

/**
 * Entfernt aus dem Backup, was in der App gelöscht wurde, aber erst nach graceDays.
 *
 * Die App löscht Dateien bewusst, z. B. Führerscheinkopien aus Datenschutzgründen oder verworfene Entwurfsfotos.
 * Ein Backup, das nur hinzufügt, würde diese Löschung unterlaufen. Sofort mitlöschen wäre aber gefährlich: Ein Fehler
 * oder ein Angriff im App-Bucket wäre dann auch im Backup verloren. Deshalb merkt sich die Sicherung, seit wann eine
 * Datei fehlt, und löscht sie erst nach der Frist. Innerhalb der Frist kann eine Datenbank-Sicherung die Datei noch
 * brauchen, nach der Frist gibt es keine solche Sicherung mehr.
 *
 * Schutzschwelle: Fehlen auf einmal ungewöhnlich viele Dateien (falscher Bucket, leere Antwort, Angriff), wird nichts
 * vorgemerkt und nichts gelöscht, sondern abgebrochen. maxNewShare ist der erlaubte Anteil neu fehlender Dateien.
 */
export async function pruneDeleted({ source, sourcePrefix = "", backup, backupPrefix = FILES_PREFIX, stateKey = MISSING_STATE_KEY, graceDays = DEFAULT_GRACE_DAYS, now = new Date(), maxNewShare = 0.1, minNewAbsolute = 20, log = () => {} }) {
  const inSource = await source.list(sourcePrefix);
  const inBackup = await backup.list(backupPrefix);
  const stateObj = await backup.get(stateKey);
  const state = stateObj ? JSON.parse(new TextDecoder().decode(stateObj.body)) : {};

  const missing = [...inBackup.keys()].filter((key) => !inSource.has(key));
  const newlyMissing = missing.filter((key) => !state[key]);
  const limit = Math.max(minNewAbsolute, Math.floor(inBackup.size * maxNewShare));
  if (newlyMissing.length > limit) {
    throw new Error(`${newlyMissing.length} von ${inBackup.size} gesicherten Dateien fehlen neu im App-Bucket (erlaubt: ${limit}). Zur Sicherheit wurde nichts vorgemerkt und nichts gelöscht. Bitte App-Bucket und Zugangsdaten prüfen.`);
  }

  const cutoff = now.getTime() - graceDays * 86_400_000;
  const nextState = {};
  const failed = [];
  let deleted = 0;
  for (const key of missing) {
    const since = state[key] ?? now.toISOString();
    if (Date.parse(since) <= cutoff) {
      try {
        await backup.remove(backupPrefix + key);
        deleted++;
        continue;
      } catch (e) {
        failed.push({ key, error: e?.message ?? String(e) });
      }
    }
    nextState[key] = since;
  }
  const body = new TextEncoder().encode(JSON.stringify(nextState));
  await backup.put(stateKey, body, "application/json");
  log(`${missing.length} gesicherte Dateien fehlen in der App (${newlyMissing.length} neu), ${deleted} nach ${graceDays} Tagen aus dem Backup entfernt.`);
  return { missing: missing.length, newlyMissing: newlyMissing.length, deleted, pending: Object.keys(nextState).length, failed };
}

// Aufräumlauf für Dateien bereits gelöschter Ausweis- und Führerscheinkopien (DriverDocumentCopy, deletionStatus DELETED).
// Läuft mit reinem Node im App-Container (ohne TypeScript), siehe scripts/cleanup-driver-copies.mjs und docs/backup.md.
//
// Normalerweise entfernt die App die Datei direkt nach dem Löschen (Storno: removeCancellationFiles). Bricht der Prozess
// zwischen Datenbank-Commit und Dateilöschung ab oder ist der Speicher gerade nicht erreichbar, bleibt die Datei liegen,
// obwohl die Zeile schon DELETED ist. Dieser Lauf richtet sich ausschließlich nach der Datenbank und holt das nach:
// - berücksichtigt nur Zeilen mit deletionStatus = 'DELETED', je Mandant;
// - löscht nur Schlüssel im Kopienbereich desselben Mandanten (t/<Mandant>/driver-verifications/…), nie etwas anderes;
// - verweigert Schlüssel, die eine aktive Kopie verwendet (doppelt abgesichert, storageKey ist ohnehin eindeutig);
// - listet je Mandant einmal auf und löscht nur, was wirklich noch da ist (kein Löschmarker bei versioniertem Bucket),
//   danach wird erneut aufgelistet und bestätigt, dass die Datei weg ist;
// - Fehlschläge stehen im Audit-Log (STORAGE_FILE_REMOVAL_FAILED) und im Ergebnis; ein erneuter Lauf ist unschädlich.

export const COPY_AREA = "driver-verifications";
const safeSegment = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "");

/** Präfix der Kopien eines Mandanten im App-Bucket (wie buildStorageKey in src/lib/storage.ts). */
export function copyPrefix(tenantId) {
  return `t/${safeSegment(tenantId)}/${COPY_AREA}/`;
}

/**
 * @typedef {{ list(prefix: string): Promise<Map<string, number>>; remove(key: string): Promise<void> }} CleanupBucket
 * @typedef {{ copyId: string; tenantId: string; storageKey: string; reason: string }} Refusal
 * @typedef {{ copyId: string; tenantId: string; storageKey: string; error: string }} Failure
 * @typedef {{ tenants: number; checked: number; removed: number; wouldRemove: number; alreadyGone: number; refused: Refusal[]; failed: Failure[] }} SweepResult
 */

/**
 * Warum ein Schlüssel nicht gelöscht werden darf (null = darf). Reine Regel, ohne Datenbank und Speicher.
 * @param {string} storageKey @param {string} tenantId @param {Set<string>} activeKeys @returns {string | null}
 */
export function refusalOf(storageKey, tenantId, activeKeys) {
  if (typeof storageKey !== "string" || storageKey.length === 0) return "kein Speicherschlüssel";
  if (storageKey.includes("..") || storageKey.startsWith("/")) return "ungültiger Speicherschlüssel";
  if (!storageKey.startsWith(copyPrefix(tenantId))) return "Schlüssel liegt nicht im Kopienbereich dieses Mandanten";
  if (activeKeys.has(storageKey)) return "Schlüssel wird von einer aktiven Kopie verwendet";
  return null;
}

/**
 * Räumt die Dateien gelöschter Kopien auf.
 * db: PrismaClient; bucket: { list(prefix) -> Map(Schlüssel ohne Präfix -> Größe), remove(key) } (scripts/backup-lib.mjs s3Bucket).
 * tenantId: nur diesen Mandanten; sonst alle Mandanten mit gelöschten Kopien. dryRun: nur berichten, nichts löschen.
 * @param {{ db: any; bucket: CleanupBucket; tenantId?: string | null; dryRun?: boolean; log?: (m: string) => void }} opts
 * @returns {Promise<SweepResult>}
 */
export async function sweepDeletedCopyFiles({ db, bucket, tenantId = null, dryRun = false, log = () => {} }) {
  /** @type {string[]} */
  const tenants = tenantId
    ? [tenantId]
    : (await db.driverDocumentCopy.findMany({ where: { deletionStatus: "DELETED" }, distinct: ["tenantId"], select: { tenantId: true }, orderBy: { tenantId: "asc" } })).map((/** @type {{ tenantId: string }} */ r) => r.tenantId);
  /** @type {SweepResult} */
  const result = { tenants: tenants.length, checked: 0, removed: 0, wouldRemove: 0, alreadyGone: 0, refused: [], failed: [] };

  for (const tenant of tenants) {
    const rows = await db.driverDocumentCopy.findMany({ where: { tenantId: tenant, deletionStatus: "DELETED" }, select: { id: true, tenantId: true, bookingId: true, storageKey: true }, orderBy: { id: "asc" } });
    if (rows.length === 0) continue;
    result.checked += rows.length;
    const keys = rows.map((r) => r.storageKey);
    const activeKeys = new Set((await db.driverDocumentCopy.findMany({ where: { storageKey: { in: keys }, deletionStatus: { not: "DELETED" } }, select: { storageKey: true } })).map((r) => r.storageKey));
    const prefix = copyPrefix(tenant);

    let existing;
    try {
      existing = await bucket.list(prefix);
    } catch (e) {
      // Ohne Auflistung wird für diesen Mandanten nichts gelöscht; die Zeilen gelten als fehlgeschlagen und werden beim nächsten Lauf erneut versucht
      for (const r of rows) await fail(db, result, r, `Auflisten fehlgeschlagen: ${messageOf(e)}`, log);
      continue;
    }

    const attempted = [];
    for (const r of rows) {
      const refusal = refusalOf(r.storageKey, tenant, activeKeys);
      if (refusal) {
        result.refused.push({ copyId: r.id, tenantId: tenant, storageKey: r.storageKey, reason: refusal });
        log(`Verweigert ${r.id}: ${refusal}`);
        continue;
      }
      const rel = r.storageKey.slice(prefix.length);
      if (!existing.has(rel)) { result.alreadyGone++; continue; }
      if (dryRun) { result.wouldRemove++; continue; }
      try {
        await bucket.remove(r.storageKey);
        attempted.push(r);
      } catch (e) {
        await fail(db, result, r, messageOf(e), log);
      }
    }

    if (attempted.length > 0) {
      // Bestätigen: was gelöscht wurde, darf beim erneuten Auflisten nicht mehr da sein
      let after;
      try {
        after = await bucket.list(prefix);
      } catch (e) {
        for (const r of attempted) await fail(db, result, r, `Bestätigung fehlgeschlagen: ${messageOf(e)}`, log);
        continue;
      }
      for (const r of attempted) {
        if (after.has(r.storageKey.slice(prefix.length))) await fail(db, result, r, "Datei nach dem Löschen weiterhin vorhanden", log);
        else result.removed++;
      }
    }
  }
  return result;
}

function messageOf(e) {
  return String(e?.message ?? e).slice(0, 200);
}

async function fail(db, result, row, error, log) {
  result.failed.push({ copyId: row.id, tenantId: row.tenantId, storageKey: row.storageKey, error });
  log(`Fehler ${row.id} (${row.storageKey}): ${error}`);
  try {
    await db.auditLog.create({
      data: { tenantId: row.tenantId, action: "STORAGE_FILE_REMOVAL_FAILED", bookingId: row.bookingId, userName: "Aufräumlauf", details: { kind: "DRIVER_COPY", storageKey: row.storageKey, copyId: row.id, error, source: "cleanup-driver-copies" } },
    });
  } catch (e) {
    log(`Fehlschlag nicht im Audit-Log gespeichert (${row.id}): ${messageOf(e)}`);
  }
}

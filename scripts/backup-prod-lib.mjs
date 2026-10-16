// Regeln und Abläufe für den produktiven Backup-Bucket im Übergangsweg (docs/backup-uebergang.md): erwartete Standard-Sperre
// und Lifecycle-Regeln, die Einrichtung (scripts/backup-prod-setup.mjs) und der lesende Prüflauf (scripts/backup-check.mjs).
// Läuft mit reinem Node im App-Container oder in einem Wegwerf-Container auf dem Server (scripts/backup-prod-run.sh).
//
// Grundsätze:
// - Der Prüflauf schickt nur lesende Anfragen (Get, Head, List).
// - Die Einrichtung ändert nur Bucket-Einstellungen: Standard-Sperre, Lifecycle-Regeln und, nur im Modus „wiederherstellen“,
//   Bucket-Policy (entfernen) und Bucket-ACL (privat). Sie löscht nie Objekte oder Fassungen. Abweichende Einstellungen
//   überschreibt sie nur im Modus „wiederherstellen“, und nur mit dem vorgesehenen Stand.
// - Ausgegeben werden nur Bucket- und Objektnamen, Zähler, Größen und Zeitpunkte, nie Zugangsdaten. Fehler erscheinen als Name,
//   Netzwerk-Code und HTTP-Status.

// Im Standalone-Build liegt nur der CommonJS-Build des SDK, daher der Default-Import.
import s3sdk from "@aws-sdk/client-s3";
import { FILES_PREFIX, MISSING_STATE_KEY, storageArea } from "./backup-lib.mjs";

const {
  S3Client, ListBucketsCommand, GetBucketVersioningCommand, GetObjectLockConfigurationCommand, PutObjectLockConfigurationCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand, GetBucketPolicyCommand, DeleteBucketPolicyCommand,
  ListObjectsV2Command, ListObjectVersionsCommand, ListMultipartUploadsCommand, GetObjectRetentionCommand,
  GetBucketAclCommand, PutBucketAclCommand, GetObjectAclCommand,
} = s3sdk;

export const LOCK_MODE = "COMPLIANCE";
export const LOCK_DAYS = 30;
export const DUMP_EXPIRATION_DAYS = 31;
export const DUMP_NONCURRENT_DAYS = 1;
export const FILES_NONCURRENT_DAYS = 7;
export const STATE_NONCURRENT_DAYS = 1;
export const MPU_ABORT_DAYS = 7;
/** Erwartetes Präfix der Coolify-Dumps: Coolify lädt nach <Bucket>/<Backup-Verzeichnis auf dem Server>/ hoch. */
export const COOLIFY_DUMP_ROOT = "data/coolify/backups/";
/** Die Einrichtung duldet den Test-Bucket im selben Projekt, falls der Produktions-Bucket doch im Test-Projekt liegt. */
export const ALLOWED_OTHER_BUCKETS = ["rent-base-backup-test"];
/** Bereiche, in denen die Dateisicherung legitim löscht (scripts/backup-lib.mjs, makeIsPrunable). */
const PRUNABLE_AREAS = ["photos", "driver-verifications"];

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Die Standard-Sperre, die jede hochgeladene Fassung 30 Tage unlöschbar macht, auch für den Kontoinhaber. */
export function expectedLockConfiguration() {
  return { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: LOCK_MODE, Days: LOCK_DAYS } } };
}

/** Zustand der Sperr-Einstellung: "aus" (Object Lock nicht aktiviert), "ohne-standard", "richtig" oder "abweichend". */
export function lockState(cfg) {
  if (cfg?.ObjectLockEnabled !== "Enabled") return { state: "aus", text: "Object Lock ist nicht aktiviert" };
  const r = cfg.Rule?.DefaultRetention;
  if (!r) return { state: "ohne-standard", text: "Object Lock aktiviert, aber keine Standard-Sperre" };
  if (r.Mode === LOCK_MODE && r.Days === LOCK_DAYS && r.Years == null) return { state: "richtig", text: `${LOCK_MODE} ${LOCK_DAYS} Tage` };
  return { state: "abweichend", text: `${r.Mode ?? "ohne Modus"}, ${r.Days ?? "–"} Tage, ${r.Years ?? "–"} Jahre` };
}

/** Prüft das Präfix der Coolify-Dumps. Liefert eine Fehlerbeschreibung oder null. */
export function validateDumpPrefix(prefix) {
  if (typeof prefix !== "string" || prefix === "") return "fehlt";
  if (prefix.length > 512) return "ist zu lang";
  if (!/^[A-Za-z0-9._\/-]+$/.test(prefix)) return "enthält unerlaubte Zeichen (erlaubt: Buchstaben, Ziffern, . _ - /)";
  if (!prefix.endsWith("/")) return "muss mit / enden";
  if (prefix.startsWith("/")) return "darf nicht mit / beginnen";
  if (prefix.includes("//") || prefix.split("/").some((part) => part === "." || part === "..")) return "enthält leere oder relative Pfadteile";
  if (prefix.startsWith(FILES_PREFIX) || prefix.startsWith("files-state/")) return "überschneidet sich mit der Dateisicherung";
  return null;
}

/** Die Lifecycle-Regeln aus docs/backup.md, mit dem Präfix der Coolify-Dumps. */
export function expectedLifecycleRules(dumpPrefix) {
  return [
    { ID: "dateien-alte-versionen", Status: "Enabled", Filter: { Prefix: FILES_PREFIX },
      NoncurrentVersionExpiration: { NoncurrentDays: FILES_NONCURRENT_DAYS }, Expiration: { ExpiredObjectDeleteMarker: true } },
    { ID: "merkliste", Status: "Enabled", Filter: { Prefix: "files-state/" },
      NoncurrentVersionExpiration: { NoncurrentDays: STATE_NONCURRENT_DAYS } },
    { ID: "datenbank-dumps", Status: "Enabled", Filter: { Prefix: dumpPrefix },
      Expiration: { Days: DUMP_EXPIRATION_DAYS }, NoncurrentVersionExpiration: { NoncurrentDays: DUMP_NONCURRENT_DAYS } },
    { ID: "abgebrochene-uploads", Status: "Enabled", Filter: { Prefix: "" },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: MPU_ABORT_DAYS } },
  ];
}

/** Vergleichbare Form einer Regelliste. Hetzner darf die Darstellung ändern (Reihenfolge, Filter-Form, false statt fehlend). */
export function normalizeRules(rules) {
  return (rules ?? []).map((r) => {
    const f = r.Filter ?? {};
    const extraFilter = f.Tag != null || f.ObjectSizeGreaterThan != null || f.ObjectSizeLessThan != null
      || (f.And != null && ((f.And.Tags?.length ?? 0) > 0 || f.And.ObjectSizeGreaterThan != null || f.And.ObjectSizeLessThan != null));
    return {
      id: r.ID ?? "",
      status: r.Status ?? "",
      prefix: f.Prefix ?? f.And?.Prefix ?? r.Prefix ?? "",
      extraFilter,
      expirationDays: r.Expiration?.Days ?? null,
      expirationDate: r.Expiration?.Date ? new Date(r.Expiration.Date).toISOString() : null,
      expiredDeleteMarker: r.Expiration?.ExpiredObjectDeleteMarker === true,
      noncurrentDays: r.NoncurrentVersionExpiration?.NoncurrentDays ?? null,
      newerNoncurrent: r.NoncurrentVersionExpiration?.NewerNoncurrentVersions ?? null,
      abortDays: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
      transitions: (r.Transitions?.length ?? 0) + (r.NoncurrentVersionTransitions?.length ?? 0) + (r.Transition ? 1 : 0) + (r.NoncurrentVersionTransition ? 1 : 0),
    };
  }).sort((a, b) => a.id.localeCompare(b.id) || a.prefix.localeCompare(b.prefix));
}

export function sameRules(actual, expected) {
  return JSON.stringify(normalizeRules(actual)) === JSON.stringify(normalizeRules(expected));
}

/** Bereich eines Schlüssels für die Lifecycle-Auswertung. */
export function areaOf(key, dumpPrefix) {
  if (key.startsWith(dumpPrefix)) return "dumps";
  if (key.startsWith("files-state/")) return "merkliste";
  if (key.startsWith(FILES_PREFIX)) return "dateien";
  return "sonstige";
}

const AREA_LABEL = { dumps: "Dumps", dateien: "Dateien", merkliste: "Merkliste", sonstige: "außerhalb der Regeln" };

/**
 * @typedef {{ Key: string, LastModified: Date | string, IsLatest?: boolean, Size?: number, ETag?: string, VersionId?: string }} VersionEntry
 * @typedef {{ key: string, lm: number, size: number, versionId?: string }} CurrentEntry
 * @typedef {{ versions: number, markers: number, bytes: number, overdue: { key: string, days: number }[],
 *   premature: { key: string, at: number }[], deleted: { key: string, at: number }[], overwritten: { key: string, at: number }[],
 *   duplicates: number, staleMarkers: number, current: CurrentEntry[] }} AreaReport
 * @typedef {{ send: (command: any) => Promise<any> }} S3Like
 */

/**
 * Wertet Fassungen und Löschmarker je Bereich aus. Listen enthalten { key, days } bzw. { key, at } für die Meldung und das
 * Quittieren (BACKUP_CHECK_BEKANNT).
 * - overdue: Fassungen, die nach den Lifecycle-Regeln und nach Ablauf der Sperre schon weg sein müssten, mit Puffer für Hetzners
 *   Verzögerung (am 14.10.2026 rund 2 Tage). Für Dumps zählt das eigene Hochladedatum (Ablauf nach 31 Tagen, endgültig einen Tag
 *   später), damit sich Verzögerungen der beiden Stufen nicht addieren. Das ist die überwachte Datenschutzfrist.
 * - premature: Löschmarker auf Dumps, die jünger als die Lifecycle-Frist sind. Coolify löscht mit S3-Aufbewahrung 0/0/0 nichts.
 * - deleted: Löschmarker auf gesicherten Dateien außerhalb von photos/ und driver-verifications/. Nur dort löscht die
 *   Dateisicherung legitim; Verträge, Protokolle, Unterschriften, Dokumente und Logos löscht sie nie.
 * - overwritten: eine Fassung direkt unter einer neueren Fassung desselben Schlüssels. Coolify (eindeutige Namen) und die
 *   Dateisicherung (überschreibt nie) erzeugen das nicht. Unter files/ zählt gleicher Inhalt (Größe und ETag) nur als duplicate,
 *   z. B. aus zwei überlappenden Läufen der Dateisicherung. Die Merkliste wird planmäßig überschrieben.
 * - staleMarkers: Löschmarker unter files/ ohne ältere Fassung, die länger liegen, als die Regeln brauchen (nur Hinweis).
 * - current: aktuelle Fassungen (für Sperre und ACL).
 */
/**
 * @param {{ versions?: VersionEntry[], deleteMarkers?: VersionEntry[], now: Date, dumpPrefix: string, bufferDays?: number }} args
 * @returns {Record<"dumps" | "dateien" | "merkliste" | "sonstige", AreaReport>}
 */
export function evaluateVersions({ versions = [], deleteMarkers = [], now, dumpPrefix, bufferDays = 7 }) {
  const nowMs = now.getTime();
  const byKey = new Map();
  const add = (e) => {
    const list = byKey.get(e.key) ?? [];
    list.push(e);
    byKey.set(e.key, list);
  };
  for (const v of versions) add({ key: v.Key, lm: new Date(v.LastModified).getTime(), latest: v.IsLatest === true, marker: false, size: v.Size ?? 0, etag: v.ETag ?? "", versionId: v.VersionId });
  for (const m of deleteMarkers) add({ key: m.Key, lm: new Date(m.LastModified).getTime(), latest: m.IsLatest === true, marker: true });

  const areas = /** @type {Record<"dumps" | "dateien" | "merkliste" | "sonstige", AreaReport>} */ ({});
  for (const name of Object.keys(AREA_LABEL)) {
    areas[name] = { versions: 0, markers: 0, bytes: 0, overdue: [], premature: [], deleted: [], overwritten: [], duplicates: 0, staleMarkers: 0, current: [] };
  }
  const buffer = bufferDays * DAY;
  const noncurrentDays = { dateien: FILES_NONCURRENT_DAYS, merkliste: STATE_NONCURRENT_DAYS, sonstige: null };

  for (const [key, list] of byKey) {
    const area = areaOf(key, dumpPrefix);
    const a = areas[area];
    // Neueste zuerst; die aktuelle Fassung (IsLatest) steht immer vorn.
    list.sort((x, y) => (y.latest - x.latest) || (y.lm - x.lm));
    list.forEach((e, i) => {
      if (e.marker) {
        a.markers++;
        const below = list[i + 1];
        if (area === "dumps" && below && !below.marker && e.lm - below.lm < (DUMP_EXPIRATION_DAYS - 1) * DAY) a.premature.push({ key, at: e.lm });
        if (area === "dateien" && i === 0 && !PRUNABLE_AREAS.includes(storageArea(key.slice(FILES_PREFIX.length)))) a.deleted.push({ key, at: e.lm });
        if (area === "dateien" && i === 0 && list.length === 1 && nowMs - e.lm > (LOCK_DAYS + 1) * DAY + buffer) a.staleMarkers++;
        return;
      }
      a.versions++;
      a.bytes += e.size;
      if (i === 0) a.current.push({ key, lm: e.lm, size: e.size, versionId: e.versionId });
      const newer = list[i - 1];
      if (newer && !newer.marker) {
        if (area === "dumps") a.overwritten.push({ key, at: newer.lm });
        else if (area === "dateien") {
          if (newer.size === e.size && newer.etag !== "" && newer.etag === e.etag) a.duplicates++;
          else a.overwritten.push({ key, at: newer.lm });
        }
      }
      let due = null;
      if (area === "dumps") due = e.lm + (i === 0 ? DUMP_EXPIRATION_DAYS : DUMP_EXPIRATION_DAYS + DUMP_NONCURRENT_DAYS) * DAY;
      else if (i > 0 && noncurrentDays[area] != null) due = Math.max(newer.lm + noncurrentDays[area] * DAY, e.lm + LOCK_DAYS * DAY);
      if (due != null && nowMs > due + buffer) a.overdue.push({ key, days: Math.floor((nowMs - due) / DAY) });
    });
  }
  return areas;
}

/** Wertet die aktuellen Dumps aus ({ key, lm, size, versionId }, aktuelle nicht gelöschte Fassungen unter dem Präfix). */
/**
 * @param {CurrentEntry[]} current
 * @param {{ now: Date, maxDumpAgeHours?: number, minDumpBytes?: number, minDumps24h?: number, maxDumps24h?: number }} options
 */
export function evaluateDumps(current, { now, maxDumpAgeHours = 2, minDumpBytes = 100_000, minDumps24h = 20, maxDumps24h = 30 }) {
  const nowMs = now.getTime();
  const dumps = (current ?? []).filter((d) => !d.key.endsWith("/")).sort((x, y) => y.lm - x.lm);
  if (!dumps.length) return { newest: null, dumps, count: 0, last24h: 0, problems: ["unter dem Präfix liegt kein Dump"] };
  const problems = [];
  const [newest, ...older] = dumps;
  const ageHours = (nowMs - newest.lm) / HOUR;
  if (ageHours > maxDumpAgeHours) problems.push(`der neueste Dump ist ${ageHours.toFixed(1)} h alt (erlaubt ${maxDumpAgeHours} h)`);
  if (newest.size < minDumpBytes) problems.push(`der neueste Dump hat nur ${newest.size} Bytes (erwartet mindestens ${minDumpBytes})`);
  const reference = older.slice(0, 24).map((d) => d.size).sort((x, y) => x - y);
  if (reference.length >= 3) {
    const median = reference[Math.floor(reference.length / 2)];
    if (newest.size < median / 2) problems.push(`der neueste Dump ist mit ${mb(newest.size)} weniger als halb so groß wie üblich (${mb(median)})`);
  }
  const last24h = dumps.filter((d) => nowMs - d.lm <= DAY).length;
  const oldest = dumps[dumps.length - 1];
  if (nowMs - oldest.lm > DAY && last24h < minDumps24h) problems.push(`nur ${last24h} Dumps in den letzten 24 h (erwartet mindestens ${minDumps24h})`);
  if (last24h > maxDumps24h) problems.push(`${last24h} Dumps in den letzten 24 h (erwartet höchstens ${maxDumps24h}; stündlich plus einzelne „Backup Now“) – fremde Uploads?`);
  return { newest, dumps, count: dumps.length, last24h, ageHours, problems };
}

/**
 * Sperre einer Fassung: COMPLIANCE und rund 30 Tage ab Hochladen, nicht kürzer und nicht verlängert. Bei Fassungen, deren Sperre
 * planmäßig schon abgelaufen ist, gilt eine fehlende Sperre nicht als Fehler.
 */
export function retentionProblem(retention, lastModifiedMs, nowMs = Date.now()) {
  if (!retention) return nowMs - lastModifiedMs > LOCK_DAYS * DAY ? null : "nicht gesperrt";
  if (retention.Mode !== LOCK_MODE) return `Modus ${retention.Mode ?? "fehlt"}`;
  const span = new Date(retention.RetainUntilDate).getTime() - lastModifiedMs;
  if (!Number.isFinite(span)) return "Sperrfrist unlesbar";
  if (span < LOCK_DAYS * DAY - 6 * HOUR) return `nur ${(span / DAY).toFixed(1)} Tage gesperrt`;
  if (span > (LOCK_DAYS + 1) * DAY) return `${(span / DAY).toFixed(0)} Tage gesperrt (verlängert)`;
  return null;
}

/** Freigaben in einer ACL an jemand anderen als den Besitzer (Gruppen wie AllUsers oder fremde Konten). */
export function foreignGrants(acl) {
  const owner = acl?.Owner?.ID;
  return (acl?.Grants ?? [])
    .filter((g) => g.Grantee?.Type === "Group" || g.Grantee?.URI || g.Grantee?.EmailAddress || (owner && g.Grantee?.ID && g.Grantee.ID !== owner))
    .map((g) => `${g.Grantee?.URI ? g.Grantee.URI.split("/").pop() : g.Grantee?.ID ? "fremdes Konto" : "andere"}:${g.Permission}`);
}

export function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Fehlername, HTTP-Status und Netzwerk-Code (z. B. ECONNREFUSED); nie Nachricht oder Anfragedetails. */
export function errorName(e) {
  const status = e?.$metadata?.httpStatusCode;
  const code = typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(e.code) ? ` ${e.code}` : "";
  return `${e?.name ?? "Fehler"}${code}${status ? ` (HTTP ${status})` : ""}`;
}

export async function tryIt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: errorName(e), name: e?.name ?? "", status: e?.$metadata?.httpStatusCode };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Führt fn für alle Einträge aus, höchstens limit gleichzeitig; Ergebnisse in Eingabereihenfolge. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Zeilenweise Ausgabe mit Zählung: OK, FEHLER, HINWEIS. */
export function reporter(out = console.log) {
  const counts = { ok: 0, fehler: 0, hinweis: 0 };
  const line = (kind, label, text) => {
    counts[kind === "OK" ? "ok" : kind === "FEHLER" ? "fehler" : "hinweis"]++;
    out(`${kind.padEnd(8)}${label}: ${text}`);
  };
  return {
    counts,
    ok: (label, text) => line("OK", label, text),
    fehler: (label, text) => line("FEHLER", label, text),
    hinweis: (label, text) => line("HINWEIS", label, text),
    info: (text) => out(text),
    summary: () => out(`\nErgebnis: ${counts.ok} ok, ${counts.fehler} Fehler, ${counts.hinweis} Hinweise`),
  };
}

const MAX_PAGES = 10_000;

export async function listAllVersions(client, Bucket, Prefix) {
  const versions = [];
  const deleteMarkers = [];
  let KeyMarker;
  let VersionIdMarker;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix, KeyMarker, VersionIdMarker }));
    versions.push(...(res.Versions ?? []));
    deleteMarkers.push(...(res.DeleteMarkers ?? []));
    if (!res.IsTruncated) return { versions, deleteMarkers };
    if (res.NextKeyMarker == null) throw new Error("Auflistung unvollständig: keine Fortsetzungsmarke");
    KeyMarker = res.NextKeyMarker;
    VersionIdMarker = res.NextVersionIdMarker;
  }
  throw new Error("Auflistung zu lang");
}

export async function listAllUploads(client, Bucket) {
  const uploads = [];
  let KeyMarker;
  let UploadIdMarker;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.send(new ListMultipartUploadsCommand({ Bucket, KeyMarker, UploadIdMarker }));
    uploads.push(...(res.Uploads ?? []));
    if (!res.IsTruncated) return uploads;
    if (res.NextKeyMarker == null) throw new Error("Auflistung unvollständig: keine Fortsetzungsmarke");
    KeyMarker = res.NextKeyMarker;
    UploadIdMarker = res.NextUploadIdMarker;
  }
  throw new Error("Auflistung zu lang");
}

const isNoLifecycle = (r) => !r.ok && /NoSuchLifecycleConfiguration/.test(r.name);
const isNoPolicy = (r) => !r.ok && /NoSuchBucketPolicy/.test(r.name);
const shortKey = (key) => key.slice(key.lastIndexOf("/") + 1);
const sample = (items) => `${items.slice(0, 5).join("; ")}${items.length > 5 ? ` … (+${items.length - 5})` : ""}`;

/** Sperre je Fassung; liefert die Probleme als "Name: Problem". */
async function checkRetentions(client, Bucket, items, nowMs) {
  const results = await mapLimited(items, 8, (d) => tryIt(() => client.send(new GetObjectRetentionCommand({ Bucket, Key: d.key, VersionId: d.versionId }))));
  const problems = [];
  results.forEach((res, i) => {
    const notLocked = !res.ok && /NoSuchObjectLockConfiguration|ObjectLockConfigurationNotFound/.test(res.name);
    const p = res.ok ? retentionProblem(res.value.Retention, items[i].lm, nowMs) : notLocked ? retentionProblem(undefined, items[i].lm, nowMs) : `nicht lesbar (${res.error})`;
    if (p) problems.push({ key: items[i].key, text: `${shortKey(items[i].key)}: ${p}` });
  });
  return problems;
}

/** Fremde Freigaben je Fassung; liefert die betroffenen Schlüssel. */
async function checkObjectAcls(client, Bucket, items) {
  const results = await mapLimited(items, 8, (d) => tryIt(() => client.send(new GetObjectAclCommand({ Bucket, Key: d.key, VersionId: d.versionId }))));
  const foreign = [];
  let unreadable = 0;
  results.forEach((res, i) => {
    if (!res.ok) unreadable++;
    else if (foreignGrants(res.value).length) foreign.push(items[i].key);
  });
  return { foreign, unreadable };
}

/**
 * Lesender Prüflauf. Liefert die Zähler; Fehler bedeuten Exit-Code 1 (Coolify meldet den Scheduled Task dann als fehlgeschlagen).
 * Stündlich: Buckets im Projekt, Versionierung, Standard-Sperre, Lifecycle, keine Policy, Bucket-ACL; alle Fassungen des Buckets:
 * neuester Dump (Alter, Größe, Anzahl in 24 h), überschriebene oder vorzeitig gelöschte Dumps, gelöschte oder überschriebene
 * Dateien, Objekte außerhalb der Regeln, Sperre jeder Fassung der letzten 26 Stunden, Dateisicherung (sobald sie läuft).
 * Mit full zusätzlich (täglich): Lifecycle-Fristen, Gesamtgröße, Sperre und ACL aller aktuellen Fassungen, offene Teil-Uploads.
 * known: quittierte Schlüssel und Bucket-Namen (BACKUP_CHECK_BEKANNT); sie lösen keinen Fehler mehr aus, nur einen Hinweis.
 */
/**
 * @param {{ client: S3Like, bucket: string, dumpPrefix: string, now?: Date, full?: boolean, maxDumpAgeHours?: number,
 *   minDumpBytes?: number, minDumps24h?: number, maxDumps24h?: number, filesMaxAgeHours?: number, bufferDays?: number,
 *   maxTotalGb?: number, allowedOtherBuckets?: string[], known?: string[], out?: (line: string) => unknown }} args
 */
export async function runCheck({ client, bucket, dumpPrefix, now = new Date(), full = false, maxDumpAgeHours = 2, minDumpBytes = 100_000, minDumps24h = 20, maxDumps24h = 30, filesMaxAgeHours = 2, bufferDays = 7, maxTotalGb = 100, allowedOtherBuckets = [], known = [], out = console.log }) {
  const r = reporter(out);
  const prefixError = validateDumpPrefix(dumpPrefix);
  if (prefixError) {
    r.fehler("Einstellung", `BACKUP_DUMP_PREFIX ${prefixError}`);
    return r.counts;
  }
  const Bucket = bucket;
  const nowMs = now.getTime();
  const knownSet = new Set(known);
  // Meldet Schlüssel als Fehler, quittierte nur als Hinweis.
  const report = (label, items, text) => {
    const open = items.filter((x) => !knownSet.has(x));
    const acked = items.length - open.length;
    if (open.length) r.fehler(label, `${open.length} ${text}: ${sample(open)}`);
    if (acked) r.hinweis(label, `${acked} quittiert (BACKUP_CHECK_BEKANNT)`);
  };

  const ver = await tryIt(() => client.send(new GetBucketVersioningCommand({ Bucket })));
  if (!ver.ok) {
    r.fehler("Bucket", `${bucket} nicht lesbar (${ver.error}); weitere Prüfungen übersprungen`);
    return r.counts;
  }
  if (ver.value.Status === "Enabled") r.ok("Versionierung", "an");
  else r.fehler("Versionierung", `Status ${ver.value.Status ?? "aus"} – ohne Versionierung schützt die Sperre nicht`);

  const lb = await tryIt(() => client.send(new ListBucketsCommand({})));
  if (!lb.ok) r.fehler("Buckets im Projekt", `nicht auflistbar (${lb.error})`);
  else {
    const others = (lb.value.Buckets ?? []).map((b) => b.Name).filter((n) => n !== bucket && !allowedOtherBuckets.includes(n));
    if (others.length) report("Buckets im Projekt", others, "unerwartete Buckets – Kosten oder fremder Zugriff?");
    else r.ok("Buckets im Projekt", `nur ${bucket}${allowedOtherBuckets.length ? " und erlaubte" : ""}`);
  }

  const lock = await tryIt(() => client.send(new GetObjectLockConfigurationCommand({ Bucket })));
  if (!lock.ok) r.fehler("Standard-Sperre", `nicht lesbar (${lock.error})`);
  else {
    const s = lockState(lock.value.ObjectLockConfiguration);
    if (s.state === "richtig") r.ok("Standard-Sperre", s.text);
    else r.fehler("Standard-Sperre", `${s.text} – neue Backups wären nicht wie vorgesehen geschützt`);
  }

  const lc = await tryIt(() => client.send(new GetBucketLifecycleConfigurationCommand({ Bucket })));
  if (isNoLifecycle(lc)) r.fehler("Lifecycle", "keine Regeln gesetzt");
  else if (!lc.ok) r.fehler("Lifecycle", `nicht lesbar (${lc.error})`);
  else if (sameRules(lc.value.Rules, expectedLifecycleRules(dumpPrefix))) r.ok("Lifecycle", `${lc.value.Rules.length} Regeln wie vorgesehen`);
  else r.fehler("Lifecycle", `weicht ab (gelesen: ${(lc.value.Rules ?? []).map((x) => x.ID ?? "ohne ID").join(", ") || "keine"}) – wirkt auch auf vorhandene, nicht mehr gesperrte Fassungen`);

  const pol = await tryIt(() => client.send(new GetBucketPolicyCommand({ Bucket })));
  if (isNoPolicy(pol)) r.ok("Bucket-Policy", "keine");
  else if (pol.ok) r.fehler("Bucket-Policy", "unerwartet vorhanden – im Übergangsweg ist keine vorgesehen");
  else r.fehler("Bucket-Policy", `nicht lesbar (${pol.error})`);

  const acl = await tryIt(() => client.send(new GetBucketAclCommand({ Bucket })));
  if (!acl.ok) r.hinweis("Bucket-ACL", `nicht lesbar (${acl.error})`);
  else if (foreignGrants(acl.value).length) r.fehler("Bucket-ACL", `Freigabe an andere (${foreignGrants(acl.value).join(", ")}) – Backups für Fremde lesbar`);
  else r.ok("Bucket-ACL", "nur der Besitzer");

  const all = await tryIt(() => listAllVersions(client, Bucket, undefined));
  if (!all.ok) {
    r.fehler("Fassungen", `nicht auflistbar (${all.error}); Prüfung der Dumps und Dateien übersprungen`);
    return r.counts;
  }
  const areas = evaluateVersions({ ...all.value, now, dumpPrefix, bufferDays });
  const d = evaluateDumps(areas.dumps.current, { now, maxDumpAgeHours, minDumpBytes, minDumps24h, maxDumps24h });
  if (d.problems.length) for (const p of d.problems) r.fehler("Dumps", p);
  else r.ok("Dumps", `neuester ${d.ageHours.toFixed(1)} h alt, ${mb(d.newest.size)}; ${d.last24h} in 24 h, ${d.count} insgesamt`);
  report("Dumps überschrieben", areas.dumps.overwritten.map((x) => x.key), "Dumps liegen unter einem neueren Upload desselben Namens – Coolify überschreibt nie; Zugriff prüfen. Die alte Fassung ist bis Sperrende über ihre Versions-ID abrufbar");
  report("Dumps gelöscht", areas.dumps.premature.map((x) => x.key), `Dumps vor Ablauf von ${DUMP_EXPIRATION_DAYS} Tagen als gelöscht markiert – nicht von Coolify (Aufbewahrung 0/0/0) und nicht vom Lifecycle; Zugriff prüfen`);
  report("Dateien gelöscht", areas.dateien.deleted.map((x) => x.key), "gesicherte Dateien außerhalb von Fotos und Ausweiskopien als gelöscht markiert – die Dateisicherung löscht dort nie; Zugriff prüfen");
  report("Dateien überschrieben", areas.dateien.overwritten.map((x) => x.key), "gesicherte Dateien haben eine neuere Fassung mit anderem Inhalt – die Dateisicherung überschreibt nie; Zugriff prüfen");
  if (areas.dateien.duplicates) r.hinweis("Dateien doppelt", `${areas.dateien.duplicates} Dateien wurden mit gleichem Inhalt erneut gesichert (überlappende Läufe?)`);
  const foreignKeys = [...new Set([...all.value.versions, ...all.value.deleteMarkers].map((v) => v.Key).filter((k) => areaOf(k, dumpPrefix) === "sonstige"))];
  report("Objekte außerhalb der Regeln", foreignKeys, "Schlüssel außerhalb von Dumps, files/ und files-state/ – kein Lauf schreibt dorthin, keine Regel räumt sie auf");

  const current = Object.values(areas).flatMap((a) => a.current);
  const recent = current.filter((x) => nowMs - x.lm <= 26 * HOUR);
  const recentProblems = await checkRetentions(client, Bucket, recent, nowMs);
  report("Sperre neuer Fassungen", recentProblems.map((p) => p.key), `von ${recent.length} Fassungen der letzten 26 h nicht wie vorgesehen gesperrt (${sample(recentProblems.map((p) => p.text))})`);
  if (!recentProblems.length) r.ok("Sperre neuer Fassungen", `${recent.length} Fassungen der letzten 26 h: ${LOCK_MODE}, rund ${LOCK_DAYS} Tage`);

  const state = [...all.value.versions, ...all.value.deleteMarkers].filter((v) => v.Key === MISSING_STATE_KEY);
  const stateCurrent = state.find((v) => v.IsLatest);
  if (!state.length) r.hinweis("Dateisicherung", "läuft noch nicht (kein files-state/missing.json)");
  else if (!stateCurrent || all.value.deleteMarkers.includes(stateCurrent)) r.fehler("Dateisicherung", `${MISSING_STATE_KEY} wurde gelöscht – Zugriff prüfen`);
  else {
    const age = (nowMs - new Date(stateCurrent.LastModified).getTime()) / HOUR;
    if (age > filesMaxAgeHours) r.fehler("Dateisicherung", `letzter erfolgreicher Lauf vor ${age.toFixed(1)} h (erlaubt ${filesMaxAgeHours} h)`);
    else r.ok("Dateisicherung", `letzter erfolgreicher Lauf vor ${age.toFixed(1)} h`);
  }

  if (full) {
    let bytes = 0;
    for (const [name, a] of Object.entries(areas)) {
      bytes += a.bytes;
      if (name === "sonstige") continue;
      const label = `Lifecycle ${AREA_LABEL[name]}`;
      const open = a.overdue.filter((x) => !knownSet.has(x.key));
      if (open.length) r.fehler(label, `${open.length} von ${a.versions} Fassungen sind überfällig (bis ${Math.max(...open.map((x) => x.days))} Tage über Frist und ${bufferDays} Tage Puffer: ${sample(open.map((x) => shortKey(x.key)))}) – die Lifecycle-Regel räumt nicht auf, oder die Sperre wurde verlängert`);
      else r.ok(label, `${a.versions} Fassungen, ${a.markers} Löschmarker, nichts überfällig`);
      if (a.overdue.length > open.length) r.hinweis(label, `${a.overdue.length - open.length} überfällige Fassungen quittiert (BACKUP_CHECK_BEKANNT)`);
      if (a.staleMarkers) r.hinweis(`Löschmarker ${AREA_LABEL[name]}`, `${a.staleMarkers} leere Löschmarker liegen länger, als die Regeln brauchen`);
    }
    const gb = bytes / 1024 ** 3;
    if (gb > maxTotalGb) r.fehler("Gesamtgröße", `${gb.toFixed(1)} GB in allen Fassungen (erlaubt ${maxTotalGb} GB) – fremde Uploads?`);
    else r.ok("Gesamtgröße", `${gb.toFixed(2)} GB in allen Fassungen`);
    const problems = await checkRetentions(client, Bucket, current, nowMs);
    report("Sperre aller Fassungen", problems.map((p) => p.key), `von ${current.length} aktuellen Fassungen nicht wie vorgesehen gesperrt (${sample(problems.map((p) => p.text))})`);
    if (!problems.length) r.ok("Sperre aller Fassungen", `${current.length} aktuelle Fassungen: ${LOCK_MODE} rund ${LOCK_DAYS} Tage ab Hochladen, keine verlängert`);
    const acls = await checkObjectAcls(client, Bucket, current);
    report("Objekt-ACL", acls.foreign, "Fassungen sind für andere freigegeben – für Fremde lesbar");
    if (acls.unreadable) r.hinweis("Objekt-ACL", `${acls.unreadable} von ${current.length} nicht lesbar`);
    else if (!acls.foreign.length) r.ok("Objekt-ACL", `${current.length} aktuelle Fassungen: nur der Besitzer`);
    const up = await tryIt(() => listAllUploads(client, Bucket));
    if (!up.ok) r.fehler("Teil-Uploads", `nicht auflistbar (${up.error})`);
    else {
      const ages = up.value.map((u) => (nowMs - new Date(u.Initiated).getTime()) / DAY);
      const stale = ages.filter((x) => x > MPU_ABORT_DAYS + bufferDays).length;
      const older = ages.filter((x) => x > 1).length;
      if (stale) r.fehler("Teil-Uploads", `${stale} unvollständige Teil-Uploads älter als ${MPU_ABORT_DAYS + bufferDays} Tage – die Lifecycle-Regel bricht sie nicht ab`);
      else if (older) r.hinweis("Teil-Uploads", `${older} unvollständige Teil-Uploads älter als 1 Tag (abgebrochene Uploads; die Lifecycle-Regel entfernt sie nach ${MPU_ABORT_DAYS} Tagen)`);
      else r.ok("Teil-Uploads", `${up.value.length} offen, keiner älter als 1 Tag`);
    }
  }
  return r.counts;
}

/** Liest einen Zustand erneut, bis er wie gewünscht ist (höchstens rund 30 s). */
async function readBack(read, wanted, pause) {
  let last;
  for (let i = 0; i < 7; i++) {
    last = await tryIt(read);
    if (wanted(last)) return last;
    await pause(5000);
  }
  return last;
}

/**
 * Einrichtung. mode: "pruefen" (nur lesend), "sperre", "lifecycle" (mit dumpPrefix) oder "wiederherstellen" (mit dumpPrefix:
 * nach einem Eingriff Bucket-Policy entfernen, Bucket-ACL auf privat, Standard-Sperre und Lifecycle auf den vorgesehenen Stand).
 * „wiederherstellen“ lässt sich nicht durch einen fremden Bucket oder nicht lesbare Einstellungen blockieren: Es meldet das und
 * versucht jeden Schritt trotzdem, die Policy zuerst, weil eine fremde Policy die übrigen Schritte verweigern könnte.
 * client: Standard-Client (setzt die Sperre, wie im Bucket-Test am 11.10.2026 erprobt);
 * strictClient: Client mit requestChecksumCalculation WHEN_REQUIRED (setzt die Lifecycle-Regeln, ebenso erprobt).
 * Exit-Codes: 0 eingerichtet bzw. schon richtig, 1 abgelehnt, fehlgeschlagen oder mit FEHLER-Zeilen,
 * 3 falscher Schlüssel, falsches Projekt oder Bucket ohne Object Lock (dann nichts geändert).
 */
/**
 * @param {{ client: S3Like, strictClient: S3Like, bucket: string, mode: string, dumpPrefix?: string,
 *   out?: (line: string) => unknown, pause?: (ms: number) => Promise<unknown>, allowedOtherBuckets?: string[] }} args
 */
export async function runSetup({ client, strictClient, bucket, mode, dumpPrefix = "", out = console.log, pause = sleep, allowedOtherBuckets = ALLOWED_OTHER_BUCKETS }) {
  const r = reporter(out);
  const Bucket = bucket;
  const finish = (code) => {
    r.summary();
    return code;
  };
  const restoring = mode === "wiederherstellen";

  const lb = await tryIt(() => client.send(new ListBucketsCommand({})));
  if (!lb.ok) {
    r.fehler("Anmeldung", `nicht möglich (${lb.error}) – Endpunkt, Access Key und Secret Key prüfen`);
    return finish(3);
  }
  const names = (lb.value.Buckets ?? []).map((b) => b.Name);
  if (!names.includes(bucket)) {
    r.fehler("Bucket", `${bucket} ist mit diesem Schlüssel nicht sichtbar (${names.length} andere Buckets) – falsches Projekt oder Bucket noch nicht angelegt`);
    return finish(3);
  }
  const others = names.filter((n) => n !== bucket);
  const unexpected = others.filter((n) => !allowedOtherBuckets.includes(n));
  if (unexpected.length) {
    r.fehler("Projekt", `der Schlüssel sieht weitere Buckets (${unexpected.join(", ")})${restoring ? " – nach einem Eingriff möglich; die Wiederherstellung läuft trotzdem" : " – das ist nicht das Backup-Projekt"}`);
    if (mode !== "pruefen" && !restoring) return finish(3);
  } else r.ok("Projekt", others.length ? `sieht ${bucket} und ${others.join(", ")}` : `sieht nur ${bucket}`);

  // Bei der Wiederherstellung zuerst die Policy: Eine fremde Policy könnte das Lesen und Setzen der übrigen Einstellungen verweigern.
  const pol = await tryIt(() => client.send(new GetBucketPolicyCommand({ Bucket })));
  if (restoring) {
    if (isNoPolicy(pol)) r.ok("Bucket-Policy", "keine, nichts geändert");
    else {
      const del = await tryIt(() => client.send(new DeleteBucketPolicyCommand({ Bucket })));
      const back = del.ok ? await readBack(() => client.send(new GetBucketPolicyCommand({ Bucket })), isNoPolicy, pause) : null;
      if (back && isNoPolicy(back)) r.ok("Bucket-Policy entfernt", "zurückgelesen: keine");
      else r.fehler("Bucket-Policy entfernen", del.ok ? "angenommen, aber weiterhin vorhanden – Stand prüfen" : `abgelehnt (${del.error}) – sperrt eine Policy alle Projektschlüssel aus, hilft nur der Hetzner-Support`);
    }
  } else if (isNoPolicy(pol)) r.ok("Bucket-Policy", "keine");
  else r.hinweis("Bucket-Policy", pol.ok ? "vorhanden – im Übergangsweg nicht vorgesehen" : `nicht lesbar (${pol.error})`);

  const ver = await tryIt(() => client.send(new GetBucketVersioningCommand({ Bucket })));
  const versioningOn = ver.ok && ver.value.Status === "Enabled";
  if (versioningOn) r.ok("Versionierung", "an");
  else r.fehler("Versionierung", ver.ok ? `Status ${ver.value.Status ?? "aus"}` : `nicht lesbar (${ver.error})`);

  const lockRead = await tryIt(() => client.send(new GetObjectLockConfigurationCommand({ Bucket })));
  const lock = lockRead.ok ? lockState(lockRead.value.ObjectLockConfiguration) : /ObjectLockConfigurationNotFound/.test(lockRead.name) ? lockState(undefined) : null;
  if (!lock) r.fehler("Sperr-Einstellung", `nicht lesbar (${lockRead.error})`);
  else if (lock.state === "richtig") r.ok("Standard-Sperre", lock.text);
  else if (restoring && lock.state !== "aus") r.hinweis("Standard-Sperre", `${lock.text} – wird zurückgesetzt`);
  else if (lock.state === "ohne-standard") r.hinweis("Standard-Sperre", `${lock.text} – mit --sperre setzen`);
  else r.fehler("Standard-Sperre", lock.text);

  const acl = await tryIt(() => client.send(new GetBucketAclCommand({ Bucket })));
  if (!acl.ok) r.hinweis("Bucket-ACL", `nicht lesbar (${acl.error})`);
  else if (foreignGrants(acl.value).length) (restoring ? r.hinweis : r.fehler)("Bucket-ACL", `Freigabe an andere (${foreignGrants(acl.value).join(", ")})${restoring ? " – wird zurückgesetzt" : ""}`);
  else r.info(`Bucket-ACL: ${(acl.value.Grants ?? []).length} Einträge, nur der Besitzer`);

  const lcRead = await tryIt(() => client.send(new GetBucketLifecycleConfigurationCommand({ Bucket })));
  const lcNone = isNoLifecycle(lcRead);
  if (lcNone) r.info("Lifecycle: noch keine Regeln");
  else if (lcRead.ok) r.info(`Lifecycle: ${(lcRead.value.Rules ?? []).map((x) => `${x.ID ?? "ohne ID"} (${x.Filter?.Prefix ?? x.Filter?.And?.Prefix ?? x.Prefix ?? ""})`).join(", ")}`);
  else r.fehler("Lifecycle", `nicht lesbar (${lcRead.error})`);

  const inv = await tryIt(() => listAllVersions(client, Bucket, undefined));
  if (!inv.ok) r.fehler("Bestand", `nicht auflistbar (${inv.error})`);
  else r.info(`Bestand: ${inv.value.versions.length} Fassungen, ${inv.value.deleteMarkers.length} Löschmarker`);

  if (mode === "pruefen") {
    const current = inv.ok ? inv.value.versions.filter((v) => v.IsLatest && v.Key.startsWith(COOLIFY_DUMP_ROOT)) : [];
    current.sort((x, y) => new Date(y.LastModified) - new Date(x.LastModified));
    if (!current.length) r.info(`Coolify-Dumps: noch keiner unter ${COOLIFY_DUMP_ROOT}`);
    else {
      for (const v of current.slice(0, 3)) r.info(`Dump: ${v.Key} · ${mb(v.Size ?? 0)} · ${new Date(v.LastModified).toISOString()}`);
      const newest = current[0];
      const ret = await tryIt(() => client.send(new GetObjectRetentionCommand({ Bucket, Key: newest.Key, VersionId: newest.VersionId })));
      const p = ret.ok ? retentionProblem(ret.value.Retention, new Date(newest.LastModified).getTime()) : `nicht gesperrt oder nicht lesbar (${ret.error})`;
      if (p) r.fehler("Sperre neuester Dump", p);
      else r.ok("Sperre neuester Dump", `${LOCK_MODE} bis ${new Date(ret.value.Retention.RetainUntilDate).toISOString()}`);
      r.info(`Vorschlag Dump-Präfix: ${newest.Key.slice(0, newest.Key.lastIndexOf("/") + 1)}`);
    }
    return finish(r.counts.fehler ? 1 : 0);
  }

  if (lock?.state === "aus") {
    r.fehler("Voraussetzung", "Object Lock ist nicht aktiviert. Das geht nur beim Anlegen: Bucket leer löschen und mit Object Lock neu anlegen – nichts geändert");
    return finish(3);
  }
  if (!restoring && (!versioningOn || !lock)) {
    r.fehler("Voraussetzung", "Versionierung oder Sperr-Einstellung nicht wie erwartet – nichts geändert");
    return finish(3);
  }

  const putLock = async () => {
    const put = await tryIt(() => client.send(new PutObjectLockConfigurationCommand({ Bucket, ObjectLockConfiguration: expectedLockConfiguration() })));
    if (!put.ok) {
      r.fehler("Standard-Sperre setzen", `abgelehnt (${put.error}) – nicht geändert`);
      return false;
    }
    const back = await readBack(() => client.send(new GetObjectLockConfigurationCommand({ Bucket })), (x) => x.ok && lockState(x.value.ObjectLockConfiguration).state === "richtig", pause);
    if (back?.ok && lockState(back.value.ObjectLockConfiguration).state === "richtig") {
      r.ok("Standard-Sperre gesetzt", `${LOCK_MODE} ${LOCK_DAYS} Tage, zurückgelesen`);
      return true;
    }
    r.fehler("Standard-Sperre gesetzt", `angenommen, aber zurückgelesen ${back?.ok ? lockState(back.value.ObjectLockConfiguration).text : back?.error ?? "nichts"} – nicht weitermachen, Stand prüfen`);
    return false;
  };
  const putLifecycle = async (expected) => {
    const put = await tryIt(() => strictClient.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: expected } })));
    if (!put.ok) {
      r.fehler("Lifecycle setzen", `abgelehnt (${put.error}) – nicht geändert`);
      return false;
    }
    const back = await readBack(() => client.send(new GetBucketLifecycleConfigurationCommand({ Bucket })), (x) => x.ok && sameRules(x.value.Rules, expected), pause);
    if (back?.ok && sameRules(back.value.Rules, expected)) {
      r.ok("Lifecycle gesetzt", `${expected.length} Regeln, zurückgelesen`);
      return true;
    }
    r.fehler("Lifecycle gesetzt", `angenommen, aber zurückgelesen ${back?.ok ? "abweichend" : back?.error ?? "nichts"} – Stand prüfen`);
    return false;
  };
  // Prüft, dass unter dem Präfix Dumps liegen und der neueste gesperrt ist; meldet als FEHLER und liefert false sonst.
  const dumpsPresent = async () => {
    const dumps = await tryIt(() => client.send(new ListObjectsV2Command({ Bucket, Prefix: dumpPrefix, MaxKeys: 1000 })));
    const found = dumps.ok ? (dumps.value.Contents ?? []).filter((o) => !o.Key.endsWith("/")) : [];
    if (!found.length) {
      r.fehler("Dump-Präfix", dumps.ok ? `unter ${dumpPrefix} liegt kein Dump – erst in Coolify „Backup Now“ auslösen bzw. das Präfix prüfen; Lifecycle nicht geändert` : `Dumps nicht auflistbar (${dumps.error}); Lifecycle nicht geändert`);
      return false;
    }
    found.sort((x, y) => new Date(y.LastModified) - new Date(x.LastModified));
    const ret = await tryIt(() => client.send(new GetObjectRetentionCommand({ Bucket, Key: found[0].Key })));
    if (!(ret.ok && ret.value.Retention?.Mode === LOCK_MODE)) {
      r.fehler("Dump-Präfix", `der neueste Dump ist nicht ${LOCK_MODE}-gesperrt (${ret.ok ? ret.value.Retention?.Mode ?? "ohne Modus" : ret.error}); Lifecycle nicht geändert`);
      return false;
    }
    r.ok("Dump-Präfix", `${found.length} Dump(s) unter dem Präfix, der neueste ist ${LOCK_MODE}-gesperrt`);
    return true;
  };

  if (mode === "sperre") {
    if (lock.state === "richtig") {
      r.ok("Standard-Sperre", "bereits gesetzt, nichts geändert");
      return finish(0);
    }
    if (lock.state === "abweichend") {
      r.fehler("Standard-Sperre", `abweichende Standard-Sperre (${lock.text}) – nichts geändert; nach einem Eingriff --wiederherstellen verwenden`);
      return finish(1);
    }
    const unlocked = inv.ok ? inv.value.versions.length : null;
    if (unlocked) r.hinweis("Bestand", `${unlocked} schon vorhandene Fassungen bleiben ohne Standard-Sperre`);
    return finish((await putLock()) ? 0 : 1);
  }

  if (mode === "lifecycle" || restoring) {
    const prefixError = validateDumpPrefix(dumpPrefix);
    if (prefixError) {
      r.fehler("Dump-Präfix", `${prefixError} – nichts geändert`);
      return finish(1);
    }
    if (!dumpPrefix.startsWith(COOLIFY_DUMP_ROOT)) r.hinweis("Dump-Präfix", `beginnt nicht mit ${COOLIFY_DUMP_ROOT} – ist das wirklich Coolifys Ablage?`);
  }

  if (mode === "lifecycle") {
    if (lock.state !== "richtig") {
      r.fehler("Voraussetzung", "erst die Standard-Sperre setzen (--sperre) – nichts geändert");
      return finish(1);
    }
    if (!(await dumpsPresent())) return finish(1);
    const expected = expectedLifecycleRules(dumpPrefix);
    if (lcRead.ok && sameRules(lcRead.value.Rules, expected)) {
      r.ok("Lifecycle", "bereits wie vorgesehen gesetzt, nichts geändert");
      return finish(0);
    }
    if (!lcNone) {
      r.fehler("Lifecycle", lcRead.ok ? "es sind schon andere Regeln gesetzt – nichts geändert; nach einem Eingriff --wiederherstellen verwenden" : "Stand nicht lesbar – nichts geändert");
      return finish(1);
    }
    return finish((await putLifecycle(expected)) ? 0 : 1);
  }

  if (restoring) {
    if (acl.ok && foreignGrants(acl.value).length) {
      const put = await tryIt(() => client.send(new PutBucketAclCommand({ Bucket, ACL: "private" })));
      const back = put.ok ? await readBack(() => client.send(new GetBucketAclCommand({ Bucket })), (x) => x.ok && !foreignGrants(x.value).length, pause) : null;
      if (back?.ok && !foreignGrants(back.value).length) r.ok("Bucket-ACL zurückgesetzt", "zurückgelesen: nur der Besitzer");
      else r.fehler("Bucket-ACL zurücksetzen", put.ok ? "angenommen, aber weiterhin Freigaben – in der Hetzner Console auf privat stellen" : `abgelehnt (${put.error}) – in der Hetzner Console auf privat stellen`);
    }
    if (lock?.state !== "richtig") await putLock();
    else r.ok("Standard-Sperre", "wie vorgesehen, nichts geändert");
    const expected = expectedLifecycleRules(dumpPrefix);
    if (lcRead.ok && sameRules(lcRead.value.Rules, expected)) r.ok("Lifecycle", "wie vorgesehen, nichts geändert");
    else if (await dumpsPresent()) await putLifecycle(expected);
    return finish(r.counts.fehler ? 1 : 0);
  }

  r.fehler("Modus", `unbekannt: ${mode}`);
  return finish(1);
}

/** Zugangsdaten aus der Umgebung (BACKUP_S3_*) oder, mit --schluessel-stdin, aus den ersten beiden Zeilen der Standardeingabe. */
/**
 * @param {Record<string, string | undefined>} env
 * @param {{ keysFromStdin?: boolean, stdin?: AsyncIterable<string | Buffer> & { setEncoding?: (encoding: BufferEncoding) => unknown } }} [options]
 */
export async function readTarget(env, { keysFromStdin = false, stdin = process.stdin } = {}) {
  const missing = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET"].filter((n) => !env[n]);
  let accessKeyId = env.BACKUP_S3_ACCESS_KEY;
  let secretAccessKey = env.BACKUP_S3_SECRET_KEY;
  if (keysFromStdin) {
    let text = "";
    stdin.setEncoding?.("utf8");
    for await (const chunk of stdin) text += chunk;
    const lines = text.split(/\r?\n/).filter((l) => l !== "");
    [accessKeyId, secretAccessKey] = lines;
    text = "";
    if (lines.length !== 2) missing.push("genau zwei Zeilen auf der Standardeingabe");
  } else {
    if (!accessKeyId) missing.push("BACKUP_S3_ACCESS_KEY");
    if (!secretAccessKey) missing.push("BACKUP_S3_SECRET_KEY");
  }
  const pattern = /^[A-Za-z0-9\/+=._~-]{10,256}$/;
  if (accessKeyId && !pattern.test(accessKeyId)) missing.push("gültiger Access Key");
  if (secretAccessKey && !pattern.test(secretAccessKey)) missing.push("gültiger Secret Key");
  return {
    missing,
    endpoint: env.BACKUP_S3_ENDPOINT,
    region: env.BACKUP_S3_REGION || "hel1",
    bucket: env.BACKUP_S3_BUCKET,
    accessKeyId,
    secretAccessKey,
  };
}

/** S3-Client mit Zeitlimits je Anfrage. Ohne throwOnRequestTimeout würde ein hängender Server den Lauf nur verzögern. */
export function s3Client(cfg, extra = {}) {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000, throwOnRequestTimeout: true },
    ...extra,
  });
}

/** Beendet den Prozess bei unerwarteten Fehlern nur mit Fehlername, ohne Stack und Anfragedetails. */
export function guardProcess(watchdogMinutes) {
  const abort = (e) => {
    console.error(`unerwarteter Fehler: ${errorName(e)}`);
    process.exit(1);
  };
  process.on("uncaughtException", abort);
  process.on("unhandledRejection", abort);
  setTimeout(() => {
    console.error(`Abbruch: Zeitlimit von ${watchdogMinutes} Minuten überschritten`);
    process.exit(1);
  }, watchdogMinutes * 60_000).unref();
}

// Prüfprotokoll für einen Backup-Test-Bucket mit Object Lock im Hetzner Object Storage (Anleitung: docs/backup-test-bucket.md).
// Läuft in einem Wegwerf-Container aus dem App-Image (dort liegt @aws-sdk/client-s3); die Zugangsdaten kommen ausschließlich
// aus der Umgebung (--env-file /root/backup-test.env) und werden nie ausgegeben. Geschrieben wird nur unter rb-test/ im Test-Bucket.
//
// Aufruf (Server, siehe Anleitung):
//   node backup-bucket-test.mjs                    Tag 0: Prüfungen 0–5 und 7
//   node backup-bucket-test.mjs --after-retention  frühestens 24 h später: Ablauf der Sperre, Löschen der am Tag 0 geschützten
//                                                  Fassungen (Ablaufprobe, md5.txt), Wirkung der Lifecycle-Regel
//   node backup-bucket-test.mjs --inventory        nur lesend: Bucket-Einstellungen, Bestand, Sperren, Stand der Lifecycle-Regel
//   node backup-bucket-test.mjs --cleanup          nach Ablauf der Sperre: alle Testobjekte unter rb-test/ entfernen
// Prüfung 6 (Coolify-Upload mit mc) läuft getrennt im Coolify-Hilfs-Image, siehe Anleitung.
// Exit: 0 bestanden · 1 Prüfung nicht ok oder unerwarteter Fehler · 2 Konfiguration abgelehnt · 3 Anmeldung oder Isolation
// gescheitert (nichts geschrieben).

import { createHash, randomBytes } from "node:crypto";
import s3 from "@aws-sdk/client-s3";

const {
  S3Client, ListBucketsCommand, GetObjectLockConfigurationCommand, PutObjectLockConfigurationCommand, GetBucketVersioningCommand,
  PutBucketVersioningCommand, PutObjectCommand, GetObjectCommand, GetObjectRetentionCommand, PutObjectRetentionCommand,
  DeleteObjectCommand, DeleteObjectsCommand, PutBucketLifecycleConfigurationCommand, GetBucketLifecycleConfigurationCommand,
  ListObjectVersionsCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  GetBucketPolicyCommand, GetObjectLegalHoldCommand, ListMultipartUploadsCommand,
} = s3;

const PREFIX = "rb-test/";
const PRODUCTION_BUCKETS = ["rent-base-files", "rent-base-backup"];
const mode = process.argv.includes("--cleanup") ? "cleanup"
  : process.argv.includes("--after-retention") ? "after"
  : process.argv.includes("--inventory") ? "inventory" : "day0";
const env = process.env;
const missing = ["TEST_S3_ENDPOINT", "TEST_S3_BUCKET", "TEST_S3_ACCESS_KEY", "TEST_S3_SECRET_KEY"].filter((k) => !env[k]);
if (missing.length) { console.log(`ABBRUCH: in /root/backup-test.env fehlt ${missing.join(", ")}`); process.exit(2); }
const Bucket = env.TEST_S3_BUCKET;
if (!/test/i.test(Bucket) || PRODUCTION_BUCKETS.includes(Bucket)) { console.log(`ABBRUCH: „${Bucket}“ ist kein Test-Bucket (Name muss „test“ enthalten)`); process.exit(2); }
const cfg = (extra = {}) => new S3Client({ endpoint: env.TEST_S3_ENDPOINT, region: env.TEST_S3_REGION || "hel1", forcePathStyle: true, credentials: { accessKeyId: env.TEST_S3_ACCESS_KEY, secretAccessKey: env.TEST_S3_SECRET_KEY }, ...extra });
const c = cfg();
const strict = cfg({ requestChecksumCalculation: "WHEN_REQUIRED" }); // schickt von sich aus keine Prüfsumme

const results = [];
const record = (id, ok, text) => { results.push({ id, ok, text }); console.log(`${ok === true ? "BESTANDEN " : ok === false ? "NICHT OK  " : "HINWEIS   "} ${id}: ${text}`); };
const err = (e) => `${e?.name ?? "Fehler"}${e?.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : ""}`;
const tryIt = async (fn) => { try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, error: err(e) }; } };
const md5 = (b) => createHash("md5").update(b).digest("base64");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const body = async (r) => Buffer.from(await r.Body.transformToByteArray());

console.log(`Test-Bucket ${Bucket} · Endpunkt ${new URL(env.TEST_S3_ENDPOINT).host} · Modus ${mode}`);
if (!/hel1\./.test(env.TEST_S3_ENDPOINT)) record("Standort", null, "Endpunkt ist nicht hel1 – geplant ist Helsinki (Dateien liegen in fsn1, Server in nbg1)");

// 0) Isolation: der Testschlüssel darf außer dem Test-Bucket keinen Bucket sehen, erst recht keinen Produktions-Bucket
const listed = await tryIt(() => c.send(new ListBucketsCommand({})));
const names = listed.ok ? (listed.value.Buckets ?? []).map((b) => b.Name) : [];
const sees = names.filter((n) => PRODUCTION_BUCKETS.includes(n));
if (sees.length) { record("0 Isolation", false, `Schlüssel sieht Produktions-Bucket ${sees.join(", ")} – falsches Projekt. Abbruch, nichts geschrieben.`); process.exit(3); }
const others = names.filter((n) => n !== Bucket);
if (others.length) { record("0 Isolation", false, `Schlüssel sieht weitere Bucket(s) ${others.join(", ")} – erwartet ist nur ${Bucket}. Abbruch, nichts geschrieben.`); process.exit(3); }
record("0 Isolation", listed.ok && names.includes(Bucket), listed.ok ? `Schlüssel sieht nur ${names.join(", ") || "keinen Bucket"}, keinen Produktions-Bucket` : `ListBuckets ${listed.error}`);
if (!listed.ok) { console.log("ABBRUCH: Anmeldung oder Zugriff abgelehnt – Schlüssel prüfen. Nichts geschrieben."); process.exit(3); }
if (!names.includes(Bucket)) { console.log(`ABBRUCH: Bucket ${Bucket} ist für diesen Schlüssel nicht sichtbar – Name oder Projekt prüfen. Nichts geschrieben.`); process.exit(3); }

// Unerwartete Fehler nur mit Namen und HTTP-Status melden: S3-Fehlerobjekte können Felder wie AWSAccessKeyId enthalten,
// die Node beim Standard-Abbruch mit ausgeben würde.
const abort = (e) => { console.log(`ABBRUCH: unerwarteter Fehler ${err(e)} (Details aus Sicherheitsgründen nicht ausgegeben)`); process.exit(1); };
process.on("uncaughtException", abort);
process.on("unhandledRejection", abort);
try {
  if (mode === "day0") await day0();
  else if (mode === "after") { await bucketState(); await afterRetention(); }
  else if (mode === "inventory") { await bucketState(); await stock("I1"); await perKey("I3"); await lifecycleState("I2"); }
  else await cleanup();
} catch (e) { abort(e); }

const failed = results.filter((r) => r.ok === false).length;
console.log(`\nErgebnis: ${results.filter((r) => r.ok === true).length} bestanden, ${failed} nicht ok, ${results.filter((r) => r.ok === null).length} Hinweise`);
process.exitCode = failed ? 1 : 0;

async function day0() {
  // 1) Object Lock aktiv, Versionierung automatisch an und nicht abschaltbar
  const lock = await tryIt(() => c.send(new GetObjectLockConfigurationCommand({ Bucket })));
  const lockOn = lock.ok && lock.value.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
  record("1a Object Lock", lockOn, lockOn ? "beim Anlegen aktiviert" : `nicht aktiv (${lock.error ?? "aus"}) – Bucket neu anlegen, nachträglich nicht möglich`);
  if (!lockOn) return;
  const ver = await tryIt(() => c.send(new GetBucketVersioningCommand({ Bucket })));
  record("1b Versionierung", ver.ok && ver.value.Status === "Enabled", ver.ok ? `Status ${ver.value.Status ?? "aus"}` : ver.error);
  const suspend = await tryIt(() => c.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Suspended" } })));
  record("1c Versionierung nicht abschaltbar", !suspend.ok, suspend.ok ? "ließ sich abschalten – Sperre wäre unwirksam" : `Abschalten abgelehnt: ${suspend.error}`);

  // 2) Standard-Sperre COMPLIANCE 1 Tag
  const put = await tryIt(() => c.send(new PutObjectLockConfigurationCommand({ Bucket, ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } } })));
  const back = await tryIt(() => c.send(new GetObjectLockConfigurationCommand({ Bucket })));
  const rule = back.ok ? back.value.ObjectLockConfiguration?.Rule?.DefaultRetention : null;
  record("2 Standard-Sperre", put.ok && rule?.Mode === "COMPLIANCE" && rule?.Days === 1, put.ok ? `gesetzt: ${rule?.Mode} ${rule?.Days} Tag` : `nicht gesetzt: ${put.error}`);

  // 3) Uploads mit und ohne Prüfsumme
  const payload = Buffer.from(`RentBase Backup-Test ${new Date().toISOString()}\n`);
  const a = await tryIt(() => c.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}default.txt`, Body: payload })));
  record("3a Upload, SDK-Standard", a.ok, a.ok ? "angenommen (SDK schickt eigene Prüfsumme)" : a.error);
  const b = await tryIt(() => strict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}md5.txt`, Body: payload, ContentMD5: md5(payload) })));
  record("3b Upload mit Content-MD5", b.ok, b.ok ? "angenommen" : b.error);
  const n = await tryIt(() => strict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}ohne-pruefsumme.txt`, Body: payload })));
  record("3c Upload ohne Prüfsumme", null, n.ok ? "angenommen – der Speicher verlangt keine Prüfsumme" : `abgelehnt (${n.error}) – Werkzeuge müssen eine Prüfsumme schicken`);
  const ret = await tryIt(() => c.send(new GetObjectRetentionCommand({ Bucket, Key: `${PREFIX}md5.txt` })));
  const until = ret.ok ? ret.value.Retention?.RetainUntilDate : null;
  record("3d Sperre am Objekt", ret.ok && ret.value.Retention?.Mode === "COMPLIANCE", ret.ok ? `COMPLIANCE bis ${until ? new Date(until).toISOString() : "?"}` : ret.error);

  // 4) Schutz innerhalb der Sperre
  const v1 = (await c.send(new ListObjectVersionsCommand({ Bucket, Prefix: `${PREFIX}md5.txt` }))).Versions?.[0]?.VersionId;
  const delVersion = await tryIt(() => c.send(new DeleteObjectCommand({ Bucket, Key: `${PREFIX}md5.txt`, VersionId: v1 })));
  record("4a Version löschen", !delVersion.ok, delVersion.ok ? "GELÖSCHT – Sperre wirkt nicht" : `abgelehnt: ${delVersion.error}`);
  const bypass = await tryIt(() => c.send(new DeleteObjectCommand({ Bucket, Key: `${PREFIX}md5.txt`, VersionId: v1, BypassGovernanceRetention: true })));
  record("4b Löschen mit Governance-Umgehung", !bypass.ok, bypass.ok ? "GELÖSCHT – COMPLIANCE wirkt nicht" : `abgelehnt: ${bypass.error}`);
  const multi = await tryIt(() => c.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: `${PREFIX}md5.txt`, VersionId: v1 }] } })));
  const multiDeleted = multi.ok && (multi.value.Deleted ?? []).length > 0;
  record("4c Mehrfach-Löschen", !multiDeleted, multiDeleted ? "GELÖSCHT – Sperre wirkt nicht" : `nicht gelöscht${multi.ok ? ` (${multi.value.Errors?.[0]?.Code ?? "Fehlerliste"})` : `: ${multi.error}`}`);
  const shorten = await tryIt(() => c.send(new PutObjectRetentionCommand({ Bucket, Key: `${PREFIX}md5.txt`, VersionId: v1, Retention: { Mode: "COMPLIANCE", RetainUntilDate: new Date(Date.now() + 60_000) } })));
  record("4d Sperre verkürzen", !shorten.ok, shorten.ok ? "VERKÜRZT – Sperre wirkt nicht" : `abgelehnt: ${shorten.error}`);
  const downgrade = await tryIt(() => c.send(new PutObjectRetentionCommand({ Bucket, Key: `${PREFIX}md5.txt`, VersionId: v1, Retention: { Mode: "GOVERNANCE", RetainUntilDate: until ? new Date(until) : new Date(Date.now() + 86_400_000) } })));
  record("4e Auf GOVERNANCE herabstufen", !downgrade.ok, downgrade.ok ? "HERABGESTUFT – Sperre wirkt nicht" : `abgelehnt: ${downgrade.error}`);
  const marker = await tryIt(() => c.send(new DeleteObjectCommand({ Bucket, Key: `${PREFIX}md5.txt` })));
  const still = await tryIt(async () => sha(await body(await c.send(new GetObjectCommand({ Bucket, Key: `${PREFIX}md5.txt`, VersionId: v1 })))));
  record("4f Löschmarker statt Löschen", still.ok && still.value === sha(payload), `${marker.ok ? "Löschmarker gesetzt" : `Löschen ohne Version: ${marker.error}`}; die gesperrte Fassung ist ${still.ok && still.value === sha(payload) ? "unverändert abrufbar" : "NICHT mehr abrufbar"}`);
  const over = await tryIt(() => strict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}default.txt`, Body: Buffer.from("überschrieben"), ContentMD5: md5(Buffer.from("überschrieben")) })));
  const versionsA = (await c.send(new ListObjectVersionsCommand({ Bucket, Prefix: `${PREFIX}default.txt` }))).Versions ?? [];
  record("4g Überschreiben", over.ok && versionsA.length >= 2, over.ok ? `neue Fassung angelegt, ${versionsA.length} Fassungen vorhanden – die alte bleibt` : over.error);

  // 5) Lifecycle-Regel (Wirkung erst nach 24 h prüfbar: --after-retention)
  const lc = await tryIt(() => strict.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: [{ ID: "rb-test-ablauf", Status: "Enabled", Filter: { Prefix: `${PREFIX}lc/` }, Expiration: { Days: 1 }, NoncurrentVersionExpiration: { NoncurrentDays: 1 } }] } })));
  const lcBack = await tryIt(() => c.send(new GetBucketLifecycleConfigurationCommand({ Bucket })));
  record("5a Lifecycle-Regel setzen", lc.ok && lcBack.ok, lc.ok ? `angenommen (${lcBack.ok ? `${lcBack.value.Rules?.length ?? 0} Regel(n) gelesen` : "Auslesen: " + lcBack.error})` : `abgelehnt: ${lc.error}`);
  const lcObj = Buffer.from("läuft nach 1 Tag ab\n");
  const lcPut = await tryIt(() => strict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}lc/ablauf.txt`, Body: lcObj, ContentMD5: md5(lcObj) })));
  record("5b Objekt für Lifecycle", lcPut.ok, lcPut.ok ? "abgelegt – Wirkung mit --after-retention prüfen" : lcPut.error);

  // 7) Rundlauf: 1 MB einzeln und 12 MB in Teilen (wie große Dumps), jeweils mit Prüfsumme je Teil
  const one = randomBytes(1024 * 1024);
  const p1 = await tryIt(() => strict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}rundlauf-1mb.bin`, Body: one, ContentMD5: md5(one) })));
  const g1 = p1.ok ? await tryIt(async () => sha(await body(await c.send(new GetObjectCommand({ Bucket, Key: `${PREFIX}rundlauf-1mb.bin` }))))) : { ok: false };
  record("7a Rundlauf 1 MB", p1.ok && g1.ok && g1.value === sha(one), p1.ok ? (g1.ok && g1.value === sha(one) ? "SHA-256 identisch" : "Prüfsumme weicht ab") : p1.error);
  const big = randomBytes(12 * 1024 * 1024);
  const parts = [big.subarray(0, 5 * 1024 * 1024), big.subarray(5 * 1024 * 1024, 10 * 1024 * 1024), big.subarray(10 * 1024 * 1024)];
  const key = `${PREFIX}rundlauf-12mb-teile.bin`;
  let uploadId;
  const mp = await tryIt(async () => {
    uploadId = (await strict.send(new CreateMultipartUploadCommand({ Bucket, Key: key }))).UploadId;
    const done = [];
    for (let i = 0; i < parts.length; i++) done.push({ PartNumber: i + 1, ETag: (await strict.send(new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: i + 1, Body: parts[i], ContentMD5: md5(parts[i]) }))).ETag });
    await strict.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: done } }));
  });
  if (!mp.ok && uploadId) await tryIt(() => strict.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })));
  const g2 = mp.ok ? await tryIt(async () => sha(await body(await c.send(new GetObjectCommand({ Bucket, Key: key }))))) : { ok: false };
  record("7b Rundlauf 12 MB in Teilen", mp.ok && g2.ok && g2.value === sha(big), mp.ok ? (g2.ok && g2.value === sha(big) ? "SHA-256 identisch" : "Prüfsumme weicht ab") : `Teil-Upload: ${mp.error}`);

  // Probe für --after-retention: muss sich nach Ablauf der Sperre löschen lassen
  const probe = Buffer.from("Ablaufprobe\n");
  await tryIt(() => strict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}ablaufprobe.txt`, Body: probe, ContentMD5: md5(probe) })));
  console.log(`\nNächster Schritt frühestens ${until ? new Date(new Date(until).getTime() + 60_000).toISOString() : "in 24 Stunden"}: --after-retention`);
}

async function versionsUnder(prefix) {
  const out = { versions: [], markers: [] };
  let KeyMarker, VersionIdMarker;
  do {
    const r = await c.send(new ListObjectVersionsCommand({ Bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
    out.versions.push(...(r.Versions ?? [])); out.markers.push(...(r.DeleteMarkers ?? []));
    KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined; VersionIdMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (KeyMarker);
  return out;
}

// Bucket-Einstellungen nur lesen. Den Policy-Inhalt nicht ausgeben, er kann Access-Key-IDs enthalten.
async function bucketState() {
  const lock = await tryIt(() => c.send(new GetObjectLockConfigurationCommand({ Bucket })));
  const rule = lock.ok ? lock.value.ObjectLockConfiguration?.Rule?.DefaultRetention : null;
  record("B1 Object Lock", lock.ok && lock.value.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled",
    lock.ok ? `aktiv, Standard-Sperre ${rule ? `${rule.Mode} ${rule.Days ? `${rule.Days} Tag(e)` : `${rule.Years} Jahr(e)`}` : "keine"}` : lock.error);
  const ver = await tryIt(() => c.send(new GetBucketVersioningCommand({ Bucket })));
  record("B2 Versionierung", ver.ok && ver.value.Status === "Enabled", ver.ok ? `Status ${ver.value.Status ?? "aus"}` : ver.error);
  const lc = await tryIt(() => c.send(new GetBucketLifecycleConfigurationCommand({ Bucket })));
  const rules = lc.ok ? lc.value.Rules ?? [] : [];
  record("B3 Lifecycle-Regel", rules.some((r) => r.ID === "rb-test-ablauf" && r.Status === "Enabled"), lc.ok
    ? rules.map((r) => `${r.ID} ${r.Status}, Präfix ${r.Filter?.Prefix ?? r.Prefix ?? "?"}, Ablauf ${r.Expiration?.Days ?? "–"} Tag, alte Fassungen ${r.NoncurrentVersionExpiration?.NoncurrentDays ?? "–"} Tag`).join("; ")
    : lc.error);
  const pol = await tryIt(() => c.send(new GetBucketPolicyCommand({ Bucket })));
  record("B4 Bucket-Policy", null, pol.ok ? "vorhanden (Inhalt nicht ausgegeben)" : pol.error.startsWith("NoSuchBucketPolicy") ? "keine gesetzt" : `Abfrage: ${pol.error}`);
}

// Bestand des ganzen Test-Buckets mit Sperrfristen. Fassungen außerhalb von rb-test/ sind eine Abweichung: Abbruch vor jedem Löschen.
async function stock(id) {
  const all = await versionsUnder("");
  const outside = [...all.versions, ...all.markers].filter((v) => !v.Key.startsWith(PREFIX));
  if (outside.length) { record(id, false, `${outside.length} Fassung(en) außerhalb von ${PREFIX} – Abweichung, Abbruch vor jedem Löschen`); process.exit(3); }
  const now = new Date();
  let locked = 0, last = null;
  for (const v of all.versions) {
    const r = await tryIt(() => c.send(new GetObjectRetentionCommand({ Bucket, Key: v.Key, VersionId: v.VersionId })));
    const until = r.ok && r.value.Retention?.RetainUntilDate ? new Date(r.value.Retention.RetainUntilDate) : null;
    if (until && until > now) locked++;
    if (until && (!last || until > last)) last = until;
  }
  // Legal Holds laufen nicht ab; unvollständige Teil-Uploads werden berechnet, ohne als Fassung zu erscheinen.
  let holds = 0, holdUnknown = 0;
  for (const v of all.versions) {
    const h = await tryIt(() => c.send(new GetObjectLegalHoldCommand({ Bucket, Key: v.Key, VersionId: v.VersionId })));
    if (h.ok) { if (h.value.LegalHold?.Status === "ON") holds++; } else if (!/NoSuchObjectLockConfiguration|NoSuchLegalHold/.test(h.error)) holdUnknown++;
  }
  const mpu = await tryIt(() => c.send(new ListMultipartUploadsCommand({ Bucket, Prefix: PREFIX })));
  const parts = mpu.ok ? (mpu.value.Uploads ?? []).length : null;
  record(id, null, `${all.versions.length} Fassung(en), ${all.markers.length} Löschmarker, alle unter ${PREFIX}; ${locked} noch gesperrt${last ? `, spätestes Sperrende ${last.toISOString()}` : ""}; Legal Hold an: ${holds}${holdUnknown ? `, unklar: ${holdUnknown}` : ""}; unvollständige Teil-Uploads: ${parts ?? `nicht lesbar (${mpu.error})`}`);
  return { ...all, locked, last };
}

// Je Objekt: Anzahl Fassungen und Löschmarker, und ob die aktuelle Fassung ein Löschmarker ist (nur lesend).
async function perKey(id) {
  const all = await versionsUnder(PREFIX);
  const keys = new Map();
  for (const v of all.versions) { const k = keys.get(v.Key) ?? { versions: 0, markers: 0, top: "" }; k.versions++; if (v.IsLatest) k.top = `Fassung vom ${new Date(v.LastModified).toISOString().slice(0, 16)}Z`; keys.set(v.Key, k); }
  for (const m of all.markers) { const k = keys.get(m.Key) ?? { versions: 0, markers: 0, top: "" }; k.markers++; if (m.IsLatest) k.top = `Löschmarker vom ${new Date(m.LastModified).toISOString().slice(0, 16)}Z`; keys.set(m.Key, k); }
  for (const [key, k] of [...keys].sort()) record(id, null, `${key}: ${k.versions} Fassung(en), ${k.markers} Löschmarker; aktuell: ${k.top || "–"}`);
}

// Stand der Lifecycle-Regel unter rb-test/lc/: noch nicht gewirkt, nur Löschmarker gesetzt oder Fassung entfernt.
async function lifecycleState(id) {
  const lc = await versionsUnder(`${PREFIX}lc/`);
  const markerOnTop = lc.markers.some((m) => m.IsLatest);
  const text = lc.versions.length === 0 && lc.markers.length === 0 ? "Objekt samt aller Fassungen entfernt – Expiration und NoncurrentVersionExpiration haben gewirkt"
    : lc.versions.length === 0 ? `Fassung entfernt, ${lc.markers.length} Löschmarker übrig`
    : markerOnTop ? `Expiration hat einen Löschmarker gesetzt, die alte Fassung ist noch da (${lc.versions.length}); NoncurrentVersionExpiration steht aus`
    : `noch nicht gewirkt: ${lc.versions.length} Fassung, kein Löschmarker`;
  record(id, null, `Lifecycle unter ${PREFIX}lc/: ${text}`);
  return lc;
}

async function afterRetention() {
  const before = await stock("A0 Bestand vorher");
  record("A0 Sperre abgelaufen", before.locked === 0, before.locked === 0
    ? `keine Fassung mehr gesperrt (spätestes Sperrende ${before.last?.toISOString() ?? "?"})`
    : `${before.locked} Fassung(en) noch gesperrt – später erneut, nichts gelöscht`);
  if (before.locked) return;
  // Gelöscht werden nur die am Tag 0 geschützten und dafür vorgesehenen Fassungen: Ablaufprobe und md5.txt (Prüfungen 4a–4e).
  // Löschen mit Versions-ID entfernt die Fassung endgültig; ein Löschmarker darf dabei nicht entstehen.
  for (const [id, key] of [["A1 Ablaufprobe endgültig löschen", `${PREFIX}ablaufprobe.txt`], ["A1b In 4a geschützte Fassung endgültig löschen", `${PREFIX}md5.txt`]]) {
    const pre = await versionsUnder(key);
    const vs = pre.versions.filter((v) => v.Key === key);
    const markersBefore = pre.markers.filter((m) => m.Key === key).length;
    if (!vs.length) { record(id, false, `${key}: keine Fassung gefunden`); continue; }
    let deleted = 0, failure = "";
    for (const v of vs) {
      const d = await tryIt(() => c.send(new DeleteObjectCommand({ Bucket, Key: key, VersionId: v.VersionId })));
      if (d.ok) deleted++; else failure = d.error;
    }
    const post = await versionsUnder(key);
    const left = post.versions.filter((v) => v.Key === key).length;
    const markersAfter = post.markers.filter((m) => m.Key === key).length;
    record(id, deleted === vs.length && left === 0 && markersAfter === markersBefore, left === 0
      ? `${deleted} Fassung(en) endgültig entfernt; Löschmarker vorher ${markersBefore}, nachher ${markersAfter} (kein neuer)`
      : `${left} Fassung(en) bleiben${failure ? ` (${failure})` : ""}`);
  }
  await lifecycleState("A2 Lifecycle");
  await stock("A3 Bestand nachher");
}

async function cleanup() {
  const mpu = await tryIt(() => c.send(new ListMultipartUploadsCommand({ Bucket, Prefix: PREFIX })));
  let abortedParts = 0;
  for (const m of mpu.ok ? mpu.value.Uploads ?? [] : []) if ((await tryIt(() => c.send(new AbortMultipartUploadCommand({ Bucket, Key: m.Key, UploadId: m.UploadId })))).ok) abortedParts++;
  record("C0 Teil-Uploads", mpu.ok && abortedParts === (mpu.value.Uploads ?? []).length, mpu.ok ? `${abortedParts} von ${(mpu.value.Uploads ?? []).length} unvollständigen Teil-Uploads abgebrochen` : `nicht lesbar (${mpu.error})`);
  const all = await versionsUnder(PREFIX);
  let removed = 0, locked = 0;
  let held = 0, unclear = 0;
  for (const v of [...all.versions, ...all.markers]) {
    const r = await tryIt(() => c.send(new DeleteObjectCommand({ Bucket, Key: v.Key, VersionId: v.VersionId })));
    if (r.ok) { removed++; continue; }
    locked++;
    // Legal Holds laufen nicht ab: getrennt melden, damit „später erneut“ nicht in die Irre führt.
    const h = await tryIt(() => c.send(new GetObjectLegalHoldCommand({ Bucket, Key: v.Key, VersionId: v.VersionId })));
    if (h.ok && h.value.LegalHold?.Status === "ON") held++;
    else if (!h.ok && !/NoSuchObjectLockConfiguration|NoSuchLegalHold/.test(h.error)) unclear++;
  }
  const timed = locked - held - unclear;
  record("C Aufräumen", locked === 0, `${removed} Fassungen/Löschmarker unter ${PREFIX} entfernt${timed ? `, ${timed} noch zeitlich gesperrt – später erneut` : ""}${held ? `, ${held} mit Legal Hold (läuft nicht ab; Rückweg F1 in docs/backup-policy-test.md)` : ""}${unclear ? `, ${unclear} nicht löschbar und Hold-Zustand unklar (z. B. Writer-Besitz; siehe docs/backup-policy-test.md, Abschnitt 5)` : ""}. Den leeren Bucket löschst du danach in der Console.`);
}

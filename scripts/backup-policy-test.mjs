// Policy-Test: eingeschränkter Schreibschlüssel aus einem eigenen Projekt am Backup-Test-Bucket (Anleitung: docs/backup-policy-test.md).
// Läuft in einem Wegwerf-Container aus dem App-Image (dort liegt @aws-sdk/client-s3) mit zwei Zugangsdateien:
//   /root/backup-test.env         Test-Admin-Schlüssel aus dem Projekt des Buckets (setzt und entfernt die Policy, prüft nach)
//   /root/backup-writer-test.env  Writer-Testschlüssel aus dem Projekt „Rent-Base Backup-Writer“ (wird geprüft)
// Geschrieben wird nur unter rb-test/policy/ im Test-Bucket. Schlüssel werden nie ausgegeben, die Policy auch nicht
// (sie enthält die Access-Key-ID des Writers). Verbotsversuche setzen, wo möglich, genau die bestehende Einstellung erneut,
// damit sich auch bei einer unerwarteten Erlaubnis nichts ändert. Sperrfristen im Test höchstens 36 Stunden.
//
// Aufruf (Server, siehe Anleitung):
//   node backup-policy-test.mjs --run      Policy setzen, erlaubte und verbotene Aktionen prüfen, mit dem Admin-Schlüssel nachprüfen
//   node backup-policy-test.mjs --finish   Policy entfernen und den Ausgangszustand (keine Policy, Writer ohne Zugriff) bestätigen
// Exit: 0 alles wie erwartet · 1 Abweichung · 2 Konfiguration abgelehnt · 3 Vorbedingung nicht erfüllt (nichts geändert)

import { createHash, randomBytes } from "node:crypto";
import s3 from "@aws-sdk/client-s3";

const {
  S3Client, ListBucketsCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  GetBucketPolicyCommand, PutBucketPolicyCommand, DeleteBucketPolicyCommand, GetBucketLocationCommand, GetObjectLockConfigurationCommand,
  PutObjectLockConfigurationCommand, GetObjectRetentionCommand, PutObjectRetentionCommand, PutObjectLegalHoldCommand, GetObjectLegalHoldCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand, GetBucketVersioningCommand, PutBucketVersioningCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} = s3;

const PREFIX = "rb-test/policy/";
const PRODUCTION_BUCKETS = ["rent-base-files", "rent-base-backup"];
const mode = process.argv.includes("--finish") ? "finish" : process.argv.includes("--run") ? "run" : null;
const env = process.env;
const fail = (code, text) => { console.log(`ABBRUCH: ${text}`); process.exit(code); };
if (!mode) fail(2, "Modus fehlt (--run oder --finish)");
const missing = ["TEST_S3_ENDPOINT", "TEST_S3_BUCKET", "TEST_S3_ACCESS_KEY", "TEST_S3_SECRET_KEY", "WRITER_S3_ENDPOINT", "WRITER_PROJECT_ID", "WRITER_S3_ACCESS_KEY", "WRITER_S3_SECRET_KEY"].filter((k) => !env[k]);
if (missing.length) fail(2, `es fehlen ${missing.join(", ")}`);
const Bucket = env.TEST_S3_BUCKET;
if (!/test/i.test(Bucket) || PRODUCTION_BUCKETS.includes(Bucket)) fail(2, `„${Bucket}“ ist kein Test-Bucket`);
if (!/^\d{1,12}$/.test(env.WRITER_PROJECT_ID)) fail(2, "WRITER_PROJECT_ID ist keine Projekt-ID");
if (env.WRITER_S3_ACCESS_KEY === env.TEST_S3_ACCESS_KEY) fail(2, "Writer- und Admin-Schlüssel sind gleich");

const client = (ak, sk, endpoint, region, extra = {}) => new S3Client({ endpoint, region: region || "hel1", forcePathStyle: true, credentials: { accessKeyId: ak, secretAccessKey: sk }, ...extra });
const A = client(env.TEST_S3_ACCESS_KEY, env.TEST_S3_SECRET_KEY, env.TEST_S3_ENDPOINT, env.TEST_S3_REGION);
const Astrict = client(env.TEST_S3_ACCESS_KEY, env.TEST_S3_SECRET_KEY, env.TEST_S3_ENDPOINT, env.TEST_S3_REGION, { requestChecksumCalculation: "WHEN_REQUIRED" });
const W = client(env.WRITER_S3_ACCESS_KEY, env.WRITER_S3_SECRET_KEY, env.WRITER_S3_ENDPOINT, env.WRITER_S3_REGION);
const Wstrict = client(env.WRITER_S3_ACCESS_KEY, env.WRITER_S3_SECRET_KEY, env.WRITER_S3_ENDPOINT, env.WRITER_S3_REGION, { requestChecksumCalculation: "WHEN_REQUIRED" });

const results = [];
const record = (id, ok, text) => { results.push({ id, ok }); console.log(`${ok === true ? "BESTANDEN " : ok === false ? "NICHT OK  " : "HINWEIS   "} ${id}: ${text}`); };
const err = (e) => `${e?.name ?? "Fehler"}${e?.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : ""}`;
const tryIt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: err(e) }; } };
const isDenied = (r) => !r.ok && /AccessDenied|Forbidden|HTTP 403/.test(r.error);
const md5 = (b) => createHash("md5").update(b).digest("base64");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const body = async (r) => Buffer.from(await r.Body.transformToByteArray());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abort = (e) => { console.log(`ABBRUCH: unerwarteter Fehler ${err(e)} (Details aus Sicherheitsgründen nicht ausgegeben)`); process.exit(1); };
process.on("uncaughtException", abort);
process.on("unhandledRejection", abort);

// Erlaubt erwartet: bestanden, wenn die Aktion gelingt.
const expectAllowed = (id, label, r, okText = "erlaubt") => record(id, r.ok, r.ok ? `${label}: ${okText}` : `${label}: abgewiesen (${r.error}) – die Policy gewährt das nicht`);
// Verboten erwartet: bestanden bei AccessDenied; eine andere Ablehnung ist ein Hinweis, eine Erlaubnis eine Abweichung.
const expectDenied = (id, label, r, allowedText = "ERLAUBT – die Policy wirkt hier nicht") => {
  if (isDenied(r)) record(id, true, `${label}: abgewiesen (${r.error})`);
  else if (r.ok) record(id, false, `${label}: ${allowedText}`);
  else record(id, null, `${label}: nicht von der Policy abgewiesen, sondern ${r.error}`);
};

const principal = `arn:aws:iam:::user/p${env.WRITER_PROJECT_ID}:${env.WRITER_S3_ACCESS_KEY}`;
const res = [`arn:aws:s3:::${Bucket}`, `arn:aws:s3:::${Bucket}/*`];
const SIDS = ["WriterDarf", "WriterDarfLoeschmarkerNurInFiles", "WriterDarfNie"];
const policyDoc = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    { Sid: SIDS[0], Effect: "Allow", Principal: { AWS: [principal] }, Resource: res,
      Action: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketObjectLockConfiguration"] },
    { Sid: SIDS[1], Effect: "Allow", Principal: { AWS: [principal] }, Resource: [`arn:aws:s3:::${Bucket}/${PREFIX}files/*`],
      Action: ["s3:DeleteObject"] },
    { Sid: SIDS[2], Effect: "Deny", Principal: { AWS: [principal] }, Resource: res,
      Action: ["s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy", "s3:PutLifecycleConfiguration", "s3:PutBucketVersioning", "s3:PutBucketObjectLockConfiguration"] },
  ],
});
// Stimmt eine gelesene Policy mit unserer überein? Nur Struktur und Principal vergleichen, nichts ausgeben.
const samePolicy = (text) => {
  try {
    const p = JSON.parse(text);
    const st = Array.isArray(p.Statement) ? p.Statement : [p.Statement];
    const principals = (s) => [s.Principal?.AWS ?? s.Principal].flat().map(String);
    return SIDS.every((sid) => st.some((s) => s.Sid === sid && principals(s).includes(principal)));
  } catch { return false; }
};

console.log(`Test-Bucket ${Bucket} · Endpunkt ${new URL(env.TEST_S3_ENDPOINT).host} · Writer-Projekt ${env.WRITER_PROJECT_ID} · Modus ${mode}`);

// Isolation des Admin-Schlüssels wie im Bucket-Test: außer dem Test-Bucket kein Bucket sichtbar.
const adminList = await tryIt(() => A.send(new ListBucketsCommand({})));
const adminNames = adminList.ok ? (adminList.value.Buckets ?? []).map((b) => b.Name) : [];
if (!adminList.ok) fail(3, `Admin-Anmeldung abgelehnt (${adminList.error}). Nichts geändert.`);
if (adminNames.some((n) => n !== Bucket)) fail(3, `Admin-Schlüssel sieht weitere Buckets (${adminNames.filter((n) => n !== Bucket).join(", ")}). Nichts geändert.`);
record("V0 Isolation Admin", true, `Admin-Schlüssel sieht nur ${Bucket}`);

try {
  if (mode === "run") await run();
  else await finish();
} catch (e) { abort(e); }
const failed = results.filter((r) => r.ok === false).length;
console.log(`\nErgebnis: ${results.filter((r) => r.ok === true).length} bestanden, ${failed} nicht ok, ${results.filter((r) => r.ok === null).length} Hinweise`);
process.exitCode = failed ? 1 : 0;

async function run() {
  // V: Vorbedingungen, nichts wird geändert
  const wList = await tryIt(() => W.send(new ListBucketsCommand({})));
  if (!wList.ok) fail(3, `Writer-Anmeldung abgelehnt (${wList.error}). Nichts geändert.`);
  const wNames = (wList.value.Buckets ?? []).map((b) => b.Name);
  if (wNames.includes(Bucket) || wNames.some((n) => PRODUCTION_BUCKETS.includes(n))) fail(3, "der Writer-Schlüssel sieht den Test- oder einen Produktions-Bucket – er stammt nicht aus einem eigenen Projekt. Nichts geändert.");
  record("V1 Writer aus eigenem Projekt", true, `Writer sieht ${wNames.length} eigene Bucket(s), nicht den Test-Bucket`);
  const before = await tryIt(() => W.send(new ListObjectsV2Command({ Bucket, Prefix: PREFIX, MaxKeys: 1 })));
  if (before.ok) fail(3, "der Writer darf den Test-Bucket schon ohne Policy lesen – unerwartet. Nichts geändert.");
  record("V2 Writer ohne Policy", isDenied(before), `Zugriff auf den Test-Bucket ${isDenied(before) ? "abgewiesen" : `nicht möglich (${before.error})`}`);
  const existing = await tryIt(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  if (existing.ok) fail(3, "am Test-Bucket ist bereits eine Policy gesetzt – unerwartet. Nichts geändert.");
  const snapLock = await tryIt(() => A.send(new GetObjectLockConfigurationCommand({ Bucket })));
  const snapLc = await tryIt(() => A.send(new GetBucketLifecycleConfigurationCommand({ Bucket })));
  const snapVer = await tryIt(() => A.send(new GetBucketVersioningCommand({ Bucket })));
  if (!snapLock.ok || !snapVer.ok) fail(3, "Bucket-Einstellungen nicht lesbar. Nichts geändert.");
  record("V3 Ausgangszustand", true, `keine Policy; Standard-Sperre ${snapLock.value.ObjectLockConfiguration?.Rule?.DefaultRetention?.Mode ?? "keine"}, Versionierung ${snapVer.value.Status}, ${snapLc.ok ? (snapLc.value.Rules ?? []).length : 0} Lifecycle-Regel(n)`);

  // S: Policy setzen (Admin) und Wirkung abwarten
  const put = await tryIt(() => A.send(new PutBucketPolicyCommand({ Bucket, Policy: policyDoc })));
  record("S1 Policy gesetzt", put.ok, put.ok ? "mit dem Admin-Schlüssel gesetzt (Inhalt nicht ausgegeben)" : `abgelehnt: ${put.error}`);
  if (!put.ok) return;
  const back = await tryIt(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  record("S2 Policy zurückgelesen", back.ok && samePolicy(back.value.Policy), back.ok ? (samePolicy(back.value.Policy) ? "drei Anweisungen mit dem Writer-Principal vorhanden" : "weicht von der gesetzten Policy ab") : back.error);
  let p1;
  for (let i = 0; i < 12; i++) { p1 = await tryIt(() => W.send(new ListObjectsV2Command({ Bucket, Prefix: PREFIX }))); if (p1.ok) break; await sleep(5000); }
  expectAllowed("P1 Auflisten (ListObjectsV2, wie Coolifys Verbindungstest)", "ListObjectsV2", p1);
  if (!p1.ok) { record("P1", false, "Policy wirkt nach 60 Sekunden nicht – weitere Writer-Tests übersprungen; mit --finish entfernen"); return; }

  // P: erlaubte Aktionen mit dem Writer-Schlüssel
  expectAllowed("P2", "GetBucketLocation", await tryIt(() => W.send(new GetBucketLocationCommand({ Bucket }))));
  expectAllowed("P3", "GetObjectLockConfiguration (für mc)", await tryIt(() => W.send(new GetObjectLockConfigurationCommand({ Bucket }))));
  const small = Buffer.from(`RentBase Policy-Test ${new Date().toISOString()}\n`);
  const p4 = await tryIt(() => W.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}db/probe.txt`, Body: small })));
  expectAllowed("P4", "PutObject (SDK-Standard)", p4);
  const p5 = await tryIt(() => Wstrict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}files/probe.txt`, Body: small, ContentMD5: md5(small) })));
  expectAllowed("P5", "PutObject mit Content-MD5 unter files/", p5);
  const big = randomBytes(12 * 1024 * 1024);
  const parts = [big.subarray(0, 5 << 20), big.subarray(5 << 20, 10 << 20), big.subarray(10 << 20)];
  const key = `${PREFIX}db/teile.bin`;
  let uploadId;
  const p6 = await tryIt(async () => {
    uploadId = (await Wstrict.send(new CreateMultipartUploadCommand({ Bucket, Key: key }))).UploadId;
    const done = [];
    for (let i = 0; i < parts.length; i++) done.push({ PartNumber: i + 1, ETag: (await Wstrict.send(new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: i + 1, Body: parts[i], ContentMD5: md5(parts[i]) }))).ETag });
    await Wstrict.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: done } }));
  });
  if (!p6.ok && uploadId) await tryIt(() => Wstrict.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })));
  expectAllowed("P6", "Teil-Upload 12 MB", p6);
  const g = p6.ok ? await tryIt(async () => sha(await body(await W.send(new GetObjectCommand({ Bucket, Key: key }))))) : { ok: false, error: "kein Upload" };
  record("P7 GetObject", g.ok && g.value === sha(big), g.ok ? (g.value === sha(big) ? "GetObject: erlaubt, SHA-256 identisch" : "GetObject: Prüfsumme weicht ab") : `GetObject: ${g.error}`);
  const v4 = p4.ok ? p4.value.VersionId : undefined;
  const p8 = v4 ? await tryIt(async () => sha(await body(await W.send(new GetObjectCommand({ Bucket, Key: `${PREFIX}db/probe.txt`, VersionId: v4 }))))) : { ok: false, error: "keine Versions-ID" };
  record("P8 GetObjectVersion", p8.ok && p8.value === sha(small), p8.ok ? "GetObject mit Versions-ID: erlaubt" : `GetObject mit Versions-ID: ${p8.error}`);
  const p9 = await tryIt(() => W.send(new DeleteObjectCommand({ Bucket, Key: `${PREFIX}files/probe.txt` })));
  const p9v = await tryIt(() => A.send(new ListObjectVersionsCommand({ Bucket, Prefix: `${PREFIX}files/probe.txt` })));
  const keptData = p9v.ok && (p9v.value.Versions ?? []).length >= 1 && (p9v.value.DeleteMarkers ?? []).length >= 1;
  record("P9 DeleteObject unter files/", p9.ok && keptData, p9.ok ? `erlaubt, ${keptData ? "nur Löschmarker, die Fassung bleibt" : "Fassung NICHT mehr vorhanden"}` : `abgewiesen (${p9.error}) – die Dateisicherung könnte legitime Löschungen nicht übernehmen`);

  // N: verbotene Aktionen mit dem Writer-Schlüssel
  expectDenied("N1", "DeleteObject außerhalb von files/ (db/)", await tryIt(() => W.send(new DeleteObjectCommand({ Bucket, Key: `${PREFIX}db/probe.txt` }))), "ERLAUBT – die Präfix-Einschränkung wirkt nicht (nur Löschmarker, Daten bleiben)");

  // N2: endgültiges Löschen einer Fassung, deren Sperre schon abgelaufen ist (nur die Policy kann es verhindern)
  const unl = Buffer.from("Fassung mit 60 Sekunden Sperre\n");
  const unlUntil = new Date(Date.now() + 60_000);
  const u = await tryIt(() => Astrict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}ungesperrt/probe.txt`, Body: unl, ContentMD5: md5(unl), ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: unlUntil })));
  if (!u.ok) record("N2", null, `nicht prüfbar: Admin-Upload mit kurzer Sperre abgelehnt (${u.error})`);
  else {
    await sleep(unlUntil.getTime() - Date.now() + 10_000);
    const r = await tryIt(() => A.send(new GetObjectRetentionCommand({ Bucket, Key: `${PREFIX}ungesperrt/probe.txt`, VersionId: u.value.VersionId })));
    const expired = r.ok && new Date(r.value.Retention?.RetainUntilDate) < new Date();
    if (!expired) record("N2", null, "nicht prüfbar: Sperre der Prüffassung noch aktiv");
    else {
      const d = await tryIt(() => W.send(new DeleteObjectCommand({ Bucket, Key: `${PREFIX}ungesperrt/probe.txt`, VersionId: u.value.VersionId })));
      expectDenied("N2", "Fassung endgültig löschen (DeleteObjectVersion, Sperre abgelaufen)", d, "ERLAUBT – der Writer kann Fassungen nach Sperrende endgültig löschen");
    }
  }
  const until36 = new Date(Date.now() + 36 * 3600_000);
  expectDenied("N3", "Sperre verlängern (PutObjectRetention, 36 h)", await tryIt(() => W.send(new PutObjectRetentionCommand({ Bucket, Key: `${PREFIX}db/probe.txt`, VersionId: v4, Retention: { Mode: "COMPLIANCE", RetainUntilDate: until36 } }))), "ERLAUBT – der Writer kann Sperren verlängern (Fassung jetzt 36 h gesperrt)");
  const lockBody = Buffer.from("Upload mit eigener Sperre\n");
  expectDenied("N4", "Upload mit eigener Sperre (Object-Lock-Header, 36 h)", await tryIt(() => Wstrict.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}db/eigene-sperre.txt`, Body: lockBody, ContentMD5: md5(lockBody), ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: until36 }))), "ERLAUBT – der Writer kann beim Hochladen eigene Sperren setzen (Objekt 36 h gesperrt)");
  const lh = await tryIt(() => W.send(new PutObjectLegalHoldCommand({ Bucket, Key: `${PREFIX}db/probe.txt`, VersionId: v4, LegalHold: { Status: "ON" } })));
  expectDenied("N5", "Legal Hold setzen", lh, "ERLAUBT – der Writer kann Legal Holds setzen (vom Admin sofort zurückgenommen)");
  if (lh.ok) await tryIt(() => A.send(new PutObjectLegalHoldCommand({ Bucket, Key: `${PREFIX}db/probe.txt`, VersionId: v4, LegalHold: { Status: "OFF" } })));
  expectDenied("N6", "Bucket-Policy setzen (identischer Inhalt)", await tryIt(() => W.send(new PutBucketPolicyCommand({ Bucket, Policy: policyDoc }))), "ERLAUBT – der Writer kann die Policy ändern (Inhalt blieb gleich)");
  const dp = await tryIt(() => W.send(new DeleteBucketPolicyCommand({ Bucket })));
  expectDenied("N7", "Bucket-Policy löschen", dp, "ERLAUBT – der Writer kann die Policy löschen (vom Admin sofort neu gesetzt)");
  if (dp.ok) await tryIt(() => A.send(new PutBucketPolicyCommand({ Bucket, Policy: policyDoc })));
  if (snapLc.ok) expectDenied("N8", "Lifecycle setzen (identische Regeln)", await tryIt(() => Wstrict.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: snapLc.value.Rules } }))), "ERLAUBT – der Writer kann Lifecycle-Regeln ändern (Inhalt blieb gleich)");
  else record("N8", null, "nicht prüfbar: keine Lifecycle-Regel zum identischen Neusetzen");
  expectDenied("N9", "Standard-Sperre setzen (identisch)", await tryIt(() => W.send(new PutObjectLockConfigurationCommand({ Bucket, ObjectLockConfiguration: snapLock.value.ObjectLockConfiguration }))), "ERLAUBT – der Writer kann die Standard-Sperre ändern (Inhalt blieb gleich)");
  expectDenied("N10", "Versionierung aussetzen", await tryIt(() => W.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Suspended" } }))), "ERLAUBT – Versionierung ausgesetzt");
  expectDenied("N11", "Bucket-Policy lesen", await tryIt(() => W.send(new GetBucketPolicyCommand({ Bucket }))), "erlaubt (nicht gewährt, aber nur lesend)");
  expectDenied("N12", "Sperrfrist lesen (GetObjectRetention)", await tryIt(() => W.send(new GetObjectRetentionCommand({ Bucket, Key: `${PREFIX}db/probe.txt`, VersionId: v4 }))), "erlaubt (nicht gewährt, aber nur lesend)");
  expectDenied("N13", "Fassungen auflisten (ListObjectVersions)", await tryIt(() => W.send(new ListObjectVersionsCommand({ Bucket, Prefix: PREFIX }))), "erlaubt (nicht gewährt, aber nur lesend)");

  // K: Kontrolle mit dem Admin-Schlüssel
  const k1 = await tryIt(() => A.send(new GetObjectRetentionCommand({ Bucket, Key: `${PREFIX}db/probe.txt`, VersionId: v4 })));
  record("K1 Standard-Sperre auf Writer-Uploads", k1.ok && k1.value.Retention?.Mode === "COMPLIANCE", k1.ok ? `${k1.value.Retention?.Mode} bis ${new Date(k1.value.Retention?.RetainUntilDate).toISOString()}` : k1.error);
  const lock = await tryIt(() => A.send(new GetObjectLockConfigurationCommand({ Bucket })));
  const lc = await tryIt(() => A.send(new GetBucketLifecycleConfigurationCommand({ Bucket })));
  const ver = await tryIt(() => A.send(new GetBucketVersioningCommand({ Bucket })));
  const same = lock.ok && JSON.stringify(lock.value.ObjectLockConfiguration) === JSON.stringify(snapLock.value.ObjectLockConfiguration)
    && ver.ok && ver.value.Status === snapVer.value.Status
    && (!snapLc.ok || (lc.ok && JSON.stringify(lc.value.Rules) === JSON.stringify(snapLc.value.Rules)));
  record("K2 Bucket-Einstellungen unverändert", same, same ? "Standard-Sperre, Versionierung und Lifecycle wie vor dem Test" : "ABWEICHUNG gegenüber dem Ausgangszustand");
  const pol = await tryIt(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  record("K3 Policy unverändert", pol.ok && samePolicy(pol.value.Policy), pol.ok ? (samePolicy(pol.value.Policy) ? "wie gesetzt" : "weicht ab") : pol.error);
  const hold = v4 ? await tryIt(() => A.send(new GetObjectLegalHoldCommand({ Bucket, Key: `${PREFIX}db/probe.txt`, VersionId: v4 }))) : { ok: false, error: "keine Versions-ID" };
  record("K4 Kein Legal Hold", !hold.ok || hold.value.LegalHold?.Status !== "ON", hold.ok ? `Status ${hold.value.LegalHold?.Status ?? "keiner"}` : `nicht gesetzt (${hold.error})`);
  console.log("\nDie Policy bleibt für den mc-Teil gesetzt; danach entfernt --finish sie.");
}

async function finish() {
  const del = await tryIt(() => A.send(new DeleteBucketPolicyCommand({ Bucket })));
  const gone = await tryIt(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  const none = !gone.ok && /NoSuchBucketPolicy/.test(gone.error);
  record("F1 Policy entfernt", none, none ? `entfernt${del.ok ? "" : ` (DeleteBucketPolicy: ${del.error})`}, Ausgangszustand ohne Policy` : gone.ok ? "Policy ist WEITERHIN gesetzt" : `Abfrage: ${gone.error}`);
  let w;
  for (let i = 0; i < 12; i++) { w = await tryIt(() => W.send(new ListObjectsV2Command({ Bucket, Prefix: PREFIX, MaxKeys: 1 }))); if (!w.ok) break; await sleep(5000); }
  record("F2 Writer wieder ohne Zugriff", isDenied(w), isDenied(w) ? "Zugriff auf den Test-Bucket abgewiesen" : w.ok ? "Writer hat WEITERHIN Zugriff" : `nicht möglich (${w.error})`);
  const inv = await tryIt(() => A.send(new ListObjectVersionsCommand({ Bucket, Prefix: PREFIX })));
  record("F3 Bestand rb-test/policy/", null, inv.ok ? `${(inv.value.Versions ?? []).length} Fassung(en), ${(inv.value.DeleteMarkers ?? []).length} Löschmarker (Aufräumen später mit --cleanup des Bucket-Tests)` : inv.error);
}

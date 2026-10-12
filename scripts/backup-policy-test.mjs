// Policy-Test: eingeschränkter Schreibschlüssel aus einem eigenen Projekt am Backup-Test-Bucket (Anleitung: docs/backup-policy-test.md).
// Läuft in einem Wegwerf-Container aus dem App-Image (dort liegt @aws-sdk/client-s3) mit zwei Zugangsdateien:
//   /root/backup-test.env         Test-Admin-Schlüssel aus dem Projekt des Buckets (setzt und entfernt die Policy, prüft nach)
//   /root/backup-writer-test.env  Writer-Testschlüssel aus dem Projekt „Rent-Base Backup-Writer“ (wird geprüft)
// und der Lauf-Kennung RB_RUN (vom Rahmenskript). Objektzugriffe – auch die erlaubten des Writers – gibt es nur unter
// rb-test/policy/<RB_RUN>/, das vor dem Lauf leer sein muss.
//
// Sicherheitsregeln:
// - Eine vorhandene Policy wird nie überschrieben: --run setzt nur, wenn zweimal nachgewiesen KEINE Policy besteht
//   (NoSuchBucketPolicy, unmittelbar vor dem Setzen erneut); jeder andere Zustand bricht ohne Änderung ab.
// - „Unsere“ Policy erkennt das Skript an den vier Kennungen, dem Writer-Testschlüssel als einzigem Principal, Ressourcen nur in
//   diesem Bucket und der Lauf-Kennung im Pfad. --finish entfernt nur die Policy DIESES Laufs; die eines anderen Laufs oder eine
//   fremde bleibt unverändert und wird gemeldet.
// - Unmittelbar vor dem Setzen gibt --run die Zeile „S0 Policy wird jetzt gesetzt“ aus; nur dann räumt das Rahmenskript auf.
// - --finish hebt zuerst Legal Holds im Laufpräfix auf (Admin, ersatzweise Writer, solange die Policy noch gilt), bricht
//   Teil-Uploads ab und entfernt danach die Policy. Wiederholbar; ändert nichts, wenn es nichts zu tun gibt.
// - Bucket-Einstellungen werden nur mit identischem, fest hinterlegtem Inhalt angefasst (Ausnahme N10: Versionierung aussetzen
//   ist bei Object Lock ohnehin unmöglich). Sperrfristen im Test höchstens 26 Stunden.
// - Schlüssel werden nie ausgegeben, die Policy auch nicht (sie enthält die Access-Key-ID des Writers).
// - Frühestens ab RB_FRUEHESTENS (Standard 13.10.2026 12:30 UTC, nach der letzten Lifecycle-Prüfung), damit die laufende
//   Lifecycle-Beobachtung im Test-Bucket nicht gestört wird.
//
// Aufruf (Server, siehe Anleitung): node backup-policy-test.mjs --run | --finish
// Exit --run:    0 wie erwartet · 1 Abweichung · 2 Konfiguration abgelehnt · 3 Vorbedingung nicht erfüllt (nichts geändert)
// Exit --finish: 0 aufgeräumt · 1 bleibender Befund (fremde Policy, Legal Hold nicht aufhebbar) · 4 vorübergehend, erneut versuchen

import { createHash, randomBytes } from "node:crypto";
import s3 from "@aws-sdk/client-s3";

const {
  S3Client, ListBucketsCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  GetBucketPolicyCommand, PutBucketPolicyCommand, DeleteBucketPolicyCommand, GetBucketLocationCommand, GetObjectLockConfigurationCommand,
  PutObjectLockConfigurationCommand, GetObjectRetentionCommand, PutObjectRetentionCommand, PutObjectLegalHoldCommand, GetObjectLegalHoldCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand, GetBucketVersioningCommand, PutBucketVersioningCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListMultipartUploadsCommand,
  GetObjectAclCommand,
} = s3;

const PRODUCTION_BUCKETS = ["rent-base-files", "rent-base-backup"];
const mode = process.argv.includes("--finish") ? "finish" : process.argv.includes("--run") ? "run" : null;
const env = process.env;
const fail = (code, text) => { console.log(`ABBRUCH: ${text}`); process.exit(code); };
if (!mode) fail(2, "Modus fehlt (--run oder --finish)");
const missing = ["TEST_S3_ENDPOINT", "TEST_S3_BUCKET", "TEST_S3_ACCESS_KEY", "TEST_S3_SECRET_KEY", "WRITER_S3_ENDPOINT", "WRITER_PROJECT_ID", "WRITER_S3_ACCESS_KEY", "WRITER_S3_SECRET_KEY", "RB_RUN"].filter((k) => !env[k]);
if (missing.length) fail(2, `es fehlen ${missing.join(", ")}`);
const Bucket = env.TEST_S3_BUCKET;
if (!/test/i.test(Bucket) || PRODUCTION_BUCKETS.includes(Bucket)) fail(2, `„${Bucket}“ ist kein Test-Bucket`);
if (!/^\d{1,12}$/.test(env.WRITER_PROJECT_ID)) fail(2, "WRITER_PROJECT_ID ist keine Projekt-ID");
if (env.WRITER_S3_ACCESS_KEY === env.TEST_S3_ACCESS_KEY) fail(2, "Writer- und Admin-Schlüssel sind gleich");
const RUN_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
if (!RUN_RE.test(env.RB_RUN)) fail(2, "RB_RUN hat nicht das Format JJJJMMTTThhmmssZ-xxxxxx");
const PREFIX = `rb-test/policy/${env.RB_RUN}/`;
// Bereich, in dem die Test-Policy dem Writer Objektzugriffe erlaubt. P10 prüft einen Upload daneben (noch im Laufpräfix).
const AREA = `${PREFIX}w/`;
const NOT_BEFORE = new Date(env.RB_FRUEHESTENS || "2026-10-13T12:30:00Z");
if (Number.isNaN(NOT_BEFORE.getTime())) fail(2, "RB_FRUEHESTENS ist kein Datum");

// Zeitlimits je Anfrage, damit ein hängender Server die Policy nicht unbegrenzt in Kraft lässt. Ohne throwOnRequestTimeout
// meldet der Handler (@smithy/node-http-handler 4.12) eine Überschreitung nur als Warnung.
const timeouts = { requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000, socketTimeout: 30_000, throwOnRequestTimeout: true } };
const client = (ak, sk, endpoint, region, extra = {}) => new S3Client({ endpoint, region: region || "hel1", forcePathStyle: true, credentials: { accessKeyId: ak, secretAccessKey: sk }, ...timeouts, ...extra });
const A = client(env.TEST_S3_ACCESS_KEY, env.TEST_S3_SECRET_KEY, env.TEST_S3_ENDPOINT, env.TEST_S3_REGION);
const Astrict = client(env.TEST_S3_ACCESS_KEY, env.TEST_S3_SECRET_KEY, env.TEST_S3_ENDPOINT, env.TEST_S3_REGION, { requestChecksumCalculation: "WHEN_REQUIRED" });
// Policy setzen und löschen nur mit genau einem Versuch: keine automatische Wiederholung nach einem Zustandswechsel.
const Aonce = client(env.TEST_S3_ACCESS_KEY, env.TEST_S3_SECRET_KEY, env.TEST_S3_ENDPOINT, env.TEST_S3_REGION, { maxAttempts: 1 });
const W = client(env.WRITER_S3_ACCESS_KEY, env.WRITER_S3_SECRET_KEY, env.WRITER_S3_ENDPOINT, env.WRITER_S3_REGION);
const Wstrict = client(env.WRITER_S3_ACCESS_KEY, env.WRITER_S3_SECRET_KEY, env.WRITER_S3_ENDPOINT, env.WRITER_S3_REGION, { requestChecksumCalculation: "WHEN_REQUIRED" });
const Wonce = client(env.WRITER_S3_ACCESS_KEY, env.WRITER_S3_SECRET_KEY, env.WRITER_S3_ENDPOINT, env.WRITER_S3_REGION, { maxAttempts: 1 });

const results = [];
const record = (id, ok, text) => { results.push({ id, ok }); console.log(`${ok === true ? "BESTANDEN " : ok === false ? "NICHT OK  " : "HINWEIS   "} ${id}: ${text}`); };
const err = (e) => `${e?.name ?? "Fehler"}${e?.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : ""}`;
const tryIt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: err(e) }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Für Lesen und Aufräumen: mehrere Versuche mit wachsender Pause; endgültige Antworten (verweigert, nicht vorhanden) sofort.
const retry = async (fn, attempts = 5) => { let r; for (let i = 0; i < attempts; i++) { r = await tryIt(fn); if (r.ok || /AccessDenied|NoSuch/.test(r.error)) return r; await sleep(2000 * (i + 1)); } return r; };
const isDenied = (r) => !r.ok && /AccessDenied|Forbidden|HTTP 403/.test(r.error);
const isNoPolicy = (r) => !r.ok && /NoSuchBucketPolicy/.test(r.error);
const md5 = (b) => createHash("md5").update(b).digest("base64");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const body = async (r) => Buffer.from(await r.Body.transformToByteArray());
// Beim Aufräumen ist jeder unerwartete Abbruch vorübergehend (Exit 4): das Rahmenskript versucht es dann erneut.
const abort = (e) => { console.log(`ABBRUCH: unerwarteter Fehler ${err(e)} (Details aus Sicherheitsgründen nicht ausgegeben)`); process.exit(mode === "finish" ? 4 : 1); };
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
const bucketArn = `arn:aws:s3:::${Bucket}`;
const SIDS = ["RbTestWriterBucket", "RbTestWriterObjekte", "RbTestWriterLoeschmarkerNurInFiles", "RbTestWriterDarfNie"];
const policyFor = (prefix) => ({
  Version: "2012-10-17",
  Statement: [
    { Sid: SIDS[0], Effect: "Allow", Principal: { AWS: [principal] }, Resource: [bucketArn],
      Action: ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketObjectLockConfiguration"] },
    { Sid: SIDS[1], Effect: "Allow", Principal: { AWS: [principal] }, Resource: [`${bucketArn}/${prefix}w/*`],
      Action: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"] },
    { Sid: SIDS[2], Effect: "Allow", Principal: { AWS: [principal] }, Resource: [`${bucketArn}/${prefix}w/files/*`],
      Action: ["s3:DeleteObject"] },
    { Sid: SIDS[3], Effect: "Deny", Principal: { AWS: [principal] }, Resource: [bucketArn, `${bucketArn}/*`],
      Action: ["s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy", "s3:PutLifecycleConfiguration", "s3:PutBucketVersioning", "s3:PutBucketObjectLockConfiguration"] },
  ],
});
const policyDoc = JSON.stringify(policyFor(PREFIX));
// Vergleichsform einer Policy: Listen sortiert, Aktionen klein, Principal als Liste. Jedes unbekannte Feld (Condition, NotAction,
// NotPrincipal, NotResource …) macht die Policy zu einer fremden.
const canon = (text) => {
  try {
    const p = typeof text === "string" ? JSON.parse(text) : text;
    if (Object.keys(p).some((k) => !["Version", "Statement", "Id"].includes(k))) return null;
    const list = (v) => [v].flat().filter((x) => x !== undefined).map(String).sort();
    const st = [p.Statement].flat().map((s) => {
      if (Object.keys(s).some((k) => !["Sid", "Effect", "Principal", "Action", "Resource"].includes(k))) return null;
      if (typeof s.Principal !== "object" || Object.keys(s.Principal).some((k) => k !== "AWS")) return null;
      return { Sid: s.Sid, Effect: s.Effect, Principal: list(s.Principal.AWS), Action: list(s.Action).map((a) => a.toLowerCase()), Resource: list(s.Resource) };
    });
    if (st.some((s) => s === null)) return null;
    return JSON.stringify({ Version: p.Version, Statement: st.sort((a, b) => String(a.Sid).localeCompare(String(b.Sid))) });
  } catch { return null; }
};
// Gehört eine gelesene Policy zu einem Lauf dieses Tests? Liefert dessen Lauf-Kennung, sonst null. Genau unsere vier Kennungen,
// nur der Writer-Testschlüssel als Principal, nur Ressourcen dieses Buckets, Kennung aus dem Lösch-Pfad – und danach muss die
// Policy exakt der Test-Policy dieses Laufs entsprechen.
const runOfTestPolicy = (text) => {
  const c = canon(text);
  if (!c) return null;
  const st = JSON.parse(c).Statement;
  if (st.length !== SIDS.length || !SIDS.every((sid) => st.filter((s) => s.Sid === sid).length === 1)) return null;
  if (!st.every((s) => s.Principal.length === 1 && s.Principal[0] === principal)) return null;
  if (!st.every((s) => s.Resource.every((r) => r === bucketArn || r.startsWith(`${bucketArn}/`)))) return null;
  const files = st.find((s) => s.Sid === SIDS[2]).Resource;
  const m = files.length === 1 && files[0].match(/^arn:aws:s3:::[^/]+\/rb-test\/policy\/([^/]+)\/w\/files\/\*$/);
  if (!m || !RUN_RE.test(m[1])) return null;
  return canon(policyFor(`rb-test/policy/${m[1]}/`)) === c ? m[1] : null;
};
// Enthält eine Policy die Laufkennung DIESES Laufs (mit Zufallsteil) und den Writer-Principal, kann sie nur aus diesem Lauf
// stammen – auch wenn sie umformatiert oder nachträglich verändert wurde. Vor dem Lauf kann es sie nicht gegeben haben.
const mine = (text) => { try { const s = JSON.stringify(JSON.parse(text)); return s.includes(`${bucketArn}/${PREFIX}`) && s.includes(principal); } catch { return false; } };
// Unsere Policy: exakt die dieses Laufs, oder eine Variante davon, die keinem anderen Lauf zugeordnet werden kann.
const isOurs = (text) => { const run = runOfTestPolicy(text); return run === env.RB_RUN || (run === null && mine(text)); };
const isExactlyOurs = (text) => runOfTestPolicy(text) === env.RB_RUN;

// Die einzige Lifecycle-Regel und Standard-Sperre, die der Test-Bucket haben darf (aus dem Bucket-Test, Tag 0). Verbotsversuche
// N8/N9 senden genau diesen Inhalt, und nur wenn der Bucket ihn tatsächlich hat; sonst entfallen sie.
const KNOWN_RULE = { ID: "rb-test-ablauf", Status: "Enabled", Filter: { Prefix: "rb-test/lc/" }, Expiration: { Days: 1 }, NoncurrentVersionExpiration: { NoncurrentDays: 1 } };
const KNOWN_LOCK = { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } };
// Exakter Strukturvergleich unabhängig von der Schlüsselreihenfolge; undefinierte Felder zählen nicht.
const deepSame = (a, b) => {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return a === b;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepSame(a[k], b[k]));
};
const normRule = (r) => { const { Prefix, ...rest } = r; return Prefix !== undefined && !rest.Filter ? { ...rest, Filter: { Prefix } } : rest; };
const hasKnownRule = (rules) => Array.isArray(rules) && rules.length === 1 && deepSame(normRule(rules[0]), KNOWN_RULE);
const hasKnownLock = (c) => c?.ObjectLockEnabled === "Enabled" && c?.Rule?.DefaultRetention?.Mode === "COMPLIANCE" && c?.Rule?.DefaultRetention?.Days === 1 && !c?.Rule?.DefaultRetention?.Years;

console.log(`Test-Bucket ${Bucket} · Endpunkt ${new URL(env.TEST_S3_ENDPOINT).host} · Writer-Projekt ${env.WRITER_PROJECT_ID} · Lauf ${env.RB_RUN} · Modus ${mode}`);

// Isolation des Admin-Schlüssels. Beim Aufräumen mehrere Versuche und nur eine Warnung: --finish entfernt ohnehin nur die
// eigene Policy dieses Laufs im genannten Test-Bucket.
const adminList = await (mode === "finish" ? retry(() => A.send(new ListBucketsCommand({})), 8) : tryIt(() => A.send(new ListBucketsCommand({}))));
if (!adminList.ok) {
  if (mode === "finish") { console.log(`ABBRUCH: Admin-Anmeldung nicht möglich (${adminList.error}) – Aufräumen NICHT durchgeführt, später erneut: run.sh --finish-only ${env.RB_RUN}`); process.exit(4); }
  fail(3, `Admin-Anmeldung abgelehnt (${adminList.error}). Nichts geändert.`);
}
const adminNames = (adminList.value.Buckets ?? []).map((b) => b.Name);
const adminOwner = adminList.value.Owner?.ID;
const isolated = adminNames.includes(Bucket) && adminNames.every((n) => n === Bucket);
if (!isolated && mode === "run") fail(3, `Admin-Schlüssel sieht nicht genau den Test-Bucket (${adminNames.join(", ") || "keinen"}). Nichts geändert.`);
record("V0 Isolation Admin", isolated ? true : null, isolated ? `Admin-Schlüssel sieht nur ${Bucket}` : `Admin-Schlüssel sieht ${adminNames.join(", ") || "keinen Bucket"} – Aufräumen betrifft trotzdem nur ${Bucket}`);

try {
  if (mode === "run") {
    setTimeout(() => abort(new Error("Watchdog: --run dauert länger als 20 Minuten")), 20 * 60_000).unref();
    await run();
  } else {
    setTimeout(() => abort(new Error("Watchdog: --finish dauert länger als 15 Minuten")), 15 * 60_000).unref();
    await finish();
  }
} catch (e) { abort(e); }
const failed = results.filter((r) => r.ok === false).length;
console.log(`\nErgebnis: ${results.filter((r) => r.ok === true).length} bestanden, ${failed} nicht ok, ${results.filter((r) => r.ok === null).length} Hinweise`);
if (mode === "run") process.exitCode = failed ? 1 : 0;

async function run() {
  // V: Vorbedingungen. Bis einschließlich V5 wird nichts geändert; jede Abweichung bricht mit Exit 3 ab.
  if (new Date() < NOT_BEFORE) fail(3, `zu früh: frühestens ${NOT_BEFORE.toISOString()} (nach der letzten Lifecycle-Prüfung). Nichts geändert.`);
  const wList = await tryIt(() => W.send(new ListBucketsCommand({})));
  if (!wList.ok) fail(3, `Writer-Anmeldung abgelehnt (${wList.error}). Nichts geändert.`);
  const wNames = (wList.value.Buckets ?? []).map((b) => b.Name);
  if (wNames.includes(Bucket) || wNames.some((n) => PRODUCTION_BUCKETS.includes(n))) fail(3, "der Writer-Schlüssel sieht den Test- oder einen Produktions-Bucket – er stammt nicht aus einem eigenen Projekt. Nichts geändert.");
  record("V1 Writer aus eigenem Projekt", true, `Writer sieht ${wNames.length} eigene Bucket(s), nicht den Test-Bucket`);
  const before = await tryIt(() => W.send(new ListObjectsV2Command({ Bucket, Prefix: PREFIX, MaxKeys: 1 })));
  if (!isDenied(before)) fail(3, before.ok ? "der Writer darf den Test-Bucket schon ohne Policy lesen – unerwartet. Nichts geändert." : `Zugriffsprobe des Writers nicht eindeutig (${before.error}). Nichts geändert.`);
  record("V2 Writer ohne Policy", true, "Zugriff auf den Test-Bucket abgewiesen");
  const existing = await tryIt(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  if (!isNoPolicy(existing)) fail(3, existing.ok ? "am Test-Bucket ist bereits eine Policy gesetzt – sie wird nicht angetastet. Nichts geändert." : `Policy-Zustand nicht eindeutig (${existing.error}) – ohne Nachweis „keine Policy“ wird nichts gesetzt. Nichts geändert.`);
  const snapLock = await tryIt(() => A.send(new GetObjectLockConfigurationCommand({ Bucket })));
  const snapLc = await tryIt(() => A.send(new GetBucketLifecycleConfigurationCommand({ Bucket })));
  const snapVer = await tryIt(() => A.send(new GetBucketVersioningCommand({ Bucket })));
  if (!snapLock.ok || !snapVer.ok || !snapLc.ok) fail(3, "Bucket-Einstellungen nicht vollständig lesbar. Nichts geändert.");
  if (!hasKnownLock(snapLock.value.ObjectLockConfiguration) || snapVer.value.Status !== "Enabled") fail(3, "Standard-Sperre oder Versionierung weichen vom bekannten Stand ab. Nichts geändert.");
  record("V3 Ausgangszustand", true, `keine Policy; Standard-Sperre COMPLIANCE 1 Tag; Versionierung an; Lifecycle ${hasKnownRule(snapLc.value.Rules) ? "wie am Tag 0" : "ABWEICHEND (N8 entfällt)"}`);
  const pre = await tryIt(() => A.send(new ListObjectVersionsCommand({ Bucket, Prefix: PREFIX })));
  if (!pre.ok || (pre.value.Versions ?? []).length || (pre.value.DeleteMarkers ?? []).length) fail(3, `Laufpräfix ${PREFIX} ist nicht leer oder nicht lesbar. Nichts geändert.`);
  record("V4 Laufpräfix", true, `${PREFIX} ist leer; alle Objektzugriffe bleiben darin`);
  const again = await tryIt(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  if (!isNoPolicy(again)) fail(3, `unmittelbar vor dem Setzen kein Nachweis „keine Policy“ (${again.ok ? "inzwischen gesetzt" : again.error}). Nichts geändert.`);
  record("V5 Erneut geprüft", true, "unmittelbar vor dem Setzen weiterhin keine Policy");

  // S: Policy setzen (Admin). Die Markierung steht vor dem Aufruf, damit das Rahmenskript nach jedem Abbruch aufräumt.
  console.log("S0 Policy wird jetzt gesetzt");
  const put = await tryIt(() => Aonce.send(new PutBucketPolicyCommand({ Bucket, Policy: policyDoc })));
  record("S1 Policy gesetzt", put.ok, put.ok ? "mit dem Admin-Schlüssel gesetzt (Inhalt nicht ausgegeben)" : `nicht bestätigt: ${put.error} – --finish prüft und räumt auf`);
  if (!put.ok) return;
  const back = await retry(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  if (back.ok && isExactlyOurs(back.value.Policy)) {
    const exact = canon(back.value.Policy) === canon(policyDoc);
    record("S2 Policy zurückgelesen", true, exact ? "genau die Test-Policy dieses Laufs" : "Test-Policy dieses Laufs, von Hetzner umformatiert");
  } else {
    // Nicht lesbar oder abweichend: ohne Writer-Tests aufhören. Entfernt wird nur, was nachweislich aus diesem Lauf stammt
    // (Laufkennung mit Zufallsteil); eine fremde Policy oder die eines anderen Laufs bleibt unverändert.
    const res = await removeOurPolicy();
    record("S2 Policy zurückgelesen", false, `${!back.ok ? `nicht lesbar (${back.error})` : isOurs(back.value.Policy) ? "Variante der Policy dieses Laufs" : "FREMDE oder andere Lauf-Policy"}; ${res.text}; Writer-Tests entfallen`);
    return;
  }
  let p1;
  for (let i = 0; i < 12; i++) { p1 = await tryIt(() => W.send(new ListObjectsV2Command({ Bucket, Prefix: PREFIX }))); if (p1.ok) break; await sleep(5000); }
  expectAllowed("P1 Auflisten (ListObjectsV2, wie Coolifys Verbindungstest)", "ListObjectsV2", p1);
  if (!p1.ok) { record("P1", false, "Policy wirkt nach 60 Sekunden nicht – weitere Writer-Tests übersprungen; --finish entfernt sie"); return; }

  // P: erlaubte Aktionen mit dem Writer-Schlüssel, alle im Laufpräfix
  expectAllowed("P2", "GetBucketLocation", await tryIt(() => W.send(new GetBucketLocationCommand({ Bucket }))));
  expectAllowed("P3", "GetObjectLockConfiguration (für mc)", await tryIt(() => W.send(new GetObjectLockConfigurationCommand({ Bucket }))));
  const small = Buffer.from(`RentBase Policy-Test ${env.RB_RUN}\n`);
  const p4 = await tryIt(() => W.send(new PutObjectCommand({ Bucket, Key: `${AREA}db/probe.txt`, Body: small })));
  expectAllowed("P4", "PutObject (SDK-Standard)", p4);
  const p5 = await tryIt(() => Wstrict.send(new PutObjectCommand({ Bucket, Key: `${AREA}files/probe.txt`, Body: small, ContentMD5: md5(small) })));
  expectAllowed("P5", "PutObject mit Content-MD5 unter files/", p5);
  const big = randomBytes(6 * 1024 * 1024);
  const parts = [big.subarray(0, 5 << 20), big.subarray(5 << 20)];
  const key = `${AREA}db/teile.bin`;
  let uploadId;
  const p6 = await tryIt(async () => {
    uploadId = (await Wstrict.send(new CreateMultipartUploadCommand({ Bucket, Key: key }))).UploadId;
    const done = [];
    for (let i = 0; i < parts.length; i++) done.push({ PartNumber: i + 1, ETag: (await Wstrict.send(new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: i + 1, Body: parts[i], ContentMD5: md5(parts[i]) }))).ETag });
    await Wstrict.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: done } }));
  });
  if (!p6.ok && uploadId) { const ab = await retry(() => A.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))); record("P6 Abbruch", ab.ok ? null : false, ab.ok ? "unvollständiger Teil-Upload vom Admin abgebrochen" : `Abbruch fehlgeschlagen (${ab.error}) – --finish versucht es erneut`); }
  expectAllowed("P6", "Teil-Upload 6 MB in 2 Teilen", p6);
  const g = p6.ok ? await tryIt(async () => sha(await body(await W.send(new GetObjectCommand({ Bucket, Key: key }))))) : { ok: false, error: "kein Upload" };
  record("P7 GetObject", g.ok && g.value === sha(big), g.ok ? (g.value === sha(big) ? "GetObject: erlaubt, SHA-256 identisch" : "GetObject: Prüfsumme weicht ab") : `GetObject: ${g.error}`);
  const v4 = p4.ok ? p4.value.VersionId : undefined;
  if (v4) {
    const p8 = await tryIt(async () => sha(await body(await W.send(new GetObjectCommand({ Bucket, Key: `${AREA}db/probe.txt`, VersionId: v4 })))));
    record("P8 GetObjectVersion", p8.ok && p8.value === sha(small), p8.ok ? "GetObject mit Versions-ID: erlaubt" : `GetObject mit Versions-ID: ${p8.error}`);
  } else record("P8 GetObjectVersion", null, "nicht prüfbar: P4 lieferte keine Versions-ID");
  const p9 = await tryIt(() => W.send(new DeleteObjectCommand({ Bucket, Key: `${AREA}files/probe.txt` })));
  const p9v = await tryIt(() => A.send(new ListObjectVersionsCommand({ Bucket, Prefix: `${AREA}files/probe.txt` })));
  const keptData = p9v.ok && (p9v.value.Versions ?? []).length >= 1 && (p9v.value.DeleteMarkers ?? []).length >= 1;
  record("P9 DeleteObject unter files/", p9.ok && keptData, p9.ok ? `erlaubt, ${keptData ? "nur Löschmarker, die Fassung bleibt" : "Fassung NICHT mehr vorhanden"}` : `abgewiesen (${p9.error}) – die Dateisicherung könnte legitime Löschungen nicht übernehmen`);
  expectDenied("P10", "PutObject außerhalb des erlaubten Bereichs (Laufpräfix, aber nicht w/)", await tryIt(() => W.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}aussen.txt`, Body: small }))), "ERLAUBT – die Einschränkung auf einen Pfad wirkt nicht (Datei liegt im Laufpräfix)");

  // N: verbotene Aktionen mit dem Writer-Schlüssel. Objektbezogene Versuche nur auf Objekte dieses Laufs; Bucket-Einstellungen
  // nur mit identischem, fest hinterlegtem Inhalt. Sperrfristen höchstens 26 Stunden.
  expectDenied("N1", "DeleteObject außerhalb von files/ (db/)", await tryIt(() => W.send(new DeleteObjectCommand({ Bucket, Key: `${AREA}db/probe.txt` }))), "ERLAUBT – die Präfix-Einschränkung wirkt nicht (nur Löschmarker, Daten bleiben)");

  // N2: endgültiges Löschen einer Fassung dieses Laufs, deren eigene Sperre (60 s) schon abgelaufen ist
  const unl = Buffer.from("Fassung mit 60 Sekunden Sperre\n");
  const unlUntil = new Date(Date.now() + 60_000);
  const u = await tryIt(() => Astrict.send(new PutObjectCommand({ Bucket, Key: `${AREA}files/ungesperrt/probe.txt`, Body: unl, ContentMD5: md5(unl), ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: unlUntil })));
  if (!u.ok) record("N2", null, `nicht prüfbar: Admin-Upload mit kurzer Sperre abgelehnt (${u.error})`);
  else {
    await sleep(unlUntil.getTime() - Date.now() + 10_000);
    const r = await tryIt(() => A.send(new GetObjectRetentionCommand({ Bucket, Key: `${AREA}files/ungesperrt/probe.txt`, VersionId: u.value.VersionId })));
    if (!(r.ok && new Date(r.value.Retention?.RetainUntilDate) < new Date())) record("N2", null, "nicht prüfbar: Sperre der Prüffassung noch aktiv oder nicht lesbar");
    else expectDenied("N2", "Fassung endgültig löschen (DeleteObjectVersion, Sperre abgelaufen)", await tryIt(() => W.send(new DeleteObjectCommand({ Bucket, Key: `${AREA}files/ungesperrt/probe.txt`, VersionId: u.value.VersionId }))), "ERLAUBT – der Writer kann Fassungen nach Sperrende endgültig löschen");
  }
  const until26 = new Date(Date.now() + 26 * 3600_000);
  if (v4) expectDenied("N3", "Sperre verlängern (PutObjectRetention, 26 h)", await tryIt(() => W.send(new PutObjectRetentionCommand({ Bucket, Key: `${AREA}db/probe.txt`, VersionId: v4, Retention: { Mode: "COMPLIANCE", RetainUntilDate: until26 } }))), "ERLAUBT – der Writer kann Sperren verlängern (Fassung jetzt 26 h gesperrt)");
  else record("N3", null, "nicht prüfbar: keine Versions-ID aus P4");
  const lockBody = Buffer.from("Upload mit eigener Sperre\n");
  expectDenied("N4", "Upload mit eigener Sperre (Object-Lock-Header, 26 h)", await tryIt(() => Wstrict.send(new PutObjectCommand({ Bucket, Key: `${AREA}db/eigene-sperre.txt`, Body: lockBody, ContentMD5: md5(lockBody), ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: until26 }))), "ERLAUBT – der Writer kann beim Hochladen eigene Sperren setzen (Objekt 26 h gesperrt)");
  if (v4) {
    // N5 nur, wenn der Admin Legal Holds auf Writer-Uploads ändern kann (unwirksames OFF vorab). Sonst könnte ein unerwartet
    // erlaubter Hold entstehen, den nur der Writer-Schlüssel wieder aufheben kann.
    const adminCan = await retry(() => A.send(new PutObjectLegalHoldCommand({ Bucket, Key: `${AREA}db/probe.txt`, VersionId: v4, LegalHold: { Status: "OFF" } })));
    if (!adminCan.ok) record("N5", null, `nicht prüfbar: der Admin kann Legal Holds auf Writer-Uploads nicht ändern (${adminCan.error}) – zur Sicherheit nicht versucht`);
    else {
      const lh = await tryIt(() => Wonce.send(new PutObjectLegalHoldCommand({ Bucket, Key: `${AREA}db/probe.txt`, VersionId: v4, LegalHold: { Status: "ON" } })));
      expectDenied("N5", "Legal Hold setzen", lh, "ERLAUBT – der Writer kann Legal Holds setzen");
      if (!isDenied(lh)) {
        const res = await releaseHold(`${AREA}db/probe.txt`, v4);
        record("N5 Rücknahme", res === "frei", res === "frei" ? "Legal Hold geprüft und nicht (mehr) gesetzt" : `Legal Hold ${res === "an" ? "WEITERHIN AN" : "Zustand unklar"} – --finish versucht es vor dem Entfernen der Policy erneut`);
      }
    }
  } else record("N5", null, "nicht prüfbar: keine Versions-ID aus P4");
  // N6/N7: nur wenn am Bucket nachweislich noch genau unsere Policy steht; je ein Versuch ohne automatische Wiederholung.
  const beforeN6 = await retry(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  if (!(beforeN6.ok && isExactlyOurs(beforeN6.value.Policy))) record("N6/N7", null, "entfallen: am Bucket steht nicht mehr genau die Test-Policy dieses Laufs");
  else {
    expectDenied("N6", "Bucket-Policy setzen (identischer Inhalt)", await tryIt(() => Wonce.send(new PutBucketPolicyCommand({ Bucket, Policy: policyDoc }))), "ERLAUBT – der Writer kann die Policy ändern (Inhalt blieb gleich)");
    const dp = await tryIt(() => Wonce.send(new DeleteBucketPolicyCommand({ Bucket })));
    expectDenied("N7", "Bucket-Policy löschen", dp, "ERLAUBT – der Writer kann die Policy löschen");
    if (!isDenied(dp)) {
      const now = await retry(() => A.send(new GetBucketPolicyCommand({ Bucket })));
      if (isNoPolicy(now)) {
        const re = await tryIt(() => Aonce.send(new PutBucketPolicyCommand({ Bucket, Policy: policyDoc })));
        record("N7 Wiederherstellung", re.ok, re.ok ? "Policy war weg; Test-Policy vom Admin neu gesetzt" : `nicht neu gesetzt (${re.error}) – der Writer hat damit keinen Zugriff mehr`);
      } else record("N7 Wiederherstellung", now.ok && isExactlyOurs(now.value.Policy) ? null : false, now.ok && isExactlyOurs(now.value.Policy) ? "Test-Policy steht weiterhin – nichts neu gesetzt" : `Zustand ${now.ok ? "verändert" : `unklar (${now.error})`} – nichts neu gesetzt`);
    }
  }
  // N8 nur mit exakt bekanntem Inhalt und nur, wenn die Lifecycle-Beobachtung unter rb-test/lc/ abgeschlossen ist (keine Fassung mehr).
  const lcOpen = await tryIt(() => A.send(new ListObjectVersionsCommand({ Bucket, Prefix: "rb-test/lc/" })));
  if (!lcOpen.ok || (lcOpen.value.Versions ?? []).length) record("N8", null, `entfällt: Lifecycle-Beobachtung unter rb-test/lc/ ${lcOpen.ok ? "noch offen" : `nicht prüfbar (${lcOpen.error})`}`);
  else if (hasKnownRule(snapLc.value.Rules)) expectDenied("N8", "Lifecycle setzen (identische, bekannte Regel)", await tryIt(() => Wstrict.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: [KNOWN_RULE] } }))), "ERLAUBT – der Writer kann Lifecycle-Regeln ändern (Inhalt blieb gleich)");
  else record("N8", null, "entfällt: Lifecycle weicht vom bekannten Stand ab, ein identisches Neusetzen ist nicht sicher");
  expectDenied("N9", "Standard-Sperre setzen (identisch, COMPLIANCE 1 Tag)", await tryIt(() => W.send(new PutObjectLockConfigurationCommand({ Bucket, ObjectLockConfiguration: KNOWN_LOCK }))), "ERLAUBT – der Writer kann die Standard-Sperre ändern (Inhalt blieb gleich)");
  expectDenied("N10", "Versionierung aussetzen (bei Object Lock ohnehin unmöglich)", await tryIt(() => W.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Suspended" } }))), "ERLAUBT – Versionierung ausgesetzt");
  expectDenied("N11", "Bucket-Policy lesen", await tryIt(() => W.send(new GetBucketPolicyCommand({ Bucket }))), "erlaubt (nicht gewährt, aber nur lesend)");
  if (v4) expectDenied("N12", "Sperrfrist lesen (GetObjectRetention)", await tryIt(() => W.send(new GetObjectRetentionCommand({ Bucket, Key: `${AREA}db/probe.txt`, VersionId: v4 }))), "erlaubt (nicht gewährt, aber nur lesend)");
  expectDenied("N13", "Fassungen auflisten (ListObjectVersions)", await tryIt(() => W.send(new ListObjectVersionsCommand({ Bucket, Prefix: PREFIX }))), "erlaubt (nicht gewährt, aber nur lesend)");

  // K: Kontrolle mit dem Admin-Schlüssel
  if (v4) {
    const k1 = await tryIt(() => A.send(new GetObjectRetentionCommand({ Bucket, Key: `${AREA}db/probe.txt`, VersionId: v4 })));
    record("K1 Standard-Sperre auf Writer-Uploads", k1.ok && k1.value.Retention?.Mode === "COMPLIANCE", k1.ok ? `${k1.value.Retention?.Mode} bis ${new Date(k1.value.Retention?.RetainUntilDate).toISOString()}` : `${k1.error} – der Admin kann die Sperre von Writer-Uploads nicht lesen (siehe K5/K6)`);
  }
  const lock = await tryIt(() => A.send(new GetObjectLockConfigurationCommand({ Bucket })));
  const lc = await tryIt(() => A.send(new GetBucketLifecycleConfigurationCommand({ Bucket })));
  const ver = await tryIt(() => A.send(new GetBucketVersioningCommand({ Bucket })));
  const same = lock.ok && JSON.stringify(lock.value.ObjectLockConfiguration) === JSON.stringify(snapLock.value.ObjectLockConfiguration)
    && ver.ok && ver.value.Status === snapVer.value.Status && lc.ok && JSON.stringify(lc.value.Rules) === JSON.stringify(snapLc.value.Rules);
  record("K2 Bucket-Einstellungen unverändert", same, same ? "Standard-Sperre, Versionierung und Lifecycle wie vor dem Test" : "ABWEICHUNG gegenüber dem Ausgangszustand");
  const pol = await retry(() => A.send(new GetBucketPolicyCommand({ Bucket })));
  record("K3 Policy unverändert", pol.ok && isExactlyOurs(pol.value.Policy), pol.ok ? (isExactlyOurs(pol.value.Policy) ? "Test-Policy dieses Laufs" : "weicht ab") : pol.error);
  if (v4) {
    const st = await holdState(`${AREA}db/probe.txt`, v4);
    record("K4 Kein Legal Hold", st === "frei", st === "frei" ? "auf der Writer-Fassung kein Legal Hold" : st === "an" ? "Legal Hold AN – --finish hebt ihn vor dem Entfernen der Policy auf" : "Zustand unklar – --finish prüft erneut");
    const k5 = await tryIt(async () => sha(await body(await A.send(new GetObjectCommand({ Bucket, Key: `${AREA}db/probe.txt`, VersionId: v4 })))));
    record("K5 Admin liest Writer-Upload", k5.ok && k5.value === sha(small), k5.ok ? "der Admin-Schlüssel kann Uploads des Writers lesen (Notfall-Wiederherstellung möglich)" : `${k5.error} – der Admin kann Uploads des Writers NICHT lesen; für die Produktion klären`);
    const acl = await tryIt(() => A.send(new GetObjectAclCommand({ Bucket, Key: `${AREA}db/probe.txt`, VersionId: v4 })));
    const owner = acl.ok ? acl.value.Owner?.ID : undefined;
    const ownedByBucket = acl.ok && owner && adminOwner && owner === adminOwner;
    record("K6 Besitzer von Writer-Uploads", null, ownedByBucket ? "gehören dem Bucket-Projekt"
      : `${acl.ok ? "gehören NICHT dem Bucket-Projekt" : `Besitz nicht nachweisbar (${acl.error}) – wie Writer-Besitz behandeln`}; den Writer-Testschlüssel erst löschen, wenn das Aufräumen der Testobjekte mit dem Admin-Schlüssel gelungen ist`);
  }
  console.log("\nDie Policy bleibt für den mc-Teil gesetzt; danach entfernt --finish sie.");
}

// Legal-Hold-Zustand einer Fassung: "frei", "an" oder "unklar". Erst Admin, ersatzweise Writer (nur solange die Policy gilt).
async function holdState(Key, VersionId) {
  for (const c of [A, W]) {
    const h = await retry(() => c.send(new GetObjectLegalHoldCommand({ Bucket, Key, VersionId })));
    if (h.ok) return h.value.LegalHold?.Status === "ON" ? "an" : "frei";
    if (/NoSuchObjectLockConfiguration|NoSuchLegalHold/.test(h.error)) return "frei";
  }
  return "unklar";
}
// Legal Hold aufheben: Admin, ersatzweise Writer; danach nachprüfen. Liefert den Zustand danach.
async function releaseHold(Key, VersionId) {
  for (const c of [A, W]) {
    await retry(() => c.send(new PutObjectLegalHoldCommand({ Bucket, Key, VersionId, LegalHold: { Status: "OFF" } })));
    const st = await holdState(Key, VersionId);
    if (st === "frei") return st;
  }
  return holdState(Key, VersionId);
}


// Entfernt die Policy nur, solange sie nachweislich aus diesem Lauf stammt; vor jedem Löschen neu gelesen, je ein Versuch.
// Liefert { state: "keine" | "weg" | "anderer" | "fremd" | "offen", text }.
async function removeOurPolicy() {
  let last = "", deleted = false;
  for (let i = 0; i < 5; i++) {
    const now = await retry(() => A.send(new GetBucketPolicyCommand({ Bucket })));
    if (isNoPolicy(now)) return deleted ? { state: "weg", text: "Test-Policy dieses Laufs entfernt, Bucket wieder ohne Policy" } : { state: "keine", text: "keine Policy gesetzt – nichts zu entfernen" };
    if (!now.ok) { last = now.error; await sleep(3000 * (i + 1)); continue; }
    if (!isOurs(now.value.Policy)) {
      const other = runOfTestPolicy(now.value.Policy);
      return other ? { state: "anderer", text: `Test-Policy eines ANDEREN Laufs (${other}) – nicht verändert; dafür run.sh --finish-only ${other}` }
        : { state: "fremd", text: "am Bucket steht eine FREMDE Policy – sie wurde nicht verändert" };
    }
    const del = await tryIt(() => Aonce.send(new DeleteBucketPolicyCommand({ Bucket })));
    if (del.ok) deleted = true; else { last = del.error; await sleep(3000 * (i + 1)); }
  }
  return { state: "offen", text: `Test-Policy WEITERHIN gesetzt oder Zustand unklar (${last || "unbestätigt"})` };
}

// Aufräumen in dieser Reihenfolge: Legal Holds (solange die Policy dem Writer noch Zugriff gibt), Teil-Uploads, dann die Policy.
// Nur die Policy DIESES Laufs wird entfernt. Exit 0 aufgeräumt, 1 bleibender Befund, 4 vorübergehend – erneut versuchen.
async function finish() {
  let transient = false, lasting = false;
  const inv = await retry(() => A.send(new ListObjectVersionsCommand({ Bucket, Prefix: PREFIX })));
  let on = 0, unknown = 0;
  if (inv.ok) {
    const deadline = Date.now() + 5 * 60_000; // Holds höchstens 5 Minuten lang prüfen, dann weiter zur Policy
    for (const v of inv.value.Versions ?? []) {
      if (Date.now() > deadline) { unknown++; continue; }
      let st = await holdState(v.Key, v.VersionId);
      if (st !== "frei") st = await releaseHold(v.Key, v.VersionId);
      if (st === "an") on++; else if (st === "unklar") unknown++;
    }
    if (inv.value.IsTruncated) unknown++;
  }
  if (!inv.ok) transient = true;
  if (on) lasting = true;
  if (unknown) transient = true;
  record("F1 Legal Holds im Laufpräfix", inv.ok && !on && !unknown, !inv.ok ? `Bestand nicht lesbar (${inv.error})`
    : on || unknown ? `${on} weiterhin AN, ${unknown} unklar – Writer-Testschlüssel NICHT löschen; Rückweg in der Anleitung`
    : `${(inv.value.Versions ?? []).length} Fassung(en) geprüft, kein Legal Hold`);

  const mpu = await retry(() => A.send(new ListMultipartUploadsCommand({ Bucket, Prefix: PREFIX })));
  let aborted = 0, abortFail = 0;
  for (const m of mpu.ok ? mpu.value.Uploads ?? [] : []) {
    const a = await retry(() => A.send(new AbortMultipartUploadCommand({ Bucket, Key: m.Key, UploadId: m.UploadId })));
    if (a.ok) aborted++; else abortFail++;
  }
  if (!mpu.ok || abortFail) transient = true;
  record("F2 Unvollständige Teil-Uploads", mpu.ok && abortFail === 0, mpu.ok ? `${aborted + abortFail} gefunden, ${aborted} abgebrochen` : `nicht lesbar (${mpu.error})`);

  const res = await removeOurPolicy();
  if (res.state === "offen") transient = true;
  if (res.state === "anderer" || res.state === "fremd") lasting = true;
  record("F3 Policy", res.state === "keine" || res.state === "weg", res.text);

  let w;
  for (let i = 0; i < 12; i++) { w = await tryIt(() => W.send(new ListObjectsV2Command({ Bucket, Prefix: PREFIX, MaxKeys: 1 }))); if (!w.ok) break; await sleep(5000); }
  if (!isDenied(w) && !lasting) transient = true;
  record("F4 Writer ohne Zugriff", isDenied(w), isDenied(w) ? "Zugriff auf den Test-Bucket abgewiesen" : w.ok ? "Writer hat WEITERHIN Zugriff" : `nicht eindeutig (${w.error})`);
  record("F5 Bestand im Laufpräfix", null, inv.ok
    ? `${(inv.value.Versions ?? []).length} Fassung(en), ${(inv.value.DeleteMarkers ?? []).length} Löschmarker; ${on || unknown ? "Legal Hold offen – siehe F1" : "gesperrt höchstens bis Standard-Sperre bzw. 26 h"}. Aufräumen später mit --cleanup des Bucket-Tests; den Writer-Testschlüssel erst danach löschen`
    : inv.error);
  process.exitCode = lasting ? 1 : transient ? 4 : results.some((r) => r.ok === false) ? 1 : 0;
}

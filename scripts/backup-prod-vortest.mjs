// Vortest der Produktions-Backup-Skripte gegen den Test-Bucket rent-base-backup-test (docs/backup-prod-vortest.md).
// Läuft nur über scripts/backup-prod-vortest.sh in einem Wegwerf-Container; der Test-Admin-Schlüssel kommt über die
// Standardeingabe. Prüft die auf dem Server abgelegten Produktionsskripte (scripts/backup-prod-lib.mjs) unverändert.
//
// Ablauf in einem Prozess; jede Abweichung in Schritt 1 bricht ab, bevor etwas geschrieben wird:
//   1 Vorprüfung (nur lesend): nur der Test-Bucket sichtbar, Versionierung an, Standard-Sperre COMPLIANCE 1 Tag, nur die bekannte
//     Lifecycle-Regel, keine Policy, Laufpräfix leer. Abbild aller vorhandenen Fassungen, Löschmarker und Bucket-Einstellungen.
//   2 Trockenlauf: Einrichtung in den Modi sperre, lifecycle, wiederherstellen. Jede ändernde Anfrage wird protokolliert und
//     blockiert, nie gesendet.
//   3 Testobjekte: künstliche Zufallsdaten nur unter dem neuen Laufpräfix: PutObject mit Content-MD5, DeleteObject ohne
//     Versions-ID (setzt nur einen Löschmarker). Keine Sperr-Header; die Standard-Sperre (1 Tag) gilt. Geschrieben wird mit einem
//     Client ohne Wiederholungen, damit jede Anfrage höchstens einmal ankommt.
//   4 Prüfläufe: Einrichtung --pruefen und Prüflauf --voll gegen das Laufpräfix. Die Schlüssel werden auf das Präfix abgebildet,
//     Auflistungen in Seiten zu 2 Einträgen erzwungen. Nur für die Dauer des vollen Prüflaufs existiert ein eigener, leerer
//     Teil-Upload; er wird danach in jedem Fall abgebrochen, auch bei Zeitüberschreitung oder SIGTERM. Danach ein zweiter
//     Trockenlauf.
//   5 Abschluss: Abbild und Einstellungen erneut lesen und vergleichen.
// Exit 0: alles wie erwartet; 1: Abweichungen bei den Erwartungen (Ablauf vollständig); 3: Vorprüfung nicht bestanden, nichts
// geschrieben; 4: Abschlusskontrolle mit Abweichung außerhalb des Laufpräfixes oder an den Einstellungen.

import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import s3sdk from "@aws-sdk/client-s3";

const lib = await import(process.env.RB_PROD_LIB ? pathToFileURL(process.env.RB_PROD_LIB).href : "./backup-prod-lib.mjs");
const { runCheck, runSetup, readTarget, s3Client, guardProcess, sameRules, errorName, tryIt, listAllVersions, listAllUploads } = lib;
const {
  ListBucketsCommand, GetBucketVersioningCommand, GetObjectLockConfigurationCommand, GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand, GetBucketAclCommand, PutObjectCommand, DeleteObjectCommand, CreateMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = s3sdk;

export const TEST_BUCKET = "rent-base-backup-test";
const KNOWN_RULE = { ID: "rb-test-ablauf", Status: "Enabled", Filter: { Prefix: "rb-test/lc/" }, Expiration: { Days: 1 }, NoncurrentVersionExpiration: { NoncurrentDays: 1 } };
const DUMP = "data/coolify/backups/rb-vortest/";
const READ = new Set([
  "ListBucketsCommand", "GetBucketVersioningCommand", "GetObjectLockConfigurationCommand", "GetBucketLifecycleConfigurationCommand",
  "GetBucketPolicyCommand", "GetBucketAclCommand", "GetObjectAclCommand", "ListObjectsV2Command", "ListObjectVersionsCommand",
  "ListMultipartUploadsCommand", "GetObjectRetentionCommand", "HeadObjectCommand",
]);
const LOCK_FIELDS = ["ObjectLockMode", "ObjectLockRetainUntilDate", "ObjectLockLegalHoldStatus", "BypassGovernanceRetention"];

function blocked(text) {
  return Object.assign(new Error(text), { name: "VortestBlockiert" });
}

/** Kurzbeschreibung einer ändernden Anfrage für das Protokoll (enthält keine Geheimnisse). */
function describe(name, input) {
  if (name === "PutObjectLockConfigurationCommand") return `Standard-Sperre ${JSON.stringify(input.ObjectLockConfiguration?.Rule ?? null)}`;
  if (name === "PutBucketLifecycleConfigurationCommand") return `Lifecycle mit ${input.LifecycleConfiguration?.Rules?.length ?? 0} Regeln: ${(input.LifecycleConfiguration?.Rules ?? []).map((r) => `${r.ID} (${r.Filter?.Prefix ?? ""})`).join(", ")}`;
  if (name === "PutBucketAclCommand") return `Bucket-ACL ${input.ACL ?? "?"}`;
  if (name === "DeleteBucketPolicyCommand") return "Bucket-Policy entfernen";
  return input.Key ? `Schlüssel ${input.Key}` : "";
}

/**
 * Sicherung um einen S3-Client. Jede Anfrage muss den Test-Bucket betreffen (außer ListBuckets).
 * mode "nur-lesen": ändernde Anfragen werden protokolliert und blockiert (Trockenlauf für die Produktionsskripte).
 * mode "anlegen": zusätzlich erlaubt sind nur PutObject mit Content-MD5 und ohne Sperr-Header, DeleteObject ohne Versions-ID,
 * Beginn und Abbruch eines eigenen Teil-Uploads, jeweils nur unter dem Laufpräfix.
 */
export function guard(client, { run, mode, out, attempts = [], ownUploads = new Set() }) {
  return {
    attempts,
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input ?? {};
      if (name !== "ListBucketsCommand" && input.Bucket !== TEST_BUCKET) throw blocked(`${name} auf anderem Bucket als ${TEST_BUCKET}`);
      if (READ.has(name)) return client.send(cmd);
      if (mode !== "anlegen") {
        attempts.push(name);
        out(`  TROCKENLAUF würde senden: ${name} – ${describe(name, input)} (blockiert, nicht gesendet)`);
        throw blocked("Trockenlauf");
      }
      const inRun = typeof input.Key === "string" && input.Key.startsWith(run) && input.Key.length > run.length;
      if (!inRun) throw blocked(`${name} außerhalb des Laufpräfixes`);
      if (LOCK_FIELDS.some((f) => input[f] != null)) throw blocked(`${name} mit Sperr-Angaben`);
      if (name === "PutObjectCommand" && input.ContentMD5) return client.send(cmd);
      if (name === "DeleteObjectCommand" && input.VersionId == null) return client.send(cmd);
      if (name === "CreateMultipartUploadCommand") {
        const res = await client.send(cmd);
        ownUploads.add(res.UploadId);
        return res;
      }
      if (name === "AbortMultipartUploadCommand" && ownUploads.has(input.UploadId)) return client.send(cmd);
      throw blocked(`${name} ist im Vortest nicht erlaubt`);
    },
  };
}

/**
 * Bildet einen Client auf das Laufpräfix ab: Schlüssel und Präfixe in Anfragen bekommen das Laufpräfix vorangestellt, in Antworten
 * wird es entfernt. Auflistungen werden in Seiten zu 2 Einträgen abgerufen, damit die Fortsetzung mit echten Marken geprüft wird.
 * Ein Schlüssel außerhalb des Laufpräfixes in einer Antwort bricht ab.
 */
export function scoped(client, run) {
  const strip = (key) => {
    if (typeof key !== "string" || !key.startsWith(run)) throw blocked("Antwort enthält einen Schlüssel außerhalb des Laufpräfixes");
    return key.slice(run.length);
  };
  const listing = new Set(["ListObjectVersionsCommand", "ListObjectsV2Command", "ListMultipartUploadsCommand"]);
  return {
    async send(cmd) {
      const Ctor = cmd.constructor;
      const input = { ...(cmd.input ?? {}) };
      if (listing.has(Ctor.name)) input.Prefix = run + (input.Prefix ?? "");
      if (Ctor.name === "ListObjectVersionsCommand" || Ctor.name === "ListObjectsV2Command") input.MaxKeys = 2;
      if (input.Key != null) input.Key = run + input.Key;
      if (input.KeyMarker != null) input.KeyMarker = run + input.KeyMarker;
      const res = await client.send(new Ctor(input));
      const copy = { ...res };
      for (const field of ["Versions", "DeleteMarkers", "Contents", "Uploads"]) {
        if (Array.isArray(res[field])) copy[field] = res[field].map((e) => ({ ...e, Key: strip(e.Key) }));
      }
      if (res.NextKeyMarker) copy.NextKeyMarker = strip(res.NextKeyMarker);
      return copy;
    },
  };
}

const md5 = (b) => createHash("md5").update(b).digest("base64");
const entryId = (e, marker) => `${e.Key}|${e.VersionId}|${e.IsLatest === true}|${marker}|${e.Size ?? "-"}|${e.ETag ?? "-"}`;

/** Bucket-Einstellungen und alle Fassungen außerhalb des Laufpräfixes, für den Vergleich vorher/nachher. */
async function snapshot(client, run) {
  const ver = await client.send(new GetBucketVersioningCommand({ Bucket: TEST_BUCKET }));
  const lock = await client.send(new GetObjectLockConfigurationCommand({ Bucket: TEST_BUCKET }));
  const lc = await tryIt(() => client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: TEST_BUCKET })));
  const pol = await tryIt(() => client.send(new GetBucketPolicyCommand({ Bucket: TEST_BUCKET })));
  const acl = await tryIt(() => client.send(new GetBucketAclCommand({ Bucket: TEST_BUCKET })));
  const all = await listAllVersions(client, TEST_BUCKET, undefined);
  const uploads = await listAllUploads(client, TEST_BUCKET);
  const outside = [
    ...all.versions.filter((v) => !v.Key.startsWith(run)).map((v) => entryId(v, false)),
    ...all.deleteMarkers.filter((v) => !v.Key.startsWith(run)).map((v) => entryId(v, true)),
  ].sort();
  const inside = {
    versions: all.versions.filter((v) => v.Key.startsWith(run)),
    markers: all.deleteMarkers.filter((v) => v.Key.startsWith(run)),
    uploads: uploads.filter((u) => u.Key.startsWith(run)),
  };
  return {
    versioning: ver.Status,
    lock: JSON.stringify(lock.ObjectLockConfiguration ?? null),
    lifecycle: lc.ok ? lc.value.Rules : lc.error,
    policy: pol.ok ? "VORHANDEN" : pol.name,
    acl: acl.ok ? JSON.stringify(acl.value.Grants ?? []) : `nicht lesbar (${acl.error})`,
    outside,
    outsideUploads: uploads.filter((u) => !u.Key.startsWith(run)).length,
    inside,
  };
}

/** Ein Prüfschritt mit erwarteten Zeilen; liefert die Abweichungen. */
function expectLines(lines, { mustMatch = [], mustNotMatch = [] }) {
  const text = lines.join("\n");
  const problems = [];
  for (const re of mustMatch) if (!re.test(text)) problems.push(`erwartet, aber nicht gefunden: ${re}`);
  for (const re of mustNotMatch) if (re.test(text)) problems.push(`unerwartet gefunden: ${re}`);
  return problems;
}

/** Abbruch der eigenen Teil-Uploads, solange welche offen sind; für Zeitüberschreitung und SIGTERM im Hauptprogramm. */
export const pending = { cleanup: null };

export async function runVortest({ client, strictClient, writerClient = strictClient, run, out = console.log, pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deviations = [];
  const step = (title) => out(`\n== ${title}`);
  const note = (ok, text) => {
    out(`${ok ? "BESTANDEN " : "ABWEICHUNG"} ${text}`);
    if (!ok) deviations.push(text);
  };
  const readOnly = guard(client, { run, mode: "nur-lesen", out });

  // 1 Vorprüfung
  step("1 Vorprüfung (nur lesend)");
  if (!/^rb-test\/prodskript\/\d{8}T\d{6}Z-[0-9a-f]{6}\/$/.test(run)) {
    out("ABBRUCH: Laufpräfix hat nicht das erwartete Format");
    return 3;
  }
  const lb = await tryIt(() => readOnly.send(new ListBucketsCommand({})));
  const names = lb.ok ? (lb.value.Buckets ?? []).map((b) => b.Name) : [];
  if (!lb.ok || names.length !== 1 || names[0] !== TEST_BUCKET) {
    out(`ABBRUCH: Schlüssel sieht nicht genau den Test-Bucket (${lb.ok ? `${names.length} Buckets` : lb.error}). Nichts geschrieben.`);
    return 3;
  }
  const before = await tryIt(() => snapshot(readOnly, run));
  if (!before.ok) {
    out(`ABBRUCH: Zustand nicht lesbar (${before.error}). Nichts geschrieben.`);
    return 3;
  }
  const b = before.value;
  const lockOk = b.lock === JSON.stringify({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } });
  const checks = [
    [b.versioning === "Enabled", `Versionierung: ${b.versioning ?? "aus"}`],
    [lockOk, `Standard-Sperre: ${b.lock}`],
    [Array.isArray(b.lifecycle) && sameRules(b.lifecycle, [KNOWN_RULE]), `Lifecycle: ${Array.isArray(b.lifecycle) ? b.lifecycle.map((r) => r.ID).join(", ") : b.lifecycle}`],
    [b.policy === "NoSuchBucketPolicy", `Bucket-Policy: ${b.policy === "NoSuchBucketPolicy" ? "keine" : b.policy}`],
    [b.inside.versions.length + b.inside.markers.length + b.inside.uploads.length === 0, `Laufpräfix ${run} leer`],
  ];
  for (const [ok, text] of checks) out(`${ok ? "BESTANDEN " : "ABBRUCH   "} ${text}`);
  out(`INFO       Bestand außerhalb des Laufpräfixes: ${b.outside.length} Fassungen/Löschmarker, ${b.outsideUploads} offene Teil-Uploads; Bucket-ACL: ${b.acl.startsWith("nicht") ? b.acl : `${JSON.parse(b.acl).length} Einträge`}`);
  if (checks.some(([ok]) => !ok)) {
    out("ABBRUCH: Ausgangszustand weicht ab. Nichts geschrieben.");
    return 3;
  }

  // 2 Trockenlauf vor dem Anlegen
  step("2 Trockenlauf der Einrichtung (ändernde Anfragen werden blockiert)");
  const dryRun = async (label, mode, dumpPrefix, expectedAttempts) => {
    const attempts = [];
    const c = guard(scoped(client, run), { run, mode: "nur-lesen", out, attempts });
    const sc = guard(scoped(strictClient, run), { run, mode: "nur-lesen", out, attempts });
    const lines = [];
    const code = await runSetup({ client: c, strictClient: sc, bucket: TEST_BUCKET, mode, dumpPrefix, out: (l) => { lines.push(l); out(`  | ${l}`); }, pause: () => pause(0) });
    note(JSON.stringify(attempts) === JSON.stringify(expectedAttempts), `${label}: Exit ${code}, versuchte Änderungen: ${attempts.join(", ") || "keine"} (erwartet: ${expectedAttempts.join(", ") || "keine"})`);
    return { code, lines };
  };
  await dryRun("--sperre", "sperre", undefined, []);
  await dryRun("--lifecycle", "lifecycle", DUMP, []);
  await dryRun("--wiederherstellen (noch ohne Dumps)", "wiederherstellen", DUMP, ["PutObjectLockConfigurationCommand"]);

  // 3 Testobjekte
  step(`3 Testobjekte unter ${run} (künstliche Zufallsdaten)`);
  const ownUploads = new Set();
  const writer = guard(writerClient, { run, mode: "anlegen", out, ownUploads });
  const put = async (rel, bytes) => {
    const body = randomBytes(bytes);
    const res = await writer.send(new PutObjectCommand({ Bucket: TEST_BUCKET, Key: run + rel, Body: body, ContentMD5: md5(body) }));
    out(`  angelegt ${rel} (${bytes} Bytes, Fassung ${res.VersionId ? "mit" : "OHNE"} Versions-ID)`);
    await pause(1500);
  };
  const mark = async (rel) => {
    const res = await writer.send(new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key: run + rel }));
    out(`  Löschmarker ${rel} (${res.DeleteMarker ? "Marker bestätigt" : "ohne Marker-Bestätigung"})`);
    await pause(1500);
  };
  try {
    await put(`${DUMP}pg-dump-vortest-1.dmp`, 150_000);
    await put(`${DUMP}pg-dump-vortest-2.dmp`, 150_000);
    await put(`${DUMP}pg-dump-vortest-3.dmp`, 150_000);
    await put(`${DUMP}pg-dump-vortest-2.dmp`, 150_000); // überschreibt die eigene Testdatei: zweite Fassung
    await mark(`${DUMP}pg-dump-vortest-3.dmp`);
    await put("files/t/vortest/contracts/2026/10/vertrag.pdf", 1024);
    await mark("files/t/vortest/contracts/2026/10/vertrag.pdf");
    await put("files/t/vortest/photos/2026/10/foto.jpg", 1024);
    await mark("files/t/vortest/photos/2026/10/foto.jpg");
    await put("files/t/vortest/documents/2026/10/dokument.pdf", 1024);
    await put("files-state/missing.json", 2);
    note(true, "Testobjekte angelegt: 8 Fassungen, 3 Löschmarker");
  } catch (e) {
    note(false, `Anlegen der Testobjekte abgebrochen: ${errorName(e)}`);
  }

  // 4 Prüfläufe
  step("4a Einrichtung --pruefen gegen das Laufpräfix");
  {
    const lines = [];
    const c = guard(scoped(client, run), { run, mode: "nur-lesen", out });
    const code = await runSetup({ client: c, strictClient: c, bucket: TEST_BUCKET, mode: "pruefen", out: (l) => { lines.push(l); out(`  | ${l}`); } });
    const p = expectLines(lines, {
      mustMatch: [/OK +Projekt: sieht nur rent-base-backup-test/, /OK +Bucket-Policy: keine/, /OK +Versionierung: an/,
        /FEHLER +Standard-Sperre: COMPLIANCE, 1 Tage/, /Lifecycle: rb-test-ablauf \(rb-test\/lc\/\)/,
        /Bestand: 8 Fassungen, 3 Löschmarker/, /Dump: data\/coolify\/backups\/rb-vortest\/pg-dump-vortest-2\.dmp/,
        /FEHLER +Sperre neuester Dump: nur 1\.0 Tage gesperrt/, /Vorschlag Dump-Präfix: data\/coolify\/backups\/rb-vortest\//],
      mustNotMatch: [/nicht lesbar \(/, /nicht auflistbar/, /VortestBlockiert/],
    });
    note(code === 1 && !p.length, `--pruefen: Exit ${code} (erwartet 1 wegen der 1-Tages-Sperre des Test-Buckets)${p.length ? `; ${p.join("; ")}` : ""}`);
  }

  step("4b Prüflauf --voll gegen das Laufpräfix (mit einem eigenen, leeren Teil-Upload für die Dauer des Laufs)");
  {
    const lines = [];
    const c = guard(scoped(client, run), { run, mode: "nur-lesen", out });
    const abortOwn = async () => {
      for (const id of ownUploads) {
        const ab = await tryIt(() => writer.send(new AbortMultipartUploadCommand({ Bucket: TEST_BUCKET, Key: `${run}${DUMP}teil-upload.dmp`, UploadId: id })));
        note(ab.ok, `eigener Teil-Upload ${ab.ok ? "abgebrochen" : `NICHT abgebrochen (${ab.error})`}`);
        if (ab.ok) ownUploads.delete(id);
      }
    };
    pending.cleanup = abortOwn;
    let counts = { ok: 0, fehler: -1, hinweis: 0 };
    try {
      const mpu = await tryIt(() => writer.send(new CreateMultipartUploadCommand({ Bucket: TEST_BUCKET, Key: `${run}${DUMP}teil-upload.dmp` })));
      // Auch bei einem Fehler könnte Hetzner den Upload angelegt haben: alle Uploads im (vorher leeren) Laufpräfix gehören diesem Lauf.
      const open = await tryIt(() => listAllUploads(readOnly, TEST_BUCKET));
      for (const u of open.ok ? open.value : []) if (u.Key.startsWith(run) && u.UploadId) ownUploads.add(u.UploadId);
      out(`  Teil-Upload ${mpu.ok ? "begonnen" : `nicht begonnen (${mpu.error})`}; offen im Laufpräfix: ${ownUploads.size}`);
      counts = await runCheck({ client: c, bucket: TEST_BUCKET, dumpPrefix: DUMP, full: true, out: (l) => { lines.push(l); out(`  | ${l}`); } });
    } finally {
      await abortOwn();
      pending.cleanup = null;
    }
    const fehler = lines.filter((l) => l.startsWith("FEHLER")).map((l) => l.slice(8, l.indexOf(":")));
    const expectedFehler = ["Standard-Sperre", "Lifecycle", "Dumps überschrieben", "Dumps gelöscht", "Dateien gelöscht", "Sperre neuer Fassungen", "Sperre aller Fassungen"];
    note(JSON.stringify([...fehler].sort()) === JSON.stringify([...expectedFehler].sort()), `Fehlerzeilen: ${fehler.join(", ") || "keine"} (erwartet genau: ${expectedFehler.join(", ")})`);
    const p = expectLines(lines, {
      mustMatch: [/OK +Versionierung: an/, /OK +Buckets im Projekt: nur rent-base-backup-test/, /OK +Bucket-Policy: keine/,
        /OK +Dumps: neuester -?[0-9.]+ h alt, 0\.1 MB; 2 in 24 h, 2 insgesamt/,
        /FEHLER +Dumps überschrieben: 1 .*pg-dump-vortest-2\.dmp/, /FEHLER +Dumps gelöscht: 1 .*pg-dump-vortest-3\.dmp/,
        /FEHLER +Dateien gelöscht: 1 .*contracts\/2026\/10\/vertrag\.pdf/,
        /FEHLER +Sperre neuer Fassungen: 4 von 4 Fassungen .*nur 1\.0 Tage gesperrt/, /OK +Dateisicherung: letzter erfolgreicher Lauf vor -?0\.\d h/,
        /OK +Lifecycle Dumps: 4 Fassungen, 1 Löschmarker, nichts überfällig/, /OK +Lifecycle Dateien: 3 Fassungen, 2 Löschmarker, nichts überfällig/,
        /OK +Gesamtgröße/, /FEHLER +Sperre aller Fassungen: 4 von 4/, /OK +Teil-Uploads: 1 offen, keiner älter als 1 Tag/],
      mustNotMatch: [/nicht auflistbar/, /VortestBlockiert/, /Objekte außerhalb der Regeln/, /Dateien überschrieben/],
    });
    note(!p.length, `Prüflauf-Zeilen wie erwartet${p.length ? `: ${p.join("; ")}` : ""}`);
    const acl = lines.filter((l) => /ACL/.test(l));
    out(`INFO       ACL-Ergebnisse bei Hetzner: ${acl.map((l) => l.trim()).join(" | ")}`);
    note(counts.fehler === expectedFehler.length, `Zähler: ${counts.ok} ok, ${counts.fehler} Fehler, ${counts.hinweis} Hinweise`);
  }

  step("4c Trockenlauf mit Dumps (ändernde Anfragen werden blockiert)");
  await dryRun("--lifecycle", "lifecycle", DUMP, []);
  await dryRun("--wiederherstellen", "wiederherstellen", DUMP, ["PutObjectLockConfigurationCommand", "PutBucketLifecycleConfigurationCommand"]);

  // 5 Abschluss
  step("5 Abschluss");
  const after = await tryIt(() => snapshot(readOnly, run));
  if (!after.ok) {
    out(`ABWEICHUNG Abschlusskontrolle nicht lesbar (${after.error})`);
    return 4;
  }
  const a = after.value;
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const gone = b.outside.filter((x) => !a.outside.includes(x));
  const added = a.outside.filter((x) => !b.outside.includes(x));
  // Die Lifecycle-Regel des Test-Buckets darf unter rb-test/lc/ während des Laufs Fassungen entfernen oder Löschmarker setzen.
  const lifecycleOnly = [...gone, ...added].every((x) => x.startsWith(KNOWN_RULE.Filter.Prefix) && (gone.includes(x) || x.split("|")[3] === "true"));
  const outsideChanged = (gone.length || added.length) && !lifecycleOnly;
  const settingsChanged = !(a.versioning === b.versioning && a.lock === b.lock && same(a.lifecycle, b.lifecycle) && a.policy === b.policy && a.acl === b.acl);
  out(`${outsideChanged ? "ABWEICHUNG" : "BESTANDEN "} Bestand außerhalb des Laufpräfixes ${outsideChanged ? `verändert: vorher ${b.outside.length}, nachher ${a.outside.length} Einträge` : `unverändert bis auf die Lifecycle-Regel (${a.outside.length} Einträge)`}`);
  if (gone.length || added.length) out(`${outsideChanged ? "           " : "HINWEIS    "}entfallen: ${gone.map((x) => x.split("|")[0]).join(", ") || "–"}; neu: ${added.map((x) => `${x.split("|")[0]}${x.split("|")[3] === "true" ? " (Löschmarker)" : ""}`).join(", ") || "–"}${outsideChanged ? "" : " – Lifecycle-Aktivität unter rb-test/lc/"}`);
  out(`${settingsChanged ? "ABWEICHUNG" : "BESTANDEN "} Bucket-Einstellungen ${settingsChanged ? "verändert" : "unverändert (Versionierung, Standard-Sperre, Lifecycle, Policy, ACL)"}`);
  if (a.outsideUploads !== b.outsideUploads) out(`HINWEIS    offene Teil-Uploads außerhalb des Laufpräfixes: vorher ${b.outsideUploads}, nachher ${a.outsideUploads}`);
  const until = a.inside.versions.map((v) => new Date(v.LastModified).getTime() + 86_400_000).reduce((x, y) => Math.max(x, y), 0);
  out(`INFO       zurückgeblieben im Laufpräfix: ${a.inside.versions.length} Fassungen, ${a.inside.markers.length} Löschmarker, ${a.inside.uploads.length} offene Teil-Uploads; gesperrt bis etwa ${until ? new Date(until).toISOString() : "–"}`);
  note(a.inside.uploads.length === 0, `keine offenen Teil-Uploads im Laufpräfix${a.inside.uploads.length ? `: ${a.inside.uploads.map((u) => u.Key.slice(run.length)).join(", ")}` : ""}`);
  out(`\nErgebnis: ${outsideChanged || settingsChanged ? "ABWEICHUNG AUSSERHALB DES LAUFPRÄFIXES ODER AN DEN EINSTELLUNGEN – " : ""}${deviations.length ? `${deviations.length} Abweichungen` : "alles wie erwartet"}`);
  if (outsideChanged || settingsChanged) return 4;
  return deviations.length ? 1 : 0;
}

// Direkter Aufruf (nicht beim Import in einem lokalen Test)
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  guardProcess(20);
  // Vor dem Zeitlimit von guardProcess und bei SIGTERM: eigene Teil-Uploads abbrechen, dann beenden.
  const stop = async (why) => {
    console.log(`\nABBRUCH: ${why}`);
    if (pending.cleanup) await pending.cleanup();
    process.exit(4);
  };
  setTimeout(() => stop("Zeitlimit des Vortests (15 Minuten) überschritten"), 15 * 60_000).unref();
  process.once("SIGTERM", () => stop("SIGTERM"));
  const target = await readTarget(process.env, { keysFromStdin: true });
  const run = process.env.RB_VORTEST_PREFIX ?? "";
  if (target.missing.length || target.bucket !== TEST_BUCKET) {
    console.error(`ABBRUCH: ${target.missing.length ? `es fehlt: ${target.missing.join(", ")}` : `Ziel ist nicht ${TEST_BUCKET}`}`);
    process.exit(2);
  }
  console.log(`Vortest der Produktionsskripte · Bucket ${target.bucket} · Endpunkt ${target.endpoint} · Laufpräfix ${run}`);
  const client = s3Client(target);
  const strictClient = s3Client(target, { requestChecksumCalculation: "WHEN_REQUIRED" });
  // Schreibender Client ohne Wiederholungen: jede Anfrage kommt höchstens einmal an (kein doppelter Teil-Upload).
  const writerClient = s3Client(target, { requestChecksumCalculation: "WHEN_REQUIRED", maxAttempts: 1 });
  process.exit(await runVortest({ client, strictClient, writerClient, run }));
}

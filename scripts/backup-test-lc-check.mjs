// Lesende Lifecycle-Prüfung am Test-Bucket rent-base-backup-test (docs/backup-test-bucket.md, „Vorbereitet: Lifecycle-Prüfung
// 16.10.2026“). Vergleicht jeden Schlüssel und die Bucket-Einstellungen mit dem protokollierten Stand vom 14.10.2026, 12:07 UTC.
// Schickt nur lesende Anfragen. Gibt nur Schlüsselnamen, Zähler und Zeitpunkte aus, nie Zugangsdaten.
//
// Ausführen (erst auf Anordnung, vom eigenen Rechner aus dem Repository-Verzeichnis):
//   ssh rb 'IMG=$(docker inspect "$(docker ps --format "{{.Names}}" | grep -E "^ye2zlmuxnpvk4osu9l5d9tqa-[0-9]+(T[0-9]+)?$")" --format "{{.Image}}"); [ "$(docker info --format "{{.Debug}}")" = false ] && docker run --rm -i --init --ulimit core=0 --network bridge --entrypoint node --env-file /root/backup-test.env -w /app "$IMG" --input-type=module -' < scripts/backup-test-lc-check.mjs
//
// Exit 0: alles außerhalb von rb-test/lc/ und alle Einstellungen unverändert (der Zustand unter rb-test/lc/ steht im Ergebnis);
// 1: Abweichung außerhalb von rb-test/lc/ oder an den Einstellungen – stoppen und berichten; 2: nicht lesbar.

import { pathToFileURL } from "node:url";
import s3sdk from "@aws-sdk/client-s3";

const {
  S3Client, ListBucketsCommand, ListObjectVersionsCommand, ListMultipartUploadsCommand, GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand, GetBucketLifecycleConfigurationCommand, GetBucketPolicyCommand, GetBucketAclCommand,
} = s3sdk;

export const BUCKET = "rent-base-backup-test";
const LC = "rb-test/lc/";
const LC_KEY = "rb-test/lc/ablauf.txt";
const P = "rb-test/policy/20261014T072427Z-a3e4f3/w/files/";
const V = "rb-test/prodskript/20261014T113609Z-f2a637/";
const D = `${V}data/coolify/backups/rb-vortest/`;

/** Stand vom 14.10.2026, 12:07 UTC (Lifecycle-Prüfung, docs/backup-test-bucket.md): Fassungen, Löschmarker, aktuellster Eintrag. */
export const BASELINE = {
  "rb-test/default.txt": { v: 2, m: 0, latest: "Fassung 2026-10-10T11:13" },
  [LC_KEY]: { v: 1, m: 1, latest: "Löschmarker 2026-10-14T01:30" },
  "rb-test/md5.txt": { v: 0, m: 1, latest: "Löschmarker 2026-10-10T11:13" },
  "rb-test/ohne-pruefsumme.txt": { v: 1, m: 0, latest: "Fassung 2026-10-10T11:13" },
  [`${P}probe.txt`]: { v: 1, m: 0, latest: "Fassung 2026-10-14T07:24" },
  [`${P}ungesperrt/probe.txt`]: { v: 1, m: 0, latest: "Fassung 2026-10-14T07:24" },
  [`${D}pg-dump-vortest-1.dmp`]: { v: 1, m: 0, latest: "Fassung 2026-10-14T11:36" },
  [`${D}pg-dump-vortest-2.dmp`]: { v: 2, m: 0, latest: "Fassung 2026-10-14T11:36" },
  [`${D}pg-dump-vortest-3.dmp`]: { v: 1, m: 1, latest: "Löschmarker 2026-10-14T11:36" },
  [`${V}files-state/missing.json`]: { v: 1, m: 0, latest: "Fassung 2026-10-14T11:36" },
  [`${V}files/t/vortest/contracts/2026/10/vertrag.pdf`]: { v: 1, m: 1, latest: "Löschmarker 2026-10-14T11:36" },
  [`${V}files/t/vortest/documents/2026/10/dokument.pdf`]: { v: 1, m: 0, latest: "Fassung 2026-10-14T11:36" },
  [`${V}files/t/vortest/photos/2026/10/foto.jpg`]: { v: 1, m: 1, latest: "Löschmarker 2026-10-14T11:36" },
  "rb-test/rundlauf-12mb-teile.bin": { v: 1, m: 0, latest: "Fassung 2026-10-10T11:14" },
  "rb-test/rundlauf-1mb.bin": { v: 1, m: 0, latest: "Fassung 2026-10-10T11:13" },
};
const KNOWN_LOCK = JSON.stringify({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } });

const errorName = (e) => `${e?.name ?? "Fehler"}${e?.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : ""}`;
const minute = (d) => new Date(d).toISOString().slice(0, 16);

/** Prüft den Bucket; liefert den Exit-Code. */
export async function checkLifecycle({ client, out = console.log }) {
  const deviations = [];
  const line = (ok, text) => {
    out(`${ok ? "BESTANDEN " : "ABWEICHUNG"} ${text}`);
    if (!ok) deviations.push(text);
  };
  const Bucket = BUCKET;

  // Einstellungen
  const names = ((await client.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name);
  line(names.length === 1 && names[0] === BUCKET, `Isolation: Schlüssel sieht ${names.length === 1 && names[0] === BUCKET ? `nur ${BUCKET}` : `${names.length} Buckets`}`);
  const ver = await client.send(new GetBucketVersioningCommand({ Bucket }));
  line(ver.Status === "Enabled", `Versionierung: ${ver.Status ?? "aus"}`);
  const lock = JSON.stringify((await client.send(new GetObjectLockConfigurationCommand({ Bucket }))).ObjectLockConfiguration ?? null);
  line(lock === KNOWN_LOCK, `Standard-Sperre: ${lock === KNOWN_LOCK ? "COMPLIANCE 1 Tag" : lock}`);
  const rules = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket }))).Rules ?? [];
  const r = rules[0];
  const lcOk = rules.length === 1 && r.ID === "rb-test-ablauf" && r.Status === "Enabled" && (r.Filter?.Prefix ?? r.Filter?.And?.Prefix ?? r.Prefix) === LC
    && r.Expiration?.Days === 1 && r.NoncurrentVersionExpiration?.NoncurrentDays === 1 && !r.AbortIncompleteMultipartUpload && !(r.Transitions?.length);
  line(lcOk, `Lifecycle: ${rules.map((x) => `${x.ID} (${x.Filter?.Prefix ?? x.Prefix ?? ""})`).join(", ") || "keine Regel"}`);
  let policy;
  try {
    await client.send(new GetBucketPolicyCommand({ Bucket }));
    policy = "VORHANDEN";
  } catch (e) {
    policy = e?.name === "NoSuchBucketPolicy" ? "keine" : `nicht lesbar (${errorName(e)})`;
  }
  line(policy === "keine", `Bucket-Policy: ${policy}`);
  const acl = await client.send(new GetBucketAclCommand({ Bucket }));
  const grants = acl.Grants ?? [];
  const ownerOnly = grants.length === 1 && grants[0].Grantee?.ID === acl.Owner?.ID;
  line(ownerOnly, `Bucket-ACL: ${ownerOnly ? "1 Eintrag, nur der Besitzer" : `${grants.length} Einträge`}`);

  // Bestand
  const versions = [];
  const markers = [];
  let KeyMarker;
  let VersionIdMarker;
  for (let page = 0; page < 1000; page++) {
    const res = await client.send(new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker }));
    versions.push(...(res.Versions ?? []));
    markers.push(...(res.DeleteMarkers ?? []));
    if (!res.IsTruncated) break;
    KeyMarker = res.NextKeyMarker;
    VersionIdMarker = res.NextVersionIdMarker;
  }
  const uploads = (await client.send(new ListMultipartUploadsCommand({ Bucket }))).Uploads ?? [];
  line(uploads.length === 0, `offene Teil-Uploads: ${uploads.length}`);
  const actual = {};
  for (const [list, isMarker] of [[versions, false], [markers, true]]) {
    for (const e of list) {
      const a = (actual[e.Key] ??= { v: 0, m: 0, latest: null, noncurrent: [] });
      if (isMarker) a.m++;
      else a.v++;
      if (e.IsLatest) a.latest = `${isMarker ? "Löschmarker" : "Fassung"} ${minute(e.LastModified)}`;
      else if (!isMarker) a.noncurrent.push(minute(e.LastModified));
    }
  }
  const fmt = (x) => (x ? `${x.v} Fassung(en), ${x.m} Löschmarker, aktuell ${x.latest ?? "–"}` : "nicht vorhanden");

  // rb-test/lc/: der beobachtete Lifecycle
  const lcKeys = Object.keys(actual).filter((k) => k.startsWith(LC));
  const a = actual[LC_KEY];
  let lcState;
  if (lcKeys.some((k) => k !== LC_KEY)) lcState = "UNERWARTET: weitere Schlüssel unter rb-test/lc/";
  else if (a && a.v === 1 && a.m === 1 && a.latest === BASELINE[LC_KEY].latest) lcState = `unverändert: alte Fassung (vom ${a.noncurrent[0]}) noch da, Löschmarker vom 14.10. 01:30 – NoncurrentVersionExpiration hat noch nicht gewirkt`;
  else if (a && a.v === 0 && a.m === 1 && a.latest === BASELINE[LC_KEY].latest) lcState = "alte Fassung ENDGÜLTIG ENTFERNT, Löschmarker noch da – NoncurrentVersionExpiration wirkt";
  else if (!a) lcState = "alte Fassung UND Löschmarker entfernt – NoncurrentVersionExpiration wirkt, der leere Löschmarker wurde ebenfalls entfernt";
  else lcState = `UNERWARTET: ${fmt(a)}`;
  out(`ERGEBNIS   ${LC_KEY}: ${lcState}`);
  if (lcState.startsWith("UNERWARTET")) deviations.push(`rb-test/lc/: ${lcState}`);

  // Alles außerhalb von rb-test/lc/: muss dem Stand vom 14.10. entsprechen
  const keys = [...new Set([...Object.keys(BASELINE), ...Object.keys(actual)])].filter((k) => !k.startsWith(LC)).sort();
  let changed = 0;
  for (const k of keys) {
    const b = BASELINE[k];
    const x = actual[k];
    const same = b && x && b.v === x.v && b.m === x.m && b.latest === x.latest;
    if (!same) {
      changed++;
      line(false, `${k}: vorher ${b ? `${b.v} Fassung(en), ${b.m} Löschmarker, aktuell ${b.latest}` : "nicht vorhanden"}; jetzt ${fmt(x)}`);
    }
  }
  if (!changed) line(true, `Bestand außerhalb von rb-test/lc/: alle ${keys.length} Schlüssel unverändert`);
  const markersOutside = markers.filter((m) => !m.Key.startsWith(LC)).length;
  out(`INFO       gesamt: ${versions.length} Fassungen, ${markers.length} Löschmarker (außerhalb von rb-test/lc/: ${markersOutside}, am 14.10.: 4)`);
  line(markersOutside === 4, `keine neuen Löschmarker außerhalb von rb-test/lc/`);

  out(`\nErgebnis: ${deviations.length ? `${deviations.length} Abweichung(en) – stoppen und berichten` : "außerhalb von rb-test/lc/ und an den Einstellungen nichts verändert"}`);
  return deviations.length ? 1 : 0;
}

// Direkter Aufruf über die Standardeingabe (siehe oben); beim Import in einem lokalen Test nicht.
if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  if (env.TEST_S3_BUCKET !== BUCKET) {
    console.log(`ABBRUCH: Zugangsdatei nennt nicht ${BUCKET}`);
    process.exit(2);
  }
  const client = new S3Client({
    endpoint: env.TEST_S3_ENDPOINT, region: "hel1", forcePathStyle: true, maxAttempts: 2,
    credentials: { accessKeyId: env.TEST_S3_ACCESS_KEY, secretAccessKey: env.TEST_S3_SECRET_KEY },
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000, throwOnRequestTimeout: true },
  });
  setTimeout(() => { console.log("ABBRUCH: Zeitlimit 5 Minuten"); process.exit(2); }, 5 * 60_000).unref();
  console.log(`Lesende Lifecycle-Prüfung ${BUCKET} · ${new Date().toISOString()} · Vergleich mit dem Stand vom 14.10.2026, 12:07 UTC`);
  try {
    process.exit(await checkLifecycle({ client }));
  } catch (e) {
    console.log(`ABBRUCH: nicht lesbar (${errorName(e)})`);
    process.exit(2);
  }
}

// Lesender Prüflauf für den produktiven Backup-Bucket (docs/backup-uebergang.md). Läuft als Scheduled Task in Coolify im
// App-Container; vor dem Deploy auch über scripts/backup-prod-run.sh --check auf dem Server.
//
// Aufruf:  node scripts/backup-check.mjs          stündlich: Buckets im Projekt, Versionierung, Standard-Sperre, Lifecycle,
//                                                 keine Policy, Bucket-ACL; alle Fassungen: neuester Dump (Alter, Größe,
//                                                 Anzahl in 24 h), überschriebene oder gelöschte Dumps und Dateien, Objekte
//                                                 außerhalb der Regeln, Sperre jeder Fassung der letzten 26 h, Dateisicherung
//          node scripts/backup-check.mjs --voll   täglich zusätzlich: Lifecycle-Fristen (Datenschutz), Gesamtgröße, Sperre
//                                                 und ACL aller aktuellen Fassungen, offene Teil-Uploads
//
// Umgebung: BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY,
//           BACKUP_DUMP_PREFIX (Pflicht, Präfix der Coolify-Dumps), optional BACKUP_CHECK_MAX_DUMP_AGE_HOURS (2),
//           BACKUP_CHECK_MIN_DUMP_BYTES (100000), BACKUP_CHECK_MIN_DUMPS_24H (20), BACKUP_CHECK_MAX_DUMPS_24H (30),
//           BACKUP_CHECK_FILES_MAX_AGE_HOURS (2; geprüft, sobald files-state/missing.json existiert),
//           BACKUP_CHECK_BUFFER_DAYS (7, Puffer für Hetzners Lifecycle-Verzögerung), BACKUP_CHECK_MAX_TOTAL_GB (100),
//           BACKUP_CHECK_ERLAUBTE_BUCKETS (weitere erlaubte Buckets im Projekt, Komma-getrennt),
//           BACKUP_CHECK_BEKANNT (geklärte Vorfälle: Objektschlüssel oder Bucket-Namen, Komma-getrennt; melden nur noch Hinweise).
// Schickt nur lesende Anfragen. Gibt keine Zugangsdaten aus. Endet mit Code 1, wenn etwas nicht stimmt; Coolify meldet den
// Scheduled Task dann als fehlgeschlagen und verschickt die Benachrichtigung. Code 2: Aufruf oder Umgebung falsch.

import { guardProcess, readTarget, runCheck, s3Client } from "./backup-prod-lib.mjs";

guardProcess(15);

const args = process.argv.slice(2);
const keysFromStdin = args.includes("--schluessel-stdin");
const full = args.includes("--voll");
if (args.some((a) => a !== "--schluessel-stdin" && a !== "--voll")) {
  console.error("Aufruf: backup-check.mjs [--voll] [--schluessel-stdin]");
  process.exit(2);
}

const env = process.env;
const number = (name, fallback, min) => {
  if (env[name] == null || env[name] === "") return fallback;
  const n = Number(env[name]);
  if (!Number.isFinite(n) || n < min) {
    console.error(`${name} muss eine Zahl ab ${min} sein.`);
    process.exit(2);
  }
  return n;
};
const list = (name) => (env[name] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const options = {
  dumpPrefix: env.BACKUP_DUMP_PREFIX,
  maxDumpAgeHours: number("BACKUP_CHECK_MAX_DUMP_AGE_HOURS", 2, 1),
  minDumpBytes: number("BACKUP_CHECK_MIN_DUMP_BYTES", 100_000, 0),
  minDumps24h: number("BACKUP_CHECK_MIN_DUMPS_24H", 20, 0),
  maxDumps24h: number("BACKUP_CHECK_MAX_DUMPS_24H", 30, 1),
  filesMaxAgeHours: number("BACKUP_CHECK_FILES_MAX_AGE_HOURS", 2, 1),
  bufferDays: number("BACKUP_CHECK_BUFFER_DAYS", 7, 0),
  maxTotalGb: number("BACKUP_CHECK_MAX_TOTAL_GB", 100, 1),
  allowedOtherBuckets: list("BACKUP_CHECK_ERLAUBTE_BUCKETS"),
  known: list("BACKUP_CHECK_BEKANNT"),
};

const target = await readTarget(env, { keysFromStdin });
if (target.missing.length) {
  console.error(`Es fehlt: ${target.missing.join(", ")}`);
  process.exit(2);
}
console.log(`Prüfung ${target.bucket} · ${full ? "voll" : "stündlich"} · ${new Date().toISOString()}`);
const counts = await runCheck({ client: s3Client(target), bucket: target.bucket, full, ...options });
console.log(`\nErgebnis: ${counts.ok} ok, ${counts.fehler} Fehler, ${counts.hinweis} Hinweise`);
process.exit(counts.fehler ? 1 : 0);

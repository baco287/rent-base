// Sichert Fotos, Unterschriften und Dokumente aus dem App-Bucket in den Backup-Bucket (unter files/).
// Läuft nachts als Scheduled Task in Coolify im App-Container, nach dem Datenbank-Backup (siehe docs/backup.md).
//
// Aufruf:  node scripts/backup-files.mjs            neue Dateien sichern, in der App gelöschte nach 30 Tagen entfernen
//          node scripts/backup-files.mjs --restore  fehlende Dateien aus dem Backup zurück in den App-Bucket
//
// Im App-Bucket wird nie etwas gelöscht oder überschrieben. Im Backup verschwindet eine Datei erst 30 Tage
// (BACKUP_GRACE_DAYS) nachdem sie in der App gelöscht wurde, damit Datenschutz-Löschungen auch dort ankommen.
// Endet mit Code 1, wenn etwas nicht geklappt hat. Coolify meldet den Task dann als fehlgeschlagen.

import { DEFAULT_GRACE_DAYS, FILES_PREFIX, copyMissing, pruneDeleted, readBucketConfig, s3Bucket } from "./backup-lib.mjs";

const restore = process.argv.includes("--restore");

const app = readBucketConfig(process.env, "");
const backup = readBucketConfig(process.env, "BACKUP_");
const missing = [...app.missing, ...backup.missing];
if (missing.length) {
  console.error(`Es fehlen Umgebungsvariablen: ${missing.join(", ")}`);
  process.exit(1);
}
if (app.endpoint === backup.endpoint && app.bucket === backup.bucket) {
  console.error("App-Bucket und Backup-Bucket sind identisch. Das Backup muss in einem eigenen Bucket liegen.");
  process.exit(1);
}
const graceDays = process.env.BACKUP_GRACE_DAYS ? Number(process.env.BACKUP_GRACE_DAYS) : DEFAULT_GRACE_DAYS;
if (!Number.isInteger(graceDays) || graceDays < 7) {
  console.error("BACKUP_GRACE_DAYS muss eine ganze Zahl ab 7 sein.");
  process.exit(1);
}

const appBucket = s3Bucket(app);
const backupBucket = s3Bucket(backup);
const started = Date.now();
const log = (m) => console.log(m);
let ok = true;

if (restore) {
  console.log(`Wiederherstellung: ${backupBucket.label} -> ${appBucket.label}`);
  const result = await copyMissing({ from: backupBucket, fromPrefix: FILES_PREFIX, to: appBucket, toPrefix: "", log });
  report(result);
} else {
  console.log(`Sicherung: ${appBucket.label} -> ${backupBucket.label}`);
  const result = await copyMissing({ from: appBucket, fromPrefix: "", to: backupBucket, toPrefix: FILES_PREFIX, replaceDifferent: true, log });
  report(result);
  try {
    const pruned = await pruneDeleted({ source: appBucket, backup: backupBucket, graceDays, log });
    if (pruned.failed.length) {
      ok = false;
      for (const f of pruned.failed.slice(0, 20)) console.error(`  Entfernen fehlgeschlagen ${f.key}: ${f.error}`);
    }
  } catch (e) {
    ok = false;
    console.error(`Aufräumen übersprungen: ${e?.message ?? e}`);
  }
}

console.log(`Dauer ${Math.round((Date.now() - started) / 1000)} s.`);
if (!ok) process.exit(1);

function report(result) {
  const mb = (result.bytes / 1024 / 1024).toFixed(1);
  console.log(`${result.copied} kopiert (${mb} MB), ${result.alreadyPresent} waren schon vorhanden, ${result.failed.length} Fehler.`);
  if (result.failed.length) {
    ok = false;
    for (const f of result.failed.slice(0, 20)) console.error(`  ${f.key}: ${f.error}`);
    if (result.failed.length > 20) console.error(`  … und ${result.failed.length - 20} weitere`);
  }
}

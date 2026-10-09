// Sichert Fotos, Unterschriften und Dokumente aus dem App-Bucket in den Backup-Bucket (unter files/).
// Läuft als Scheduled Task in Coolify im App-Container, nach dem Datenbank-Backup (siehe docs/backup.md).
//
// Aufruf:  node scripts/backup-files.mjs            neue Dateien sichern, legitim gelöschte nach 30 Tagen entfernen
//          node scripts/backup-files.mjs --restore  fehlende Dateien aus dem Backup zurück in den App-Bucket
//
// Grundsätze:
// - Im App-Bucket wird nie etwas gelöscht oder überschrieben.
// - Im Backup wird nie etwas überschrieben. Weicht eine Datei ab, bleibt die gesicherte Fassung und es gibt einen Fehler.
// - Aus dem Backup gelöscht werden nur Entwurfsfotos und Führerscheinkopien, die die App legitim gelöscht hat
//   (Datenbank verweist nicht mehr darauf), und das erst 30 Tage (BACKUP_GRACE_DAYS) nach dem Verschwinden.
//   Alle anderen fehlenden Dateien bleiben im Backup und werden jede Nacht als Fehler gemeldet.
// Endet mit Code 1, wenn etwas nicht stimmt. Coolify meldet den Task dann als fehlgeschlagen.

import { DEFAULT_GRACE_DAYS, FILES_PREFIX, copyMissing, loadReferences, makeIsPrunable, pruneDeleted, readBucketConfig, s3Bucket } from "./backup-lib.mjs";

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
  report(result, "im App-Bucket", "Backup");
} else {
  console.log(`Sicherung: ${appBucket.label} -> ${backupBucket.label}`);
  const result = await copyMissing({ from: appBucket, fromPrefix: "", to: backupBucket, toPrefix: FILES_PREFIX, log });
  report(result, "im Backup", "App-Bucket");
  try {
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient();
    let references;
    try {
      references = await loadReferences(db);
    } finally {
      await db.$disconnect();
    }
    const pruned = await pruneDeleted({ source: appBucket, backup: backupBucket, graceDays, isPrunable: makeIsPrunable(references), log });
    if (pruned.protectedMissing.length) {
      ok = false;
      console.error(`${pruned.protectedMissing.length} Dateien fehlen im App-Bucket, obwohl die App sie nie löscht. Sie bleiben im Backup. Prüfen und mit --restore zurückholen:`);
      for (const k of pruned.protectedMissing.slice(0, 20)) console.error(`  ${k}`);
      if (pruned.protectedMissing.length > 20) console.error(`  … und ${pruned.protectedMissing.length - 20} weitere`);
    }
    if (pruned.failed.length) {
      ok = false;
      for (const f of pruned.failed.slice(0, 20)) console.error(`  Entfernen fehlgeschlagen ${f.key}: ${f.error}`);
    }
  } catch (e) {
    ok = false;
    console.error(`Aufräumen übersprungen, nichts gelöscht: ${e?.message ?? e}`);
  }
}

console.log(`Dauer ${Math.round((Date.now() - started) / 1000)} s.`);
if (!ok) process.exit(1);

function report(result, kept, other) {
  const mb = (result.bytes / 1024 / 1024).toFixed(1);
  console.log(`${result.copied} kopiert (${mb} MB), ${result.alreadyPresent} waren schon vorhanden, ${result.failed.length} Fehler, ${result.mismatched.length} Abweichungen.`);
  if (result.failed.length) {
    ok = false;
    for (const f of result.failed.slice(0, 20)) console.error(`  ${f.key}: ${f.error}`);
    if (result.failed.length > 20) console.error(`  … und ${result.failed.length - 20} weitere`);
  }
  if (result.mismatched.length) {
    ok = false;
    console.error(`${result.mismatched.length} Dateien haben ${kept} eine andere Größe als im ${other}. Nichts wurde überschrieben, die vorhandene Fassung bleibt. Mögliche Manipulation, bitte prüfen:`);
    for (const m of result.mismatched.slice(0, 20)) console.error(`  ${m.key}: Quelle ${m.sourceSize} Bytes, Ziel ${m.targetSize} Bytes`);
    if (result.mismatched.length > 20) console.error(`  … und ${result.mismatched.length - 20} weitere`);
  }
}

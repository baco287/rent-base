// Entfernt Dateien bereits gelöschter Ausweis- und Führerscheinkopien aus dem App-Bucket (Regeln: driver-copy-cleanup-lib.mjs).
// Läuft als Scheduled Task in Coolify im App-Container oder von Hand im App-Terminal (siehe docs/backup.md).
//
// Aufruf:  node scripts/cleanup-driver-copies.mjs                 alle Mandanten
//          node scripts/cleanup-driver-copies.mjs --dry-run       nur berichten, nichts löschen
//          node scripts/cleanup-driver-copies.mjs --tenant <id>   nur ein Mandant
//
// Löscht ausschließlich Dateien von Kopien mit deletionStatus DELETED, nur im Kopienbereich des eigenen Mandanten.
// Endet mit Code 1, wenn etwas fehlschlägt oder verweigert wurde. Coolify meldet den Task dann als fehlgeschlagen;
// ein erneuter Lauf ist unschädlich.

import { readBucketConfig, s3Bucket } from "./backup-lib.mjs";
import { sweepDeletedCopyFiles } from "./driver-copy-cleanup-lib.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tenantIdx = args.indexOf("--tenant");
const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : null;
if (tenantIdx >= 0 && !tenantId) {
  console.error("--tenant braucht eine Mandanten-Id.");
  process.exit(1);
}

const app = readBucketConfig(process.env, "");
if (app.missing.length) {
  console.error(`Es fehlen Umgebungsvariablen: ${app.missing.join(", ")}`);
  process.exit(1);
}
const bucket = s3Bucket(app);
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const started = Date.now();
let ok = true;
try {
  console.log(`Aufräumlauf gelöschte Dokumentkopien${dryRun ? " (nur Bericht)" : ""}: ${bucket.label}${tenantId ? `, Mandant ${tenantId}` : ""}`);
  const r = await sweepDeletedCopyFiles({ db, bucket, tenantId, dryRun, log: (m) => console.log(`  ${m}`) });
  console.log(`${r.tenants} Mandanten, ${r.checked} gelöschte Kopien geprüft: ${dryRun ? `${r.wouldRemove} würden entfernt` : `${r.removed} Dateien entfernt`}, ${r.alreadyGone} bereits entfernt, ${r.refused.length} verweigert, ${r.failed.length} Fehler.`);
  for (const x of r.refused.slice(0, 20)) console.error(`  Verweigert ${x.copyId} (Mandant ${x.tenantId}): ${x.reason}`);
  for (const x of r.failed.slice(0, 20)) console.error(`  Fehler ${x.copyId} (Mandant ${x.tenantId}): ${x.error}`);
  if (r.refused.length || r.failed.length) ok = false;
} catch (e) {
  ok = false;
  console.error(`Aufräumlauf abgebrochen, nichts weiter gelöscht: ${e?.message ?? e}`);
} finally {
  await db.$disconnect();
}
console.log(`Dauer ${Math.round((Date.now() - started) / 1000)} s.`);
if (!ok) process.exit(1);

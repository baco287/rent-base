// Prüft eine wiederhergestellte Datenbank gegen die Live-Datenbank und den Backup-Bucket.
// Ablauf des Wiederherstellungstests: siehe docs/backup.md.
//
// Aufruf im App-Container:  RESTORE_DATABASE_URL="postgres://…/…" node scripts/check-restore.mjs
//
// Liest nur, schreibt nichts. Endet mit Code 1, wenn ein Fehler gefunden wurde.

import { pathToFileURL } from "node:url";
import { FILES_PREFIX, readBucketConfig, s3Bucket, sha256Hex } from "./backup-lib.mjs";

const TABLES = [
  ["tenant", "Mandanten"],
  ["user", "Benutzer"],
  ["customer", "Kunden"],
  ["vehicle", "Fahrzeuge"],
  ["booking", "Buchungen"],
  ["rentalContract", "Mietverträge"],
  ["contractAmendment", "Vertragsnachträge"],
  ["handover", "Übergabeprotokolle"],
  ["damage", "Schäden"],
  ["damageCase", "Schadenfälle"],
  ["photo", "Fotos"],
  ["signature", "Unterschriften"],
  ["document", "Dokumente"],
  ["invoice", "Rechnungen"],
  ["payment", "Zahlungen"],
  ["securityDeposit", "Kautionen"],
  ["extraCharge", "Zusatzkosten"],
  ["auditLog", "Protokolleinträge"],
];

// Alle Tabellen mit Dateien im Object Storage: [Modell, Bezeichnung, Bedingung für "Datei muss existieren"]
const FILE_MODELS = [
  ["photo", "Foto", {}],
  ["document", "Dokument", {}],
  ["damageCaseDocument", "Schadenakte", {}],
  ["vehicleDocument", "Fahrzeugdokument", {}],
  ["authorityUpload", "Behördenschreiben", {}],
  ["authorityCaseDocument", "Behördenakte", {}],
  ["accidentReplacementCaseDocument", "Unfallersatzakte", {}],
  // Datenschutzgerecht gelöschte Führerscheinkopien haben absichtlich keine Datei mehr
  ["driverDocumentCopy", "Fahrerdokument", { deletionStatus: { not: "DELETED" } }],
];

const MAX_AGE_HOURS = 48;

async function collectStats(client) {
  // Ohne Migrationstabelle ist es keine Rent-Base-Datenbank (oder der Import ist gescheitert)
  const rows = await client
    .$queryRawUnsafe(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)
    .catch(() => []);
  const migrations = rows.map((r) => r.migration_name);
  const counts = {};
  for (const [model] of TABLES) counts[model] = await client[model].count().catch(() => null);
  const max = (model, field) => client[model].aggregate({ _max: { [field]: true } }).then((r) => r._max[field], () => null);
  const newestOf = await Promise.all([max("booking", "createdAt"), max("handover", "createdAt"), max("photo", "uploadedAt"), max("document", "createdAt")]);
  const newest = newestOf.filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  return { migrations, counts, newest };
}

/** Alle Dateien, die die wiederhergestellte Datenbank im Object Storage erwartet. */
async function expectedFiles(client) {
  const out = [];
  for (const [model, , where] of FILE_MODELS) {
    const rows = await client[model].findMany({ where, select: { storageKey: true, sizeBytes: true, checksum: true } });
    out.push(...rows.map((r) => ({ key: r.storageKey, size: r.sizeBytes, checksum: r.checksum })));
  }
  // Unterschriften liegen bisher als Bild in der Datenbank. Nur solche ohne Bilddaten erwarten eine Datei.
  const signatures = await client.signature.findMany({ where: { imageData: null }, select: { storageKey: true, imageChecksum: true } });
  out.push(...signatures.map((s) => ({ key: s.storageKey, size: null, checksum: s.imageChecksum })));
  // Logos der Mandanten (Briefkopf in PDFs und Mails)
  const logos = await client.tenant.findMany({ where: { logoStorageKey: { not: null } }, select: { logoStorageKey: true, logoChecksum: true } });
  out.push(...logos.map((t) => ({ key: t.logoStorageKey, size: null, checksum: t.logoChecksum })));
  return out;
}

/**
 * Vergleicht und liefert eine Liste von Befunden { level: "OK" | "WARNUNG" | "FEHLER", text }.
 * prod und restored sind PrismaClients, backup ist ein Bucket aus backup-lib.mjs.
 */
export async function checkRestore({ prod, restored, backup, sampleSize = 5 }) {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });

  const live = await collectStats(prod);
  const back = await collectStats(restored);

  // Migrationen
  if (back.migrations.length === 0) {
    add("FEHLER", "Keine Migrationen in der wiederhergestellten Datenbank. Ist das die richtige Datenbank?");
    return findings;
  }
  const notInBackup = live.migrations.filter((m) => !back.migrations.includes(m));
  const unknown = back.migrations.filter((m) => !live.migrations.includes(m));
  if (notInBackup.length) add("WARNUNG", `Das Backup ist älter als diese Migrationen: ${notInBackup.join(", ")}`);
  if (unknown.length) add("WARNUNG", `Migrationen im Backup, die live fehlen: ${unknown.join(", ")}`);
  if (!notInBackup.length && !unknown.length) add("OK", `Migrationen: alle ${live.migrations.length} vorhanden`);

  // Datenbestand
  for (const [model, label] of TABLES) {
    const l = live.counts[model];
    const b = back.counts[model];
    if (b === null) add("FEHLER", `${label}: Tabelle im Backup nicht lesbar`);
    else if (l > 0 && b === 0) add("FEHLER", `${label}: Backup leer, live ${l}`);
    else if (l !== null && b > l) add("WARNUNG", `${label}: ${b} im Backup, aber nur ${l} live`);
    else add("OK", `${label}: ${b} im Backup, ${l ?? "?"} live`);
  }

  // Alter
  if (back.newest) {
    const ageHours = live.newest ? (live.newest - back.newest) / 3_600_000 : 0;
    const text = `Neuester Datensatz im Backup: ${back.newest.toISOString()}`;
    if (ageHours > MAX_AGE_HOURS) add("WARNUNG", `${text}, live ${live.newest.toISOString()}. Das Backup ist älter als ${MAX_AGE_HOURS} Stunden.`);
    else add("OK", text);
  }

  // Dateien
  const expected = await expectedFiles(restored);
  const stored = await backup.list(FILES_PREFIX);
  const missing = expected.filter((e) => !stored.has(e.key));
  const wrongSize = expected.filter((e) => stored.has(e.key) && e.size !== null && stored.get(e.key) !== e.size);
  if (missing.length) add("FEHLER", `${missing.length} von ${expected.length} Dateien fehlen im Backup, z. B. ${missing.slice(0, 3).map((e) => e.key).join(", ")}`);
  if (wrongSize.length) add("FEHLER", `${wrongSize.length} Dateien haben im Backup eine falsche Größe, z. B. ${wrongSize[0].key}`);
  if (!missing.length && !wrongSize.length) add("OK", `Dateien: alle ${expected.length} referenzierten Dateien liegen im Backup`);

  // Stichprobe: Dateien wirklich laden und gegen die Prüfsumme aus der Datenbank prüfen
  const candidates = expected.filter((e) => e.checksum && stored.has(e.key));
  const sample = [...candidates].sort(() => Math.random() - 0.5).slice(0, sampleSize);
  const broken = [];
  for (const e of sample) {
    const obj = await backup.get(FILES_PREFIX + e.key);
    if (!obj || sha256Hex(obj.body) !== e.checksum) broken.push(e.key);
  }
  if (broken.length) add("FEHLER", `Prüfsumme stimmt nicht bei ${broken.length} von ${sample.length} Stichproben: ${broken.join(", ")}`);
  else if (sample.length) add("OK", `Stichprobe: ${sample.length} Dateien geladen, Prüfsummen stimmen`);

  return findings;
}

function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "(ungültige Adresse)";
  }
}

async function main() {
  const restoreUrl = process.env.RESTORE_DATABASE_URL;
  if (!restoreUrl) {
    console.error('RESTORE_DATABASE_URL fehlt. Aufruf: RESTORE_DATABASE_URL="postgres://…" node scripts/check-restore.mjs');
    process.exit(1);
  }
  if (restoreUrl === process.env.DATABASE_URL) {
    console.error("RESTORE_DATABASE_URL zeigt auf die Live-Datenbank. Bitte die Adresse der wiederhergestellten Testdatenbank angeben.");
    process.exit(1);
  }
  const bucketCfg = readBucketConfig(process.env, "BACKUP_");
  if (bucketCfg.missing.length) {
    console.error(`Es fehlen Umgebungsvariablen: ${bucketCfg.missing.join(", ")}`);
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const prod = new PrismaClient();
  const restored = new PrismaClient({ datasourceUrl: restoreUrl });
  const backup = s3Bucket(bucketCfg);

  console.log("Prüfung der Wiederherstellung");
  console.log(`  Live-Datenbank:     ${describeUrl(process.env.DATABASE_URL)}`);
  console.log(`  Wiederhergestellt:  ${describeUrl(restoreUrl)}`);
  console.log(`  Backup-Bucket:      ${backup.label}\n`);

  try {
    const findings = await checkRestore({ prod, restored, backup });
    for (const f of findings) console.log(`${f.level.padEnd(8)} ${f.text}`);
    const errors = findings.filter((f) => f.level === "FEHLER").length;
    const warnings = findings.filter((f) => f.level === "WARNUNG").length;
    console.log(`\nErgebnis: ${errors ? "NICHT bestanden" : "bestanden"} (${errors} Fehler, ${warnings} Warnungen)`);
    process.exitCode = errors ? 1 : 0;
  } finally {
    await Promise.all([prod.$disconnect(), restored.$disconnect()]);
  }
}

// Ohne Top-Level-await, damit die Tests das Modul laden können
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`Prüfung abgebrochen: ${e?.message ?? e}`);
    process.exit(1);
  });
}

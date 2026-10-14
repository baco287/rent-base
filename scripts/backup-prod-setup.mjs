// Richtet den produktiven Backup-Bucket im Übergangsweg ein (docs/backup-uebergang.md). Läuft über scripts/backup-prod-run.sh
// in einem Wegwerf-Container auf dem Server; die Zugangsdaten kommen dort über die Standardeingabe, nie über Argumente,
// Dateien oder Umgebungsvariablen.
//
// Aufruf:  node backup-prod-setup.mjs --schluessel-stdin --pruefen               nur lesend: Projekt, Einstellungen, Bestand,
//                                                                                Vorschlag für das Dump-Präfix
//          node backup-prod-setup.mjs --schluessel-stdin --sperre                Standard-Sperre COMPLIANCE 30 Tage setzen,
//                                                                                wenn noch keine gesetzt ist
//          node backup-prod-setup.mjs --schluessel-stdin --lifecycle <Präfix>    Lifecycle-Regeln setzen, wenn noch keine
//                                                                                gesetzt sind und unter dem Präfix ein
//                                                                                gesperrter Dump liegt
//          node backup-prod-setup.mjs --schluessel-stdin --wiederherstellen <Präfix>  nach einem Eingriff: Standard-Sperre und
//                                                                                Lifecycle auf den vorgesehenen Stand setzen,
//                                                                                eine Bucket-Policy entfernen
// Ziel aus BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_BUCKET. Ohne --schluessel-stdin aus BACKUP_S3_ACCESS_KEY/_SECRET_KEY.
// Löscht nie Objekte oder Fassungen. Abweichende Einstellungen überschreibt nur --wiederherstellen, mit dem vorgesehenen Stand.
// Exit 0: eingerichtet oder schon richtig; 1: abgelehnt oder fehlgeschlagen; 2: Aufruf falsch; 3: falscher Schlüssel oder Bucket.

import { guardProcess, readTarget, runSetup, s3Client } from "./backup-prod-lib.mjs";

guardProcess(10);

const args = process.argv.slice(2);
const keysFromStdin = args.includes("--schluessel-stdin");
const rest = args.filter((a) => a !== "--schluessel-stdin");
let mode;
let dumpPrefix;
if (rest.length === 1 && rest[0] === "--pruefen") mode = "pruefen";
else if (rest.length === 1 && rest[0] === "--sperre") mode = "sperre";
else if (rest.length === 2 && rest[0] === "--lifecycle") [mode, dumpPrefix] = ["lifecycle", rest[1]];
else if (rest.length === 2 && rest[0] === "--wiederherstellen") [mode, dumpPrefix] = ["wiederherstellen", rest[1]];
else {
  console.error("Aufruf: backup-prod-setup.mjs [--schluessel-stdin] --pruefen | --sperre | --lifecycle <Dump-Präfix> | --wiederherstellen <Dump-Präfix>");
  process.exit(2);
}

const target = await readTarget(process.env, { keysFromStdin });
if (target.missing.length) {
  console.error(`Es fehlt: ${target.missing.join(", ")}`);
  process.exit(2);
}
console.log(`Einrichtung ${target.bucket} · Endpunkt ${target.endpoint} · Modus ${mode}${dumpPrefix ? ` · Dump-Präfix ${dumpPrefix}` : ""}`);
const client = s3Client(target);
const strictClient = s3Client(target, { requestChecksumCalculation: "WHEN_REQUIRED" });
const code = await runSetup({ client, strictClient, bucket: target.bucket, mode, dumpPrefix });
process.exit(code);

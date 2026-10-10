# Backups und Wiederherstellung

Rent-Base speichert Verträge, Unterschriften, Übergabeprotokolle und Fotos, die nicht verloren gehen dürfen. Die Begründungen zu Object Lock, Zugangsdaten und Datenschutz stehen in [backup-strategie.md](backup-strategie.md). Dieses Dokument ist die Betriebsanleitung.

**Status:** vorbereitet, **noch nichts aktiv**. Reihenfolge der Einrichtung:
1. Test-Bucket prüfen.
2. Produktiven Bucket anlegen.
3. Datenbank-Backup einrichten.
4. Deploy mit den Skripten.
5. Dateisicherung einrichten.
6. Erster Wiederherstellungstest.

| Was | Womit | Wann (UTC) | Wohin | Aufbewahrung |
|---|---|---|---|---|
| Datenbank | Coolify-Backup (`pg_dump`) | alle 6 Stunden: 02:00, 08:00, 14:00, 20:00 | Backup-Bucket mit Object Lock (fsn1), dazu eine lokale Kopie auf dem Server | S3: 30 Tage, lokal: die letzten 8 |
| Fotos, Dokumente, Logos | `scripts/backup-files.mjs` als Scheduled Task | jeweils 30 Minuten später: 02:30, 08:30, 14:30, 20:30 | Backup-Bucket unter `files/` | solange die App die Datei hat; legitim gelöschte Dateien nach 7 Tagen plus 7 Tage alte Version |
| Ganzer Server | Hetzner Backup | ca. 02:48 | bei Hetzner, am Server | 7 Tage |

**Maximaler Datenverlust:** 6 Stunden. Die Dateisicherung läuft jeweils nach dem Datenbank-Backup. So liegt jede Datei, die ein Dump kennt, auch im Backup-Bucket. Das Hetzner-Abbild um 02:48 enthält eine fertige, konsistente Kopie des 02:00-Dumps.

## Einmalige Einrichtung

### 1. Projekte, Schlüssel und Test-Bucket bei Hetzner

Aufbau und Begründung: [backup-strategie.md](backup-strategie.md), „Zielarchitektur“.

1. **Projekte:** Hetzner Console → zwei neue Projekte anlegen:
   - **„Rent-Base Backup“** für den Bucket und den Admin-Schlüssel
   - **„Rent-Base Backup-Writer“** nur für den Schreibschlüssel
2. **Schlüssel anlegen:**
   - Im Projekt „Rent-Base Backup“ → Sicherheit → S3-Zugangsdaten → **Admin-Schlüssel**. Nur im Passwortmanager ablegen, **nie** in Coolify oder auf dem Server.
   - Im Projekt „Rent-Base Backup-Writer“ → **Schreibschlüssel**. Auch im Passwortmanager ablegen.
   - Die Projekt-ID des Writer-Projekts notieren. Sie wird für die Bucket-Policy gebraucht.
3. **Test-Bucket** im Backup-Projekt anlegen:
   - Standort **fsn1**, Name z. B. `rent-base-backup-test`, **Object Lock: aktiviert**.
   - Mit Compliance-Frist **1 Tag**, Lifecycle und Policy wie unten (Schritt 2), nur mit dem Test-Bucket-Namen.
   - Dann die sechs Punkte aus [backup-strategie.md](backup-strategie.md), „Vor dem produktiven Einsatz“, abarbeiten und das Ergebnis im Protokoll unten festhalten.
   - Danach den Test-Bucket löschen, sobald seine Frist abgelaufen ist.

### 2. Produktiver Backup-Bucket (erst nach bestandenem Test)

1. Im Projekt „Rent-Base Backup“ den Bucket `rent-base-backup` anlegen: Standort **fsn1**, privat, **Object Lock: aktiviert**. Das geht nur beim Anlegen.
2. Auf dem eigenen Rechner mit dem **Admin-Schlüssel** (AWS CLI, `--endpoint-url https://fsn1.your-objectstorage.com`) einrichten:

   ```bash
   # Standard-Frist: jede Version 30 Tage unlöschbar (Compliance)
   aws s3api put-object-lock-configuration --bucket rent-base-backup --endpoint-url https://fsn1.your-objectstorage.com \
     --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":30}}}'

   aws s3api put-bucket-lifecycle-configuration --bucket rent-base-backup --endpoint-url https://fsn1.your-objectstorage.com \
     --lifecycle-configuration file://lifecycle.json

   aws s3api put-bucket-policy --bucket rent-base-backup --endpoint-url https://fsn1.your-objectstorage.com \
     --policy file://policy.json
   ```

   **`lifecycle.json`:** Das Präfix der Coolify-Dumps nach dem ersten Datenbank-Backup ablesen und dann eintragen.

   ```json
   {
     "Rules": [
       { "ID": "dateien-alte-versionen", "Status": "Enabled", "Filter": { "Prefix": "files/" },
         "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }, "Expiration": { "ExpiredObjectDeleteMarker": true } },
       { "ID": "merkliste", "Status": "Enabled", "Filter": { "Prefix": "files-state/" },
         "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
       { "ID": "datenbank-dumps", "Status": "Enabled", "Filter": { "Prefix": "<PRAEFIX-DER-COOLIFY-DUMPS>" },
         "Expiration": { "Days": 31 }, "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
       { "ID": "abgebrochene-uploads", "Status": "Enabled", "Filter": { "Prefix": "" },
         "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 } }
     ]
   }
   ```

   **`policy.json`:** Der Platzhalter `p<WRITER-PROJEKT-ID>:<WRITER-ACCESS-KEY>` hat das von Hetzner dokumentierte Format. In die Datei gehört nur die Access-Key-ID, nie der Secret Key.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "SchreibschluesselDarf", "Effect": "Allow",
         "Principal": { "AWS": ["arn:aws:iam:::user/p<WRITER-PROJEKT-ID>:<WRITER-ACCESS-KEY>"] },
         "Action": ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:DeleteObject", "s3:ListBucket",
                    "s3:GetBucketLocation", "s3:GetBucketObjectLockConfiguration"],
         "Resource": ["arn:aws:s3:::rent-base-backup", "arn:aws:s3:::rent-base-backup/*"] },
       { "Sid": "SchreibschluesselDarfNie", "Effect": "Deny",
         "Principal": { "AWS": ["arn:aws:iam:::user/p<WRITER-PROJEKT-ID>:<WRITER-ACCESS-KEY>"] },
         "Action": ["s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention",
                    "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutLifecycleConfiguration",
                    "s3:PutBucketVersioning", "s3:PutBucketObjectLockConfiguration"],
         "Resource": ["arn:aws:s3:::rent-base-backup", "arn:aws:s3:::rent-base-backup/*"] }
     ]
   }
   ```

   Beide Dateien sind **Vorlagen**. Ob Hetzner jede Aktion genau so durchsetzt, zeigt erst der Test-Bucket.

### 3. Datenbank-Backup in Coolify

Die Bezeichnungen stammen aus Coolify v4.4.3.

1. Seitenleiste → **S3 Storage** → „New storage“:
   - Name „Hetzner Backup fsn1“
   - Host `fsn1.your-objectstorage.com` (https)
   - Bucket `rent-base-backup`, Region `fsn1`
   - **Schreibschlüssel** (nicht der Admin-Schlüssel)

   Dann „Validate Connection & Continue“.
2. PostgreSQL-Ressource `rent-base-db` → **Backups** → „+ Add“:
   - **General:**
     - Frequency `0 2,8,14,20 * * *`
     - Timezone UTC
     - „Missing backup alert after“ 8 Stunden
   - **S3 storage:** „Enable S3“ an, S3 Storage aus Schritt 1. „Local copy“ an.
   - **Retention:**
     - lokal „Backups to keep“ 8
     - S3 „Days to keep“ 30
   - **Datenbank:** Unter den zu sichernden Datenbanken steht der Datenbankname aus `DATABASE_URL` der App, also der Teil nach dem letzten `/`.
3. „Backup Now“ auslösen und prüfen, ob die Datei im Bucket angekommen ist. Ihr Präfix in `lifecycle.json` eintragen und die Lifecycle-Regel erneut setzen.

### 4. Dateisicherung als Scheduled Task

Voraussetzung: Die App ist mit einer Version deployt, die die Skripte enthält.

1. **Anwendung → Environment Variables:** mit dem **Schreibschlüssel** ergänzen. Build time jeweils „Not available during build“, Runtime „Available at runtime“. Danach neu deployen.
   ```
   BACKUP_S3_ENDPOINT=https://fsn1.your-objectstorage.com
   BACKUP_S3_REGION=fsn1
   BACKUP_S3_BUCKET=rent-base-backup
   BACKUP_S3_ACCESS_KEY=…
   BACKUP_S3_SECRET_KEY=…
   BACKUP_GRACE_DAYS=7
   ```
   Der Task läuft per `docker exec` im App-Container. Er sieht deshalb nur Laufzeit-Variablen und nutzt die `DATABASE_URL` der App für die Löschregel.
2. **Anwendung → Scheduled Tasks → „New scheduled task“:**
   - Name „Dateien sichern“
   - Command `node scripts/backup-files.mjs`
   - Schedule `30 2,8,14,20 * * *`
   - Timeout `3600`
   - Container leer lassen
3. **Einmal von Hand ausführen.** Erwartet werden Zeilen wie:
   ```
   812 kopiert (950.3 MB), 0 waren schon vorhanden, 0 Fehler, 0 Abweichungen.
   0 legitim gelöschte Dateien (0 neu), 0 nach 7 Tagen aus dem Backup entfernt; 0 geschützte Dateien fehlen im App-Bucket.
   ```

**So arbeitet das Skript:**

- **Kopieren:** Jede neue Datei wird mit ihrer SHA-256-Prüfsumme als Metadatum ins Backup kopiert.
- **Nie überschreiben:** Eine Datei, die schon im Backup liegt, wird nie überschrieben. Hat sie im App-Bucket plötzlich eine andere Größe, bleibt die gesicherte Fassung, und der Task meldet einen Fehler. Ursache kann eine Manipulation mit gestohlenen App-Zugangsdaten sein.
- **Nur legitime Löschungen übernehmen:** Die App löscht persistierte Dateien nur in zwei Fällen, und nur diese verschwinden auch aus dem Backup, nach der Frist `BACKUP_GRACE_DAYS` (mit Object Lock 7 Tage, ohne mindestens 30):
  - Fotos aus Entwürfen. Die Datenbank verweist dann nicht mehr darauf.
  - Führerscheinkopien, die aus Datenschutzgründen gelöscht wurden (`deletionStatus = DELETED`).

  Ob eine Datei noch gebraucht wird, entscheidet die **Datenbank**, nicht der App-Bucket. Die Merkliste liegt unter `files-state/missing.json`.
- **Geschützte Dateien:** Verträge, Protokolle, Rechnungen, Akten, Unterschriften, Logos und alle Fotos, auf die die Datenbank verweist, werden **nie** aus dem Backup gelöscht. Fehlen sie im App-Bucket, meldet der Task bei jedem Lauf einen Fehler, bis sie mit `--restore` zurückgeholt sind.
- **Ohne Datenbank kein Löschen:** Ist die Datenbank nicht erreichbar, wird nichts gelöscht, und der Task meldet einen Fehler.
- **Schutzschwelle:** Fehlen auf einmal ungewöhnlich viele löschbare Dateien (mehr als 10 % und mehr als 20 Stück), merkt das Skript nichts vor, löscht nichts und meldet einen Fehler.
- **App-Bucket:** Dort wird nie etwas gelöscht oder überschrieben.

### 4a. Aufräumlauf für gelöschte Ausweis- und Führerscheinkopien

Die App entfernt die Datei einer gelöschten Kopie direkt nach dem Löschen (beim Storno nach dem Commit, mit drei Versuchen;
Fehlschläge stehen im Audit-Log als „Datei nach dem Storno nicht entfernt“). Bricht der Prozess genau dazwischen ab oder ist der
Speicher nicht erreichbar, bleibt die Datei im App-Bucket liegen, obwohl die Kopie in der Datenbank schon gelöscht ist.
`scripts/cleanup-driver-copies.mjs` holt das nach und richtet sich dabei ausschließlich nach der Datenbank:

- berücksichtigt nur Kopien mit `deletionStatus = DELETED`, je Mandant;
- löscht nur Schlüssel im Kopienbereich desselben Mandanten (`t/<Mandant>/driver-verifications/…`), nie Dateien aktiver Kopien
  und nie etwas außerhalb dieses Bereichs (solche Fälle werden als „verweigert“ gemeldet);
- listet je Mandant einmal auf, löscht nur, was noch da ist, und bestätigt das Löschen durch erneutes Auflisten;
- schreibt jeden Fehlschlag ins Audit-Log (`STORAGE_FILE_REMOVAL_FAILED`, Benutzer „Aufräumlauf“) und endet dann mit Code 1;
  ein erneuter Lauf ist unschädlich.

**Einrichtung (noch nicht erfolgt):** Anwendung → Scheduled Tasks → „New scheduled task“:
- Name „Gelöschte Dokumentkopien aufräumen“
- Command `node scripts/cleanup-driver-copies.mjs`
- Schedule `15 2,8,14,20 * * *` (eine Viertelstunde vor der Dateisicherung: gelöschte Kopien gelangen so gar nicht erst ins Backup)
- Timeout `600`, Container leer lassen

Vorher einmal von Hand mit `--dry-run` ausführen (nur Bericht). Erwartet wird z. B.
`1 Mandanten, 2 gelöschte Kopien geprüft: 0 würden entfernt, 2 bereits entfernt, 0 verweigert, 0 Fehler.`
Einzelner Mandant: `--tenant <id>`.

### 5. Benachrichtigungen

Seitenleiste → **Notifications** → einen Kanal einrichten und testen. Diese Ereignisse einschalten:
- „Backup failure“
- „Scheduled task failure“
- „Deployment failure“
- „Disk usage warning“
- „Server unreachable“

**Ohne aktiven Kanal bleiben fehlgeschlagene Backups unbemerkt.** Die Backup-Jobs deshalb erst aktivieren, wenn der Kanal läuft.

### 6. Zugangsdaten außerhalb des Servers aufbewahren

**Gehört in den Passwortmanager:**
- alle Umgebungsvariablen der App: `DATABASE_URL`, `APP_URL`, `SETUP_KEY`, `RENTBASE_SECRET_KEY`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `S3_*`, `BACKUP_S3_*`, `SMTP_*`
- **der Admin-Schlüssel des Backup-Projekts**, der **nur** dort liegt

**`RENTBASE_SECRET_KEY`:** Er verschlüsselt die SMTP-Passwörter der Mandanten. Ohne ihn sind sie auch aus einem Backup nicht wiederherstellbar.

## Wiederherstellungstest (nachprüfbar)

**Wann:** vor dem ersten externen Vermieter, danach jedes Quartal und nach größeren Änderungen an Datenbank oder Speicher. Ein Test gilt nur als bestanden, wenn **alle** Abnahmekriterien erfüllt und im Protokoll belegt sind.

**Ablauf:**

1. **Start notieren:** Datum, Uhrzeit, wer prüft.
2. **Backup auswählen:** das neueste Datenbank-Backup in Coolify (Backups → Executions). **Objektname und Zeitpunkt** notieren, zusätzlich die **Versions-ID** aus der Hetzner Console oder `aws s3api list-object-versions`.
3. **Testdatenbank:**
   - In Coolify im selben Projekt eine neue PostgreSQL-Datenbank `rent-base-restore-test` anlegen, **gleiche Version wie live**, laut Bestandsaufnahme vom 09.10.2026 PostgreSQL 18.6. Starten.
   - Configuration → **Import Backup** → aus S3 → das notierte Backup.
   - **Dauer des Imports messen.**
4. **Prüfskript:** App → Terminal:
   ```
   RESTORE_DATABASE_URL="postgres://…intern…/…" node scripts/check-restore.mjs
   ```
   Die **vollständige Ausgabe** ins Protokoll kopieren. Sie enthält nur Zählwerte, Speicherschlüssel und Prüfergebnisse, keine Kundendaten.
5. **Abnahmekriterien:**
   - [ ] `Ergebnis: bestanden` (0 Fehler)
   - [ ] Migrationen vollständig oder nur die Warnung „Backup älter als diese Migrationen“ mit erklärbarem Deploy dazwischen
   - [ ] Neuester Datensatz im Backup höchstens 6 Stunden älter als live
   - [ ] Alle referenzierten Dateien liegen im Backup, die Stichprobe der Prüfsummen stimmt
   - [ ] Sortierregel OK (UTF-8 wie live). Unter der Regel „C“ findet die Suche Umlaute nicht ohne Groß-/Kleinschreibung; die Testdatenbank dann mit UTF-8-Regel neu anlegen
   - [ ] Import innerhalb von 30 Minuten (Ziel, beim ersten Test überprüfen)
6. **Aufräumen:** `rent-base-restore-test` in Coolify **löschen**, denn sie enthält alle Kundendaten. Die Löschung im Protokoll vermerken.
7. **Einmalig bei der Einrichtung, am Test-Bucket:** „Alte Version zurückholen“ (siehe unten) üben. Dabei die zurückgeholte Datei per SHA-256 gegen die Prüfsumme aus der Datenbank vergleichen.

## Im Ernstfall

### Datenbank beschädigt oder Daten falsch verändert

Nicht über die laufende Datenbank zurückspielen, sondern daneben:
1. Wie beim Wiederherstellungstest eine neue Datenbank anlegen und das Backup von **vor** dem Vorfall importieren.
2. Mit `scripts/check-restore.mjs` prüfen.
3. `DATABASE_URL` der App umstellen und neu deployen.
4. Die alte Datenbank erst löschen, wenn klar ist, was passiert ist.

Alles nach dem gewählten Backup fehlt danach, das sind höchstens 6 Stunden. Seither gelöschte personenbezogene Daten erneut löschen (Löschprotokoll).

### Dateien fehlen im App-Bucket

App → Terminal: `node scripts/backup-files.mjs --restore`. Das kopiert alle fehlenden Dateien zurück und überschreibt nichts.

Ist der App-Bucket ganz verloren: neuen Bucket anlegen, `S3_*` umstellen, deployen, dann `--restore` ausführen.

### Alte Version zurückholen (überschrieben oder gelöscht)

Mit dem **Admin-Schlüssel**, auf dem eigenen Rechner, nicht auf dem Server:

```bash
EP=https://fsn1.your-objectstorage.com
aws s3api list-object-versions --bucket rent-base-backup --prefix "files/t/<mandant>/documents/…" --endpoint-url $EP
aws s3api get-object --bucket rent-base-backup --key "<schlüssel>" --version-id "<VersionId>" pruef.pdf --endpoint-url $EP
sha256sum pruef.pdf   # muss zur Prüfsumme in der Datenbank passen (Document.checksum bzw. Photo.checksum)

# die gute Version wieder zur aktuellen machen, danach mit --restore in den App-Bucket holen
aws s3api copy-object --bucket rent-base-backup --key "<schlüssel>" \
  --copy-source "rent-base-backup/<schlüssel>?versionId=<VersionId>" --endpoint-url $EP
```

Alte Versionen bleiben 30 Tage ab dem Hochladen gesperrt und mindestens 7 Tage nach dem Überschreiben bzw. dem Löschmarker erhalten.

### Verdacht auf gestohlene Zugangsdaten

Abweichungsmeldungen der Dateisicherung **sofort** ernst nehmen.

| Betroffen | Sofortmaßnahme | Danach |
|---|---|---|
| App-Schlüssel (`S3_*`) | in Hetzner (Projekt „Rent-Base“) löschen und neu anlegen, in Coolify eintragen, neu deployen | Dateisicherung laufen lassen, Abweichungen und fehlende Dateien prüfen, mit `--restore` bzw. „Alte Version zurückholen“ beheben |
| Schreibschlüssel | im Writer-Projekt löschen, neuen anlegen, Policy, Coolify S3 Storage und `BACKUP_S3_*` umstellen | mit dem Admin-Schlüssel `list-object-versions` auf Löschmarker und neue Versionen seit dem Vorfall prüfen, gute Versionen zurückholen |
| Admin-Schlüssel | sofort löschen und neu anlegen | Lock-Konfiguration, Lifecycle und Policy kontrollieren. Compliance-gesperrte Versionen sind auch damit nicht löschbar. |
| Server oder Coolify | alle Schlüssel und Passwörter wechseln, Server neu aufsetzen | aus Backups wiederherstellen (siehe oben), Ursache klären |

### Server verloren

1. **Mit Hetzner-Backup:** Server → Backups → neueste Sicherung wiederherstellen. Startet die Datenbank nicht sauber, aus dem Coolify-Backup zurückspielen.
2. **Ohne Hetzner-Backup:**
   1. Neuen Server anlegen und Coolify installieren.
   2. Die App aus GitHub anlegen und die Variablen aus dem Passwortmanager eintragen.
   3. Eine neue PostgreSQL 18.6 anlegen und das neueste Backup importieren.

   Die Dateien liegen weiter im App-Bucket. Fehlt dort etwas, `--restore` ausführen.

## Offene Punkte

- **Test-Bucket:** Alle sechs Prüfpunkte stehen noch aus, insbesondere Durchsetzung von Sperre und Policy in fsn1 sowie die Kompatibilität mit Coolify.
- **Löschkonzept (DSGVO):** Die Backup-Fristen aus [backup-strategie.md](backup-strategie.md) aufnehmen und rechtlich bestätigen lassen. Für Datensätze selbst (Kunden, Verträge) gibt es in der App noch keine Löschfristen. Die Aufbewahrungspflichten gelten.
- **Versionierung des App-Buckets prüfen:** Ist sie eingeschaltet, entfernt ein Löschen nur die aktuelle Fassung; ältere
  Fassungen (z. B. von Ausweiskopien) bleiben, bis eine Lifecycle-Regel für nicht aktuelle Versionen sie entfernt. In der
  Hetzner Console nachsehen und gegebenenfalls eine kurze Frist für nicht aktuelle Versionen festlegen.
- **Manipulation mit gleicher Dateigröße im App-Bucket:** Das erkennt die Dateisicherung nicht sofort. Die gesicherte Fassung bleibt aber unverändert, und die Stichprobe beim Wiederherstellungstest prüft den Inhalt.

## Protokoll

| Datum | Art (Test-Bucket / Wiederherstellung) | Backup (Objekt, Zeitpunkt, Version) | Dauer Import | Ergebnis `check-restore` | Testdatenbank gelöscht | Geprüft von | Auffälligkeiten |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

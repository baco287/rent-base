# Backups und Wiederherstellung

Rent-Base speichert Verträge, Unterschriften, Übergabeprotokolle und Fotos, die nicht verloren gehen dürfen.
Gesichert wird deshalb an drei Stellen, jede Nacht in fester Reihenfolge (Zeiten in UTC):

| Was | Womit | Wann | Wohin | Aufbewahrung |
|---|---|---|---|---|
| Datenbank | Coolify-Backup (`pg_dump`) | 02:00 | Backup-Bucket (Falkenstein) und lokal auf dem Server | S3: 30 Tage, lokal: 7 Stück |
| Fotos, Dokumente, Logos | `scripts/backup-files.mjs` als Scheduled Task | 02:15 | Backup-Bucket unter `files/` | solange die Datei in der App existiert, danach noch 30 Tage |
| Ganzer Server | Hetzner Backup | ca. 02:48 | bei Hetzner, am Server | 7 Tage |

Die Reihenfolge ist Absicht:

- Die Dateisicherung läuft nach dem Datenbank-Backup. Damit liegt jede Datei, die die Sicherung der Datenbank kennt, auch im Backup-Bucket.
- Das Hetzner-Abbild entsteht danach. So enthält es zusätzlich eine fertige, konsistente Sicherung der Datenbank. Die laufende Datenbank im Abbild selbst ist nicht verlässlich konsistent.

Der Backup-Bucket liegt in einem **eigenen Hetzner-Projekt** und an einem **anderen Standort** als der App-Bucket (`nbg1`).

- **Eigenes Projekt:** Hetzner-Zugangsdaten gelten für alle Buckets ihres Projekts. Geraten die Zugangsdaten der App nach draußen, kommt man damit nicht an die Backups.
- **Anderer Standort:** Fällt ein Rechenzentrum aus, sind nicht App-Dateien und Backup zugleich weg.

## Einmalige Einrichtung

### 1. Backup-Projekt und Bucket bei Hetzner

1. Hetzner Console → neues Projekt „Rent-Base Backup“.
2. Im neuen Projekt → Object Storage → Bucket erstellen: Standort **Falkenstein (fsn1)**, Name z. B. `rent-base-backup`, privat. Ohne Versionierung und ohne Object Lock: Sonst blieben Dateien, die nach der Frist aus Datenschutzgründen gelöscht werden, als alte Versionen erhalten.
3. Im neuen Projekt → Sicherheit → S3-Zugangsdaten erstellen. Den Secret Key sofort im Passwortmanager ablegen, er wird nur einmal angezeigt.

### 2. Datenbank-Backup in Coolify

Die Bezeichnungen stammen aus Coolify v4.4.3. Ältere Versionen beschriften manches anders.

1. Seitenleiste → **S3 Storage** → „New storage“:
   - Name „Hetzner Backup fsn1“
   - Endpoint/Host `fsn1.your-objectstorage.com` (Protokoll https)
   - Bucket `rent-base-backup`
   - Region `fsn1`
   - Access Key und Secret Key aus Schritt 1

   „Validate Connection & Continue“. Coolify prüft dabei, ob der Bucket erreichbar ist. Der Bucket muss also schon existieren.
2. PostgreSQL-Ressource → **Backups** → „+ Add“ und den neuen Eintrag öffnen:
   - **General:**
     - Frequency `0 2 * * *`.
     - Timezone UTC, das Backup muss vor 02:48 UTC fertig sein.
     - „Missing backup alert after“ setzen, zum Beispiel 26 Stunden.
   - **S3 storage:** „Enable S3“ einschalten und den S3 Storage aus Schritt 1 wählen. „Local copy“ bleibt an.
   - **Retention:**
     - lokal „Backups to keep“ 7
     - S3 „Days to keep“ 30
   - **Datenbank:** Unter den zu sichernden Datenbanken muss der Datenbankname aus `DATABASE_URL` der App stehen, also der Teil nach dem letzten `/`.
3. Einmal „Backup Now“ auslösen und in der Hetzner Console prüfen, ob im Bucket eine Datei angekommen ist.

### 3. Dateisicherung als Scheduled Task

Voraussetzung: Die App ist mit einer Version deployt, die `scripts/backup-files.mjs` enthält.

1. Anwendung → **Environment Variables** → diese fünf Werte ergänzen, jeweils mit Build time „Not available during build“ und Runtime „Available at runtime“. Danach neu deployen.
   ```
   BACKUP_S3_ENDPOINT=https://fsn1.your-objectstorage.com
   BACKUP_S3_REGION=fsn1
   BACKUP_S3_BUCKET=rent-base-backup
   BACKUP_S3_ACCESS_KEY=…
   BACKUP_S3_SECRET_KEY=…
   ```
   Der Scheduled Task läuft per `docker exec` im laufenden App-Container und sieht deshalb nur die Laufzeit-Variablen.
2. Anwendung → **Scheduled Tasks** → „New scheduled task“:
   - Name „Dateien sichern“
   - Command `node scripts/backup-files.mjs`
   - Schedule `15 2 * * *`
   - Timeout (seconds) `3600`. Die Voreinstellung von 300 Sekunden reicht für den ersten, vollständigen Lauf nicht.
   - Container leer lassen. Es gibt nur einen.
3. Einmal von Hand ausführen und das Log prüfen. Erwartet werden Zeilen wie
   ```
   812 kopiert (950.3 MB), 0 waren schon vorhanden, 0 Fehler.
   0 gesicherte Dateien fehlen in der App (0 neu), 0 nach 30 Tagen aus dem Backup entfernt.
   ```
   Der erste Lauf kopiert alles und dauert entsprechend länger, danach nur noch die neuen Dateien.

**So arbeitet das Skript:**

- **Kopieren:** Es kopiert jede neue Datei mit ihrer SHA-256-Prüfsumme als Metadatum.
- **Löschungen übernehmen:** Die App löscht manche Dateien bewusst, etwa Führerscheinkopien aus Datenschutzgründen oder verworfene Entwurfsfotos. Das Skript merkt sich, seit wann eine gesicherte Datei in der App fehlt, und entfernt sie erst **30 Tage** später auch aus dem Backup.
  - Innerhalb dieser Frist kann ein Datenbank-Backup die Datei noch brauchen, danach gibt es keines mehr.
  - Die Merkliste liegt unter `files-state/missing.json`.
  - Die Frist ist über `BACKUP_GRACE_DAYS` einstellbar, mindestens 7 Tage.
- **Schutzschwelle:** Fehlen auf einmal ungewöhnlich viele Dateien (mehr als 10 % und mehr als 20 Stück, zum Beispiel bei falschem Bucket oder einem Angriff), merkt das Skript nichts vor, löscht nichts und meldet einen Fehler.
- **Fehler:** Kann etwas nicht kopiert oder entfernt werden, endet der Task mit Fehler.
- **App-Bucket:** Dort wird nie etwas gelöscht oder überschrieben.

### 4. Benachrichtigungen

Seitenleiste → **Notifications** (gilt für das ganze Team) → einen Kanal einrichten: Email, Telegram, Discord, Slack, Pushover oder Webhook. Mindestens diese Ereignisse einschalten:

- „Backup failure“
- „Scheduled task failure“
- „Deployment failure“
- „Disk usage warning“
- „Server unreachable“

Die Schwelle für die Festplatte steht unter Server → **Advanced** → „Notification threshold“ (%), zum Beispiel 80.

### 5. Zugangsdaten außerhalb des Servers aufbewahren

Alle Umgebungsvariablen der App gehören zusätzlich in den Passwortmanager: `DATABASE_URL`, `APP_URL`, `SETUP_KEY`, `RENTBASE_SECRET_KEY`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `S3_*`, `BACKUP_S3_*`, `SMTP_*`. Ist der Server weg, sind sie sonst auch weg.

`RENTBASE_SECRET_KEY` ist dabei besonders wichtig: Damit sind die SMTP-Passwörter der Mandanten verschlüsselt. Ohne ihn lassen sich diese Passwörter auch aus einem Datenbank-Backup nicht wiederherstellen.

## Wiederherstellungstest

Erstmals direkt nach der Einrichtung, danach jedes Quartal. Ein nie getestetes Backup ist nur eine Hoffnung.

1. In Coolify im selben Projekt eine neue PostgreSQL-Datenbank anlegen: gleiche Version wie die Live-Datenbank, Name `rent-base-restore-test`. Starten.
2. Testdatenbank → Configuration → **Import Backup** → aus S3 → die neueste Sicherung wählen → importieren.
3. Die interne Verbindungsadresse der Testdatenbank kopieren („Postgres URL (internal)“).
4. App → **Terminal** und dort ausführen:
   ```
   RESTORE_DATABASE_URL="postgres://…" node scripts/check-restore.mjs
   ```
5. Erwartet wird `Ergebnis: bestanden`. Das Skript liest nur und prüft:
   - ob alle Migrationen da sind,
   - die Anzahl der Datensätze je Tabelle im Vergleich zu live,
   - wie alt der neueste Datensatz ist,
   - ob jede Datei, auf die die Sicherung verweist, im Backup-Bucket liegt, mit richtiger Größe. Geprüft werden:
     - Fotos und Dokumente
     - Schaden-, Fahrzeug-, Behörden- und Unfallersatzakten
     - Führerscheinkopien, außer gelöschten
     - Logos

     Unterschriften liegen bisher in der Datenbank.
   - bei einer Stichprobe von 5 Dateien den Inhalt gegen die Prüfsumme aus der Datenbank.

   Eine Warnung „Das Backup ist älter als diese Migrationen“ ist normal, wenn nach dem Backup ein Deploy mit neuer Migration lief.
6. **Testdatenbank in Coolify wieder löschen.** Sie enthält eine vollständige Kopie der Kundendaten.
7. Ergebnis unten im Protokoll eintragen.

## Im Ernstfall

### Datenbank beschädigt oder Daten falsch verändert

Nicht über die laufende Datenbank zurückspielen, sondern daneben:

1. Wie beim Wiederherstellungstest eine neue Datenbank anlegen und die Sicherung von **vor** dem Vorfall importieren.
2. Mit `scripts/check-restore.mjs` prüfen.
3. `DATABASE_URL` der App auf die neue Datenbank umstellen und neu deployen.
4. Die alte Datenbank erst löschen, wenn klar ist, was passiert ist.

Alles, was nach dem gewählten Backup erfasst wurde, fehlt danach und muss nacherfasst werden.

### Dateien fehlen im App-Bucket

App → Terminal:
```
node scripts/backup-files.mjs --restore
```
Das kopiert alle fehlenden Dateien aus dem Backup zurück und überschreibt nichts.

Ist der App-Bucket ganz verloren: einen neuen Bucket anlegen, `S3_*` der App darauf umstellen, deployen und dann `--restore` ausführen.

### Server verloren

1. **Mit Hetzner-Backup:** Hetzner Console → Server → Backups → neueste Sicherung wiederherstellen. Startet die Datenbank danach nicht sauber, wie oben aus dem Coolify-Backup zurückspielen.
2. **Ohne Hetzner-Backup** (zum Beispiel weil der Server gelöscht wurde):
   1. Neuen Server anlegen und Coolify installieren.
   2. Die App aus GitHub neu anlegen und die Umgebungsvariablen aus dem Passwortmanager eintragen.
   3. Eine neue PostgreSQL-Datenbank anlegen, das neueste Backup aus S3 importieren und `DATABASE_URL` darauf setzen.

   Die Dateien liegen weiterhin im App-Bucket. Fehlt dort etwas, wie oben `--restore` ausführen.

## Offene Punkte

- **Löschkonzept für Kundendaten (DSGVO):** In der App gelöschte Dateien verschwinden nach 30 Tagen auch aus dem Backup, Datenbank-Backups nach 30 Tagen. Für Datensätze selbst (Kunden, Verträge) gibt es noch keine Löschfristen in der App. Die gesetzlichen Aufbewahrungspflichten für Verträge und Rechnungen muss das Löschkonzept berücksichtigen.
- **Hetzner-Server-Backups** enthalten ebenfalls Kundendaten und gelten 7 Tage.

## Protokoll der Wiederherstellungstests

| Datum | Backup vom | Ergebnis | Geprüft von |
|---|---|---|---|
| | | | |

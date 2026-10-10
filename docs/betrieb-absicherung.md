# Absicherung der Produktion – Stand 10.10.2026

Grundlage: lesende Bestandsaufnahme vom 10.10.2026 (Server, Coolify 4.4.6, App-Bucket, Erreichbarkeit). In der Produktion
wurde dabei **nichts verändert**. Dieses Dokument enthält keine geheimen Werte und darf auch keine bekommen.

## Ergebnis der Freigabe vom 10.10.2026

| # | Maßnahme | Stand | Warum |
|---|---|---|---|
| 1 | Benachrichtigungen per E-Mail | **vorbereitet, Eingabe durch dich** | Die SMTP-Zugangsdaten muss eine Person eintragen; Claude gibt keine Passwörter in Formulare ein |
| 2 | Hetzner-Serverbackups und Cloud-Firewall | **von außen geprüft, Rest per Console** | Kein Hetzner-API-Token vorhanden; Firewall-Wirkung von außen bestätigt |
| 3 | Externe Überwachung von `/api/health` | **vorbereitet, Entscheidung nötig** | Braucht ein Konto bei einem Dienst |
| 4 | Test-Bucket für die Backup-Strategie | **nicht angelegt, Entscheidung nötig** | Mit den vorhandenen Rechten nur im Produktionsprojekt mit dem App-Schlüssel möglich – nicht isoliert |
| 5 | Checkliste Offline-Aufbewahrung | **erstellt** (unten) | – |
| 6 | Nächster Schritt produktive Backups | **beschrieben** (unten) | – |

---

## 1. Benachrichtigungen per E-Mail (vorhandener SMTP-Anbieter)

Geprüft: Der Server erreicht den SMTP-Server der App (`w0216162.kasserver.com`, all-inkl) auf **Port 587**; 465 und 25 sind
bei Hetzner gesperrt. Absender `noreply@rent-base.de` wird von der App bereits erfolgreich genutzt.

**Coolify → Notifications → Email** (Pfad laut Coolify-Doku; Beschriftungen können je Version leicht abweichen):

1. **Email service:** „Use team email settings“.
2. **From name:** z. B. „RentBase Betrieb“ · **From address:** `noreply@rent-base.de`.
3. **SMTP server:**
   - Host `w0216162.kasserver.com`
   - Port `587`
   - Encryption **StartTLS**
   - Benutzername und Passwort wie bei der App: Coolify → Anwendung `rent-base` → Environment Variables → `SMTP_USER` / `SMTP_PASSWORD`. Direkt kopieren und einfügen, nirgends sonst ablegen.
   - Timeout leer lassen.
   - **Save changes**.
4. **SMTP delivery:** Enabled → **Save changes**.
5. **Empfänger:** Falls ein Feld „Recipients“ angezeigt wird, eine Betriebsadresse eintragen, die regelmäßig gelesen wird. Sonst nutzt Coolify die Adressen der Team-Mitglieder; das Profil prüfen.
6. **Notification events** einschalten:

   | Ereignis | Empfehlung |
   |---|---|
   | Deployment Failure | an |
   | Backup Failure | an |
   | Scheduled Task Failure | an |
   | Server Unreachable / Reachable | an |
   | Server Disk Usage | an |
   | Restart limit reached | an, falls angeboten |
   | Container Status Changes | an (meldet, wenn die App stoppt oder neu startet) |
   | Erfolgsmeldungen (Deployment/Backup/Task Success) | aus, sonst wird es zu viel. Backup Success nur in den ersten Tagen, um die ersten Läufe zu sehen |

7. **Send test** → an die eigene Adresse senden → Posteingang **und Spam-Ordner** prüfen.

Danach prüfe ich lesend, dass Kanal und Ereignisse in Coolify gespeichert sind. Ohne gültigen Kanal ist jedes Ereignis
wirkungslos. Ausweg ohne E-Mail: In Coolify unter den Instanzeinstellungen gibt es eine Liste „Scheduled Jobs failures“.

## 2. Hetzner-Serverbackups und Cloud-Firewall

**Von außen geprüft (10.10.2026):**
- Erreichbar sind 22, 80 und 443.
- Die internen Coolify-Ports 8000, 8080, 6001 und 6002 lauschen auf dem Server, sind aber von außen **gefiltert**. Eine Hetzner-Cloud-Firewall ist also sehr wahrscheinlich aktiv.
- Auf dem Server selbst ist keine Firewall aktiv (ufw aus).

**In der Hetzner Console prüfen** (Projekt „Rent-Base“, Server `rent-base`, ID 166146267, nbg1-dc3) und mir die Ergebnisse
nennen oder Screenshots ohne Zugangsdaten schicken:

| Wo | Was prüfen |
|---|---|
| Server → **Backups** | Aktiviert? Uhrzeit des Backup-Fensters, Anzahl und Datum der vorhandenen Backups (erwartet: 7, täglich) |
| Server → **Snapshots** | Vorhandene Snapshots (Anzahl, Datum) |
| Server → **Firewalls** | Welche Firewall ist zugewiesen? |
| **Firewalls** → diese Firewall → Regeln | Eingehend nur 22, 80, 443 (und ggf. ICMP)? Ist 22 auf bestimmte IP-Adressen beschränkt? Keine Regel für 8000/8080/6001/6002? Ausgehend: Standard (alles erlaubt) oder eingeschränkt? |
| Server → **Protection** | Lösch- und Rebuild-Schutz an? (Empfehlung: an) |
| **Object Storage** → Buckets | Welche Buckets existieren (erwartet: nur `rent-base-files` in fsn1)? |
| **Object Storage** → Zugangsschlüssel | Anzahl und Bezeichnung der S3-Schlüssel; nicht mehr genutzte notieren (später widerrufen) |
| **Security → API Tokens** | Vorhandene Tokens (sollten keine nötig sein) |
| Konto → **Zwei-Faktor-Authentisierung** | Für jedes Konto mit Zugriff aktiv? Wiederherstellungscodes offline (siehe Abschnitt 5) |
| Projekt → **Mitglieder** | Wer hat Zugriff, mit welcher Rolle? |

Hinweis: Hetzner-Serverbackups sichern das ganze Server-Image, nicht konsistent pro Datenbank. Sie ersetzen keine Datenbank-Dumps,
sind aber der schnellste Rückweg bei einem kaputten Server.

## 3. Externe Überwachung von `https://app.rent-base.de/api/health`

`/api/health` antwortet `200 {"status":"ok","db":"ok"}`; ist die Datenbank nicht erreichbar, kommt `503` mit `"db":"error"`.
Die Abfrage enthält keine personenbezogenen Daten.

**Einstellungen für den Monitor** (bei jedem Dienst gleich):
- **Anfrage:** HTTP(S) `GET https://app.rent-base.de/api/health`.
- **Erwartet:** Status 200 **und** der Antworttext enthält `"db":"ok"`.
- **Prüfintervall:** 1 bis 3 Minuten, Timeout 10 Sekunden.
- **Alarm:** nach 2 Fehlschlägen in Folge, per E-Mail an die Betriebsadresse, optional per App-Push.
- **Zertifikat:** Warnung 14 Tage vor Ablauf. Aktuell gültig bis 16.12.2026; die Verlängerung erfolgt automatisch.
- **Zweiter Monitor:** `https://rent-base.de/` (Website, Status 200).

**Dienst – deine Entscheidung (es entsteht ein Konto):**

| Dienst | Kosten | Hinweis |
|---|---|---|
| Better Stack (Uptime) | kostenloser Einstieg | Anbieter in der EU, Prüfintervall im freien Tarif begrenzt |
| UptimeRobot | kostenloser Einstieg | 5-Minuten-Intervall im freien Tarif, US-Anbieter |
| Uptime Kuma, selbst betrieben | eigener kleiner Server nötig | Nie auf demselben Server, sonst fällt die Überwachung mit aus |

Bitte auch die aktuellen Bedingungen und Datenverarbeitung auf der Seite des Anbieters prüfen.

## 4. Test-Bucket für die Backup-Strategie

**Entscheidung 10.10.2026: Option A.** Schritt-für-Schritt-Anleitung und Ablauf: [backup-test-bucket.md](backup-test-bucket.md).
Weitere Entscheidungen: Überwachung zunächst mit UptimeRobot; SMTP in Coolify, Hetzner-Prüfung und Passwortmanager übernimmst du selbst.

**Mit den vorhandenen Rechten** steht nur der S3-Schlüssel der App zur Verfügung (Projekt „Rent-Base“). Ein damit angelegter
Bucket läge im Produktionsprojekt und wäre mit dem Produktionsschlüssel erreichbar, also **nicht isoliert**. Deshalb ist er
noch nicht angelegt.

**Kosten:** Die Grundgebühr des Object Storage fällt laut Hetzner **einmal pro Konto** an, solange mindestens ein Bucket existiert.
Sie wird für `rent-base-files` bereits bezahlt. Ein Test-Bucket mit wenigen Testdateien kostet praktisch nichts zusätzlich.
Ausnahme: Testdateien unter COMPLIANCE-Sperre lassen sich erst nach Ablauf der Sperre löschen. Deshalb nur 1 Tag Sperre im Test.

**Standort:** App-Dateien in fsn1, Server in nbg1, also Backups nach **hel1** (bisherige Planung fsn1 korrigiert).

**Option A (empfohlen, isoliert):**
1. Du legst in der Console ein eigenes Projekt an, z. B. „Rent-Base Backup“ (wie geplant).
2. Darin einen Bucket `rent-base-backup-test` in hel1 mit **Object Lock: Enabled**. Das geht nur beim Anlegen, später nicht mehr.
3. Dazu einen S3-Schlüssel für dieses Projekt.
4. Den Schlüssel legst du **selbst** auf dem Server in einer nur für root lesbaren Datei ab (`/root/backup-test.env`, `chmod 600`, Inhalt `TEST_S3_ACCESS_KEY=…` / `TEST_S3_SECRET_KEY=…`). Niemals in Chat oder Repository.
5. Ich führe danach das Testprotokoll aus. Die Skripte lesen die Datei, ohne die Werte auszugeben.

**Option B (sofort möglich, nicht isoliert):** Test-Bucket im Projekt „Rent-Base“ mit dem App-Schlüssel. Er prüft das Verhalten
von Object Lock, aber nicht die geplante Trennung der Schlüssel. Danach müsste der Bucket wieder gelöscht werden; das geht erst nach Ablauf der Sperre.

**Testprotokoll** (für beide Optionen; Ergebnis je Punkt bestanden/nicht bestanden):

| # | Prüfung | Warum |
|---|---|---|
| 1 | Object Lock aktiv, Versionierung automatisch an und nicht abschaltbar | Hetzner-Doku: Versionierung ist bei Sperre Pflicht |
| 2 | Standard-Sperre **COMPLIANCE 1 Tag** setzen und auslesen | Voraussetzung für unveränderbare Backups |
| 3 | Upload mit und ohne Prüfsumme (Content-MD5 bzw. x-amz-checksum) | Bei Object Lock muss jede Prüfsumme mitgeschickt werden; bei anderen Backup-Werkzeugen scheitert das oft |
| 4 | Löschen und Überschreiben innerhalb der Sperre werden abgelehnt (auch mit dem Projekt-Schlüssel) | Kern des Schutzes gegen gestohlene Schlüssel und Ransomware |
| 5 | Lifecycle-Regel setzen und Wirkung beobachten | Hetzner warnt bei Veeam, dass Lifecycle-Regeln mit Sperre nicht unterstützt werden; davon hängt das Aufräumen alter Backups ab |
| 6 | **Coolify:** Test-Bucket als S3-Speicher eintragen (Schlüssel gibst du in Coolify ein), „Test connection“, ein Datenbank-Backup in den Test-Bucket, danach prüfen, dass die Datei ankommt und was Coolifys eigenes Löschen alter Backups bei aktiver Sperre tut | Kompatibilität mit Coolify; dessen Aufbewahrung muss mindestens so lang sein wie die Sperre |
| 7 | Rücksicherung: Dump aus dem Test-Bucket in eine Test-Datenbank einspielen | Ein Backup zählt erst, wenn die Rücksicherung klappt |
| 8 | Nur Option A: Schreibschlüssel aus einem dritten Projekt per Bucket-Policy (Plan in `backup-strategie.md`) | Trennung der Schlüssel |

Hinweis zu Punkt 6: Ein echtes Datenbank-Backup im Test-Bucket enthält Kundendaten. Daher die kurze Sperre und das Löschen nach Ablauf.

## 5. Checkliste: Offline-Aufbewahrung von Wiederherstellungsschlüsseln und Zugangsdaten

Grundregeln:
- Werte gehören **nur** in einen Passwortmanager mit Notfallzugang für eine zweite Person.
- Zusätzlich eine verschlüsselte Offline-Kopie, z. B. ein verschlüsselter USB-Stick an einem anderen Ort.
- Wiederherstellungscodes zusätzlich auf Papier im verschlossenen Umschlag.
- Nie in Chat, E-Mail, Ticket oder Repository.
- Werte direkt von der Quelle in den Passwortmanager kopieren, z. B. per SSH auf dem Server.

| ☐ | Was | Wo es heute liegt | Wofür beim Wiederherstellen |
|---|---|---|---|
| ☐ | **Coolify `APP_KEY`** | `/data/coolify/source/.env` auf dem Server | Entschlüsselt alle in Coolify gespeicherten Geheimnisse (Variablen, S3-Schlüssel, DB-Passwörter). Ohne ihn ist ein Coolify-Backup wertlos |
| ☐ | Coolify `DB_PASSWORD`, `REDIS_PASSWORD`, `PUSHER_APP_ID/KEY/SECRET` | gleiche Datei | Wiederherstellung von Coolify selbst |
| ☐ | Coolify `ROOT_USER_PASSWORD` | gleiche Datei (Rest der Installation) | Prüfen, ob noch gültig. Nach bestätigtem Admin-Login mit 2FA aus der Datei entfernen (eigene Freigabe) |
| ☐ | Coolify-Admin-Login und 2FA-Wiederherstellungscodes | Passwortmanager / Coolify | Zugang zur Oberfläche |
| ☐ | SSH-Schlüssel für `root@rent-base` (mit Passphrase) | eigenes Gerät | Serverzugang; Ausweg ohne Schlüssel: Hetzner-Console → Rescue/Konsole |
| ☐ | Hetzner-Konto (Login, 2FA-Wiederherstellungscodes) | Passwortmanager | Server, Backups, Firewall, Object Storage |
| ☐ | S3-Schlüssel der App (`rent-base-files`) | Coolify (Variablen der App) | Zugriff auf die Dateien |
| ☐ | Später: Backup-Schreibschlüssel und **Backup-Admin-Schlüssel (nur offline!)** | noch nicht angelegt | Siehe `backup-strategie.md` |
| ☐ | **`RENTBASE_SECRET_KEY`** (und ggf. `RENTBASE_SECRET_KEY_PREVIOUS`) | Coolify (Variablen der App) | Entschlüsselt die gespeicherten SMTP-Passwörter der Mandanten. Ohne ihn sind diese nach einem Restore unbrauchbar |
| ☐ | `SETUP_KEY` | Coolify (Variablen der App) | Schützt die Ersteinrichtung |
| ☐ | Später: `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | noch nicht gesetzt | Gleicher Wert bei jedem Build, sonst brechen offene Formulare |
| ☐ | Passwort der App-Datenbank `rent-base-db` | Coolify (Datenbank-Ressource) | Zugang zur Datenbank, Restore |
| ☐ | SMTP-Konto bei all-inkl und KAS-Login | Passwortmanager | E-Mail-Versand, DNS, Postfächer |
| ☐ | Domain/DNS `rent-base.de` (Registrar-Login, 2FA) | Passwortmanager | Umzug auf neuen Server, Zertifikate |
| ☐ | GitHub-Konto `baco287` (2FA-Codes) und Coolifys Zugriff auf das Repository | Passwortmanager / GitHub | Neuaufbau aus dem Code |

Pflege:
- Nach jeder Änderung eines Schlüssels und mindestens einmal im Jahr prüfen, ob jeder Eintrag noch stimmt.
- Hier nur das Datum vermerken, nie den Wert.

| Geprüft am | von | Ergebnis |
|---|---|---|
| | | |

## 6. Nächster Schritt: produktive Datenbank- und Dateibackups

Reihenfolge. Jeder Schritt braucht deine Freigabe, Schritt 4 zusätzlich das Deployment des Pilot-Stands:

1. **Voraussetzungen:** Benachrichtigungen (Abschnitt 1) aktiv und getestet; Test-Bucket-Protokoll (Abschnitt 4) bestanden.
2. **Produktiver Backup-Bucket:**
   - Projekt „Rent-Base Backup“, Bucket `rent-base-backup` in hel1 mit Object Lock.
   - Sperrmodus und -dauer nach Testergebnis; geplant sind COMPLIANCE 30 Tage.
   - Getrennter Schreibschlüssel; den Admin-Schlüssel nur offline aufbewahren.
3. **Datenbank-Backup in Coolify:**
   - S3-Speicher eintragen.
   - Für `rent-base-db` alle 6 Stunden sichern (`0 2,8,14,20 * * *`, UTC), in S3 speichern; lokal 7 Stände, in S3 entsprechend der Sperre.
   - Ersten Lauf von Hand starten und Datei und Größe prüfen. Die Datenbank ist heute 19 MB groß.
   - Zusätzlich das **Coolify-eigene Backup** (Einstellungen → Backup) in denselben Bucket.
4. **Rücksicherung testen:** Dump in eine neue Test-Datenbank einspielen und Tabellen zählen. Danach die Test-Datenbank löschen.
5. **Dateibackup** (erst nach dem Deployment des Pilot-Stands, denn das Skript liegt nur dort):
   - `BACKUP_S3_*` als Runtime-Variablen setzen.
   - Geplante Aufgaben einrichten: „Dateien sichern“ `30 2,8,14,20 * * *` und „Gelöschte Dokumentkopien aufräumen“ `15 2,8,14,20 * * *`.
   - Beide einmal von Hand laufen lassen (siehe `backup.md`).
6. **Vollständiger Wiederherstellungstest** mit `check-restore`, danach vierteljährlich.

Bis Schritt 3 steht, gibt es **kein** Backup der Produktionsdaten außer dem Hetzner-Server-Image. Das ist die dringendste Lücke.

# Vorschlag: produktive Backups für RentBase

**Stand 11.10.2026. Nur ein Vorschlag: Es ist nichts angelegt und nichts umgestellt.** Jeder Schritt in Abschnitt 6 braucht
eine ausdrückliche Freigabe.

**Grundlagen:**
- Testergebnisse: [backup-test-bucket.md](backup-test-bucket.md)
- Begründungen: [backup-strategie.md](backup-strategie.md)
- Betriebsanleitung: [backup.md](backup.md)

Abweichend von diesen beiden Dokumenten liegt der Backup-Bucket in **hel1** statt fsn1. Ihre fsn1-Angaben werden mit der
Freigabe dieses Vorschlags angepasst.

## 1. Was der Test belegt (Test-Bucket `rent-base-backup-test`, hel1)

| Eigenschaft | Ergebnis |
|---|---|
| Object Lock COMPLIANCE | Wirkt wie dokumentiert. In der Sperrzeit lassen sich Fassungen weder löschen noch die Sperre verkürzen oder herabstufen, auch nicht mit dem vollen Projektschlüssel. Die Versionierung lässt sich nicht abschalten |
| Nach Ablauf der Sperre | Fassungen lassen sich mit Versions-ID endgültig löschen, mit SDK und `mc` gleich, ohne Löschmarker |
| Löschen ohne Versions-ID | Setzt nur einen Löschmarker. Die Daten bleiben |
| Coolifys Upload-Weg | `mc` aus `coolify-helper` 1.0.17 lädt in den gesperrten Bucket hoch, auch in Teilen (20 MB); Rücklesen mit identischer SHA-256 |
| Prüfsummen | Uploads werden mit und ohne Prüfsumme angenommen. Kein Werkzeug scheitert an dieser Stelle |
| Lifecycle | Die Regel wird trotz Object Lock angenommen. **Ob sie wirkt, ist noch offen**: Nachprüfung am 12. und 13.10.2026 |
| Projektschlüssel | Haben volle Rechte, auch für Standard-Sperre und Lifecycle. Deshalb ist ein eingeschränkter Schreibschlüssel nötig (Abschnitt 2) |

## 2. Eingeschränkter Schreibzugang für Coolify und die Dateisicherung

### Was Hetzner dokumentiert ([S3-Zugangsdaten](https://docs.hetzner.com/storage/object-storage/faq/s3-credentials/))

- **Projektschlüssel:** Ein Schlüssel gilt automatisch für **alle** Buckets seines Projekts, mit vollen Rechten.
- **Bucket-Policy:** Sie kann einzelnen Schlüsseln aus **einem anderen Projekt** Rechte geben.
  - Principal: `arn:aws:iam:::user/p<Projekt-ID>:<Access-Key>`; mit `p<Projekt-ID>` gilt sie für alle Schlüssel jenes Projekts.
  - Die Projekt-ID ist die des Schlüssel-Projekts, nicht die des Bucket-Projekts.
- **Zum Setzen der Policy** braucht es einen Schlüssel im Projekt des Buckets, also den Admin-Schlüssel.
- **Versionierte Buckets:** Neben `s3:GetObject` auch `s3:GetObjectVersion` erlauben.
- **Gegenrichtung:** Mit `Deny` und `NotPrincipal` lassen sich auch Schlüssel des eigenen Projekts aussperren. Dann zeigt die
  Hetzner Console den Bucket-Inhalt nicht mehr an.

### Grenzen, die nicht dokumentiert sind und deshalb getestet werden müssen

1. **Welche Policy-Aktionen und Bedingungen Hetzner durchsetzt.** Die Liste der unterstützten Aktionen erwähnt Policies nicht.
   Ob z. B. ein reines `Allow` für `s3:PutObject` ein `DeleteObjectVersion` zuverlässig abweist, ist nicht belegt.
2. **Sperrfristen beim Hochladen.** Bei AWS braucht ein Upload mit eigenen Sperr-Headern (`x-amz-object-lock-*`) das Recht
   `s3:PutObjectRetention`. Setzt Hetzner das nicht durch, könnte ein gestohlener Schreibschlüssel Daten beliebig lange sperren.
   Das kostet Geld und blockiert Datenschutz-Löschungen. **Im Test nur mit kurzen Fristen (höchstens 2 Tage) prüfen.**
3. **Einschränkung auf Präfixe** (`rent-base-backup/files/*`): Bei AWS üblich, bei Hetzner nicht beschrieben.
4. **Eigene Buckets im Writer-Projekt:** Ein Schreibschlüssel kann in **seinem eigenen** Projekt Buckets anlegen. Das lässt
   sich nicht verbieten. Schaden: nur Kosten; erkennbar an der Rechnung.
5. **Schlüssel im Backup-Projekt:** Jeder Schlüssel dort hat volle Rechte, auch über die Policy. Deshalb darf es dort nur
   **einen** Schlüssel geben, den Admin-Schlüssel, und der liegt nur im Passwortmanager. Die Test-Schlüssel müssen gelöscht sein,
   bevor dort `rent-base-backup` entsteht.
6. **Kein IAM:** Es gibt keine Benutzer oder Rollen, kein MFA-Delete und keine dokumentierten Policy-Bedingungen.

### Vorschlag: zwei Schreibschlüssel im Projekt „Rent-Base Backup-Writer“

| Schlüssel | Eingetragen in | Erlaubt | Bewusst nicht erlaubt |
|---|---|---|---|
| `coolify-db` | Coolify „S3 Storage“ | `PutObject`, `GetObject`, `GetObjectVersion`, `ListBucket`, `GetBucketLocation`, `GetBucketObjectLockConfiguration` | **`DeleteObject`**: Coolifys S3-Aufbewahrung wird abgeschaltet, das Aufräumen übernimmt die Lifecycle-Regel |
| `dateisicherung` | `BACKUP_S3_*` der App | wie oben, dazu `DeleteObject` **nur** auf `files/*` (legitime Löschungen setzen Löschmarker) | `DeleteObject` außerhalb von `files/` |

**Für beide verboten** (zusätzlich ausdrückliches `Deny`):
- `DeleteObjectVersion`, `PutObjectRetention`, `PutObjectLegalHold`, `BypassGovernanceRetention`
- `PutBucketPolicy`, `DeleteBucketPolicy`
- `PutLifecycleConfiguration`, `PutBucketVersioning`, `PutBucketObjectLockConfiguration`

**Belegt aus dem Coolify-Quelltext (v4.4.6, nur gelesen):**
- „Validate Connection“ listet Objekte (`ListObjectsV2`).
- Hochladen und Wiederherstellen laufen über `mc cp`.
- Coolifys S3-Aufbewahrung löscht mit einfachem `DeleteObject`. Stehen alle drei S3-Werte (Anzahl, Tage, Größe) auf **0**,
  löscht Coolify im Bucket **nichts**.

Eine einfachere Variante mit **einem** Schreibschlüssel für beides ist möglich. Dann bekäme auch Coolify das Löschrecht für
`files/`; die Trennung wäre schwächer.

## 3. Coolify übergibt S3-Schlüssel als Prozessargumente

### Befund

**Coolify-Quelltext v4.4.6 (nur gelesen):**
- **Datenbank- und Volume-Backup:** `docker exec … mc alias set … <Key> <Secret>`. Die Schlüssel stehen kurz in den Argumenten
  von `docker exec` auf dem Host und von `mc` im Hilfscontainer.
- **Wiederherstellung:** Die Schlüssel stehen als Umgebungsvariablen im Hilfscontainer, die Shell setzt sie aber in die
  Argumente von `mc` ein.
- **Dauer:** jeweils ein Bruchteil einer Sekunde je Lauf. Ein Programm, das die Prozessliste ständig abfragt, kann das abgreifen.

**Server (nur gelesen, Demonstration mit Platzhalter):**
- `/proc` ist ohne `hidepid` eingehängt. Jeder Host-Benutzer kann die Argumente aller Prozesse lesen, auch die von
  Container-Prozessen; nachgewiesen für `deploy`.
- Umgebungsvariablen fremder Prozesse kann `deploy` nicht lesen.
- Andere Container sehen den Host nicht: eigener PID-Namensraum.

**Benutzer `deploy` (uid 1000, angelegt 16.09.2026):**
- Er ist **gleichwertig zu root**:
  - Gruppe `sudo` mit `NOPASSWD: ALL`
  - Gruppe `docker`
  - ein SSH-Schlüssel in `authorized_keys`
  - Passwort gesperrt, verzeichnete Anmeldungen: keine
- Coolify verbindet sich als `root`, nicht als `deploy`.

**Bewertung:** `deploy` kann die Schlüssel sehen. Das ist aber nicht der eigentliche Punkt. Wer `deploy` hat, ist ohnehin root
und kann alles lesen: `/root/backup-test.env`, die Coolify-Datenbank und den Coolify-Schlüssel, mit dem die S3-Schlüssel dort
verschlüsselt sind. Gegen `deploy` hilft deshalb nur eine Entscheidung über das Konto selbst.

### Lösungen ohne Änderung am Coolify-Quelltext

1. **`deploy` klären (empfohlen, zuerst).** Untersucht am 11.10.: seit dem Anlegen nicht benutzt, kein Dienst braucht ihn.
   Maßnahmenplan mit Rückweg: [server-benutzer-deploy.md](server-benutzer-deploy.md).
   - **Wird das Konto nicht gebraucht:** SSH-Schlüssel entfernen und das Konto aus `sudo` und `docker` nehmen oder ganz sperren.
   - **Ist es dein Admin-Zugang:** bewusst als zweiten root-Zugang führen, mit Passphrase am Schlüssel. Dann bringt Schritt 2
     gegen `deploy` nichts.
2. **`hidepid=invisible` für `/proc`.**
   - **Wirkung:** Unprivilegierte Host-Benutzer und Dienste sehen fremde Prozesse nicht mehr.
   - **Umsetzung:** Remount ohne Neustart, dazu ein Eintrag in `/etc/fstab`. Die Änderung lässt sich sofort zurücknehmen.
   - **Vorsicht:** `polkit` läuft. Es braucht eine `gid=`-Ausnahme für `polkitd`, sonst scheitern polkit-Abfragen von Nicht-root-Benutzern.
   - **Bewertung:** Nutzen gering, solange es außer root keine unprivilegierten Login-Benutzer gibt. Optional.
3. **Eingeschränkte Schreibschlüssel (Abschnitt 2).**
   - **Wirkung:** Ein abgegriffener Schlüssel kann gesperrte Backups weder löschen noch ändern, und auch die Bucket-Einstellungen nicht.
   - **Bewertung:** Das ist der wirksamste Schutz.
4. **Datenbank-Backup ohne Coolifys S3-Weg:** eigenes `pg_dump` mit Upload über das SDK, die Schlüssel nur in der Umgebung.
   - **Bewertung:** Möglich, aber mehr Wartung, und Coolifys Backup-Übersicht und Fehlermeldungen entfallen. Derzeit nicht empfohlen.

### Restrisiken
- root, Mitglieder der Gruppe `docker` und Coolify selbst sehen alle Schlüssel. Das lässt sich nicht vermeiden.
- Die Coolify-Datenbank enthält die S3-Schlüssel verschlüsselt; der Schlüssel dazu liegt auf demselben Server.
- Coolify aktualisiert sich täglich selbst. Das Verhalten nach größeren Updates erneut prüfen.

## 4. Produktionskonzept

### Überblick

| Was | Womit | Wann (UTC) | Wohin | Aufbewahrung |
|---|---|---|---|---|
| PostgreSQL `rent-base-db` | Coolify-Backup (`pg_dump`), Schlüssel `coolify-db` | **stündlich**, Minute 17 | `rent-base-backup` (hel1), lokal die letzten 24 | 30 Tage COMPLIANCE, danach Lifecycle |
| Private Dateien (Fotos, Dokumente, Unterschriften, Logos) | `scripts/backup-files.mjs` als Scheduled Task, Schlüssel `dateisicherung` | **stündlich**, Minute 37 | `rent-base-backup/files/` | solange die App die Datei hat; legitim gelöschte nach 7 + 7 Tagen |
| Aufräumlauf gelöschter Ausweiskopien | `scripts/cleanup-driver-copies.mjs` | stündlich, Minute 27, also vor der Dateisicherung | App-Bucket | – |
| Ganzer Server | Hetzner-Serverbackup | täglich | Hetzner | 7 Tage |

**Warum stündlich statt alle 6 Stunden:**
- Im Pilotbetrieb entstehen tagsüber Verträge, Übergaben und Fotos. Ein Stundenraster senkt den möglichen Datenverlust (RPO)
  von 6 Stunden auf 1 Stunde.
- Ein Dump der heute 19 MB großen Datenbank dauert Sekunden. Die Kosten bleiben im Grundpreis (siehe unten).
- Wer es einfacher will, bleibt beim dokumentierten 6-Stunden-Raster.

### Object Lock
- **Bucket:** `rent-base-backup` in hel1, privat, **Object Lock beim Anlegen aktivieren**.
- **Standard-Sperre:** sofort danach **COMPLIANCE 30 Tage**, bevor der erste Upload kommt; sonst bleiben frühe Uploads ungesperrt.
- **Warum COMPLIANCE:** GOVERNANCE schützt nicht, weil jeder Projektschlüssel die Sperre umgehen darf.
- **Warum 30 Tage:**
  - Schutz gegen gestohlene Schlüssel und Ransomware für einen Monat.
  - Fehler, die erst nach mehr als 30 Tagen auffallen, lassen sich nicht mehr aus Backups beheben (bekannte Grenze).

### Lifecycle und Speicherbereinigung

**Regeln** (Vorlage `lifecycle.json` in [backup.md](backup.md), Präfix der Dumps nach dem ersten Backup eintragen):

| Bereich | Regel |
|---|---|
| Dumps | `Expiration.Days = 31`, `NoncurrentDays = 1`; eigene Regel `ExpiredObjectDeleteMarker` für übrig gebliebene Löschmarker |
| `files/` | `NoncurrentDays = 7`, `ExpiredObjectDeleteMarker` |
| `files-state/` | `NoncurrentDays = 1` |
| ganzer Bucket | `AbortIncompleteMultipartUpload` nach 7 Tagen |

**Coolify:** S3-Aufbewahrung auf 0 / 0 / 0, damit Coolify nichts löscht. Lokale Aufbewahrung: 24.

**Ergebnis 12./13.10.2026: Die Lifecycle-Regel hat im Test-Bucket nicht gewirkt** ([backup-test-bucket.md](backup-test-bucket.md)).
- Nach gut zwei Tagen gab es weder einen Löschmarker noch ein Entfernen.
- Die Kosten sind kein Problem: rund 720 Dumps im Monat bleiben weit unter dem enthaltenen Kontingent.
- Der **Datenschutz** aber schon: Dumps blieben länger als 31 Tage liegen.

**Möglichkeiten** (jeweils eigene Freigabe):

| Möglichkeit | Vorgehen | Bewertung |
|---|---|---|
| A Ursache klären | Hetzner-Support fragen: Bearbeitungszeit, Präfix-Filter, Object Lock. Zusätzlich die Beobachtung lesend weiterlaufen lassen | ohne Risiko; liefert die Grundlage für B oder C |
| B Täglicher Aufräumlauf mit eigenem Schlüssel ([Konzept](backup-aufraeumen-konzept.md)) | Ein dritter Schlüssel im Writer-Projekt, ohne Leserecht, mit `DeleteObjectVersion` nur auf den Backup-Präfixen. Er läuft als Scheduled Task und löscht nur Fassungen mit abgelaufener Sperre, die älter als 31 Tage sind; Schutzschwellen gegen Massenlöschung | COMPLIANCE verhindert jedes Löschen innerhalb der 30 Tage, auch mit diesem Schlüssel. Gestohlen könnte er nur Dumps entfernen, die ohnehin fällig sind. Setzt voraus, dass Hetzner Policies durchsetzt (Policy-Test) |
| C Monatlicher Aufräumlauf mit dem Admin-Schlüssel | vom eigenen Rechner, nur Fassungen mit abgelaufener Sperre; der Admin-Schlüssel kommt nie auf den Server | einfach, aber manuell; Dumps bleiben bis zu 61 Tage |

### Wiederherstellungstests
- **Wann:** vor dem ersten externen Vermieter, danach vierteljährlich und nach größeren Änderungen. Ablauf und Abnahmekriterien
  wie in [backup.md](backup.md), Abschnitt „Wiederherstellungstest“.
- **Was:**
  - Dump in eine **neue** Test-Datenbank einspielen und mit `check-restore.mjs` prüfen; danach die Test-Datenbank löschen.
  - Einmal eine alte Dateifassung mit dem Admin-Schlüssel zurückholen und ihre SHA-256 prüfen.
- **Zusätzlich jede Woche ein kurzer Blick:** Ist der neueste Dump jünger als 2 Stunden, und hat er eine plausible Größe?
  Später lässt sich das als lesender Prüflauf automatisieren.

### Überwachung und Benachrichtigungen
- **Coolify:** E-Mail-Benachrichtigungen über deinen SMTP-Zugang mit den Ereignissen „Backup failure“, „Scheduled task failure“,
  „Disk usage“ und „Server unreachable“. **Backups erst aktivieren, wenn die Test-Mail ankommt.**
- **UptimeRobot:** `/api/health` und die Website, wie beschlossen.
- **Lücke:** Fällt Coolify selbst aus, meldet niemand die fehlenden Backups.
  - Abhilfe später: ein „Totmann“-Signal, z. B. Healthchecks.io (kostenloser Einstieg, braucht ein Konto). Die Dateisicherung
    meldet sich dort nach jedem erfolgreichen Lauf.
  - Bis dahin: der wöchentliche Blick.

### Trennung von Test- und Produktionszugangsdaten

| Zugangsdaten | Projekt | Ort | Ende |
|---|---|---|---|
| Test-Schlüssel | Rent-Base Backup | `/root/backup-test.env` (root, 600), Passwortmanager | **vor** dem Anlegen von `rent-base-backup` in der Console löschen, Datei mit `shred -u` entfernen |
| Admin-Schlüssel (neu) | Rent-Base Backup | **nur** Passwortmanager | dauerhaft; bei Verdacht sofort ersetzen |
| `coolify-db`, `dateisicherung` (neu) | Rent-Base Backup-Writer | Coolify „S3 Storage“ bzw. `BACKUP_S3_*` | dauerhaft; Wechsel nach [backup.md](backup.md) „Verdacht auf gestohlene Zugangsdaten“ |
| App-Schlüssel `S3_*` | Rent-Base | App | unverändert |

**Regeln:**
- Kein Schlüssel wird für zwei Zwecke verwendet.
- Test-Schlüssel kommen nie in Coolify oder in die App.
- Das Einrichtungsskript `/root/backup-test-env-setup.sh` wird mit dem Test entfernt.

### Datenschutz
- **Inhalt:** Dumps enthalten alle personenbezogenen Daten, Dateien auch Ausweis- und Führerscheinkopien.
- **Fristen:** Wegen der Sperre verschwinden Löschungen erst nach etwa **31 bis 32 Tagen** aus den Dumps, gelöschte
  Kopien frühestens nach 15 Tagen (siehe [backup-strategie.md](backup-strategie.md)).
  - Diese Fristen gehören ins Löschkonzept und sind **rechtlich zu bestätigen**.
  - Nach einer Wiederherstellung werden zwischenzeitlich gelöschte Daten erneut gelöscht.
- **Speicherort:** Finnland (EU). Prüfen, ob der Auftragsverarbeitungsvertrag mit Hetzner im Konto abgeschlossen ist.
- **Verschlüsselung:** Die Dumps liegen bei Hetzner ohne eigene Verschlüsselung. Coolify bietet keine
  clientseitige Verschlüsselung, Hetzner nennt nur SSE-C.
- **Tests:** Echte Kundendaten kommen nie in Test-Buckets.

### Kosten
- **Grundpreis:** Er gilt laut Hetzner je **Konto** und wird für `rent-base-files` schon bezahlt.
- **Enthaltenes Kontingent:** rund 1 TB Speicher im Monat (744 TB-Stunden) und rund 1 TB Traffic. Eingehender und
  interner Traffic in `eu-central` sowie S3-Anfragen sind kostenlos.
- **Schätzung für RentBase:**
  - Dumps: 720 im Monat zu je höchstens 20 MB, also höchstens 15 GB.
  - Dateien: heute 150 MB, dazu alte Fassungen. Abgerechnet werden mindestens 64 kB je Objekt.
- **Zusatzkosten nach heutigem Stand: keine.**
- **Hetzner-Serverbackup:** Es kostet laut Hetzner einen Aufschlag auf den Serverpreis. Ob es aktiv ist, prüfst du in der Console.

## 5. Offene Risiken

| Risiko | Stand |
|---|---|
| **Lifecycle wirkt im Test nicht** (12./13.10.) | FAIL vom 13.10. bleibt. Am 14.10. um 01:30 UTC setzte die Regel den ersten Löschmarker, rund 49,5 Stunden zu spät; ob alte Fassungen entfernt werden, zeigt sich ab 15.10. Vor produktiven Backups einen nachweislich funktionierenden Aufräumweg festlegen (Möglichkeiten A–C oben) |
| Eingeschränkter Writer-Schlüssel funktioniert nicht wie geplant | **Policy-Test vom 14.10.** ([backup-policy-test.md](backup-policy-test.md), 7d): Der Writer konnte nichts Verbotenes. Aber `GetBucketLocation`, `PutObject` mit SDK-Standard-Prüfsumme, Teil-Uploads, `DeleteObject` und **Coolifys `mc cp`** wurden trotz Freigabe abgewiesen. Ursache offen; die Policy ist so nicht produktionstauglich |
| `deploy` war ein zweiter, nicht benutzter root-Zugang | **erledigt am 12.10.2026:** stillgelegt, ohne sudo, ohne `docker`, ohne Anmeldung, mit Rückweg ([server-benutzer-deploy.md](server-benutzer-deploy.md)) |
| Coolify-Schlüssel kurz in der Prozessliste | gering, solange nur root-gleiche Benutzer existieren; eingeschränkter Schreibschlüssel begrenzt den Schaden |
| Übernahme des Hetzner-Kontos | Zwei-Faktor-Anmeldung, wenige Personen mit Zugriff; optional eine monatliche verschlüsselte Kopie anderswo |
| Ausfall von Coolify bleibt unbemerkt | wöchentlicher Blick, später ein Totmann-Signal |
| Fehler, die erst nach mehr als 30 Tagen auffallen | aus Backups nicht behebbar (bewusste Grenze) |
| Pilot-Stand noch nicht deployt | Dateisicherung und Aufräumlauf brauchen die Skripte aus diesem Zweig |
| Backups heute | **Es gibt noch keine Datenbank- und Dateibackups außer dem Hetzner-Serverbackup** |

## 6. Schritte, die eine ausdrückliche Freigabe brauchen (Reihenfolge)

1. **Ergebnis der Lifecycle-Nachprüfung abwarten.** Die Prüfungen am 12. und 13.10. sind nur lesend und bereits eingeplant.
   Danach gibst du das Aufräumen der Testobjekte frei (`--cleanup`).
2. **Entscheidung über `deploy`:** behalten, einschränken oder sperren. Danach setze ich sie um, mit Rückweg.
3. **Policy-Test am Test-Bucket.**
   - **Du:** legst das Projekt „Rent-Base Backup-Writer“ und darin einen Test-Schreibschlüssel an und gibst ihn wie gehabt
     verdeckt ein, in eine zweite Datei.
   - **Ich:** setze mit dem Test-Schlüssel eine Policy auf den Test-Bucket und prüfe Erlaubtes und Verbotenes. Sperrfristen dabei
     nur kurz (höchstens 2 Tage).
4. **Optional `hidepid`** für `/proc`, mit `polkit`-Ausnahme.
5. **Test abschließen:**
   - **Du:** löschst Test-Bucket, Test-Schlüssel und die Testdatei.
   - **Ich:** entferne das Einrichtungsskript.
6. **Produktiver Bucket:**
   - **Du:** legst `rent-base-backup` in hel1 mit Object Lock an, dazu den Admin-Schlüssel.
   - **Von deinem Rechner, mit vorbereiteten Befehlen:** Standard-Sperre, Lifecycle und Policy setzen. Der Admin-Schlüssel kommt nicht auf den Server.
7. **Coolify:** S3-Speicher mit `coolify-db` eintragen und das stündliche Datenbank-Backup einrichten. Danach erstes Backup,
   Präfix in die Lifecycle-Regel, erster Wiederherstellungstest.
8. **Deployment des Pilot-Stands** (gesondert), dann die Scheduled Tasks für Dateisicherung und Aufräumlauf.
9. **Vollständiger Wiederherstellungstest**, danach vierteljährlich.

# Checkliste: erster produktiver PostgreSQL-Backup-Lauf

**Stand 15.10.2026.** Gilt für den Übergangsweg ([backup-uebergang.md](backup-uebergang.md)). Abkürzungen A3–A10 wie dort. Jeder
Haken wird mit Datum ins Protokoll in [backup.md](backup.md) übernommen.

## 0. Voraussetzungen

- [ ] Übergangsweg freigegeben (Entscheidung; Grenzen in [backup-vergleich.md](backup-vergleich.md))
- [ ] **Coolify-E-Mail:**
  - Kanal eingerichtet: lesend bestätigt am 15.10., Ereignis „Backup failure“ an.
  - **Test-Mail angekommen:** von dir zu bestätigen.
  - „Server Disk Usage“ an.
  - „Backup Success“ vorübergehend an.
- [ ] Hetzner-Serverbackup: neuestes Backup jünger als 24 Stunden ([betrieb-absicherung.md](betrieb-absicherung.md), Abschnitt 2)
- [ ] A1: Projekt, Bucket `rent-base-backup` (hel1, Object Lock aktiviert), Schlüssel `admin`, `coolify-db`, `dateisicherung`;
  Werte nur im Passwortmanager
- [ ] A3 `run.sh --pruefen`:
  - Exit 0, „sieht nur rent-base-backup“
  - Versionierung an, keine Policy, ACL nur der Besitzer
  - Bestand 0
- [ ] A4 `run.sh --sperre`: „Standard-Sperre gesetzt: COMPLIANCE 30 Tage, zurückgelesen“
- [ ] A5 S3 Storage in Coolify mit `coolify-db`: „Validate Connection“ erfolgreich

## 1. Erster Lauf

- [ ] A6 Zeitplan:
  - Frequency `17 * * * *`, UTC
  - S3 an
  - Aufbewahrung S3 **0 / 0 / 0**, lokal 24 / 0 / 0
- [ ] Uhrzeit notieren, dann „Backup Now“
- [ ] Coolify → `rent-base-db` → Backups → Executions:
  - Status erfolgreich
  - Größe und Dateiname notieren
  - S3-Upload ja
- [ ] Mail „Backup Success“ angekommen (falls eingeschaltet)

## 2. Prüfung

- [ ] A7 `run.sh --pruefen`:
  - Zeile `Dump: …` mit derselben Größe wie in Coolify
  - `OK Sperre neuester Dump: COMPLIANCE bis <Upload + 30 Tage>`
  - `Vorschlag Dump-Präfix` notieren
- [ ] A8 `run.sh --lifecycle <Präfix>`: „Lifecycle gesetzt: 4 Regeln, zurückgelesen“
- [ ] A9 `run.sh --check <Präfix>`:
  - 0 Fehler
  - Hinweis „Dateisicherung: läuft noch nicht“ ist richtig
- [ ] Nach dem nächsten planmäßigen Lauf (Minute 17) erneut `--pruefen`: zwei Dumps, beide gesperrt
- [ ] Ab jetzt bis Phase C **täglich** `run.sh --check <Präfix>`

## 3. Alarmierung

- [ ] **Kanal:** Coolify → Notifications → Email → „Send test“. Die Mail ist angekommen; Spam-Ordner geprüft
- [ ] **Ereignis:** „Backup failure“ an. Lesend bestätigt am 15.10.; nach Änderungen erneut lesend prüfen lassen
- [ ] **Optional, mit Freigabe: Alarm-Probe ohne Produktionsdaten.** So wird der Ereignisweg selbst getestet, nicht nur der
  Kanal:
  1. Eine **leere** Wegwerf-Datenbank `rb-alarmprobe` in Coolify anlegen.
  2. Einen Backup-Zeitplan auf einen S3-Speicher mit absichtlich **falschem Bucket-Namen** setzen.
  3. „Backup Now“.
  4. **Erwartet:** Mail „Backup failure“.
  5. Danach Datenbank, Zeitplan und S3-Speicher löschen.
- [ ] **Bekannt:** Ein echter Fehler am Produktions-Backup wird nicht absichtlich ausgelöst. Fällt Coolify ganz aus, meldet
  niemand fehlende Backups (Prüflauf von außen offen).

## 4. Isolierte Wiederherstellung (A10, mit Freigabe)

- [ ] **Testdatenbank anlegen:** In Coolify eine **neue** PostgreSQL 18.6 `rent-base-restore-test` im selben Projekt.
  - „Make it publicly available“ **aus**.
  - Keine App mit ihr verbinden.
  - Gleiche Sortierregel wie live (UTF-8).
- [ ] „Import Backup“ → aus S3 → den in Abschnitt 1 notierten Dump; Dauer messen
- [ ] **Vergleich (ich, nur lesend, beide Seiten mit Schreibschutz):**
  - Zeilenzahlen der Haupttabellen
  - Stand der Migrationen
  - neuester Datensatz höchstens rund 1 Stunde älter als live
  - Abweichungen nur durch Änderungen nach dem Dump-Zeitpunkt
- [ ] **Testdatenbank löschen** samt Volume; sie enthält alle Kundendaten. Danach prüfen, dass Container und Volume weg sind
- [ ] Protokoll: Dump-Name, Zeitpunkt, Dauer des Imports, Ergebnis, Löschung bestätigt

Der vollständige Test mit `check-restore.mjs` und den Dateien folgt nach dem Deploy ([backup.md](backup.md),
„Wiederherstellungstest“).

## 5. Abbrechen, wenn …

- **`--pruefen` oder `--sperre` endet nicht mit Exit 0:** nicht weitermachen, Ausgabe schicken.
- **Der erste Dump ist nicht gesperrt, oder die Sperre ist nicht rund 30 Tage:**
  1. Im Zeitplan S3 ausschalten.
  2. Ausgabe schicken.
  3. Die bereits hochgeladene Fassung bleibt so, wie sie ist.
- **„Backup failure“ oder ein Fehler im Prüflauf:** Ursache klären, bevor weitere Schritte folgen
  ([backup-uebergang.md](backup-uebergang.md), Abschnitt 6).
- **Wiederherstellung unvollständig:** Backups weiterlaufen lassen, aber nicht als geprüft werten; Ursache klären.

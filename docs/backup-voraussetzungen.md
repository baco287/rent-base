# Offene Voraussetzungen für produktive Backups

**Stand 15.10.2026** (ergänzt um Benachrichtigungen, [backup-vergleich.md](backup-vergleich.md), [backup-erster-lauf.md](backup-erster-lauf.md) und [hetzner-support-anfrage.md](hetzner-support-anfrage.md)). Den Plan für das erste PostgreSQL-Backup enthält [backup-plan-postgres.md](backup-plan-postgres.md). Grundlage ist der Übergangsweg ([backup-uebergang.md](backup-uebergang.md)): Projektschlüssel, Object Lock
COMPLIANCE 30 Tage und ein Prüflauf. Noch ist kein produktiver Bucket angelegt und kein Backup aktiv. Außer dem
Hetzner-Serverbackup gibt es keine Sicherung.

Legende: ✅ erledigt · ◻ offen · ◆ Entscheidung

## 1. Gemeinsam, vor dem ersten produktiven Backup

| | Voraussetzung | Stand | Wer |
|---|---|---|---|
| ◆ | **Übergangsweg und seine Grenzen annehmen** ([backup-uebergang.md](backup-uebergang.md), Abschnitt 1). Vor allem: gesicherte Dateien über 30 Tage sind ungeschützt, der Prüflauf läuft im selben System, Legal Holds werden nicht geprüft | offen | du |
| ◆ | Projekt für den Bucket: neues Projekt „Rent-Base Backup Produktion“ (empfohlen) oder das Test-Projekt nach dem Aufräumen | offen | du |
| ◻ | Coolify-Benachrichtigung per E-Mail (A0): **Kanal eingerichtet** (lesend bestätigt am 15.10.; Backup-, Task- und Deploy-Fehler an). Offen: Test-Mail bestätigen, „Server Disk Usage“ einschalten | teilweise | du |
| ◻ | Hetzner: Projekt, Bucket `rent-base-backup` in hel1 mit Object Lock, drei Schlüssel (A1). Ob der Name frei ist, zeigt sich beim Anlegen | offen | du |
| ✅ | Einrichtungs- und Prüfskripte auf dem Server (A2), Prüfsummen gleich dem Repository | 14.10. | ich |
| ✅ | Vortest der Skripte gegen Hetzner ([backup-prod-vortest.md](backup-prod-vortest.md)): alle Prüfungen wie erwartet; das echte Setzen von Sperre und Lifecycle nur im Trockenlauf | 14.10. | ich |
| ◻ | **Lifecycle belegen:** Den Ablauf hat die Regel ausgeführt, mit rund 2 Tagen Verzögerung. Die alte Fassung war am 16.10. 07:27 UTC noch da: nach S3-Regeln seit 16.10. 00:00 UTC überfällig, bei der einmal beobachteten Verzögerung voraussichtlich um den 18.10. Nächste lesende Prüfung ab 18.10., auf Anordnung; danach Entscheidung über den Aufräumlauf ([backup-plan-postgres.md](backup-plan-postgres.md), Abschnitt 1) | offen | ich, auf Anordnung |
| ◻ | **Aufräumweg, falls das nicht wirkt:** nur ein Konzept ([backup-aufraeumen-konzept.md](backup-aufraeumen-konzept.md)), nicht umgesetzt | offen | ich, mit Freigabe |
| ◻ | **Löschfristen rechtlich bestätigen und ins Löschkonzept** ([backup-strategie.md](backup-strategie.md)): Dumps etwa 33–38 Tage (überwacht bis rund 40), legitim gelöschte Fotos und Ausweiskopien etwa 15–33 Tage | offen | du |
| ◻ | Auftragsverarbeitungsvertrag mit Hetzner im Konto prüfen | offen | du |
| ◻ | Hetzner-Serverbackup weiter aktiv: laut deinem Screenshot vom 04.10. täglich, 7 Stände; in der Console bestätigen | zu bestätigen | du |

## 2. PostgreSQL-Backups (Phase A, ohne Deploy)

Reihenfolge und Befehle: [backup-uebergang.md](backup-uebergang.md), Abschnitt 3.

| | Schritt | Wer | Freigabe |
|---|---|---|---|
| ◻ | A3 lesende Prüfung `run.sh --pruefen` | du | – |
| ◻ | A4 Standard-Sperre `--sperre`: ab hier ist jede Fassung 30 Tage unlöschbar | du | „ja“ im Skript |
| ◻ | A5 S3 Storage in Coolify mit `coolify-db`, „Validate Connection“ | du | – |
| ◻ | A6 Zeitplan `17 * * * *` UTC, S3 an, Aufbewahrung S3 0/0/0, lokal 24; „Backup Now“ | du | – |
| ◻ | A7 `--pruefen`: Dump angekommen und gesperrt, Präfix ablesen | du | – |
| ◻ | A8 Lifecycle `--lifecycle <Präfix>` | du | „ja“ im Skript |
| ◻ | A9 voller Prüflauf `--check <Präfix>`, bis Phase C **täglich von Hand** | du | – |
| ◻ | A10 kurze Wiederherstellungsprobe in eine Testdatenbank, Zeilenzahlen vergleichen, danach löschen | du / ich | **ja** |

Schon belegt: `mc` aus Coolifys Hilfscontainer lädt mit einem Schlüssel mit vollen Rechten in einen Object-Lock-Bucket hoch,
auch in Teilen (Bucket-Test 10.10., 20 MB). Ein echter Coolify-Backup-Lauf steht noch aus; der erste ist „Backup Now“ in A6.

## 3. Dateibackups (Phase B und C, nach dem Deploy)

| | Voraussetzung | Stand | Wer | Freigabe |
|---|---|---|---|---|
| ◻ | **Pilot-Deploy** mit den Skripten (Merge und Deploy, PR #1); vorher die Punkte aus [deployment.md](deployment.md), u. a. `APP_URL` | offen | du / ich | **ja** |
| ◻ | App-Umgebung: `BACKUP_S3_*` mit `dateisicherung`, `BACKUP_GRACE_DAYS=7`, `BACKUP_DUMP_PREFIX`; danach Neustart | offen | du | **ja** (Neustart) |
| ◻ | Scheduled Tasks: Aufräumlauf (vorher `--dry-run`), Dateisicherung, Prüflauf stündlich und täglich `--voll`; je einmal von Hand | offen | du | – |
| ◻ | **Erster echter Lauf der Dateisicherung:** `backup-files.mjs` lief bisher nur gegen Attrappen, nie gegen echte Buckets | offen | du | – |
| ◻ | Vollständiger Wiederherstellungstest mit `check-restore.mjs` ([backup.md](backup.md)) | offen | du / ich | **ja** |
| ◻ | App-Bucket `rent-base-files` (fsn1): Versionierung ist aus. Bewusst so lassen oder ändern ([backup.md](backup.md), offene Punkte) | offen | du | ◆ |
| ◆ | **Rollende Sperre** für Dateien über 30 Tage: braucht vorher einen Test am Test-Bucket; verlängert die Löschfrist gelöschter Dateien auf bis zu rund 40 Tage | offen | du | ◆ |
| ◆ | **Prüflauf von außen oder Totmann-Signal** (GitHub Actions nach dem Merge oder Healthchecks.io) | offen | du | ◆ |

## 4. Später oder unabhängig

| | Punkt | Stand |
|---|---|---|
| ◻ | Eingeschränkter Writer-Schlüssel: Ursache bei Hetzner offen. Diagnose E2–E8 ([backup-prod-vortest.md](backup-prod-vortest.md), Abschnitt 5) und Support-Anfrage brauchen je eine Freigabe | offen |
| ◻ | Test aufräumen: Die Sperren der Testobjekte sind seit dem 15.10. abgelaufen (Policy-Test 07:25 UTC, Vortest 11:37 UTC). Aufräumen nur mit Freigabe; Test-Schlüssel und Writer-Projekt erst danach löschen | offen |
| ◻ | Entscheidung über das stillgelegte Konto `deploy` | frühestens 11.11.2026 |

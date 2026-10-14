# Vortest der Produktions-Backup-Skripte am Test-Bucket

**Freigabe vom 14.10.2026.** Die Skripte des Übergangswegs ([backup-uebergang.md](backup-uebergang.md)) laufen einmal gegen den
echten Hetzner-Test-Bucket `rent-base-backup-test`, bevor ein produktiver Bucket entsteht. Zusätzlich werden die
fehlgeschlagenen Writer-Fälle P2, P4, P6, P9 und M3 aus dem Policy-Test technisch analysiert (Abschnitt 5).

**Dateien:**

| Datei | Zweck |
|---|---|
| [`scripts/backup-prod-vortest.mjs`](../scripts/backup-prod-vortest.mjs) | Testgerüst: Vorprüfung, Trockenlauf, Testobjekte, Prüfläufe, Abschlusskontrolle |
| [`scripts/backup-prod-vortest.sh`](../scripts/backup-prod-vortest.sh) | Testvariante des Rahmens; der produktive `run.sh` bleibt unverändert |

Geprüft werden die auf dem Server abgelegten Produktionsskripte aus `/root/backup-prod/js`, unverändert und nur lesend
eingehängt.

## 1. Bedingungen und wie sie eingehalten werden

| Bedingung | Umsetzung |
|---|---|
| Nur Test-Bucket und Test-Admin-Schlüssel | Der Wrapper liest nur `/root/backup-test.env` (root, 600) und bricht ab, wenn dort ein anderer Bucket oder Endpunkt steht. Das Gerüst bricht ab, wenn der Schlüssel etwas anderes sieht als genau `rent-base-backup-test`. Jede Anfrage an einen anderen Bucket wird blockiert |
| Separate Wrapper-Variante | `run-vortest.sh` in `/root/backup-prod-vortest`. Die Prüfungen des produktiven Rahmens bleiben unverändert: Docker-Debug, genau ein Produktions-Container, Image-ID, Schlüssel nur über die Standardeingabe |
| Nur neue, gekennzeichnete Präfixe und künstliche Daten | Laufpräfix `rb-test/prodskript/<Zeit>-<Zufall>/`, vorher nachweislich leer; Inhalte aus `randomBytes` |
| Vorab lesend prüfen | Schritt 1: sichtbare Buckets, Versionierung, Standard-Sperre (COMPLIANCE 1 Tag), Lifecycle (nur `rb-test-ablauf`), keine Policy, ACL, Abbild aller vorhandenen Fassungen und Löschmarker. Jede Abweichung: Abbruch, nichts geschrieben |
| Erst ein Trockenlauf | Schritt 2: Einrichtung in den Modi `--sperre`, `--lifecycle` und `--wiederherstellen`. Jede ändernde Anfrage der Skripte wird mit Inhalt protokolliert und **blockiert, nie gesendet** |
| Nur sichere S3-Operationen | Die Skripte selbst dürfen im ganzen Vortest **nichts** schreiben. Das Gerüst darf nur: PutObject eines neuen Schlüssels unter dem Laufpräfix (mit Content-MD5, ohne Sperr-Header); DeleteObject **ohne** Versions-ID unter dem Laufpräfix (setzt nur einen Löschmarker); einen eigenen, leeren Teil-Upload beginnen und abbrechen. Alles andere blockiert eine Sicherung im Gerüst. Geschrieben wird ohne automatische Wiederholung, damit nichts doppelt ankommt. Der Teil-Upload besteht nur während des vollen Prüflaufs und wird danach in jedem Fall abgebrochen, auch bei Zeitüberschreitung oder SIGTERM. Nur nach einem harten Abbruch (Neustart, `kill -9`) bliebe er offen und müsste mit Freigabe abgebrochen werden |
| Keine vorhandenen Testobjekte verändern | Schreibzugriffe nur unter dem Laufpräfix; Abschlusskontrolle vergleicht alle Fassungen außerhalb davon mit dem Abbild aus Schritt 1 |
| Keine dauerhaften Änderungen an Policy, Lifecycle, Object Lock, Versionierung | Solche Anfragen sind im Gerüst in jedem Schritt blockiert; die Abschlusskontrolle vergleicht die Einstellungen |
| Keine produktiven Zugangsdaten, keine Kundendaten | Nur der Test-Admin-Schlüssel; der Test-Bucket enthält nur künstliche Testdaten |
| Keine Geheimnisse ausgeben | Ausgabe nur Namen, Zähler, Zeitpunkte, Fehlername und HTTP-Status |

**Was danach zurückbleibt (erwartet):**
- Unter dem Laufpräfix 8 Fassungen künstlicher Daten (zusammen rund 0,5 MB) und 3 Löschmarker.
- Die Fassungen sind durch die Standard-Sperre des Test-Buckets **1 Tag** gesperrt; der eigene Teil-Upload ist abgebrochen.
- Aufgeräumt wird später zusammen mit dem übrigen Test-Bucket.

## 2. Testobjekte

Alle Schlüssel relativ zum Laufpräfix:

| Schlüssel | Was | Zweck im Prüflauf |
|---|---|---|
| `data/coolify/backups/rb-vortest/pg-dump-vortest-1.dmp` | 150 kB Zufallsdaten | Dump |
| `…/pg-dump-vortest-2.dmp` | zweimal hochgeladen | erkannt als „Dumps überschrieben“ |
| `…/pg-dump-vortest-3.dmp` | hochgeladen, dann Löschmarker | erkannt als „Dumps gelöscht“ |
| `files/t/vortest/contracts/2026/10/vertrag.pdf` | 1 kB, dann Löschmarker | erkannt als „Dateien gelöscht“ |
| `files/t/vortest/photos/2026/10/foto.jpg` | 1 kB, dann Löschmarker | legitime Löschung, **kein** Fehler |
| `files/t/vortest/documents/2026/10/dokument.pdf` | 1 kB | gesicherte Datei |
| `files-state/missing.json` | `{}`-große Zufallsdaten | Dateisicherung „gelaufen“ |
| `…/teil-upload.dmp` | begonnener Teil-Upload ohne Teile | offene Teil-Uploads; danach abgebrochen |

**Erwartete Befunde gegen den Test-Bucket:** Der Test-Bucket ist absichtlich anders eingestellt als der Produktions-Bucket
(1 Tag statt 30, eigene Lifecycle-Regel). Erwartet sind deshalb genau diese Fehlerzeilen:
- Standard-Sperre und Lifecycle
- die drei absichtlichen Eingriffe
- die Sperre neuer und aller Fassungen („nur 1.0 Tage“)

Abweichungen davon werden gemeldet, lösen aber nichts aus.

## 3. Ergebnis

*Wird nach dem Lauf ergänzt.*

## 4. Zurückgeblieben

*Wird nach dem Lauf ergänzt.*

## 5. Analyse der Writer-Fälle P2, P4, P6, P9, M3

*Wird nach der Analyse ergänzt.*

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

**Lauf `rb-test/prodskript/20261014T113609Z-f2a637/`**
- Am 14.10.2026 um 11:36 UTC gestartet, losgelöst; nach unter einer Minute beendet mit **Exit 0, „alles wie erwartet“**.
- **Geprüft:**
  - Skripte: `backup-lib.mjs` `ad8f010f…`, `backup-prod-lib.mjs` `be077ce8…`, Testgerüst `1191938f…`.
  - App-Image `863331d5fdd6`.
  - Vorher wurde bestätigt, dass `/root/backup-prod` unverändert dem Repository entspricht (alle Prüfsummen gleich).
- **Protokoll:** `/root/backup-prod-vortest/log-20261014T113609Z.txt`, ohne Zugangsdaten.

**Real gegen Hetzner geprüft:** die Bibliothek [`backup-prod-lib.mjs`](../scripts/backup-prod-lib.mjs) mit
- `runSetup` in allen vier Modi; ändernde Anfragen blockiert
- `runCheck` mit `--voll`
- `readTarget`: Schlüssel über die Standardeingabe
- `s3Client`: Zeitlimits, Standard- und strenger Client
- `listAllVersions` und `listAllUploads` mit echten Fortsetzungsmarken in Seiten zu 2 Einträgen

Die Aufrufskripte `backup-prod-setup.mjs` und `backup-check.mjs` selbst sind nur dünne Hüllen um diese Funktionen. Sie und
der produktive `run.sh` liefen nicht gegen Hetzner (Abschnitt 6).

| Schritt | Ergebnis |
|---|---|
| 1 Vorprüfung | PASS: nur der Test-Bucket sichtbar, Versionierung an, Standard-Sperre COMPLIANCE 1 Tag, nur `rb-test-ablauf`, keine Policy, Laufpräfix leer. Bestand außerhalb: 10 Einträge, keine offenen Teil-Uploads, Bucket-ACL 1 Eintrag |
| 2 Trockenlauf `--sperre` | PASS: lehnt die abweichende Sperre ab (Exit 1), **keine** Änderung versucht |
| 2 Trockenlauf `--lifecycle` | PASS: „erst die Standard-Sperre setzen“ (Exit 1), **keine** Änderung versucht |
| 2 Trockenlauf `--wiederherstellen`, ohne Dumps | PASS: würde nur die Standard-Sperre auf COMPLIANCE 30 Tage setzen (blockiert); Lifecycle nicht, weil kein Dump unter dem Präfix liegt |
| 3 Testobjekte | PASS: 8 Fassungen und 3 Löschmarker angelegt, alle mit Versions-ID, Löschmarker von Hetzner bestätigt |
| 4a `--pruefen` | PASS: alle erwarteten Zeilen. Projekt, Policy, Versionierung, ACL, Lifecycle, Bestand 8/3, die beiden aktuellen Dumps, „Sperre neuester Dump: nur 1.0 Tage“, Dump-Präfix-Vorschlag richtig; Exit 1 wie erwartet |
| 4b Prüflauf `--voll` | PASS: genau die 7 erwarteten Fehlerzeilen, sonst 12 OK, 0 Hinweise (Einzelheiten unten) |
| 4c Trockenlauf `--lifecycle` mit Dumps | PASS: lehnt weiterhin ab, keine Änderung versucht |
| 4c Trockenlauf `--wiederherstellen` mit Dumps | PASS: würde Standard-Sperre (COMPLIANCE 30 Tage) **und** Lifecycle (4 Regeln, Dump-Präfix richtig) setzen; beides blockiert. Policy und ACL unverändert, weil keine vorhanden bzw. nur der Besitzer |
| 5 Abschluss | PASS: Bestand außerhalb des Laufpräfixes unverändert (10 Einträge, keine Änderung, auch nicht durch den Lifecycle). Einstellungen unverändert; eigener Teil-Upload abgebrochen, keiner offen |

**Prüflauf `--voll` im Einzelnen:**
- **OK:**
  - Versionierung, Buckets im Projekt, Bucket-Policy
  - **Bucket-ACL „nur der Besitzer“** und **Objekt-ACL „4 aktuelle Fassungen: nur der Besitzer“**: Hetzner lässt ACLs lesen, und das Format passt
  - Dumps: neuester 0.0 h alt, 0.1 MB, 2 in 24 h
  - Dateisicherung
  - Lifecycle-Fristen in allen drei Bereichen, Gesamtgröße
  - Teil-Uploads: der eigene, offene wurde gefunden
- **Erwartete Fehler:**
  - Standard-Sperre und Lifecycle: Der Test-Bucket ist absichtlich anders eingestellt.
  - Die drei absichtlichen Eingriffe wurden je genau einmal erkannt:
    - `pg-dump-vortest-2.dmp` überschrieben
    - `pg-dump-vortest-3.dmp` gelöscht
    - `vertrag.pdf` gelöscht
  - Die gelöschte Foto-Datei wurde richtig **nicht** gemeldet.
  - Sperre neuer und aller Fassungen „nur 1.0 Tage“: Hetzners Sperrfrist wird richtig gelesen und gerechnet.

**Was das belegt:** Hetzner antwortet auf jede Anfrage der Skripte so, wie die Skripte es erwarten:
- Versionen, Löschmarker und `IsLatest`
- Fortsetzungsmarken bei seitenweiser Auflistung
- Sperrfristen je Fassung mit Versions-ID
- ACL-Format von Bucket und Objekten
- offene Teil-Uploads
- Fehlernamen wie `NoSuchBucketPolicy` und `NoSuchLifecycleConfiguration`

Keine Anfrage endete mit „nicht lesbar“ oder „nicht auflistbar“.

## 4. Zurückgeblieben

| Was | Stand nach dem Lauf (unabhängig nachgeprüft, nur lesend) |
|---|---|
| Laufpräfix `rb-test/prodskript/20261014T113609Z-f2a637/` | 8 Fassungen künstlicher Daten (zusammen rund 0,5 MB), 3 Löschmarker; gesperrt durch die Standard-Sperre bis etwa **15.10.2026, 11:37 UTC** |
| Offene Teil-Uploads | keine im ganzen Bucket |
| Bestand außerhalb | unverändert: 8 Fassungen, 2 Löschmarker unter `rb-test/` |
| Bucket-Einstellungen | unverändert: Versionierung an, COMPLIANCE 1 Tag, nur `rb-test-ablauf`, keine Policy, ACL nur der Besitzer |
| Server | `/root/backup-prod-vortest`: `run-vortest.sh`, Testgerüst, Protokoll, Startausgabe, Sperrdatei, alles ohne Zugangsdaten. `/root/backup-prod` unverändert. Kein Container läuft |

Aufgeräumt werden die Testobjekte später zusammen mit dem übrigen Test-Bucket, frühestens nach Sperrende.

## 5. Analyse der Writer-Fälle P2, P4, P6, P9, M3

Untersucht ohne Policy-Änderung und ohne Writer-Zugriff:
- **Ceph-RGW-Quelltext:** Zweige reef, squid, tentacle und main, mit festen Commit-Ständen.
- **Hetzner-Dokumentation** und öffentliche Berichte.
- **Lokale Mitschnitte** der genauen SDK-Anfragen, mit Platzhalter-Schlüsseln gegen einen lokalen Server.
- **Eine lesende Probe E1:** `GetBucketLocation` mit dem Test-Admin-Schlüssel, je 5× im Pfad- und im Subdomain-Stil.

**Kernergebnis: Die Policy blockiert keinen der fünf Fälle.**
- Jede gescheiterte Anfrage ist durch Anweisung 1, 2 oder 3 erlaubt.
- Keine nutzt eine Aktion aus der `Deny`-Anweisung.
- Im Ceph-Quelltext laufen die gescheiterten Anfragen durch dieselbe Prüffunktion, mit derselben Aktion und demselben Ressourcen-ARN wie gelungene Anfragen desselben Laufs:

| Gescheitert | Gelungen, gleiche Prüfung |
|---|---|
| P2 `GetBucketLocation` | P3 `GetBucketObjectLockConfiguration`, gleiche Anweisung |
| P4 `PutObject` unter `w/db/` | P6 `CreateMultipartUpload` unter `w/db/`, beides `s3:PutObject` |
| P6 Teile bzw. Abschluss | P6 Start, alles `s3:PutObject` auf denselben Schlüssel |
| P9 `DeleteObject` ohne Versions-ID | wird nur gegen `s3:DeleteObject` geprüft, das Anweisung 3 erlaubt |

Ein unverändertes Ceph müsste also beide Seiten jeweils gleich behandeln. Die Ursache liegt bei Hetzner und ist von außen nicht
eindeutig bestimmbar.

| Fall | Befund | Wahrscheinlichste Ursache (unbestätigt) |
|---|---|---|
| P2 `GetBucketLocation` | **E1: Für den Besitzer 10 von 10 erlaubt** (`hel1`). Hetzner unterstützt die Aktion also; die Abweisung betrifft nur den Writer. Für Coolify unkritisch: `mc` fällt bei Abweisung still auf `us-east-1` zurück, und M2 sowie der Upload-Start gelangen trotzdem | Hetzner wertet die Policy für diese Anfrage anders aus oder nicht durchgehend |
| P4 `PutObject` SDK-Standard | Mitschnitt: kein `aws-chunked`, keine nachgestellte Prüfsumme. Ein gewöhnlicher signierter PUT mit den Kopfzeilen `x-amz-checksum-crc32` und `x-amz-sdk-checksum-algorithm`. Einziger Unterschied zu P5: CRC32-Kopfzeilen statt Content-MD5. Laut Quelltext ist das keine Rechtefrage; Prüfsummenfehler wären 400 bzw. 501, nicht 403. Der Besitzer lud so am 10.10. erfolgreich hoch | uneinheitliche Wirkung der Policy, oder eine Hetzner-eigene Behandlung der CRC32-Kopfzeilen bei fremden Schlüsseln |
| P6 Teil-Upload | Start erlaubt, danach Teil oder Abschluss abgewiesen; welcher, ist nicht aufgezeichnet. Teile mit Content-MD5, also derselben Kopfzeilen-Familie wie das erlaubte P5. Damit sind Pfad und Prüfsumme als gemeinsame Ursache ausgeschlossen | wie P4, oder eine Hetzner-eigene Prüfung der Teil-Schritte |
| P9 Löschmarker | Mitschnitt: DELETE ohne Versions-ID und ohne Bypass-Kopfzeile. Upstream prüft nur `s3:DeleteObject` | uneinheitliche Wirkung, oder Hetzner ordnet das Löschen in Object-Lock-Buckets `DeleteObjectVersion` zu, das ausdrücklich verboten ist |
| M3 `mc cp` | `mc` sendet in Object-Lock-Buckets Content-MD5 und `UNSIGNED-PAYLOAD`, keine nachgestellten Prüfsummen (aus dem Quelltext abgeleitet). Wie P6: Start gelang, ein späterer Schritt nicht. Dass ein Teil-Upload übrig blieb, liegt **an der Policy**: `s3:AbortMultipartUpload` fehlt, deshalb konnte `mc` den Upload nicht selbst abbrechen | wie P6 |

**Zwei Erklärungen bleiben, keine ist belegt:**
1. **Die Policy wirkt bei Hetzner nicht durchgehend.** Hetzner betreibt mehrere RGW-Cluster hinter einem eigenen Frontend. In
   hel1 lief laut Hetzner-Status zur Testzeit eine Störung mit Bucket-Migrationen.
   - Das erklärt das Muster aus erlaubten und abgewiesenen Anfragen.
   - Dagegen spricht: Drei Admin-Lesevorgänge sahen die Policy jedes Mal.
2. **Hetzner ordnet einzelne Anfragen eigenen Aktionen zu oder hat eine zusätzliche Prüfschicht.**

**Berichtigungen zu [backup-policy-test.md](backup-policy-test.md), Abschnitt 7d:**
- Die Vermutung „Übertragung mit nachgestellter Prüfsumme (`aws-chunked`)“ ist widerlegt.
- Die Vermutung „`Deny` auf `PutObjectRetention` greift bei Uploads“ widerspricht dem Quelltext.
- „Lesende Anfragen gelangen durchgehend“ stimmt nicht: P2 ist lesend und scheiterte.
- „Die Dateisicherung könnte keine größeren Dateien hochladen (P6)“ trifft nicht zu: Sie lädt jede Datei einzeln hoch. Für sie
  zählt P4.

**Neu erkanntes Risiko für das spätere Writer-Design:** Upstream-Ceph prüft Sperr- und Legal-Hold-Kopfzeilen beim **Hochladen**
nur gegen `s3:PutObject`. Das `Deny` auf `PutObjectRetention` und `PutObjectLegalHold` gilt nur für die eigenen Sperr-APIs.
- Ein Writer könnte also beim Hochladen lange COMPLIANCE-Sperren oder Legal Holds setzen.
- N4 belegt das Gegenteil nicht, denn dort scheiterte schon der einfache Upload.
- Bei Hetzner ist das ungeprüft.

**Für den Übergangsweg ohne Belang:** Er nutzt Projektschlüssel mit vollen Rechten. Als Besitzer funktionierten am 10.10.
SDK-Standard-Upload, Teil-Upload, Löschmarker und `mc cp`; heute zusätzlich `GetBucketLocation` (E1) sowie Upload und
Löschmarker im Vortest.

**Mögliche nächste Diagnose (jeweils eigene Freigabe, nicht ausgeführt):**
- **E2, ohne Policy-Änderung:** dieselben Anfrageformen mit dem Admin-Schlüssel wiederholen, mit Anfrage-IDs.
- **E3/E4, mit befristeter Test-Policy:**
  - jede Anfrageform 5× wiederholen, sofort und nach mehr als 15 Minuten Wartezeit;
  - Pfad × Prüfsummenart als Matrix;
  - Teil-Upload-Schritte einzeln aufzeichnen;
  - `mc` mit `--debug` und `MC_REGION=hel1`;
  - Anfrage-IDs für eine Support-Anfrage sammeln.
- **E5:** Principal für das ganze Projekt statt für den einzelnen Schlüssel.
- **E7:** Prüfen, ob Hetzner das ausdrückliche `Deny` überhaupt durchsetzt.
- **E8:** Sperr-Kopfzeilen beim Hochladen.

**Für eine spätere Writer-Policy** käme nach AWS- und Ceph-Regeln nur `s3:AbortMultipartUpload` hinzu. Solange die
Hetzner-Ursache offen ist, funktioniert aber auch das nicht verlässlich.

## 6. Nicht geprüft

- **Echtes Setzen von Standard-Sperre, Lifecycle, Policy-Entfernen und ACL-Zurücksetzen:** nur im Trockenlauf gezeigt. Am
  Test-Bucket wäre das eine dauerhafte Änderung (Bedingung 8). Dieselben Aufrufe für Sperre und Lifecycle funktionierten im
  Bucket-Test am 11.10.; geprüft wird das echte Setzen erst bei der Einrichtung des neuen Buckets (A4, A8), mit Rücklesen.
- **Der produktive Rahmen `run.sh`:** Er nimmt nur den Bucket `rent-base-backup` und lehnt Test-Schlüssel ab. Lokal ist er mit
  27 Fällen geprüft; der Testrahmen nutzt dieselbe Containerauswahl und Schlüsselübergabe.
- **Prüflauf als Coolify-Task:** erst nach dem Deploy (Phase C).
- **Große Mengen:** Hunderte Dumps, tausende Dateien. Laufzeit und Anzahl der Anfragen im vollen Lauf (eine
  Sperr- und eine ACL-Abfrage je aktueller Fassung) sind nur geschätzt.
- **`--lifecycle` mit mehr als 1000 Dumps:** Die Voraussetzungsprüfung liest nur die erste Seite. Für die Einrichtung (ein Dump)
  ist das ohne Belang.
- **Legal Holds:** prüft der Prüflauf nicht.

Hinweis zum Protokoll: Die Abschlusszeile lautet „unverändert bis auf die Lifecycle-Regel“. Ohne folgende HINWEIS-Zeile heißt
das, dass sich außerhalb des Laufpräfixes gar nichts geändert hat.

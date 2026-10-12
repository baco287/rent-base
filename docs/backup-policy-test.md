# Policy-Test: eingeschränkter Schreibschlüssel für Backups

**Stand 12.10.2026: vorbereitet und lokal geprüft, noch nicht ausgeführt.** Es ist kein Projekt und kein Schlüssel angelegt,
und am Test-Bucket ist nichts verändert. Jeder Schritt in Abschnitt 7 braucht deine Freigabe.

**Ziel:** Bevor der produktive Backup-Bucket entsteht, prüfen wir an `rent-base-backup-test`, ob Hetzner eine Bucket-Policy
für einen Schlüssel aus einem **eigenen Projekt** so durchsetzt, wie [backup-produktion-vorschlag.md](backup-produktion-vorschlag.md)
(Abschnitt 2) es vorsieht. Coolify und die Dateisicherung sollen hochladen und lesen können, aber nichts endgültig löschen und
keine Sperren, Regeln oder Policies ändern.

**Dateien:**
- [`scripts/backup-policy-test.mjs`](../scripts/backup-policy-test.mjs): Prüfungen, mit `--run` und `--finish`
- [`scripts/backup-test-env-setup.sh`](../scripts/backup-test-env-setup.sh): verdeckte Schlüsseleingabe, Modus `--writer`
- Rahmenskript auf dem Server: `/root/backup-policy-test/run.sh`. Es baut auf `backup-policy-test.mjs` auf, übernimmt den
  `mc`-Teil und räumt auf.

## 1. Welche Rechte gebraucht werden

| Wer | Aktion | Wofür | Beleg |
|---|---|---|---|
| Coolify | `s3:ListBucket` | „Validate Connection“ (`ListObjectsV2`), Wiederherstellung (`exists`, `size`) | Coolify-Quelltext 4.4.6, `S3Storage::testConnection`, `StartDatabaseImport` |
| Coolify | `s3:PutObject` | Upload mit `mc cp`, auch in Teilen | `DatabaseBackupJob`, Bucket-Test Prüfung 6 |
| Coolify | `s3:GetObject` | Wiederherstellung mit `mc cp` aus S3 | `StartDatabaseImport` |
| Coolify / `mc` | `s3:GetBucketLocation`, `s3:GetBucketObjectLockConfiguration` | `mc` fragt Region und Sperre ab | Der Test zeigt, ob es nötig ist |
| Dateisicherung | wie Coolify, dazu `s3:GetObjectVersion` | Lesen und Vergleichen | `scripts/backup-files.mjs` |
| Dateisicherung | `s3:DeleteObject` **nur unter `files/`** | legitime Löschungen als Löschmarker | [backup.md](backup.md), Abschnitt 4 |
| Coolify | **kein** `s3:DeleteObject` | S3-Aufbewahrung 0/0/0 löscht nichts; aufgeräumt wird per Lifecycle-Regel | `bootstrap/helpers/databases.php` |
| nur der Admin | `DeleteObjectVersion`, `PutObjectRetention`, `PutObjectLegalHold`, `BypassGovernanceRetention`, `PutBucketPolicy`, `DeleteBucketPolicy`, `PutLifecycleConfiguration`, `PutBucketVersioning`, `PutBucketObjectLockConfiguration` | endgültig löschen, Sperren und Regeln ändern | – |

**Test-Policy:** Sie gilt nur für den Writer-Testschlüssel (`arn:aws:iam:::user/p<Projekt-ID>:<Access-Key>`) und hat vier
Anweisungen.

| Anweisung | Recht | Gilt für |
|---|---|---|
| 1 | `ListBucket`, `GetBucketLocation`, `GetBucketObjectLockConfiguration` | den Test-Bucket |
| 2 | `PutObject`, `GetObject`, `GetObjectVersion` | **nur** `rb-test/policy/<Lauf>/w/*` |
| 3 | `DeleteObject` | nur `rb-test/policy/<Lauf>/w/files/*` |
| 4 | ausdrückliches `Deny` für alle Verwaltungsaktionen der letzten Tabellenzeile oben | den ganzen Test-Bucket |

## 2. Testfälle

Alle Objektzugriffe liegen unter `rb-test/policy/<Lauf>/`. `<Lauf>` ist eine eindeutige Kennung aus Zeitstempel und
Zufallsteil, etwa `20261013T130000Z-3fa91c`; das Präfix muss vor dem Lauf leer sein.

| Nr. | Prüfung | Erwartet | Bedeutung einer Abweichung |
|---|---|---|---|
| V0–V5 | Admin sieht nur den Test-Bucket. Writer stammt aus eigenem Projekt und hat ohne Policy keinen Zugriff. **Nachweislich keine Policy**, unmittelbar vor dem Setzen ein zweites Mal geprüft. Bekannter Stand von Sperre und Versionierung. Laufpräfix leer. Nicht vor dem 13.10.2026, 14:30 Uhr | erfüllt, sonst Abbruch (Exit 3); **nichts geändert** | falsches Projekt, unerwarteter Zustand oder zu früh |
| S0–S2 | Markierung ausgeben, Policy mit dem Admin-Schlüssel setzen und zurücklesen | gesetzt und als Policy dieses Laufs erkannt | Weicht die gelesene Form ab, entfernt das Skript sie sofort; Writer-Tests entfallen |
| P1 | Auflisten (wie Coolifys Verbindungstest) | erlaubt; bis zu 60 s Wartezeit auf die Wirkung | Policy wirkt nicht → weitere Writer-Tests entfallen |
| P2–P3 | Region und Standard-Sperre lesen | erlaubt | – |
| P4–P6 | Upload mit SDK-Prüfsumme, mit Content-MD5, in Teilen (6 MB) | erlaubt | Coolify bzw. Dateisicherung könnten nicht sichern |
| P7–P8 | Lesen, auch einer bestimmten Fassung | erlaubt, SHA-256 identisch | Wiederherstellung unmöglich |
| P9 | Löschen unter `w/files/` | erlaubt, **nur Löschmarker**, Fassung bleibt | Dateisicherung könnte legitime Löschungen nicht übernehmen |
| P10 | Upload neben dem erlaubten Bereich (`<Lauf>/aussen.txt`) | abgewiesen | Einschränkung auf einen Pfad wirkt nicht |
| N1 | Löschen außerhalb von `files/` | abgewiesen | Präfix-Einschränkung beim Löschen wirkt nicht (nur Löschmarker) |
| N2 | Fassung endgültig löschen, deren Sperre schon abgelaufen ist (eigene Prüffassung mit 60 s Sperre) | abgewiesen | **kritisch:** Writer könnte alte Backups nach Sperrende endgültig löschen |
| N3–N4 | Sperre auf 26 h verlängern; Upload mit eigener Sperre (26 h) | abgewiesen | Writer könnte Daten länger sperren |
| N5 | Legal Hold setzen | abgewiesen; sonst sofort aufgehoben und nachgeprüft | Writer könnte Daten unbefristet sperren |
| N6–N7 | Policy setzen (identischer Inhalt) bzw. löschen | abgewiesen; eine gelöschte Policy wird nur neu gesetzt, wenn danach nachweislich keine besteht | **kritisch:** Writer könnte sich selbst Rechte geben |
| N8–N9 | Lifecycle bzw. Standard-Sperre setzen, jeweils exakt der bekannte Inhalt | abgewiesen | **kritisch:** Writer könnte künftige Backups ungeschützt lassen |
| N10 | Versionierung aussetzen | abgewiesen (bei Object Lock ohnehin unmöglich) | 409 statt 403: Policy greift nicht, Object Lock verhindert es aber |
| N11–N13 | Policy, Sperrfrist und Fassungsliste lesen | abgewiesen (nicht gewährt) | nur lesend, geringe Bedeutung |
| K1–K4 | Admin-Kontrolle: Writer-Uploads tragen die Standard-Sperre; Bucket-Einstellungen und Policy unverändert; kein Legal Hold | erfüllt | – |
| K5–K6 | Kann der Admin Writer-Uploads lesen, und wem gehören sie? | lesbar; Besitzer Bucket-Projekt | Wichtig für Notfall-Wiederherstellung und Aufräumen, siehe Abschnitt 5 |
| M1–M6 | `mc` wie Coolify mit dem Writer-Schlüssel: eigene Buckets, Auflisten, Upload 17 MiB in Teilen, Rücklesen; `mc rm` und `mc rm --versions` außerhalb von `files/` | erlaubt bzw. abgewiesen | Coolify bräuchte weitere Rechte bzw. Einschränkung wirkt nicht |
| F1–F5 | Aufräumen: Legal Holds aufheben, Teil-Uploads abbrechen, Policy dieses Laufs entfernen, Writer ohne Zugriff, Bestand | erfüllt | siehe Rückweg |

## 3. Sicherheitszusagen und wie sie eingehalten werden

1. **Eine vorhandene Policy wird nie überschrieben oder entfernt.**
   - `--run` setzt nur, wenn die Abfrage ausdrücklich „keine Policy“ (`NoSuchBucketPolicy`) liefert. Diese Abfrage läuft
     zweimal, die zweite unmittelbar vor dem Setzen. Jede andere Antwort bricht ohne Änderung ab: vorhandene Policy,
     Netzwerk- oder Serverfehler.
   - `--finish` entfernt nur die Test-Policy **dieses Laufs**. Erkannt wird sie an genau vier Anweisungen mit unseren
     Kennungen, dem Writer-Testschlüssel als einzigem Principal, Ressourcen nur in diesem Bucket und der Laufkennung im
     Pfad, und nach Normalisierung muss sie genau der gesetzten Form entsprechen.
   - Eine fremde Policy oder die eines anderen Laufs bleibt unverändert und wird gemeldet. Das gilt auch, wenn sie nur um
     eine Bedingung (`Condition`) erweitert wurde.
   - Policy-Schreibaufrufe laufen mit genau einem Versuch, ohne automatische Wiederholung. Ein Sperrschloss (`flock`) lässt
     nur einen Lauf gleichzeitig zu.
   - Einzige Ausnahme: Liest das Skript direkt nach dem eigenen Setzen eine abweichende Form zurück, entfernt es sie sofort.
     Sekunden vorher war nachweislich keine Policy gesetzt, und ein paralleler Lauf ist ausgeschlossen.
2. **Nach einem Abbruch bleiben keine erweiterten Rechte zurück.**
   - Direkt vor dem Setzen gibt `--run` die Zeile `S0 Policy wird jetzt gesetzt` aus. Die Ausgabe wird laufend in
     `run-<Lauf>.out` mitgeschrieben.
   - Erscheint die Markierung, räumt das Rahmenskript **bei jedem Ende** auf: nach Erfolg, Fehler, Absturz des Containers,
     `docker kill` oder einem Signal an bash.
   - Das Aufräumen versucht es bei vorübergehenden Fehlern bis zu fünfmal mit Pause.
   - Jede Anfrage hat ein Zeitlimit (30 s), der ganze Lauf einen Watchdog (20 min), jeder `mc`-Befehl 10 min.
   - Der Lauf wird losgelöst von der SSH-Sitzung gestartet. Ein Verbindungsabbruch unterbricht ihn deshalb nicht.
   - Ohne Markierung wurde nichts gesetzt, und das Skript räumt nichts auf.
3. **Schreib- und Löschversuche nur im eindeutigen Testpräfix.**
   - Alle Objektzugriffe liegen unter `rb-test/policy/<Lauf>/`. Die Policy erlaubt dem Writer Objektzugriffe sogar nur unter
     `…/<Lauf>/w/`.
   - Bestehende Testobjekte unter `rb-test/` werden weder gelesen noch geschrieben. Ausnahme: die Bestandsliste beim
     Auflisten (nur lesend).
   - Bucket-Einstellungen werden nur mit exakt dem bekannten Inhalt angefasst, und auch das nur, wenn der Bucket ihn
     tatsächlich hat (N8, N9). Ausnahme ist N10, bei Object Lock ohnehin unmöglich.
   - Der Lauf startet frühestens am 13.10.2026 um 14:30 Uhr, also nach der letzten Lifecycle-Prüfung.
4. **Keine dauerhaft gesperrten oder unnötig kostenpflichtigen Objekte.**
   - Writer-Uploads tragen die Standard-Sperre von 1 Tag. Wird N3 oder N4 wider Erwarten erlaubt, sind es höchstens 26 Stunden.
   - Legal Holds laufen nicht ab. Deshalb hebt das Skript einen unerwartet gesetzten Hold sofort auf und prüft das nach.
     Beim Aufräumen sucht es Holds **vor** dem Entfernen der Policy: mit dem Admin, ersatzweise mit dem Writer, solange
     dieser noch Zugriff hat. Ein unklarer Zustand zählt als nicht aufgeräumt.
   - Unvollständige Teil-Uploads bricht der Admin ab, beim Aufräumen und beim späteren `--cleanup` des Test-Buckets.
   - Datenmenge: rund 24 MB für 1 bis 2 Tage, im enthaltenen Kontingent des Grundpreises.
5. **Keine Geheimnisse in Ausgaben oder Prozessargumenten.**
   - Schlüssel kommen nur über `--env-file` in die Container und über stdin an `mc`. Fehler meldet das Skript nur mit Namen
     und HTTP-Status, `mc`-Fehlertexte mit ersetzten Schlüsseln.
   - Die Policy wird nie ausgegeben, weil sie die Access-Key-ID des Writers enthält.
   - Ist das Docker-Debug-Protokoll an, bricht der Lauf ab.
   - Die Projekt-ID wird verdeckt eingegeben. So bleibt auch ein versehentlich zu früh eingefügter Schlüssel unsichtbar.

**Lokal nachgewiesen** mit erfundenen Schlüsseln und nachgebildetem S3:
- 33 Fälle des Einrichtungsskripts
- 21 Fälle zur Policy-Sicherheit: fremde, unklare, umformatierte und Alt-Policies, belegtes Präfix, Stichtag, Konfiguration
- 11 Fälle zur Ablauflogik des Rahmenskripts: Markierung, Abbruch, Signal, Wiederholungen
- Prüfungen, dass kein Schlüssel-Teilstück in einer Ausgabe erscheint

**Dazu zwei unabhängige Prüfrunden:** Prüfer sollten die Zusagen gezielt widerlegen. Die bestätigten Befunde sind behoben.

## 4. Wann ist der Lauf sauber beendet?

Nur wenn das Protokoll alle drei Bedingungen erfüllt:
- Es endet mit `== Ende Lauf <Lauf>: aufgeräumt`.
- `F1`, `F3` und `F4` stehen auf BESTANDEN.
- `F2` hat keine Teil-Uploads offen gelassen.

Erst dann dürfen die Zugangsdatei des Writers entfernt und, später, der Writer-Testschlüssel gelöscht werden.

## 5. Sicherer Rückweg

| Lage | Vorgehen |
|---|---|
| Lauf hängt sichtbar | `docker kill rb-policy-run-<Lauf>`. Danach räumt das Rahmenskript selbst auf. bash nicht beenden |
| Protokoll endet ohne „aufgeräumt“, oder der Server wurde neu gestartet | `bash /root/backup-policy-test/run.sh --finish-only <Lauf>`. Die Laufkennung steht in der ersten Protokollzeile. Wiederholbar; ändert nichts, wenn es nichts zu tun gibt. Braucht beide Zugangsdateien und einen laufenden App-Container |
| `F3`: Policy eines anderen Laufs | `--finish-only` mit der gemeldeten Kennung |
| `F3`: fremde Policy | nichts tun, mich hinzuziehen. Sie wird bewusst nicht angetastet |
| `F1`: Legal Hold weiterhin an oder unklar | **Writer-Testschlüssel NICHT löschen.** Gehören die Objekte dem Writer-Projekt (K6), kann nur er den Hold aufheben. Dann mit einer kurzzeitigen Policy, die nur diese Aktion erlaubt; eigene Freigabe |
| Server nicht erreichbar, Aufräumen scheitert dauerhaft | **Wenn F1 keinen Legal Hold meldet:** den Writer-Testschlüssel in der Console löschen. Die Policy gewährt dann niemandem mehr etwas und wird später mit `--finish-only` entfernt |

**Selbst im ungünstigsten Fall** gewährt die Policy nur dem Writer-Testschlüssel Rechte, nur am Test-Bucket, und Objektzugriffe
nur im Laufbereich. Produktions-Buckets sind nie betroffen.

**Reihenfolge zum Schluss:**
1. Test-Bucket aufräumen (`--cleanup` des Bucket-Tests, frühestens nach Ablauf der Sperren).
2. Bestätigen, dass auch die Writer-Uploads entfernt sind (K6).
3. Erst dann den Writer-Testschlüssel löschen.

Andernfalls blieben Objekte womöglich ohne einen Schlüssel zurück, der sie entfernen kann, und würden weiter berechnet.

## 6. Writer-Projekt und Testschlüssel in der Hetzner Console anlegen (du)

Die Bezeichnungen können je nach Console-Version leicht abweichen.

1. **Anmelden:** <https://console.hetzner.com>, mit Zwei-Faktor-Anmeldung.
2. **Neues Projekt:**
   - In der Projektübersicht auf **„+ Neues Projekt“** klicken.
   - Name: `Rent-Base Backup-Writer`
   - Mit **„Projekt hinzufügen“** bestätigen.
3. **Projekt öffnen und Projekt-ID notieren:**
   - Die Adresszeile lautet dann `https://console.hetzner.com/projects/<Zahl>/…`. Die **Zahl** ist die Projekt-ID.
   - Sie ist kein Geheimnis, kommt aber mit in den Passwortmanager.
4. **Nichts weiter anlegen:** keine Server, Volumes, Netzwerke oder Buckets, keine Mitglieder einladen.
   - Das Projekt trägt nur Schlüssel und kostet nichts.
   - Fragt die Console beim nächsten Schritt nach einem Bucket oder einer Object-Storage-Aktivierung: abbrechen und mir
     Bescheid geben.
5. **Schlüssel erzeugen:**
   - Im linken Menü **„Sicherheit“**, dann den Reiter **„S3-Zugangsdaten“** öffnen.
   - Auf **„Zugangsdaten generieren“** klicken.
   - Beschreibung: `writer-test`
   - Mit **„Zugangsdaten generieren“** bestätigen.
6. **Sofort sichern:** Access Key und Secret Key werden **nur jetzt** angezeigt. Beide über die Kopier-Schaltflächen in einen
   **neuen** Passwortmanager-Eintrag übernehmen.

   | Feld | Inhalt |
   |---|---|
   | Titel | `RentBase Writer TEST (hel1)` |
   | Felder | Projekt-ID, Access Key, Secret Key |
   | Notiz | „Nur Policy-Test am Bucket rent-base-backup-test. Nie in Coolify oder der App eintragen. Erst löschen, wenn der Test-Bucket aufgeräumt ist.“ |

7. **Abschließen:**
   - Den Dialog schließen.
   - Die Zwischenablage leeren; im Windows-Zwischenablageverlauf (Win+V) die Einträge löschen.
8. **Kontrolle:**
   - Unter „S3-Zugangsdaten“ steht genau ein Eintrag `writer-test`.
   - Unter „Object Storage“ des Writer-Projekts gibt es keinen Bucket.
9. **Mir Bescheid geben,** ohne Werte: „Writer-Projekt angelegt, Schlüssel im Passwortmanager.“

**Danach, sobald ich das neue Einrichtungsskript bereitgestellt habe** (Abschnitt 7, Schritt 2):

```
ssh -t rb bash /root/backup-env-setup.sh --writer
```

- Die Projekt-ID eingeben; sie bleibt unsichtbar und wird nach der Prüfung angezeigt.
- Dann Access Key und Secret Key einfügen; beide bleiben unsichtbar.
- Ziel ist `/root/backup-writer-test.env` (root, 600). Das Skript bricht ab, wenn versehentlich der Admin-Testschlüssel
  eingefügt wird oder die Datei schon existiert.

## 7. Ablauf und Freigaben

| Schritt | Wer | Freigabe nötig |
|---|---|---|
| 1 Writer-Projekt und Testschlüssel anlegen (Abschnitt 6) | du | ja |
| 2 Einrichtungsskript als neue Datei `/root/backup-env-setup.sh` bereitstellen, ohne Überschreiben. Die alte Fassung `/root/backup-test-env-setup.sh` entferne ich danach | ich | ja |
| 3 Writer-Schlüssel verdeckt eingeben | du | – |
| 4 Nachprüfung der Datei, nur lesend | ich | – |
| 5 Rahmenskript nach `/root/backup-policy-test/run.sh` legen (Verzeichnis root, 700) und Lauf losgelöst starten: `setsid nohup bash run.sh > log-<Zeit>.txt 2>&1 < /dev/null &`; Protokoll lesen. Frühestens am 13.10.2026 um 14:30 Uhr | ich | ja |
| 6 Ergebnis dokumentieren, Entscheidung über die produktive Policy | ich / du | – |
| 7 Test-Bucket aufräumen, dann Writer-Datei entfernen und Writer-Testschlüssel löschen (Reihenfolge aus Abschnitt 5) | ich / du | ja |

## 8. Wenn Hetzner Einschränkungen nicht durchsetzt

- **Folge:** Gelingen P- und N-Tests gleichermaßen, taugt die Policy nicht als Schutzschicht. Vorhandene Backups schützt
  weiterhin Object Lock COMPLIANCE.
- **Was dann ungeschützt wäre:**
  - künftige Backups vor Änderungen an Sperre und Lifecycle
  - Fassungen nach Sperrende vor endgültigem Löschen
- **Weiteres Vorgehen:** Wir stellen den Vorschlag um, z. B. auf einen täglichen lesenden Prüflauf der Bucket-Einstellungen mit Alarm.

**Bekannte Grenzen, unabhängig vom Ergebnis:**
- Ein Writer-Schlüssel kann in seinem **eigenen** Projekt Buckets anlegen. Das lässt sich nicht verbieten, schadet nur durch
  Kosten und ist an der Rechnung erkennbar.
- Gehören Writer-Uploads dem Writer-Projekt (K6), braucht die Produktion eine Lösung, damit der Admin sie im Notfall lesen und
  nach Sperrende entfernen kann. Die Lifecycle-Regel löscht unabhängig vom Besitzer.

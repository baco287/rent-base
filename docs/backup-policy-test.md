# Policy-Test: eingeschränkter Schreibschlüssel für Backups

**Stand 14.10.2026: ausgeführt (Lauf `20261014T072427Z-a3e4f3`), Ergebnis in Abschnitt 7d.**
- Der Writer konnte **nichts Verbotenes** tun.
- Aber mehrere **gewährte** Rechte wirkten nicht, und Coolifys `mc cp` scheiterte.
- Die Policy ist in dieser Form **nicht produktionstauglich**.
- Die Test-Policy ist entfernt. Jeder weitere Schritt braucht deine Freigabe.

**Ziel:** Bevor der produktive Backup-Bucket entsteht, prüfen wir an `rent-base-backup-test`, ob Hetzner eine Bucket-Policy
für einen Schlüssel aus einem **eigenen Projekt** so durchsetzt, wie [backup-produktion-vorschlag.md](backup-produktion-vorschlag.md)
(Abschnitt 2) es vorsieht. Coolify und die Dateisicherung sollen hochladen und lesen können, aber nichts endgültig löschen und
keine Sperren, Regeln oder Policies ändern.

**Dateien:**
- [`scripts/backup-policy-test.mjs`](../scripts/backup-policy-test.mjs): Prüfungen, mit `--run` und `--finish`
- [`scripts/backup-test-env-setup.sh`](../scripts/backup-test-env-setup.sh): verdeckte Schlüsseleingabe, Modus `--writer`
- [`scripts/backup-policy-test-run.sh`](../scripts/backup-policy-test-run.sh): Rahmenskript. Es startet die Wegwerf-Container,
  übernimmt den `mc`-Teil und räumt in jedem Fall auf.
- Auf dem Server liegen beide als `/root/backup-policy-test/run.sh` und `/root/backup-policy-test/backup-policy-test.mjs`.

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
| S0–S2 | Markierung ausgeben, Policy mit dem Admin-Schlüssel setzen und zurücklesen | gesetzt und als Policy dieses Laufs erkannt | Writer-Tests entfallen. Eine Variante **dieses** Laufs wird sofort entfernt; eine fremde Policy oder die eines anderen Laufs bleibt unverändert |
| P1 | Auflisten (wie Coolifys Verbindungstest) | erlaubt; bis zu 60 s Wartezeit auf die Wirkung | Policy wirkt nicht → weitere Writer-Tests entfallen |
| P2–P3 | Region und Standard-Sperre lesen | erlaubt | – |
| P4–P6 | Upload mit SDK-Prüfsumme, mit Content-MD5, in Teilen (6 MB) | erlaubt | Coolify bzw. Dateisicherung könnten nicht sichern |
| P7–P8 | Lesen, auch einer bestimmten Fassung | erlaubt, SHA-256 identisch | Wiederherstellung unmöglich |
| P9 | Löschen unter `w/files/` | erlaubt, **nur Löschmarker**, Fassung bleibt | Dateisicherung könnte legitime Löschungen nicht übernehmen |
| P10 | Upload neben dem erlaubten Bereich (`<Lauf>/aussen.txt`) | abgewiesen | Einschränkung auf einen Pfad wirkt nicht |
| N1 | Löschen außerhalb von `files/` | abgewiesen | Präfix-Einschränkung beim Löschen wirkt nicht (nur Löschmarker) |
| N2 | Fassung endgültig löschen, deren Sperre schon abgelaufen ist. Die Prüffassung (60 s Sperre, vom Admin hochgeladen) liegt unter `w/files/`, wo einfaches Löschen erlaubt ist; nur das `Deny` auf `DeleteObjectVersion` kann es verhindern | abgewiesen | **kritisch:** Writer könnte alte Backups nach Sperrende endgültig löschen. Nicht abgedeckt: Fassungen, die der Writer selbst hochgeladen hat |
| N3–N4 | Sperre auf 26 h verlängern; Upload mit eigener Sperre (26 h) | abgewiesen | Writer könnte Daten länger sperren |
| N5 | Legal Hold setzen. **Nur** wenn der Admin vorher nachweislich Holds auf Writer-Uploads ändern kann (wirkungsloses OFF); sonst „nicht prüfbar“ | abgewiesen; sonst sofort aufgehoben und nachgeprüft | Writer könnte Daten unbefristet sperren |
| N6–N7 | Policy setzen (identischer Inhalt) bzw. löschen. Nur wenn am Bucket nachweislich noch genau unsere Policy steht; je ein Versuch | abgewiesen; eine gelöschte Policy wird nur neu gesetzt, wenn danach nachweislich keine besteht | **kritisch:** Writer könnte sich selbst Rechte geben |
| N8–N9 | Lifecycle bzw. Standard-Sperre setzen, jeweils exakt der bekannte Inhalt. N8 entfällt, solange unter `rb-test/lc/` noch Fassungen liegen (Lifecycle-Beobachtung offen) | abgewiesen | **kritisch:** Writer könnte künftige Backups ungeschützt lassen |
| N10 | Versionierung aussetzen | abgewiesen (bei Object Lock ohnehin unmöglich) | 409 statt 403: Policy greift nicht, Object Lock verhindert es aber |
| N11–N13 | Policy, Sperrfrist und Fassungsliste lesen | abgewiesen (nicht gewährt) | nur lesend, geringe Bedeutung |
| K1–K4 | Admin-Kontrolle: Writer-Uploads tragen die Standard-Sperre; Bucket-Einstellungen und Policy unverändert; kein Legal Hold | erfüllt | – |
| K5–K6 | Kann der Admin Writer-Uploads lesen, und wem gehören sie? | lesbar; Besitzer Bucket-Projekt | Wichtig für Notfall-Wiederherstellung und Aufräumen, siehe Abschnitt 5 |
| M1–M6 | `mc` wie Coolify mit dem Writer-Schlüssel: eigene Buckets, Auflisten, Upload 17 MiB in Teilen, Rücklesen; `mc rm` und `mc rm --versions` außerhalb von `files/` | erlaubt bzw. abgewiesen | Coolify bräuchte weitere Rechte bzw. Einschränkung wirkt nicht. M6 ist nur ein Hinweis: die Standard-Sperre verhindert das Löschen ohnehin, aussagekräftig ist N2 |
| F1–F5 | Aufräumen: Legal Holds aufheben, Teil-Uploads abbrechen, Policy dieses Laufs entfernen, Writer ohne Zugriff, Bestand | erfüllt | siehe Rückweg |

## 3. Sicherheitszusagen und wie sie eingehalten werden

1. **Eine vorhandene Policy wird nie überschrieben oder entfernt.**
   - `--run` setzt nur, wenn die Abfrage ausdrücklich „keine Policy“ (`NoSuchBucketPolicy`) liefert. Diese Abfrage läuft
     zweimal, die zweite unmittelbar vor dem Setzen. Jede andere Antwort bricht ohne Änderung ab: vorhandene Policy,
     Netzwerk- oder Serverfehler.
   - Entfernt wird nur eine Policy, die nachweislich aus **diesem Lauf** stammt. Kennzeichen sind die Laufkennung mit
     Zufallsteil im Pfad und der Writer-Testschlüssel als Principal. Vor dem Lauf kann es eine solche Policy nicht gegeben
     haben.
     - Normalfall: Die gelesene Policy entspricht nach Normalisierung genau der gesetzten: vier Anweisungen mit unseren
       Kennungen, einziger Principal, Ressourcen nur in diesem Bucket.
     - Weicht sie ab, wurde sie aber erkennbar aus der Policy dieses Laufs abgeleitet (z. B. von Hetzner umformatiert oder
       nachträglich ergänzt), wird sie ebenfalls entfernt.
   - Eine fremde Policy oder die Test-Policy eines anderen Laufs bleibt unverändert und wird gemeldet. Das gilt auch, wenn
     sie direkt nach dem eigenen Setzen gelesen wird (S2).
   - Vor jedem Löschen liest das Skript den Zustand neu. Policy-Schreibaufrufe laufen mit genau einem Versuch, auch die
     Verbotsversuche N6/N7 des Writers. Diese laufen nur, wenn nachweislich noch genau unsere Policy steht.
   - Ein Sperrschloss (`flock`) lässt nur einen Lauf gleichzeitig zu. Ein neuer Lauf startet nicht, solange Container eines
     früheren Laufs existieren.
2. **Nach einem Abbruch bleiben keine erweiterten Rechte zurück.**
   - Direkt vor dem Setzen gibt `--run` die Zeile `S0 Policy wird jetzt gesetzt` aus. Die Ausgabe wird laufend in
     `run-<Lauf>.out` mitgeschrieben.
   - Erscheint die Markierung, räumt das Rahmenskript **bei jedem Ende** auf: nach Erfolg, Fehler, Absturz des Containers,
     `docker kill` oder einem Signal an bash.
   - Ohne Markierung entfällt das Aufräumen nur, wenn `--run` regulär vor dem Setzen endete (Exit 2 oder 3) und die
     Mitschrift vollständig ist. In jedem anderen Fall wird vorsorglich aufgeräumt; das ist harmlos.
   - In bestimmten Fällen folgt nach 10 Minuten ein zweiter Aufräumdurchgang. Er erfasst eine Policy, die erst verspätet
     sichtbar oder wirksam wird:
     - die gesetzte Policy wurde nicht als eigene zurückgelesen (S2; S2 wartet vorher bis zu 60 s auf die Sichtbarkeit),
     - ein späterer Policy-Schreibaufruf blieb ohne Antwort (Zeile `S9`),
     - die Mitschrift war gestört.
   - Der `mc`-Teil startet nur nach einem regulär abgeschlossenen `--run`, also mit Ergebniszeile und bestandenem S1, S2 und
     P1, und läuft höchstens 75 Minuten. Nach einem Abbruch wird sofort aufgeräumt.
   - Beim Aufräumen sind Legal Holds und Teil-Uploads auf 5 Minuten begrenzt; danach geht es in jedem Fall weiter zur Policy.
     Ist die Policy offen oder unklar, gilt immer „erneut versuchen“, auch neben einem bleibenden Befund.
   - Das Aufräumen versucht es bis zu fünfmal mit Pause, außer bei Erfolg und bei einem bleibenden Befund wie einer fremden
     Policy.
   - **Zeitlimits:**
     - Jede Anfrage: 30 s, wirksam erzwungen.
     - `--run`: Watchdog 20 min.
     - `--finish`: Watchdog 15 min, danach erneuter Versuch.
     - Jeder `mc`-Befehl: 10 min.
   - Der Lauf wird losgelöst von der SSH-Sitzung gestartet. Ein Verbindungsabbruch unterbricht ihn deshalb nicht.
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
   - Legal Holds laufen nicht ab. N5 versucht der Writer deshalb nur, wenn der Admin nachweislich Holds auf Writer-Uploads
     ändern kann. Einen unerwartet gesetzten Hold hebt das Skript sofort auf und prüft das nach.
   - Beim Aufräumen sucht es Holds **vor** dem Entfernen der Policy: mit dem Admin, ersatzweise mit dem Writer, solange
     dieser noch Zugriff hat. Ein unklarer Zustand zählt als nicht aufgeräumt.
   - Ist der Besitz von Writer-Uploads nicht nachweisbar (K6), wird er wie Writer-Besitz behandelt. Das ist wichtig für die
     Reihenfolge beim Löschen des Schlüssels (Abschnitt 5).
   - Unvollständige Teil-Uploads bricht der Admin ab, beim Aufräumen und beim späteren `--cleanup` des Test-Buckets.
   - Datenmenge: rund 24 MB für 1 bis 2 Tage, im enthaltenen Kontingent des Grundpreises.
5. **Keine Geheimnisse in Ausgaben oder Prozessargumenten.**
   - Schlüssel kommen nur über `--env-file` in die Container und über stdin an `mc`. Fehler meldet das Skript nur mit Namen
     und HTTP-Status, `mc`-Fehlertexte mit ersetzten Schlüsseln.
   - Die Policy wird nie ausgegeben, weil sie die Access-Key-ID des Writers enthält.
   - Der Lauf bricht ab, wenn der Docker-Debug-Modus oder das Log-Level `debug`/`trace` aktiv ist; sonst stünden die
     Container-Umgebungen im Daemon-Log.
     - Geprüft werden `docker info`, die Startparameter von `dockerd` (auch eine abweichende Konfigurationsdatei) und das
       Daemon-Protokoll der letzten 15 Minuten.
     - Ist das nicht prüfbar, bricht der Lauf ebenfalls ab.
   - Container schreiben keine Speicherabbilder (`--ulimit core=0`).
   - Die Projekt-ID wird verdeckt eingegeben, mit drei Versuchen. So bleibt ein zu früh eingefügter Schlüssel unsichtbar.
   - Nach einem Abbruch mitten in der Eingabe nimmt das Skript weitere Eingaben unsichtbar entgegen, bis „ende“ kommt. So
     landet kein Schlüssel nach dem Ende der Sitzung in der lokalen Shell.

**Lokal nachgewiesen** mit erfundenen Schlüsseln und nachgebildetem S3:
- 36 Fälle des Einrichtungsskripts
- 27 Fälle zur Policy-Sicherheit: fremde, unklare, umformatierte, veränderte und Alt-Policies, Abweichungen und verzögerte
  Sichtbarkeit direkt nach dem Setzen, belegtes Präfix, Stichtag, Konfiguration
- 17 Fälle zur Ablauflogik des Rahmenskripts: Markierung, gestörte Mitschrift, Abbruch vor und nach P1, Signal,
  Wiederholungen, zweiter Durchgang, `mc`-Start
- Prüfungen, dass kein Schlüssel-Teilstück in einer Ausgabe erscheint

**Dazu drei unabhängige Prüfrunden:** Prüfer sollten die Zusagen gezielt widerlegen, jeder Befund wurde gegengeprüft.
- Runde 1: 21 bestätigte Befunde
- Runde 2: 25 bestätigte Befunde
- Runde 3 (nur geänderte Stellen): 9 bestätigte Befunde

Viele Befunde überschneiden sich, alle sind behoben. Die lokalen Tests fanden zusätzlich einen Fehler, der sogar im Vorschlag
eines Prüfers steckte (`PIPESTATUS`).

## 4. Wann ist der Lauf sauber beendet?

Nur wenn das Protokoll alle drei Bedingungen erfüllt:
- Es endet mit `== Ende Lauf <Lauf>: aufgeräumt`.
- `F1`, `F3` und `F4` stehen auf BESTANDEN.
- `F2` hat keine Teil-Uploads offen gelassen.

Erst dann dürfen die Zugangsdatei des Writers entfernt und, später, der Writer-Testschlüssel gelöscht werden.

## 5. Sicherer Rückweg

| Lage | Vorgehen |
|---|---|
| Lauf hängt sichtbar | `docker kill rb-policy-run-<Lauf> rb-policy-mc-<Lauf> rb-policy-finish-<Lauf>`. Danach räumt das Rahmenskript selbst auf. bash nicht beenden |
| Neuer Lauf startet nicht: „Container eines früheren Laufs vorhanden“ | zuerst `--finish-only` mit dessen Kennung |
| Protokoll endet ohne „aufgeräumt“, oder der Server wurde neu gestartet | Aufräumen ebenfalls losgelöst starten: `cd /root/backup-policy-test && setsid nohup bash run.sh --finish-only <Lauf> > finish-<Zeit>.txt 2>&1 < /dev/null &`, dann die Datei lesen. Die Laufkennung steht in der ersten Protokollzeile. Wiederholbar; ändert nichts, wenn es nichts zu tun gibt. Braucht beide Zugangsdateien und einen laufenden App-Container |
| `F3`: Policy eines anderen Laufs | `--finish-only` mit der gemeldeten Kennung |
| `F3`: fremde Policy | nichts tun, mich hinzuziehen. Sie wird bewusst nicht angetastet |
| `F1`: Legal Hold weiterhin an oder unklar | **Writer-Testschlüssel NICHT löschen.** Gehören die Objekte dem Writer-Projekt (K6), kann nur er den Hold aufheben. Dann mit einer kurzzeitigen Policy, die nur diese Aktion erlaubt; eigene Freigabe |
| Server nicht erreichbar, Aufräumen scheitert dauerhaft | **Nur wenn** das Protokoll belegt, dass kein Legal Hold entstanden sein kann: `BESTANDEN  N5` (abgewiesen) oder „N5 … nicht prüfbar“ oder `BESTANDEN  F1` aus einem abgeschlossenen Aufräumen. Dann den Writer-Testschlüssel in der Console löschen; die Policy gewährt dann niemandem mehr etwas und wird später mit `--finish-only` entfernt. Fehlt dieser Beleg: Schlüssel behalten und warten, bis der Server erreichbar ist |

**Selbst im ungünstigsten Fall** gewährt die Policy nur dem Writer-Testschlüssel Rechte, nur am Test-Bucket, und Objektzugriffe
nur im Laufbereich. Produktions-Buckets sind nie betroffen.

**Reihenfolge zum Schluss:**
1. Test-Bucket aufräumen (`--cleanup` des Bucket-Tests, frühestens nach Ablauf der Sperren).
2. Bestätigen, dass auch die Writer-Uploads entfernt sind: `C Aufräumen` BESTANDEN, und `--inventory` zeigt unter
   `rb-test/policy/` weder Fassungen noch Legal Holds.
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

- Die Projekt-ID eingeben; sie bleibt unsichtbar und wird nach der Prüfung angezeigt (bis zu drei Versuche).
- Bricht das Skript ab, verlangt es „ende“, bevor es sich beendet. Bis dahin nichts weiter einfügen.
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
| 5 Verzeichnis `/root/backup-policy-test` (root, 700) anlegen. `run.sh` und `backup-policy-test.mjs` aus dem Repository ohne Überschreiben hineinkopieren und die Prüfsummen vergleichen. Lauf losgelöst starten: `setsid nohup bash run.sh > log-<Zeit>.txt 2>&1 < /dev/null &`; Protokoll lesen. Frühestens am 13.10.2026 um 14:30 Uhr | ich | ja |
| 6 Ergebnis dokumentieren, Entscheidung über die produktive Policy | ich / du | – |
| 7 Test-Bucket aufräumen, dann Writer-Datei entfernen und Writer-Testschlüssel löschen (Reihenfolge aus Abschnitt 5) | ich / du | ja |

## 7a. Freigabe vom 12.10.2026 und vorab festgelegte Kriterien

**Freigegeben:**
- Verzeichnis `/root/backup-policy-test` anlegen.
- Die beiden geprüften Skripte dorthin kopieren.
- Den Test losgelöst von der SSH-Sitzung ausführen, sobald alle Bedingungen erfüllt sind.

**Nicht freigegeben:**
- produktive Buckets anlegen oder ändern
- Testobjekte außerhalb des Laufpräfixes löschen
- Test-Zugangsdaten löschen oder rotieren
- Merge, Deployment, Änderungen an Datenbank oder App

**Bedingungen:**
1. Start frühestens am **13.10.2026 um 14:30 Uhr** (Europe/Berlin).
2. **Beide Lifecycle-Prüfungen** (12. und 13.10.) sind abgeschlossen und dokumentiert.
3. **Unerwartetes Lifecycle-Ergebnis:** stoppen und berichten.
4. **Vorher prüfen:** Zustand des Test-Buckets, Trennung der Zugangsdaten, keine Bucket-Policy.
5. **Nur** `rent-base-backup-test` verwenden.
6. Schreibversuche nur unter `rb-test/policy/<Lauf>/`.
7. Das geprüfte Skript und den Aufräummechanismus **unverändert** verwenden. Gelaufen wird mit dem Stand von Commit `e6ca6ab`, Prüfsummen werden beim Kopieren verglichen.
8. **Stoppen und berichten** bei unerwarteten Berechtigungen, fehlgeschlagener Isolation oder Problemen beim Entfernen der Test-Policy.

**Was als „erwartet“ gilt (festgelegt vor den Ergebnissen):**

| Prüfung | Weiter, wenn | Stopp und Bericht, wenn |
|---|---|---|
| Lifecycle 12.10. | `rb-test/lc/ablauf.txt` hat einen aktuellen Löschmarker und die alte Fassung noch (S3-Regel), **oder** ist noch unverändert (Hetzner verarbeitet später). Alles außerhalb von `rb-test/lc/` wie im Ausgangsstand: 5 Fassungen, Löschmarker nur auf `md5.txt`. Einstellungen gleich, keine Policy | etwas außerhalb von `rb-test/lc/` fehlt, ist neu oder verändert; Einstellungen oder Policy anders; fremde Buckets oder Objekte; Fehler |
| Lifecycle 13.10. | keine Fassung mehr unter `rb-test/lc/` (höchstens ein Löschmarker), **oder** Löschmarker gesetzt und die Fassung noch da (höchstens 1 Tag Verzögerung; N8 entfällt dann automatisch). Rest wie oben | nach zwei Tagen gar keine Wirkung; Fassung ohne Löschmarker verschwunden; Änderungen außerhalb von `rb-test/lc/`; Einstellungen oder Policy anders; Fehler |
| Vorprüfung Policy-Test | Admin sieht nur den Test-Bucket; keine Policy; beide Zugangsdateien root/600, getrennt, Schlüssel verschieden; kein Testverzeichnis und kein `rb-policy-`-Container | jede Abweichung |
| Policy-Test | Protokoll endet mit `== Ende Lauf <Lauf>: aufgeräumt`; F1, F3, F4 bestanden | Abbruch vor dem Setzen, `AUFRÄUMEN NICHT ABGESCHLOSSEN`, eine fremde Policy, ein Legal Hold oder eine **unerwartete Erlaubnis** (ein N-Test „ERLAUBT“). Dann keine weiteren Schritte ohne neue Freigabe |

## 7b. Lauf vom 13.10.2026: Abbruch in der Vorbedingung V1, nichts verändert

Separat freigegeben am 13.10.2026, unabhängig vom Lifecycle-Ergebnis. Das Lifecycle-FAIL bleibt bestehen.

**Vorprüfung vor dem Start:** alles erfüllt.
- **Bucket:** Admin sieht nur `rent-base-backup-test`; keine Bucket-Policy; Bestand 6 Fassungen und 1 Löschmarker.
- **Zugangsdaten:** beide root/600, getrennt, Schlüssel verschieden.
- **Laufende Prozesse:** keine anderen Läufe, Container oder Aufräumprozesse.
- **Skripte:** `run.sh` (SHA-256 `ae0bc604…`) und `backup-policy-test.mjs` (`a3743a32…`), unverändert seit Commit `38bdcfb`.
  - Lokal erneut 28 Sicherheitsfälle und 17 Ablauffälle bestanden.
  - Ein Testfall war nur zeitabhängig (Stichtag vergangen) und ist jetzt zeitunabhängig.
- **Bereitstellung:** Die Skripte wurden ohne Überschreiben nach `/root/backup-policy-test` (root, 700) kopiert, die Prüfsummen
  sind identisch.

**Lauf `20261013T212129Z-6e3793`** (gestartet 21:21:30 UTC, losgelöst):

```
BESTANDEN  V0 Isolation Admin: Admin-Schlüssel sieht nur rent-base-backup-test
ABBRUCH: Writer-Anmeldung abgelehnt (InvalidAccessKeyId (HTTP 403)). Nichts geändert.
== Policy wurde nicht gesetzt (Exit 3) – nichts geändert
```

- Die Policy wurde **nicht** gesetzt; es entstand kein Testobjekt und kein Container. Das Aufräumen entfiel, weil nichts gesetzt
  wurde.
- **Im Testverzeichnis bleiben:** `run.sh`, `backup-policy-test.mjs`, das Protokoll, die Mitschrift und die Sperrdatei. Keine
  davon enthält Zugangsdaten.

**Diagnose, nur lokal auf dem Server und ohne Werte auszugeben:**
- Weder der Writer-Access-Key noch der Writer-Secret-Key hat das Format (Länge, Zeichenart) der funktionierenden
  Admin-Schlüssel.
- Vertauscht sind sie nicht.

**Mögliche Ursachen:**
1. In der Datei stehen nicht die S3-Zugangsdaten `writer-test`, sondern andere Werte, z. B. ein API-Token des Projekts.
2. Der Schlüssel ist bei Hetzner nicht (mehr) gültig.
3. S3-Zugangsdaten eines Projekts ohne eigenen Bucket gelten am Endpunkt hel1 nicht. Das ist offen und Teil der Support-Anfrage
   ([hetzner-support-lifecycle.md](hetzner-support-lifecycle.md), Frage 6).

**Einordnung:** Unerwartetes Ergebnis, deshalb Stopp. Ein neuer Lauf braucht eine neue Freigabe.
- Die Datei `/root/backup-writer-test.env` lässt sich bewusst nicht überschreiben.
- Ein Ersatz mit korrekten Werten braucht deshalb zuerst deine Freigabe, die vorhandene Datei zu entfernen.

## 7c. Diagnose vom 14.10.2026: Eingabefehler in der Writer-Zugangsdatei

Nur lesend. Keine Werte, Teile, Längen, Signaturen oder Header ausgegeben; verglichen wurde ausschließlich im Speicher auf dem
Server.

| Prüfung | Ergebnis |
|---|---|
| Dateiformat | 5 Zeilen, kein BOM, keine CR. Endpunkt exakt `https://hel1.your-objectstorage.com`, Region `hel1`, Projekt-ID 16367501 |
| Writer-Access-Feld | nur Großbuchstaben/Ziffern, so lang wie ein Secret Key. **Besteht aus zwei gleichen Hälften und ist genau das Secret-Feld zweimal hintereinander** |
| Writer-Secret-Feld | nur Großbuchstaben/Ziffern, so lang wie ein Access Key: das Format eines Access Keys. Ein Secret Key hat gemischte Groß- und Kleinbuchstaben, wie der Admin-Secret-Key |
| `ListBuckets` Writer an hel1, fsn1, nbg1 | jeweils `InvalidAccessKeyId (HTTP 403)` |
| `ListBuckets` Admin an hel1, fsn1, nbg1 (Kontrolle) | überall angenommen; in hel1 sichtbar nur der Test-Bucket |

**Diagnose:**
- Beim verdeckten Einfügen wurde derselbe Wert, dem Format nach der Access Key, zweimal ins Access-Feld und einmal ins
  Secret-Feld eingefügt.
- Der Secret Key steht nicht in der Datei, und die Datei enthält ungültige Zugangsdaten.

**Abgrenzung der Ursachen:**

| Mögliche Ursache | Ausgeschlossen, weil … |
|---|---|
| Fehlende Berechtigung | Sie zeigt sich als `AccessDenied`, und erst nachdem der Schlüssel erkannt wurde |
| Fehlende Bucket-Policy | `ListBuckets` listet nur das eigene Projekt und braucht keine Policy; außerdem käme sonst ebenfalls `AccessDenied` |
| Isolation zwischen Projekten | würde sich als `AccessDenied` zeigen, nicht als unbekannter Schlüssel |
| Signatur- oder Endpunktfehler | Ein falscher Secret Key ergibt `SignatureDoesNotMatch`, aber erst bei bekannter Access-Key-ID. Endpunkt und Region stimmen exakt, und der Admin-Schlüssel funktioniert an allen drei Standorten |
| **Ungültige Zugangsdaten (Eingabefehler)** | **belegt:** Die vorgelegte Access-Key-ID ist der verdoppelte Wert; Hetzner kennt sie deshalb an keinem Standort |

**Lokaler Bestätigungsweg (optional, du selbst):** Prüfen, ob der einfach gespeicherte Wert, also das Secret-Feld, dein Access
Key ist. Einen Wert sieht dabei niemand; ausgegeben wird nur GLEICH oder VERSCHIEDEN:

```
ssh -t rb 'IFS= read -rs -p Access-Key-aus-dem-Passwortmanager-einfuegen: k; echo; v=$(grep -m1 ^WRITER_S3_SECRET_KEY= /root/backup-writer-test.env | cut -d= -f2-); [ x$k = x$v ] && echo GLEICH || echo VERSCHIEDEN; k=; v='
```

**Bestätigt am 14.10.2026:** Der Vergleich ergab `GLEICH`.
- Der einfach gespeicherte Wert, also das Secret-Feld, ist der Access Key aus dem Passwortmanager, und der stimmt laut Nutzer mit
  dem Eintrag `writer-test` in der Console überein.
- Die Diagnose „Access Key dreimal eingefügt, Secret Key fehlt“ ist damit belegt.

**Kleinster sicherer nächster Schritt** (braucht deine Freigabe, weil die Datei bewusst nicht überschrieben werden kann):
1. Die fehlerhafte Datei mit `shred -u /root/backup-writer-test.env` entfernen. Sie enthält keinen gültigen Secret Key; der
   Schlüssel `writer-test` bei Hetzner bleibt unberührt.
2. Neu eingeben: `ssh -t rb bash /root/backup-env-setup.sh --writer`. Je Abfrage **genau einmal** einfügen: zuerst die
   Projekt-ID, dann den Access Key, dann den **Secret Key**.
3. Lesende Anmeldeprobe (`ListBuckets` mit dem Writer-Schlüssel). Erst danach kommt eine neue Freigabe für den Policy-Test.

**Vorschlag gegen Wiederholung:** Das Einrichtungsskript soll ein Access-Feld aus zwei gleichen Hälften ablehnen, ebenso Werte,
die im jeweils anderen Feld enthalten sind. Die Kopie auf dem Server zu ersetzen braucht eine Freigabe.

**Umgesetzt am 14.10.2026 (Freigabe vom selben Tag):**
1. **Fehlerhafte Datei entfernt:** Erst wurde lesend bestätigt, dass `/root/backup-writer-test.env` exakt dem diagnostizierten
   Zustand entsprach: root:root 600, 5 Zeilen, hel1, Projekt 16367501, Access-Feld = Secret-Feld doppelt. Dann wurde sie mit
   `shred -u` entfernt.
   - Keine Reste; Admin-Datei und Vorversionen der Einrichtungsskripte unverändert.
   - Der Schlüssel `writer-test` bei Hetzner ist unberührt.
2. **Einrichtungsskript v2** (Commit `cb80d0c`), unabhängig gegengeprüft, 56 lokale Fälle bestanden:
   - Werte aus mehrfach demselben Stück werden abgelehnt.
   - Ein Access Key im Secret-Feld wird abgelehnt.
   - Admin-Schlüssel werden in beiden Writer-Feldern abgelehnt.
   - Die Admin-Datei wird robust gelesen.
   - Die Bucket-Abfrage im Admin-Modus ist verdeckt.
3. **Bereitgestellt** als `/root/backup-env-setup-v2.sh`, ohne Überschreiben: root:root 700, SHA-256 `4f3696a5…`, identisch mit
   dem Repository. Syntax auf dem Server in Ordnung; ein Probestart ohne Terminal bricht vor jeder Abfrage ab.

**Neu eingeben (du):** `ssh -t rb bash /root/backup-env-setup-v2.sh --writer`. Danach folgen die lesende Nachprüfung und die
Anmeldeprobe, jeweils mit Freigabe.

**Ergebnis 14.10.2026:**
- **Neu eingegeben** mit v2.
- **Lesende Nachprüfung:** root:root 600, fünf Namen, hel1, Projekt 16367501, keine Reste, getrennt von den Admin-Daten, alle
  Schlüssel verschieden.
  - Formatvergleich (nur ja/nein): Access Key und Secret Key haben jeweils das Format der Admin-Gegenstücke.
  - Kein Feld enthält mehrfach denselben Wert oder das andere Feld, nichts vertauscht.
- **Lesende Anmeldeprobe** (eine `ListBuckets`-Anfrage an hel1): **angenommen (HTTP 200), 0 eigene Buckets**.
  - Der Writer-Schlüssel ist also gültig.
  - Wie vorgesehen sieht er weder den Test-Bucket noch einen Produktions-Bucket. Das entspricht der Vorbedingung V1 des
    Policy-Tests.

## 7d. Lauf vom 14.10.2026: nichts Verbotenes erlaubt, aber gewährte Rechte wirken nur teilweise

**Freigabe:** am 14.10.2026 freigegeben, nach dem Hinweis auf den Lifecycle-Löschmarker vom selben Morgen erneut bestätigt.
**Das Lifecycle-FAIL vom 13.10. bleibt bestehen** und gilt nicht als erfolgreich.

**Lauf `20261014T072427Z-a3e4f3`:**
- Losgelöst gestartet am 14.10.2026 um 07:24:28 UTC, nach etwa 5 Minuten beendet.
- Skripte unverändert seit dem 13.10.; Prüfsumme im Protokoll `a3743a32…`.
- Protokoll: `/root/backup-policy-test/log-20261014T072426Z.txt`. Es endet mit `== Ende Lauf 20261014T072427Z-a3e4f3: aufgeräumt`.

### Ergebnis je Testfall

| Nr. | Ergebnis | Befund |
|---|---|---|
| V0–V5 | PASS | Admin sieht nur den Test-Bucket. Writer aus eigenem Projekt sieht 0 Buckets und ohne Policy keinen Zugriff. Vorher keine Policy, zweimal geprüft. Laufpräfix leer |
| S0–S2 | PASS | Policy gesetzt und als genau die Policy dieses Laufs zurückgelesen |
| P1 | PASS | `ListObjectsV2` erlaubt (Coolifys Verbindungstest) |
| P2 | **FAIL** | `GetBucketLocation` abgewiesen (AccessDenied 403), obwohl gewährt |
| P3 | PASS | `GetObjectLockConfiguration` erlaubt |
| P4 | **FAIL** | `PutObject` mit SDK-Standard-Prüfsumme unter `w/db/` abgewiesen (403), obwohl gewährt |
| P5 | PASS | `PutObject` mit Content-MD5 unter `w/files/` erlaubt |
| P6 | **FAIL** | Teil-Upload (6 MB, 2 Teile, Content-MD5) unter `w/db/` abgewiesen (403). **Gestartet werden konnte er**: Es gab eine Upload-ID, der Admin brach den Rest ab. Abgewiesen wurde also ein Teil oder der Abschluss |
| P7 | **FAIL** | Folgefehler: kein Objekt zum Lesen, weil P6 scheiterte |
| P8 | nicht prüfbar | P4 lieferte keine Versions-ID |
| P9 | **FAIL** | `DeleteObject` unter `w/files/` abgewiesen (403), obwohl gewährt. Die Dateisicherung könnte legitime Löschungen nicht übernehmen |
| P10 | PASS | Upload im Laufpräfix, aber außerhalb von `w/`, abgewiesen |
| N1 | PASS | Löschen außerhalb von `files/` abgewiesen |
| N2 | PASS | Fassung mit abgelaufener Sperre endgültig löschen (`DeleteObjectVersion`) abgewiesen |
| N3 | nicht prüfbar | keine Versions-ID aus P4 |
| N4 | PASS | Upload mit eigener Sperre (26 h) abgewiesen |
| N5 | nicht prüfbar | keine Versions-ID aus P4 |
| N6, N7 | PASS | Bucket-Policy setzen bzw. löschen abgewiesen |
| **N8** | **NICHT GETESTET** | entfällt, solange die Lifecycle-Beobachtung unter `rb-test/lc/` läuft |
| N9 | PASS | Standard-Sperre setzen abgewiesen |
| N10 | PASS | Versionierung aussetzen abgewiesen (403) |
| N11, N13 | PASS | Policy lesen, Fassungen auflisten abgewiesen |
| N12 | nicht prüfbar | keine Versions-ID aus P4 |
| K1, K4, K5, K6 | nicht ausgeführt | brauchen den Writer-Upload aus P4. **Offen bleibt damit, ob der Admin Writer-Uploads lesen kann und wem sie gehören** |
| K2, K3 | PASS | Bucket-Einstellungen und Policy während des Tests unverändert |
| M1, M2 | PASS | `mc` (coolify-helper 1.0.17) sieht keine eigenen Buckets; `mc ls` im erlaubten Bereich |
| M3 | **FAIL** | `mc cp` (17 MiB, wie Coolify) unter `w/coolify/`: „Insufficient permissions“. Ein begonnener Teil-Upload blieb übrig; F2 hat ihn abgebrochen |
| M4–M6 | nicht ausgeführt | entfallen nach M3 |
| F1–F4 | PASS | kein Legal Hold (2 Fassungen geprüft); 1 Teil-Upload abgebrochen; **Test-Policy entfernt, Bucket ohne Policy**; Writer wieder ohne Zugriff |
| F5 | Hinweis | 2 Fassungen, 0 Löschmarker im Laufpräfix |

**Nachkontrolle um 07:30 UTC, nur lesend:**
- Admin `GetBucketPolicy`: 5 von 5 Abfragen ergaben `NoSuchBucketPolicy` (404).
- Writer `ListObjectsV2`: 15 von 15 Abfragen über 75 Sekunden ergaben `AccessDenied` (403).
- Kein `rb-policy-`-Container und kein Prozess läuft mehr.

### Was Hetzner tatsächlich durchsetzt

- **Trennung der Projekte wirkt:** Ein Schlüssel aus dem Writer-Projekt hat ohne Policy keinen Zugriff (V2, F4, Nachkontrolle).
- **Wirksam gewährt:**
  - `ListObjectsV2` (P1, M2)
  - `GetObjectLockConfiguration` (P3)
  - einfacher `PutObject` mit Content-MD5 (P5)
  - der Start eines Teil-Uploads (P6, vermutlich auch M3)
- **Pfadgrenze:** Außerhalb von `w/` wurde ein Upload abgewiesen (P10), innerhalb angenommen (P5).
- **Nicht wirksam, obwohl gewährt:**
  - `GetBucketLocation` (P2)
  - `PutObject` mit SDK-Standard-Prüfsumme (P4)
  - Teile oder Abschluss eines Teil-Uploads (P6, M3)
  - `DeleteObject` (P9)
- **Verbotene Aktionen:** Alle geprüften wurden abgewiesen. Der Writer hat ohne Policy allerdings gar keine Rechte.
  - Belegt ist damit: Die Policy gibt diese Aktionen nicht frei.
  - Nicht belegt ist: ob Hetzner das ausdrückliche `Deny` selbst auswertet.
  - Für die Sicherheit zählt das Ergebnis: Der Writer konnte keine verbotene Aktion ausführen.

**Hinweis aus dem Vergleich:** P6 zeigt, dass `PutObject` unter `w/db/` grundsätzlich greift, denn der Start des Teil-Uploads
gelang. Zugleich laden der Admin-Schlüssel und `mc` mit SDK-Standard bzw. in Teilen hoch (Bucket-Test, Tag 0). Die Ursache
liegt also eher an der **Art der Anfrage** als am Pfad.

### Mögliche Ursachen

**Berichtigt am 14.10.2026** durch die Analyse in [backup-prod-vortest.md](backup-prod-vortest.md), Abschnitt 5: Die
Vermutungen „nachgestellte Prüfsumme (`aws-chunked`)“ und „`Deny` auf `PutObjectRetention`“ sind widerlegt bzw. widersprechen dem
Ceph-Quelltext. P2 ist eine lesende Anfrage und scheiterte. Die Dateisicherung lädt nicht in Teilen hoch; für sie zählt P4.
Die Tabelle bleibt als damaliger Stand stehen.

Nicht belegt; unterscheiden lassen sie sich nur mit einem weiteren Lauf oder einer Antwort des Supports.

| Vermutung | passt zu | passt nicht zu |
|---|---|---|
| Hetzner ordnet einzelne Anfragen anderen Aktionen zu als AWS, etwa Teil-Upload-Schritte, `GetBucketLocation` oder `DeleteObject` im versionierten Bucket mit Object Lock | P2, P6, P9, M3 | – |
| Übertragung mit nachgestellter Prüfsumme (`aws-chunked`, SDK-Standard und neuere `mc`) wird bei Schlüsseln aus einem fremden Projekt anders ausgewertet | P4, M3 | P2, P9 (ohne Inhalt) |
| Das ausdrückliche `Deny`, z. B. auf `PutObjectRetention`, greift bei Uploads in einen Bucket mit Standard-Sperre | P4, P6, M3 | P5 wurde angenommen |
| Die Policy wirkt nicht auf allen Knoten gleichzeitig | uneinheitliches Muster | Lesende Anfragen gelangen durchgehend; die Nachkontrolle war einheitlich |

### Verbleibender Bestand

**Im Laufpräfix `rb-test/policy/20261014T072427Z-a3e4f3/`:** 2 Fassungen, kein Löschmarker, kein Legal Hold, kein offener
Teil-Upload.

| Fassung | Hochgeladen von | Sperre |
|---|---|---|
| `w/files/ungesperrt/probe.txt` | Admin, für N2 | 60 s, abgelaufen |
| `w/files/probe.txt` | Writer, P5 | Standard-Sperre, bis etwa 15.10.2026, 07:25 UTC |

**Unverändert:**
- der ältere Bestand unter `rb-test/` (Bucket-Test, Lifecycle-Beobachtung)
- beide Zugangsdateien (root, 600)
- das Testverzeichnis `/root/backup-policy-test`: Skripte, Protokolle, Mitschriften, Sperrdatei, alles ohne Zugangsdaten

### Einordnung

**Der eingeschränkte Writer ist in dieser Form nicht produktionstauglich.**
- Er kann nichts Verbotenes.
- Aber Coolify könnte keine Datenbank-Backups hochladen (M3).
- Die Dateisicherung könnte keine größeren Dateien hochladen (P6) und keine Löschungen übernehmen (P9).

Es gab **keine unerwartete Erlaubnis**, und das Aufräumen ist vollständig. Deshalb kein Stopp nach Abschnitt 7a; weitere
Schritte nur mit neuer Freigabe:
1. **Ursache klären:** Fragen zu P2, P4, P6, P9 und M3 an die Support-Anfrage anhängen, oder einen Diagnoselauf freigeben.
   - Diagnoselauf: je Anfrageart mehrfach, Teil-Upload-Schritte einzeln, Prüfsummen-Modi.
   - Zusätzlich eine Policy-Variante ohne `Deny`-Anweisung.
   - Das braucht neuen Code, Gegenprüfung und eine Freigabe.
2. **Übergangsweg für den Start:** Entscheidung über Coolify mit einem Schlüssel aus dem Bucket-Projekt. Geschützt wäre er
   durch Object Lock COMPLIANCE und einen täglichen lesenden Prüflauf der Bucket-Einstellungen (Abschnitt 8).
3. **Testobjekte aufräumen:** frühestens nach Sperrende, also ab 15.10.2026, 07:30 UTC, mit `--cleanup`. Den
   Writer-Testschlüssel erst danach löschen.

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

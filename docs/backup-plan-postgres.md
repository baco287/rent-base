# Plan: erstes produktives PostgreSQL-Backup

**Stand 16.10.2026.** Fasst den Stand zusammen und legt fest, wie das erste produktive Backup entsteht. Gegengeprüft; die
Befunde sind eingearbeitet.

**Grundlagen:**
- [backup-voraussetzungen.md](backup-voraussetzungen.md), [backup-vergleich.md](backup-vergleich.md),
  [backup-erster-lauf.md](backup-erster-lauf.md), [hetzner-support-anfrage.md](hetzner-support-anfrage.md)
- Protokolle:
  - Bucket-Test ([backup-test-bucket.md](backup-test-bucket.md))
  - Policy-Test ([backup-policy-test.md](backup-policy-test.md), 7d)
  - Vortest und Analyse ([backup-prod-vortest.md](backup-prod-vortest.md))

**Ausgangslage am 16.10.2026, 07:25 UTC (lesend geprüft):**
- **Produktion:** gesund.
  - Seit heute 06:55–07:01 UTC läuft Commit `c19300d` von `main`, automatisch von Coolify deployt (nicht durch diese Sitzung).
    Er enthält keine Migrationen und keine Backup-Dateien.
- **Platte:** 46 % belegt (14.10.: 35 %).
  - Ursache ist der heutige Build: 3,5 GB Build-Cache und das neue App-Image mit rund 1 GB.
  - Frei sind 20 GB.
  - Coolify räumt erst ab 80 % automatisch auf.
- **Coolify:** 0 Datenbank-Backups, 0 S3-Speicher, 0 Scheduled Tasks. Der E-Mail-Kanal ist eingerichtet (15.10.).
- **Skripte:** Die Skripte auf dem Server sind gleich dem Repository (Prüfsummen). Kein Testcontainer läuft. Zweig
  `worktree-pilot-p0` lokal gleich Remote; keine fremden Änderungen am Zweig.

## 1. Lifecycle und Löschfristen

| Stufe | Beleg |
|---|---|
| Ablauf (`Expiration`): Löschmarker setzen | **wirkt, aber verspätet:** fällig 12.10. 00:00 UTC, ausgeführt 14.10. 01:30 UTC (49,5 Stunden später) |
| Alte Fassung endgültig entfernen (`NoncurrentVersionExpiration`) | **noch nicht belegt.** Am 16.10. 07:27 UTC noch vorhanden. Nach S3-Regeln seit 16.10. 00:00 UTC überfällig. Bei derselben Verzögerung wie beim Ablauf (einmal beobachtet) voraussichtlich um den 18.10. gegen 01:30 UTC; das ist eine Schätzung, keine Zusage |

**Folgen für die Produktion:**
- **Bedingung vom 13.10.:** Damals war festgelegt, dass ein belegter Aufräumweg **vor** produktiven Backups stehen muss. Dieser
  Plan schlägt vor, das erste Backup schon vorher anzulegen. Das ist **deine Entscheidung**.
  - Begründung: Das erste Dump erreicht seine Ablauffrist (31 Tage) erst nach etwa einem Monat.
- **Zeitplan für den Nachweis:**
  - **Entscheidung direkt nach der nächsten Lifecycle-Prüfung** (ab 18.10., auf Anordnung).
  - Ist `NoncurrentVersionExpiration` dann nicht belegt, wird der Aufräumlauf sofort umgesetzt.
  - Der Aufräumlauf ist heute nur ein Konzept für einen Writer-Schlüssel ([backup-aufraeumen-konzept.md](backup-aufraeumen-konzept.md)).
    Er muss erst an den Projektschlüssel angepasst, gebaut, geprüft und freigegeben werden. Dafür braucht es die Wochen bis
    Tag 31.
- **Löschfristen:**
  - Dumps erwartet nach etwa 33–38 Tagen weg; der Prüflauf schlägt ab Tag 39 an; Obergrenze rund 40 Tage.
  - Gelöschte Fotos und Ausweiskopien: etwa 15–33 Tage.
  - Rechtlich zu bestätigen (Schritt 4 unten).

## 2. Writer-Fälle P2, P4, P6, P7, P9, M3

Grundlage: Policy-Test vom 14.10., Mitschnitte der Anfragen, Ceph-RGW-Quelltext, Hetzner-Dokumentation und die lesende Probe E1
([backup-prod-vortest.md](backup-prod-vortest.md), Abschnitt 5).

| Fall | Was geschah | Fehlende Berechtigung? |
|---|---|---|
| P2 `GetBucketLocation` | Writer abgewiesen; Besitzer 10 von 10 erlaubt (E1) | nein: in Anweisung 1 erlaubt; P3 aus derselben Anweisung (andere Aktion) gelang |
| P4 `PutObject` (SDK-Standard, CRC32-Kopfzeilen) | Writer abgewiesen; Besitzer gleiche Form am 10.10. erlaubt | nein: `s3:PutObject` auf `w/*`; der Upload-Start unter demselben Pfad gelang (P6), mit derselben Aktion |
| P6 Teil-Upload | Start erlaubt, ein Teil oder der Abschluss abgewiesen | nein: alle drei Schritte prüfen `s3:PutObject` |
| P7 `GetObject` | nicht gesendet, weil P6 kein Objekt erzeugte | Folgefehler, keine eigene Aussage |
| P9 `DeleteObject` (Löschmarker) | Writer abgewiesen; kein gelungenes Gegenstück im Lauf | nein: `s3:DeleteObject` auf `w/files/*` erlaubt |
| M3 `mc cp` (Coolify) | Start erlaubt, späterer Schritt abgewiesen; Upload-Rest blieb liegen | für den Fehler nein; **für das Aufräumen ja: `s3:AbortMultipartUpload` fehlt**, deshalb konnte `mc` den Rest nicht entfernen |

**Welche Berechtigungen fehlen?**
- Die fünf gescheiterten Anfragen P2, P4, P6, P9 und M3 waren durch die Policy erlaubt, und keine nutzte eine verbotene Aktion.
- Es fehlt nur `s3:AbortMultipartUpload`, das `mc` zum Aufräumen braucht.
- Mehr Rechte zu vergeben (z. B. `s3:*`), ist nicht begründet und würde den Zweck aufheben.

**Warum klappt es mit dem Admin-Schlüssel, aber nicht mit dem Writer?**
- Der Admin-Schlüssel gehört zum Projekt des Buckets. Hetzner prüft ihn als Besitzer, ohne die Policy.
- Der Writer ist nur über die Bucket-Policy berechtigt, und diese Auswertung verhielt sich uneinheitlich. Für P4, P6 und M3
  gelang im selben Lauf eine Anfrage mit derselben Aktion (`s3:PutObject`); für P2 eine aus derselben Anweisung. Für P9 gibt es
  keinen Vergleich.
- **Wahrscheinlichste Erklärungen, beide unbestätigt:**
  1. Die Policy wirkt bei Hetzner nicht auf allen Knoten zugleich. Laut Recherche meldete die Hetzner-Statusseite zur Testzeit
     eine Störung in hel1 mit Bucket-Migrationen; selbst nachgeprüft habe ich das nicht.
  2. Hetzner hat eine eigene Zuordnung oder Prüfschicht für Schlüssel aus fremden Projekten.

**Gibt es einen sicheren Weg, Coolify mit eingeschränkten Zugangsdaten zu betreiben?**
- **Heute nicht.**
  - Dumps über 16 MiB lädt `mc` in Teilen hoch. Das ist unter der Policy gescheitert (M3).
  - Kleinere Dumps lädt `mc` einzeln mit Content-MD5 und `UNSIGNED-PAYLOAD` hoch. Diese Form wurde mit dem Writer nie getestet;
    P5 war Content-MD5 mit signiertem Payload.
  - Bei 19 MB Datenbankgröße (10.10.) ist ein Dump unter 16 MiB wahrscheinlich, Coolify nutzte also meist genau diesen
    ungetesteten Weg.
  - Eine Policy, die nur zufällig wirkt, hieße zufällig scheiternde Backups.
- **Möglich wird es, wenn:**
  - Hetzner die Ursache benennt, oder eine Diagnose mit befristeter Test-Policy (E3/E4) zeigt, dass es an der Wirkungsverzögerung
    liegt (dann nach dem Setzen warten und prüfen) oder an einer bestimmbaren Zuordnung (dann Policy anpassen);
  - **und** ein neuer Policy-Test besteht. Er braucht:
    - wiederholte Anfragen, `s3:AbortMultipartUpload`, E7 (`Deny` wirkt?) und E8 (Sperr-Kopfzeilen beim Hochladen);
    - die am 14.10. offenen Fälle P7/P8, N3, N5, N8, N12, K1–K6 und M4–M6;
    - Coolifys echten Upload-Weg für kleine Dumps.
  - Vor dem Umstieg wird außerdem der Prüflauf um die Writer-Policy erweitert ([backup-uebergang.md](backup-uebergang.md),
    Abschnitt 7).
- **Alternative ohne Policy, nur als Idee:** zwei Buckets.
  - Coolify schreibt mit einem Projektschlüssel in Bucket A.
  - Ein Lauf **außerhalb des Servers** kopiert täglich in Bucket B eines anderen Projekts, dessen Schlüssel nie auf dem Server
    liegt.
  - Schützt B auch bei einer Übernahme des Servers, kostet aber Schlüssel mit vollen Rechten an einem Ort außerhalb, mehr Betrieb
    und für B bis zu 24 Stunden Rückstand.
  - Nicht ausgearbeitet; eigene Entscheidung.

**Was muss Hetzner beantworten?** Die Fragen 1–8 und 1–5 in [hetzner-support-anfrage.md](hetzner-support-anfrage.md). Die
wichtigsten:
- Werden Policies für Schlüssel aus anderen Projekten für alle Aktionen unterstützt, auch für Multipart-Teilschritte und
  Löschmarker in Object-Lock-Buckets?
- Wirkt eine Policy überall sofort, oder mit Verzögerung?
- Was zeigen Hetzners Protokolle für den 14.10. 07:24–07:28 UTC?
- Wird ein ausdrückliches `Deny` ausgewertet?
- Wann werden Lifecycle-Regeln verarbeitet, und mit welcher Obergrenze?

**Kann der Support jetzt kontaktiert werden?** Ja. Der Entwurf enthält jetzt den Stand vom 16.10. und die korrigierten
Fälligkeiten. Vor dem Absenden ergänzt du nur die Projekt-ID von „Rent-Base Backup“ und, falls Hetzner sie verlangt, die
Access-Key-ID (nie den Secret Key) des Schlüssels `writer-test`.

## 3. Entscheidung: welcher Weg für das erste Backup

**Bevorzugt bleibt der Writer-Weg.** Er ist heute technisch blockiert (Abschnitt 2). Wie lange, hängt von Hetzner ab.

**Vorschlag: zeitlich begrenzter Übergangsweg** ([backup-uebergang.md](backup-uebergang.md)), parallel die Support-Anfrage.
- **Beginn:** mit dem ersten produktiven Backup.
- **Überprüfungstermin spätestens 15.12.2026:** Dann entscheidest du neu, auf der Grundlage der Hetzner-Antwort.
  - Bis zu einer Umstellung (fünf Schritte, [backup-uebergang.md](backup-uebergang.md), Abschnitt 7) laufen die Backups
    unverändert weiter.
  - Ein bestandener Policy-Test stellt nicht von selbst um.
- **Warum nicht warten:**
  - Heute gibt es außer dem Hetzner-Serverbackup keine Sicherung. Bestätigt ist es zuletzt mit deinem Screenshot vom 04.10.
  - Ein Datenbankfehler, etwa durch eine Migration bei einem künftigen Deploy, ließe sich nur beheben, indem der ganze Server
    auf den letzten nächtlichen Stand zurückgesetzt wird. Das ist nicht konsistent je Datenbank und betrifft auch App und
    Coolify.

### Risikobewertung des Übergangswegs

Bis Phase C prüft der Prüflauf nur täglich von Hand; stündlich und automatisch erst ab Phase C. Die Restrisiken gelten für
Phase A; wo sich Phase C unterscheidet, steht es dabei.

| Risiko | Eintritt | Schaden | Maßnahme | Restrisiko |
|---|---|---|---|---|
| Backup-Schlüssel gestohlen und anderswo benutzt | gering | Einstellungen für künftige Backups geändert; eine fremde Lifecycle-Regel wirkt schon beim nächsten Lauf (gegen 01:30 UTC); alte Fassungen nach Sperrende löschbar | Prüflauf (Phase A täglich von Hand, Phase C stündlich), `--wiederherstellen`, Schlüsseltausch ([backup-uebergang.md](backup-uebergang.md), Abschnitt 6) | **mittel** (Erkennung bis zu 24 Stunden); Phase C gering für Dumps, für Dateien hoch |
| Server oder Coolify übernommen | gering | wie oben, und der Prüflauf lässt sich abschalten | Prüflauf von außen bzw. Totmann-Signal (noch nicht eingerichtet); Zwei-Faktor-Anmeldung bei Hetzner (zu bestätigen) | **hoch**, bis eine Prüfung von außen läuft (wie [backup-vergleich.md](backup-vergleich.md)) |
| Policy sperrt alle Projektschlüssel aus | gering | Einstellungen nicht lesbar, nicht reparierbar | Prüflauf meldet „nicht lesbar“; dann hilft nur der Hetzner-Support | mittel |
| Unumkehrbarer Missbrauch (Sperren verlängern, Legal Holds, gesperrter Müll) | gering | Kosten, Löschpflichten nicht erfüllbar | nur Erkennung: verlängerte Sperren, Fremdobjekte, fremde Buckets, Größe; Legal Holds gar nicht | **mittel**, nur Erkennung |
| Hetzner-Konto übernommen | gering | alles, auch der Bucket | nicht abgedeckt; Zwei-Faktor-Anmeldung, Wiederherstellungscodes offline | mittel |
| Backup scheitert unbemerkt | mittel | Lücke in der Sicherung | Coolify „Backup failure“ per E-Mail; Prüflauf meldet Alter, Lücken und Sperre | gering; Totalausfall von Coolify erst mit Prüfung von außen |
| Platte läuft voll | gering | App und Datenbank fallen aus | 20 GB frei; lokale Aufbewahrung auf 24 Dumps begrenzen; „Server Disk Usage“ **vor** dem ersten Backup einschalten; Testdatenbank nach der Probe sofort löschen | gering |
| Wiederherstellungsprobe trifft die Produktion (falsche Ressource beim Import) | gering | Live-Daten mit dem Dump überschrieben | nur in die neue `rent-base-restore-test` importieren; den Ressourcennamen zweimal prüfen; Probe auf dem Produktionsserver, also mit gemeinsamem Platten- und Speicherplatz | gering bei Sorgfalt |
| Lifecycle entfernt alte Fassungen nicht | offen | Löschfristen überschritten | Entscheidung nach der Prüfung ab 18.10.; sonst Aufräumlauf, der erst gebaut werden muss; der Prüflauf meldet überfällige Fassungen | mittel, bis der Nachweis oder der Aufräumlauf steht |
| Datenabfluss (alle Dumps lesbar) | gering | vollständige Kundendaten | Schlüssel nur in Passwortmanager, Coolify und (Phase C) App-Umgebung; ACL-Prüfung | gleich wie beim Writer-Weg |
| Wiederherstellung funktioniert nicht | unbekannt | Backups wertlos | Wiederherstellungsprobe direkt nach dem ersten Backup | gering nach bestandener Probe |

### Schutzmaßnahmen im Übergangsweg

- **Object Lock:** COMPLIANCE 30 Tage als Standard-Sperre, gesetzt vor dem ersten Upload (A4). Der Prüflauf prüft jede neue
  Fassung (zu kurz oder verlängert).
- **Lifecycle und Löschfristen:**
  - vier Regeln (A8);
  - überwachte Obergrenze rund 40 Tage;
  - Nachweis oder Aufräumlauf wie in Abschnitt 1;
  - Fristen ins Löschkonzept.
- **Alarmierung:**
  - Coolify-E-Mail: eingerichtet; „Backup failure“, „Scheduled task failure“, „Server unreachable“ sind an.
  - **Vor dem ersten Backup:** die Test-Mail bestätigen, „Server Disk Usage“ einschalten.
  - Optional die Alarm-Probe mit einer leeren Wegwerf-Datenbank ([backup-erster-lauf.md](backup-erster-lauf.md), Abschnitt 3).
- **Schutz der Zugangsdaten:**
  - drei getrennte Schlüssel mit **gleichen vollen Rechten**; getrennt nur, damit jeder einzeln ersetzbar ist;
  - `admin` nur im Passwortmanager; nur du gibst ihn ein, verdeckt, und er lebt nur im Speicher eines Wegwerf-Containers;
  - `coolify-db` nur in Coolify (verschlüsselt gespeichert, kurz in Prozessargumenten sichtbar, bekannt);
  - `dateisicherung` erst in Phase C;
  - keine Test-Schlüssel in der Produktion; der Wrapper lehnt sie ab.
  - Schlüsseltausch beschrieben.
- **Externe Überwachung:**
  - Heute prüft UptimeRobot nur die Erreichbarkeit der App.
  - Vorschlag: ein Totmann-Dienst (z. B. Healthchecks.io, braucht ein Konto). Der Prüflauf meldet sich nach jedem erfolgreichen
    Lauf; bleibt die Meldung aus, kommt eine Mail. Das braucht eine kleine Ergänzung des Prüfskripts und gehört zu Phase C.
  - Unabhängig vom Server wäre zusätzlich ein Prüflauf über GitHub Actions nach dem Merge. Er braucht einen **vierten Schlüssel
    mit vollen Rechten** als GitHub-Secret.
  - Bis dahin prüfst du täglich mit `run.sh --check`. Das ist nicht unabhängig vom Server, aber besser als nichts.
- **Wiederherstellungsprobe:**
  - direkt nach dem ersten Backup in eine neue, nicht öffentliche Testdatenbank;
  - getrennt von der Live-Datenbank, aber auf demselben Server;
  - lesender Vergleich der Zeilenzahlen;
  - danach die Testdatenbank samt Volume löschen ([backup-erster-lauf.md](backup-erster-lauf.md), Abschnitt 4).

## 4. Schritte bis zum ersten produktiven PostgreSQL-Backup

| # | Schritt | Wer | Freigabe |
|---|---|---|---|
| 1 | **Entscheidungen:** Übergangsweg mit Überprüfungstermin 15.12.2026; erstes Backup vor dem Lifecycle-Nachweis (Abschnitt 1); Projekt „Rent-Base Backup Produktion“ (empfohlen) | du | – |
| 2 | Test-Mail aus Coolify bestätigen; **„Server Disk Usage“ einschalten**; „Backup Success“ vorübergehend an | du | – |
| 3 | Hetzner-Serverbackup und Zwei-Faktor-Anmeldung in der Console bestätigen ([betrieb-absicherung.md](betrieb-absicherung.md), Abschnitt 2) | du | – |
| 4 | Auftragsverarbeitungsvertrag mit Hetzner prüfen; Löschfristen rechtlich bestätigen oder bewusst nach dem ersten Backup nachholen | du | ◆ |
| 5 | Support-Anfrage absenden (Projekt-ID ergänzen) | du | – |
| 6 | A1: Projekt, Bucket `rent-base-backup` (hel1, Object Lock), Schlüssel `admin`, `coolify-db`, `dateisicherung` | du | – |
| 7 | A3 `--pruefen` → A4 `--sperre` | du | „ja“ im Skript |
| 8 | A5 S3 Storage in Coolify. A6 Zeitplan `17 * * * *` UTC, S3 an, **Aufbewahrung S3 0/0/0, lokal 24/0/0**. „Backup Now“ | du | – |
| 9 | A7 `--pruefen` (Dump gesperrt, Präfix), A8 `--lifecycle`, A9 `--check`. Nach dem nächsten Lauf (Minute 17) erneut `--pruefen`: zwei Dumps, beide gesperrt. Abbruchregeln: [backup-erster-lauf.md](backup-erster-lauf.md), Abschnitt 5 | du | „ja“ im Skript |
| 10 | Wiederherstellungsprobe (A10) | du / ich | **ja** |
| 11 | Ab dann täglich `--check` bis Phase C. Lifecycle-Prüfung am Test-Bucket ab 18.10. | du (`--check`) / ich (Test-Bucket, auf Anordnung) | – |

Wählst du statt des neuen Projekts „Rent-Base Backup“: vorher den Test aufräumen und die Test-Schlüssel löschen (beides mit
Freigabe). Für den Prüflauf dann `BACKUP_CHECK_ERLAUBTE_BUCKETS` setzen.

**Danach bis zu den Dateibackups (Phase B und C):**
1. **Pilot-Deploy:** Das ist der Merge von PR #1 nach `main`. Coolify deployt `main` sofort automatisch, einschließlich der
   Migrationen des Zweigs.
   - Vorher `c19300d` in den Zweig übernehmen und an `rent-base-db` ein Backup auslösen ([deployment.md](deployment.md)).
   - Beides nur mit deiner Freigabe.
2. App-Umgebung `BACKUP_S3_*` mit `dateisicherung`, `BACKUP_DUMP_PREFIX`, `BACKUP_GRACE_DAYS=7`; Neustart mit Freigabe.
3. Scheduled Tasks: Aufräumlauf (vorher `--dry-run`), Dateisicherung, Prüflauf stündlich und täglich.
4. Erster echter Lauf der Dateisicherung; sie lief bisher nur gegen Attrappen.
5. Vollständiger Wiederherstellungstest mit `check-restore.mjs`.
6. Entscheidungen:
   - rollende Sperre für Dateien über 30 Tage (vorher Test am Test-Bucket);
   - Totmann-Signal bzw. Prüflauf von außen;
   - Versionierung des App-Buckets.

# Backup-Test-Bucket einrichten (Option A, getrenntes Projekt)

Ziel: Bevor wir den produktiven Backup-Bucket anlegen, prüfen wir an einem **getrennten** Test-Bucket, ob Object Lock,
Versionierung, Aufbewahrung und Coolifys Upload-Weg so funktionieren wie geplant. Der Test berührt weder die laufende App
noch die Datenbank noch Coolify-Einstellungen. Echte Kundendaten kommen nicht in den Test-Bucket.

Dauer für dich: etwa 10 Minuten. Du brauchst den Hetzner-Login und den SSH-Zugang zum Server
(`ssh rb` in einem Terminal auf deinem Rechner).

**Kosten:** Die Grundgebühr des Object Storage fällt laut Hetzner einmal pro Konto an und wird für `rent-base-files` schon
bezahlt. Der Test legt rund 35 MB Testdaten ab. Es entstehen praktisch keine Zusatzkosten.

---

## Schritt 1: Eigenes Projekt anlegen

1. In der **Hetzner Console** oben die Projektauswahl öffnen → **Neues Projekt**.
2. Name: `Rent-Base Backup Test` → anlegen.

Warum eigenes Projekt: S3-Zugangsdaten gelten bei Hetzner für **alle** Buckets eines Projekts. Nur in einem eigenen Projekt
kann der Testschlüssel die Produktionsdateien nicht sehen. Das prüft das Testskript als Erstes und bricht sonst ab.

## Schritt 2: Bucket mit Object Lock anlegen

Im neuen Projekt: **Object Storage** → **Bucket erstellen**.

| Feld | Eintrag |
|---|---|
| Standort | **Helsinki (hel1)** |
| Name | `rent-base-backup-test-20261010`. Nur Kleinbuchstaben, Ziffern und Bindestrich, weltweit eindeutig, **muss „test“ enthalten**. Ist der Name vergeben, eine Ziffer anhängen |
| Sichtbarkeit | **Privat** |
| Object Lock | **Aktiviert**. Wichtig: geht nur jetzt beim Anlegen, nicht nachträglich |
| Standard-Aufbewahrung (falls angeboten) | **leer lassen**. Das Testskript setzt selbst 1 Tag COMPLIANCE |

→ **Erstellen**. Die Versionierung schaltet Hetzner mit Object Lock automatisch ein.

## Schritt 3: S3-Zugangsdaten für dieses Projekt erzeugen

Im selben Projekt: **Sicherheit** → Reiter **S3-Zugangsdaten** → **Zugangsdaten generieren** → Beschreibung `backup-test`.

Access Key und Secret Key werden **nur einmal** angezeigt. Beide sofort im Passwortmanager speichern.

## Schritt 4: Zugangsdaten sicher auf den Server legen

Die Werte kommen **nur** in eine Datei auf dem Server, die ausschließlich root lesen kann. Nicht in den Chat, keine E-Mail,
kein Repository. Das Einrichtungsskript [`scripts/backup-test-env-setup.sh`](../scripts/backup-test-env-setup.sh) liest die
Schlüssel verdeckt ein und schreibt sie nur mit Shell-Builtins in die Datei. So landen sie nicht in Befehlsargumenten, in der
Umgebung, in der History oder in einer Ausgabe. Eine vorhandene Datei überschreibt es nie.

1. Vorbereitung (Claude, nach deiner Freigabe):
   - Nur lesend prüfen, dass `/root/backup-test.env` noch nicht existiert und keine Tastatur-Protokollierung (`pam_tty_audit`) aktiv ist.
   - Das Skript als `/root/backup-test-env-setup.sh` auf den Server kopieren, ohne Überschreiben.
2. In einem Terminal auf deinem Rechner eingeben:
   ```
   ssh -t rb bash /root/backup-test-env-setup.sh
   ```
   Die Web-Konsole der Hetzner Console eignet sich schlecht, weil Einfügen dort oft nicht zuverlässig funktioniert.
3. Bucket-Name eingeben (sichtbar, kein Geheimnis).
4. Access Key aus dem Passwortmanager einfügen (Strg+V oder Rechtsklick) und Enter drücken. Es erscheint nichts, das ist
   gewollt. Danach den Secret Key genauso.
5. Das Skript zeigt nur Besitzer, Rechte (`root:root 600`) und welche der fünf Variablen vorhanden sind.
6. Zwischenablage leeren. Nutzt du den Windows-Zwischenablageverlauf (Win+V), die beiden Einträge dort löschen.

Bei Tippfehlern oder Abbruch (Strg+C) entsteht keine Datei; das Skript einfach erneut starten. Ein falscher, aber gültig
aussehender Schlüssel fällt in Prüfung 0 des Testprotokolls auf: Anmeldung abgelehnt, nichts geschrieben. Dann melde ich
mich, du entfernst die Datei mit `shred -u /root/backup-test.env` und richtest sie neu ein.

## Schritt 5: Mir Bescheid geben

Kurze Nachricht genügt, ohne Schlüssel: „Bucket `<Name>` in hel1 mit Object Lock angelegt, Datei liegt auf dem Server.“

---

## Was danach passiert

**Tag 0 (etwa 2 Minuten, Freigabe liegt vor):** Ich starte das Testskript ([`scripts/backup-bucket-test.mjs`](../scripts/backup-bucket-test.mjs)).

- **Ausführung:** in zwei Wegwerf-Containern, die danach automatisch verschwinden. Prüfungen 0–5 und 7 laufen mit dem AWS SDK, Prüfung 6 mit demselben `mc`, das Coolify für Backups nutzt.
- **Ablage:** Das Skript schreibt nur unter `rb-test/` im Test-Bucket.
- **Abbruch vor dem Schreiben:** Lehnt Hetzner die Anmeldung ab oder ist der Bucket für den Schlüssel nicht sichtbar, endet der Lauf
  nach Prüfung 0 mit Exit 3. Dann ist nichts geschrieben, auch Prüfung 6 läuft nicht.
- **Keine Schlüssel in Ausgaben oder Prozessargumenten:**
  - Fehler meldet das Skript nur mit Namen und HTTP-Status. S3-Fehlertexte können `AWSAccessKeyId` enthalten und werden deshalb nicht ausgegeben.
  - Prüfung 6 übergibt die Schlüssel über stdin an `mc alias set`, nicht als Argumente. Fehlertexte von `mc` erscheinen nur mit ersetzten Schlüsseln.
  - Coolify selbst übergibt sie als Argumente (siehe [betrieb-absicherung.md](betrieb-absicherung.md), Abschnitt 6). Für das Prüfergebnis
    spielt das keine Rolle: Binary, Alias-Konfiguration und `mc cp` sind dieselben.

| Nr. | Prüfung |
|---|---|
| 0 | Isolation: Testschlüssel sieht keinen Produktions-Bucket (sonst Abbruch) |
| 1 | Object Lock aktiv, Versionierung an und nicht abschaltbar |
| 2 | Standard-Sperre COMPLIANCE 1 Tag |
| 3 | Uploads mit und ohne Prüfsumme; Sperre am Objekt |
| 4 | In der Sperrzeit: nicht löschbar, nicht verkürzbar, nicht herabstufbar; Löschen erzeugt nur einen Löschmarker; Überschreiben legt eine neue Fassung an |
| 5 | Lifecycle-Regel annehmen (Wirkung erst nach 24 h) |
| 6 | Upload, Rücklesen und Löschversuch mit `mc` wie Coolify |
| 7 | Rundlauf 1 MB und 12 MB in Teilen, SHA-256 identisch |

**Tag 1 (frühestens 24 Stunden später):** `--after-retention`. Lässt sich ein Testobjekt nach Ablauf der Sperre löschen? Hat die
Lifecycle-Regel gewirkt? Hetzner verarbeitet Regeln eventuell mit Verzögerung, dann noch einmal am Tag 2.

**Aufräumen (nach Ablauf der Sperre, mit deiner Freigabe):**
1. `--cleanup` entfernt alle Testobjekte unter `rb-test/`.
2. Danach löschst du in der Console den leeren Bucket und die Test-S3-Zugangsdaten.
   - Umgesetzt wurde der Test im Projekt `Rent-Base Backup`, in dem später der produktive Bucket entstehen soll.
   - Das Projekt bleibt deshalb bestehen. Die Test-Zugangsdaten müssen aber **vor** dem Anlegen von `rent-base-backup` gelöscht sein.
3. Auf dem Server die Datei entfernen: `shred -u /root/backup-test.env`.

## Was das Ergebnis für die Produktion bedeutet

| Ergebnis | Folge für den produktiven Backup-Bucket |
|---|---|
| Prüfungen 1, 2 und 4 bestanden | Object Lock COMPLIANCE schützt vorhandene Backups wie geplant, auch gegen gestohlene Schlüssel. Ein Projektschlüssel kann aber Standard-Sperre und Lifecycle-Regeln für **künftige** Objekte ändern. Coolify bekommt deshalb einen Schlüssel ohne diese Rechte |
| Lifecycle wirkt (Tag 1/2) | Alte Backups und Löschmarker verschwinden nach Ablauf automatisch |
| Lifecycle wirkt nicht | Aufräumen alter Backups muss anders gelöst werden, z. B. regelmäßig nach Ablauf der Sperre |
| Prüfung 6 bestanden | Coolify kann in einen gesperrten Bucket hochladen |
| Löschversuch in Prüfung 6 abgelehnt | Coolifys eigene Aufbewahrung kann innerhalb der Sperre nichts löschen. Ein einfaches Löschen setzt nur einen Löschmarker, die Fassung bleibt. Die Coolify-Aufbewahrung wird deshalb mindestens so lang eingestellt wie die Sperre |

Noch nicht Teil dieses Tests:
- **Schreibschlüssel aus einem dritten Projekt über eine Bucket-Policy** (`backup-strategie.md`). Das folgt beim produktiven Bucket, falls wir es nutzen.
- **„Test connection“ und ein echtes Datenbank-Backup aus Coolify.** Das braucht eine Coolify-Einstellung und wird gesondert freigegeben.

## Ergebnis Tag 0 (10.10.2026, 11:14 UTC)

Bucket `rent-base-backup-test` in hel1, Projekt „Rent-Base Backup“. **SDK-Teil: 19 bestanden, 0 nicht ok, 1 Hinweis. Prüfung 6: 4 bestanden, 1 Hinweis.** Gesamt-Exit 0.

| Nr. | Ergebnis |
|---|---|
| 0 | Schlüssel sieht nur `rent-base-backup-test` (mit SDK und mit `mc` geprüft) |
| 1a–1c | Object Lock aktiv, Versionierung `Enabled`; Abschalten abgelehnt (`InvalidBucketState`, HTTP 409) |
| 2 | Standard-Sperre COMPLIANCE 1 Tag gesetzt und zurückgelesen |
| 3a–3b | Upload mit SDK-Prüfsumme und mit Content-MD5 angenommen |
| 3c | Hinweis: Upload **ohne** Prüfsumme wird ebenfalls angenommen. Kein Werkzeug scheitert also an fehlenden Prüfsummen |
| 3d | Sperre am Objekt: COMPLIANCE bis 11.10.2026 11:13:53 UTC |
| 4a–4e | Version löschen, Governance-Umgehung, Mehrfach-Löschen, Verkürzen, Herabstufen: alle abgelehnt (`AccessDenied`, HTTP 403) |
| 4f | Löschen ohne Version setzt nur einen Löschmarker, die gesperrte Fassung bleibt unverändert abrufbar |
| 4g | Überschreiben legt eine neue Fassung an, die alte bleibt |
| 5a–5b | Lifecycle-Regel trotz Object Lock angenommen und zurückgelesen; Testobjekt abgelegt |
| 6a | `mc` RELEASE.2026-09-06T02-44-40Z aus coolify-helper 1.0.17 nimmt die Schlüssel über stdin an |
| 6b–6c | 20 MB mit `mc cp` hochgeladen (Teil-Upload) und rückgelesen, SHA-256 identisch |
| 6d | Hinweis: `mc retention info` liefert nur die Kopfzeile. Die Sperre selbst belegen 3d und 6e |
| 6e | `mc rm --versions --force` abgelehnt (`AccessDenied`), die Fassung bleibt |
| 7a–7b | 1 MB einzeln und 12 MB in drei Teilen: SHA-256 identisch |

**Offen:**
- A1 Löschen nach Ablauf der Sperre und A2 Wirkung der Lifecycle-Regel: `--after-retention` frühestens am 11.10.2026 um 11:15 UTC.
- Das Aufräumen folgt erst nach Prüfung der Ergebnisse und mit Freigabe.

## Ergebnis Tag 1 (11.10.2026, 17:39 UTC)

**Vorab nur lesend (`--inventory`):**
- Bestand wie am Ende von Tag 0: 9 Fassungen und 1 Löschmarker (aus 4f), alle unter `rb-test/`.
- Keine Sperre mehr aktiv; die letzte endete am 11.10. um 11:14:07 UTC.
- Einstellungen unverändert, keine Bucket-Policy. Es gab keine Abweichung.

**Nachtest (`--after-retention`):** SDK-Teil 7 bestanden, 0 nicht ok. `mc`-Teil 2 bestanden. Gesamt-Exit 0.

| Nr. | Frage | Ergebnis |
|---|---|---|
| 0, B1–B4 | Isolation und Einstellungen | PASS. Nur der Test-Bucket sichtbar; COMPLIANCE 1 Tag; Versionierung an; Lifecycle-Regel vorhanden; keine Policy |
| A0 | Ist die Sperre abgelaufen? | PASS. Keine der 9 Fassungen mehr gesperrt |
| A1 | Lässt sich die Ablaufprobe jetzt löschen? | PASS. Fassung endgültig entfernt, kein neuer Löschmarker |
| A1b | Lässt sich die in 4a–4e geschützte `md5.txt` jetzt löschen? | PASS. Fassung endgültig entfernt. Übrig bleibt nur der Löschmarker aus 4f |
| M1–M4 | Verhält sich `mc` anders als das SDK? | PASS, kein Unterschied. Gleicher Bestand (7 Fassungen, 1 Löschmarker), gleiche Standard-Sperre. `mc retention info` meldet für die `mc`-Testdatei „COMPLIANCE, expired“. `mc rm --versions --force` entfernt sie jetzt endgültig, ohne Löschmarker; am Tag 0 wurde genau das abgelehnt |
| A2 | Hat die Lifecycle-Regel gewirkt? | Noch nicht. Das ist erwartet: S3 rechnet „1 Tag“ ab der Erstellung (10.10. 11:14 UTC) und rundet auf die nächste Mitternacht UTC, also auf den 12.10. 00:00 UTC |

**Löschen mit Versions-ID entfernt Daten endgültig, Löschen ohne Versions-ID setzt nur einen Löschmarker (4f).**
- Für die Produktion heißt das: Nach Ablauf der Sperre kann nur wer `DeleteObjectVersion` darf Daten wirklich entfernen, also der Admin-Schlüssel oder die Lifecycle-Regel.
- Der Schreibschlüssel darf das nicht.

**Bestand nach Tag 1:** 6 Fassungen, 1 Löschmarker. Ungesperrt sind `default.txt` (2), `ohne-pruefsumme.txt`, `lc/ablauf.txt`, `rundlauf-1mb.bin` und `rundlauf-12mb-teile.bin`.

**Lifecycle-Nachprüfung, nur lesend mit `--inventory`:**
- 12.10.2026: erwartet ist, dass Expiration einen Löschmarker setzt.
- 13.10.2026: erwartet ist, dass NoncurrentVersionExpiration die alte Fassung endgültig entfernt.

Hetzner nennt keine Bearbeitungszeiten. Verzögert sich die Wirkung um einen Tag, ist das kein Fehler.

**Ausgangsstand vor dem Stichtag** (11.10.2026, 21:2x UTC, `--inventory`, nur lesend): 6 Fassungen, 1 Löschmarker, nichts gesperrt.

| Objekt | Fassungen | Löschmarker | Aktuell |
|---|---|---|---|
| `rb-test/default.txt` | 2 | 0 | Fassung vom 10.10. |
| `rb-test/lc/ablauf.txt` (Lifecycle-Regel) | 1 | 0 | Fassung vom 10.10. 11:13 UTC; fällig ab 12.10. 00:00 UTC |
| `rb-test/md5.txt` | 0 | 1 | Löschmarker aus Prüfung 4f |
| `rb-test/ohne-pruefsumme.txt` | 1 | 0 | Fassung |
| `rb-test/rundlauf-12mb-teile.bin` | 1 | 0 | Fassung |
| `rb-test/rundlauf-1mb.bin` | 1 | 0 | Fassung |

Außerhalb von `lc/` gilt keine Lifecycle-Regel. Diese Objekte dürfen sich bis zum Aufräumen nicht verändern.
Das ist zugleich die Gegenprobe: Die Regel darf nur ihr Präfix treffen.

## Lifecycle-Nachprüfung 12.10.2026 (14:07 Uhr Berlin, 12:07 UTC, nur lesend)

**Einstellungen unverändert:**
- Isolation bestanden: Der Schlüssel sieht nur `rent-base-backup-test`.
- Object Lock COMPLIANCE 1 Tag, Versionierung an, Lifecycle-Regel `rb-test-ablauf` aktiv, keine Bucket-Policy.

**Bestand:** 6 Fassungen und 1 Löschmarker, Stück für Stück identisch mit dem Ausgangsstand vom 11.10.

| Bereich | Ergebnis |
|---|---|
| `rb-test/lc/ablauf.txt` (Lifecycle-Regel) | **noch nicht gewirkt**: 1 Fassung, kein Löschmarker |
| außerhalb von `rb-test/lc/` | unverändert: 5 Fassungen, Löschmarker nur auf `md5.txt`. Die Regel hat nichts außerhalb ihres Präfixes angefasst |

**Bewertung:** Nach S3-Regel war die Expiration ab 12.10. 00:00 UTC fällig. Gut 12 Stunden später hat Hetzner sie noch
nicht ausgeführt. S3 führt Lifecycle-Aktionen asynchron aus; Hetzner nennt keine Bearbeitungszeit.

Nach den vorab festgelegten Kriterien ([backup-policy-test.md](backup-policy-test.md), Abschnitt 7a) ist das **„weiter“**:
noch unverändert, alles andere wie im Ausgangsstand. **Entscheidend ist die Prüfung am 13.10.:** Hat die Regel dann gar
nicht gewirkt, wird gestoppt und berichtet.

## Lifecycle-Nachprüfung 13.10.2026 (20:57 Uhr Berlin, 18:57 UTC, nur lesend) – FAIL, Stopp

**Zum Zeitpunkt:**
- Die für 14:07 Uhr geplante Prüfung und der Policy-Test um 14:37 Uhr sind entfallen, weil die Sitzung zwischenzeitlich neu
  gestartet wurde; eingeplante Aufträge überdauern das nicht.
- Auf dem Server ist nichts gelaufen: kein `/root/backup-policy-test`, keine `rb-policy-`-Container, keine Policy. Die
  Prüfung wurde am Abend nachgeholt.

**Einstellungen unverändert:**
- Isolation bestanden: Der Schlüssel sieht nur `rent-base-backup-test`.
- Object Lock COMPLIANCE 1 Tag, Versionierung an, Lifecycle-Regel `rb-test-ablauf` aktiv, keine Bucket-Policy.
- Admin- und Writer-Zugangsdaten unverändert: root/600, getrennt, Schlüssel verschieden.

**Bestand:** identisch mit dem 11. und 12.10., also 6 Fassungen und 1 Löschmarker.

| Bereich | Ergebnis |
|---|---|
| `rb-test/lc/ablauf.txt` | **weiterhin keine Wirkung**: 1 Fassung, kein Löschmarker. Hochgeladen am 10.10. um 11:13 UTC; nach S3-Regel fällig seit 12.10. 00:00 UTC, also seit rund 43 Stunden |
| außerhalb von `rb-test/lc/` | unverändert (5 Fassungen, Löschmarker nur auf `md5.txt`) |

**Bewertung: FAIL.** Nach den vorab festgelegten Kriterien heißt „nach zwei Tagen gar keine Wirkung“ **Stopp und Bericht**.
Der Policy-Test wurde deshalb **nicht** gestartet.

**Mögliche Ursachen (ohne Änderung am Bucket nicht zu klären):**
1. Hetzner arbeitet Lifecycle-Regeln langsamer ab als in zwei Tagen. Die Doku nennt keine Zeiten.
2. Regeln mit Präfix-Filter (`Filter.Prefix`) werden nicht ausgeführt. Das einzige Beispiel der Hetzner-Doku gilt für den
   ganzen Bucket.
3. In Buckets mit Object Lock führt Hetzner Lifecycle-Regeln nicht oder nur eingeschränkt aus. Die Doku erwähnt Object Lock
   beim Löschen alter Fassungen („unless object lock is applied“). Ein Hetzner-Leitfaden für Veeam rät von Lifecycle-Regeln
   zusammen mit Object Lock ab.

**Folge für die Produktion:**
- Auf die Lifecycle-Regel als Aufräumweg ist derzeit **kein Verlass**.
- Ohne sie verschwinden Datenbank-Dumps nicht nach 31 Tagen von selbst. Das ist vor allem eine Datenschutzfrage; die Kosten
  bleiben gering.
- Vor produktiven Backups braucht es deshalb einen nachweislich funktionierenden Aufräumweg; Optionen in
  [backup-produktion-vorschlag.md](backup-produktion-vorschlag.md).

**Beobachtung 14.10.2026, 07:18 UTC** (nur lesend, bei der Vorprüfung für den Policy-Test):

| Bereich | Ergebnis |
|---|---|
| `rb-test/lc/ablauf.txt` | **Löschmarker gesetzt am 14.10.2026 um 01:30 UTC**, die alte Fassung ist noch da. Das ist die erste Wirkung der Regel, rund 49,5 Stunden nach S3-Fälligkeit (12.10. 00:00 UTC) und rund 3,6 Tage nach dem Hochladen. `NoncurrentVersionExpiration` steht aus |
| außerhalb von `rb-test/lc/` | unverändert: 5 Fassungen, Löschmarker nur auf `md5.txt` |
| Einstellungen, Policy | unverändert, keine Policy |

**Bewertung:**
- Das **FAIL vom 13.10. bleibt bestehen.** Am 12. und 13.10. hatte die Regel nicht gewirkt.
- Neu belegt ist: Hetzner führt die Regel **mit Präfix-Filter und in einem Bucket mit Object Lock** aus, aber mit deutlicher
  Verzögerung. Die Ursachen 2 und 3 oben sind damit für Expiration widerlegt.
- Ob auch `NoncurrentVersionExpiration` die alte Fassung endgültig entfernt, zeigt sich frühestens ab dem 15.10.
- Für die Produktion gilt deshalb: Die Lifecycle-Regel ist ein möglicher, aber langsamer Aufräumweg. Fristen im Löschkonzept
  brauchen einen Puffer von mehreren Tagen, oder ein Aufräumlauf ([backup-aufraeumen-konzept.md](backup-aufraeumen-konzept.md))
  sichert die Frist ab.

**Weiteres Vorgehen:**
- **Weitere lesende Prüfung am 14.10.2026 um 14:07 Uhr.** Sie ist nur in dieser Sitzung eingeplant und wird sonst beim nächsten
  Kontakt nachgeholt. Das FAIL bleibt bestehen, auch wenn die Regel verspätet wirkt.
- **Support-Anfrage an Hetzner:** [hetzner-support-lifecycle.md](hetzner-support-lifecycle.md).
- **Aufräumweg ohne Lifecycle:** [backup-aufraeumen-konzept.md](backup-aufraeumen-konzept.md).

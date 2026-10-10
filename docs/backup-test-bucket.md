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
| Prüfungen 1, 2 und 4 bestanden | Object Lock COMPLIANCE schützt Backups wie geplant, auch gegen gestohlene Schlüssel |
| Lifecycle wirkt (Tag 1/2) | Alte Backups und Löschmarker verschwinden nach Ablauf automatisch |
| Lifecycle wirkt nicht | Aufräumen alter Backups muss anders gelöst werden, z. B. regelmäßig nach Ablauf der Sperre |
| Prüfung 6 bestanden | Coolify kann in einen gesperrten Bucket hochladen |
| Löschversuch in Prüfung 6 abgelehnt | Coolifys eigene Aufbewahrung kann innerhalb der Sperre nichts löschen. Ein einfaches Löschen setzt nur einen Löschmarker, die Fassung bleibt. Die Coolify-Aufbewahrung wird deshalb mindestens so lang eingestellt wie die Sperre |

Noch nicht Teil dieses Tests:
- **Schreibschlüssel aus einem dritten Projekt über eine Bucket-Policy** (`backup-strategie.md`). Das folgt beim produktiven Bucket, falls wir es nutzen.
- **„Test connection“ und ein echtes Datenbank-Backup aus Coolify.** Das braucht eine Coolify-Einstellung und wird gesondert freigegeben.

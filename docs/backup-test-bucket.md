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

Access Key und Secret Key werden **nur einmal** angezeigt. Fenster offen lassen, bis Schritt 4 erledigt ist.

## Schritt 4: Zugangsdaten sicher auf den Server legen

Die Werte kommen **nur** in eine Datei auf dem Server, die ausschließlich root lesen kann. Nicht in den Chat, keine E-Mail,
kein Repository. Das Testskript liest die Datei und gibt die Werte nie aus.

1. In einem Terminal auf deinem Rechner `ssh rb` eingeben. Die Web-Konsole der Hetzner Console eignet sich schlecht, weil
   Einfügen dort oft nicht zuverlässig funktioniert.
2. Eingeben:
   ```
   umask 077
   nano /root/backup-test.env
   ```
3. Diese fünf Zeilen einfügen und die Platzhalter ersetzen. Keine Anführungszeichen, keine Leerzeichen um das `=`:
   ```
   TEST_S3_ENDPOINT=https://hel1.your-objectstorage.com
   TEST_S3_REGION=hel1
   TEST_S3_BUCKET=rent-base-backup-test-20261010
   TEST_S3_ACCESS_KEY=hier-den-Access-Key-einfügen
   TEST_S3_SECRET_KEY=hier-den-Secret-Key-einfügen
   ```
4. Speichern mit **Strg+O**, **Enter**, dann **Strg+X**.
5. Rechte festlegen und prüfen:
   ```
   chmod 600 /root/backup-test.env
   ls -l /root/backup-test.env
   ```
   Erwartet: `-rw------- 1 root root …`. Danach mit `exit` abmelden.
6. Willst du die Testschlüssel im Passwortmanager ablegen, tu das jetzt. Nötig ist es nicht, denn sie werden nach dem Test
   gelöscht. Dann das Fenster mit den Schlüsseln in der Console schließen. Nutzt du den Windows-Zwischenablageverlauf
   (Win+V), die beiden Einträge dort löschen.

## Schritt 5: Mir Bescheid geben

Kurze Nachricht genügt, ohne Schlüssel: „Bucket `<Name>` in hel1 mit Object Lock angelegt, Datei liegt auf dem Server.“

---

## Was danach passiert

**Tag 0 (etwa 2 Minuten, Freigabe liegt vor):** Ich starte das Testskript ([`scripts/backup-bucket-test.mjs`](../scripts/backup-bucket-test.mjs)).

- **Ausführung:** in zwei Wegwerf-Containern, die danach automatisch verschwinden. Prüfungen 0–5 und 7 laufen mit dem AWS SDK, Prüfung 6 mit demselben `mc`, das Coolify für Backups nutzt.
- **Ablage:** Das Skript schreibt nur unter `rb-test/` im Test-Bucket.

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
2. Danach löschst du in der Console den leeren Bucket, die S3-Zugangsdaten `backup-test` und das Projekt `Rent-Base Backup Test`.
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

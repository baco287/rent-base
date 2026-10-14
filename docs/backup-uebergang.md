# Übergangsweg: Backups mit Projektschlüssel, Object Lock und Prüflauf

**Stand 14.10.2026: vorbereitet, noch nichts eingerichtet.**
- Skripte, Tests und diese Anleitung sind in zwei Runden unabhängig gegengeprüft. Die Befunde sind eingearbeitet; was bleibt,
  steht in Abschnitt 1 und 8.
- Die Einrichtungsschritte nennen, wer sie ausführt und ob sie eine Freigabe brauchen.

**Warum ein Übergangsweg:**
- Der eingeschränkte Writer-Schlüssel funktioniert mit Coolify nicht. Im Policy-Test vom 14.10.2026 wurden Uploads in Teilen und
  `mc cp` trotz Freigabe abgewiesen; die Ursache ist offen ([backup-policy-test.md](backup-policy-test.md), Abschnitt 7d).
- Außer dem Hetzner-Serverbackup gibt es heute **keine** Datenbank- und Dateibackups.
- Der Übergangsweg schützt sofort viel, aber nicht alles (Abschnitt 1). Er lässt sich später auf eingeschränkte Schlüssel
  umstellen (Abschnitt 7).

**Kern:**
- Coolify und die Dateisicherung schreiben mit gewöhnlichen Projektschlüsseln in einen Bucket mit **Object Lock COMPLIANCE
  30 Tage**.
- Ein **Prüflauf** meldet Eingriffe.
  - **Stündlich:**
    - Sperre, Lifecycle, Policy und Bucket-ACL
    - fremde Buckets und Fremdobjekte
    - fehlende, überschriebene oder gelöschte Dumps und Dateien
    - die Sperre jeder neuen Fassung
    - eine stehengebliebene Dateisicherung
  - **Täglich:** Löschfristen, Gesamtgröße, Sperre und Freigaben aller Fassungen.

**Dateien:**

| Datei | Zweck |
|---|---|
| [`scripts/backup-prod-lib.mjs`](../scripts/backup-prod-lib.mjs) | erwartete Sperre und Lifecycle-Regeln, Einrichtung, Prüflauf |
| [`scripts/backup-prod-setup.mjs`](../scripts/backup-prod-setup.mjs) | Einrichtung: `--pruefen`, `--sperre`, `--lifecycle <Präfix>`, `--wiederherstellen <Präfix>` |
| [`scripts/backup-check.mjs`](../scripts/backup-check.mjs) | Prüflauf, stündlich und täglich `--voll`, nur lesend |
| [`scripts/backup-prod-run.sh`](../scripts/backup-prod-run.sh) | Rahmen auf dem Server: verdeckte Eingabe, Wegwerf-Container, Protokoll |
| [`tests/backup-prod.test.ts`](../tests/backup-prod.test.ts) | 18 Tests gegen einen nachgebildeten Bucket, ohne Netz und Datenbank |

Den Rahmen `run.sh` habe ich zusätzlich lokal mit nachgebildetem Docker geprüft (27 Fälle). Geprüft wurde:
- Schlüssel landen nur auf der Standardeingabe: nicht in Argumenten, Ausgabe oder Protokoll.
- Test-Schlüssel und mehrfach eingefügte Werte werden abgelehnt.
- Echo und „ja“ sind verdeckt.
- Nur der Produktions-Container wird verwendet.

## 1. Was geschützt ist und was nicht

| Ereignis | Folge im Übergangsweg | Wer bemerkt es |
|---|---|---|
| Ein Backup-Schlüssel wird gestohlen (aus Coolify, dem App-Container oder vom Server) und **anderswo** benutzt | Fassungen **innerhalb ihrer 30-Tage-Sperre** lassen sich weder löschen noch verändern. Auch die Sperre lässt sich nicht verkürzen | – |
| … der Dieb ändert Standard-Sperre oder Lifecycle, auch nur kurz | Künftige Uploads sind schwächer geschützt. Eine neue Lifecycle-Regel wirkt auch auf **vorhandene** Fassungen, deren Sperre abgelaufen ist | stündlich: die Einstellung selbst und die Sperre jeder Fassung der letzten 26 h; Reparatur mit `--wiederherstellen` (Abschnitt 6) |
| … der Dieb legt neue Fassungen über Dumps oder Dateien oder setzt Löschmarker | Die alte Fassung bleibt abrufbar: bei jungen Fassungen bis Sperrende, sonst noch 1 Tag (Dumps) bzw. 7 Tage (Dateien) nach dem Eingriff. Danach entfernt der Lifecycle sie | stündlich. Ausnahme: Löschmarker auf Fotos und Ausweiskopien, die die Dateisicherung selbst legitim setzt |
| … der Dieb löscht Fassungen **nach** Ablauf ihrer Sperre endgültig | Dumps betrifft das kaum, sie werden ab Tag 31 ohnehin entfernt. **Gesicherte Dateien, die älter als 30 Tage sind, sind dagegen ungeschützt**: Verträge, Protokolle und Fotos. Löscht der Angreifer zugleich die Originale im App-Bucket, sind sie verloren | **niemand** (Lücke, Abschnitt 8) |
| … der Dieb verlängert Sperren, lädt gesperrten Datenmüll hoch oder legt weitere Buckets an | Lässt sich **nicht rückgängig machen**: Kosten, und Löschpflichten sind nicht mehr erfüllbar | Sperren neuer Fassungen stündlich, aller Fassungen täglich; Fremdobjekte und fremde Buckets in hel1 stündlich; Gesamtgröße täglich |
| … der Dieb setzt Legal Holds | wie oben, unumkehrbar bis zur Aufhebung | **nicht geprüft** |
| … der Dieb liest alles oder gibt Backups für andere frei | Vollständige Kundendaten fließen ab (das könnte auch der Writer) | Bucket-ACL stündlich, Objekt-ACLs aller aktuellen Fassungen täglich, jeweils jede Freigabe außer an den Besitzer. Lässt Hetzner ACLs nicht lesen, nur ein Hinweis |
| … der Dieb setzt eine Policy, die alle Projektschlüssel aussperrt | Einstellungen lassen sich nicht mehr lesen und nicht reparieren | stündlich („nicht lesbar“); dann hilft nur der Hetzner-Support |
| **App-Container, Coolify oder Server übernommen** | Wie oben, zusätzlich: Der Prüflauf läuft im selben System. Der Angreifer kann ihn abschalten, die Benachrichtigung umleiten oder das Skript verfälschen; dann meldet er nichts | nur ein Prüflauf **von außen** (Abschnitt 8) |
| Fehlbedienung in Coolify (Aufbewahrung) | S3-Aufbewahrung 0/0/0, Coolify löscht nichts. Ein Löschen setzt nur Löschmarker | stündlich („Dumps gelöscht“) |
| Backup läuft nicht oder ist leer | – | Coolify „Backup failure“; Prüflauf: Dump älter als 2 h, auffällig klein, weniger als 20 oder mehr als 30 in 24 h, nicht richtig gesperrt |
| Coolify fällt ganz aus | Weder Backups noch Prüflauf laufen | UptimeRobot nur, wenn auch die Website ausfällt; sonst niemand (Abschnitt 8) |
| Lifecycle räumt nicht auf | Daten bleiben über die Löschfrist hinaus | täglich, mit 7 Tagen Puffer für Hetzners Verzögerung |
| Hetzner-Konto übernommen | – | nicht abgedeckt; Zwei-Faktor-Anmeldung |

**Gegenüber dem geplanten Writer-Schlüssel ist der Übergangsweg schwächer bei:**
- Änderungen an den Einstellungen; das bemerken wir nur.
- Endgültigem Löschen nach Sperrende, vor allem bei **Dateien, die älter als 30 Tage sind**.
- Unumkehrbarem Missbrauch: verlängerte Sperren, Legal Holds, gesperrter Müll.

Er ist trotzdem deutlich besser als der heutige Stand ganz ohne Backups. Die Übergangszeit sollte aber kurz bleiben.

## 2. Aufbau

**Projekt:** Empfehlung ist ein **neues** Projekt „Rent-Base Backup Produktion“.
- Die Test-Schlüssel aus „Rent-Base Backup“ sehen den Produktions-Bucket dann nie.
- Test und Aufräumen dort laufen unabhängig weiter.
- Ein Projekt kostet nichts; der Grundpreis gilt je Konto.
- *Alternative:* den Bucket in „Rent-Base Backup“ anlegen.
  - Dann vorher den Test aufräumen (frühestens 15.10.) und die beiden Test-Schlüssel löschen.
  - Die Einrichtung duldet dort den Test-Bucket.
  - Für den Prüflauf `BACKUP_CHECK_ERLAUBTE_BUCKETS=rent-base-backup-test` setzen, bis der Test-Bucket gelöscht ist.

**Bucket:** `rent-base-backup`, Standort **hel1**, privat, **Object Lock beim Anlegen aktivieren**. Damit ist auch die
Versionierung an. Ist der Name vergeben, bitte Bescheid geben; er steht in `run.sh`.

**Schlüssel im Backup-Projekt:** Alle haben dieselben vollen Projektrechte. Getrennt sind sie, damit sich jeder einzeln
ersetzen lässt.

| Schlüssel | Liegt in | Wofür |
|---|---|---|
| `admin` | **nur** im Passwortmanager | Einrichtung und Reparatur über `run.sh`, Notfall, Wiederherstellung von Hand |
| `coolify-db` | Coolify „S3 Storage“ | Datenbank-Backups |
| `dateisicherung` | App-Umgebung `BACKUP_S3_*` (ab Phase C) | Dateisicherung und Prüflauf |

**Abweichung von [backup.md](backup.md) und [backup-produktion-vorschlag.md](backup-produktion-vorschlag.md):**
- Dort soll der Admin-Schlüssel nie auf den Server.
- Im Übergangsweg wird er für Einrichtung und Reparatur verdeckt auf dem Server eingegeben. Er lebt dort nur im Speicher eines
  Wegwerf-Containers.
- Das bringt kein zusätzliches Risiko, solange der Server nicht übernommen ist; die Schlüssel in Coolify und in der App haben
  dieselben Rechte.
- Ist der Server übernommen, gilt Abschnitt 6, „Server oder Coolify übernommen“.

**Einstellungen am Bucket:**
- Standard-Sperre COMPLIANCE 30 Tage
- die vier Lifecycle-Regeln aus [backup.md](backup.md) ([`expectedLifecycleRules`](../scripts/backup-prod-lib.mjs))
- **keine** Bucket-Policy, Bucket-ACL nur für den Besitzer

**Zeitplan (UTC, stündlich):**

| Minute | Was |
|---|---|
| 17 | Datenbank-Backup (Coolify) |
| 27 | Aufräumlauf gelöschter Ausweiskopien |
| 37 | Dateisicherung |
| 47 | Prüflauf |
| 05:52 täglich | voller Prüflauf |

**Löschfristen:**
- **Dumps:** Lifecycle-Ablauf nach 31 Tagen, endgültig einen Tag später.
  - Jede Stufe wird auf Mitternacht gerundet, dazu kommt Hetzners Verzögerung (am 14.10. rund 2 Tage).
  - **Erwartet verschwindet ein Dump nach etwa 33 bis 38 Tagen.** Liegt er nach 39 Tagen noch vor, meldet der nächste volle
    Prüflauf einen Fehler.
  - Der Puffer lässt sich mit `BACKUP_CHECK_BUFFER_DAYS` anpassen.
- **Legitim gelöschte Fotos und Ausweiskopien:**
  - Sie verschwinden aus dem Backup frühestens 14 Tage nach dem Löschen in der App: 7 Tage Frist der Dateisicherung, dann
    7 Tage Lifecycle.
  - Ist die Datei jünger als 30 Tage, gilt stattdessen ihre Sperre.
  - Mit Hetzners Verzögerung sind das also etwa 15 bis 33 Tage nach dem Löschen.
- Die Obergrenze von rund 40 Tagen gehört ins Löschkonzept.

## 3. Phase A: Datenbank-Backups (ohne Deploy)

| Schritt | Wer | Freigabe |
|---|---|---|
| A0 Coolify-Benachrichtigungen per E-Mail einrichten und testen | du | – |
| A1 Projekt, Bucket und Schlüssel in der Hetzner Console | du | – |
| A2 Skripte auf den Server legen | ich | **ja** |
| A3 lesende Prüfung `--pruefen` | du | – |
| A4 Standard-Sperre `--sperre` | du | „ja“ im Skript |
| A5 S3 Storage in Coolify | du | – |
| A6 Backup-Zeitplan in Coolify, erstes Backup | du | – |
| A7 Kontrolle `--pruefen`, Dump-Präfix ablesen | du | – |
| A8 Lifecycle `--lifecycle <Präfix>` | du | „ja“ im Skript |
| A9 voller Prüflauf `--check <Präfix>` | du | – |
| A10 kurze Wiederherstellungsprobe | du / ich | **ja** |

**A0 Benachrichtigungen (du):** Coolify → Notifications → E-Mail über deinen SMTP-Zugang, Test-Mail senden. Diese Ereignisse
einschalten:
- „Backup failure“
- „Scheduled task failure“
- „Server unreachable“
- „Disk usage“

**Backups erst einschalten, wenn die Test-Mail ankommt.**

**A1 Hetzner Console (du):**
1. Neues Projekt „Rent-Base Backup Produktion“.
2. Darin Object Storage → Bucket anlegen: Name `rent-base-backup`, Standort Helsinki (hel1), Sichtbarkeit privat,
   **Object Lock: aktiviert**.
3. Sicherheit → S3-Zugangsdaten → drei Schlüssel: `admin`, `coolify-db`, `dateisicherung`.
4. Jeden Secret Key sofort in den Passwortmanager. Die Console zeigt ihn nur einmal.
5. Keine Werte in den Chat. Projekt-ID und Bucket-Name sind keine Geheimnisse.

**A2 Skripte auf den Server (ich, mit Freigabe):**
- `/root/backup-prod` anlegen (root, 700), darin `run.sh` (700) und `js/` (755) mit den vier `.mjs`-Dateien (644). Das
  App-Image läuft als Benutzer `app` und muss sie lesen können.
- Ohne Überschreiben kopieren, die Prüfsummen mit dem Repository vergleichen.
- Kein Schlüssel, kein Lauf, keine Änderung an Coolify oder am Bucket.

**Erledigt am 14.10.2026** (Freigabe vom selben Tag), Stand Commit `58f3bb7`:
- **Abgelegt:** Verzeichnisse und Rechte wie oben, alles root:root. Alle fünf Prüfsummen gleich dem Repository
  (`run.sh` `06c231a3…`).
- **Syntax:** in Ordnung.
- **Startprobe ohne Terminal:** bricht wie vorgesehen vor jeder Abfrage ab (Exit 2).
- **Probe im Wegwerf-Container, ohne Schlüssel und ohne Netz:** Benutzer `app` lädt die Skripte samt AWS SDK, und der Aufruf
  ohne Modus zeigt die Nutzung.
- **Vorher behoben:** Coolify benennt den App-Container mit Zeitstempel (`…-20261008T120740`). Das ursprüngliche Muster hätte
  ihn nicht erkannt.

**A3 Lesende Prüfung (du):**

```bash
ssh -t rb bash /root/backup-prod/run.sh --pruefen
```

- Access Key und Secret Key von `admin` jeweils **genau einmal** einfügen. Alle Eingaben bleiben unsichtbar.
- Das Skript lehnt Test-Schlüssel, doppelt eingefügte Werte und einen Access Key im Secret-Feld ab.
- Es nimmt nur den laufenden Produktions-Container der App als Vorlage; läuft gerade ein Deploy, bricht es ab.
- **Erwartet:**
  - `OK Projekt: sieht nur rent-base-backup`
  - `OK Bucket-Policy: keine`
  - `OK Versionierung: an`
  - `HINWEIS Standard-Sperre: Object Lock aktiviert, aber keine Standard-Sperre – mit --sperre setzen`
  - `Bucket-ACL: 1 Einträge, nur der Besitzer` (oder ein Hinweis, dass Hetzner ACLs nicht lesen lässt)
  - `Bestand: 0 Fassungen, 0 Löschmarker`
  - am Ende `== Ende --pruefen: Exit 0`
- **Exit 3:** Anmeldung abgelehnt oder Bucket nicht sichtbar.
- **Exit 1:** Eine FEHLER-Zeile, etwa weitere Buckets im Projekt oder Object Lock aus.
- Bei Exit 3 oder 1 bitte melden. Geändert wird bei `--pruefen` nie etwas.

**A4 Standard-Sperre (du):**

```bash
ssh -t rb bash /root/backup-prod/run.sh --sperre
```

- Das Skript beschreibt die Änderung und fragt nach „ja“. Auch diese Eingabe ist unsichtbar; ein versehentlich eingefügter
  Schlüssel wird also nicht angezeigt.
- Danach den `admin`-Schlüssel eingeben.
- **Erwartet:** `OK Standard-Sperre gesetzt: COMPLIANCE 30 Tage, zurückgelesen`, Exit 0.
- **Ab hier ist jede hochgeladene Fassung 30 Tage unlöschbar**, auch für dich und Hetzner.
- Das Skript setzt die Sperre nur, wenn noch keine steht.

**A5 S3 Storage in Coolify (du):** Seitenleiste → S3 Storages → „+ Add“:
- Name „Hetzner Backup hel1“
- Endpoint `https://hel1.your-objectstorage.com`
- Bucket `rent-base-backup`, Region `hel1`
- Access Key und Secret Key von **`coolify-db`**

Dann „Validate Connection“.

**A6 Backup-Zeitplan (du):** Ressource `rent-base-db` → Backups → „+ Add“ (oder den vorhandenen Zeitplan bearbeiten):
- **Frequency** `17 * * * *`, Timezone UTC
- **S3** an, Storage aus A5
- **Aufbewahrung lokal:** Anzahl 24, Tage 0, Größe 0
- **Aufbewahrung S3: Anzahl 0, Tage 0, Größe 0.** Damit löscht Coolify im Bucket nichts; aufgeräumt wird über den Lifecycle.
- Gesichert wird die Datenbank aus der `DATABASE_URL` der App.

Dann „Backup Now“. Die Execution muss erfolgreich sein.

**A7 Kontrolle (du):** `--pruefen` wie in A3.
- **Erwartet:**
  - eine Zeile `Dump: data/coolify/backups/… · … MB · <Zeit>`
  - `OK Sperre neuester Dump: COMPLIANCE bis <Zeit + 30 Tage>`
  - `Vorschlag Dump-Präfix: data/coolify/backups/…/`
- Das Präfix ist kein Geheimnis; du kannst es mir schicken.

**A8 Lifecycle (du):**

```bash
ssh -t rb bash /root/backup-prod/run.sh --lifecycle data/coolify/backups/…/
```

- „ja“ (unsichtbar), dann den `admin`-Schlüssel.
- **Erwartet:** `OK Lifecycle gesetzt: 4 Regeln, zurückgelesen`.
- Das Skript setzt die Regeln nur, wenn noch keine stehen, unter dem Präfix ein Dump liegt und dieser gesperrt ist.
- Lehnt Hetzner die Regeln ab, bleibt alles unverändert. Dann bitte melden.

**A9 Voller Prüflauf (du):**

```bash
ssh -t rb bash /root/backup-prod/run.sh --check data/coolify/backups/…/
```

- **Erwartet:** 0 Fehler. Der Hinweis „Dateisicherung: läuft noch nicht“ ist bis Phase C richtig.
- Die Mindestzahl von 20 Dumps in 24 Stunden gilt erst, wenn der älteste Dump älter als einen Tag ist.

**Bis Phase C läuft der Prüflauf nicht automatisch.** Coolify meldet in dieser Zeit nur fehlgeschlagene Backups. Deshalb:
- A9 bis zum Abschluss von Phase C **täglich** einmal ausführen. Das dauert etwa eine Minute mit dem `admin`-Schlüssel.
- Phase B und C zügig nachziehen.

**A10 Kurze Wiederherstellungsprobe (du / ich, mit Freigabe), vor dem Pilot-Deploy:**
1. In Coolify eine neue PostgreSQL 18.6 `rent-base-restore-test` anlegen.
2. „Import Backup“ aus S3 mit dem neuesten Dump.
3. Ich vergleiche lesend die Zeilenzahlen der Haupttabellen mit der Live-Datenbank.
4. Danach löschst du die Testdatenbank; sie enthält alle Kundendaten.

Der vollständige Test mit `check-restore.mjs` folgt nach dem Deploy ([backup.md](backup.md), „Wiederherstellungstest“).

## 4. Phase B: Pilot-Deploy

Eigene Freigabe, siehe PR. Die stündlichen Datenbank-Backups laufen dann schon und sichern den Stand vor den Migrationen.

## 5. Phase C: Dateisicherung und Prüflauf (nach dem Deploy)

**C1 App-Umgebung (du; der Neustart braucht eine Freigabe):** Anwendung → Environment Variables, jeweils nur zur Laufzeit, nicht
beim Build. Danach die App neu starten, denn Scheduled Tasks sehen nur die Umgebung, mit der der Container gestartet wurde.

```
BACKUP_S3_ENDPOINT=https://hel1.your-objectstorage.com
BACKUP_S3_REGION=hel1
BACKUP_S3_BUCKET=rent-base-backup
BACKUP_S3_ACCESS_KEY=…   (dateisicherung)
BACKUP_S3_SECRET_KEY=…   (dateisicherung)
BACKUP_GRACE_DAYS=7
BACKUP_DUMP_PREFIX=data/coolify/backups/…/
```

**C2 Scheduled Tasks (du):** Anwendung → Scheduled Tasks. Jeden einmal von Hand ausführen, bevor der Zeitplan greift.

| Name | Command | Schedule | Timeout |
|---|---|---|---|
| Gelöschte Dokumentkopien aufräumen | `node scripts/cleanup-driver-copies.mjs`, vorher einmal mit `--dry-run` | `27 * * * *` | 600 |
| Dateien sichern | `node scripts/backup-files.mjs` | `37 * * * *` | 3600 |
| Backup prüfen | `node scripts/backup-check.mjs` | `47 * * * *` | 600 |
| Backup prüfen (voll) | `node scripts/backup-check.mjs --voll` | `52 5 * * *` | 900 |

**Dateisicherung:** Sobald sie einmal gelaufen ist, also `files-state/missing.json` existiert, prüft der Prüflauf sie
automatisch. Der letzte erfolgreiche Lauf darf höchstens 2 Stunden alt sein. Nach dem ersten Lauf von „Backup prüfen“ ist
`OK Dateisicherung: letzter erfolgreicher Lauf vor … h` zu erwarten.

**C3:** Vollständiger Wiederherstellungstest nach [backup.md](backup.md).

**Ausgabe des Prüflaufs:**
- Eine Zeile je Prüfung (`OK`, `FEHLER`, `HINWEIS`), am Ende `Ergebnis: n ok, m Fehler, k Hinweise`.
- Bei einem Fehler endet er mit Code 1, und Coolify verschickt „Scheduled task failure“.
- Zugangsdaten gibt er nie aus.

## 6. Wenn der Prüflauf Alarm schlägt

**Grundsatz:** Jede Fehlermeldung ernst nehmen. Den Scheduled Task nicht abschalten.

**Ist ein Vorfall geklärt**, die Meldung aber nicht behebbar (etwa eine überschriebene Fassung, die bis Sperrende stehen bleibt,
verlängerte Sperren oder ein gesperrter fremder Bucket):
- Die in der FEHLER-Zeile genannten Objektschlüssel bzw. Bucket-Namen in `BACKUP_CHECK_BEKANNT` eintragen, Komma-getrennt.
- Die App neu starten (mit Freigabe).
- Diese Fälle erscheinen dann nur noch als Hinweis; alles Neue meldet weiter als Fehler.

| Meldung | Sofort | Danach |
|---|---|---|
| `Standard-Sperre`, `Lifecycle weicht ab`, `Bucket-Policy`, `Bucket-ACL`, oder Einstellungen „nicht lesbar“ | `run.sh --wiederherstellen <Präfix>` („ja“, `admin`-Schlüssel). Möglichst vor dem nächsten Lifecycle-Lauf (beobachtet um etwa 01:30 UTC), denn eine fremde Regel wirkt auch auf vorhandene, entsperrte Fassungen. Die Wiederherstellung entfernt zuerst eine fremde Policy, lässt sich durch fremde Buckets nicht blockieren und löscht keine Daten | alle drei Schlüssel ersetzen (unten), dann `--check`. Lässt sich die Policy nicht entfernen: Hetzner-Support |
| `Dumps überschrieben`, `Dumps gelöscht`, `Dateien überschrieben`, `Dateien gelöscht` | melden; nichts löschen | Ich bereite mit Freigabe vor: die alte Fassung über ihre Versions-ID zurückholen bzw. den Löschmarker entfernen. Das Zurückholen legt eine neue Fassung an; die Meldung bleibt deshalb bestehen und wird danach quittiert. Schlüssel ersetzen |
| `Sperre neuer Fassungen` / `Sperre aller Fassungen` | melden | Bei zu kurzer Sperre: `--wiederherstellen`, Schlüssel ersetzen. Eine verlängerte Sperre lässt sich nicht zurücknehmen; sie gehört ins Löschprotokoll und wird quittiert |
| `Objekt-ACL` | melden | Freigaben der genannten Fassungen auf privat zurücksetzen; das bereite ich mit Freigabe vor. Schlüssel ersetzen |
| `Buckets im Projekt`, `Objekte außerhalb der Regeln`, `Gesamtgröße` | melden | Herkunft klären, Schlüssel ersetzen. Ungesperrtes kann weg; Gesperrtes bleibt bis Sperrende und wird quittiert |
| `Versionierung` | melden | Bei Object Lock lässt sie sich eigentlich nicht abschalten: Hetzner-Support |
| `Dumps`: zu alt, zu wenige, zu klein, zu viele | Coolify → `rent-base-db` → Backups → Executions | Ursache beheben; „zu viele“ deutet auf fremde Uploads |
| `Dateisicherung` steht oder Merkliste gelöscht | Scheduled Task „Dateien sichern“ prüfen | Bei gelöschter Merkliste: Zugriff prüfen, Schlüssel ersetzen |
| `Lifecycle … überfällig` | prüfen, ob Hetzner nur später aufräumt (Löschmarker vorhanden?) | Puffer `BACKUP_CHECK_BUFFER_DAYS` erhöhen oder Aufräumlauf ([backup-aufraeumen-konzept.md](backup-aufraeumen-konzept.md)) |
| `Teil-Uploads` | – | Die Lifecycle-Regel prüfen; abgebrochene Uploads kosten nur Speicher |

**Schlüssel ersetzen:** Ist die Quelle unklar, alle drei ersetzen.
1. Hetzner Console → Projekt → S3-Zugangsdaten: den Schlüssel löschen und neu anlegen.
2. Neue Werte eintragen:
   - `coolify-db`: in Coolify unter S3 Storage, dann „Validate Connection“.
   - `dateisicherung`: in `BACKUP_S3_*`, danach die App neu starten.
   - `admin`: in den Passwortmanager.
3. `run.sh --check <Präfix>` ausführen.

**Server oder Coolify übernommen:**
- **Keine neuen Schlüssel auf diesem Server eingeben**, auch nicht in `run.sh`.
- Zuerst alle drei Schlüssel in der Console löschen. Das stoppt den Angreifer; gesperrte Fassungen bleiben ohnehin erhalten.
- Dann den Server neu aufsetzen und aus den Backups wiederherstellen ([backup.md](backup.md), „Im Ernstfall“).
- Die Bucket-Einstellungen erst danach reparieren: mit `run.sh --wiederherstellen` auf dem neuen Server, oder von einem
  sauberen Rechner mit Repository und `npm install`:
  ```
  BACKUP_S3_ENDPOINT=https://hel1.your-objectstorage.com BACKUP_S3_BUCKET=rent-base-backup \
    node scripts/backup-prod-setup.mjs --schluessel-stdin --wiederherstellen <Präfix>
  ```
  Die Schlüssel kommen dabei als zwei Zeilen über die Standardeingabe, z. B. aus dem Passwortmanager per Pipe; nie als
  Argument.

## 7. Rückweg und späterer Umstieg

**Rückweg:**
- Im Backup-Zeitplan S3 ausschalten; die lokalen Backups laufen weiter.
- Die Scheduled Tasks deaktivieren.
- `coolify-db` und `dateisicherung` in der Console löschen; sie haben volle Rechte.
- Der Bucket bleibt.
  - Gesperrte Fassungen lassen sich frühestens 30 Tage nach dem Upload löschen; die Kosten liegen im Grundpreis.
  - **Aktuelle Dateien unter `files/` laufen nie ab**, auch nicht Ausweiskopien. Wird der Bucket nicht mehr gebraucht, muss er
    nach Sperrende mit dem `admin`-Schlüssel geleert und gelöscht werden. Sonst bleiben diese Daten unbegrenzt liegen.

**Umstieg auf eingeschränkte Schlüssel, sobald die Ursache aus dem Policy-Test geklärt ist:**
1. Prüflauf so erweitern, dass er „keine Policy“ **oder** die erwartete Writer-Policy annimmt, und deployen.
2. Writer-Schlüssel und Policy setzen.
3. Coolify und `BACKUP_S3_*` umstellen.
4. Die Writer-Policy im Prüflauf verpflichtend machen; `--wiederherstellen` entsprechend anpassen, denn heute entfernt es jede
   Policy.
5. Erst dann `coolify-db` und `dateisicherung` löschen.

## 8. Offene Punkte und Entscheidungen

- **Projekt:** neues Projekt (empfohlen) oder „Rent-Base Backup“ nach dem Aufräumen des Tests (Abschnitt 2).
- **Dateien älter als 30 Tage:** Im Übergangsweg ungeschützt (Abschnitt 1).
  - **Empfohlener Folgeschritt:** eine „rollende Sperre“. Ein täglicher Lauf verlängert die Sperre jeder aktuellen Datei im Backup
    wieder auf 30 Tage. Verlängern ist unter COMPLIANCE erlaubt, verkürzen nicht.
  - Vorher ist ein kurzer Test am Test-Bucket nötig: Erlaubt Hetzner das Verlängern? Außerdem müsste der Prüflauf dann
    Sperren bis 30 Tage ab der letzten Verlängerung annehmen.
  - **Datenschutzfolge:** Legitim gelöschte Fotos und Ausweiskopien blieben bis zu rund 40 Tage nach dem Löschen im Backup:
    7 Tage Frist, bis zu 30 Tage Restsperre, dazu Hetzners Verzögerung. Heute sind es etwa 15 bis 33 Tage. Das ist rechtlich
    zu bewerten.
- **Prüflauf von außen:** Der Prüflauf in Coolify hilft nicht, wenn App, Coolify oder Server übernommen sind oder Coolify ganz
  ausfällt. `run.sh --check` von Hand läuft auf demselben Server und ist deshalb ebenfalls nicht unabhängig. Unabhängig wären:
  - ein geplanter Lauf außerhalb des Servers, z. B. als GitHub-Actions-Zeitplan nach dem Merge, mit einem vierten Schlüssel
    als Repository-Secret; GitHub meldet fehlgeschlagene Läufe per E-Mail;
  - oder ein Totmann-Dienst wie Healthchecks.io (braucht ein Konto).
- **Legal Holds** prüft der Prüflauf nicht; das kostete eine Anfrage je Fassung und Tag.
- **Lifecycle im Test:** Ob `NoncurrentVersionExpiration` alte Fassungen wirklich entfernt, zeigt sich ab dem 15.10.
  - Wirkt sie nicht, meldet der volle Prüflauf überfällige Dumps ab etwa Tag 39 nach dem ersten Backup.
  - Dann braucht es den Aufräumlauf aus [backup-aufraeumen-konzept.md](backup-aufraeumen-konzept.md), angepasst an den
    Projektschlüssel.
- **Löschkonzept:** die Fristen aus Abschnitt 2 rechtlich bestätigen lassen ([backup-strategie.md](backup-strategie.md)).
- **ACL:** Ob Hetzner Bucket- und Objekt-ACLs lesen lässt, zeigt A3. Wenn nicht, bleibt die Prüfung ein Hinweis.
- **Bekannt und akzeptiert:** Coolify übergibt die S3-Schlüssel kurz als Prozessargumente
  ([backup-produktion-vorschlag.md](backup-produktion-vorschlag.md), Abschnitt 3).

# Policy-Test: eingeschränkter Schreibschlüssel für Backups

**Stand 12.10.2026: vorbereitet, noch nicht ausgeführt.** Es ist nichts angelegt. Jeder Schritt in Abschnitt 4 braucht deine
Freigabe.

**Ziel:** Bevor der produktive Backup-Bucket entsteht, prüfen wir an `rent-base-backup-test`, ob Hetzner eine Bucket-Policy
für einen Schlüssel aus einem **eigenen Projekt** so durchsetzt, wie [backup-produktion-vorschlag.md](backup-produktion-vorschlag.md)
(Abschnitt 2) es vorsieht. Coolify und die Dateisicherung sollen hochladen und lesen können, aber nichts endgültig löschen und
keine Sperren, Regeln oder Policies ändern.

## 1. Welche Rechte gebraucht werden

| Wer | Aktion | Wofür | Beleg |
|---|---|---|---|
| Coolify | `s3:ListBucket` | „Validate Connection“ (`ListObjectsV2`), Wiederherstellung (`exists`, `size`) | Coolify-Quelltext 4.4.6, `S3Storage::testConnection`, `StartDatabaseImport` |
| Coolify | `s3:PutObject` | Upload mit `mc cp`, auch in Teilen | `DatabaseBackupJob`, Bucket-Test Prüfung 6 |
| Coolify | `s3:GetObject` | Wiederherstellung mit `mc cp` aus S3 | `StartDatabaseImport` |
| Coolify / `mc` | `s3:GetBucketLocation`, `s3:GetBucketObjectLockConfiguration` | `mc` fragt Region und Sperre ab | MinIO-Client-Verhalten; der Test zeigt, ob es nötig ist |
| Dateisicherung | wie Coolify, dazu `s3:GetObjectVersion` | Lesen und Vergleichen | `scripts/backup-files.mjs` |
| Dateisicherung | `s3:DeleteObject` **nur unter `files/`** | legitime Löschungen (Entwurfsfotos, gelöschte Ausweiskopien) als Löschmarker | [backup.md](backup.md), Abschnitt 4 |
| Coolify | **kein** `s3:DeleteObject` | Coolifys S3-Aufbewahrung steht auf 0/0/0 und löscht dann nichts; das Aufräumen übernimmt die Lifecycle-Regel | `bootstrap/helpers/databases.php` |
| niemand außer Admin | `DeleteObjectVersion`, `PutObjectRetention`, `PutObjectLegalHold`, `BypassGovernanceRetention`, `PutBucketPolicy`, `DeleteBucketPolicy`, `PutLifecycleConfiguration`, `PutBucketVersioning`, `PutBucketObjectLockConfiguration` | endgültiges Löschen, Sperren ändern, Bucket-Regeln ändern | – |

**Im Test** bekommt ein einziger Writer-Testschlüssel beide Rollen:
- erlaubt: `PutObject`, `GetObject`, `GetObjectVersion`, `ListBucket`, `GetBucketLocation`, `GetBucketObjectLockConfiguration`
- `DeleteObject` nur unter `rb-test/policy/files/`
- ausdrückliches `Deny` für alle Verwaltungsaktionen der letzten Zeile

So prüft ein Lauf beide Fälle.

## 2. Testfälle

Ausgeführt von [`scripts/backup-policy-test.mjs`](../scripts/backup-policy-test.mjs), danach ein `mc`-Teil mit dem Writer-Schlüssel im
Coolify-Hilfsimage. Geschrieben wird nur unter `rb-test/policy/`.

| Nr. | Prüfung | Erwartet | Bedeutung einer Abweichung |
|---|---|---|---|
| V0–V3 | Vorbedingungen: Admin sieht nur den Test-Bucket; Writer sieht ihn nicht als eigenen und hat ohne Policy keinen Zugriff; noch keine Policy gesetzt | erfüllt, sonst Abbruch (Exit 3), nichts geändert | falsches Projekt oder unerwarteter Zustand |
| S1–S2 | Policy mit dem Admin-Schlüssel setzen und zurücklesen | gesetzt, drei Anweisungen mit Writer-Principal | Hetzner nimmt das Format nicht an |
| P1 | Auflisten (wie Coolifys Verbindungstest) | erlaubt, wartet bis 60 s auf die Wirkung | Policy wirkt nicht → weitere Writer-Tests entfallen |
| P2–P3 | Region und Standard-Sperre lesen | erlaubt | – |
| P4–P6 | Upload mit SDK-Prüfsumme, mit Content-MD5, in Teilen (12 MB) | erlaubt | Coolify bzw. Dateisicherung könnten nicht sichern |
| P7–P8 | Lesen, auch einer bestimmten Fassung | erlaubt, SHA-256 identisch | Wiederherstellung unmöglich |
| P9 | Löschen unter `files/` | erlaubt, **nur Löschmarker**, Fassung bleibt | Dateisicherung könnte legitime Löschungen nicht übernehmen |
| N1 | Löschen außerhalb von `files/` | abgewiesen | Präfix-Einschränkung wirkt nicht (nur Löschmarker, Daten bleiben) |
| N2 | Fassung endgültig löschen, deren Sperre schon abgelaufen ist; der Admin legt dafür eine Fassung mit 60 s Sperre an | abgewiesen | **kritisch:** Writer könnte alte Backups nach Sperrende endgültig löschen |
| N3 | Sperre einer Fassung auf 36 h verlängern | abgewiesen | Writer könnte Daten länger sperren (Kosten, Datenschutz) |
| N4 | Upload mit eigener Sperre (36 h) | abgewiesen | wie N3 |
| N5 | Legal Hold setzen | abgewiesen; falls doch erlaubt, nimmt der Admin ihn sofort zurück | Writer könnte Daten unbefristet sperren |
| N6–N7 | Policy setzen (identischer Inhalt) bzw. löschen | abgewiesen; falls Löschen doch erlaubt, setzt der Admin sie sofort neu | **kritisch:** Writer könnte sich selbst Rechte geben |
| N8–N9 | Lifecycle bzw. Standard-Sperre setzen (jeweils identischer Inhalt) | abgewiesen | **kritisch:** Writer könnte künftige Backups ungeschützt lassen oder ablaufen lassen |
| N10 | Versionierung aussetzen | abgewiesen (403) | 409 heißt: Policy greift nicht, Object Lock verhindert es aber |
| N11–N13 | Policy, Sperrfrist und Fassungsliste lesen | abgewiesen (nicht gewährt) | nur lesend, geringe Bedeutung |
| K1–K4 | Kontrolle mit dem Admin-Schlüssel: Writer-Uploads tragen die Standard-Sperre; Sperre, Lifecycle und Versionierung unverändert; Policy unverändert; kein Legal Hold | erfüllt | – |
| M1–M4 | `mc` wie Coolify mit dem Writer-Schlüssel: eigene Buckets, Auflisten, Upload 20 MB, Rücklesen | erlaubt, SHA-256 identisch | Coolify bräuchte weitere Rechte; welche, zeigt die Fehlermeldung |
| M5–M6 | `mc rm` und `mc rm --versions` außerhalb von `files/` | abgewiesen, Datei bleibt | wie N1 bzw. N2 |
| F1–F3 | Policy entfernen; Writer hat danach keinen Zugriff mehr; Bestand unter `rb-test/policy/` | erfüllt | – |

**Sicherheitsvorkehrungen:**
- Nur der Test-Bucket. Der Admin-Schlüssel muss weiterhin **nur** ihn sehen, sonst bricht der Test ab.
- Verbotsversuche setzen, wo möglich, genau die bestehende Einstellung erneut. Auch eine unerwartete Erlaubnis ändert dann nichts.
- Sperrfristen im Test höchstens 36 Stunden.
- Die Policy wird am Ende **immer** entfernt, sobald sie gesetzt war, auch wenn zwischendurch etwas schiefging.
- Schlüssel werden nie ausgegeben, auch die Policy nicht, weil sie die Access-Key-ID des Writers enthält.
- Zurück bleiben Testobjekte unter `rb-test/policy/`, gesperrt für 1 Tag (36 h, falls N3/N4 wider Erwarten erlaubt sind).
  Sie verschwinden beim Aufräumen des Test-Buckets.

## 3. Writer-Projekt sicher einrichten (du, in der Hetzner Console)

1. **Neues Projekt** „Rent-Base Backup-Writer“ anlegen. **Keine** Server und **keine** Buckets darin anlegen. Das Projekt trägt
   nur Schlüssel und kostet nichts.
2. **Projekt-ID** aus der Adresszeile notieren (`…/projects/<ID>/…`). Sie ist kein Geheimnis und kommt in die Policy.
3. **Sicherheit → S3-Zugangsdaten → Zugangsdaten generieren**, Beschreibung `writer-test`.
   - Sofort im Passwortmanager speichern, als eigener Eintrag „RentBase Writer **TEST**“, getrennt von den späteren
     Produktivschlüsseln.
   - Diesen Schlüssel nie in Coolify oder in die App eintragen.
4. **Auf den Server legen,** verdeckt wie beim Admin-Testschlüssel: `ssh -t rb bash /root/backup-env-setup.sh --writer`
   - Zuerst die Projekt-ID eingeben (sichtbar), dann Access Key und Secret Key (unsichtbar).
   - Ziel ist `/root/backup-writer-test.env` (root, 600). Das Skript bricht ab, wenn versehentlich der Admin-Testschlüssel
     eingefügt wird oder die Datei schon existiert.
   - Das Skript mit dem Modus `--writer` muss vorher auf den Server; das gehört zu Schritt 2 in Abschnitt 4.
5. Mir Bescheid geben, ohne Schlüssel: „Writer-Projekt angelegt, Datei liegt auf dem Server.“

**Nach dem Test:**
- Den Schlüssel `writer-test` in der Console löschen; auf dem Server `shred -u /root/backup-writer-test.env`.
- Das Projekt bleibt für die produktiven Schreibschlüssel `coolify-db` und `dateisicherung` bestehen. Sie entstehen erst mit
  dem produktiven Bucket.

## 4. Ablauf und Freigaben

| Schritt | Wer | Freigabe nötig |
|---|---|---|
| 1 Writer-Projekt und Testschlüssel anlegen (Abschnitt 3, Punkte 1–3) | du | ja (neues Projekt, neuer Schlüssel) |
| 2 Einrichtungsskript mit `--writer` als neue Datei `/root/backup-env-setup.sh` bereitstellen, ohne Überschreiben; die alte Fassung entferne ich danach | ich | ja |
| 3 Writer-Schlüssel verdeckt eingeben (Abschnitt 3, Punkt 4) | du | – |
| 4 Nachprüfung der Datei, nur lesend | ich | – |
| 5 Policy-Test ausführen (setzt, prüft und entfernt die Policy am Test-Bucket) | ich | ja |
| 6 Ergebnis dokumentieren; Entscheidung über die produktive Policy | ich / du | – |
| 7 Writer-Testschlüssel löschen, Datei entfernen | du / ich | ja |

**Wenn der Test zeigt, dass Hetzner Einschränkungen nicht durchsetzt** (P-Tests gelingen, N-Tests auch):
- Die Policy taugt dann nicht als Schutzschicht. Vorhandene Backups schützt weiterhin Object Lock COMPLIANCE.
- Nicht geschützt wären künftige Backups vor Änderungen an Sperre und Lifecycle, und Fassungen nach Sperrende vor endgültigem
  Löschen.
- Dann stellen wir den Vorschlag um, z. B. auf einen täglichen lesenden Prüflauf der Bucket-Einstellungen mit Alarm, und
  bewerten das Risiko neu.

**Bekannte Grenzen, unabhängig vom Ergebnis:**
- Ein Writer-Schlüssel kann in seinem **eigenen** Projekt Buckets anlegen. Das lässt sich nicht verbieten, schadet aber nur
  durch Kosten; erkennbar an der Rechnung.
- In der Console sind Buckets mit eingeschränkten Schlüsseln teils nicht mehr durchsuchbar, laut Hetzner bei
  `Deny`/`NotPrincipal` für das eigene Projekt. Unsere Policy sperrt das eigene Projekt nicht aus.

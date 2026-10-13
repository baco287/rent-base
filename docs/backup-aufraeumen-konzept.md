# Konzept: Backups aufräumen, falls die Lifecycle-Regel dauerhaft nicht funktioniert

**Stand 13.10.2026: nur Konzept.** Es ist nichts eingerichtet: kein Schlüssel, keine Policy, kein Aufräumjob. Jeder Schritt
in Abschnitt 6 braucht eine eigene Freigabe.

**Anlass:** Im Test-Bucket hat die Lifecycle-Regel auch zwei Tage nach Fälligkeit nicht gewirkt
([backup-test-bucket.md](backup-test-bucket.md)). Ohne funktionierendes Aufräumen blieben Datenbank-Dumps, und damit alle
Kundendaten, länger als die zugesagten rund 31 Tage im Backup ([backup-strategie.md](backup-strategie.md), Datenschutz).

## 1. Ziele

| Ziel | Wert |
|---|---|
| Dumps verschwinden | etwa 31 Tage nach dem Erstellen, spätestens nach 32 Tagen |
| Alte Dateifassungen (`files/`) verschwinden | 7 Tage, nachdem sie überschrieben oder gelöscht wurden |
| Merkliste (`files-state/`) | alte Fassungen nach 1 Tag |
| Abgebrochene Teil-Uploads | nach 7 Tagen |
| Vorzeitiges Löschen | **unmöglich**, auch mit gestohlenen Schlüsseln (Object Lock COMPLIANCE 30 Tage) |
| Fehlende Backups | nie stillschweigend alles löschen; lieber alarmieren und alte Stände behalten |

## 2. Grundidee

Ein **eigener, eng begrenzter Aufräumschlüssel** löscht täglich alte Fassungen. Der COMPLIANCE-Modus ist dabei die eigentliche
Sicherung:
- Solange eine Fassung gesperrt ist (30 Tage), lehnt der Speicher jedes endgültige Löschen ab, egal mit welchem Schlüssel.
- Der Aufräumschlüssel kann deshalb nur entfernen, was ohnehin fällig ist.

## 3. Schlüssel und Rechte (Bucket-Policy)

Ein dritter Schlüssel `aufraeumen` im Projekt „Rent-Base Backup-Writer“, getrennt von `coolify-db` und `dateisicherung`:

| Erlaubt | Wofür |
|---|---|
| `s3:ListBucket`, `s3:ListBucketVersions` | Fassungen und Löschmarker auflisten |
| `s3:GetObjectRetention` | vor dem Löschen prüfen, ob die Sperre abgelaufen ist |
| `s3:DeleteObjectVersion` auf `<Dump-Präfix>/*`, `files/*`, `files-state/*` | fällige Fassungen und verwaiste Löschmarker endgültig entfernen |
| `s3:ListBucketMultipartUploads`, `s3:AbortMultipartUpload` | abgebrochene Teil-Uploads entfernen |

**Ausdrücklich verboten** (`Deny`):
- `s3:GetObject` und `s3:GetObjectVersion`: Der Schlüssel muss Backups nie **lesen**. Ein Leck verrät also keine Kundendaten.
- `s3:PutObject`
- `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, `s3:BypassGovernanceRetention`
- alle Bucket-Einstellungen: Policy, Lifecycle, Versionierung, Object Lock

**Was ein gestohlener Aufräumschlüssel anrichten kann:**
- Er kann Fassungen entfernen, deren 30-tägige Sperre abgelaufen ist, also höchstens etwas früher als geplant. Jüngere
  Backups bleiben unantastbar.
- Er kann weder lesen noch schreiben, noch die Regeln ändern.

## 4. Ablauf des Aufräumlaufs (Skript `scripts/backup-purge.mjs`, noch zu schreiben)

Täglich als Scheduled Task im App-Container, mit eigenen Variablen `PURGE_S3_*`, getrennt von `BACKUP_S3_*`.

1. **Bestand lesen:** alle Fassungen und Löschmarker unter den drei Präfixen, seitenweise.
2. **Fällig ist eine Fassung nur, wenn alle Bedingungen erfüllt sind:**
   - die Sperre ist abgelaufen, laut `GetObjectRetention`, nicht nur laut Datum;
   - sie ist alt genug:
     - Dumps: älter als 31 Tage;
     - `files/`: nicht aktuell, und ihre Nachfolgefassung bzw. ihr Löschmarker ist älter als 7 Tage;
     - `files-state/`: nicht aktuell und älter als 1 Tag;
   - sie ist **nie** die aktuelle Fassung einer Datei unter `files/`. Aktuelle Dateien entfernt nur die Dateisicherung, per
     Löschmarker.
3. **Verwaiste Löschmarker** (ohne verbliebene Fassung) entfernen. Das entspricht `ExpiredObjectDeleteMarker`.
4. **Teil-Uploads,** die älter als 7 Tage sind, abbrechen.
5. **Schutzschwellen,** die einen Lauf ohne Löschen abbrechen und Alarm geben:
   - **Bestandsprüfung:** Gibt es weniger als 24 Dumps aus den letzten 31 Tagen, wird nichts gelöscht. Dann stockt vermutlich
     das Backup, und die alten Stände sind der letzte Rückhalt.
   - **Mengenbegrenzung:** Mehr als 10 % aller Fassungen oder mehr als 500 auf einmal wären fällig.
   - **Uhrzeit:** Die Uhr des Servers weicht deutlich von der Zeitangabe des Speichers ab.
6. **Ausgabe:** nur Zahlen (fällig, gelöscht, übersprungen, Fehler) und keine Schlüssel. Ein Fehlschlag meldet sich über
   Coolifys Benachrichtigung „Scheduled task failure“.
7. **Testmodus** `--dry-run`: zeigt, was gelöscht würde, ohne zu löschen. Pflicht vor der ersten echten Ausführung.

## 5. Bewertung

| Weg | Datenschutzfrist | Aufwand | Risiko |
|---|---|---|---|
| Lifecycle-Regel (falls Hetzner sie doch ausführt) | ~31–32 Tage | keiner | im Test ohne Wirkung |
| **Aufräumschlüssel, täglich (dieses Konzept)** | ~31–32 Tage | ein Skript, ein Schlüssel, eine Policy | Gestohlener Schlüssel: nur fällige Fassungen, kein Lesezugriff |
| Admin-Schlüssel, monatlich vom eigenen Rechner | bis zu ~61 Tage | manuell, regelmäßig | Admin-Schlüssel kurzzeitig im Einsatz; Termin kann vergessen werden |

**Empfehlung:**
- **Der tägliche Aufräumschlüssel**, sobald der Policy-Test belegt, dass Hetzner aktionsgenaue Rechte und Präfix-Einschränkungen
  durchsetzt.
- **Bis dahin, als Ersatz:** der monatliche Admin-Lauf.
- **Falls Hetzner die Lifecycle-Regel doch ausführt:** sie zusätzlich behalten. Der Aufräumlauf prüft dann nur noch nach.

## 6. Voraussetzungen und Freigaben (Reihenfolge)

1. Der Policy-Test ist mit funktionierendem Writer-Schlüssel bestanden.
2. Ein Policy-Test für den Aufräumschlüssel am Test-Bucket belegt:
   - `DeleteObjectVersion` wirkt nur nach Ablauf der Sperre.
   - Kein Lesen ist möglich.
   - Präfixe werden eingehalten.
3. Das Skript `backup-purge.mjs` ist geschrieben und gegen einen nachgebildeten Speicher getestet: Schutzschwellen, Testmodus,
   keine Schlüssel in Ausgaben.
4. Ein Testmodus-Lauf am produktiven Bucket hat stattgefunden, frühestens 31 Tage nach dem ersten Backup; erst dann echte Läufe.
5. Die Fristen sind ins Löschkonzept übernommen und rechtlich bestätigt.

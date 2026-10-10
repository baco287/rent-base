# Backup-Strategie: Object Lock, Zugangsdaten, Datenschutz

Entscheidungsgrundlage für den Backup-Bucket. Das operative Vorgehen steht in [backup.md](backup.md).

**Stand:** 09.10.2026, nur aus Anbieter-Dokumentation und Quellcode geprüft. **Es ist noch nichts angelegt.**

**Quellen:**
- Hetzner: [Buckets und Objekte](https://docs.hetzner.com/storage/object-storage/faq/buckets-objects/), [Object Lock Retention](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/protect-object-lock-retention/), [Lifecycle](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/manage-lifecycle/), [S3-Zugangsdaten](https://docs.hetzner.com/storage/object-storage/faq/s3-credentials/), [unterstützte Aktionen](https://docs.hetzner.com/storage/object-storage/supported-actions/)
- Coolify v4.4.3: `app/Jobs/DatabaseBackupJob.php`

## Ziele

| Ziel | Wert |
|---|---|
| Datenbank-Sicherung | alle 6 Stunden |
| Dateisicherung | alle 6 Stunden, mindestens täglich |
| Aufbewahrung | 30 Tage |
| Maximaler Datenverlust (RPO) | 6 Stunden |
| Schutz vor versehentlichem Löschen | ja |
| Schutz vor gestohlenen Zugangsdaten (App, Backup-Schreibschlüssel, Server) | ja, mindestens 30 Tage lang nicht löschbar |
| Datenschutz | gelöschte Daten verschwinden nach einer festen, dokumentierten Frist auch aus Backups |
| Wiederherstellung | regelmäßig geübt, Ergebnis nachprüfbar protokolliert |

## Was Hetzner bietet (laut Dokumentation)

- **Object Lock:** Wird **nur beim Anlegen des Buckets** eingeschaltet (Console oder API) und lässt sich nachträglich nicht hinzufügen. Er schaltet die Versionierung dauerhaft ein.
- **Modi:**
  - **Compliance:** „Niemand kann die Frist vorzeitig beenden“, auch der Inhaber nicht.
  - **Governance:** Lässt sich mit Sonderrecht umgehen. Hetzner-Zugangsdaten haben standardmäßig vollen Zugriff auf ihr Projekt. **Für den Schutz gegen gestohlene Schlüssel taugt deshalb nur Compliance.**
- **Standard-Frist** pro Bucket: per API (`put-object-lock-configuration`). Ob das auch in der Console geht, ist nicht belegt.
- **Lifecycle-Regeln:** Expiration, NoncurrentVersionExpiration (nur `NoncurrentDays`), ExpiredObjectDeleteMarker und AbortIncompleteMultipartUpload werden unterstützt. Gesperrte Versionen werden erst nach Ablauf ihrer Frist entfernt.
- **Zugangsdaten:** Sie gelten standardmäßig für alle Buckets ihres Projekts. Einzelne Rechte lassen sich über eine Bucket-Policy vergeben, auch an Schlüssel aus **einem anderen Projekt**. Hetzner beschreibt genau dieses Muster.
- **Abrechnung:** nach Gesamtgröße, alte Versionen eingeschlossen. Kleinstgröße je Objekt sind 64 kB.
- **Vorsicht:** In **fsn1** war Object Lock vom 10.11.2025 bis 17.01.2026 gestört ([Statusmeldung](https://status.hetzner.com/incident/5517a22b-2040-4ee3-9929-d2f480e7e163)). Deshalb muss die Durchsetzung vor dem Einsatz am Test-Bucket geprüft werden.

## Zielarchitektur

```
Projekt „Rent-Base“ (nbg1)            App-Bucket, App-Schlüssel (S3_*)
Projekt „Rent-Base Backup“ (fsn1)     Backup-Bucket mit Object Lock, Admin-Schlüssel NUR im Passwortmanager
Projekt „Rent-Base Backup-Writer“     kein Bucket; nur der Schreibschlüssel, Rechte per Bucket-Policy
```

| Schlüssel | Wo eingetragen | Darf |
|---|---|---|
| App-Schlüssel (`S3_*`) | App | App-Bucket (wie heute) |
| **Schreibschlüssel** | Coolify „S3 Storage“ und `BACKUP_S3_*` der App | Hochladen, Lesen, Auflisten, Löschmarker setzen, Lock-Konfiguration lesen |
| **Admin-Schlüssel** | **nirgends auf dem Server**, nur im Passwortmanager | Einrichtung (Lock-Frist, Lifecycle, Policy) und Notfall-Wiederherstellung alter Versionen |

**Schreibschlüssel, erlaubt:**
- `s3:PutObject`, `s3:GetObject`, `s3:GetObjectVersion`, `s3:ListBucket`
- `s3:GetBucketLocation`, `s3:GetBucketObjectLockConfiguration`. Das MinIO-Werkzeug, mit dem Coolify hochlädt, braucht das, um bei gesperrten Buckets die nötige MD5-Prüfsumme zu senden.
- `s3:DeleteObject`. In einem versionierten Bucket setzt das nur einen Löschmarker, die Daten bleiben erhalten. Coolify braucht es für seine Aufbewahrungsregel, die Dateisicherung für legitime Löschungen.

**Schreibschlüssel, ausdrücklich verboten:**
- `s3:DeleteObjectVersion`
- `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, `s3:BypassGovernanceRetention`
- `s3:PutBucketPolicy`, `s3:DeleteBucketPolicy`
- `s3:PutLifecycleConfiguration`, `s3:PutBucketVersioning`, `s3:PutBucketObjectLockConfiguration`

Zu `s3:PutObjectRetention`: Wer Fristen verlängern darf, kann Datenschutz-Löschungen beliebig blockieren.

**Bucket-Einstellungen** (mit dem Admin-Schlüssel):

| Einstellung | Wert | Wirkung |
|---|---|---|
| Object Lock Standard-Frist | **COMPLIANCE, 30 Tage** | Jede hochgeladene Version ist 30 Tage unlöschbar und nicht überschreibbar, auch für den Admin-Schlüssel |
| Lifecycle: Coolify-Dumps (Präfix nach dem ersten Upload ablesen) | `Expiration.Days = 31`, `NoncurrentDays = 1` | Ein Dump verschwindet kurz nach seiner Frist, auch wenn Coolifys eigenes Aufräumen einmal ausfällt |
| Lifecycle: `files/` | `NoncurrentDays = 7`, ExpiredObjectDeleteMarker | Überschriebene oder gelöschte Dateien bleiben noch 7 Tage als alte Version erreichbar |
| Lifecycle: `files-state/` | `NoncurrentDays = 1` | Die Merkliste der Sicherung sammelt keine Versionen an |
| Lifecycle: ganzer Bucket | AbortIncompleteMultipartUpload 7 Tage | Abgebrochene Uploads verursachen keine Kosten |
| Dateisicherung | `BACKUP_GRACE_DAYS = 7` | Die Versionierung hält gelöschte Dateien ohnehin noch 7 Tage |

## Wechselwirkungen

### Object Lock und automatisches Löschen

- **Coolify** löscht alte Dumps mit einem einfachen `DeleteObject`. Im versionierten Bucket setzt das einen Löschmarker, was auch bei Compliance erlaubt ist. Coolify zeigt das Backup danach als gelöscht an, die Daten bleiben aber, bis Frist und Lifecycle sie entfernen.
- **Die Dateisicherung** löscht nur legitim gelöschte Entwurfsfotos und Führerscheinkopien (Löschregel in [backup.md](backup.md)), ebenfalls per Löschmarker. Andere Dateien löscht sie nie.
- **Was ein gestohlener Schreibschlüssel anrichten kann:** Löschmarker setzen und neue Versionen hochladen.
  - **Geschützt bleibt:** jede Version in ihren ersten 30 Tagen, und jede ältere Version mindestens 7 Tage nach dem Überschreiben bzw. nach dem Löschmarker.
  - **Erkennung:** Die nächtliche Dateisicherung meldet eine Abweichung zwischen App und Backup innerhalb von höchstens 6 Stunden (Abweichungsmeldung bzw. erneutes Kopieren). Bis dahin ist alles aus alten Versionen wiederherstellbar (siehe [backup.md](backup.md), „Alte Version zurückholen“).
- **Was er nicht kann:** Versionen endgültig löschen, Fristen ändern, Lifecycle oder Policy ändern.

### Datenschutz (DSGVO), zur rechtlichen Prüfung vorlegen

| Daten | Wann sie aus den Backups verschwinden |
|---|---|
| Datenbank-Dumps (enthalten alle Kundendaten, auch später gelöschte) | etwa **31 Tage** nach dem Erstellen: 30 Tage Frist, dann am Folgetag per Lifecycle |
| Führerscheinkopie, in der App gelöscht am Tag X | Löschmarker nach 7 Tagen Frist, dann 7 Tage alte Version, also frühestens **X + 15**. Spätestens 30 Tage nach dem Hochladen der Kopie plus 1 Tag, falls das später ist. |
| Entwurfsfotos | wie Führerscheinkopien |
| Verträge, Protokolle, Rechnungen, Akten | werden in der App nie gelöscht und deshalb auch im Backup nicht. Aufbewahrungspflichten etwa nach HGB und AO gelten weiter. |
| Hetzner-Server-Backups | 7 Tage, ganzer Server einschließlich Datenbank |

**Compliance-Modus:** Er schließt eine **vorzeitige** Löschung einzelner Daten aus Backups technisch aus, auch auf Anfrage einer betroffenen Person. Üblich und hier vorgesehen ist:
- im Löschkonzept eine feste Backup-Frist von 30 Tagen nennen,
- bei einer Wiederherstellung zwischenzeitlich gelöschte Daten erneut löschen (Löschprotokoll).

**Bitte rechtlich bestätigen lassen.**

## Vor dem produktiven Einsatz: Test-Bucket (nicht verifizierte Punkte)

In einem Test-Bucket mit Object Lock im **Compliance-Modus mit 1 Tag** Frist in fsn1 prüfen. Erst wenn alle Punkte bestanden sind, den produktiven Bucket anlegen.

1. **Sperre:** Eine Version lässt sich weder mit dem Schreib- noch mit dem Admin-Schlüssel löschen (`delete-object --version-id …` scheitert).
2. **Policy:** Der Schreibschlüssel darf hochladen, lesen und Löschmarker setzen. `DeleteObjectVersion`, `PutObjectRetention` und `PutBucketPolicy` werden abgewiesen.
3. **Coolify:** Ein Datenbank-Backup mit diesem Bucket läuft durch, und die Aufbewahrungsregel setzt Löschmarker. Dabei das Präfix der Dumps notieren, es wird für die Lifecycle-Regel gebraucht.
4. **Dateisicherung:** `scripts/backup-files.mjs` lädt hoch. Das AWS SDK sendet dabei die CRC32-Prüfsumme im Header, weil der Inhalt als Puffer übergeben wird, nicht als Datenstrom.
5. **Lifecycle:** Nach 2 bis 3 Tagen sind alte Versionen nach Fristablauf verschwunden.
6. **Wiederherstellung:** Mit dem Admin-Schlüssel lässt sich eine alte Version zurückholen (siehe [backup.md](backup.md)).

## Was die Strategie nicht abdeckt

- **Übernahme des Hetzner-Kontos:** Wer das Konto übernimmt, erreicht alle Projekte.
  - Gegenmaßnahmen: Zwei-Faktor-Anmeldung für alle Hetzner-Zugänge, möglichst wenige Personen mit Zugriff auf das Backup-Projekt.
  - Optional: eine monatliche, verschlüsselte Kopie des neuesten Dumps bei einem anderen Anbieter oder offline.
- **Datenbank-Zugangsdaten mit Schreibrecht:** Damit lassen sich Entwurfsdaten löschen. Versiegelte Verträge und Protokolle schützen die Trigger. Gelöschtes lässt sich aus dem Dump der letzten 6 Stunden zurückholen.
- **Fehler, die erst nach mehr als 30 Tagen bemerkt werden:** Sie lassen sich nicht aus Backups beheben.

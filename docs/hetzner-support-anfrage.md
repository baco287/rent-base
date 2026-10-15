# Entwurf: Anfrage an den Hetzner-Support (Bucket-Policy für Schlüssel aus anderem Projekt, Lifecycle-Verzögerung)

**Stand 15.10.2026. Entwurf zum Absenden durch dich**, über die Hetzner Console → Support → „Neue Anfrage“, Kategorie Object
Storage. Ersetzt den früheren Entwurf [hetzner-support-lifecycle.md](hetzner-support-lifecycle.md).

**Vor dem Absenden ergänzen:**
- die Projekt-ID von „Rent-Base Backup“, aus der Console-Adresse `…/projects/<ID>/…`;
- die **Access-Key-ID** (nicht den Secret Key) des Schlüssels `writer-test` im Projekt „Rent-Base Backup-Writer“, nur falls
  Hetzner sie für die Suche in den Protokollen braucht.

**Nicht hineinschreiben:** Secret Keys, Passwörter, Server-IP-Adressen.

---

**Betreff:** Object Storage hel1: Bucket-Policy für Schlüssel aus anderem Projekt wirkt nur teilweise; Lifecycle mit rund 2 Tagen Verzögerung

Guten Tag,

wir bereiten Datenbank- und Dateibackups in Ihrem Object Storage vor (hel1, Object Lock) und haben zwei Beobachtungen, zu denen
wir um Einordnung bitten. Unsere Tests liefen ausschließlich in einem Test-Bucket mit künstlichen Daten.

### Umgebung

- **Bucket:** `rent-base-backup-test`, Standort hel1, Projekt „Rent-Base Backup“ (Projekt-ID `<bitte ergänzen>`)
- Object Lock beim Anlegen aktiviert, Versionierung „Enabled“, Standard-Sperre COMPLIANCE 1 Tag
- **Zweites Projekt** „Rent-Base Backup-Writer“, **Projekt-ID 16367501**, ohne eigenen Bucket, mit einem S3-Schlüssel
  `writer-test`
- **Clients:** AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` 3.1136, Node 22) mit Endpunkt
  `https://hel1.your-objectstorage.com`, Pfad-Stil, Region `hel1`; außerdem `mc` aus dem Coolify-Hilfscontainer
  (coolify-helper 1.0.17)

### 1. Bucket-Policy für einen Schlüssel aus einem anderen Projekt wirkt nur teilweise

Am **14.10.2026 zwischen 07:24 und 07:28 UTC** war folgende Policy am Bucket gesetzt. `<RUN>` steht für
`rb-test/policy/20261014T072427Z-a3e4f3/`. Das Setzen per `PutBucketPolicy` mit dem Schlüssel des Bucket-Projekts wurde
angenommen, und `GetBucketPolicy` lieferte sie unverändert zurück.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "RbTestWriterBucket", "Effect": "Allow",
      "Principal": { "AWS": ["arn:aws:iam:::user/p16367501:<Access-Key-ID writer-test>"] },
      "Resource": ["arn:aws:s3:::rent-base-backup-test"],
      "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketObjectLockConfiguration"] },
    { "Sid": "RbTestWriterObjekte", "Effect": "Allow",
      "Principal": { "AWS": ["arn:aws:iam:::user/p16367501:<Access-Key-ID writer-test>"] },
      "Resource": ["arn:aws:s3:::rent-base-backup-test/<RUN>w/*"],
      "Action": ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"] },
    { "Sid": "RbTestWriterLoeschmarkerNurInFiles", "Effect": "Allow",
      "Principal": { "AWS": ["arn:aws:iam:::user/p16367501:<Access-Key-ID writer-test>"] },
      "Resource": ["arn:aws:s3:::rent-base-backup-test/<RUN>w/files/*"],
      "Action": ["s3:DeleteObject"] },
    { "Sid": "RbTestWriterDarfNie", "Effect": "Deny",
      "Principal": { "AWS": ["arn:aws:iam:::user/p16367501:<Access-Key-ID writer-test>"] },
      "Resource": ["arn:aws:s3:::rent-base-backup-test", "arn:aws:s3:::rent-base-backup-test/*"],
      "Action": ["s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention",
                 "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutLifecycleConfiguration", "s3:PutBucketVersioning",
                 "s3:PutBucketObjectLockConfiguration"] }
  ]
}
```

Anfragen mit dem Schlüssel aus Projekt 16367501, jeweils **einmal** gesendet, in dieser Reihenfolge innerhalb weniger Minuten:

| Nr. | Anfrage | Ergebnis |
|---|---|---|
| P1 | `GET /rent-base-backup-test?list-type=2&prefix=<RUN>` (ListObjectsV2) | 200 |
| **P2** | `GET /rent-base-backup-test?location` (GetBucketLocation) | **403 AccessDenied** |
| P3 | `GET /rent-base-backup-test?object-lock` | 200 |
| **P4** | `PUT …/<RUN>w/db/probe.txt`, 45 Byte; Kopfzeilen `x-amz-checksum-crc32` und `x-amz-sdk-checksum-algorithm: CRC32`, signierter Payload, kein `aws-chunked` | **403 AccessDenied** |
| P5 | `PUT …/<RUN>w/files/probe.txt`, 45 Byte, `Content-MD5`, signierter Payload | 200 |
| **P6** | Multipart unter `…/<RUN>w/db/teile.bin`: `POST ?uploads` lieferte eine UploadId; danach `PUT ?partNumber=1&uploadId=…` (5 MiB) und `?partNumber=2` (1 MiB) mit `Content-MD5`, dann `POST ?uploadId=…` | Start **200**, danach **403 AccessDenied**. Welcher Schritt abgewiesen wurde, haben wir leider nicht einzeln aufgezeichnet |
| **P9** | `DELETE …/<RUN>w/files/probe.txt`, ohne `versionId`, ohne Bypass-Kopfzeile; erwartet war ein Löschmarker | **403 AccessDenied** |
| P10 | `PUT …/<RUN>aussen.txt`, außerhalb von `w/`, nicht freigegeben | 403 (erwartet) |
| **M3** | `mc cp` einer 17-MiB-Datei nach `…/<RUN>w/coolify/pg-dump.dmp` | Upload-Start gelang (eine unvollständige Multipart-Upload blieb zurück), danach „Insufficient permissions“ |

**Zur Abgrenzung:**
- **Der Schlüssel des Bucket-Projekts** konnte am 10.10.2026 dieselben Anfrageformen ausführen: Upload mit
  CRC32-Kopfzeilen, Multipart mit Content-MD5, Löschmarker, `mc cp` mit 20 MB.
- **`GetBucketLocation`** beantwortet der Bucket-Projekt-Schlüssel am 14.10. um 11:48 UTC in 10 von 10 Versuchen mit `hel1`,
  im Pfad- und im Subdomain-Stil.
- **Gemeinsamer Nenner:** In jedem abgewiesenen Fall lief eine vergleichbare Anfrage desselben Schlüssels kurz davor oder danach
  durch:
  - dieselbe Aktion: `CreateMultipartUpload` und `PutObject` unter `w/db/`, beides `s3:PutObject`
  - oder dieselbe Policy-Anweisung: `GetBucketObjectLockConfiguration` neben `GetBucketLocation`
- **Ohne Policy** wies der Bucket den Schlüssel erwartungsgemäß vollständig ab, vorher und nachher.

**Unsere Fragen:**
1. Werden Bucket-Policies für Principals aus einem **anderen Projekt** (`arn:aws:iam:::user/p<Projekt-ID>:<Access-Key-ID>`) für
   alle oben genannten Aktionen unterstützt? Gilt das auch für die Teilschritte von Multipart-Uploads
   (`UploadPart`, `CompleteMultipartUpload`) und für `DeleteObject` ohne `versionId` in einem Bucket mit Object Lock?
2. Ordnen Sie einzelne Anfragen anderen Policy-Aktionen zu als AWS? Zum Beispiel:
   - `DeleteObject` in versionierten oder Object-Lock-Buckets als `s3:DeleteObjectVersion`
   - Uploads mit `x-amz-checksum-*`-Kopfzeilen
   - `GetBucketLocation` nur für den Bucket-Besitzer
3. Wird eine gesetzte Bucket-Policy auf allen Ihren Frontends bzw. Clustern gleichzeitig wirksam? Mit welcher Verzögerung ist
   nach `PutBucketPolicy` zu rechnen, bis sie überall gilt?
4. Gab es am 14.10.2026 zwischen 07:24 und 07:28 UTC in hel1 Störungen oder Bucket-Migrationen, die den Bucket
   `rent-base-backup-test` betrafen?
5. Können Sie für diesen Zeitraum in Ihren Protokollen nachsehen, warum die Anfragen P2, P4, P6, P9 und M3 abgewiesen wurden?
   Bucket `rent-base-backup-test`, Schlüssel aus Projekt 16367501.
6. Wertet Ihr Object Storage ein ausdrückliches `Deny` in Bucket-Policies aus?
7. Werden Sperr- und Legal-Hold-Kopfzeilen beim Hochladen (`x-amz-object-lock-mode`, `x-amz-object-lock-retain-until-date`,
   `x-amz-object-lock-legal-hold`) gegen `s3:PutObjectRetention` bzw. `s3:PutObjectLegalHold` geprüft, oder nur gegen
   `s3:PutObject`?
8. Wird `s3:AbortMultipartUpload` in Bucket-Policies unterstützt?

### 2. Lifecycle-Regel wird mit rund zwei Tagen Verzögerung ausgeführt

**Regel** (gesetzt am 10.10.2026 gegen 11:14 UTC; `GetBucketLifecycleConfiguration` liefert sie unverändert zurück):

```json
{ "Rules": [ { "ID": "rb-test-ablauf", "Status": "Enabled", "Filter": { "Prefix": "rb-test/lc/" },
               "Expiration": { "Days": 1 }, "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } } ] }
```

**Objekt:** `rb-test/lc/ablauf.txt`, hochgeladen am 10.10.2026 um 11:13 UTC. Sperre (COMPLIANCE, 1 Tag) bis 11.10.2026 11:13 UTC.

| Zeitpunkt (UTC) | Beobachtung |
|---|---|
| 11.10. 21:2x, 12.10. 12:07, 13.10. 18:57 | 1 Fassung, kein Löschmarker |
| **14.10. 01:30** | **Löschmarker gesetzt** (laut `LastModified` des Markers); die alte Fassung ist noch da |
| 14.10. 07:18 und 12:07 | unverändert: Löschmarker und alte Fassung |

**Erwartet:**
- Nach S3-Semantik wäre der Löschmarker ab dem 12.10. um 00:00 UTC fällig gewesen. Gesetzt wurde er rund 49,5 Stunden später.
- Das endgültige Entfernen der alten Fassung (`NoncurrentVersionExpiration`, 1 Tag) wäre ab dem 15.10. fällig.
- *Stand der Nachprüfung am 16.10.:* `<nach der Prüfung ergänzen>`

**Unsere Fragen:**
1. Wie oft und zu welchen Zeiten werden Lifecycle-Regeln verarbeitet? Ist eine Verzögerung von rund zwei Tagen nach Fälligkeit
   üblich, und mit welcher Höchstdauer sollten wir planen?
2. Wird `NoncurrentVersionExpiration` in Buckets mit Object Lock ausgeführt, nachdem die Sperre der Fassung abgelaufen ist?
3. Werden Löschmarker ohne ältere Fassung („expired object delete markers“) automatisch entfernt? Oder braucht es dafür
   `ExpiredObjectDeleteMarker` in einer eigenen Regel? Ist eine zweite Regel mit demselben Präfix zulässig?
4. Werden `AbortIncompleteMultipartUpload`-Regeln mit leerem Präfix (`"Filter": { "Prefix": "" }`) unterstützt?
5. Gibt es eine Möglichkeit, die Lifecycle-Verarbeitung eines Buckets zu prüfen, etwa Status oder Protokoll?

Wir planen Löschfristen für personenbezogene Daten in Backups und brauchen dafür eine verlässliche Obergrenze, bis wann
abgelaufene Fassungen entfernt sind.

Vielen Dank und freundliche Grüße

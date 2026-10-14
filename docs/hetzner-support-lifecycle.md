# Entwurf: Anfrage an den Hetzner-Support zu Lifecycle-Regeln

**Stand 13.10.2026. Entwurf zum Absenden durch dich**, z. B. über die Hetzner Console → Support → „Neue Anfrage“
(Kategorie Object Storage).

- **Vor dem Absenden ergänzen:** die Projekt-ID des Projekts „Rent-Base Backup“, aus der Console-Adresse `…/projects/<ID>/…`.
- **Nicht hineinschreiben:** Zugangsschlüssel, Passwörter oder IP-Adressen. Hetzner braucht sie für die Frage nicht.

---

**Betreff:** Object Storage (hel1): Lifecycle-Regel wird in Bucket mit Object Lock nicht ausgeführt

Guten Tag,

in unserem Object-Storage-Bucket wird eine Lifecycle-Regel angenommen und lässt sich auslesen, wird aber nach mehr als zwei
Tagen nicht ausgeführt. Wir möchten verstehen, ob das erwartetes Verhalten ist, bevor wir produktive Backups einrichten.

**Bucket**
- Projekt: Rent-Base Backup (Projekt-ID: `<bitte ergänzen>`)
- Bucket: `rent-base-backup-test`, Standort hel1
- Object Lock beim Anlegen aktiviert; Versionierung „Enabled“
- Standard-Sperre: COMPLIANCE, 1 Tag

**Lifecycle-Konfiguration** (gesetzt am 10.10.2026 gegen 11:14 UTC per `PutBucketLifecycleConfiguration`, AWS SDK v3;
`GetBucketLifecycleConfiguration` liefert sie unverändert zurück):

```json
{
  "Rules": [
    {
      "ID": "rb-test-ablauf",
      "Status": "Enabled",
      "Filter": { "Prefix": "rb-test/lc/" },
      "Expiration": { "Days": 1 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }
    }
  ]
}
```

**Betroffenes Objekt**
- `rb-test/lc/ablauf.txt`, hochgeladen am 10.10.2026 um 11:13 UTC, eine Fassung.
- Die Sperre (COMPLIANCE, Standard-Sperre) endete am 11.10.2026 um 11:13 UTC.

**Beobachtung**

| Zeitpunkt (UTC) | Ergebnis |
|---|---|
| 11.10.2026, 21:2x | 1 Fassung, kein Löschmarker |
| 12.10.2026, 12:07 | unverändert |
| 13.10.2026, 18:57 | unverändert |

Nach unserem Verständnis der S3-Semantik hätte die Regel ab dem 12.10.2026 um 00:00 UTC einen Löschmarker setzen und die alte
Fassung einen Tag später entfernen sollen. Andere Objekte im Bucket außerhalb des Präfixes sind wie erwartet unverändert.

**Unsere Fragen**
1. Wie oft und zu welchen Zeiten werden Lifecycle-Regeln verarbeitet? Mit welcher Verzögerung ist nach Fälligkeit zu rechnen?
2. Werden Regeln mit Präfix-Filter (`Filter.Prefix`) unterstützt, oder nur Regeln für den ganzen Bucket bzw. das ältere Feld
   `Prefix` auf oberster Ebene?
3. Werden Lifecycle-Regeln (Expiration, NoncurrentVersionExpiration) in Buckets mit aktiviertem Object Lock ausgeführt, auch
   nachdem die Sperre einer Fassung abgelaufen ist? Gibt es Einschränkungen in Verbindung mit einer Standard-Sperre?
4. Ist die Kombination von `Expiration` und `NoncurrentVersionExpiration` in einer Regel zulässig?
5. Gibt es eine Möglichkeit, die Verarbeitung zu prüfen (Status, Protokoll), oder einen empfohlenen Weg, um in einem Bucket mit
   Object Lock Backups nach Ablauf der Sperre automatisch zu löschen?
6. Wir möchten einem S3-Schlüssel aus einem **zweiten Projekt, das selbst keinen Bucket hat**, per Bucket-Policy eingeschränkte
   Rechte auf diesen Bucket geben (Principal `arn:aws:iam:::user/p<Projekt-ID>:<Access-Key>`).
   - Sind S3-Zugangsdaten eines Projekts ohne eigenen Bucket am Endpunkt `hel1.your-objectstorage.com` gültig?
   - Muss Object Storage im zweiten Projekt dafür erst aktiviert werden?
   - Zur Einordnung, nicht zum Absenden: Unser erster Fehlversuch („InvalidAccessKeyId“) beruhte auf einem Eingabefehler auf
     unserer Seite. Diese Frage ist deshalb nur noch vorsorglich gestellt.

Vielen Dank und freundliche Grüße

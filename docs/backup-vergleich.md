# Gegenüberstellung: Übergangsweg und eingeschränkte Writer-Schlüssel

**Stand 15.10.2026.**

**Grundlagen:**
- Bucket-Test (10./11.10.)
- Policy-Test (14.10., [backup-policy-test.md](backup-policy-test.md) 7d)
- Vortest der Produktionsskripte und Analyse der Writer-Fälle (14.10., [backup-prod-vortest.md](backup-prod-vortest.md))
- Lifecycle-Prüfungen bis 14.10. ([backup-test-bucket.md](backup-test-bucket.md))

**Die beiden Wege:**
- **Übergangsweg:** Coolify und die Dateisicherung schreiben mit gewöhnlichen Projektschlüsseln, also mit vollen Rechten im
  Backup-Projekt ([backup-uebergang.md](backup-uebergang.md)).
- **Writer-Weg:** Schlüssel aus einem eigenen Projekt, eingeschränkt per Bucket-Policy
  ([backup-produktion-vorschlag.md](backup-produktion-vorschlag.md), Abschnitt 2).

Beide nutzen Object Lock COMPLIANCE 30 Tage, dieselben Lifecycle-Regeln und den Prüflauf.

## 1. Was jeder Weg leistet

| Aspekt | Übergangsweg (volle Rechte) | Writer-Weg (eingeschränkt) |
|---|---|---|
| **Funktioniert heute mit Coolify** | **ja**: `mc cp` mit vollem Schlüssel in den Object-Lock-Bucket am 10.10. belegt; Skripte am 14.10. gegen Hetzner geprüft | **nein**: Upload in Teilen und `mc cp` am 14.10. abgewiesen (P6, M3). Ursache bei Hetzner, ungeklärt |
| Funktioniert heute mit der Dateisicherung | ja (Besitzer: Upload mit SDK-Standard und Löschmarker am 10.10. belegt) | **nein**: Upload mit SDK-Standard (P4) und Löschmarker (P9) abgewiesen. Nur Upload mit Content-MD5 gelang (P5), einmal |
| Schutz der letzten 30 Tage | COMPLIANCE: keine Fassung löschbar oder änderbar, Sperre nicht verkürzbar | gleich |
| Endgültiges Löschen nach Sperrende | **möglich** mit jedem Schlüssel. Betrifft vor allem **gesicherte Dateien, die älter als 30 Tage sind**: ungeschützt, und der Prüflauf bemerkt es nicht | verboten (`Deny` auf `DeleteObjectVersion`). Ob Hetzner das `Deny` selbst auswertet, ist unbelegt (E7) |
| Standard-Sperre, Lifecycle oder Policy ändern | **möglich**; der stündliche Prüflauf meldet es, `--wiederherstellen` setzt zurück | verboten. Die Abweisungen im Test (N6, N7, N9, N10) belegen aber nur, dass nichts freigegeben war |
| Sperren verlängern, Legal Hold, gesperrten Müll hochladen | **möglich, unumkehrbar**; teilweise gemeldet (verlängerte Sperren, Fremdobjekte, Gesamtgröße) | über die eigenen Sperr-APIs verboten. **Beim Hochladen per Kopfzeile laut Ceph-Quelltext trotzdem möglich**, bei Hetzner ungeprüft (E8) |
| Alles lesen | ja | ja (Lesen ist für Wiederherstellung nötig) |
| Weitere Buckets anlegen (Kosten) | ja, im Backup-Projekt; stündlich gemeldet | ja, im Writer-Projekt; nicht verbietbar, dort nicht gemeldet |
| Admin-Schlüssel auf dem Server | kurz im Speicher eines Wegwerf-Containers, für Einrichtung und Reparatur | nicht nötig |
| Admin liest Uploads des Writers | entfällt, ein Projekt | **offen** (K5, K6 nicht geprüft) |
| Aufräumen alter Fassungen | Lifecycle; notfalls ein Aufräumlauf mit Projektschlüssel | Lifecycle; der Writer darf nicht aufräumen, ein Aufräumlauf braucht einen eigenen Schlüssel |
| Abgebrochene Teil-Uploads | `mc` bricht selbst ab, Lifecycle nach 7 Tagen | `mc` kann nicht abbrechen (fehlendes `s3:AbortMultipartUpload`), nur der Lifecycle |
| Betriebsaufwand | gering | höher: Policy pflegen und nach jeder Änderung prüfen; Prüflauf muss die Writer-Policy kennen |

## 2. Risiken

| Risiko | Übergangsweg | Writer-Weg |
|---|---|---|
| Gestohlener Schlüssel, außerhalb benutzt | mittel: Einstellungen für künftige Backups änderbar (binnen einer Stunde gemeldet); **alte Dateien endgültig löschbar** (nicht gemeldet); unumkehrbarer Missbrauch möglich | gering: nur Hochladen, Lesen und Löschmarker unter `files/`. Unsicher bleiben die Wirkung des `Deny` und Sperr-Kopfzeilen beim Upload |
| Übernahme von App, Coolify oder Server | hoch: wie oben, dazu kann der Angreifer den Prüflauf abschalten | mittel: Einstellungen und alte Fassungen bleiben geschützt (wenn das `Deny` wirkt); der Prüflauf ist ebenfalls abschaltbar |
| Datenabfluss (alles lesbar) | gleich | gleich |
| Backups scheitern unbemerkt | gering: Coolify meldet „Backup failure“, der Prüflauf Alter und Lücken | **hoch, solange die Ursache offen ist:** Die Policy wirkte am 14.10. nicht verlässlich; Backups könnten zufällig scheitern |
| Lifecycle zu langsam oder wirkungslos | gleich: Löschfristen bis rund 40 Tage, Nachweis für alte Fassungen offen | gleich |

## 3. Technische Blocker

| Weg | Blocker | Lösbar durch |
|---|---|---|
| Übergangsweg | keiner bekannt | – |
| Writer-Weg | Hetzner weist erlaubte Anfragen ab: P2, P4, P6, P9, M3. Die Policy selbst blockiert sie nicht | Antwort des Supports ([hetzner-support-anfrage.md](hetzner-support-anfrage.md)) oder eigene Diagnose E2–E8 mit befristeter Test-Policy, danach ein neuer Policy-Test |
| Writer-Weg | `s3:AbortMultipartUpload` fehlt in der Policy | Policy ergänzen, im nächsten Policy-Test prüfen |
| Writer-Weg | Wirkung des `Deny` und Sperr-Kopfzeilen beim Hochladen unbelegt | E7, E8 |
| Beide | Endgültiges Entfernen alter Fassungen durch den Lifecycle unbelegt | Lifecycle-Prüfung ab 16.10.; sonst Aufräumlauf ([backup-aufraeumen-konzept.md](backup-aufraeumen-konzept.md)) |

## 4. Erforderliche Schutzmaßnahmen

**Übergangsweg:**
1. Prüflauf stündlich und täglich als Coolify-Task. Bis zum Deploy täglich von Hand.
2. Schlüssel getrennt halten und den Ablauf für den Schlüsseltausch kennen ([backup-uebergang.md](backup-uebergang.md),
   Abschnitt 6).
3. **Rollende Sperre für gesicherte Dateien.** Vorher am Test-Bucket prüfen, ob Hetzner das Verlängern erlaubt. Schließt die
   größte Lücke.
4. **Prüflauf von außen oder Totmann-Signal.** Nur das hilft bei einer Übernahme von Server oder Coolify.
5. Übergangszeit kurz halten; Umstieg, sobald der Writer-Weg belegt funktioniert.
6. Zwei-Faktor-Anmeldung bei Hetzner, Admin-Schlüssel nur im Passwortmanager.

**Writer-Weg, zusätzlich vor dem Umstieg:**
1. Ursache P2, P4, P6, P9, M3 klären und einen neuen Policy-Test mit wiederholten Anfragen bestehen.
2. `s3:AbortMultipartUpload` ergänzen.
3. E7 (wirkt das `Deny`?) und E8 (Sperr-Kopfzeilen beim Hochladen) prüfen.
4. K5 und K6 klären: Kann der Admin Writer-Uploads lesen, und wem gehören sie?
5. Den Prüflauf um die erwartete Policy erweitern. Erst dann umstellen und die Projektschlüssel löschen.

## 5. Einordnung

- **Heute funktioniert nur der Übergangsweg.** Er schützt die letzten 30 Tage vollständig und meldet die meisten Eingriffe.
  Er ist schwächer bei alten Dateien und bei einer Übernahme des Servers.
- **Der Writer-Weg ist sicherer, aber derzeit nicht nutzbar.** Ob und wann er nutzbar wird, hängt von Hetzner ab.
- **Ob der Übergangsweg mit seinen Grenzen genutzt wird, ist deine Entscheidung** ([backup-voraussetzungen.md](backup-voraussetzungen.md)).

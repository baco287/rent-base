# Übergabe-Entwurf beim Storno als „verworfen“ kennzeichnen (Option A)

**Umgesetzt am 10.10.2026** nach Freigabe mit den Entscheidungen E1 a, E2 a, E3 a, E4 a, E5 a, E6 a, E7 b (nur Übergaben):
Migration und Datenbankregeln in „Übergabe verwerfen (1/2)“, Anwendung in „Übergabe verwerfen (2/2)“ auf `worktree-pilot-p0`.
Abweichend vom ursprünglichen Vorschlag (unten):
- E7: Grund am Entwurf ist der feste Text „Mit dem Storno der Buchung verworfen“; der Stornogrund steht nur an der Buchung.
- Dateien (Fotos, Kopien) entfernt `removeCancellationFiles` nach dem Commit mit bis zu drei Versuchen je Datei; was dann noch
  scheitert, steht im Audit-Log (`STORAGE_FILE_REMOVAL_FAILED`, Speicherschlüssel und Kopie-Id) und kann mit derselben Funktion
  nachgeholt werden. Vorher wurden Fehler beim Entfernen stillschweigend ignoriert.
- Die Übergabe-Seite zeigt für stornierte Buchungen einen eigenen Hinweis statt „vor Einführung des Assistenten übergeben“.

Der folgende Text ist der ursprüngliche Vorschlag vom 09.10.2026 (Zeilenangaben Stand Commit 4b820c7).

## 1. Problem

Ein Storno scheitert immer, sobald im Übergabe-Entwurf eine Fahrerprüfung erfasst wurde (PostgreSQL 23001):

- `cancelBooking` → `discardHandoverDrafts` (`src/lib/cancellation.ts:57-72`) löscht Fotos, Unterschriften, Zusatzkosten,
  Checkliste, Schadenkopien und dann das Protokoll.
- Auf das Protokoll verweisen `DriverVerification.handoverId` und `DriverDocumentCopy.handoverId`, beide `ON DELETE RESTRICT`
  (Migration `20261003090000_fahrerpruefung`, Zeilen 133 und 148).
- Prüfvermerke werden nie gelöscht (`rb_guard_driver_verification`: „Prüfvermerke werden nicht gelöscht“), ihre Zuordnung ist fest.
  Dokumentkopien werden nie gelöscht, nur als gelöscht markiert (`rb_guard_driver_copy`).

Die Datenbankregeln sind richtig. Das Storno berücksichtigt sie nicht. Typischer Fall: Führerschein bei der Abholung ungültig →
Storno → Fehlermeldung, Buchung bleibt reserviert, Fahrzeug bleibt blockiert.

## 2. Lösung in einem Satz

Ein Übergabe-Entwurf mit Prüfdaten wird beim Storno nicht gelöscht, sondern bekommt den neuen Status `DISCARDED`
(wie `ContractAmendment`), seine übrigen Bestandteile werden wie bisher gelöscht, Prüfvermerke bleiben als Nachweis,
Ausweis- und Führerscheinkopien werden datenschutzgerecht gelöscht. Danach ist das Protokoll in der Datenbank unveränderlich.

## 3. Entscheidungen, die ich von dir brauche (mit Empfehlung)

| # | Frage | Empfehlung | Begründung |
|---|---|---|---|
| E1 | `DISCARDED` immer oder nur bei Prüfdaten (Vermerke oder Kopien)? | **Nur bei Prüfdaten**, sonst wie bisher löschen | Kleinste Verhaltensänderung; bestehender Test „D) Übergabe-Entwurf“ (`tests/audit.test.ts:192-202`) bleibt gültig; ohne Prüfdaten gibt es nichts aufzubewahren |
| E2 | Ausweis-/Führerscheinkopien beim Storno löschen? | **Ja**: Zeile `DELETED` mit Grund „Buchung storniert“, Datei nach dem Commit entfernen | Zweck entfällt (Datenminimierung). Heute gibt es keinen anderen Löschweg für Kopien stornierter Buchungen |
| E3 | Bestätigte Vermerke aus verworfenen Entwürfen weiter als Referenz für Wiederholungsprüfung und „zuletzt geprüft“ nutzen? | **Ja** | Die Prüfung hat tatsächlich stattgefunden; bei verworfenen Nachträgen ist das heute schon so (`driver-verification.ts:370-375`) |
| E4 | Verworfenen Entwurf in der Oberfläche zeigen? | **Nein** (Übergabe-Seite verhält sich wie heute nach dem Löschen); Nachweis über Audit-Log | Minimal; eine Nur-Lese-Ansicht kann später folgen |
| E5 | Stornobestätigung (Kunden-PDF) ergänzen? | **Nein** | Kundenseitig ohne Mehrwert |
| E6 | Freitexte/Messwerte des Protokolls beim Verwerfen leeren? | **Nein** | Der Verwerfungs-Guard (unten) erlaubt bewusst nur Status und Verwerfungsfelder; Leeren wäre eine zweite Regel |
| E7 | Grund Pflicht? | **Ja**, automatisch der Stornogrund | Das Storno verlangt ohnehin einen Grund (`cancellation.ts:360-361`) |

Offen und **nicht** Teil dieses Vorschlags: Aufbewahrungsfrist und späteres Löschen von Prüfvermerken. Das betrifft alle
Buchungen, nicht nur stornierte (es gibt heute keinen Mechanismus, `retentionUntil` wird nirgends gesetzt) – gehört ins
Löschkonzept / zur AVV.

## 4. Migration (Entwurf, nur Ergänzungen und Verschärfungen)

Neuer Ordner nach `20261022090000_miettarife`, z. B. `20261023090000_uebergabe_verworfen`. Vor dem Anlegen `origin/main`
auf neuere Migrationen prüfen.

```sql
-- Übergabe-Entwurf verwerfen statt löschen (Storno nach Fahrerprüfung). Nur Ergänzungen und Verschärfungen.
ALTER TABLE "Handover" ADD COLUMN "discardedAt" TIMESTAMP(3);
ALTER TABLE "Handover" ADD COLUMN "discardReason" TEXT;

-- Bisher ohne CHECK: der Code schreibt nur DRAFT und FINALIZED (Diagnose unten)
ALTER TABLE "Handover" ADD CONSTRAINT "rb_handover_status" CHECK ("status" IN ('DRAFT', 'FINALIZED', 'DISCARDED'));
-- Verworfen genau dann, wenn Zeitpunkt und Grund gesetzt sind; nur Übergaben (Prüfvermerke gibt es nur dort); nie zugleich finalisiert
ALTER TABLE "Handover" ADD CONSTRAINT "rb_handover_discarded" CHECK (
  (("status" = 'DISCARDED') = ("discardedAt" IS NOT NULL))
  AND (("status" = 'DISCARDED') = ("discardReason" IS NOT NULL))
  AND ("status" <> 'DISCARDED' OR ("type" = 'PICKUP' AND "finalizedAt" IS NULL AND "contentHash" IS NULL))
);

-- Protokoll: FINALIZED unverändert; DISCARDED weder änderbar noch löschbar; Verwerfen ändert nur Status und Verwerfungsfelder
CREATE OR REPLACE FUNCTION rb_guard_handover() RETURNS trigger AS $$
DECLARE
  o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'FINALIZED' AND NOT rb_purge_allowed() THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: finalisiertes Protokoll % kann nicht gelöscht werden', OLD."number";
    END IF;
    IF OLD."status" = 'DISCARDED' AND NOT rb_purge_allowed() THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: verworfenes Protokoll % kann nicht gelöscht werden', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF OLD."status" = 'FINALIZED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: finalisiertes Protokoll % kann nicht geändert werden', OLD."number";
  END IF;
  IF OLD."status" = 'DISCARDED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: verworfenes Protokoll % kann nicht geändert werden', OLD."number";
  END IF;
  IF NEW."status" = 'DISCARDED' THEN
    o := to_jsonb(OLD) - 'status' - 'discardedAt' - 'discardReason' - 'updatedAt';
    n := to_jsonb(NEW) - 'status' - 'discardedAt' - 'discardReason' - 'updatedAt';
    IF o <> n THEN RAISE EXCEPTION 'RB_IMMUTABLE: Beim Verwerfen bleibt der Inhalt des Protokolls % unverändert', OLD."number"; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

Dazu zwei Trigger-Funktionen per `CREATE OR REPLACE`, jeweils die **aktuelle** Fassung vollständig übernommen und nur im
Übergabe-Zweig erweitert (FINALIZED-Meldungen unverändert, damit bestehende Tests und Fehlertexte gleich bleiben):

- `rb_guard_handover_child` (Fundament-Migration Zeilen 591-614; Fotos, Checkliste, Schadenkopien, Zusatzkosten):
  zusätzlich zu `st = 'FINALIZED'` ein eigener Zweig `st = 'DISCARDED'` → „gehört zu einem verworfenen Protokoll und ist gesperrt“,
  an beiden Stellen (Bestand und Umhängen).
- `rb_guard_signature` (aktuelle Fassung: Migration `20261020090000_storno_mietaenderungen`, Zeilen 350-389):
  im Handover-Zweig für INSERT und DELETE zusätzlich `st = 'DISCARDED'` sperren.

Nicht nötig: `rb_check_driver_verification` verbietet neue Vermerke schon für jeden Status außer DRAFT
(`20261018090000_vertragsnachtraege`, Zeile 237). `rb_guard_driver_verification` und `rb_guard_driver_copy` hängen nicht am
Protokollstatus; das Markieren einer Kopie als gelöscht bleibt dadurch auch nach dem Verwerfen möglich.

Optional (weitere Verschärfung, nicht für die Fehlerbehebung nötig): neue Dokumentkopien nur zu Entwürfen (heute nur im Code geprüft).

## 5. Anwendungscode

1. **`discardHandoverDrafts`** (`src/lib/cancellation.ts:57-72`), je Entwurf:
   - Prüfdaten zählen (`driverVerification`, `driverDocumentCopy` mit `handoverId`).
   - Ohne Prüfdaten: **unverändert** löschen.
   - Mit Prüfdaten: Fotos, Unterschriften, Zusatzkosten, Checkliste, Schadenkopien löschen wie bisher (solange der Entwurf noch
     DRAFT ist – danach sperren die Trigger); Kopien mit `deletionStatus = 'DELETED'`, `deletedAt`, Grund „Buchung storniert“
     markieren; dann `status = 'DISCARDED'`, `discardedAt`, `discardReason` = Stornogrund; Audit `HANDOVER_DRAFT_DISCARDED`
     (Protokollnummer, Anzahl Vermerke, Anzahl gelöschter Kopien).
   - Speicherschlüssel der Fotos **und** der Kopien zurückgeben. Sie werden wie heute nach dem Commit entfernt
     (`buchungen/actions.ts:340`, `orphanedStorageKeys`).
   - Sperrreihenfolge bleibt Buchung → Protokoll (das Storno sperrt die Buchung zuerst).
2. **`assertHandoverDraft`** (`src/lib/integrity.ts:66-68`): eigene Meldung für DISCARDED („wurde mit dem Storno verworfen“)
   statt „finalisiert … Nachtragsprotokoll“.
3. **Übergabe-Seite**: `buchungen/[id]/uebergabe/page.tsx:48` und `uebergabe/actions.ts:35` laden das jüngste PICKUP-Protokoll
   ohne Statusfilter → um `status: { not: "DISCARDED" }` ergänzen. Ohne das würde ein verworfener Entwurf als „Entwurf“ im
   Assistenten erscheinen. Mit dem Filter verhält sich die Seite genau wie heute nach dem Löschen.
4. Texte: `HANDOVER_STATUS` und `AUDIT_ACTIONS` (`constants.ts`) um „Verworfen“ bzw. die neue Aktion ergänzen; Hinweis im
   Storno-Assistenten (`cancellation.ts:142`): „Fahrerprüfungen bleiben als Nachweis erhalten, Ausweiskopien werden gelöscht.“
5. Unverändert: Rückgabe-Seiten, Schlüsselrückgabe, Dokumente, Rechnungen, Dashboards, Kundenakte – sie filtern bereits positiv
   auf DRAFT bzw. FINALIZED (Einzelnachweise in der Analyse); DISCARDED-Rückgaben verhindert der CHECK.

## 6. Tests (keine Abschwächung)

- **Angepasst, strenger**: Storno-Zweig in `tests/audit.test.ts:152` und `tests/lock-order.test.ts:88` erwartet heute
  `handover === null`. Mit Fahrerprüfung wird daraus: Status `DISCARDED`, `discardedAt`/Grund gesetzt, Prüfvermerke nach Anzahl
  und Inhalt unverändert, Kopien `DELETED`, Fotos/Unterschriften/Checkliste/Schadenkopien/Zusatzkosten 0. Dieser Zweig ist heute
  unerreichbar, weil das Storno dort immer scheitert.
- **Neu**:
  - Storno nach bestätigter und nach blockierter Fahrerprüfung (mit Kopie): Buchung `CANCELLED`, Speicherschlüssel der Fotos
    und Kopien im Ergebnis, Datei-Aufräumen nach dem Commit.
  - Storno ohne Prüfdaten: wie bisher gelöscht (bestehender Test D bleibt).
  - Datenbankregeln: verworfenes Protokoll nicht änderbar (auch nicht zurück auf DRAFT), nicht löschbar; keine neuen Fotos,
    Checklisteneinträge, Schadenkopien, Zusatzkosten, Unterschriften, Prüfvermerke; Verwerfen mit Inhaltsänderung abgelehnt;
    CHECK: DISCARDED ohne Zeitpunkt/Grund oder als RETURN abgelehnt.
  - Übergabe-Seite/Aktionen einer stornierten Buchung greifen nicht auf den verworfenen Entwurf zu.
- Wie alle Wettläufe gegen PostgreSQL 18.6 mit Pool 5, anschließend fünf Volläufe.

## 7. Migrationssicherheit

- **Nur additiv**: zwei nullable Spalten (ohne Umschreiben der Tabelle), zwei CHECK-Regeln, drei ersetzte Trigger-Funktionen.
  Keine Datenänderung, kein Umbenennen, kein Löschen.
- **Bestandsdaten**: Der Code schreibt nur `DRAFT` und `FINALIZED`; alle Bestandszeilen erfüllen die neuen CHECK-Regeln.
  Vor dem Deploy (nach deiner Freigabe) eine **lesende** Diagnose auf Produktion:
  `SELECT "status", count(*) FROM "Handover" GROUP BY 1;` – erwartet nur DRAFT/FINALIZED.
- **Rolling Deploy** (Migration beim Start des neuen Containers, der alte bedient noch): Der alte Code schreibt nie DISCARDED
  und kennt die neuen Spalten nicht; ein Storno mit Prüfdaten scheitert bei ihm wie heute – kein neuer Schaden.
- **Zurückrollen der App** ohne Migration: Spalten bleiben ungenutzt. Bereits verworfene Entwürfe würden in der alten
  Übergabe-Seite als „Entwurf“ angezeigt, jede Aktion daran aber abgelehnt (Status ≠ DRAFT) – unschön, nicht gefährlich.
- **Altfälle**: Vor dem 22.09.2026 konnte ein Storno Entwürfe stehen lassen (DRAFT unter CANCELLED, ohne Prüfvermerke).
  Werden nicht verändert; optional mit derselben Diagnose zählen.

## 8. Datenschutz

- **Bleibt erhalten**: die Protokollzeile (Nummer, Art, Zeitpunkte, Mitarbeitername, ggf. Messwerte/Bemerkung) und die
  Prüfvermerke (Name, Geburtsdatum, Führerscheindaten als Snapshot, Prüfergebnis). Die Vermerke sind nach Design ein
  Nachweis und werden schon heute für jede Buchung unbefristet aufbewahrt.
- **Wird gelöscht**: Fotos (Zeile und Datei; sonst würden Fotos zu bekannten Schäden über `damageId` in spätere Protokolle
  wandern, `handovers.ts:619`), Unterschriftsbilder, Zusatzkosten, Checkliste, Schadenkopien, Ausweis-/Führerscheinkopien
  (Datei entfernt, Zeile als gelöscht mit Grund – wie das bestehende manuelle Löschen in `driver-verification.ts:602-612`).
- **Restrisiko**: Schlägt das Entfernen einer Datei nach dem Commit fehl, bleibt sie im App-Speicher liegen (wie heute bei
  Fotos; Fehler werden geschluckt). Die Sicherung entfernt Kopien mit Status DELETED nach 30 Tagen (`backup-lib.mjs:149`).

## 9. Umfang und Commits

1. Migration + Trigger + Datenbank-Regeltests.
2. Storno-Code, Meldungen, Übergabe-Seite, angepasste und neue Tests.

Geschätzt rund 60 Zeilen SQL, 60 Zeilen Code, 150 Zeilen Tests. Kein Trigger wird abgeschwächt, kein Test entfernt.

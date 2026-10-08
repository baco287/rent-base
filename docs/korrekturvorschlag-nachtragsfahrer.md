# Korrekturvorschlag: Fahrer aus Nachträgen im Originalvertrag

Stand 08.10.2026, geprüft gegen `origin/main` 0c42b42. Der Vorschlag ist **noch nicht angewendet**. Die fertige, getestete Änderung liegt als Patch daneben: [`korrekturvorschlag-nachtragsfahrer.patch`](korrekturvorschlag-nachtragsfahrer.patch).

## Fehler

`loadContract` in `src/lib/contracts.ts` lädt **alle** Zeilen aus `ContractDriver`, auch Fahrer, die ein Vertragsnachtrag hinzugefügt hat (`addedByAmendmentId`). Daraus entstehen zwei Dinge:

- die Inhaltsprüfsumme in `signedContent()`, also der Wert, den der Mieter unterschrieben hat, und
- das Vertragsdokument in `buildContractDocument()`, also die Vertragsansicht in der App und das Vertrags-PDF über `loadContractDocumentData` in `src/lib/document-data.ts`.

Sobald ein Nachtrag einen Fahrer hinzufügt, rechnet die App den Originalvertrag deshalb mit einem Fahrer, der dort nie unterschrieben wurde. Das gilt schon für einen **nicht unterschriebenen Entwurf**.

## Nachweis

Reproduziert gegen eine frische Testdatenbank:

| Zeitpunkt | `verifyContract().intact` | Zusatzfahrer im Originalvertrag |
|---|---|---|
| Vertrag unterschrieben | `true` | 0 |
| Nachtrag-Entwurf mit neuem Fahrer (nicht unterschrieben) | **`false`** | **1** |

## Folgen

| Wo | Folge | Schwere |
|---|---|---|
| Vertrags-PDF | Ein **später neu erzeugtes** Vertrags-PDF (Nachgenerierung nach S3-Fehler, neue Fassung) zeigt Fahrer, die beim Unterschreiben nicht im Vertrag standen. Das beim Abschluss archivierte PDF ist korrekt. | mittel (Beweiswert) |
| Vertragsansicht in der App | zeigt dieselben falschen Fahrer, auch aus Entwürfen | mittel |
| `verifyContract` | meldet „nicht intakt“, obwohl nichts manipuliert wurde. Heute nur in Tests aufgerufen, aber jede künftige Integritätsprüfung würde fälschlich Alarm schlagen. | mittel |
| Zähler „Fahrer geprüft x von y“ (`pickupDriverCheckStatus`) | zählt Entwurfsfahrer und herausgenommene Fahrer mit | gering |
| Übergabeseite „Zusatzfahrer“ | zeigt Entwurfsfahrer und herausgenommene Fahrer | gering |

Richtig machen es schon: die Fahrerprüfung bei der Übergabe (`requiredDriversFor`) und die Zuordnung bei Behördenvorgängen (`authority.ts`).

## Korrektur

Es gibt zwei getrennte Begriffe, die der Code bisher vermischt:

1. **Fahrer laut Unterschrift:** nur Zeilen ohne `addedByAmendmentId`. Daraus entstehen Prüfsumme, Vertragsansicht, Vertrags-PDF und Vertragsmails. Nachtragsfahrer stehen im Nachtragsdokument.
2. **Aktuell wirksame Fahrer:** Fahrer laut Unterschrift, minus die per unterschriebenem Nachtrag herausgenommenen, plus die per unterschriebenem Nachtrag aufgenommenen. Das gilt für die Fahrerprüfung, die Anzeige bei der Übergabe und den Zähler.

Konkrete Änderungen (6 Dateien, siehe Patch):

| Datei | Änderung |
|---|---|
| `src/lib/contract-view.ts` | neue Konstante `ORIGINAL_CONTRACT_DRIVERS` (`where: { addedByAmendmentId: null }`) |
| `src/lib/contracts.ts` | `loadContract` nutzt sie. Damit stimmen Prüfsumme, `verifyContract`, `dropStaleSignatures` und die Vertragsseite. |
| `src/lib/document-data.ts` | Vertrags-PDF nutzt sie ebenfalls |
| `src/lib/driver-verification.ts` | Filter als `isEffectiveDriver()` herausgezogen und im Zähler `pickupDriverCheckStatus` verwendet |
| `src/app/(app)/buchungen/[id]/uebergabe/page.tsx` | Anzeige „Zusatzfahrer“ nur mit wirksamen Fahrern |
| `tests/amendments.test.ts` | Regressionstest für Entwurf und unterschriebenen Nachtrag: Prüfsumme, PDF-Daten, Pflichtfahrer, Zähler |

**Risiko der Änderung:** gering.

- Im Vertragsentwurf gibt es keine Nachtragsfahrer, weil Nachträge einen unterschriebenen Vertrag voraussetzen. Alle Entwurfsabläufe bleiben deshalb unverändert.
- Herausgenommene Fahrer bleiben in der Prüfsumme, weil sie unterschrieben wurden. `removedByAmendmentId` gehört nicht zum Prüfsummen-Inhalt.
- An gespeicherten Daten ändert sich nichts, es gibt keine Migration.

## Prüfung der Korrektur

- **Mit Patch:** Regressionstest grün, Typprüfung grün.
- **Ohne Patch:** Derselbe Test scheitert an „ein Nachtrag-Entwurf ändert die Prüfsumme des Vertrags nicht“. Der Test erkennt den Fehler also.
- **Anwenden:** `git apply docs/korrekturvorschlag-nachtragsfahrer.patch`, danach die komplette Testsuite laufen lassen.

## Betroffene Daten in Produktion (nur lesend prüfen)

Vertrags-PDFs, die erzeugt wurden, nachdem ein Nachtrag einen Fahrer hinzugefügt hatte:

```sql
SELECT c."number" AS vertrag, d."version", d."createdAt" AS pdf_erzeugt
FROM "Document" d
JOIN "RentalContract" c ON c."id" = d."contractId"
WHERE d."type" = 'RENTAL_CONTRACT'
  AND EXISTS (
    SELECT 1 FROM "ContractDriver" cd
    WHERE cd."contractId" = c."id" AND cd."addedByAmendmentId" IS NOT NULL AND cd."createdAt" < d."createdAt"
  )
ORDER BY d."createdAt";
```

Leeres Ergebnis heißt: kein archiviertes PDF betroffen. Sonst nach dem Einspielen der Korrektur für diese Verträge eine neue PDF-Fassung erzeugen. Archivierte Dokumente sind unveränderlich, die fehlerhafte Fassung bleibt als ältere Version erhalten.

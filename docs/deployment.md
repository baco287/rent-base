# Deployment ohne Datenverlust

Wie RentBase aktualisiert wird, während Kunden damit arbeiten, und was in Coolify dafür eingestellt sein muss.

## Das Problem

Jeder Deploy ersetzt den laufenden Container. Wer gerade eine Seite offen hat, etwa auf dem Tablet am Hof, schickt beim nächsten Speichern eine Anfrage an die **neue** Version. Ohne Vorkehrungen passiert dann:

1. **Server Actions unbekannt:** Next.js vergibt jeder Server Action eine ID, die vom Build-Schlüssel abhängt. Ohne festen Schlüssel erzeugt jeder Build neue IDs. Die alte Seite kennt nur die alten, die Aktion wird nicht ausgeführt, und die Eingaben sind weg. Nachgewiesen am 08.10.: zwei Builds mit demselben Schlüssel ergeben 262 von 262 gleichen Action-IDs, zwei Builds mit verschiedenem Schlüssel ergeben 0.
2. **Programmteile fehlen:** Beim Navigieren fordert die alte Seite JavaScript-Dateien an, die es nicht mehr gibt.
3. **Lücke beim Umschalten:** Ohne Healthcheck stoppt Coolify den alten Container, bevor der neue bereit ist.

## Die Vorkehrungen

| Maßnahme | Wirkung | Wo |
|---|---|---|
| Fester `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | Unveränderte Server Actions behalten ihre ID. Offene Formulare lassen sich nach einem Deploy weiter absenden. | Coolify, Build-Variable |
| `deploymentId` aus `SOURCE_COMMIT` | Eine veraltete Seite lädt nach der Aktion neu, statt mit Fehlern weiterzulaufen. Die Aktion selbst wird vorher noch ausgeführt. | `next.config.ts`, Coolify |
| Docker-`HEALTHCHECK` auf `/api/health` | Coolify schaltet erst auf den neuen Container um, wenn er gesund ist (Rolling Update). Ist er kaputt, bleibt der alte in Betrieb. | `Dockerfile` |
| Deutsche Fehlerseite | Wenn trotzdem etwas scheitert: klare Ansage („RentBase wurde gerade aktualisiert“, „Keine Verbindung“), Knöpfe für „Seite neu laden“ und „Erneut versuchen“, Fehlercode für den Support | `src/app/error.tsx`, `src/app/(app)/error.tsx`, `src/app/global-error.tsx` |
| Schritte sofort speichern | Übergabe-, Rückgabe- und Vertragsassistent speichern jeden Schritt in der Datenbank. Höchstens der aktuelle Schritt geht verloren. | schon vorhanden |
| Deploy-Fenster | Nicht während der Geschäftszeiten der Pilotkunden deployen | Absprache |

**Was trotzdem verloren gehen kann:**

- Wurde eine Server Action selbst geändert, umbenannt oder verschoben, bekommt sie eine neue ID. Wer genau dieses Formular offen hat, verliert die Eingabe. Die Fehlerseite sagt das dann klar.
- Buchung, Kunde, Unfallersatz und Rechnungseditor halten ihre Eingaben bis zum Absenden nur im Browser. Für sie wäre ein Entwurf im `sessionStorage` der nächste Schritt (siehe unten).

## Einstellungen in Coolify (einmalig)

Alle Einstellungen gehören zur App `app.rent-base.de` und gelten ab dem nächsten Deploy.

1. **`APP_URL`** (Laufzeit-Variable): `https://app.rent-base.de`
   - **Pflicht vor dem Deploy dieses Stands.** Einladungs-, Passwort-Reset- und Rückgabelinks entstehen nur noch aus diesem Wert und nie mehr aus dem `Host`-Header der Anfrage.
   - Fehlt er, scheitern Einladungen und Reset mit einer klaren Meldung, und beim Start steht ein Hinweis im Log.
   - Ob der Wert gültig ist, zeigt das Control Center unter System.
2. **`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`** (als **Build-Variable** markieren):
   - Ein zufälliger Schlüssel, einmal erzeugen und danach **nie wieder ändern**:
     ```
     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     ```
   - Zusätzlich im Passwortmanager ablegen.
   - Fehlt er, steht im Build-Log ein Hinweis, und der Build verhält sich wie bisher.
3. **`SOURCE_COMMIT` für die `deploymentId`:** Coolify stellt den Commit als `SOURCE_COMMIT` bereit. Damit er schon beim **Build** ankommt, muss in den erweiterten Einstellungen der App die Option eingeschaltet sein, die den Source Commit in den Build übernimmt.
   - **Nicht verifiziert:** wie die Option in der eingesetzten Coolify-Version genau heißt.
   - Prüfen lässt es sich so: Nach dem Deploy trägt das `<html>`-Element im Seitenquelltext das Attribut `data-dpl-id`.
4. **Healthcheck:** Der Dockerfile-Healthcheck wird laut Coolify-Doku automatisch übernommen. Rolling Updates gibt es nur, wenn
   - kein Port direkt auf dem Host veröffentlicht ist,
   - kein eigener Containername gesetzt ist („Consistent/Custom Container Name“).

   Beides in den App-Einstellungen prüfen.

## Regeln für jeden Deploy mit echten Kunden

1. Über einen Pull Request mit grüner CI (`.github/workflows/ci.yml`), nicht direkt auf `main`.
2. Außerhalb der Geschäftszeiten der Pilotkunden. Die Hetzner-Sicherung läuft gegen 02:48 UTC, also nicht in diesem Fenster.
3. Migrationen nur erweiternd: Spalten oder Tabellen hinzufügen ist in Ordnung. Umbenennen oder Löschen geht nur in zwei Deploys, weil beim Rolling Update kurz alte und neue Version gleichzeitig auf die bereits migrierte Datenbank zugreifen.
4. Vor einem Deploy mit Migration: in Coolify an der Datenbank „Backup Now“ auslösen.
5. Danach: `/api/health` prüfen, eine Seite neu laden, in den Coolify-Logs nach `[Konfiguration]` suchen.

## Nächster Schritt (noch nicht umgesetzt)

**Entwürfe im Browser für die vier Formulare, die bis zum Absenden nur im Browser leben:** Buchung, Kunde, Unfallersatz, Rechnungseditor.

- Eingaben werden laufend in `sessionStorage` gespiegelt. Das gilt nur im aktuellen Tab und wird beim Schließen gelöscht, wichtig wegen der Ausweisdaten auf geteilten Tablets.
- Nach einem Neuladen werden sie wiederhergestellt, nach erfolgreichem Speichern gelöscht.
- Weil diese Formulare ihren Zustand in React halten, braucht das je Formular eine kleine Anpassung und keine globale Lösung.

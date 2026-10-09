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

## Einstellungen in Coolify (einmalig, gemeinsam durchgehen)

**Grundlage:** Die Bezeichnungen stammen aus dem Quellcode von **Coolify v4.4.3**. Ältere v4-Versionen beschriften manches anders, etwa „Available at Buildtime“ statt eines Auswahlfelds „Build time“. Deshalb zuerst die eingesetzte Version ablesen (Einstellungen bzw. Fußzeile).

**Wirkung:** Alle Einstellungen gelten ab dem nächsten Deploy. Sie betreffen die Anwendung `app.rent-base.de`, nicht die Website `rent-base.de`.

### Schritt 0: Bestandsaufnahme (nur ansehen, nichts ändern)

1. **Version:** Die Coolify-Version notieren.
2. **Anwendung → Environment Variables:**
   - Für jede Variable notieren, ob sie unter „Build time“ als „Available during build“ markiert ist. Neue Variablen sind in Coolify standardmäßig für Build **und** Laufzeit freigegeben.
   - Notieren, wie „Build secrets“ steht. Es muss auf „Standard build arguments“ stehen, nicht auf „Docker BuildKit secrets“. Sonst kommen Build-Variablen nicht als Umgebungsvariable beim Build an.
3. **Anwendung → Advanced → Build:**
   - „Build arguments“ ist voraussichtlich „Inject build args automatically“, die Voreinstellung.
   - „Source commit availability“ ist voraussichtlich „Runtime only (preserves cache)“.
4. **Anwendung → Healthcheck:** voraussichtlich deaktiviert. **So lassen.**
5. **Anwendung → Configuration:** prüfen, dass Rolling Updates möglich sind:
   - „Port mappings“ ist leer.
   - „Container naming“ steht nicht auf „Consistent name (no rolling updates)“.
   - Es gibt keinen „Custom container name“.
   - Unter „Custom Docker options“ steht kein `--ip` und kein `--ip6`.

### Schritt 1: `APP_URL` setzen (Pflicht vor dem Deploy dieses Stands)

1. **Anwendung → Environment Variables → neue Variable anlegen:**
   - Name `APP_URL`
   - Wert `https://app.rent-base.de` (ohne Schrägstrich am Ende, ohne Anführungszeichen)
   - Build time: „Not available during build“
   - Runtime: „Available at runtime“
2. **Wirkung:** Einladungs-, Passwort-Reset- und Rückgabelinks entstehen nur noch aus diesem Wert und nie mehr aus dem `Host`-Header einer Anfrage.
   - Fehlt der Wert, scheitern diese Mails mit einer klaren Meldung, und beim Serverstart steht `[Konfiguration] …` im Log.
   - Nach dem Deploy zeigt das Control Center unter **System** bei `APP_URL` „gesetzt“ und „gültig“.

### Schritt 2: `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` anlegen (Schutz offener Formulare)

1. **Schlüssel einmalig erzeugen**, auf dem eigenen Rechner oder im Terminal der Anwendung:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   **Sofort im Passwortmanager ablegen.** Der Schlüssel darf sich danach **nie mehr ändern**. Ändert er sich, scheitern beim nächsten Deploy alle offenen Formulare einmalig, wie heute bei jedem Deploy.
2. **Anwendung → Environment Variables → neue Variable anlegen:**
   - Name `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
   - Wert: der Schlüssel, ohne Anführungszeichen. `+`, `/` und `=` sind unproblematisch.
   - Build time: **„Available during build“**
   - Runtime: **„Not available at runtime“** (siehe Entscheidung unten)
3. **Nach dem ersten Deploy prüfen:** Im Build-Log darf **kein** `[Build] NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ist nicht gesetzt` stehen.
4. **Erst ab dem zweiten Deploy mit diesem Schlüssel** bleiben offene Formulare über den Deploy hinweg absendbar.

**Lokal nachgewiesen**, mit Standalone-Server wie im Image:

| Szenario | Ergebnis |
|---|---|
| Gleicher Schlüssel, anderer Commit | Die alte offene Seite führt die Aktion auf dem neuen Server aus. |
| Anderer Schlüssel | „RentBase wurde gerade aktualisiert“ |

Außerdem steht der Schlüssel aus dem Build-Schritt unverändert im Laufzeit-Manifest.

**Entscheidung (09.10.2026): nur Build-Variable, nie Laufzeit-Variable.**

1. **Beim Build nötig:** Next.js leitet aus dem Schlüssel die IDs aller Server Actions ab und bettet ihn in das Laufzeit-Manifest des Images ein (`.next/server/server-reference-manifest.json`).
2. **Zur Laufzeit nicht nötig:** Ohne Laufzeit-Variable nutzt der Server den eingebetteten Schlüssel. Next.js 16.3, `encryption-utils.js`: `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || manifest.encryptionKey`.
3. **Getestet mit echten Standalone-Builds und einer gebundenen Action** („Mietvertrag erstellen“):
   - Build A mit K1, dann Build B mit K1 und **ohne** Laufzeit-Schlüssel: Die offene Seite aus A wird auf B korrekt ausgeführt.
   - Derselbe Build mit **abweichendem** Laufzeit-Schlüssel funktioniert heute ebenfalls. Der Laufzeit-Schlüssel verschlüsselt nur Variablen aus Inline-Server-Actions (Closures), und RentBase hat keine: Alle Action-Dateien sind dateiweit mit `"use server"` markiert, und `.bind()`-Argumente werden nicht verschlüsselt.
4. **Warum trotzdem nie zur Laufzeit setzen:** Die Laufzeit-Variable hätte Vorrang vor dem eingebetteten Schlüssel. Käme später eine Inline-Action dazu, würde ein abweichender oder nur bei manchen Deploys gesetzter Laufzeit-Wert offene Formulare über Deploys hinweg brechen. Mit „nur Build“ gibt es genau eine Quelle.

### Schritt 3 (optional, später): `deploymentId` aus dem Commit

**Wirkung:** Nach einem Deploy lädt eine veraltete Seite beim Navigieren gezielt neu, statt auf fehlende Programmteile zu stoßen. Diesen Fall fängt die Fehlerseite schon ab („RentBase wurde gerade aktualisiert“). Die `deploymentId` ist deshalb ein Komfortgewinn, kein Muss.

**Einstellung:** Anwendung → Advanced → Build → „Source commit availability“ auf **„Available during build“**.

**Preis:** Coolify fügt `SOURCE_COMMIT` dann nach jedem `FROM` ein. Damit wird bei jedem Deploy der Docker-Cache aller Stufen ungültig, auch für `npm ci`, und Builds dauern spürbar länger.

**Empfehlung:** Für den Pilotstart **aus lassen**. Später entscheiden, ob die längeren Builds den Komfort wert sind.

**Prüfen, wenn eingeschaltet:** Im Seitenquelltext trägt `<html>` das Attribut `data-dpl-id="<Commit>"`.

### Schritt 4: Healthcheck und Rolling Update

1. **Anwendung → Healthcheck:** **deaktiviert lassen.** Coolify übernimmt dann den `HEALTHCHECK` aus dem Dockerfile und wartet, bis Docker den neuen Container als `healthy` meldet.
2. **Prüfen im Deploy-Log:** Dort erscheint „Custom healthcheck found in Dockerfile.“
3. **Bei einem kaputten Deploy:** Wird der neue Container nicht gesund (Startphase 90 s, danach 3 Fehlversuche im Abstand von 30 s), behält Coolify den alten. Der Deploy gilt dann als fehlgeschlagen.

### Schritt 5: Geheimnisse aus dem Build heraushalten (empfohlen, Bestandsaufnahme aus Schritt 0)

**Problem:** Variablen mit „Available during build“ gibt Coolify als Build-Argument in **jede** Stufe des Dockerfiles. Sie können dadurch in der Build-Historie des Images auf dem Server auftauchen. Der Build braucht nur:

| Variable | Beim Build nötig? |
|---|---|
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | ja, **nur** beim Build (siehe Schritt 2) |
| `DATABASE_URL` | **nein**, sobald dieses Dockerfile deployt ist: Der Build setzt für `prisma generate` und `next build` einen Platzhalter (`build.invalid`). Lokal geprüft: Der Build läuft durch, weder Platzhalter noch eine mitgegebene echte Adresse landen im Ergebnis, zur Laufzeit gilt die echte Adresse. |
| `S3_*`, `SMTP_*`, `RENTBASE_SECRET_KEY`, `SETUP_KEY`, `BACKUP_S3_*`, `APP_URL` | nein |

**Vorgehen:**

1. Bei allen Variablen außer `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` Build time auf „Not available during build“ stellen.
2. **Reihenfolge bei `DATABASE_URL`:** erst umstellen, **nachdem** dieser Stand deployt ist. Das heute laufende Dockerfile braucht die Variable noch beim Build, sonst scheitert der nächste Deploy.

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

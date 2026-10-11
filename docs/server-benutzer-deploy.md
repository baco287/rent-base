# Serverbenutzer `deploy`: Befund und Maßnahmenplan

**Stand 11.10.2026.** Alles nur gelesen, nichts geändert. Die Umsetzung braucht deine ausdrückliche Freigabe.

## Befund

| Frage | Ergebnis |
|---|---|
| Angelegt | 16.09.2026 um 11:18:58, **von Hand durch root**: Gruppe und Benutzer, Gruppen `users` und `sudo`. Um 11:20:52 kam die Gruppe `docker` dazu. In cloud-init (user-data, Log) taucht `deploy` nicht auf |
| sudo | `/etc/sudoers.d/deploy` (16.09., 11:18): `deploy ALL=(ALL) NOPASSWD:ALL`. Zusätzlich die Gruppenregel `%sudo ALL=(ALL:ALL) ALL`; sie verlangt ein Passwort, und das ist gesperrt |
| Gruppen | `deploy`, `users`, `sudo`, `docker`. Der Docker-Socket gehört `root:docker` mit Rechten 660, `docker` heißt also Vollzugriff auf alle Container |
| SSH-Schlüssel | Ein Schlüssel, **identisch mit deinem Schlüssel bei root** (`SHA256:cAeos…`, ED25519). Keine Einschränkungen wie `from=` |
| Passwort | gesperrt (root ebenfalls). Passwortanmeldung per SSH ist abgeschaltet |
| Benutzung | **Eine** Anmeldung am 16.09. um 11:19:26, 28 Sekunden nach dem Anlegen, mit `sudo true`. Das ist der übliche Prüfschritt einer Einrichtungsanleitung. Seitdem keine Anmeldung. Die vier `runuser`-Sitzungen vom 11.10. um 19:42 stammen aus der Platzhalter-Demonstration von Claude |
| Coolify | Verbindet sich als `root` mit dem Schlüssel „coolify“. Git läuft über den Schlüssel der GitHub-App. `deploy` kommt nicht vor |
| Deine SSH-Konfiguration | Alle Hosts melden sich als `root` an, auch `rb` |
| GitHub / CI | Keine SSH- oder Deploy-Schritte zum Server. Deployments laufen über Coolify |
| Cronjobs, Dienste | Keine Crontab, keine `cron`-Datei, keine systemd-Unit mit `User=deploy`, kein Linger, keine laufenden Prozesse |
| Dateien | Nur das Home-Verzeichnis. Die Dateien mit uid 1000 in den containerd-Snapshots gehören dem Image-Benutzer `node`, der zufällig dieselbe Nummer hat, nicht dem Konto |
| Angriffsversuche | 282 abgewiesene Anmeldeversuche für „deploy“ seit 16.09. Das sind Bots, die den verbreiteten Namen ausprobieren |

**Wahrscheinlicher Zweck:**
- Der übliche Härtungsschritt „eigener Admin-Benutzer statt root“.
- Der zweite Teil, die root-Anmeldung abzuschalten, wurde nie umgesetzt. Gearbeitet wird weiter als root: 1.599 Anmeldungen seit 16.09., dazu Coolify.

## Bewertung

- **Zweiter root-Zugang ohne Nutzen:**
  - Er hat denselben Schlüssel wie root und ist deshalb kein zusätzlicher Notfallweg. Geht der Schlüssel verloren, ist auch `deploy` verloren.
  - Der Notfallweg bei Hetzner ist das Rescue-System bzw. das Zurücksetzen des root-Passworts in der Console.
- **Risiko liegt vor allem in der Zukunft:** Ein später ergänzter Schlüssel oder ein gesetztes Passwort wäre sofort root, weil `NOPASSWD` gilt.
- **Auswirkung einer Einschränkung:** keine auf RentBase, Coolify, Container oder Backups.
  - Es ist kein Neustart nötig: sudo liest seine Regeln bei jedem Aufruf, sshd liest `authorized_keys` bei jeder Anmeldung, und Gruppen wirken ab der nächsten Anmeldung.

## Maßnahmenplan (Vorschlag A: stilllegen, Konto und Schlüssel behalten)

**Voraussetzungen:**
- Die root-Anmeldung mit deinem Schlüssel funktioniert. Während der Änderung bleibt eine zweite root-Sitzung offen.
- Der Notfallweg ist bekannt: Hetzner Console → Rescue.

| Schritt | Befehl (als root) | Prüfung |
|---|---|---|
| 0 Sicherung | Verzeichnis `/root/deploy-stilllegung-<Datum>` mit Rechten 700. Hinein kommen Kopien von `/etc/sudoers.d/deploy` und `/home/deploy/.ssh/authorized_keys` sowie die Ausgaben von `id deploy`, `getent passwd deploy` und `sudo -l -U deploy` | Dateien vorhanden |
| 1 sudo-Regel entfernen | `mv /etc/sudoers.d/deploy /root/deploy-stilllegung-<Datum>/sudoers.d-deploy` | `visudo -c` meldet „parsed OK“; `sudo -l -U deploy` zeigt kein `NOPASSWD` mehr |
| 2 Gruppen entfernen | `gpasswd -d deploy sudo` und `gpasswd -d deploy docker` | `id deploy` zeigt nur noch `deploy` und `users` |
| 3 Anmeldung sperren | `usermod --shell /usr/sbin/nologin deploy`, `chage -E 0 deploy`, `authorized_keys` in `authorized_keys.stillgelegt` umbenennen. Der Schlüssel bleibt erhalten und steht ohnehin bei root | `ssh deploy@<server>` von deinem Rechner wird abgewiesen, `ssh rb` funktioniert weiter |
| 4 Betrieb kontrollieren | – | `docker ps` unverändert, `/api/health` liefert 200, Coolify meldet den Server weiter als erreichbar, keine neuen Fehler im Journal |
| 5 Beobachten | 30 Tage | Danach entscheiden, ob das Konto ganz gelöscht wird (`userdel`, Home archivieren). Das wird gesondert freigegeben |

**Rückweg, jeder Schritt einzeln, ohne Neustart, in unter einer Minute:**
- zu 1: `cp /root/deploy-stilllegung-<Datum>/sudoers.d-deploy /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy && visudo -c`
- zu 2: `usermod -aG sudo,docker deploy`
- zu 3: `usermod --shell /bin/bash deploy`, `chage -E -1 deploy`, Datei zurück zu `authorized_keys` umbenennen

**Risiken des Plans:**
- **Aussperren:** betrifft nur `deploy`; root bleibt unverändert und braucht kein sudo. Ein Fehler in den sudo-Regeln fällt durch `visudo -c` sofort auf.
- **Unbekannte Nutzung von außen,** etwa ein vergessenes Skript, das sich als `deploy` anmeldet: Seit dem 16.09. ist keine solche Anmeldung verzeichnet, das ist also sehr unwahrscheinlich. Mit dem Rückweg ist sie in einer Minute wiederhergestellt.

**Danach:**
- Es gibt keinen unprivilegierten Login-Benutzer mehr.
- `hidepid` für `/proc` hat dann nur noch geringen Nutzen ([backup-produktion-vorschlag.md](backup-produktion-vorschlag.md), Abschnitt 3).

## Andere Möglichkeiten (nicht empfohlen)

- **B: `deploy` als einzigen Admin behalten und die root-Anmeldung per SSH abschalten.**
  - Coolify verbindet sich aber als root. Das ginge nur mit einer Ausnahme für Coolify in sshd (`Match Address`) und einem Neuladen von sshd.
  - Mehr Risiko, kein Gewinn, solange du selbst als root arbeitest.
- **C: Nur `NOPASSWD` und `docker` entfernen, Anmeldung behalten.**
  - Dann wäre `deploy` ein unprivilegierter Login-Benutzer, ohne erkennbaren Zweck.
  - Erst in diesem Fall wäre `hidepid` sinnvoll.

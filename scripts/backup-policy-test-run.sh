#!/usr/bin/env bash
# Rahmenskript für den Policy-Test auf dem Server (Anleitung: docs/backup-policy-test.md, Abschnitt 7).
# Liegt als /root/backup-policy-test/run.sh neben /root/backup-policy-test/backup-policy-test.mjs (beide aus dem Repository).
# Start losgelöst von der SSH-Sitzung (siehe Anleitung), damit ein Verbindungsabbruch den Lauf nicht unterbricht:
#   bash run.sh                       vollständiger Lauf: Policy setzen, prüfen, danach immer aufräumen
#   bash run.sh --finish-only <Lauf>  nur aufräumen (Legal Holds, Teil-Uploads und Test-Policy dieses Laufs)
# Abbrechen nur mit: docker kill rb-policy-run-<Lauf> rb-policy-mc-<Lauf> rb-policy-finish-<Lauf>
#   (bash nicht beenden; das Aufräumen läuft danach von selbst)
# Zugangsdaten nur aus /root/backup-test.env (Test-Admin) und /root/backup-writer-test.env (Writer), beide root, 600.
# Läuft in Wegwerf-Containern. Laufende App, Datenbank und Coolify-Einstellungen bleiben unberührt.
set -u
DIR=/root/backup-policy-test
MODE=${1:-}
case "$MODE" in ""|--finish-only) ;; *) echo "ABBRUCH: unbekannter Modus $MODE"; exit 2;; esac
A=/root/backup-test.env
W=/root/backup-writer-test.env
for f in "$A" "$W"; do
  [ -f "$f" ] || { echo "ABBRUCH: $f fehlt (siehe Anleitung)"; exit 2; }
  [ "$(stat -c '%U %a' "$f")" = "root 600" ] || { echo "ABBRUCH: $f muss root gehören und Rechte 600 haben"; exit 2; }
done
BUCKET=$(grep '^TEST_S3_BUCKET=' "$A" | cut -d= -f2-)
case "$BUCKET" in rent-base-files|rent-base-backup) echo "ABBRUCH: Produktions-Bucket"; exit 2;; *test*) ;; *) echo "ABBRUCH: kein Test-Bucket"; exit 2;; esac
[ -d "$DIR" ] && [ "$(stat -c '%U %a' "$DIR")" = "root 700" ] || { echo "ABBRUCH: $DIR fehlt oder hat nicht root/700"; exit 2; }
[ -f "$DIR/backup-policy-test.mjs" ] || { echo "ABBRUCH: $DIR/backup-policy-test.mjs fehlt"; exit 2; }
# Nur ein Lauf gleichzeitig, auch beim Aufräumen.
exec 9>"$DIR/.lock"
flock -n 9 || { echo "ABBRUCH: ein anderer Lauf ist aktiv, nichts geändert"; exit 2; }
# Bei Docker-Debug-Modus oder Log-Level debug/trace stünden die Umgebungswerte der Container im Daemon-Log.
[ "$(docker info --format '{{.Debug}}' 2>/dev/null)" = "false" ] || { echo "ABBRUCH: Docker-Debug-Modus ist an oder nicht prüfbar"; exit 2; }
DPID=$(pgrep -xo dockerd)
[ -n "$DPID" ] || { echo "ABBRUCH: dockerd nicht gefunden, Protokollstufe nicht prüfbar"; exit 2; }
DCMD=" $(tr '\0' ' ' <"/proc/$DPID/cmdline") "
printf '%s\n' "$DCMD" | grep -Eqi -- ' (-D|--debug(=true)?|-l[= ]?(debug|trace)|--log-level[= ](debug|trace)) ' && { echo "ABBRUCH: Docker-Log-Level debug/trace (Startparameter)"; exit 2; }
DCFG=$(printf '%s\n' "$DCMD" | grep -Eo -- '--config-file[= ][^ ]+' | sed -E 's/^--config-file[= ]//' | head -1)
grep -Eqsi '"log-level"[[:space:]]*:[[:space:]]*"(debug|trace)"|"debug"[[:space:]]*:[[:space:]]*true' "${DCFG:-/etc/docker/daemon.json}" && { echo "ABBRUCH: Docker-Log-Level debug/trace (Konfiguration)"; exit 2; }
journalctl -u docker --since -15min -o cat 2>/dev/null | grep -qi 'level=debug' && { echo "ABBRUCH: Docker-Daemon protokolliert auf Stufe debug"; exit 2; }
if [ "$MODE" = --finish-only ]; then
  RUN=${2:-}
  [[ $RUN =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$ ]] || { echo "ABBRUCH: Lauf-Kennung fehlt oder ungültig"; exit 2; }
else
  RUN="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
fi
IMG=$(docker inspect "$(docker ps --format '{{.Names}}' | grep '^ye2zlmuxnpvk4osu9l5d9tqa' | head -1)" --format '{{.Config.Image}}' 2>/dev/null)
HELPER=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i coolify-helper | head -1)
[ -n "$IMG" ] || { echo "ABBRUCH: App-Image nicht gefunden"; exit 2; }
if [ "$MODE" != --finish-only ]; then
  [ -n "$HELPER" ] || { echo "ABBRUCH: Coolify-Hilfsimage nicht gefunden"; exit 2; }
  # Kein neuer Lauf, solange Container eines anderen Laufs existieren (das Sperrschloss erfasst Container nicht).
  L=$(docker ps -a --format '{{.Names}}') || { echo "ABBRUCH: docker ps nicht möglich"; exit 2; }
  ANDERE=$(printf '%s\n' "$L" | grep '^rb-policy-' | tr '\n' ' ')
  [ -z "$ANDERE" ] || { echo "ABBRUCH: Container eines früheren Laufs vorhanden: $ANDERE– erst mit --finish-only aufräumen"; exit 2; }
fi
echo "== Lauf $RUN · $(date -u +%Y-%m-%dT%H:%M:%SZ) · Präfix rb-test/policy/$RUN/ · Testskript sha256 $(sha256sum "$DIR/backup-policy-test.mjs" | cut -c1-12)"
JSCODE=$(cat "$DIR/backup-policy-test.mjs")

# --- Ablauf ---
OUTF="$DIR/run-$RUN.out"
node_run() { printf '%s\n' "$JSCODE" | docker run --rm -i --init --ulimit core=0 --name "rb-policy-${1#--}-$RUN" --network bridge --entrypoint node --env-file "$A" --env-file "$W" -e RB_RUN="$RUN" -w /app "$IMG" --input-type=module - "$1" 2>&1; }
FERTIG=0
FRC=0
UNSICHER=0
UNTERBROCHEN=0
trap 'UNTERBROCHEN=1' INT TERM HUP
finish_versuche() { # bis zu 5 Durchgänge; wiederholt bei allem außer 0 (aufgeräumt) und 1 (bleibender Befund)
  for i in 1 2 3 4 5; do
    echo "== Aufräumen (--finish), Versuch $i: Legal Holds, Teil-Uploads, dann nur die Test-Policy dieses Laufs"
    docker rm -f "rb-policy-finish-$RUN" >/dev/null 2>&1
    node_run --finish
    FRC=$?
    case "$FRC" in 0|1) break;; esac
    [ "$i" -lt 5 ] && sleep 60
  done
}
aufraeumen() {
  [ "$FERTIG" = 1 ] && return "$FRC"
  FERTIG=1
  docker rm -f "rb-policy-run-$RUN" "rb-policy-mc-$RUN" >/dev/null 2>&1
  finish_versuche
  # Zweiter Durchgang nach 10 Minuten, wenn ein Policy-Schreibaufruf verspätet noch wirken könnte: Setzen nicht als eigene
  # Policy zurückgelesen (S2), ein späterer Aufruf unbestätigt (S9) oder die Mitschrift gestört.
  if [ "$FRC" = 0 ] && { [ "$UNSICHER" = 1 ] || grep -q '^S9 ' "$OUTF" 2>/dev/null || { markiert && ! grep -q '^BESTANDEN  S2 Policy zurückgelesen' "$OUTF"; }; }; then
    echo "== Ein Policy-Schreibaufruf könnte verspätet wirken: zweiter Aufräumdurchgang in 10 Minuten"
    sleep 600
    finish_versuche
  fi
  if [ "$FRC" = 0 ]; then echo "== Ende Lauf $RUN: aufgeräumt"
  else echo "== AUFRÄUMEN NICHT ABGESCHLOSSEN (Exit $FRC). Rückweg: bash $DIR/run.sh --finish-only $RUN – Writer-Testschlüssel NICHT löschen, bevor das gelingt"; fi
  return "$FRC"
}
markiert() { grep -q '^S0 Policy wird jetzt gesetzt' "$OUTF" 2>/dev/null; }
if [ "$MODE" = --finish-only ]; then aufraeumen; exit $?; fi

# Aufräumen, sobald --run die Markierung „S0 Policy wird jetzt gesetzt“ ausgegeben hat (sie steht vor dem Setzen) – dann bei
# jedem Ende: nach Erfolg, Fehler, Absturz des Containers oder Unterbrechung.
trap 'markiert && { aufraeumen || exit $?; }' EXIT
echo "== Falls am Ende kein '== Ende Lauf $RUN: aufgeräumt' steht: bash $DIR/run.sh --finish-only $RUN"
echo "== Abbrechen nur mit: docker kill rb-policy-run-$RUN rb-policy-mc-$RUN rb-policy-finish-$RUN (bash nicht beenden)"
echo "== Policy-Test mit dem AWS SDK (Wegwerf-Container aus $IMG)"
node_run --run | tee "$OUTF"
PS=("${PIPESTATUS[@]}") # in einem Schritt sichern: jede weitere Zuweisung überschreibt PIPESTATUS
RC=${PS[0]}
TRC=${PS[1]:-1}
if ! markiert; then
  docker rm -f "rb-policy-run-$RUN" >/dev/null 2>&1
  trap - EXIT
  # Sicher ohne Aufräumen nur, wenn --run regulär vor dem Setzen endete (2 oder 3) und die Mitschrift vollständig ist.
  if [ "$TRC" = 0 ] && { [ "$RC" = 2 ] || [ "$RC" = 3 ]; }; then
    echo "== Policy wurde nicht gesetzt (Exit $RC) – nichts geändert"
    echo "== Ende Lauf $RUN"
    exit "$RC"
  fi
  echo "== Lauf endete ohne Markierung, aber nicht regulär (Exit $RC, Mitschrift $TRC): vorsorglich aufräumen"
  [ "$TRC" = 0 ] || UNSICHER=1 # gestörte Mitschrift: die Markierung könnte fehlen, obwohl gesetzt wurde
  aufraeumen
  exit $?
fi
[ "$UNTERBROCHEN" = 1 ] && { echo "== Unterbrochen"; exit 130; }
# mc-Teil nur nach einem regulär abgeschlossenen --run (Ergebniszeile vorhanden, also kein Abbruch, Watchdog oder docker kill).
if { [ "$RC" = 0 ] || [ "$RC" = 1 ]; } && grep -q '^Ergebnis: ' "$OUTF" && grep -q "^BESTANDEN  S1 Policy gesetzt" "$OUTF" && grep -q "^BESTANDEN  S2 Policy zurückgelesen" "$OUTF" && grep -q "^BESTANDEN  P1" "$OUTF"; then
  echo "== mc-Teil mit dem Writer-Schlüssel, wie Coolify ($HELPER, Wegwerf-Container, höchstens 75 Minuten)"
  timeout -k 30 4500 docker run --rm -i --init --ulimit core=0 --name "rb-policy-mc-$RUN" --network bridge --env-file "$W" -e TEST_S3_BUCKET="$BUCKET" -e RB_RUN="$RUN" --entrypoint sh "$HELPER" -s <<'SH'
set -u
case "$TEST_S3_BUCKET" in *test*) ;; *) echo "ABBRUCH: kein Test-Bucket"; exit 2;; esac
sicher() {
  awk 'BEGIN { n = split(ENVIRON["WRITER_S3_ACCESS_KEY"] " " ENVIRON["WRITER_S3_SECRET_KEY"], k, " ") }
  { for (i = 1; i <= n; i++) if (length(k[i]) > 0) while ((p = index($0, k[i])) > 0) $0 = substr($0, 1, p - 1) "***" substr($0, p + length(k[i])); print }'
}
# Zeitlimit je mc-Befehl, falls vorhanden (busybox oder coreutils).
if timeout 5 true 2>/dev/null; then T="timeout 600"; else T=""; fi
case "$(command -V printf 2>&1)" in *builtin*) ;; *) echo "NICHT OK   M0 printf ist kein Shell-Builtin – mc-Teil ausgelassen, keine Schlüssel übergeben"; exit 1;; esac
printf '%s\n%s\n' "$WRITER_S3_ACCESS_KEY" "$WRITER_S3_SECRET_KEY" | mc alias set rbw "$WRITER_S3_ENDPOINT" --api S3v4 >/tmp/alias.log 2>&1 \
  || { echo "NICHT OK   M0 mc alias set mit dem Writer-Schlüssel: $(sicher </tmp/alias.log | tail -1 | cut -c1-200)"; exit 1; }
P="rbw/$TEST_S3_BUCKET/rb-test/policy/$RB_RUN/w"
EIGENE=$($T mc ls rbw </dev/null 2>/dev/null | awk '{ print $NF }' | tr '\n' ' ')
case " $EIGENE " in *" $TEST_S3_BUCKET/ "*|*" rent-base-files/ "*|*" rent-base-backup/ "*) echo "NICHT OK   M1 Writer sieht fremde Buckets als eigene: $EIGENE"; exit 1;; esac
echo "BESTANDEN  M1 mc sieht als eigene Buckets des Writers: ${EIGENE:-keine}"
if $T mc ls "$P/" </dev/null >/tmp/ls.log 2>&1; then echo "BESTANDEN  M2 mc ls im erlaubten Bereich"; else echo "NICHT OK   M2 mc ls: $(sicher </tmp/ls.log | tail -1 | cut -c1-200)"; fi
F=/tmp/rentbase-dump-test.dmp
head -c 17825792 /dev/urandom >"$F"
SUM=$(sha256sum "$F" | cut -d' ' -f1)
K="$P/coolify/pg-dump.dmp"
if $T mc cp "$F" "$K" </dev/null >/tmp/cp.log 2>&1; then echo "BESTANDEN  M3 Upload 17 MiB (Teil-Upload) mit mc cp und eingeschränktem Schlüssel (Coolifys Weg)"
else echo "NICHT OK   M3 Upload mit mc cp: $(sicher </tmp/cp.log | tail -1 | cut -c1-200) – ein Teil-Upload-Rest wird beim Aufräumen abgebrochen"; exit 1; fi
GOT=$($T mc cat "$K" </dev/null 2>/dev/null | sha256sum | cut -d' ' -f1)
[ "$GOT" = "$SUM" ] && echo "BESTANDEN  M4 Rücklesen mit mc (wie Coolifys Wiederherstellung): SHA-256 identisch" || echo "NICHT OK   M4 Rücklesen mit mc: Prüfsumme weicht ab"
if $T mc rm "$K" </dev/null >/tmp/rm1.log 2>&1; then echo "NICHT OK   M5 mc rm außerhalb von files/ ERLAUBT – Präfix-Einschränkung wirkt nicht (nur Löschmarker)"
elif grep -qi 'denied' /tmp/rm1.log; then echo "BESTANDEN  M5 mc rm außerhalb von files/ abgewiesen (AccessDenied)"
else echo "HINWEIS    M5 mc rm abgelehnt, aber nicht als AccessDenied: $(sicher </tmp/rm1.log | tail -1 | cut -c1-160)"; fi
if $T mc rm --versions --force "$K" </dev/null >/tmp/rm2.log 2>&1 && ! $T mc stat "$K" </dev/null >/dev/null 2>&1; then echo "NICHT OK   M6 mc rm --versions hat die Datei ENTFERNT"
else echo "HINWEIS    M6 mc rm --versions abgewiesen, Datei weiter abrufbar ($(sicher </tmp/rm2.log | grep -io 'access denied\|accessdenied' | head -1)); aussagekräftig ist N2, hier sperrt zusätzlich die Standard-Sperre"; fi
SH
  [ "$UNTERBROCHEN" = 1 ] && { echo "== Unterbrochen"; exit 130; }
fi
exit "$RC"

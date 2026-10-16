#!/usr/bin/env bash
# Testvariante des Rahmens für den Vortest der Produktions-Backup-Skripte gegen den Test-Bucket (docs/backup-prod-vortest.md).
# Getrennt vom produktiven /root/backup-prod/run.sh, das unverändert bleibt. Liegt auf dem Server als
# /root/backup-prod-vortest/run-vortest.sh (root, 700) mit dem Testgerüst in /root/backup-prod-vortest/js/. Die geprüften
# Produktionsskripte kommen unverändert aus /root/backup-prod/js und werden nur lesend eingehängt.
# Start losgelöst:  cd /root/backup-prod-vortest && setsid nohup bash run-vortest.sh > start.txt 2>&1 < /dev/null &
#
# Zugangsdaten: ausschließlich der Test-Admin-Schlüssel aus /root/backup-test.env. Die Datei wird zeilenweise mit Shell-Builtins
# gelesen; die Schlüssel gehen nur über die Standardeingabe an den Wegwerf-Container, nicht in Argumente, Umgebung, Dateien oder
# Protokolle. Ziel ist fest rent-base-backup-test in hel1; eine andere Angabe in der Datei bricht ab.
set -uo pipefail
set +x
umask 077
ulimit -c 0

DIR=/root/backup-prod-vortest
PROD_JS=/root/backup-prod/js
VT_JS="$DIR/js"
ENVF=/root/backup-test.env
BUCKET=rent-base-backup-test
ENDPUNKT=https://hel1.your-objectstorage.com
APP=ye2zlmuxnpvk4osu9l5d9tqa

abbruch() { builtin printf 'ABBRUCH: %s\n' "$1" >&2; exit 2; }

[ "$(id -u)" = 0 ] || abbruch "nur als root ausführen"
for f in "$PROD_JS/backup-lib.mjs" "$PROD_JS/backup-prod-lib.mjs" "$VT_JS/backup-prod-vortest.mjs"; do
  [ -f "$f" ] && [ ! -L "$f" ] || abbruch "$f fehlt"
done
[ -f "$ENVF" ] && [ ! -L "$ENVF" ] && [ "$(stat -c '%U %a' "$ENVF")" = "root 600" ] || abbruch "$ENVF fehlt oder hat nicht root/600"
exec 9>"$DIR/.lock"
flock -n 9 || abbruch "ein anderer Vortest läuft"
[ "$(docker info --format '{{.Debug}}' 2>/dev/null)" = false ] || abbruch "Docker nicht erreichbar oder im Debug-Modus"
if docker ps -a --format '{{.Names}}' | grep -q '^rb-vortest-'; then abbruch "ein rb-vortest-Container existiert noch"; fi
# Wie im produktiven Rahmen: nur der Produktions-Container der App, genau einer, Image über die unveränderliche ID.
KANDIDATEN=$(docker ps --format '{{.Names}}' | grep -E "^${APP}-[0-9]+(T[0-9]+)?$")
[ -n "$KANDIDATEN" ] || abbruch "App-Container $APP läuft nicht"
[ "$(builtin printf '%s\n' "$KANDIDATEN" | wc -l)" -eq 1 ] || abbruch "mehrere App-Container laufen (Deploy im Gange?)"
IMG=$(docker inspect "$KANDIDATEN" --format '{{.Image}}') && [[ $IMG =~ ^sha256:[0-9a-f]{64}$ ]] || abbruch "Image des App-Containers nicht lesbar"

ak=""
sk=""
ep=""
bk=""
zeile=""
aufraeumen() {
  ak=""
  sk=""
  zeile=""
}
trap aufraeumen EXIT
while IFS= read -r zeile || [[ -n $zeile ]]; do
  case $zeile in
    TEST_S3_ACCESS_KEY=*) ak=${zeile#*=} ;;
    TEST_S3_SECRET_KEY=*) sk=${zeile#*=} ;;
    TEST_S3_ENDPOINT=*) ep=${zeile#*=} ;;
    TEST_S3_BUCKET=*) bk=${zeile#*=} ;;
  esac
  zeile=""
done <"$ENVF"
[[ -n $ak && -n $sk ]] || abbruch "Test-Schlüssel in $ENVF unvollständig"
[ "$bk" = "$BUCKET" ] || abbruch "$ENVF nennt einen anderen Bucket als $BUCKET"
[ "$ep" = "$ENDPUNKT" ] || abbruch "$ENVF nennt einen anderen Endpunkt als $ENDPUNKT"

ZEIT=$(date -u +%Y%m%dT%H%M%SZ)
ZUFALL=$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
RUN="rb-test/prodskript/${ZEIT}-${ZUFALL}/"
[[ $RUN =~ ^rb-test/prodskript/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}/$ ]] || abbruch "Laufpräfix ungültig"
LOG="$DIR/log-$ZEIT.txt"
SUMMEN=$(sha256sum "$PROD_JS/backup-lib.mjs" "$PROD_JS/backup-prod-lib.mjs" "$VT_JS/backup-prod-vortest.mjs" | cut -c1-12 | tr '\n' ' ')
builtin printf '== Vortest %s · Laufpräfix %s · Image %s · Skripte %s\n' "$ZEIT" "$RUN" "${IMG:7:12}" "$SUMMEN" | tee -a "$LOG"
builtin printf '%s\n%s\n' "$ak" "$sk" |
  docker run --rm -i --init --ulimit core=0 --network bridge --name "rb-vortest-$ZEIT" --entrypoint node \
    -v "$PROD_JS:/app/rb-prod:ro" -v "$VT_JS:/app/rb-vortest:ro" \
    -e "BACKUP_S3_ENDPOINT=$ENDPUNKT" -e "BACKUP_S3_REGION=hel1" -e "BACKUP_S3_BUCKET=$BUCKET" \
    -e "RB_VORTEST_PREFIX=$RUN" -e "RB_PROD_LIB=/app/rb-prod/backup-prod-lib.mjs" \
    -w /app "$IMG" /app/rb-vortest/backup-prod-vortest.mjs 2>&1 |
  tee -a "$LOG"
PS=("${PIPESTATUS[@]}")
ak=""
sk=""
RC=${PS[1]}
builtin printf '== Ende Vortest %s: Exit %s\n' "$RUN" "$RC" | tee -a "$LOG"
exit "$RC"

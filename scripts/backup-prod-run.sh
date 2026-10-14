#!/usr/bin/env bash
# Rahmen für Einrichtung und Prüfung des produktiven Backup-Buckets im Übergangsweg (docs/backup-uebergang.md).
# Liegt auf dem Server als /root/backup-prod/run.sh (root, 700), die Skripte in /root/backup-prod/js/. Aufruf im eigenen Terminal:
#   ssh -t rb bash /root/backup-prod/run.sh --pruefen                 nur lesend
#   ssh -t rb bash /root/backup-prod/run.sh --sperre                  Standard-Sperre COMPLIANCE 30 Tage setzen
#   ssh -t rb bash /root/backup-prod/run.sh --lifecycle <Dump-Präfix> Lifecycle-Regeln setzen
#   ssh -t rb bash /root/backup-prod/run.sh --check <Dump-Präfix>     voller lesender Prüflauf (wie der tägliche Scheduled Task)
#   ssh -t rb bash /root/backup-prod/run.sh --wiederherstellen <Dump-Präfix>   nach einem Eingriff: Sperre und Lifecycle auf den
#                                                                     vorgesehenen Stand, eine Bucket-Policy entfernen
#
# Access Key und Secret Key werden verdeckt eingelesen, nur mit Shell-Builtins geprüft und ausschließlich über die
# Standardeingabe an einen Wegwerf-Container aus dem App-Image weitergegeben: nicht in Befehlsargumenten, nicht in Dateien, nicht
# in Umgebungsvariablen, nicht im Protokoll, nie ausgegeben. Test-Schlüssel aus /root/backup-test.env und
# /root/backup-writer-test.env werden abgelehnt. Ändernde Modi verlangen vorher ein ausdrückliches „ja“, das ebenfalls verdeckt
# gelesen wird (ein zu früh eingefügter Schlüssel bleibt so unsichtbar). Während der Container läuft, ist das Terminal-Echo aus.
# Die Ausgabe (ohne Zugangsdaten) wird zusätzlich an /root/backup-prod/protokoll-<Monat>.txt angehängt.
set -uo pipefail
set +x
umask 077
ulimit -c 0

DIR=/root/backup-prod
JS="$DIR/js"
BUCKET=rent-base-backup
ENDPUNKT=https://hel1.your-objectstorage.com
REGION=hel1
APP=ye2zlmuxnpvk4osu9l5d9tqa
MUSTER='^[A-Za-z0-9/+=._~-]+$'

abbruch() { builtin printf 'ABBRUCH: %s\n' "$1" >&2; exit 2; }
# Abbruch mitten in der Schlüsseleingabe: weitere Eingaben unsichtbar auffangen, bis „ende“ kommt. Sonst landete ein danach
# eingefügter Schlüssel nach dem Ende der SSH-Sitzung in der lokalen Shell (und ihrer History).
abbruch_still() {
  builtin printf 'ABBRUCH: %s\n' "$1" >&2
  local x
  while IFS= read -r -s -p 'Zum Beenden „ende“ eingeben (Eingaben bleiben unsichtbar): ' x && [[ $x != ende ]]; do x=""; builtin printf '\n'; done
  x=""
  builtin printf '\n'
  exit 2
}
nutzung() { abbruch "Aufruf: run.sh --pruefen | --sperre | --lifecycle <Dump-Präfix> | --check <Dump-Präfix> | --wiederherstellen <Dump-Präfix>"; }

MODUS=${1:-}
PRAEFIX=""
AENDERT=""
case "$MODUS" in
  --pruefen) [ $# -eq 1 ] || nutzung; SKRIPT=backup-prod-setup.mjs; ARGS=(--pruefen) ;;
  --sperre)
    [ $# -eq 1 ] || nutzung; SKRIPT=backup-prod-setup.mjs; ARGS=(--sperre)
    AENDERT="die Standard-Sperre COMPLIANCE 30 Tage auf $BUCKET setzen. Jede danach hochgeladene Fassung ist 30 Tage lang unlöschbar, auch für dich und für Hetzner; das lässt sich für hochgeladene Fassungen nicht zurücknehmen." ;;
  --lifecycle)
    [ $# -eq 2 ] || nutzung; PRAEFIX=$2; SKRIPT=backup-prod-setup.mjs; ARGS=(--lifecycle "$PRAEFIX")
    AENDERT="die Lifecycle-Regeln auf $BUCKET setzen: Dumps unter $PRAEFIX nach 31 Tagen als gelöscht markieren und frühestens einen Tag später endgültig entfernen; alte Fassungen unter files/ nach 7, unter files-state/ nach 1 Tag (jeweils frühestens nach Ablauf der Sperre); abgebrochene Teil-Uploads nach 7 Tagen." ;;
  --check) [ $# -eq 2 ] || nutzung; PRAEFIX=$2; SKRIPT=backup-check.mjs; ARGS=(--voll) ;;
  --wiederherstellen)
    [ $# -eq 2 ] || nutzung; PRAEFIX=$2; SKRIPT=backup-prod-setup.mjs; ARGS=(--wiederherstellen "$PRAEFIX")
    AENDERT="die Einstellungen von $BUCKET auf den vorgesehenen Stand zurücksetzen: Standard-Sperre COMPLIANCE 30 Tage, die vier Lifecycle-Regeln für $PRAEFIX, eine vorhandene Bucket-Policy entfernen und die Bucket-ACL auf privat setzen. Objekte und Fassungen werden nicht gelöscht." ;;
  *) nutzung ;;
esac
if [ -n "$PRAEFIX" ] && ! [[ $PRAEFIX =~ ^[A-Za-z0-9._/-]+/$ ]]; then abbruch "Dump-Präfix nur aus Buchstaben, Ziffern, . _ - / und mit / am Ende"; fi

[ "$(id -u)" = 0 ] || abbruch "nur als root ausführen"
[ -t 0 ] || abbruch "nur interaktiv im Terminal ausführen (ssh -t); Schlüssel nie per Pipe übergeben"
# Echo von Anfang an aus: Ein zu früh eingefügter Schlüssel bleibt unsichtbar. read -s stellt danach diesen Zustand wieder her;
# der EXIT-Trap schaltet das Echo am Ende wieder ein (hier vorläufig, unten mit dem Aufräumen der Variablen).
trap 'stty echo 2>/dev/null || true' EXIT
stty -echo 2>/dev/null || true
for f in backup-lib.mjs backup-prod-lib.mjs backup-prod-setup.mjs backup-check.mjs; do
  [ -f "$JS/$f" ] && [ ! -L "$JS/$f" ] || abbruch "$JS/$f fehlt"
done
exec 9>"$DIR/.lock"
flock -n 9 || abbruch "ein anderer Lauf ist aktiv"
[ "$(docker info --format '{{.Debug}}' 2>/dev/null)" = false ] || abbruch "Docker nicht erreichbar oder im Debug-Modus (würde Anfragen protokollieren)"
# Nur der Produktions-Container (<uuid>-<Zeitstempel>, z. B. -20261008T120740), keine Vorschau-Deployments (<uuid>-pr-<n>);
# genau einer.
KANDIDATEN=$(docker ps --format '{{.Names}}' | grep -E "^${APP}-[0-9]+(T[0-9]+)?$")
[ -n "$KANDIDATEN" ] || abbruch "App-Container $APP läuft nicht; sein Image wird für den Wegwerf-Container gebraucht"
[ "$(builtin printf '%s\n' "$KANDIDATEN" | wc -l)" -eq 1 ] || abbruch "mehrere App-Container laufen (Deploy im Gange?); später erneut versuchen"
CONTAINER=$KANDIDATEN
IMG=$(docker inspect "$CONTAINER" --format '{{.Image}}') && [[ $IMG =~ ^sha256:[0-9a-f]{64}$ ]] || abbruch "Image des App-Containers nicht lesbar"
IMGNAME=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')

ak=""
sk=""
wert=""
zeile=""
fremd=""
aufraeumen() {
  stty echo 2>/dev/null || true
  ak=""
  sk=""
  wert=""
  zeile=""
  fremd=""
  antwort=""
  unset BASH_REMATCH 2>/dev/null || true
}
trap aufraeumen EXIT
trap 'builtin printf "\nAbgebrochen.\n" >&2; exit 130' INT TERM HUP

antwort=""
# Einfügen ohne Klammer-Steuerzeichen (Bracketed Paste), damit der Passwortmanager-Wert unverändert ankommt.
builtin printf '\033[?2004l'
builtin printf 'Bucket %s · Endpunkt %s · Modus %s%s\n' "$BUCKET" "$ENDPUNKT" "$MODUS" "${PRAEFIX:+ · Dump-Präfix $PRAEFIX}"
if [ -n "$AENDERT" ]; then
  builtin printf '\nDieser Lauf wird %s\n' "$AENDERT"
  IFS= read -r -s -p 'Fortfahren? Genau „ja“ eingeben (bleibt unsichtbar), dann Enter: ' antwort || abbruch "Eingabe beendet, nichts geändert"
  builtin printf '\n'
  if [ "$antwort" != ja ]; then
    antwort=""
    abbruch_still "nicht bestätigt, nichts geändert"
  fi
  antwort=""
  builtin printf '  „ja“ erkannt.\n'
fi
builtin printf '\nAdmin-Schlüssel des Backup-Projekts aus dem Passwortmanager (nicht den Coolify- oder Test-Schlüssel).\n'

# Besteht der Wert aus zwei oder mehr gleichen Stücken (z. B. zwei- oder dreimal eingefügt)? Nur Builtins.
wiederholt() {
  local w=$1 n=${#1} d i stueck kette
  for ((d = 1; d <= n / 2; d++)); do
    ((n % d == 0)) || continue
    stueck=${w:0:d}
    kette=""
    for ((i = 0; i < n / d; i++)); do kette+=$stueck; done
    if [[ $kette == "$w" ]]; then w=""; stueck=""; kette=""; return 0; fi
  done
  w=""; stueck=""; kette=""
  return 1
}

# Ist der Wert ein Schlüssel aus einer der Test-Zugangsdateien? Zeilenweise mit Builtins gelesen, nur im Speicher verglichen.
test_schluessel() {
  local datei
  for datei in /root/backup-test.env /root/backup-writer-test.env; do
    [ -f "$datei" ] || continue
    while IFS= read -r zeile || [[ -n $zeile ]]; do
      case $zeile in
        *_S3_ACCESS_KEY=* | *_S3_SECRET_KEY=*)
          fremd=${zeile#*=}
          if [[ -n $fremd && $fremd == "$1" ]]; then zeile=""; fremd=""; return 0; fi ;;
      esac
      zeile=""
      fremd=""
    done <"$datei"
  done
  return 1
}

# $1 = Name der Zielvariable, $2 = Anzeigename, $3 = "secret" beim Secret Key. Leere Zeilen werden übergangen, ungültige Werte
# bis zu dreimal abgelehnt. Der Wert wird nie angezeigt.
lies_geheim() {
  local -n _ziel=$1
  local fehler=0 grund
  while :; do
    IFS= read -r -s -p "$2 einfügen (bleibt unsichtbar), dann Enter: " wert || abbruch "Eingabe beendet, nichts geändert"
    builtin printf '\n'
    [[ -n $wert ]] || continue
    grund=""
    if ! { ((${#wert} >= 10)) && [[ $wert =~ $MUSTER ]]; }; then
      grund="zu kurz oder mit Leer- bzw. Sonderzeichen"
    elif wiederholt "$wert"; then
      grund="besteht aus mehrfach demselben Wert – vermutlich mehrmals eingefügt; bitte genau einmal einfügen"
    elif [[ ${3:-} == secret ]] && [[ $wert == *"$ak"* ]]; then
      grund="entspricht dem Access Key oder enthält ihn – bitte den Secret Key einfügen"
    elif [[ ${3:-} == secret ]] && [[ $ak == *"$wert"* ]]; then
      grund="steckt bereits im erfassten Access Key – dort wurde vermutlich zu viel eingefügt; mit Strg+C abbrechen und neu starten"
    elif test_schluessel "$wert"; then
      grund="ist ein Test-Schlüssel – für den Produktions-Bucket den Admin-Schlüssel des Backup-Projekts verwenden"
    fi
    unset BASH_REMATCH 2>/dev/null || true
    if [[ -z $grund ]]; then
      _ziel=$wert
      wert=""
      builtin printf '  %s erfasst.\n' "$2"
      return 0
    fi
    wert=""
    fehler=$((fehler + 1))
    builtin printf '  Nicht übernommen (%s). Versuch %s von 3.\n' "$grund" "$fehler"
    ((fehler < 3)) || abbruch_still "$2 nicht erfasst, nichts geändert"
  done
}

lies_geheim ak "Access Key"
lies_geheim sk "Secret Key" secret

ZEIT=$(date -u +%Y%m%dT%H%M%SZ)
PROTOKOLL="$DIR/protokoll-${ZEIT:0:6}.txt"
SUMMEN=$(cd "$JS" && sha256sum backup-lib.mjs backup-prod-lib.mjs backup-prod-setup.mjs backup-check.mjs | cut -c1-12 | tr '\n' ' ')
builtin printf '\n== %s %s%s · Image %s (%s) · Skripte %s\n' "$ZEIT" "$MODUS" "${PRAEFIX:+ $PRAEFIX}" "$IMGNAME" "${IMG:7:12}" "$SUMMEN" | tee -a "$PROTOKOLL"
UMGEBUNG=(-e "BACKUP_S3_ENDPOINT=$ENDPUNKT" -e "BACKUP_S3_REGION=$REGION" -e "BACKUP_S3_BUCKET=$BUCKET")
[ "$SKRIPT" = backup-check.mjs ] && UMGEBUNG+=(-e "BACKUP_DUMP_PREFIX=$PRAEFIX")
# Ab hier liest nichts mehr vom Terminal: Echo aus, damit eine verspätet eingefügte Eingabe nicht sichtbar wird.
builtin printf '  Weitere Eingaben bleiben bis zum Ende des Laufs unsichtbar.\n'
stty -echo 2>/dev/null || true
builtin printf '%s\n%s\n' "$ak" "$sk" |
  docker run --rm -i --init --ulimit core=0 --network bridge --name "rb-prod-${MODUS#--}-$ZEIT" --entrypoint node \
    -v "$JS:/app/rb-prod:ro" "${UMGEBUNG[@]}" -w /app "$IMG" "/app/rb-prod/$SKRIPT" --schluessel-stdin "${ARGS[@]}" 2>&1 |
  tee -a "$PROTOKOLL"
PS=("${PIPESTATUS[@]}")
ak=""
sk=""
RC=${PS[1]}
builtin printf '== Ende %s: Exit %s\n' "$MODUS" "$RC" | tee -a "$PROTOKOLL"
exit "$RC"

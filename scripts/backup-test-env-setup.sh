#!/usr/bin/env bash
# Legt /root/backup-test.env für den Backup-Test-Bucket an (Anleitung: docs/backup-test-bucket.md, Schritt 4).
# Aufruf im eigenen Terminal:  ssh -t rb bash /root/backup-test-env-setup.sh
#
# Access Key und Secret Key werden verdeckt eingelesen (kein Echo) und nur mit Shell-Builtins verarbeitet und geschrieben:
# nicht in Befehlsargumenten anderer Programme, nicht in der Umgebung, nicht in der History, nie ausgegeben, auch nicht
# teilweise. Eine vorhandene Datei wird nie überschrieben. Am Ende nur Besitzer, Rechte und Vorhandensein der Variablen.
set -euo pipefail
set +x
umask 077
ulimit -c 0

ZIEL=/root/backup-test.env
ENDPUNKT=https://hel1.your-objectstorage.com
REGION=hel1
MUSTER='^[A-Za-z0-9/+=._~-]+$'

abbruch() { builtin printf 'ABBRUCH: %s\n' "$1" >&2; exit 2; }

[ "$(id -u)" = 0 ] || abbruch "nur als root ausführen"
[ -t 0 ] || abbruch "nur interaktiv im Terminal ausführen (ssh -t); Schlüssel nie per Pipe übergeben"
if [ -e "$ZIEL" ] || [ -L "$ZIEL" ]; then abbruch "$ZIEL existiert bereits, nichts verändert"; fi

tmp=""
ak=""
sk=""
aufraeumen() {
  stty echo 2>/dev/null || true
  ak=""
  sk=""
  unset BASH_REMATCH 2>/dev/null || true
  if [ -n "$tmp" ]; then rm -f -- "$tmp"; fi
}
trap aufraeumen EXIT
trap 'builtin printf "\nAbgebrochen, nichts angelegt.\n" >&2; exit 130' INT TERM HUP

# Einfügen ohne Klammer-Steuerzeichen (Bracketed Paste), damit der Passwortmanager-Wert unverändert ankommt.
builtin printf '\033[?2004l'

# $1 = Name der Zielvariable, $2 = Anzeigename. Leere Zeilen (zusätzliches Enter) werden übergangen,
# ungültige Werte bis zu dreimal abgelehnt. Der Wert wird nie angezeigt.
lies_geheim() {
  local -n _ziel=$1
  local fehler=0 wert
  while :; do
    IFS= read -r -s -p "$2 einfügen (bleibt unsichtbar), dann Enter: " wert || abbruch "Eingabe beendet, nichts angelegt"
    builtin printf '\n'
    [[ -n $wert ]] || continue
    if ((${#wert} >= 10)) && [[ $wert =~ $MUSTER ]]; then
      _ziel=$wert
      wert=""
      unset BASH_REMATCH 2>/dev/null || true
      builtin printf '  %s erfasst.\n' "$2"
      return 0
    fi
    wert=""
    fehler=$((fehler + 1))
    builtin printf '  Nicht übernommen (zu kurz oder mit Leer- bzw. Sonderzeichen). Versuch %s von 3.\n' "$fehler"
    ((fehler < 3)) || abbruch "$2 nicht erfasst, nichts angelegt"
  done
}

builtin printf 'Einrichtung %s (Endpunkt %s)\n\n' "$ZIEL" "$ENDPUNKT"
IFS= read -r -p "Bucket-Name (z. B. rent-base-backup-test): " bucket || abbruch "Eingabe beendet, nichts angelegt"
case "$bucket" in rent-base-files | rent-base-backup) abbruch "Produktions-Bucket ist nicht erlaubt" ;; esac
[[ $bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || abbruch "ungültiger Bucket-Name (nur a–z, 0–9 und Bindestrich)"
[[ $bucket == *test* ]] || abbruch "der Bucket-Name muss „test“ enthalten"

lies_geheim ak "Access Key"
lies_geheim sk "Secret Key"
[[ $ak != "$sk" ]] || abbruch "Access Key und Secret Key sind gleich (zweimal dasselbe eingefügt?), nichts angelegt"

tmp=$(mktemp /root/.backup-test.env.XXXXXX)
{
  builtin printf 'TEST_S3_ENDPOINT=%s\n' "$ENDPUNKT"
  builtin printf 'TEST_S3_REGION=%s\n' "$REGION"
  builtin printf 'TEST_S3_BUCKET=%s\n' "$bucket"
  builtin printf 'TEST_S3_ACCESS_KEY=%s\n' "$ak"
  builtin printf 'TEST_S3_SECRET_KEY=%s\n' "$sk"
} >"$tmp"
ak=""
sk=""
chmod 600 -- "$tmp"
# Harter Link legt die Datei nur an, wenn sie noch nicht existiert (kein Überschreiben, auch nicht bei einem Wettlauf).
ln -- "$tmp" "$ZIEL" || abbruch "$ZIEL ist inzwischen entstanden, nichts überschrieben"
rm -f -- "$tmp"
tmp=""

builtin printf '\nAngelegt: %s\n' "$ZIEL"
builtin printf '  Besitzer und Rechte: %s\n' "$(stat -c '%U:%G %a' -- "$ZIEL")"
fehlt=0
for name in TEST_S3_ENDPOINT TEST_S3_REGION TEST_S3_BUCKET TEST_S3_ACCESS_KEY TEST_S3_SECRET_KEY; do
  if grep -q "^${name}=." -- "$ZIEL"; then
    builtin printf '  %-20s vorhanden\n' "$name"
  else
    builtin printf '  %-20s FEHLT\n' "$name"
    fehlt=1
  fi
done
[ "$fehlt" = 0 ] || abbruch "Datei unvollständig; bitte melden, nicht selbst ändern"
builtin printf '\nFertig. Die Werte wurden nicht angezeigt. Nach dem Test entfernen mit: shred -u %s\n' "$ZIEL"

#!/usr/bin/env bash
# Legt die Zugangsdatei für den Backup-Test an (Anleitungen: docs/backup-test-bucket.md Schritt 4, docs/backup-policy-test.md).
# Liegt auf dem Server als /root/backup-env-setup-v2.sh (root, 700; ab 14.10.2026, die Vorversion /root/backup-env-setup.sh
# bleibt unverändert). Aufruf im eigenen Terminal:
#   ssh -t rb bash /root/backup-env-setup-v2.sh            Test-Admin-Schlüssel  → /root/backup-test.env
#   ssh -t rb bash /root/backup-env-setup-v2.sh --writer   Writer-Testschlüssel  → /root/backup-writer-test.env
# Seit v2 werden doppelt eingefügte Werte und ein Access Key im Secret-Feld sofort abgelehnt (Anlass: Eingabefehler 13.10.2026).
#
# Access Key und Secret Key werden verdeckt eingelesen (kein Echo) und nur mit Shell-Builtins verarbeitet und geschrieben:
# nicht in Befehlsargumenten anderer Programme, nicht in der Umgebung, nicht in der History, nie ausgegeben, auch nicht
# teilweise. Eine vorhandene Datei wird nie überschrieben. Am Ende nur Besitzer, Rechte und Vorhandensein der Variablen.
set -euo pipefail
set +x
umask 077
ulimit -c 0

BASIS=/root
ENDPUNKT=https://hel1.your-objectstorage.com
REGION=hel1
MUSTER='^[A-Za-z0-9/+=._~-]+$'
case "${1:-}" in
  "") WRITER=0; P=TEST; ZIEL="$BASIS/backup-test.env" ;;
  --writer) WRITER=1; P=WRITER; ZIEL="$BASIS/backup-writer-test.env" ;;
  *) builtin printf 'ABBRUCH: unbekannte Option %s (erlaubt: --writer)\n' "$1" >&2; exit 2 ;;
esac

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

[ "$(id -u)" = 0 ] || abbruch "nur als root ausführen"
[ -t 0 ] || abbruch "nur interaktiv im Terminal ausführen (ssh -t); Schlüssel nie per Pipe übergeben"
if [ -e "$ZIEL" ] || [ -L "$ZIEL" ]; then abbruch "$ZIEL existiert bereits, nichts verändert"; fi
if [ "$WRITER" = 1 ] && [ ! -f "$BASIS/backup-test.env" ]; then abbruch "$BASIS/backup-test.env fehlt; der Writer-Test braucht den Test-Admin-Schlüssel"; fi

tmp=""
ak=""
sk=""
adm=""
adms=""
wert=""
zeile=""
grund=""
aufraeumen() {
  stty echo 2>/dev/null || true
  ak=""
  sk=""
  adm=""
  adms=""
  wert=""
  zeile=""
  unset BASH_REMATCH 2>/dev/null || true
  if [ -n "$tmp" ]; then rm -f -- "$tmp"; fi
}
trap aufraeumen EXIT
trap 'builtin printf "\nAbgebrochen, nichts angelegt.\n" >&2; exit 130' INT TERM HUP

# Einfügen ohne Klammer-Steuerzeichen (Bracketed Paste), damit der Passwortmanager-Wert unverändert ankommt.
builtin printf '\033[?2004l'

# $1 = Name der Zielvariable, $2 = Anzeigename, $3 = "secret" beim Secret Key (dann Vergleich mit dem erfassten Access Key).
# Leere Zeilen (zusätzliches Enter) werden übergangen, ungültige Werte bis zu dreimal abgelehnt. Der Wert wird nie angezeigt.
# Alle Prüfungen nur mit Shell-Builtins.
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

lies_geheim() {
  local -n _ziel=$1
  local fehler=0 wert grund
  while :; do
    IFS= read -r -s -p "$2 einfügen (bleibt unsichtbar), dann Enter: " wert || abbruch "Eingabe beendet, nichts angelegt"
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
    ((fehler < 3)) || abbruch_still "$2 nicht erfasst, nichts angelegt"
  done
}

builtin printf 'Einrichtung %s (Endpunkt %s)\n\n' "$ZIEL" "$ENDPUNKT"
if [ "$WRITER" = 0 ]; then
  # Verdeckt wie die Projekt-ID, damit ein zu früh eingefügter Schlüssel nicht sichtbar wird; der gültige Name wird danach angezeigt.
  fehler=0
  while :; do
    IFS= read -r -s -p "Bucket-Name (z. B. rent-base-backup-test, bleibt unsichtbar): " bucket || abbruch "Eingabe beendet, nichts angelegt"
    builtin printf '\n'
    [[ -n $bucket ]] || continue
    grund=""
    case "$bucket" in rent-base-files | rent-base-backup) grund="Produktions-Bucket ist nicht erlaubt" ;; esac
    if [[ -z $grund ]] && ! [[ $bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then grund="nur a–z, 0–9 und Bindestrich; eingefügter Text wurde verworfen"; fi
    if [[ -z $grund && $bucket != *test* ]]; then grund="der Bucket-Name muss „test“ enthalten"; fi
    unset BASH_REMATCH 2>/dev/null || true
    if [[ -z $grund ]]; then builtin printf '  Bucket %s erfasst.\n' "$bucket"; break; fi
    bucket=""
    fehler=$((fehler + 1))
    builtin printf '  Nicht übernommen (%s). Versuch %s von 3.\n' "$grund" "$fehler"
    ((fehler < 3)) || abbruch_still "Bucket-Name nicht erfasst, nichts angelegt"
  done
else
  # Verdeckt, damit ein versehentlich zu früh eingefügter Schlüssel nicht sichtbar wird; die gültige ID wird danach angezeigt.
  fehler=0
  while :; do
    IFS= read -r -s -p "Projekt-ID des Writer-Projekts (Zahl aus der Console-Adresse …/projects/<ID>/…, bleibt unsichtbar): " projekt || abbruch "Eingabe beendet, nichts angelegt"
    builtin printf '\n'
    [[ -n $projekt ]] || continue
    if [[ $projekt =~ ^[0-9]{1,12}$ ]]; then builtin printf '  Projekt-ID %s erfasst.\n' "$projekt"; break; fi
    projekt=""
    fehler=$((fehler + 1))
    builtin printf '  Nicht übernommen (nur Ziffern; eingefügter Text wurde verworfen). Versuch %s von 3.\n' "$fehler"
    ((fehler < 3)) || abbruch_still "Projekt-ID nicht erfasst, nichts angelegt"
  done
fi

lies_geheim ak "Access Key"
lies_geheim sk "Secret Key" secret
[[ $ak != "$sk" ]] || abbruch "Access Key und Secret Key sind gleich (zweimal dasselbe eingefügt?), nichts angelegt"
if [ "$WRITER" = 1 ]; then
  # Der Writer-Schlüssel muss aus einem anderen Projekt stammen als der Test-Admin-Schlüssel. Vergleich nur mit Builtins.
  # Ganze Zeilen lesen und mit Parametererweiterung trennen: IFS='=' würde ein einzelnes '=' am Wertende abschneiden. Auch die
  # letzte Zeile ohne Zeilenschaltung wird gelesen.
  while IFS= read -r zeile || [[ -n $zeile ]]; do
    case $zeile in
      TEST_S3_ACCESS_KEY=*) adm=${zeile#*=} ;;
      TEST_S3_SECRET_KEY=*) adms=${zeile#*=} ;;
    esac
    zeile=""
  done <"$BASIS/backup-test.env"
  zeile=""
  [[ -n $adm && -n $adms ]] || abbruch "Test-Admin-Schlüssel in $BASIS/backup-test.env nicht vollständig gefunden, nichts angelegt"
  [[ $ak != "$adm" && $ak != "$adms" ]] || abbruch "der Access Key ist ein Test-Admin-Schlüssel, nicht der Writer-Schlüssel – nichts angelegt"
  [[ $sk != "$adms" && $sk != "$adm" ]] || abbruch "der Secret Key ist ein Test-Admin-Schlüssel, nicht der Writer-Schlüssel – nichts angelegt"
  adm=""
  adms=""
fi

tmp=$(mktemp "$BASIS/.backup-env.XXXXXX")
{
  builtin printf '%s_S3_ENDPOINT=%s\n' "$P" "$ENDPUNKT"
  builtin printf '%s_S3_REGION=%s\n' "$P" "$REGION"
  if [ "$WRITER" = 0 ]; then builtin printf 'TEST_S3_BUCKET=%s\n' "$bucket"; else builtin printf 'WRITER_PROJECT_ID=%s\n' "$projekt"; fi
  builtin printf '%s_S3_ACCESS_KEY=%s\n' "$P" "$ak"
  builtin printf '%s_S3_SECRET_KEY=%s\n' "$P" "$sk"
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
if [ "$WRITER" = 0 ]; then NAMEN="TEST_S3_ENDPOINT TEST_S3_REGION TEST_S3_BUCKET TEST_S3_ACCESS_KEY TEST_S3_SECRET_KEY"
else NAMEN="WRITER_S3_ENDPOINT WRITER_S3_REGION WRITER_PROJECT_ID WRITER_S3_ACCESS_KEY WRITER_S3_SECRET_KEY"; fi
fehlt=0
for name in $NAMEN; do
  if grep -q "^${name}=." -- "$ZIEL"; then
    builtin printf '  %-20s vorhanden\n' "$name"
  else
    builtin printf '  %-20s FEHLT\n' "$name"
    fehlt=1
  fi
done
[ "$fehlt" = 0 ] || abbruch "Datei unvollständig; bitte melden, nicht selbst ändern"
builtin printf '\nFertig. Die Werte wurden nicht angezeigt. Nach dem Test entfernen mit: shred -u %s\n' "$ZIEL"

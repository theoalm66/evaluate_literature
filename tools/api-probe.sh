#!/bin/sh
# Startet tools/api-probe.js in einem Node-Container: Es reicht Docker, Node muss nicht installiert sein.
#   tools/api-probe.sh --url https://<Server>/v1 --model <Modell> [--quick] [--text datei.txt]
# Ohne gesetzte Umgebungsvariable LIT_PROBE_KEY fragt das Skript den API-Key unsichtbar ab.
set -e
cd "$(dirname "$0")/.."
if [ -z "$LIT_PROBE_KEY" ]; then
    printf 'API-Key (die Eingabe bleibt unsichtbar): '
    stty -echo 2>/dev/null || true
    read -r LIT_PROBE_KEY
    stty echo 2>/dev/null || true
    echo
    export LIT_PROBE_KEY
fi
exec docker run --rm -e LIT_PROBE_KEY -v "$PWD":/work -w /work --user "$(id -u):$(id -g)" \
    node:22-bookworm-slim node tools/api-probe.js "$@"

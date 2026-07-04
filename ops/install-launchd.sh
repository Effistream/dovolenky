#!/bin/zsh
#
# Nainstaluje (nebo odinstaluje) launchd job pro dovolenky scan.
#
# Použití:
#   ops/install-launchd.sh              — nainstaluje/aktualizuje job
#   ops/install-launchd.sh --uninstall  — odstraní job

set -euo pipefail

LABEL="com.daniel.dovolenky.scan"
SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_SRC="$SCRIPT_DIR/launchd/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Odinstalovávám $LABEL…"
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  echo "Hotovo. Job je odregistrovaný a plist smazaný z ~/Library/LaunchAgents/."
  exit 0
fi

echo "Instaluji $LABEL…"

# On a fresh checkout logs/ and data/ don't exist yet; launchd redirects stdout/stderr into
# logs/scan.log and the scan writes the SQLite DB into data/, so create both before load or the
# very first run fails to open its log/DB.
mkdir -p "$PROJECT_DIR/logs" "$PROJECT_DIR/data"

cp "$PLIST_SRC" "$PLIST_DEST"
echo "Zkopírováno do $PLIST_DEST."

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "Hotovo. Scan poběží každé 2 hodiny (v :05, 00:05–22:05)."
echo "Log najdeš v logs/scan.log. Odinstalace: ops/install-launchd.sh --uninstall"

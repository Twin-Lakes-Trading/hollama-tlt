#!/bin/sh
# Builds Scipio UI and installs it as a launch agent that starts at login and
# restarts if it exits. Safe to run again: it replaces the existing agent.
#
# Usage: deploy/install.sh            (serves on port 4173)
#        PORT=8080 deploy/install.sh
set -eu

LABEL=com.tlt.scipio-ui
PORT="${PORT:-4173}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/scipio-ui.log"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
	echo "node not found. Install it with: brew install node@24" >&2
	exit 1
fi
case "$("$NODE" --version)" in
v24.*) ;;
*) echo "Warning: expected Node 24 (see .nvmrc), found $("$NODE" --version)" >&2 ;;
esac

cd "$APP_DIR"
npm ci
PUBLIC_ADAPTER=docker-node npm run build

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
sed -e "s#__NODE__#$NODE#g" \
	-e "s#__APP_DIR__#$APP_DIR#g" \
	-e "s#__PORT__#$PORT#g" \
	-e "s#__LOG__#$LOG#g" \
	deploy/$LABEL.plist >"$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Scipio UI is running on port $PORT (logs: $LOG)"

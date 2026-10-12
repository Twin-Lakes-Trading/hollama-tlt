#!/bin/sh
# Builds Scipio UI and installs it as a launch agent that starts at login and
# restarts if it exits. Safe to run again: it replaces the existing agent.
#
# Usage: deploy/install.sh            (serves on 10.20.0.9:4173)
#        PORT=8080 BIND_ADDRESS=10.20.0.9 deploy/install.sh
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

# Only listen on the mini's WireGuard address, so nothing outside the VPN can
# connect. Override with BIND_ADDRESS=... if the WireGuard address changes.
BIND_ADDRESS="${BIND_ADDRESS:-10.20.0.9}"
if ! ifconfig | grep -q "inet $BIND_ADDRESS "; then
	echo "$BIND_ADDRESS isn't assigned to this machine. Is WireGuard up?" >&2
	echo "Set BIND_ADDRESS to the mini's WireGuard address and run this again." >&2
	exit 1
fi

cd "$APP_DIR"
npm ci
PUBLIC_ADAPTER=docker-node npm run build

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
sed -e "s#__NODE__#$NODE#g" \
	-e "s#__APP_DIR__#$APP_DIR#g" \
	-e "s#__PORT__#$PORT#g" \
	-e "s#__BIND_ADDRESS__#$BIND_ADDRESS#g" \
	-e "s#__LOG__#$LOG#g" \
	deploy/$LABEL.plist >"$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Scipio UI is running on http://$BIND_ADDRESS:$PORT (logs: $LOG)"

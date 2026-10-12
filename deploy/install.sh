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
# bootout returns before launchd has removed the agent, and bootstrapping
# while it's still there fails with "Input/output error"
i=0
while launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -ge 15 ]; then
		echo "The old $LABEL agent didn't stop. Try again in a few seconds." >&2
		exit 1
	fi
	sleep 1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

i=0
until curl -fs -o /dev/null "http://$BIND_ADDRESS:$PORT/"; do
	i=$((i + 1))
	if [ "$i" -ge 15 ]; then
		echo "Scipio UI didn't start. Last lines of $LOG:" >&2
		tail -n 20 "$LOG" >&2
		exit 1
	fi
	sleep 1
done

echo "Scipio UI is running on http://$BIND_ADDRESS:$PORT (logs: $LOG)"

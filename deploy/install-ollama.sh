#!/bin/sh
# Runs Ollama as a launch agent listening on the network (0.0.0.0:11434), so the
# Scipio UI can reach it over WireGuard. Replaces `brew services`, which drops
# custom environment variables. Safe to run again: it replaces the agent.
#
# Usage: deploy/install-ollama.sh
set -eu

LABEL=com.tlt.ollama
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ollama.log"
OLLAMA="$(command -v ollama || true)"

if [ -z "$OLLAMA" ]; then
	echo "ollama not found. Install it with: brew install ollama" >&2
	exit 1
fi

# Stop anything else that runs Ollama, so it doesn't hold the port
if command -v brew >/dev/null 2>&1; then
	brew services stop ollama >/dev/null 2>&1 || true
fi
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true

i=0
while lsof -iTCP:11434 -sTCP:LISTEN >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -ge 10 ]; then
		echo "Something else is still using port 11434:" >&2
		lsof -iTCP:11434 -sTCP:LISTEN >&2
		echo "Stop it (or remove Ollama.app from Login Items) and run this again." >&2
		exit 1
	fi
	sleep 1
done

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
sed -e "s#__OLLAMA__#$OLLAMA#g" \
	-e "s#__LOG__#$LOG#g" \
	"$APP_DIR/deploy/$LABEL.plist" >"$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"

i=0
until curl -fs http://127.0.0.1:11434/api/version >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -ge 15 ]; then
		echo "Ollama didn't start. Check $LOG" >&2
		exit 1
	fi
	sleep 1
done

lsof -iTCP:11434 -sTCP:LISTEN
echo "Ollama is listening on 0.0.0.0:11434 (logs: $LOG)"

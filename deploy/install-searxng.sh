#!/bin/sh
# Installs or updates SearXNG, the search engine behind Scipio UI's web search,
# and runs it as a launch agent on 127.0.0.1:8888. Safe to run again: it pulls
# the latest SearXNG, keeps the existing settings, and replaces the agent.
#
# Usage: deploy/install-searxng.sh
#        NO_AGENT=1 deploy/install-searxng.sh   (set up files only, don't start it)
set -eu

LABEL=com.tlt.searxng
PORT="${PORT:-8888}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SEARXNG_DIR="${SEARXNG_DIR:-$HOME/searxng}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/searxng.log"

# SearXNG needs Python 3.10+, and macOS ships 3.9, so use Homebrew's
PYTHON=""
for candidate in "$(brew --prefix 2>/dev/null)/bin/python3" python3.13 python3.12 python3; do
	if command -v "$candidate" >/dev/null 2>&1 &&
		"$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
		PYTHON="$(command -v "$candidate")"
		break
	fi
done
if [ -z "$PYTHON" ]; then
	echo "SearXNG needs Python 3.10 or newer. Install it with: brew install python" >&2
	exit 1
fi
echo "Using $("$PYTHON" --version) at $PYTHON"

mkdir -p "$SEARXNG_DIR"
if [ -d "$SEARXNG_DIR/searxng-src/.git" ]; then
	git -C "$SEARXNG_DIR/searxng-src" pull --ff-only
else
	git clone --depth 1 https://github.com/searxng/searxng "$SEARXNG_DIR/searxng-src"
fi

if [ ! -x "$SEARXNG_DIR/venv/bin/python" ]; then
	"$PYTHON" -m venv "$SEARXNG_DIR/venv"
fi
PIP="$SEARXNG_DIR/venv/bin/pip"
"$PIP" install -q -U pip setuptools wheel
(
	cd "$SEARXNG_DIR/searxng-src"
	"$PIP" install -q -r requirements.txt -r requirements-server.txt
	"$PIP" install -q --use-pep517 --no-build-isolation -e .
)

# Keep existing settings (and their secret key) on re-runs
if [ ! -f "$SEARXNG_DIR/settings.yml" ]; then
	sed -e "s#__SECRET_KEY__#$(openssl rand -hex 32)#" \
		"$APP_DIR/deploy/searxng-settings.yml" >"$SEARXNG_DIR/settings.yml"
	chmod 600 "$SEARXNG_DIR/settings.yml"
fi

if [ -n "${NO_AGENT:-}" ]; then
	echo "SearXNG is set up in $SEARXNG_DIR (launch agent not installed)"
	exit 0
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
sed -e "s#__SEARXNG_DIR__#$SEARXNG_DIR#g" \
	-e "s#__PORT__#$PORT#g" \
	-e "s#__LOG__#$LOG#g" \
	"$APP_DIR/deploy/$LABEL.plist" >"$PLIST"

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
until curl -fs -o /dev/null "http://127.0.0.1:$PORT/healthz"; do
	i=$((i + 1))
	if [ "$i" -ge 30 ]; then
		echo "SearXNG didn't start. Last lines of $LOG:" >&2
		tail -n 20 "$LOG" >&2
		exit 1
	fi
	sleep 1
done

count="$(curl -fs "http://127.0.0.1:$PORT/search?q=weather&format=json" |
	"$PYTHON" -c 'import json, sys; print(len(json.load(sys.stdin)["results"]))' || echo 0)"
echo "SearXNG is running on http://127.0.0.1:$PORT (test search: $count results, logs: $LOG)"

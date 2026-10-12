#!/bin/sh
# Pulls the latest main, rebuilds, and restarts the Scipio UI launch agent.
#
# Usage: deploy/update.sh
set -eu

LABEL=com.tlt.scipio-ui
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$APP_DIR"
git pull --ff-only
npm ci
PUBLIC_ADAPTER=docker-node npm run build
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Scipio UI updated to $(git log -1 --format='%h %s')"

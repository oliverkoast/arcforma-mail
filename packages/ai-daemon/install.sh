#!/bin/bash
# Installs the AI daemon as a LaunchAgent. Idempotent. Never runs the daemon as a child of this shell.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"
LABEL=ai.arcforma.ai-daemon
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" "$HERE/launchd/$LABEL.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "installed $LABEL with node=$NODE; log: ~/Library/Logs/arcforma-ai-daemon.log"

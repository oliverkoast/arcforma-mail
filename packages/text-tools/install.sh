#!/bin/bash
# Builds, installs to /Applications, and (re)starts the LaunchAgent.
#
# The app is never launched as a child of this shell: launchd owns it, so it
# survives the terminal closing and the TCC row points at a stable path.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Arcforma Text.app"
LABEL="ai.arcforma.text"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET="/Applications/$APP_NAME"

./build.sh

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -x ArcformaText 2>/dev/null || true
sleep 1

rm -rf "$TARGET"
cp -R "build/$APP_NAME" /Applications/

mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__HOME__|$HOME|g" launchagent/ai.arcforma.text.plist > "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $TARGET and started $LABEL via launchd."
echo "Grant Accessibility once: System Settings > Privacy & Security > Accessibility > Arcforma Text."
echo "Log: ~/Library/Logs/arcforma-text.log"

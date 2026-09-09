#!/bin/bash
# Build, pack, and install Arcforma Mail, waiting for the running copy to actually exit first.
#
# Replacing the bundle under a running process leaves that process with a code signature macOS can
# no longer validate, which makes safeStorage report the Keychain as unavailable and breaks every
# saved sign-in until the app is restarted. That happened. Hence the wait loop rather than a quit
# followed immediately by rm.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="Arcforma Mail.app"
BUILT="apps/desktop/release/mac-arm64/$APP"

( cd apps/desktop && pnpm --silent build && pnpm --silent run pack )
codesign --verify --deep --strict "$BUILT"

# A relaunch on the first launch after an install can put up a macOS Keychain dialog and park the
# app on it. Replacing the app while one is still unanswered stacks a second prompt on the first,
# and the person at the keyboard sees a frozen app and no reason. Wait for the click instead.
if pgrep -x SecurityAgent >/dev/null && pgrep -f "$APP/Contents/MacOS" >/dev/null; then
  echo "A Keychain dialog is waiting for Arcforma Mail. Click Always Allow on it, then run this again." >&2
  exit 2
fi

osascript -e 'tell application "Arcforma Mail" to quit' 2>/dev/null || true
for _ in $(seq 1 40); do
  pgrep -f "$APP/Contents/MacOS" >/dev/null || break
  sleep 0.5
done
if pgrep -f "$APP/Contents/MacOS" >/dev/null; then
  pkill -f "$APP/Contents/MacOS" || true
  for _ in $(seq 1 20); do
    pgrep -f "$APP/Contents/MacOS" >/dev/null || break
    sleep 0.5
  done
fi
if pgrep -f "$APP/Contents/MacOS" >/dev/null; then
  echo "Arcforma Mail is still running and will not exit. Not replacing it." >&2
  exit 1
fi

rm -rf "/Applications/$APP"
cp -R "$BUILT" /Applications/
codesign --verify --deep --strict "/Applications/$APP"
open -a "Arcforma Mail"
echo "installed and relaunched"

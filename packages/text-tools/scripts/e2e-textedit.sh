#!/bin/bash
# End-to-end check of Arcforma Text against TextEdit. A human runs this once
# Accessibility has been granted to "/Applications/Arcforma Text.app".
#
# What it proves, with a stub `claude` that returns one fixed sentence:
#   case 1: select "teh quick brwn fox" in a new TextEdit document, press Cmd+J,
#           and the document now reads the stub's corrected sentence.
#   case 2: with no selection, Cmd+J leaves the text alone and the log says
#           "Select text first".
#
# Prerequisites:
#   - The app is installed and running under launchd (install.sh).
#   - Accessibility is granted to Arcforma Text (System Settings > Privacy &
#     Security > Accessibility). Checked below via `--e2e-status`.
#   - The terminal running this script has Accessibility and Automation
#     rights for System Events (macOS asks on the first run).
#
# Idempotent: every defaults key it writes is deleted on exit, the launchd
# job is restarted afterwards so the real backend comes back, and the TextEdit
# documents it created are closed without saving.
set -uo pipefail
cd "$(dirname "$0")/.."

LABEL="ai.arcforma.text"
APP="/Applications/Arcforma Text.app"
BIN="$APP/Contents/MacOS/ArcformaText"
STUB="$PWD/scripts/claude-stub.sh"
LOG="$HOME/Library/Logs/arcforma-text.log"
DOMAIN="gui/$(id -u)/$LABEL"
INPUT="teh quick brwn fox"
PASS=0
FAIL=0
STARTED_DOCS=0

say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); say "ok    $*"; }
bad() { FAIL=$((FAIL + 1)); say "FAIL  $*"; }

kickstart() {
    launchctl kickstart -k "$DOMAIN" 2>/dev/null || launchctl kickstart "$DOMAIN" 2>/dev/null
}

wait_for_launch() {
    # The fresh process writes "launch" and then the hotkey line; wait for both.
    local before="$1" i
    for i in $(seq 1 50); do
        if tail -n +"$((before + 1))" "$LOG" 2>/dev/null | grep -q "hotkeys: fix"; then return 0; fi
        sleep 0.2
    done
    return 1
}

log_lines() { wc -l < "$LOG" 2>/dev/null | tr -d ' ' || echo 0; }
log_since() { tail -n +"$(($1 + 1))" "$LOG" 2>/dev/null; }

textedit_text() {
    osascript -e 'tell application "TextEdit" to get text of document 1' 2>/dev/null
}

cleanup() {
    say ""
    say "cleanup: restoring the real backend"
    defaults delete "$LABEL" claudeBin 2>/dev/null || true
    defaults delete "$LABEL" aiBackend 2>/dev/null || true
    if [ "$STARTED_DOCS" = "1" ]; then
        osascript -e 'tell application "TextEdit" to close every document saving no' >/dev/null 2>&1 || true
    fi
    local before
    before="$(log_lines)"
    kickstart
    wait_for_launch "$before" || say "warning: the app did not log a relaunch within 10 s"
    say ""
    if [ "$FAIL" -eq 0 ]; then
        say "PASS ($PASS checks)"
    else
        say "FAIL ($FAIL failed, $PASS passed)"
    fi
    say ""
    say "log tail ($LOG):"
    tail -n 40 "$LOG" 2>/dev/null | sed 's/^/  /'
    exit "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
}
trap cleanup EXIT

# --- preflight -------------------------------------------------------------

[ -x "$BIN" ] || { bad "app not installed at $APP (run install.sh)"; exit 1; }
[ -x "$STUB" ] || { bad "stub not executable: $STUB"; exit 1; }
launchctl print "$DOMAIN" >/dev/null 2>&1 || { bad "launchd job $LABEL not loaded (run install.sh)"; exit 1; }
command -v python3 >/dev/null || { bad "python3 is needed to parse the stub's JSON"; exit 1; }

EXPECTED="$("$STUB" -p x | python3 -c 'import sys, json; r = json.load(sys.stdin)["result"]; m = "<<ARCFORMA_END>>"; assert r.endswith(m), r; print(r[:-len(m)])')" \
    || { bad "stub did not produce valid JSON with the completion marker"; exit 1; }
ok "stub produces valid JSON; expected sentence: \"$EXPECTED\""

# TCC attributes a process started from a terminal to the terminal's own
# grant, so `--e2e-status` run here cannot answer for the app. The launchd-run
# app logs its own answer at every launch; restart it and read that line.
before="$(log_lines)"
kickstart
if ! wait_for_launch "$before"; then
    bad "app did not relaunch within 10 s"
    exit 1
fi
if log_since "$before" | grep -q "accessibility trusted$"; then
    ok "Accessibility is granted to the launchd-run app"
elif log_since "$before" | grep -q "accessibility not trusted"; then
    bad "Accessibility is not granted. Grant it in System Settings > Privacy & Security > Accessibility > Arcforma Text, then rerun."
    exit 1
else
    bad "could not find the app's accessibility line in the log after relaunch"
    exit 1
fi

# --- point the app at the stub ---------------------------------------------

defaults write "$LABEL" claudeBin "$STUB"
defaults write "$LABEL" aiBackend direct
before="$(log_lines)"
kickstart
if wait_for_launch "$before"; then
    ok "app relaunched with the stub backend"
else
    bad "app did not relaunch within 10 s"
    exit 1
fi
if log_since "$before" | grep -q "aiBackend=direct"; then
    ok "app logged the forced direct backend"
else
    bad "app did not log the forced direct backend"
fi
# The stub must be what the fresh process resolves.
if "$BIN" --e2e-status 2>/dev/null | grep -q "claude binary: $STUB installed=true"; then
    ok "app resolves claudeBin to the stub"
else
    bad "app does not resolve claudeBin to the stub"
    "$BIN" --e2e-status 2>/dev/null | sed 's/^/  /'
fi

# --- case 1: selection, Cmd+J, replaced ------------------------------------

say ""
say "case 1: fix a selection"
open -a TextEdit
sleep 1
osascript >/dev/null 2>&1 <<'APPLESCRIPT'
tell application "TextEdit"
    activate
    make new document
end tell
APPLESCRIPT
STARTED_DOCS=1
sleep 1
osascript -e "tell application \"System Events\" to keystroke \"$INPUT\"" >/dev/null 2>&1
sleep 0.5
osascript -e 'tell application "System Events" to keystroke "a" using command down' >/dev/null 2>&1
sleep 0.4
case1_before="$(log_lines)"
osascript -e 'tell application "System Events" to keystroke "j" using command down' >/dev/null 2>&1

result=""
for i in $(seq 1 40); do
    result="$(textedit_text)"
    [ "$result" = "$EXPECTED" ] && break
    sleep 0.2
done
if [ "$result" = "$EXPECTED" ]; then
    ok "document text equals the stub's corrected sentence"
else
    bad "document text is \"$result\", expected \"$EXPECTED\""
fi
if log_since "$case1_before" | grep -q "fix: Done"; then
    ok "log shows fix: Done"
else
    bad "log does not show fix: Done"
fi
if log_since "$case1_before" | grep -q "timing text.fix: capture"; then
    ok "log carries the timing line"
    log_since "$case1_before" | grep "timing text.fix" | tail -n 1 | sed 's/^/  /'
else
    bad "log has no timing line"
fi

# --- case 2: no selection, Cmd+J, unchanged --------------------------------

say ""
say "case 2: no selection"
osascript -e 'tell application "TextEdit" to activate' >/dev/null 2>&1
sleep 0.5
# Cmd+Right collapses the selection to the end of the line.
osascript -e 'tell application "System Events" to key code 124 using command down' >/dev/null 2>&1
sleep 0.4
text_before="$(textedit_text)"
case2_before="$(log_lines)"
osascript -e 'tell application "System Events" to keystroke "j" using command down' >/dev/null 2>&1
found=0
for i in $(seq 1 25); do
    if log_since "$case2_before" | grep -q "Select text first"; then found=1; break; fi
    sleep 0.2
done
sleep 0.5
text_after="$(textedit_text)"
if [ "$found" = "1" ]; then
    ok "log shows Select text first"
else
    bad "log does not show Select text first within 5 s"
fi
if [ "$text_after" = "$text_before" ]; then
    ok "document text unchanged with no selection"
else
    bad "document text changed with no selection: \"$text_after\""
fi
if log_since "$case2_before" | grep -q "fix: Done"; then
    bad "a replacement happened with no selection"
else
    ok "no replacement logged with no selection"
fi

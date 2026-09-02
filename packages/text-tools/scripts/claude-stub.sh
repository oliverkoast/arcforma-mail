#!/bin/bash
# Stub `claude` for the e2e harness. Answers every `-p` call with one fixed
# corrected sentence plus the completion marker, in the same JSON shape as
# `claude -p --output-format json`. It never talks to a model, so the harness
# proves the capture, verify, and paste path without a Claude login.
#
# Wire it in with:
#   defaults write ai.arcforma.text claudeBin "$PWD/scripts/claude-stub.sh"
#   defaults write ai.arcforma.text aiBackend direct
# and remove both keys afterwards (e2e-textedit.sh does this on exit).
SENTENCE="The quick brown fox."
if [ "${1:-}" = "--version" ]; then
    echo "arcforma-claude-stub 0.0.1"
    exit 0
fi
printf '{"type":"result","is_error":false,"result":"%s<<ARCFORMA_END>>","session_id":"stub"}\n' "$SENTENCE"

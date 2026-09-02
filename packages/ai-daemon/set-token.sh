#!/bin/bash
# Stores a long-lived Claude Code token for the daemon. Run `claude setup-token` first, copy the
# token it prints, then run this script and paste it at the prompt (input is hidden). The token
# lands in ai-daemon.json (mode 600) and the daemon restarts.
set -euo pipefail
CFG="$HOME/Library/Application Support/Arcforma/ai-daemon.json"
[ -f "$CFG" ] || { echo "daemon config not found at $CFG; run install.sh first"; exit 1; }
read -r -s -p "Paste the token from claude setup-token: " TOKEN; echo
[ -n "$TOKEN" ] || { echo "empty token"; exit 1; }
TOKEN="$TOKEN" python3 - "$CFG" <<'PY'
import json, os, sys
p = sys.argv[1]; j = json.load(open(p)); j["claudeOAuthToken"] = os.environ["TOKEN"].strip()
json.dump(j, open(p, "w"), indent=2); os.chmod(p, 0o600)
PY
launchctl kickstart -k "gui/$(id -u)/ai.arcforma.ai-daemon"
sleep 3; tail -1 "$HOME/Library/Logs/arcforma-ai-daemon.log"

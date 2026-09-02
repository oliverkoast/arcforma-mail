#!/bin/bash
# The whole verification matrix. Exit non-zero on any failure. Run from the repo root.
set -uo pipefail
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use 24 >/dev/null
fail=0
step() { printf '\n== %s\n' "$1"; }
run() { if "$@" >/dev/null 2>&1; then echo "   ok"; else echo "   FAILED: $*"; fail=1; fi; }

step "brand sync"; run node scripts/sync-brand.mjs
step "unit and fixture tests (all packages)"; run pnpm -r --silent test
step "typecheck"; run pnpm -r --silent typecheck
step "brand check"; run node scripts/brand-check.mjs
step "voice sweep (no em dashes or emojis in source, prompts, or UI strings)"
if grep -rnP --include='*.{ts,tsx,mjs,swift,md,css,sql}' '[\x{2014}\x{2013}\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' apps packages/ai-core packages/ai-daemon packages/gmail packages/store packages/text-tools/Sources docs qa README.md 2>/dev/null | grep -v node_modules | grep -v '/brand/' | head -5 | grep .; then echo "   FAILED"; fail=1; else echo "   ok"; fi
step "renderer build"; run pnpm --filter desktop --silent build
step "Arcforma Text build and self-test"
if (cd packages/text-tools && ./build.sh >/dev/null 2>&1 && "./build/Arcforma Text.app/Contents/MacOS/ArcformaText" --selftest 2>&1 | grep -qi "all self-tests passed"); then echo "   ok"; else echo "   FAILED (run packages/text-tools/build.sh and the --selftest flag to see why)"; fail=1; fi
step "AI daemon health"
CFG="$HOME/Library/Application Support/Arcforma/ai-daemon.json"
if [ -f "$CFG" ]; then PORT=$(python3 -c "import json;print(json.load(open('$CFG'))['port'])"); curl -sf "http://127.0.0.1:$PORT/v1/health" | python3 -c 'import json,sys; j=json.load(sys.stdin); print("   claude:",j["claude"],"local:",j["local"],"cli:",j["cliVersion"])' || { echo "   daemon not answering"; fail=1; }; else echo "   not installed (packages/ai-daemon/install.sh)"; fi
step "Claude login as the daemon sees it"
if [ -f "$CFG" ]; then curl -sf "http://127.0.0.1:$PORT/v1/health" | python3 -c 'import json,sys; j=json.load(sys.stdin); print("   loggedIn:",j["loggedIn"],"source:",j.get("authSource"),"(config_token from claude setup-token is the durable one)")'; fi
step "Arcforma Text install state"
launchctl print "gui/$(id -u)/ai.arcforma.text" >/dev/null 2>&1 && echo "   launchd job present" || echo "   not installed (packages/text-tools/install.sh)"
echo; [ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }

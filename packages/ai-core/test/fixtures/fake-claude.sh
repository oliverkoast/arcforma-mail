#!/bin/bash
# Stand-in for the claude CLI. Behaviour is driven by FAKE_CLAUDE_MODE.
if [ "$1" = "auth" ]; then
  if [ "${FAKE_CLAUDE_MODE:-ok}" = "keychainstale" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then echo '{"loggedIn":false,"authMethod":"none"}'; else echo '{"loggedIn":true,"email":"test@example.com","authMethod":"'"${CLAUDE_CODE_OAUTH_TOKEN:+oauth_token}"'"}'; fi; exit 0; fi
if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi
# Collect args
prompt=""; model=""; system=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2;;
    --model) model="$2"; shift 2;;
    --system-prompt) system="$2"; shift 2;;
    *) shift;;
  esac
done
# stdin must be closed by the caller; if it is a pipe with no data we would hang, so read with a timeout to detect misuse.
if [ ! -t 0 ] && read -t 0.2 -r _line; then echo "stdin had data" >&2; fi
case "${FAKE_CLAUDE_MODE:-ok}" in
  keychainstale)
    if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then printf '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}\n'; else printf '{"type":"result","is_error":false,"result":"token-ok<<ARCFORMA_END>>"}\n'; fi;;
  ok)
    marker=""; [[ "$system" == *"<<ARCFORMA_END>>"* ]] && marker="<<ARCFORMA_END>>"
    printf '{"type":"result","is_error":false,"result":"fixed:%s%s","duration_api_ms":12,"modelUsage":{"%s":{}}}\n' "$(echo "$prompt" | tr -d '"\\' | head -c 30)" "$marker" "$model";;
  loggedout) printf '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}\n';;
  unsupported)
    if [ "$model" = "claude-fable-5-1" ]; then printf '{"type":"result","is_error":true,"result":"API Error: 400 model does not support this model"}\n';
    else printf '{"type":"result","is_error":false,"result":"ok-from-%s<<ARCFORMA_END>>","modelUsage":{"%s":{}}}\n' "$model" "$model"; fi;;
  limited)
    if [ "$model" = "claude-fable-5-1" ]; then printf '{"type":"result","is_error":true,"result":"You'"'"'ve reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage to continue."}\n';
    else printf '{"type":"result","is_error":false,"result":"answered-by-%s<<ARCFORMA_END>>","modelUsage":{"%s":{}}}\n' "$model" "$model"; fi;;
  truncated) printf '{"type":"result","is_error":false,"result":"half a sen"}\n';;
  slow) sleep 5; printf '{"type":"result","result":"late"}\n';;
  warn) echo "Warning: something on stdout"; printf '{"type":"result","is_error":false,"result":"after warning<<ARCFORMA_END>>"}\n';;
esac

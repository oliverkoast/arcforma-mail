# Arcforma AI daemon

One local process that both Arcforma Mail and Arcforma Text call for AI. It runs Claude through the machine's Claude Code login (`claude -p`, no key needed) or an Anthropic API key, and a local llama.cpp model for background classification.

Prerequisite: a Claude Code login the CLI can see from a clean environment, or an Anthropic API key. Four sources, in the order the daemon tries them:

1. `claudeOAuthToken` in `ai-daemon.json`: a long-lived token from `claude setup-token`, stored with `./set-token.sh`. Durable; use this.
2. `claudeApiKey` in `ai-daemon.json`: an Anthropic key, passed to the CLI as `ANTHROPIC_API_KEY`. Billed per request rather than against a subscription. `claude auth status` answers about the subscription login only, so a configured key is reported as signed in without asking it and is proved by the first completion. The mail app's setup flow writes this.
3. `~/.claude/.credentials.json`, written by `claude auth login`. Used automatically when the keychain login is stale, but its access token expires in hours and the daemon cannot refresh it.
4. The keychain item the CLI keeps itself.

Seen 2026-09-02: the keychain held an expired credential, the CLI reported "not logged in" from a clean environment, and three `claude auth login` runs only refreshed the file. Source 1 is the fix. A Claude Code session's own environment must not leak into the daemon, which is why the LaunchAgent sets a minimal PATH and HOME.

Config: `~/Library/Application Support/Arcforma/ai-daemon.json` (created on first run with a random bearer token; the chosen port is written back). Clients read `port` and `token` from it.

Routing: `routes` in the config sends a task to the local model regardless of the caller's prompt. Default: `text.fix` (Cmd+J grammar fix) goes to Qwen3-4B for selections up to 1500 characters with the library prompt `grammar_fix_local`, temperature 0, and three sanity checks (finished cleanly, length within 0.6 to 1.6 of the input, no dashes); anything that fails goes to Claude instead. Measured 2026-09-02: 300 to 900 ms per fix against 4.4 s on Claude. The model stays loaded for `local.idleMinutes` (default 120) and is warmed at daemon start. Instruction edits (`text.instruct`) stay on Claude.

Endpoints (127.0.0.1 only, `Authorization: Bearer <token>` except health):
- `GET /v1/health` -> `{ok, claude: ok|signed_out, loggedIn, email, cliVersion, model, local: ok|loading|idle|missing, inFlight}`
- `POST /v1/complete` `{task?, system?, user, vars?, model?, maxTokens?, timeoutMs?, requestId?, allowedTools?, json?}` -> `{ok, text, json?, model, latencyMs, engine}` or `{ok:false, code, error}` with 503 for `not_logged_in`, 504 for `timeout`, 499 for `cancelled`
- `DELETE /v1/complete/<requestId>` cancels an in-flight call
- `POST /v1/classify` `{text, schema?, vars?}` -> local model JSON
- `GET /v1/tasks` lists prompt library tasks

Install: `./install.sh` (LaunchAgent, KeepAlive on crash, clean exit stays down). Logs: `~/Library/Logs/arcforma-ai-daemon.log`.

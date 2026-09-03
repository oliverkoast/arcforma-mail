/**
 * Claude through the Claude Code login, or an Anthropic API key when one is
 * configured. The login is the default and needs no key; the key exists for
 * people who have no Claude subscription, and onboarding writes it.
 *
 * Runs `claude -p` as a subprocess, one turn, JSON output, no tools. Pattern
 * lifted from aeo-check/bridge/claude-bridge.mjs with two fixes learned on
 * 2026-09-01: stdin must be closed (the CLI waits three seconds for piped
 * input otherwise), and `--bare` must not be used (it skips the keychain
 * read and reports "Not logged in").
 *
 * The environment passed to the child is deliberately minimal. A child that
 * inherits a Claude Code session's variables authenticates through that
 * session instead of the machine's own login, which hides a missing login
 * until the LaunchAgent runs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MODEL_CHAIN = ["claude-fable-5-1", "opus", "sonnet"];

export function childEnv(extra = {}) {
  const home = process.env.HOME ?? os.homedir();
  return {
    HOME: home,
    PATH: [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    LANG: "en_US.UTF-8",
    ...extra,
  };
}

/**
 * The CLI reads the keychain first and, when the item there is stale, reports "not logged in"
 * even though `claude auth login` wrote a fresh credential to ~/.claude/.credentials.json
 * (seen on 2026-09-02). Passing that token as CLAUDE_CODE_OAUTH_TOKEN is the documented
 * headless path and sidesteps the keychain entirely. A long-lived token from
 * `claude setup-token` (config `claudeOAuthToken`) is preferred; the file is the fallback.
 * @returns {string|null}
 */
export function credentialsFileToken(file = path.join(os.homedir(), ".claude", ".credentials.json")) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"))?.claudeAiOauth;
    if (!o?.accessToken) return null;
    if (o.expiresAt && o.expiresAt - Date.now() < 5 * 60 * 1000) return null;
    return o.accessToken;
  } catch { return null; }
}

export class ClaudeRunner {
  /**
   * @param {{bin?: string, modelChain?: string[], timeoutMs?: number, concurrency?: number, env?: Record<string,string>, oauthToken?: string, apiKey?: string, credentialsFile?: string}} [opts]
   */
  constructor(opts = {}) {
    this.oauthToken = opts.oauthToken ?? null;
    this.apiKey = opts.apiKey ?? null;
    this.credentialsFile = opts.credentialsFile;
    this.bin = opts.bin ?? process.env.ARCFORMA_CLAUDE_BIN ?? `${os.homedir()}/.local/bin/claude`;
    this.modelChain = opts.modelChain ?? DEFAULT_MODEL_CHAIN;
    this.modelIndex = 0;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.baseEnv = childEnv(opts.env);
    this.authSource = "keychain";
    this.inFlight = 0;
    this.queue = [];
    this.children = new Map(); // requestId -> child
    this.authOkUntil = 0;
    this.authCache = null;
    this.retryPreferredAt = 0;
  }

  get model() { return this.modelChain[this.modelIndex]; }

  /** Environment for a child: keychain login by default, explicit token when the keychain is stale, an API key when one is configured. */
  get env() {
    if (this.oauthToken) { this.authSource = "config_token"; return { ...this.baseEnv, CLAUDE_CODE_OAUTH_TOKEN: this.oauthToken }; }
    // An API key is a credential of its own: the CLI bills it instead of a subscription login.
    if (this.apiKey) { this.authSource = "api_key"; return { ...this.baseEnv, ANTHROPIC_API_KEY: this.apiKey }; }
    if (this.authSource === "file_token") {
      const t = credentialsFileToken(this.credentialsFile);
      if (t) return { ...this.baseEnv, CLAUDE_CODE_OAUTH_TOKEN: t };
      this.authSource = "keychain";
    }
    return this.baseEnv;
  }

  /**
   * `claude auth status` as JSON, cached for a minute when positive.
   *
   * An API key is reported as signed in without asking the CLI: `auth status`
   * answers about the subscription login only, so a machine with a key and no
   * login would otherwise show the "sign in to Claude Code" eyebrow while every
   * request worked. The key itself is proved by the first completion, whose
   * failure comes back as a plain claude_error.
   */
  async authStatus() {
    if (this.apiKey) return { loggedIn: true, email: null, authSource: "api_key", raw: null };
    if (Date.now() < this.authOkUntil && this.authCache) return this.authCache;
    let status = await this._authOnce();
    if (!status.loggedIn && !this.oauthToken && this.authSource !== "file_token" && credentialsFileToken(this.credentialsFile)) {
      // Keychain says no but a fresh credentials file exists: switch to it and ask again.
      this.authSource = "file_token";
      status = await this._authOnce();
      if (!status.loggedIn) this.authSource = "keychain";
    }
    if (status.loggedIn) { this.authOkUntil = Date.now() + 60_000; this.authCache = status; }
    return status;
  }

  async _authOnce() {
    const r = await this._exec(["auth", "status"], 10_000);
    let parsed = null;
    try { parsed = JSON.parse(r.out); } catch {}
    return { loggedIn: Boolean(parsed?.loggedIn), email: parsed?.email ?? null, authSource: this.authSource, raw: parsed };
  }

  async version() {
    const r = await this._exec(["--version"], 10_000);
    return r.out.trim() || null;
  }

  /**
   * One completion. Resolves {ok, text, model, latencyMs} or {ok:false, code, error}.
   * @param {{system: string, user: string, model?: string, timeoutMs?: number, requestId?: string, allowedTools?: string[], maxTurns?: number}} req
   */
  complete(req) {
    return new Promise((resolve) => {
      this.queue.push({ req, resolve });
      this._pump();
    });
  }

  cancel(requestId) {
    const child = this.children.get(requestId);
    if (!child) return false;
    child.cancelled = true;
    killTree(child);
    return true;
  }

  _pump() {
    while (this.inFlight < this.concurrency && this.queue.length) {
      const { req, resolve } = this.queue.shift();
      this.inFlight++;
      this._run(req)
        .then(resolve, (e) => resolve({ ok: false, code: "internal", error: String(e).slice(0, 500) }))
        .finally(() => { this.inFlight--; this._pump(); });
    }
  }

  async _run(req) {
    const started = Date.now();
    // A model the CLI cannot run, or one whose plan allowance is spent, both mean "ask the next
    // model in the chain" rather than "fail". A spent allowance is temporary, so the chain resets
    // after a cooling period and the preferred model gets tried again.
    if (this.modelIndex > 0 && this.retryPreferredAt && Date.now() > this.retryPreferredAt) {
      this.modelIndex = 0;
      this.retryPreferredAt = 0;
    }
    let model = req.model ?? this.model;
    for (;;) {
      const r = await this._once(req, model);
      const stepDown = !req.model && this.modelIndex < this.modelChain.length - 1 && (isUnsupported(r.error) || isOutOfAllowance(r.error));
      if (!r.ok && stepDown) {
        if (isOutOfAllowance(r.error)) this.retryPreferredAt = Date.now() + 30 * 60_000;
        this.modelIndex++;
        model = this.model;
        continue;
      }
      return { ...r, model, latencyMs: Date.now() - started, code: r.ok ? undefined : outOfAllowanceCode(r) };
    }
  }

  _once(req, model) {
    const args = [
      "-p", req.user,
      "--model", model,
      "--system-prompt", req.system,
      "--output-format", "json",
      "--max-turns", String(req.maxTurns ?? 1),
      "--no-session-persistence",
    ];
    if (req.allowedTools?.length) args.push("--allowedTools", req.allowedTools.join(","));
    else args.push("--disallowedTools", "*");
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], env: this.env, detached: true });
      if (req.requestId) this.children.set(req.requestId, child);
      let out = "", err = "";
      const timer = setTimeout(() => { child.timedOut = true; killTree(child); }, req.timeoutMs ?? this.timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => { clearTimeout(timer); done({ ok: false, code: "spawn", error: String(e).slice(0, 500) }); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (child.cancelled) return done({ ok: false, code: "cancelled", error: "cancelled" });
        if (child.timedOut) return done({ ok: false, code: "timeout", error: "claude timed out" });
        done(parseResult(out, err, code));
      });
      const done = (r) => { if (req.requestId) this.children.delete(req.requestId); resolve(r); };
    });
  }

  _exec(args, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], env: this.env });
      let out = "", err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => { clearTimeout(timer); resolve({ out, err, code }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ out: "", err: String(e), code: -1 }); });
    });
  }
}

export function isUnsupported(error) {
  return /does not support this model/i.test(String(error ?? ""));
}

/** The plan's allowance for that model is spent. Temporary, and another model may still answer. */
export function isOutOfAllowance(error) {
  return /(reached|exceeded) your .{0,30}limit|usage limit|out of (credits|usage)|rate.?limit/i.test(String(error ?? ""));
}

function outOfAllowanceCode(r) {
  return isOutOfAllowance(r.error) ? "out_of_allowance" : r.code;
}

/** Kill the child and everything it spawned. Children run detached so they own a process group. */
export function killTree(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

/** Parse the `--output-format json` envelope into a normalized result. */
export function parseResult(out, err, code) {
  let ev = null;
  try { ev = JSON.parse(out); } catch {
    // The CLI can prefix warnings on stdout; take the last JSON object line.
    const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
    for (const line of lines.reverse()) { try { ev = JSON.parse(line); break; } catch {} }
  }
  if (!ev) return { ok: false, code: "no_output", error: `claude exited ${code}: ${(err || out).slice(0, 300)}` };
  const text = typeof ev.result === "string" ? ev.result : "";
  if (ev.is_error) {
    const msg = text || "claude returned is_error with no message";
    const codeName = /not logged in/i.test(msg) ? "not_logged_in" : /does not support this model/i.test(msg) ? "model_unsupported" : "claude_error";
    return { ok: false, code: codeName, error: msg.slice(0, 500) };
  }
  if (!text && code !== 0) return { ok: false, code: "exit", error: `claude exited ${code}: ${err.slice(0, 300)}` };
  const usedModel = ev.modelUsage && Object.keys(ev.modelUsage)[0];
  return { ok: true, text, usedModel: usedModel ?? null, apiMs: ev.duration_api_ms ?? null };
}

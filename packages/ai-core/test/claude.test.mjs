import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner, parseResult } from "../src/claude.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.sh");
const runner = (mode, opts = {}) => new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: mode }, ...opts });

test("parseResult handles success, error kinds, and stdout warnings", () => {
  assert.equal(parseResult('{"result":"hi","is_error":false,"modelUsage":{"m":{}}}', "", 0).text, "hi");
  assert.equal(parseResult('{"result":"Not logged in · Please run /login","is_error":true}', "", 0).code, "not_logged_in");
  assert.equal(parseResult('{"result":"x does not support this model","is_error":true}', "", 0).code, "model_unsupported");
  assert.equal(parseResult('Warning: junk\n{"result":"ok"}', "", 0).text, "ok");
  assert.equal(parseResult("", "boom", 1).code, "no_output");
});

test("completes with the fake CLI and reports the model", async () => {
  const r = await runner("ok").complete({ system: "s", user: "hello" });
  assert.equal(r.ok, true);
  assert.match(r.text, /^fixed:hello/);
  assert.equal(r.model, "claude-fable-5-1");
  assert.ok(r.latencyMs >= 0);
});

test("auth status is parsed and cached", async () => {
  const c = runner("ok");
  const a = await c.authStatus();
  assert.equal(a.loggedIn, true);
  assert.equal(a.email, "test@example.com");
  assert.ok(c.authOkUntil > Date.now());
});

test("not logged in surfaces as a typed code", async () => {
  const r = await runner("loggedout").complete({ system: "s", user: "u" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_logged_in");
});

test("model chain steps down on an unsupported model", async () => {
  const c = runner("unsupported");
  const r = await c.complete({ system: "s", user: "u" });
  assert.equal(r.ok, true);
  assert.equal(r.model, "opus");
  assert.equal(c.model, "opus", "runner remembers the working model");
});

test("timeout kills the child and reports timeout", async () => {
  const r = await runner("slow").complete({ system: "s", user: "u", timeoutMs: 300 });
  assert.equal(r.code, "timeout");
});

test("cancel by requestId", async () => {
  const c = runner("slow");
  const p = c.complete({ system: "s", user: "u", requestId: "r1" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.cancel("r1"), true);
  const r = await p;
  assert.equal(r.code, "cancelled");
});

test("concurrency gate queues extra requests", async () => {
  const c = runner("ok", { concurrency: 1 });
  const ps = [1, 2, 3].map((i) => c.complete({ system: "s", user: `u${i}` }));
  assert.ok(c.queue.length >= 1, "second and third wait in the queue");
  const rs = await Promise.all(ps);
  assert.ok(rs.every((r) => r.ok));
});

test("falls back to the credentials file token when the keychain login is stale", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const file = path.join(os.tmpdir(), `creds-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "tok123", refreshToken: "r", expiresAt: Date.now() + 3600_000 } }));
  const c = new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: "keychainstale" }, credentialsFile: file });
  const a = await c.authStatus();
  assert.equal(a.loggedIn, true);
  assert.equal(c.authSource, "file_token");
  const r = await c.complete({ system: "s", user: "u" });
  assert.equal(r.ok, true);
  assert.match(r.text, /token-ok/);
  fs.unlinkSync(file);
});

test("an expired credentials file is ignored", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const file = path.join(os.tmpdir(), `creds-exp-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: Date.now() - 1000 } }));
  const c = new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: "keychainstale" }, credentialsFile: file });
  assert.equal((await c.authStatus()).loggedIn, false);
  assert.equal(c.authSource, "keychain");
  fs.unlinkSync(file);
});

test("a configured long-lived token wins", async () => {
  const c = new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: "keychainstale" }, oauthToken: "long" });
  assert.equal((await c.authStatus()).loggedIn, true);
  assert.equal(c.authSource, "config_token");
});

test("a spent model allowance falls back down the chain and retries the preferred model later", async () => {
  const { isOutOfAllowance } = await import("../src/claude.mjs");
  assert.equal(isOutOfAllowance("You've reached your Fable limit. Switch to another model"), true);
  assert.equal(isOutOfAllowance("exceeded your usage limit for today"), true);
  assert.equal(isOutOfAllowance("something else entirely"), false);
  const c = runner("limited");
  const r = await c.complete({ system: "s", user: "u" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.model, "opus");
  assert.ok(c.retryPreferredAt > Date.now(), "the preferred model is tried again after a cooling period");
  c.retryPreferredAt = Date.now() - 1;
  await c.complete({ system: "s", user: "u" });
  assert.equal(c.modelIndex, 1, "it steps down again while the allowance is still spent");
});

test("an Anthropic API key becomes the child's credential and is reported as signed in without asking the CLI", async () => {
  const c = runner("signed_out", { apiKey: "sk-ant-example" });
  assert.equal(c.env.ANTHROPIC_API_KEY, "sk-ant-example");
  assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "a key and a login token are never sent together");
  assert.equal(c.authSource, "api_key");
  // `claude auth status` answers about the subscription login only, so a key is not put to it.
  const a = await c.authStatus();
  assert.equal(a.loggedIn, true);
  assert.equal(a.authSource, "api_key");
});

test("a configured login token still wins over an API key, and neither leaks into a plain run", async () => {
  const withToken = runner("ok", { oauthToken: "a-long-lived-token", apiKey: "sk-ant-example" });
  assert.equal(withToken.env.CLAUDE_CODE_OAUTH_TOKEN, "a-long-lived-token");
  assert.equal(withToken.env.ANTHROPIC_API_KEY, undefined);
  const plain = runner("ok");
  assert.equal(plain.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(plain.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

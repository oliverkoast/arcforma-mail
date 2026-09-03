import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyAiChoice, daemonConfigView, patchDaemonConfig, pointDaemonAtModel, readAccessibility } from "./environment.js";

function tempConfig(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-daemon-")), "ai-daemon.json");
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const mode = (file: string) => fs.statSync(file).mode & 0o777;

test("each AI choice writes only its own credential and clears the other, at 0600", () => {
  const file = tempConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ port: 51234, token: "keep-me", local: { threads: 4 } }));

  applyAiChoice("claude-code", "a-long-lived-token", file);
  let cfg = read(file);
  assert.equal(cfg["claudeOAuthToken"], "a-long-lived-token");
  assert.equal(cfg["claudeApiKey"], "");
  assert.equal(cfg["port"], 51234, "the daemon's own port and token are left alone");
  assert.equal(cfg["token"], "keep-me");
  assert.deepEqual(cfg["local"], { threads: 4 });
  assert.equal(mode(file), 0o600);

  applyAiChoice("api-key", "sk-ant-example", file);
  cfg = read(file);
  assert.equal(cfg["claudeApiKey"], "sk-ant-example");
  assert.equal(cfg["claudeOAuthToken"], "", "switching to a key drops the token rather than leaving both");

  applyAiChoice("local", "", file);
  cfg = read(file);
  assert.equal(cfg["claudeApiKey"], "");
  assert.equal(cfg["claudeOAuthToken"], "", "local only leaves no secret behind");
});

test("a missing config is created rather than refused, and a nested patch merges instead of replacing", () => {
  const file = tempConfig();
  assert.equal(fs.existsSync(file), false);
  patchDaemonConfig({ local: { model: "/tmp/a.gguf", threads: 8 } }, file);
  assert.deepEqual(read(file)["local"], { model: "/tmp/a.gguf", threads: 8 });
  assert.equal(mode(file), 0o600);

  pointDaemonAtModel("/tmp/b.gguf", file);
  assert.deepEqual(read(file)["local"], { model: "/tmp/b.gguf", threads: 8 }, "the model changes and the rest of local survives");
});

test("the config view reports what is stored and what is on disk without handing back a secret", () => {
  const file = tempConfig();
  const model = path.join(path.dirname(file), "present.gguf");
  fs.writeFileSync(model, "gguf");
  fs.writeFileSync(file, JSON.stringify({ claudeOAuthToken: "a-token", claudeApiKey: "", local: { binary: "/nowhere/llama-server", model } }), { mode: 0o600 });

  const view = daemonConfigView(file);
  assert.equal(view.present, true);
  assert.equal(view.hasClaudeToken, true);
  assert.equal(view.hasApiKey, false);
  assert.equal(view.localModel, model);
  assert.equal(view.localModelPresent, true);
  assert.equal(view.localBinary, "/nowhere/llama-server");
  assert.equal(view.localBinaryPresent, false);
  assert.equal(JSON.stringify(view).includes("a-token"), false, "the token itself is never part of the view");

  const missing = daemonConfigView(path.join(path.dirname(file), "gone.json"));
  assert.equal(missing.present, false);
  assert.equal(missing.hasClaudeToken, false);
});

test("the Accessibility grant is read from the newest line Arcforma Text wrote about it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-textlog-"));
  const log = path.join(dir, "arcforma-text.log");

  assert.deepEqual(readAccessibility(log), { state: "unknown", at: null }, "no log means nothing is known, not that it was denied");

  fs.writeFileSync(log, "[2026-09-02T10:00:00Z] INFO  launch ai.arcforma.text\n[2026-09-02T10:00:01Z] INFO  accessibility not trusted, prompt requested\n");
  const denied = readAccessibility(log);
  assert.equal(denied.state, "not_granted");
  assert.equal(denied.at, Date.parse("2026-09-02T10:00:01Z"));

  // A later launch after the grant: the newest line wins over the older refusal.
  fs.appendFileSync(log, "[2026-09-02T10:05:00Z] INFO  accessibility trusted\n");
  assert.equal(readAccessibility(log).state, "granted");

  // A log with nothing about the grant is unknown rather than granted.
  fs.writeFileSync(log, "[2026-09-02T10:00:00Z] INFO  launch ai.arcforma.text\n");
  assert.equal(readAccessibility(log).state, "unknown");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiService } from "../src/service.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.sh");
const svc = (mode) => new AiService({ claude: { bin: FAKE, env: { FAKE_CLAUDE_MODE: mode } } });

test("status reports claude ok and local missing", async () => {
  const s = await svc("ok").status();
  assert.equal(s.claude, "ok");
  assert.equal(s.local, "missing");
  assert.equal(s.cliVersion, "9.9.9 (fake)");
});

test("grammar_fix task renders the prompt and strips the marker", async () => {
  const r = await svc("ok").complete({ task: "grammar_fix", user: JSON.stringify({ selectedText: "teh cat" }) });
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes("<<ARCFORMA_END>>"));
  assert.match(r.text, /^fixed:/);
});

test("a truncated answer fails closed", async () => {
  const r = await svc("truncated").complete({ task: "grammar_fix", user: "{}" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "incomplete");
});

test("a warning line before the JSON is tolerated", async () => {
  const r = await svc("warn").complete({ task: "grammar_fix", user: "{}" });
  assert.equal(r.ok, true);
  assert.equal(r.text, "after warning");
});

test("local task without a configured model returns local_missing", async () => {
  const r = await svc("ok").classifyLocal({ text: "hi", vars: { categories: "", examples: "" } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "local_missing");
});

test("unknown task is a typed error", async () => {
  await assert.rejects(() => svc("ok").complete({ task: "nope", user: "" }), /unknown task/);
});

test("a caller-supplied system prompt makes task a label, not a library lookup", async () => {
  const r = await svc("ok").complete({ task: "text.fix", system: "You fix text.", user: "hi" });
  assert.equal(r.ok, true);
  assert.match(r.text, /^fixed:hi/);
});

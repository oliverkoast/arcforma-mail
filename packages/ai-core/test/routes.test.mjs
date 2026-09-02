import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiService, unwrapLocal } from "../src/service.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.sh");

/** A service whose local model is a stub returning `answer` (or throwing). */
function svcWithLocal(answer, { finish = "stop", claudeMode = "ok" } = {}) {
  const s = new AiService({ claude: { bin: FAKE, env: { FAKE_CLAUDE_MODE: claudeMode } } });
  s.local = {
    configured: true, cfg: { model: "stub.gguf" }, status: () => "ok", stop() {}, ensure: async () => "stub",
    complete: async () => { if (answer instanceof Error) throw answer; return { text: answer, model: "stub", latencyMs: 5, finish }; },
  };
  return s;
}
const fixReq = (text) => ({ task: "text.fix", system: "caller prompt with <<ARCFORMA_END>>", user: JSON.stringify({ selectedText: text }) });

test("text.fix goes to the local model and carries the caller's marker", async () => {
  const r = await svcWithLocal("The cat sat.").complete(fixReq("teh cat sat"));
  assert.equal(r.engine, "local");
  assert.equal(r.text, "The cat sat.<<ARCFORMA_END>>");
});

test("long selections skip the local model and use Claude", async () => {
  const r = await svcWithLocal("short").complete(fixReq("x".repeat(2000)));
  assert.equal(r.engine, "claude");
});

test("a truncated, empty, or wildly resized local answer falls back to Claude", async () => {
  for (const [answer, opts] of [["half", { finish: "length" }], ["", {}], ["way too long ".repeat(20), {}], ["x", {}]]) {
    const r = await svcWithLocal(answer, opts).complete(fixReq("a sentence of ordinary length here"));
    assert.equal(r.engine, "claude", `answer ${JSON.stringify(answer).slice(0, 20)}`);
  }
});

test("a local answer containing an em dash falls back to Claude", async () => {
  const r = await svcWithLocal("The cat — sat.").complete(fixReq("the cat sat"));
  assert.equal(r.engine, "claude");
});

test("a local model error falls back to Claude", async () => {
  const r = await svcWithLocal(new Error("boom")).complete(fixReq("the cat sat"));
  assert.equal(r.engine, "claude");
});

test("a non-envelope user message is not routed locally", async () => {
  const r = await svcWithLocal("nope").complete({ task: "text.fix", system: "s", user: "plain text" });
  assert.equal(r.engine, "claude");
});

test("an explicit model request bypasses the route", async () => {
  const r = await svcWithLocal("nope").complete({ ...fixReq("the cat sat"), model: "sonnet" });
  assert.equal(r.engine, "claude");
});

test("unwrapLocal strips fences, labels, and wrapping quotes", () => {
  assert.equal(unwrapLocal("```\nHi.\n```"), "Hi.");
  assert.equal(unwrapLocal("Corrected text: Hi."), "Hi.");
  assert.equal(unwrapLocal('"Hi."'), "Hi.");
  assert.equal(unwrapLocal('He said "hi" and "bye"'), 'He said "hi" and "bye"');
});

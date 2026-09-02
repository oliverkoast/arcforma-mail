import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPrompt, parsePrompt, render, extractMarked, listTasks, voiceRules } from "../src/prompts.mjs";

test("every prompt parses and declares an engine", () => {
  const tasks = listTasks();
  assert.ok(tasks.includes("grammar_fix") && tasks.includes("classify"));
  for (const t of tasks) {
    const { meta, body } = loadPrompt(t);
    assert.ok(["claude", "local"].includes(meta.engine), `${t} engine`);
    assert.ok(body.length > 40, `${t} body`);
    assert.ok(!/—|–/.test(body), `${t} contains a dash character`);
  }
});

test("front matter parsing", () => {
  const { meta, body } = parsePrompt('---\nengine: claude\nmaxTokens: 12\nmarker: "<<X>>"\n---\nBody {{a}}');
  assert.deepEqual(meta, { engine: "claude", maxTokens: 12, marker: "<<X>>" });
  assert.equal(render(body, { a: "1" }), "Body 1");
});

test("render fills voice and drops unknown placeholders", () => {
  const { body } = loadPrompt("grammar_fix");
  const out = render(body, { voice: voiceRules(), marker: "<<M>>" });
  assert.ok(out.includes("no emojis"));
  assert.ok(out.includes("<<M>>"));
  assert.ok(!out.includes("{{"));
});

test("extractMarked strips the marker and rejects truncation or emptiness", () => {
  assert.equal(extractMarked("Hello.<<M>>", "<<M>>"), "Hello.");
  assert.equal(extractMarked("Hello. <<M>>\n", "<<M>>"), "Hello.");
  assert.throws(() => extractMarked("Hello.", "<<M>>"), /completion marker/);
  assert.throws(() => extractMarked("<<M>>", "<<M>>"), /empty/);
  assert.equal(extractMarked("plain", null), "plain");
});

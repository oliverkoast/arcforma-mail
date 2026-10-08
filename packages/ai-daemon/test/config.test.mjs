import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledLlama, withCurrentSonnet, withReachableLlama } from "../src/config.mjs";

function llamaDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcforma-llama-"));
  fs.writeFileSync(path.join(dir, "llama-server"), "");
  return dir;
}

test("the bundled llama-server is found only where ARCFORMA_LLAMA_DIR says and only when it is there", () => {
  assert.equal(bundledLlama({}), null);
  assert.equal(bundledLlama({ ARCFORMA_LLAMA_DIR: path.join(os.tmpdir(), "no-such-llama") }), null);
  const dir = llamaDir();
  assert.deepEqual(bundledLlama({ ARCFORMA_LLAMA_DIR: dir }), { binary: path.join(dir, "llama-server"), libDir: dir });
});

test("a stored binary that is gone gives way to the bundled one, and one that exists is kept", () => {
  const dir = llamaDir();
  const env = { ARCFORMA_LLAMA_DIR: dir };
  const gone = withReachableLlama({ local: { binary: "/nowhere/llama-server", libDir: "/nowhere", model: "m.gguf" } }, env);
  assert.equal(gone.local.binary, path.join(dir, "llama-server"));
  assert.equal(gone.local.model, "m.gguf");
  const other = llamaDir();
  const kept = withReachableLlama({ local: { binary: path.join(other, "llama-server"), libDir: other } }, env);
  assert.equal(kept.local.binary, path.join(other, "llama-server"));
});

test("an Ollama base URL is left alone, and nothing bundled means nothing changes", () => {
  const dir = llamaDir();
  const ollama = { local: { baseUrl: "http://127.0.0.1:11434", binary: null } };
  assert.equal(withReachableLlama(ollama, { ARCFORMA_LLAMA_DIR: dir }), ollama);
  const none = { local: { binary: null } };
  assert.equal(withReachableLlama(none, {}), none);
});

test("the old default chain becomes Sonnet 5.5, and a chain chosen by hand is kept", () => {
  assert.deepEqual(withCurrentSonnet({ modelChain: ["sonnet"] }).modelChain, ["claude-sonnet-5-5"]);
  assert.deepEqual(withCurrentSonnet({ modelChain: ["opus", "sonnet"] }).modelChain, ["opus", "sonnet"]);
  assert.deepEqual(withCurrentSonnet({ modelChain: ["claude-haiku-5-5"] }).modelChain, ["claude-haiku-5-5"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiService } from "@arcforma/ai-core";
import { createDaemon } from "../src/server.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ai-core", "test", "fixtures", "fake-claude.sh");

async function up(mode = "ok") {
  const cfg = { token: "t0k", claudeBin: FAKE, concurrency: 2, local: {} };
  const service = new AiService({ claude: { bin: FAKE, env: { FAKE_CLAUDE_MODE: mode } } });
  const { server } = createDaemon(cfg, { service });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, token = "t0k") => fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("health needs no token; other routes do", async () => {
  const d = await up();
  const h = await (await d.call("GET", "/v1/health", null, "")).json();
  assert.equal(h.claude, "ok");
  const bad = await d.call("POST", "/v1/complete", { user: "x" }, "wrong");
  assert.equal(bad.status, 401);
  await d.close();
});

test("complete runs a task and strips the marker", async () => {
  const d = await up();
  const r = await d.call("POST", "/v1/complete", { task: "grammar_fix", user: JSON.stringify({ selectedText: "teh" }), requestId: "a1" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.match(j.text, /^fixed:/);
  await d.close();
});

test("signed out maps to 503 not_logged_in", async () => {
  const d = await up("loggedout");
  const r = await d.call("POST", "/v1/complete", { system: "s", user: "u" });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, "not_logged_in");
  await d.close();
});

test("cancel returns 404 for unknown ids and classify without a local model is 503", async () => {
  const d = await up();
  assert.equal((await d.call("DELETE", "/v1/complete/nope")).status, 404);
  const c = await d.call("POST", "/v1/classify", { text: "hi", vars: { categories: "", examples: "" } });
  assert.equal(c.status, 503);
  await d.close();
});

test("chat completions pass through to the local model with thinking off, behind the token", async () => {
  let seen = null;
  const llama = (await import("node:http")).createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      seen = { path: req.url, body: JSON.parse(b) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Clean text." } }] }));
    });
  });
  await new Promise((r) => llama.listen(0, "127.0.0.1", r));
  const service = new AiService({ claude: { bin: FAKE }, local: { baseUrl: `http://127.0.0.1:${llama.address().port}` } });
  const { server } = createDaemon({ token: "t0k", local: {} }, { service });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const post = (body, token = "t0k") => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  assert.equal((await post({ messages: [] }, "wrong")).status, 401);
  assert.equal((await post({ model: "local" })).status, 400);
  const r = await post({ model: "local", messages: [{ role: "user", content: "um so hi" }], stream: true });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "Clean text.");
  assert.equal(seen.path, "/v1/chat/completions");
  assert.equal(seen.body.stream, false);
  assert.deepEqual(seen.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(seen.body.messages[0].content, "um so hi");
  await new Promise((r) => server.close(r));
  await new Promise((r) => llama.close(r));
});

test("chat completions without a local model are 503", async () => {
  const d = await up();
  const r = await d.call("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "x" }] });
  assert.equal(r.status, 503);
  await d.close();
});

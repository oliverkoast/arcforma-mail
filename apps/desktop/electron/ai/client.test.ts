import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiClient, AiError, readDaemonConfig, toFailure, type FetchLike } from "./client.js";

function configFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-ai-"));
  const file = path.join(dir, "ai-daemon.json");
  fs.writeFileSync(file, JSON.stringify({ port: 4321, token: "secret" }));
  return file;
}

function fake(handler: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => { status: number; body: unknown }): { fetch: FetchLike; calls: Array<{ url: string; headers: Record<string, string>; body?: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const r = handler(url, init);
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, calls };
}

test("reads the daemon config and sends the bearer token except on health", async () => {
  const { fetch, calls } = fake((url) => (url.endsWith("/v1/health") ? { status: 200, body: { ok: true, loggedIn: false, claude: "signed_out", local: "idle", model: "claude-fable-5-1", cliVersion: "2.1.257" } } : { status: 200, body: { ok: true, text: "Summary.", model: "m", latencyMs: 5, engine: "claude" } }));
  const ai = new AiClient({ configFile: configFile(), fetch });
  const h = await ai.health();
  assert.equal(h.loggedIn, false);
  assert.equal(h.claude, "signed_out");
  assert.equal(calls[0]!.url, "http://127.0.0.1:4321/v1/health");
  assert.equal(calls[0]!.headers["authorization"], undefined);
  const c = await ai.complete({ task: "summarize", user: "hi" });
  assert.equal(c.text, "Summary.");
  assert.equal(calls[1]!.headers["authorization"], "Bearer secret");
  assert.deepEqual(JSON.parse(calls[1]!.body!), { task: "summarize", user: "hi" });
});

test("503 not_logged_in and other daemon failures become typed AiErrors", async () => {
  const { fetch } = fake((url) => {
    if (url.endsWith("/v1/complete")) return { status: 503, body: { ok: false, code: "not_logged_in", error: "Not logged in" } };
    if (url.endsWith("/v1/classify")) return { status: 200, body: { ok: false, code: "bad_json", error: "not JSON" } };
    return { status: 401, body: { ok: false, error: "bad token" } };
  });
  const ai = new AiClient({ configFile: configFile(), fetch });
  await assert.rejects(ai.complete({ task: "summarize", user: "x" }), (e: unknown) => e instanceof AiError && e.code === "not_logged_in" && e.status === 503);
  await assert.rejects(ai.classify({ text: "x", schema: {} }), (e: unknown) => e instanceof AiError && e.code === "bad_response");
  await assert.rejects(ai.cancel("r").then(() => ai.complete({ user: "x", system: "s" })), (e: unknown) => e instanceof AiError && e.code === "not_logged_in");
  assert.deepEqual(toFailure(new AiError("timeout", "slow")), { ok: false, code: "timeout", error: "slow" });
  assert.equal(toFailure(new Error("boom")).code, "unknown");
});

test("a missing config or a refused connection is daemon_down, and status never throws", async () => {
  const missing = new AiClient({ configFile: path.join(os.tmpdir(), "does-not-exist.json"), fetch: fake(() => ({ status: 200, body: {} })).fetch });
  await assert.rejects(missing.complete({ user: "x", system: "s" }), (e: unknown) => e instanceof AiError && e.code === "daemon_down");
  assert.equal(readDaemonConfig(path.join(os.tmpdir(), "does-not-exist.json")), null);
  const refused = new AiClient({
    configFile: configFile(),
    fetch: async () => {
      throw Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" });
    },
  });
  await assert.rejects(refused.health(), (e: unknown) => e instanceof AiError && e.code === "daemon_down");
  const s = await refused.status();
  assert.equal(s.ok, false);
  assert.equal(s.claude, "daemon_down");
});

#!/usr/bin/env node
/**
 * Arcforma AI daemon. Loopback HTTP in front of @arcforma/ai-core so the
 * mail app and the text tools share one Claude Code login path, one local
 * model process, and one concurrency gate. Plain Node, no dependencies
 * beyond the core package, so a LaunchAgent can keep it alive.
 *
 * Config: ~/Library/Application Support/Arcforma/ai-daemon.json
 *   {port, token, claudeBin, modelChain, concurrency, local:{binary, libDir, model, baseUrl}}
 * The file is created on first run with a random token and port 0 (pick a
 * free port); the chosen port is written back so clients can find it.
 */
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { AiService } from "@arcforma/ai-core";
import { loadConfig, saveConfig, CONFIG_FILE } from "./config.mjs";

const MAX_BODY = 2 * 1024 * 1024;
const log = (...a) => console.log(new Date().toISOString(), ...a);

export function createDaemon(cfg, deps = {}) {
  const service = deps.service ?? new AiService({
    claude: { bin: cfg.claudeBin, modelChain: cfg.modelChain, concurrency: cfg.concurrency, oauthToken: cfg.claudeOAuthToken || null, apiKey: cfg.claudeApiKey || null },
    local: cfg.local,
    routes: cfg.routes,
    log,
  });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) => {
      const json = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
      res.end(json);
      if (url.pathname !== "/v1/health") log(req.method, url.pathname, status, `${Date.now() - started}ms`);
    };
    try {
      if (url.pathname === "/v1/health" && req.method === "GET") return send(200, await service.status());
      const auth = req.headers.authorization ?? "";
      if (!timingSafeEqual(auth, `Bearer ${cfg.token}`)) return send(401, { ok: false, code: "unauthorized", error: "bad token" });

      if (url.pathname === "/v1/complete" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body.user !== "string") return send(400, { ok: false, code: "bad_request", error: "user (string) required" });
        const r = await service.complete({
          task: body.task, system: body.system, user: body.user, vars: body.vars, model: body.model,
          maxTokens: body.maxTokens, timeoutMs: body.timeoutMs, requestId: body.requestId, allowedTools: body.allowedTools, json: body.json, schema: body.schema,
        });
        return send(r.ok ? 200 : statusFor(r.code), r);
      }
      const cancel = url.pathname.match(/^\/v1\/complete\/([\w-]+)$/);
      if (cancel && req.method === "DELETE") return send(service.cancel(cancel[1]) ? 200 : 404, { ok: true });

      if (url.pathname === "/v1/classify" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body.text !== "string") return send(400, { ok: false, code: "bad_request", error: "text (string) required" });
        const r = await service.classifyLocal({ text: body.text, schema: body.schema, system: body.system, task: body.task, vars: body.vars, maxTokens: body.maxTokens, timeoutMs: body.timeoutMs });
        return send(r.ok ? 200 : statusFor(r.code), r);
      }
      if (url.pathname === "/v1/tasks" && req.method === "GET") {
        const { listTasks } = await import("@arcforma/ai-core");
        return send(200, { tasks: listTasks() });
      }
      return send(404, { ok: false, code: "not_found" });
    } catch (e) {
      log("error", String(e).slice(0, 300));
      return send(500, { ok: false, code: "internal", error: String(e.message ?? e).slice(0, 500) });
    }
  });

  return { server, service };
}

function statusFor(code) {
  return { not_logged_in: 503, model_unsupported: 503, local_missing: 503, timeout: 504, cancelled: 499, bad_request: 400, unknown_task: 400 }[code] ?? 502;
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); } catch (e) { reject(new Error("invalid JSON body")); } });
    req.on("error", reject);
  });
}

export async function main() {
  const cfg = loadConfig();
  const { server, service } = createDaemon(cfg);
  await new Promise((resolve, reject) => { server.on("error", reject); server.listen(cfg.port, "127.0.0.1", resolve); });
  cfg.port = server.address().port;
  saveConfig(cfg);
  log(`arcforma ai daemon up on 127.0.0.1:${cfg.port} config=${CONFIG_FILE} claude=${cfg.claudeBin} local=${cfg.local?.model ?? "none"}`);
  void service.prewarm();
  const st = await service.status();
  log(`claude ${st.claude}${st.email ? ` (${st.email})` : ""} via ${st.authSource} cli=${st.cliVersion} local=${st.local}`);
  if (!st.loggedIn) log("claude is not signed in on this machine. Run `claude setup-token` and put the token in ai-daemon.json as claudeOAuthToken, or `claude auth login`. Completions return not_logged_in until then.");
  const shutdown = () => { log("shutting down"); service.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

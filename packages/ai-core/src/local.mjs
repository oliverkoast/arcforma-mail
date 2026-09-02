/**
 * Local model through llama.cpp's llama-server (OpenAI-compatible HTTP).
 *
 * Owns one child process, starts it lazily, unloads it after idle. The same
 * client also speaks to Ollama at http://127.0.0.1:11434 when `baseUrl` is
 * set and no binary is configured. Ported from openwhispr/src/helpers/llamaServer.js,
 * trimmed to macOS Metal.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const DEFAULT_CTX = 8192;
const DEFAULT_IDLE_MS = 120 * 60 * 1000;
const START_TIMEOUT_MS = 120_000;

export class LocalModel {
  /**
   * @param {{binary?: string, libDir?: string, model?: string, port?: number, baseUrl?: string, threads?: number, ctx?: number, log?: (s:string)=>void}} cfg
   */
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.baseUrl = cfg.baseUrl ?? null;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.idleTimer = null;
    this.log = cfg.log ?? (() => {});
  }

  get configured() { return Boolean(this.baseUrl || (this.cfg.binary && this.cfg.model)); }

  status() {
    if (this.baseUrl) return "ok";
    if (!this.configured) return "missing";
    if (!fs.existsSync(this.cfg.binary) || !fs.existsSync(this.cfg.model)) return "missing";
    if (this.ready) return "ok";
    if (this.starting) return "loading";
    return "idle";
  }

  async ensure() {
    if (this.baseUrl) return this.baseUrl;
    if (!this.configured) throw Object.assign(new Error("local model not configured"), { code: "local_missing" });
    if (this.ready) return this._url();
    if (!this.starting) this.starting = this._start().finally(() => { this.starting = null; });
    await this.starting;
    return this._url();
  }

  async _start() {
    const port = this.cfg.port ?? (await freePort());
    this.port = port;
    const args = [
      "--model", this.cfg.model,
      "--host", "127.0.0.1", "--port", String(port),
      "--threads", String(this.cfg.threads ?? 4),
      "--ctx-size", String(this.cfg.ctx ?? DEFAULT_CTX),
      "--n-gpu-layers", "99",
      "--jinja",
    ];
    const libDir = this.cfg.libDir ?? path.dirname(this.cfg.binary);
    const env = { ...process.env, DYLD_LIBRARY_PATH: libDir, LLAMA_ARG_FIT: "off" };
    this.log(`llama-server starting on ${port} with ${path.basename(this.cfg.model)}`);
    const child = spawn(this.cfg.binary, args, { stdio: ["ignore", "pipe", "pipe"], env });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    child.on("exit", (code, sig) => {
      this.log(`llama-server exited code=${code} sig=${sig} ${stderr.slice(-300).replace(/\n/g, " ")}`);
      this.child = null; this.ready = false;
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error(`llama-server died during startup: ${stderr.slice(-300)}`);
      try {
        const r = await fetch(`${this._url()}/health`);
        if (r.ok) { this.ready = true; this._touch(); this.log("llama-server ready"); return; }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop();
    throw new Error("llama-server did not become ready in time");
  }

  _url() { return this.baseUrl ?? `http://127.0.0.1:${this.port}`; }

  _touch() {
    if (this.baseUrl) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.log("llama-server idle, stopping"); this.stop(); }, (this.cfg.idleMinutes ?? 0) > 0 ? this.cfg.idleMinutes * 60_000 : DEFAULT_IDLE_MS);
    this.idleTimer.unref?.();
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.child) { try { this.child.kill("SIGTERM"); } catch {} }
    this.child = null; this.ready = false;
  }

  /**
   * Chat completion. When `schema` is given, output is constrained to that JSON schema and parsed.
   * @param {{system: string, user: string, schema?: object, maxTokens?: number, temperature?: number, model?: string, timeoutMs?: number}} req
   */
  async complete(req) {
    const base = await this.ensure();
    const body = {
      model: req.model ?? "local",
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 512,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    };
    if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: "out", schema: req.schema, strict: true } };
    const started = Date.now();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), req.timeoutMs ?? 60_000);
    let res;
    try {
      res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    } finally { clearTimeout(t); this._touch(); }
    if (!res.ok) throw new Error(`llama-server HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const text = stripThinking(msg.content || msg.reasoning_content || "");
    const out = { text, model: data.model ?? "local", latencyMs: Date.now() - started, finish: data.choices?.[0]?.finish_reason };
    if (req.schema) {
      try { out.json = JSON.parse(text); } catch (e) { throw Object.assign(new Error(`local model returned invalid JSON: ${text.slice(0, 200)}`), { code: "bad_json" }); }
    }
    return out;
  }
}

export function stripThinking(s) {
  return String(s).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on("error", reject);
  });
}

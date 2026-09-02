/**
 * The one AI service both apps consume. Claude for on-demand work, the local
 * model for background classification, prompts from the library, the voice
 * profile from disk.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "./claude.mjs";
import { LocalModel } from "./local.mjs";
import { loadPrompt, render, voiceRules, extractMarked } from "./prompts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Per-task routing. A route sends short requests for a task to the local model with a library
 * prompt, regardless of the system prompt the caller supplied, and falls back to Claude when the
 * local model is missing, the text is too long, or the local answer fails the sanity checks.
 * `marker` is appended to a successful local answer so the caller's truncation check still holds.
 */
export const DEFAULT_ROUTES = {
  "text.fix": { engine: "local", prompt: "grammar_fix_local", maxChars: 1500, marker: "<<ARCFORMA_END>>", fallback: "claude" },
};

/** Strip wrapping quotes, code fences, or a stray label a small model sometimes adds. */
export function unwrapLocal(text) {
  let t = String(text).trim();
  t = t.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  t = t.replace(/^(?:corrected(?: text)?|output)\s*:\s*/i, "");
  if (t.length > 2 && /^["“]/.test(t) && /["”]$/.test(t) && !/^["“].*["”].*["“]/.test(t)) t = t.slice(1, -1);
  return t;
}

export class AiService {
  /** @param {{claude?: ConstructorParameters<typeof ClaudeRunner>[0], local?: ConstructorParameters<typeof LocalModel>[0], voiceFile?: string, log?: (s:string)=>void}} [cfg] */
  constructor(cfg = {}) {
    this.claude = new ClaudeRunner(cfg.claude);
    this.local = new LocalModel({ ...cfg.local, log: cfg.log });
    this.voiceFile = cfg.voiceFile ?? path.join(HERE, "voice", "oliver.voice.md");
    this.routes = { ...DEFAULT_ROUTES, ...(cfg.routes ?? {}) };
    this.log = cfg.log ?? (() => {});
  }

  /** Load the local model ahead of the first request so a fix never pays the startup cost. */
  prewarm() {
    if (this.local.configured && this.local.status() !== "ok") {
      return this.local.ensure().catch((e) => this.log(`prewarm failed: ${e.message}`));
    }
    return Promise.resolve();
  }

  /**
   * Try a routed task on the local model. Returns a result on success, null to fall through.
   * @param {object} req  @param {object} route
   */
  async _routeLocal(req, route) {
    if (!this.local.configured || this.local.status() === "missing") return null;
    if (typeof req.user !== "string" || req.user.length > route.maxChars) return null;
    let selected = null;
    try { selected = JSON.parse(req.user)?.selectedText; } catch {}
    if (typeof selected !== "string" || !selected.trim()) return null;
    const started = Date.now();
    try {
      const { meta, body } = loadPrompt(route.prompt);
      const system = render(body, { voice: voiceRules() });
      const r = await this.local.complete({ system, user: req.user, maxTokens: Math.min(meta.maxTokens ?? 1200, Math.ceil(selected.length / 2) + 200), temperature: 0, timeoutMs: req.timeoutMs ?? 20_000 });
      if (r.finish && r.finish !== "stop") { this.log(`local route ${req.task}: truncated (${r.finish}), falling back`); return null; }
      const text = unwrapLocal(r.text);
      const ratio = text.length / Math.max(1, selected.length);
      if (!text.trim() || ratio < 0.6 || ratio > 1.6 || /—|–/.test(text)) {
        this.log(`local route ${req.task}: rejected (ratio ${ratio.toFixed(2)}), falling back`);
        return null;
      }
      return { ok: true, text: route.marker ? text + route.marker : text, model: r.model, latencyMs: Date.now() - started, engine: "local" };
    } catch (e) {
      this.log(`local route ${req.task}: ${e.message}, falling back`);
      return null;
    }
  }

  async status() {
    const [auth, version] = await Promise.all([this.claude.authStatus(), this.claude.version()]);
    return {
      ok: true,
      claude: auth.loggedIn ? "ok" : "signed_out",
      loggedIn: auth.loggedIn,
      email: auth.email,
      authSource: auth.authSource ?? this.claude.authSource,
      cliVersion: version,
      model: this.claude.model,
      local: this.local.status(),
      localModel: this.local.cfg?.model ? path.basename(this.local.cfg.model) : null,
      inFlight: this.claude.inFlight,
      queued: this.claude.queue.length,
    };
  }

  voice() {
    try { return fs.readFileSync(this.voiceFile, "utf8"); } catch { return ""; }
  }

  /**
   * Run a library task. `vars` fill the prompt template; `user` is the user message.
   * Returns {ok, text, model, latencyMs} or {ok:false, code, error}.
   * @param {{task: string, user: string, vars?: Record<string,string>, system?: string, model?: string, maxTokens?: number, timeoutMs?: number, requestId?: string, allowedTools?: string[], json?: boolean}} req
   */
  async complete(req) {
    const route = req.task ? this.routes[req.task] : null;
    if (route?.engine === "local" && !req.model) {
      const local = await this._routeLocal(req, route);
      if (local) return local;
      if (route.fallback !== "claude") return { ok: false, code: "local_error", error: "local model could not answer", engine: "local" };
    }
    let system = req.system;
    let marker = null;
    // A caller that supplies its own system prompt uses `task` only as a label for logs and
    // timing; the prompt library is consulted only when no system prompt is given.
    if (req.task && !req.system) {
      const { meta, body } = loadPrompt(req.task);
      marker = meta.marker ?? null;
      system = render(body, { voice: voiceRules(), voiceProfile: this.voice(), marker: marker ?? "", ...(req.vars ?? {}) });
      if (meta.engine === "local") {
        try {
          const r = await this.local.complete({ system, user: req.user, maxTokens: req.maxTokens ?? meta.maxTokens, schema: req.schema, timeoutMs: req.timeoutMs });
          return { ok: true, text: r.text, json: r.json, model: r.model, latencyMs: r.latencyMs, engine: "local" };
        } catch (e) {
          return { ok: false, code: e.code ?? "local_error", error: String(e.message ?? e).slice(0, 500), engine: "local" };
        }
      }
    }
    if (!system) return { ok: false, code: "bad_request", error: "system or task required" };
    const r = await this.claude.complete({ system, user: req.user, model: req.model, timeoutMs: req.timeoutMs, requestId: req.requestId, allowedTools: req.allowedTools });
    if (!r.ok) return { ...r, engine: "claude" };
    let text = r.text;
    try { text = extractMarked(text, marker); } catch (e) { return { ok: false, code: e.code, error: e.message, engine: "claude", model: r.model }; }
    let json;
    if (req.json) {
      try { json = JSON.parse(text.replace(/^```(?:json)?\n?|\n?```$/g, "")); } catch { return { ok: false, code: "bad_json", error: `not JSON: ${text.slice(0, 200)}`, engine: "claude", model: r.model }; }
    }
    return { ok: true, text, json, model: r.model, latencyMs: r.latencyMs, engine: "claude" };
  }

  /** Background classification on the local model. Never touches Claude. */
  classifyLocal({ text, schema, system, task = "classify", vars, maxTokens, timeoutMs }) {
    return this.complete({ task: system ? undefined : task, system, user: text, vars, schema, maxTokens, timeoutMs }).then((r) => {
      if (r.ok && !r.json) { try { r.json = JSON.parse(r.text); } catch { return { ok: false, code: "bad_json", error: r.text.slice(0, 200) }; } }
      return r;
    });
  }

  cancel(requestId) { return this.claude.cancel(requestId); }

  stop() { this.local.stop(); }
}

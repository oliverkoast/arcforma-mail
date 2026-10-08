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
import { loadPrompt, render, voiceRules, extractMarked, splitExamples, tagText } from "./prompts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Per-task routing. A route sends short requests for a task to the local model with a library
 * prompt, regardless of the system prompt the caller supplied, and falls back to Claude when the
 * local model is missing, the text is too long, or the local answer fails the sanity checks.
 * `marker` is appended to a successful local answer so the caller's truncation check still holds.
 */
export const DEFAULT_ROUTES = {
  "text.fix": fixRoute(),
};

/**
 * Cmd+J. The local model first; when it cannot, Claude with the library's own prompt on Haiku 5.5.
 * Measured 2026-10-08 on eval/text-fix (36 cases): Haiku 5.5 with grammar_fix passed 36, median
 * 1.1 s; Sonnet passed 36 at 2.7 s; the Swift app's copy of the prompt on Haiku passed 34, once
 * explaining its edits above the text. So the caller's system prompt is not used for a fix.
 */
export function fixRoute() {
  return { engine: "local", prompt: "grammar_fix_local", maxChars: 1500, marker: "<<ARCFORMA_END>>", fallback: "claude", claudeModel: "claude-haiku-5-5", claudePrompt: "grammar_fix" };
}

/** Strip wrapping quotes, code fences, or a stray label a small model sometimes adds. */
export function unwrapLocal(text) {
  let t = String(text).trim();
  t = t.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  t = t.replace(/^(?:corrected(?: text)?|output)\s*:\s*/i, "");
  if (t.length > 2 && /^["“]/.test(t) && /["”]$/.test(t) && !/^["“].*["”].*["“]/.test(t)) t = t.slice(1, -1);
  return t;
}

/**
 * What a 4B model does not reliably do from a prompt, done in code. The eval on 2026-10-08 found
 * dashes in 9 of 15 failures, most of them copied from the writer's own text, and each one made
 * the daemon throw a good fix away. A dash between numbers is a range and becomes a hyphen; any
 * other dash becomes a comma. Trailing spaces the model adds before a line break (markdown hard
 * breaks) go unless the writer typed them.
 */
export function tidyLocal(text, input = "") {
  let t = String(text)
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1-$2")
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?:;])/g, "$1")
    .replace(/^,\s*/gm, "");
  if (!/[ \t]\n/.test(input)) t = t.replace(/[ \t]+\n/g, "\n");
  if (!/[ \t]$/.test(input)) t = t.replace(/[ \t]+$/, "");
  return t;
}

/**
 * The messages a routed local task sends. A `format: tagged` prompt gets its examples as past
 * turns and the selection inside <text> tags; any other prompt keeps the caller's JSON envelope.
 */
export function localMessages(meta, body, selected, envelope) {
  const rendered = render(body, { voice: voiceRules() });
  if (meta.format !== "tagged") return { system: rendered, turns: [], user: envelope };
  const { system, examples } = splitExamples(rendered);
  const turns = examples.flatMap((e) => [{ role: "user", content: tagText(e.input) }, { role: "assistant", content: e.output }]);
  return { system, turns, user: tagText(selected) };
}

/** A library prompt written for Claude may ask for an end marker; a local answer has no use for one. */
function stripMarkerLine(text) {
  return String(text).replace(/<<ARCFORMA_END>>\s*$/, "").trim();
}

/** Outside these, a local answer is not an edit of the selection at all (a written poem, a lost paragraph), even as a last resort. */
const HARD_RATIO = [0.3, 2.5];

/** Optimal string alignment distance: Levenshtein plus adjacent transposition, so "teh" is one edit from "the". */
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const WORDS = /[\p{L}\p{N}']+/gu;

/**
 * The share of the writer's distinct words still in the answer, a misspelt word counting as kept
 * when the answer has it within a third of its length in edits. A copy edit keeps most of them:
 * across five engine and prompt runs of the 2026-10-08 eval every real fix kept at least 0.78,
 * while every answer that obeyed the text instead of editing it (a translation, an answered
 * question, a poem, a dropped "Translate this to Spanish:") kept 0.56 or less. Null for a
 * selection too short for the share to mean anything.
 */
export function keptShare(input, output) {
  const source = [...new Set(String(input).toLowerCase().match(WORDS) ?? [])];
  if (source.length < 4) return null;
  const out = [...new Set(String(output).toLowerCase().match(WORDS) ?? [])];
  const kept = source.filter((w) => out.some((o) => o === w || osa(w, o) <= Math.max(1, Math.floor(w.length / 3))));
  return kept.length / source.length;
}

/** Below this the answer is not an edit of the selection, whatever else is true. */
const HARD_KEPT = 0.65;
/** Below this a fix is doubtful while Claude can still be asked. */
const STRICT_KEPT = 0.7;

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
  async _routeLocal(req, route, { strict = true } = {}) {
    if (!this.local.configured || this.local.status() === "missing") return null;
    if (typeof req.user !== "string" || req.user.length > route.maxChars) return null;
    let selected = null;
    try { selected = JSON.parse(req.user)?.selectedText; } catch {}
    if (typeof selected !== "string" || !selected.trim()) return null;
    const started = Date.now();
    try {
      const { meta, body } = loadPrompt(route.prompt);
      const { system, turns, user } = localMessages(meta, body, selected, req.user);
      const r = await this.local.complete({ system, turns, user, maxTokens: Math.min(meta.maxTokens ?? 1200, Math.ceil(selected.length / 2) + 200), temperature: 0, timeoutMs: req.timeoutMs ?? 20_000 });
      if (r.finish && r.finish !== "stop") { this.log(`local route ${req.task}: truncated (${r.finish}), falling back`); return null; }
      const text = tidyLocal(unwrapLocal(r.text), selected);
      const ratio = text.length / Math.max(1, selected.length);
      // Truncated, empty, or wildly off length is unusable either way: that is an answer to the
      // text, not an edit of it. The tighter bar is a quality bar, and a quality bar is the wrong
      // question once Claude is the thing that failed: the choice then is this answer or none.
      const kept = keptShare(selected, text);
      if (!text.trim() || ratio < HARD_RATIO[0] || ratio > HARD_RATIO[1] || (kept !== null && kept < HARD_KEPT)) {
        this.log(`local route ${req.task}: unusable (ratio ${ratio.toFixed(2)}, kept ${kept?.toFixed(2) ?? "n/a"})`);
        return null;
      }
      if (strict && (ratio < 0.6 || ratio > 1.6 || (kept !== null && kept < STRICT_KEPT))) {
        this.log(`local route ${req.task}: rejected (ratio ${ratio.toFixed(2)}, kept ${kept?.toFixed(2) ?? "n/a"}), falling back`);
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
  /**
   * A person is waiting on a text.* request; background classification is not. While one is in
   * flight, classify calls hold at the gate, so the slot a fix needs is free the moment it asks.
   */
  _enterInteractive() {
    this._interactive = (this._interactive ?? 0) + 1;
  }
  _leaveInteractive() {
    this._interactive = Math.max(0, (this._interactive ?? 0) - 1);
    if (this._interactive === 0) {
      const waiters = this._waiters ?? [];
      this._waiters = [];
      for (const w of waiters) w();
    }
  }
  async _awaitQuiet() {
    while ((this._interactive ?? 0) > 0) await new Promise((r) => (this._waiters ??= []).push(r));
  }

  async complete(req) {
    const interactive = typeof req.task === "string" && req.task.startsWith("text.");
    if (interactive) this._enterInteractive();
    try {
      return await this._complete(req);
    } finally {
      if (interactive) this._leaveInteractive();
    }
  }

  async _complete(req) {
    // A library task on the local model, asked for by name: how mail's AI runs on a Mac with no
    // Claude, and how the eval compares the two engines on the same prompt.
    if (req.engine === "local" && req.task && !req.system) return this._localTask(req);
    const route = req.task ? this.routes[req.task] : null;
    if (route?.engine === "local" && !req.model) {
      const local = await this._routeLocal(req, route);
      if (local) return local;
      if (route.fallback !== "claude") return { ok: false, code: "local_error", error: "local model could not answer", engine: "local" };
    }
    let system = req.system;
    let marker = null;
    // A route that names its Claude prompt uses it whatever the caller sent, and hands the caller's
    // marker back on the answer so the caller's own truncation check still holds.
    const routed = Boolean(route?.claudePrompt && !req.model);
    if (routed) {
      const { meta, body } = loadPrompt(route.claudePrompt);
      marker = meta.marker ?? null;
      system = render(body, { voice: voiceRules(), voiceProfile: this.voice(), marker: marker ?? "", ...(req.vars ?? {}) });
    } else if (req.task && !req.system) {
      // A caller that supplies its own system prompt uses `task` only as a label for logs and
      // timing; the prompt library is consulted only when no system prompt is given.
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
    const r = await this.claude.complete({ system, user: req.user, model: req.model ?? (routed ? route.claudeModel : undefined), timeoutMs: req.timeoutMs, requestId: req.requestId, allowedTools: req.allowedTools });
    if (!r.ok) {
      // The fallback used to run one way only. A task routed to the local model fell through to
      // Claude when the local answer was not good enough, and a signed-out Claude then failed the
      // whole request with a healthy local model sitting idle: Cmd+J stopped working every time an
      // OAuth token expired, which is often. Now the local model gets the last word too, with the
      // quality bar dropped, because a merely adequate fix beats "sign in to Claude Code".
      if (route?.engine === "local" && !req.model) {
        const rescue = await this._routeLocal(req, route, { strict: false });
        if (rescue) {
          this.log(`claude ${r.code ?? "failed"}, answered ${req.task} on the local model instead`);
          return { ...rescue, degraded: true };
        }
      }
      return { ...r, engine: "claude" };
    }
    let text = r.text;
    try { text = extractMarked(text, marker); } catch (e) { return { ok: false, code: e.code, error: e.message, engine: "claude", model: r.model }; }
    if (routed && route.marker) text += route.marker;
    let json;
    if (req.json) {
      try { json = JSON.parse(text.replace(/^```(?:json)?\n?|\n?```$/g, "")); } catch { return { ok: false, code: "bad_json", error: `not JSON: ${text.slice(0, 200)}`, engine: "claude", model: r.model }; }
    }
    return { ok: true, text, json, model: r.model, latencyMs: r.latencyMs, engine: "claude" };
  }

  async _localTask(req) {
    try {
      const { meta, body } = loadPrompt(req.task);
      const system = render(body, { voice: voiceRules(), voiceProfile: this.voice(), marker: "", ...(req.vars ?? {}) });
      const r = await this.local.complete({ system, user: req.user, maxTokens: req.maxTokens ?? meta.maxTokens ?? 800, schema: req.schema, temperature: 0.2, timeoutMs: req.timeoutMs });
      let text = stripMarkerLine(r.text);
      let json = r.json;
      if (req.json && json === undefined) {
        try { json = JSON.parse(text.replace(/^```(?:json)?\n?|\n?```$/g, "")); } catch { return { ok: false, code: "bad_json", error: `not JSON: ${text.slice(0, 200)}`, engine: "local", model: r.model }; }
      }
      return { ok: true, text, json, model: r.model, latencyMs: r.latencyMs, engine: "local" };
    } catch (e) {
      return { ok: false, code: e.code ?? "local_error", error: String(e.message ?? e).slice(0, 500), engine: "local" };
    }
  }

  /** Background classification on the local model. Never touches Claude. */
  async classifyLocal(req) {
    await this._awaitQuiet();
    return this._classifyLocalNow(req);
  }
  _classifyLocalNow({ text, schema, system, task = "classify", vars, maxTokens, timeoutMs }) {
    return this.complete({ task: system ? undefined : task, system, user: text, vars, schema, maxTokens, timeoutMs }).then((r) => {
      if (r.ok && !r.json) { try { r.json = JSON.parse(r.text); } catch { return { ok: false, code: "bad_json", error: r.text.slice(0, 200) }; } }
      return r;
    });
  }

  cancel(requestId) { return this.claude.cancel(requestId); }

  stop() { this.local.stop(); }
}

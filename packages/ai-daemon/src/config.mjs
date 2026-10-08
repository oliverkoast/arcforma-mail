import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const SUPPORT_DIR = process.env.ARCFORMA_SUPPORT_DIR ?? path.join(os.homedir(), "Library", "Application Support", "Arcforma");
export const CONFIG_FILE = path.join(SUPPORT_DIR, "ai-daemon.json");
export const LOG_FILE = path.join(os.homedir(), "Library", "Logs", "arcforma-ai-daemon.log");

const OPENWHISPR_BIN = path.join(os.homedir(), "Projects", "openwhispr", "resources", "bin");

/**
 * The llama.cpp build Arcforma Mail carries in Contents/Resources/helpers/llama. The LaunchAgent the
 * app writes sets ARCFORMA_LLAMA_DIR to it; a daemon started from the repository has none.
 */
export function bundledLlama(env = process.env) {
  const dir = env.ARCFORMA_LLAMA_DIR;
  if (!dir) return null;
  const binary = path.join(dir, "llama-server");
  return fs.existsSync(binary) ? { binary, libDir: dir } : null;
}

function defaultLlama() {
  const openwhispr = path.join(OPENWHISPR_BIN, "llama-server-darwin-arm64");
  if (fs.existsSync(openwhispr)) return { binary: openwhispr, libDir: OPENWHISPR_BIN };
  return bundledLlama() ?? { binary: null, libDir: OPENWHISPR_BIN };
}

const DEFAULTS = () => ({
  port: 0,
  token: crypto.randomBytes(24).toString("hex"),
  claudeBin: path.join(os.homedir(), ".local", "bin", "claude"),
  claudeOAuthToken: "",
  claudeApiKey: "",
  // Sonnet, and nothing above or below it. Fable is quick and it is the wrong trade for anything
  // that goes out under someone's name; opus is not asked for. Cmd+J does not depend on this chain
  // any more, because text.fix answers on the local model and falls back to it when Claude cannot.
  modelChain: ["sonnet"],
  concurrency: 2,
  local: {
    ...defaultLlama(),
    model: firstExisting([
      path.join(SUPPORT_DIR, "models", "qwen3-4b-instruct-q4_k_m.gguf"),
      path.join(os.homedir(), ".cache", "openwhispr", "models", "qwen2.5-1.5b-instruct-q5_k_m.gguf"),
    ]),
    baseUrl: null,
    threads: 4,
    ctx: 16384, // two slots of 8k; see local.mjs
    idleMinutes: 120,
  },
  routes: {
    "text.fix": { engine: "local", prompt: "grammar_fix_local", maxChars: 1500, marker: "<<ARCFORMA_END>>", fallback: "claude" },
  },
});

function firstExisting(paths) { return paths.find((p) => fs.existsSync(p)) ?? paths[0]; }

/** Read the config, creating it with defaults (and a fresh token) on first run. */
export function loadConfig() {
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
  let cfg = DEFAULTS();
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))); } catch (e) { throw new Error(`bad ${CONFIG_FILE}: ${e.message}`); }
  }
  return withReachableLlama(cfg);
}

/**
 * A stored binary that is gone (the app was moved, or the openwhispr checkout deleted) gives way to
 * the bundled one, so the local model keeps answering without anyone editing the file.
 */
export function withReachableLlama(cfg, env = process.env) {
  if (cfg.local?.baseUrl) return cfg;
  if (cfg.local?.binary && fs.existsSync(cfg.local.binary)) return cfg;
  const bundled = bundledLlama(env);
  return bundled ? { ...cfg, local: { ...cfg.local, ...bundled } } : cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? deepMerge(a[k], v) : v;
  }
  return out;
}

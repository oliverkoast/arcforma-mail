// What onboarding needs to know about the machine outside the mail app: the AI
// daemon's config file, the local llama.cpp binary and model, and the Arcforma
// Text install with its Accessibility grant. Reads and narrow writes only; the
// renderer never touches any of it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfigPath } from "../ai/client.js";
import type { AiChoice } from "../../shared/onboarding.js";

const MODE = 0o600;

/** The daemon's support folder: the config file's own directory. */
export function supportDir(): string {
  return path.dirname(defaultConfigPath());
}

export function modelsDir(): string {
  return path.join(supportDir(), "models");
}

/** The model onboarding offers. One entry, because a choice between quantizations is not a first-run question. */
export const MODEL_CATALOG = {
  name: "Qwen3 4B Instruct, 4-bit",
  file: "qwen3-4b-instruct-q4_k_m.gguf",
  url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
  bytes: 2_497_281_120,
} as const;

export function modelPath(): string {
  return path.join(modelsDir(), MODEL_CATALOG.file);
}

export interface DaemonConfigView {
  /** The config file the daemon and the app both read. */
  path: string;
  present: boolean;
  /** True when a long-lived Claude Code token is stored. The token itself never leaves the main process. */
  hasClaudeToken: boolean;
  /** True when an Anthropic API key is stored. */
  hasApiKey: boolean;
  /** The llama.cpp server binary the config points at, and whether it is there. */
  localBinary: string | null;
  localBinaryPresent: boolean;
  /** The GGUF the config points at, and whether it is there. */
  localModel: string | null;
  localModelPresent: boolean;
}

function readConfig(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The daemon's own default binary location, so a machine that has llama.cpp from openwhispr is recognised. */
function fallbackBinary(): string {
  return path.join(os.homedir(), "Projects", "openwhispr", "resources", "bin", "llama-server-darwin-arm64");
}

export function daemonConfigView(file = defaultConfigPath()): DaemonConfigView {
  const present = fs.existsSync(file);
  const cfg = present ? readConfig(file) : {};
  const local = (cfg["local"] ?? {}) as Record<string, unknown>;
  const binary = typeof local["binary"] === "string" && local["binary"] ? local["binary"] : fs.existsSync(fallbackBinary()) ? fallbackBinary() : null;
  const model = typeof local["model"] === "string" && local["model"] ? local["model"] : fs.existsSync(modelPath()) ? modelPath() : null;
  return {
    path: file,
    present,
    hasClaudeToken: typeof cfg["claudeOAuthToken"] === "string" && (cfg["claudeOAuthToken"] as string).length > 0,
    hasApiKey: typeof cfg["claudeApiKey"] === "string" && (cfg["claudeApiKey"] as string).length > 0,
    localBinary: binary,
    localBinaryPresent: Boolean(binary && fs.existsSync(binary)),
    localModel: model,
    localModelPresent: Boolean(model && fs.existsSync(model)),
  };
}

/**
 * Merges a patch into the daemon config, creating the file when it is missing,
 * and leaves it at mode 0600. The daemon rereads the file when it restarts;
 * onboarding says so rather than restarting the LaunchAgent behind anyone's back.
 */
export function patchDaemonConfig(patch: Record<string, unknown>, file = defaultConfigPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? readConfig(file) : {};
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    if (value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object" && !Array.isArray(existing)) {
      next[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      next[key] = value;
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: MODE });
  fs.chmodSync(tmp, MODE);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, MODE);
}

/** Writes the credential for a choice. Local only clears both, so a machine that opts out stops carrying a secret. */
export function applyAiChoice(choice: AiChoice, secret: string, file = defaultConfigPath()): void {
  if (choice === "claude-code") patchDaemonConfig({ claudeOAuthToken: secret, claudeApiKey: "" }, file);
  else if (choice === "api-key") patchDaemonConfig({ claudeApiKey: secret, claudeOAuthToken: "" }, file);
  else patchDaemonConfig({ claudeOAuthToken: "", claudeApiKey: "" }, file);
}

/** Points the daemon at a model that has just landed. */
export function pointDaemonAtModel(file: string, configFile = defaultConfigPath()): void {
  patchDaemonConfig({ local: { model: file } }, configFile);
}

export type AccessibilityState = "granted" | "not_granted" | "unknown";

export interface TextToolState {
  /** /Applications/Arcforma Text.app exists. */
  installed: boolean;
  appPath: string;
  /** The launchd label, so the step can say what to restart. */
  label: string;
  logPath: string;
  accessibility: AccessibilityState;
  /** When the log line the state came from was written, or null when there is no log. */
  checkedAt: number | null;
}

export const TEXT_APP_PATH = "/Applications/Arcforma Text.app";
export const TEXT_LABEL = "ai.arcforma.text";

export function textLogPath(): string {
  return process.env["ARCMAIL_TEXT_LOG"] || path.join(os.homedir(), "Library", "Logs", "arcforma-text.log");
}

/**
 * The grant, read from the app's own answer. Arcforma Text writes
 * "accessibility trusted" or "accessibility not trusted" at launch, and that
 * line is the only place another process can honestly learn the answer, so the
 * check restarts the agent first and then reads the newest line.
 */
export function readAccessibility(log = textLogPath()): { state: AccessibilityState; at: number | null } {
  let text: string;
  try {
    text = fs.readFileSync(log, "utf8");
  } catch {
    return { state: "unknown", at: null };
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.includes("accessibility ")) continue;
    const stamp = /^\[([^\]]+)\]/.exec(line)?.[1];
    const at = stamp ? Date.parse(stamp) : NaN;
    if (line.includes("accessibility not trusted")) return { state: "not_granted", at: Number.isFinite(at) ? at : null };
    if (line.includes("accessibility trusted")) return { state: "granted", at: Number.isFinite(at) ? at : null };
  }
  return { state: "unknown", at: null };
}

export function textToolState(): TextToolState {
  const log = textLogPath();
  const { state, at } = readAccessibility(log);
  return {
    installed: fs.existsSync(TEXT_APP_PATH),
    appPath: TEXT_APP_PATH,
    label: TEXT_LABEL,
    logPath: log,
    accessibility: state,
    checkedAt: at,
  };
}

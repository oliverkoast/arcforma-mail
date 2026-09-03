// First-run onboarding: the step order, the field validators, the Google Cloud
// console links, and the reading of daemon health into an AI choice. Pure
// functions with no Node and no DOM, so the renderer, the main process, and
// node:test all share one answer.

import type { AiStatus } from "./types.js";

export type OnboardingStepId = "welcome" | "accounts" | "ai" | "model" | "text" | "done";

/** The order the flow walks. The rail draws one dot per entry, in this order. */
export const ONBOARDING_STEPS: readonly OnboardingStepId[] = ["welcome", "accounts", "ai", "model", "text", "done"];

/** The rail's label for each step. Short enough to sit in a 200 px column. */
export const STEP_TITLES: Record<OnboardingStepId, string> = {
  welcome: "What this is",
  accounts: "Add an account",
  ai: "How AI works",
  model: "The local model",
  text: "The text tool",
  done: "Done",
};

export function stepIndex(id: OnboardingStepId): number {
  const i = ONBOARDING_STEPS.indexOf(id);
  return i < 0 ? 0 : i;
}

export function isStepId(v: unknown): v is OnboardingStepId {
  return typeof v === "string" && (ONBOARDING_STEPS as readonly string[]).includes(v);
}

/** The step after this one. The last step stays put; finishing is a separate act. */
export function nextStepId(id: OnboardingStepId): OnboardingStepId {
  const i = stepIndex(id);
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)] as OnboardingStepId;
}

/** The step before this one, or null on the first. */
export function prevStepId(id: OnboardingStepId): OnboardingStepId | null {
  const i = stepIndex(id);
  return i <= 0 ? null : (ONBOARDING_STEPS[i - 1] as OnboardingStepId);
}

/**
 * Where a launch lands. A quit mid-way comes back to the step that was on
 * screen; a finished setup does not reopen; anything unreadable starts over.
 */
export function resumeStepId(stored: unknown, done: boolean): OnboardingStepId {
  if (done) return "done";
  return isStepId(stored) ? stored : "welcome";
}

export type Validation = { ok: true; value: string } | { ok: false; message: string };

/** Desktop client ids look like 000000000000-abcdef.apps.googleusercontent.com. */
export const CLIENT_ID_PATTERN = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export function validateClientId(raw: string): Validation {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, message: "Paste the client id from the Google Cloud console." };
  if (/\s/.test(value)) return { ok: false, message: "That has a space in it. Paste the client id on its own." };
  if (!value.endsWith(".apps.googleusercontent.com")) return { ok: false, message: "A client id ends in .apps.googleusercontent.com. This one does not, so it is probably the client secret or the project id." };
  if (!CLIENT_ID_PATTERN.test(value)) return { ok: false, message: "A client id reads as digits, a dash, then letters and digits, then .apps.googleusercontent.com. Copy the whole Client ID field." };
  return { ok: true, value };
}

export function validateClientSecret(raw: string): Validation {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, message: "Paste the client secret from the same page." };
  if (/\s/.test(value)) return { ok: false, message: "That has a space in it. Paste the client secret on its own." };
  if (value.endsWith(".apps.googleusercontent.com")) return { ok: false, message: "That is the client id. The secret is the shorter field next to it." };
  return { ok: true, value };
}

/** The slot id written into oauth-clients.json. Derived from the address so nobody has to invent one. */
export function accountIdForEmail(raw: string, taken: readonly string[] = []): string {
  const local = String(raw ?? "").trim().toLowerCase().split("@");
  const domain = (local[1] ?? "").split(".")[0] ?? "";
  const base = (domain || local[0] || "account").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "account";
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

/** Deliberately loose: Google decides what an address is, this only catches a typed-in blank or a missing @. */
export function validateEmail(raw: string): Validation {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return { ok: false, message: "Type the address of the mailbox you are adding." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, message: "That does not read as an email address. It should look like you@example.com." };
  return { ok: true, value };
}

/** A Google Cloud project id: lowercase letters, digits, and dashes. Empty is allowed; the links then drop the project. */
export function validateProjectId(raw: string): Validation {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: true, value: "" };
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(value)) return { ok: false, message: "A project id is 6 to 30 characters: a lowercase letter, then lowercase letters, digits, or dashes. It is under the project name in the console." };
  return { ok: true, value };
}

/** The three APIs the app calls. The bulk enable flow takes them as one comma-separated list. */
export const GOOGLE_APIS = ["gmail.googleapis.com", "calendar-json.googleapis.com", "people.googleapis.com"];

export type ConsoleLink = "createProject" | "enableApis" | "consentScreen" | "credentials";

/** The exact console page for each step, with the project pinned when its id is known. */
export function consoleUrl(link: ConsoleLink, projectId = ""): string {
  const project = validateProjectId(projectId).ok ? projectId.trim() : "";
  const suffix = project ? `?project=${encodeURIComponent(project)}` : "";
  switch (link) {
    case "createProject":
      return "https://console.cloud.google.com/projectcreate";
    case "enableApis":
      return `https://console.cloud.google.com/flows/enableapi?apiid=${GOOGLE_APIS.join(",")}${project ? `&project=${encodeURIComponent(project)}` : ""}`;
    case "consentScreen":
      return `https://console.cloud.google.com/auth/branding${suffix}`;
    case "credentials":
      return `https://console.cloud.google.com/auth/clients${suffix}`;
  }
}

export type AiChoice = "local" | "claude-code" | "api-key";

export interface AiAvailability {
  /** What the AI step selects when nothing has been chosen yet. */
  choice: AiChoice;
  /** The sentence under the heading, saying what was found on this Mac. */
  detail: string;
  /** True when the daemon says Claude already answers here, so no token is needed. */
  claudeReady: boolean;
  /** False when the daemon config is missing or the daemon is not listening. */
  daemonRunning: boolean;
}

/**
 * Daemon health read into the AI step. Three outcomes: no daemon (nothing can
 * be checked, local only still works once it starts), a daemon with Claude
 * signed in (nothing to paste), a daemon with Claude signed out (paste a
 * token or a key, or stay local).
 */
export function aiAvailability(status: AiStatus | null, stored: AiChoice | null = null): AiAvailability {
  if (!status || !status.ok) {
    return {
      choice: stored ?? "local",
      detail: "The AI daemon is not answering on this Mac, so nothing could be checked. Background sorting and Claude both wait for it.",
      claudeReady: false,
      daemonRunning: false,
    };
  }
  if (status.loggedIn) {
    return {
      choice: stored ?? "claude-code",
      detail: `Claude Code is already signed in on this Mac${status.cliVersion ? ` (${status.cliVersion})` : ""}. Summaries, drafts, and Ask work with no token to paste.`,
      claudeReady: true,
      daemonRunning: true,
    };
  }
  return {
    choice: stored ?? "local",
    detail: "The AI daemon runs and Claude is signed out. Paste a Claude Code token or an Anthropic key, or stay on local only.",
    claudeReady: false,
    daemonRunning: true,
  };
}

/** Claude Code tokens from `claude setup-token`. Shape only: the daemon proves it on the first call. */
export function validateClaudeToken(raw: string): Validation {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, message: "Paste the token that `claude setup-token` printed." };
  if (/\s/.test(value)) return { ok: false, message: "That has a space in it. Paste the token on its own." };
  if (value.length < 20) return { ok: false, message: "That is too short to be a token. Run `claude setup-token` again and copy the whole line." };
  return { ok: true, value };
}

export function validateApiKey(raw: string): Validation {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, message: "Paste an Anthropic API key from console.anthropic.com." };
  if (/\s/.test(value)) return { ok: false, message: "That has a space in it. Paste the key on its own." };
  if (!value.startsWith("sk-ant-")) return { ok: false, message: "Anthropic keys start with sk-ant-. Check you copied the key and not the key name." };
  return { ok: true, value };
}

/** Bytes as the size a person would say out loud, for the sentence before a download starts. */
export function readableSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown size";
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export type DownloadPhase = "idle" | "starting" | "downloading" | "done" | "cancelled" | "failed";

/** The model download, as both the main process and the step see it. */
export interface DownloadState {
  phase: DownloadPhase;
  /** Bytes on disk, including anything resumed from a previous run. */
  received: number;
  /** What the whole file weighs, from the catalog and confirmed against the server. Null while unknown. */
  total: number | null;
  /** True when this run continued a part file rather than starting from zero. */
  resumed: boolean;
  /** The finished file, once it is in place. */
  file: string | null;
  /** Why it stopped, for the step to print. Null unless the phase is failed. */
  error: string | null;
}

/** 0 to 100, or null when the total is not known yet. */
export function downloadPercent(state: DownloadState): number | null {
  if (!state.total || state.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((state.received / state.total) * 100)));
}

/** The one line the model step prints under the bar. */
export function downloadLine(state: DownloadState): string {
  switch (state.phase) {
    case "idle":
      return "Nothing downloaded yet.";
    case "starting":
      return state.resumed ? `Asking for the rest of the file, ${readableSize(state.received)} already here.` : "Asking the server for the file.";
    case "downloading":
      return `${readableSize(state.received)} of ${state.total ? readableSize(state.total) : "unknown size"}${state.resumed ? ", carried on from an earlier run" : ""}.`;
    case "done":
      return `Downloaded. The daemon now points at ${state.file ?? "the new file"}.`;
    case "cancelled":
      return `Stopped. ${readableSize(state.received)} is kept, and starting again picks up from there.`;
    case "failed":
      return state.error ?? "The download failed.";
  }
}

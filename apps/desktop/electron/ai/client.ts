// Client for the Arcforma AI daemon (packages/ai-daemon). Reads port and
// bearer token from ~/Library/Application Support/Arcforma/ai-daemon.json,
// talks loopback HTTP, and turns every failure into an AiError with a code the
// UI can render honestly: not_logged_in shows SIGN IN TO CLAUDE CODE and the
// app keeps working.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AiErrorCode, AiStatus } from "../../shared/types.js";

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly status: number | null = null
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface DaemonConfig {
  port: number;
  token: string;
}

export function defaultConfigPath(): string {
  return process.env["ARCMAIL_AI_CONFIG"] || path.join(os.homedir(), "Library", "Application Support", "Arcforma", "ai-daemon.json");
}

export function readDaemonConfig(file = defaultConfigPath()): DaemonConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { port?: unknown; token?: unknown };
    if (typeof raw.port !== "number" || typeof raw.token !== "string" || !raw.token) return null;
    return { port: raw.port, token: raw.token };
  } catch {
    return null;
  }
}

export interface CompleteRequest {
  task?: string;
  system?: string;
  user: string;
  vars?: Record<string, string>;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  requestId?: string;
  json?: boolean;
  /** Claude tools to allow for this call (for example WebSearch). Omitted means none. */
  allowedTools?: string[];
}

export interface CompleteResponse {
  text: string;
  json?: unknown;
  model: string;
  latencyMs: number;
  engine: string;
}

export interface ClassifyRequest {
  text: string;
  schema: unknown;
  vars?: Record<string, string>;
  system?: string;
  task?: string;
  timeoutMs?: number;
}

export interface ClassifyResponse<T = unknown> {
  json: T;
  text: string;
  latencyMs: number;
}

interface DaemonFailure {
  ok: false;
  code?: string;
  error?: string;
}

const CODE_MAP: Record<string, AiErrorCode> = {
  not_logged_in: "not_logged_in",
  model_unsupported: "model_unsupported",
  timeout: "timeout",
  bad_json: "bad_response",
  incomplete: "bad_response",
  empty: "bad_response",
  local_error: "daemon_down",
  local_missing: "daemon_down",
};

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text: () => Promise<string> }>;

export class AiClient {
  private config: DaemonConfig | null = null;
  private readonly configFile: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { configFile?: string; fetch?: FetchLike } = {}) {
    this.configFile = opts.configFile ?? defaultConfigPath();
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Re-reads the config file; the daemon rewrites it when it picks a port. */
  reload(): DaemonConfig | null {
    this.config = readDaemonConfig(this.configFile);
    return this.config;
  }

  private base(): { url: string; token: string } {
    const cfg = this.config ?? this.reload();
    if (!cfg) throw new AiError("daemon_down", `AI daemon config not found at ${this.configFile}. Run packages/ai-daemon/install.sh.`);
    return { url: `http://127.0.0.1:${cfg.port}`, token: cfg.token };
  }

  private async call<T>(pathname: string, init: { method: "GET" | "POST" | "DELETE"; body?: unknown; auth?: boolean; timeoutMs?: number }): Promise<T> {
    const { url, token } = this.base();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.auth !== false) headers["authorization"] = `Bearer ${token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 120_000);
    let res: { status: number; text: () => Promise<string> };
    try {
      res = await this.fetchImpl(url + pathname, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: ctl.signal });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") throw new AiError("timeout", "The AI daemon did not answer in time.");
      // A refused connection means the daemon is not running; the config may also be stale.
      this.config = null;
      throw new AiError("daemon_down", "The AI daemon is not running.");
    }
    clearTimeout(timer);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new AiError("bad_response", `The AI daemon returned something that is not JSON (${res.status}).`, res.status);
    }
    if (res.status === 401 || res.status === 403) {
      this.config = null;
      throw new AiError("unauthorized", "The AI daemon rejected the token. Restart the daemon and the app.", res.status);
    }
    const failure = data as DaemonFailure | null;
    if (res.status >= 400 || (failure && failure.ok === false)) {
      const code = failure?.code ? CODE_MAP[failure.code] ?? "unknown" : res.status === 503 ? "not_logged_in" : res.status === 504 ? "timeout" : "unknown";
      throw new AiError(code, failure?.error || `AI daemon error ${res.status}.`, res.status);
    }
    return data as T;
  }

  async health(): Promise<AiStatus> {
    const h = await this.call<{ ok: boolean; loggedIn?: boolean; claude?: string; local?: string; model?: string; cliVersion?: string }>("/v1/health", { method: "GET", auth: false, timeoutMs: 5000 });
    return { ok: Boolean(h.ok), loggedIn: Boolean(h.loggedIn), claude: h.claude ?? "unknown", local: h.local ?? "unknown", model: h.model ?? null, cliVersion: h.cliVersion ?? null };
  }

  /** Cheap health that never throws: daemon_down is a status, not an exception. */
  async status(): Promise<AiStatus> {
    try {
      return await this.health();
    } catch {
      return { ok: false, loggedIn: false, claude: "daemon_down", local: "unknown", model: null, cliVersion: null };
    }
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const r = await this.call<{ ok: true; text: string; json?: unknown; model: string; latencyMs: number; engine: string }>("/v1/complete", {
      method: "POST",
      body: req,
      timeoutMs: (req.timeoutMs ?? 90_000) + 5000,
    });
    if (typeof r.text !== "string") throw new AiError("bad_response", "The AI daemon returned no text.");
    return { text: r.text, json: r.json, model: r.model, latencyMs: r.latencyMs, engine: r.engine };
  }

  async classify<T = unknown>(req: ClassifyRequest): Promise<ClassifyResponse<T>> {
    const r = await this.call<{ ok: true; text: string; json?: unknown; latencyMs: number }>("/v1/classify", {
      method: "POST",
      body: req,
      timeoutMs: (req.timeoutMs ?? 60_000) + 5000,
    });
    if (r.json === undefined || r.json === null) throw new AiError("bad_response", "The local model returned no JSON.");
    return { json: r.json as T, text: r.text, latencyMs: r.latencyMs };
  }

  async cancel(requestId: string): Promise<void> {
    try {
      await this.call(`/v1/complete/${encodeURIComponent(requestId)}`, { method: "DELETE", timeoutMs: 5000 });
    } catch {
      // Nothing to cancel is fine.
    }
  }
}

/** Turns any thrown value into the failure shape the renderer renders. */
export function toFailure(err: unknown): { ok: false; code: AiErrorCode; error: string } {
  if (err instanceof AiError) return { ok: false, code: err.code, error: err.message };
  return { ok: false, code: "unknown", error: err instanceof Error ? err.message : String(err) };
}

import { GmailApiError, isRateLimit, parseRetryAfter } from "./errors.js";
import { fetchTransport, realSleep, type Sleep, type Transport } from "./transport.js";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_BATCH = "https://www.googleapis.com/batch/gmail/v1";
export const BATCH_SIZE = 25;

/** Quota units per call, from the Gmail API usage limits page. */
export const QUOTA: Record<string, number> = {
  "profile": 1,
  "labels.list": 1,
  "labels.get": 1,
  "labels.create": 5,
  "history.list": 2,
  "messages.list": 5,
  "messages.get": 5,
  "messages.modify": 5,
  "messages.trash": 5,
  "messages.untrash": 5,
  "messages.send": 100,
  "messages.attachments.get": 5,
  "threads.list": 10,
  "threads.get": 10,
  "threads.modify": 10,
  "threads.trash": 10,
  "threads.untrash": 10,
  "drafts.list": 5,
  "drafts.get": 5,
  "drafts.create": 10,
  "drafts.update": 15,
  "drafts.delete": 10,
  "drafts.send": 100,
  "settings.sendAs.list": 1,
};

export function quotaFor(method: string, path: string): number {
  const p = path.replace(/^\/+/, "").split("?")[0] ?? "";
  if (p === "profile") return QUOTA["profile"]!;
  if (p.startsWith("settings/sendAs")) return QUOTA["settings.sendAs.list"]!;
  const [resource, id, action] = p.split("/");
  if (!resource) return 1;
  if (resource === "history") return QUOTA["history.list"]!;
  if (resource === "labels") return method === "POST" ? QUOTA["labels.create"]! : QUOTA["labels.list"]!;
  const ACTIONS = new Set(["send", "modify", "trash", "untrash", "list", "get", "attachments", "batchModify", "batchDelete", "import", "insert"]);
  const verb = id && ACTIONS.has(id) ? id : action ?? (id ? (method === "POST" ? "modify" : "get") : method === "POST" ? "send" : "list");
  const key = resource === "messages" && action === "attachments" ? "messages.attachments.get" : `${resource}.${verb}`;
  return QUOTA[key] ?? 5;
}

/** Token bucket in quota units. Callers may borrow into deficit; the wait time keeps the average at the refill rate. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Reserves units and returns how long to wait before the call may go out. */
  take(units: number): number {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perSecond);
    this.last = t;
    this.tokens -= units;
    if (this.tokens >= 0) return 0;
    return Math.ceil((-this.tokens / this.perSecond) * 1000);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  /** Quota units; defaults from the cost table. */
  cost?: number;
  signal?: AbortSignal;
  /** Override the base URL for non-Gmail Google APIs that share the token. */
  base?: string;
}

export interface BatchRequest {
  method?: "GET" | "POST" | "DELETE";
  path: string;
  query?: RequestOptions["query"];
  body?: unknown;
  cost?: number;
}

export interface BatchResult<T = unknown> {
  status: number;
  body: T | null;
  error: GmailApiError | null;
}

export interface GmailClientOptions {
  /** Returns a valid access token. Called with force=true after a 401 to refresh. */
  accessToken: (force?: boolean) => Promise<string>;
  transport?: Transport;
  sleep?: Sleep;
  now?: () => number;
  unitsPerSecond?: number;
  maxAttempts?: number;
  onRetry?: (info: { attempt: number; waitMs: number; status: number; reason: string | null }) => void;
}

export function buildQuery(query: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

interface ParsedError {
  reason: string | null;
  message: string;
}

function parseError(status: number, text: string): ParsedError {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }>; status?: string } };
    return { reason: j.error?.errors?.[0]?.reason ?? j.error?.status ?? null, message: j.error?.message ?? `HTTP ${status}` };
  } catch {
    return { reason: null, message: text.slice(0, 200) || `HTTP ${status}` };
  }
}

export class GmailClient {
  private readonly transport: Transport;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly bucket: TokenBucket;
  private readonly maxAttempts: number;
  private readonly onRetry: GmailClientOptions["onRetry"];
  private readonly accessToken: GmailClientOptions["accessToken"];

  /** The token source, for sibling Google APIs (Calendar, People) that share this account's login. */
  tokenSource(): GmailClientOptions["accessToken"] { return this.accessToken; }

  constructor(opts: GmailClientOptions) {
    this.accessToken = opts.accessToken;
    this.transport = opts.transport ?? fetchTransport;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    const rate = opts.unitsPerSecond ?? 200;
    this.bucket = new TokenBucket(rate, rate, this.now);
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.onRetry = opts.onRetry;
  }

  backoffMs(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return retryAfterMs;
    const base = Math.min(60_000, 1000 * 2 ** attempt);
    return base + Math.floor(Math.random() * 250);
  }

  private async throttle(cost: number): Promise<void> {
    const wait = this.bucket.take(cost);
    if (wait > 0) await this.sleep(wait);
  }

  /** One REST call against users/me with throttling, auth refresh, and rate-limit backoff. */
  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const url = `${opts.base ?? GMAIL_API}/${path.replace(/^\/+/, "")}${buildQuery(opts.query)}`;
    const cost = opts.cost ?? quotaFor(method, path);
    let forceToken = false;
    for (let attempt = 0; ; attempt++) {
      await this.throttle(cost);
      const token = await this.accessToken(forceToken);
      forceToken = false;
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      const res = await this.transport(url, { method, headers, body, signal: opts.signal });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        return (text ? JSON.parse(text) : null) as T;
      }
      const { reason, message } = parseError(res.status, text);
      if (res.status === 401 && attempt === 0) {
        forceToken = true;
        continue;
      }
      const retryable = isRateLimit(res.status, reason) || res.status >= 500;
      if (retryable && attempt + 1 < this.maxAttempts) {
        const waitMs = this.backoffMs(attempt, parseRetryAfter(res.headers.get("retry-after"), this.now()));
        this.onRetry?.({ attempt, waitMs, status: res.status, reason });
        await this.sleep(waitMs);
        continue;
      }
      throw new GmailApiError(res.status, message, reason, parseRetryAfter(res.headers.get("retry-after"), this.now()));
    }
  }

  /** Runs requests in multipart/mixed batches of 25. Results align with the input order. */
  async batch<T = unknown>(requests: BatchRequest[], signal?: AbortSignal): Promise<BatchResult<T>[]> {
    const out: BatchResult<T>[] = new Array(requests.length);
    for (let start = 0; start < requests.length; start += BATCH_SIZE) {
      const chunk = requests.slice(start, start + BATCH_SIZE);
      const results = await this.runChunk<T>(chunk, signal);
      results.forEach((r, i) => (out[start + i] = r));
    }
    return out;
  }

  private async runChunk<T>(chunk: BatchRequest[], signal?: AbortSignal): Promise<BatchResult<T>[]> {
    const results: BatchResult<T>[] = chunk.map(() => ({ status: 0, body: null, error: null }));
    let pending = chunk.map((_, i) => i);
    for (let attempt = 0; pending.length > 0; attempt++) {
      const cost = pending.reduce((sum, i) => sum + (chunk[i]!.cost ?? quotaFor(chunk[i]!.method ?? "GET", chunk[i]!.path)), 0);
      await this.throttle(cost);
      const token = await this.accessToken(false);
      const boundary = `batch_${Math.random().toString(36).slice(2)}${this.now().toString(36)}`;
      const body = buildBatchBody(boundary, pending.map((i) => ({ id: `item${i}`, req: chunk[i]! })));
      const res = await this.transport(GMAIL_BATCH, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
        body,
        signal,
      });
      const text = await res.text();
      if (res.status !== 200) {
        const { reason, message } = parseError(res.status, text);
        const retryable = isRateLimit(res.status, reason) || res.status >= 500;
        if (retryable && attempt + 1 < this.maxAttempts) {
          const waitMs = this.backoffMs(attempt, parseRetryAfter(res.headers.get("retry-after"), this.now()));
          this.onRetry?.({ attempt, waitMs, status: res.status, reason });
          await this.sleep(waitMs);
          continue;
        }
        throw new GmailApiError(res.status, message, reason);
      }
      const parts = parseBatchResponse(res.headers.get("content-type") ?? "", text);
      const retry: number[] = [];
      let retryAfter: number | null = null;
      for (const idx of pending) {
        const part = parts.get(`item${idx}`);
        if (!part) {
          results[idx] = { status: 0, body: null, error: new GmailApiError(0, "missing batch part") };
          continue;
        }
        if (part.status >= 200 && part.status < 300) {
          results[idx] = { status: part.status, body: (part.body ? JSON.parse(part.body) : null) as T, error: null };
          continue;
        }
        const { reason, message } = parseError(part.status, part.body);
        if ((isRateLimit(part.status, reason) || part.status >= 500) && attempt + 1 < this.maxAttempts) {
          retry.push(idx);
          retryAfter = parseRetryAfter(part.headers["retry-after"] ?? null, this.now()) ?? retryAfter;
        } else {
          results[idx] = { status: part.status, body: null, error: new GmailApiError(part.status, message, reason) };
        }
      }
      pending = retry;
      if (pending.length > 0) {
        const waitMs = this.backoffMs(attempt, retryAfter);
        this.onRetry?.({ attempt, waitMs, status: 429, reason: "batch-part" });
        await this.sleep(waitMs);
      }
    }
    return results;
  }
}

export function buildBatchBody(boundary: string, items: Array<{ id: string; req: BatchRequest }>): string {
  const lines: string[] = [];
  for (const { id, req } of items) {
    const method = req.method ?? "GET";
    const path = `/gmail/v1/users/me/${req.path.replace(/^\/+/, "")}${buildQuery(req.query)}`;
    lines.push(`--${boundary}`, "Content-Type: application/http", `Content-ID: <${id}>`, "", `${method} ${path} HTTP/1.1`);
    if (req.body !== undefined) {
      const json = JSON.stringify(req.body);
      lines.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(json)}`, "", json);
    } else {
      lines.push("");
    }
    lines.push("");
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

export interface BatchPart {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Parses a multipart/mixed batch response into parts keyed by the request Content-ID. */
export function parseBatchResponse(contentType: string, text: string): Map<string, BatchPart> {
  const out = new Map<string, BatchPart>();
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!m) return out;
  const boundary = m[1]!;
  const chunks = text.split(new RegExp(`(?:\\r?\\n)?--${escapeRe(boundary)}(?:--)?(?:\\r?\\n|$)`));
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const split = splitHeaders(chunk);
    if (!split) continue;
    const idHeader = split.headers["content-id"] ?? "";
    const id = idHeader.replace(/^<|>$/g, "").replace(/^response-/, "");
    const http = splitHeaders(split.body);
    if (!http) continue;
    const statusLine = http.statusLine ?? "";
    const status = Number(/HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
    out.set(id, { id, status, headers: http.headers, body: http.body.trim() });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitHeaders(block: string): { statusLine: string | null; headers: Record<string, string>; body: string } | null {
  const trimmed = block.replace(/^\r?\n+/, "");
  const idx = trimmed.search(/\r?\n\r?\n/);
  if (idx === -1) return null;
  const head = trimmed.slice(0, idx);
  const sep = trimmed.slice(idx).match(/^\r?\n\r?\n/)![0].length;
  const body = trimmed.slice(idx + sep);
  const headers: Record<string, string> = {};
  let statusLine: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^HTTP\//.test(line)) {
      statusLine = line;
      continue;
    }
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return { statusLine, headers, body };
}

// The client for the pixel service: register a token before a message goes
// out, and collect what the service has seen since the watermark.
//
// The service is deployed by whoever runs this app, not by this project, so
// every call here has to survive it being absent, wrong, or down. Nothing in
// this file is allowed to fail a send: queueSend calls register and carries on
// without a pixel when it does not answer.

import { hasReceiptAuthToken, receiptAuthToken, type Db } from "@arcforma/store";
import { getSetting } from "@arcforma/store";
import { normaliseServiceUrl } from "./pixel.js";

/** A call that hangs must not hold a send behind it. */
export const RECEIPT_TIMEOUT_MS = 8000;

/** One fetch of a receipt image, as the service reports it. */
export interface ServiceEvent {
  token: string;
  at: number;
  grade: string;
  why?: string;
  userAgent?: string;
}

export interface ReceiptConfig {
  /** True when receipts are switched on in Settings. */
  enabled: boolean;
  url: string;
  authToken: string;
}

/** What Settings says right now. Read fresh on every call, so changing it takes effect at once. */
export function receiptConfig(db: Db): ReceiptConfig {
  return {
    enabled: getSetting(db, "readReceipts") === true,
    url: normaliseServiceUrl(getSetting(db, "readReceiptsUrl")),
    authToken: receiptAuthToken(db),
  };
}

/** True when a message can actually be armed: switched on, a service to talk to, and a token to talk with. */
export function receiptsUsable(db: Db): boolean {
  const c = receiptConfig(db);
  return c.enabled && c.url.length > 0 && hasReceiptAuthToken(db);
}

export type Fetcher = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

/** node:test has no window; the global fetch is the one the app uses and the one a test replaces. */
const defaultFetch = (() => globalThis.fetch as unknown as Fetcher)();

export interface ReceiptServiceOptions {
  fetchImpl?: Fetcher;
  timeoutMs?: number;
  now?: () => number;
}

/** Plain words for a person, not a status code. Both fields are shown as written. */
export interface ReceiptCheck {
  ok: boolean;
  text: string;
}

export class ReceiptService {
  private readonly fetchImpl: Fetcher;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly db: Db, opts: ReceiptServiceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? RECEIPT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  config(): ReceiptConfig {
    return receiptConfig(this.db);
  }

  private async call(path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: unknown }> {
    const c = this.config();
    if (!c.url) throw new Error("No pixel service URL is set.");
    if (!c.authToken) throw new Error("No pixel service token is stored.");
    const res = await this.fetchImpl(`${c.url}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${c.authToken}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // A gateway page instead of JSON is a reachability problem, and the status says so.
    }
    return { status: res.status, body };
  }

  /**
   * Tells the service a message is going out. Throws on anything but a 200, so
   * the caller can send without a pixel and say the receipt was not armed.
   */
  async register(token: string, sentAt: number): Promise<void> {
    const { status } = await this.call("/register", { method: "POST", body: JSON.stringify({ token, sentAt }) });
    if (status === 401) throw new Error("The pixel service rejected the token.");
    if (status !== 200) throw new Error(`The pixel service answered ${status}.`);
  }

  /** Everything the service has recorded after `since`. */
  async events(since: number): Promise<ServiceEvent[]> {
    const { status, body } = await this.call(`/events?since=${Math.max(0, Math.round(since))}`);
    if (status === 401) throw new Error("The pixel service rejected the token.");
    if (status !== 200) throw new Error(`The pixel service answered ${status}.`);
    return readEvents(body);
  }

  /**
   * Test the connection. The service has no health route on purpose, so this
   * asks for events since now: an empty list from an authenticated call is
   * proof the URL and the token are both right.
   */
  async check(): Promise<ReceiptCheck> {
    const c = this.config();
    if (!c.url) return { ok: false, text: "No service URL yet. Deploy one from packages/pixel-service and paste its address above." };
    if (!c.authToken) return { ok: false, text: "No token stored yet. Paste the same value you set as PIXEL_AUTH_TOKEN on the service." };
    try {
      const { status } = await this.call(`/events?since=${this.now()}`);
      if (status === 200) return { ok: true, text: `${c.url} answered. The URL and the token are both right.` };
      if (status === 401) return { ok: false, text: "The service answered, but it rejected the token. Check it matches PIXEL_AUTH_TOKEN on the service." };
      if (status === 404) return { ok: false, text: "The address answered but has no /events route on it. Check the URL points at the pixel service itself." };
      return { ok: false, text: `The service answered ${status}. Nothing is armed until it answers 200.` };
    } catch (err) {
      const message = (err as Error).message || "the request failed";
      return { ok: false, text: `Could not reach ${c.url}: ${message}` };
    }
  }
}

/** Reads the service's answer defensively: a shape we do not recognise yields nothing rather than a guess. */
export function readEvents(body: unknown): ServiceEvent[] {
  const list = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(list)) return [];
  const out: ServiceEvent[] = [];
  for (const raw of list) {
    const e = raw as { token?: unknown; at?: unknown; grade?: unknown; why?: unknown; userAgent?: unknown };
    if (typeof e.token !== "string" || typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    const grade = e.grade === "opened" || e.grade === "automatic" || e.grade === "unknown" ? e.grade : "unknown";
    out.push({ token: e.token, at: e.at, grade, why: typeof e.why === "string" ? e.why : "", userAgent: typeof e.userAgent === "string" ? e.userAgent : "" });
  }
  return out;
}

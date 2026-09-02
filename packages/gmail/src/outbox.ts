// Drains local mutations to Gmail, one account at a time, in id order. The
// store owns the rows; this module executes a job and reports back so the
// store can ack it or schedule a retry.

import type { GmailClient } from "./client.js";
import { GmailApiError, AuthExpiredError } from "./errors.js";

export type OutboxOp = "modifyLabels" | "trash" | "untrash" | "send" | "draftUpsert" | "draftDelete";

export interface OutboxJob {
  id: number;
  op: OutboxOp;
  payload: unknown;
  attempts: number;
}

export interface ModifyLabelsPayload {
  threadId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  addLabelNames?: string[];
  removeLabelNames?: string[];
}

export interface SendPayload {
  raw: string;
  threadId?: string | null;
}

export interface DraftUpsertPayload {
  draftId: number;
  raw: string;
  threadId?: string | null;
  gmailDraftId?: string | null;
}

export interface DraftDeletePayload {
  gmailDraftId: string;
}

/** What drafts.create and drafts.update hand back. `gone` means the draft to update no longer exists in Gmail. */
export interface DraftUpsertResult {
  draftId: number;
  gmailDraftId: string | null;
  gmailMessageId: string | null;
  gone: boolean;
}

export type OutboxOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; retryAt: number | null; authExpired?: boolean };

interface LabelListResponse {
  labels?: Array<{ id: string; name: string; type?: string }>;
}

/** Resolves label names to ids, creating user labels on first use. */
export class LabelResolver {
  private cache: Map<string, string> | null = null;
  constructor(private readonly client: GmailClient) {}

  async list(): Promise<Array<{ id: string; name: string; type: string }>> {
    const res = await this.client.request<LabelListResponse>("labels");
    const labels = (res.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type ?? "user" }));
    this.cache = new Map(labels.map((l) => [l.name, l.id]));
    return labels;
  }

  invalidate(): void {
    this.cache = null;
  }

  async idFor(name: string): Promise<string> {
    if (!this.cache) await this.list();
    const hit = this.cache!.get(name);
    if (hit) return hit;
    const created = await this.client.request<{ id: string; name: string }>("labels", {
      method: "POST",
      body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    this.cache!.set(name, created.id);
    return created.id;
  }
}

/** Backoff for a failed drain attempt: 2 s, 8 s, 32 s, then capped at 5 min. */
export function retryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, 2000 * 4 ** Math.max(0, attempt - 1));
}

export async function executeOutboxOp(client: GmailClient, labels: LabelResolver, job: OutboxJob, now = Date.now()): Promise<OutboxOutcome> {
  try {
    switch (job.op) {
      case "modifyLabels": {
        const p = job.payload as ModifyLabelsPayload;
        const add = [...(p.addLabelIds ?? [])];
        const remove = [...(p.removeLabelIds ?? [])];
        for (const name of p.addLabelNames ?? []) add.push(await labels.idFor(name));
        for (const name of p.removeLabelNames ?? []) remove.push(await labels.idFor(name));
        if (add.length === 0 && remove.length === 0) return { ok: true, result: null };
        const result = await client.request(`threads/${encodeURIComponent(p.threadId)}/modify`, {
          method: "POST",
          body: { addLabelIds: add, removeLabelIds: remove },
        });
        return { ok: true, result };
      }
      case "trash":
      case "untrash": {
        const p = job.payload as { threadId: string };
        const result = await client.request(`threads/${encodeURIComponent(p.threadId)}/${job.op}`, { method: "POST" });
        return { ok: true, result };
      }
      case "send": {
        const p = job.payload as SendPayload;
        const body: Record<string, string> = { raw: p.raw };
        if (p.threadId) body["threadId"] = p.threadId;
        const result = await client.request("messages/send", { method: "POST", body, cost: 100 });
        return { ok: true, result };
      }
      case "draftUpsert": {
        const p = job.payload as DraftUpsertPayload;
        const message: Record<string, string> = { raw: p.raw };
        if (p.threadId) message["threadId"] = p.threadId;
        type Wire = { id: string; message?: { id?: string; threadId?: string } };
        if (p.gmailDraftId) {
          try {
            const updated = await client.request<Wire>(`drafts/${encodeURIComponent(p.gmailDraftId)}`, { method: "PUT", body: { id: p.gmailDraftId, message }, cost: 15 });
            const result: DraftUpsertResult = { draftId: p.draftId, gmailDraftId: updated.id, gmailMessageId: updated.message?.id ?? null, gone: false };
            return { ok: true, result };
          } catch (err) {
            // The Gmail draft went away between the edit and the drain (deleted or sent over there).
            // Deleting in either place deletes in the other, so the local row goes rather than a copy coming back.
            if (err instanceof GmailApiError && err.status === 404) {
              const result: DraftUpsertResult = { draftId: p.draftId, gmailDraftId: p.gmailDraftId, gmailMessageId: null, gone: true };
              return { ok: true, result };
            }
            throw err;
          }
        }
        const created = await client.request<Wire>("drafts", { method: "POST", body: { message }, cost: 10 });
        const result: DraftUpsertResult = { draftId: p.draftId, gmailDraftId: created.id, gmailMessageId: created.message?.id ?? null, gone: false };
        return { ok: true, result };
      }
      case "draftDelete": {
        const p = job.payload as DraftDeletePayload;
        try {
          await client.request(`drafts/${encodeURIComponent(p.gmailDraftId)}`, { method: "DELETE", cost: 10 });
        } catch (err) {
          // Already gone is the outcome that was wanted.
          if (!(err instanceof GmailApiError && err.status === 404)) throw err;
        }
        return { ok: true, result: null };
      }
    }
  } catch (err) {
    if (err instanceof AuthExpiredError) return { ok: false, error: err.message, retryAt: null, authExpired: true };
    if (err instanceof GmailApiError) {
      // 404 on a thread that is gone, or a 400 the API will never accept, is terminal.
      const terminal = err.status === 400 || err.status === 404 || (err.status === 403 && !err.reason?.includes("ateLimit"));
      if (terminal) return { ok: false, error: `${err.status} ${err.message}`, retryAt: null };
      return { ok: false, error: `${err.status} ${err.message}`, retryAt: now + (err.retryAfterMs ?? retryDelayMs(job.attempts + 1)) };
    }
    return { ok: false, error: (err as Error).message, retryAt: now + retryDelayMs(job.attempts + 1) };
  }
}

export interface DrainSource {
  next(): OutboxJob | null;
  ack(id: number, result: unknown): void;
  fail(id: number, error: string, retryAt: number | null, authExpired?: boolean): void;
  markInflight(id: number): void;
}

/** Serial drain for one account. Stops at the first row that needs to wait, so order is preserved. */
export async function drainAccount(client: GmailClient, labels: LabelResolver, source: DrainSource, opts: { max?: number; now?: () => number } = {}): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  const max = opts.max ?? 50;
  const now = opts.now ?? Date.now;
  for (let i = 0; i < max; i++) {
    const job = source.next();
    if (!job) break;
    source.markInflight(job.id);
    const outcome = await executeOutboxOp(client, labels, job, now());
    if (outcome.ok) {
      source.ack(job.id, outcome.result);
      done += 1;
    } else {
      source.fail(job.id, outcome.error, outcome.retryAt, outcome.authExpired);
      failed += 1;
      if (outcome.authExpired) break;
      if (outcome.retryAt !== null) break;
    }
  }
  return { done, failed };
}

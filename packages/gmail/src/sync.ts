// Backfill: newest-first threads.list over the last 90 days, threads.get in
// metadata batches of 25. profile.historyId is recorded before the first list
// call so the history poll picks up exactly where the snapshot was taken.

import type { GmailClient } from "./client.js";
import { GmailApiError } from "./errors.js";
import type { GmailThread } from "./mime.js";
import { getProfile } from "./owners.js";

export const METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Reply-To",
  "Subject",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
  "List-Id",
  "List-Unsubscribe",
  "Precedence",
  "Auto-Submitted",
  "X-Autoreply",
  "Content-Type",
];

export const BACKFILL_QUERY = (days: number) => `-in:spam -in:trash newer_than:${days}d`;

export interface BackfillProgress {
  /** Threads written so far in this run. */
  done: number;
  /** Gmail's estimate of matching threads; null until the first page. */
  estimate: number | null;
  page: number;
  finished: boolean;
}

export interface BackfillSink {
  /** Called once, before the first list call, with the watermark for history.list. */
  onHistoryId(historyId: string): void;
  onThreads(threads: GmailThread[]): void;
  /** Persist the next page token so a restart resumes here. Null means the backfill completed. */
  onCursor(cursor: string | null): void;
  onProgress?(progress: BackfillProgress): void;
}

export interface BackfillOptions {
  client: GmailClient;
  days?: number;
  cursor?: string | null;
  pageSize?: number;
  signal?: AbortSignal;
  /** Total already done from a previous run, for progress continuity. */
  doneSoFar?: number;
}

interface ThreadsListResponse {
  threads?: Array<{ id: string; historyId?: string; snippet?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export async function fetchThreadsMetadata(client: GmailClient, ids: string[], signal?: AbortSignal): Promise<GmailThread[]> {
  const results = await client.batch<GmailThread>(
    ids.map((id) => ({ path: `threads/${encodeURIComponent(id)}`, query: { format: "metadata", metadataHeaders: METADATA_HEADERS }, cost: 10 })),
    signal
  );
  const out: GmailThread[] = [];
  for (const r of results) {
    if (r.body && !r.error) {
      out.push(r.body);
      continue;
    }
    // A 404 means the thread vanished between list and get; skip it. Anything
    // else (a rate limit past the retry budget, a 5xx, a missing part) must
    // fail the page, or the cursor advances and the thread is never fetched.
    if (r.error && r.error.status === 404) continue;
    throw r.error ?? new GmailApiError(r.status, "batch part returned no body");
  }
  return out;
}

export interface ThreadFetchOutcome {
  threads: GmailThread[];
  /** Threads whose part failed with something other than a 404, with the error, for the caller to retry later. */
  failed: Array<{ id: string; error: GmailApiError }>;
}

/**
 * The tolerant form for the history poll: every thread that came back is
 * returned, a vanished thread is skipped, and any other failure is reported
 * per thread instead of failing the batch. One bad thread must not hold the
 * watermark back for every other change in the page.
 */
export async function fetchThreadsMetadataPartial(client: GmailClient, ids: string[], signal?: AbortSignal): Promise<ThreadFetchOutcome> {
  const results = await client.batch<GmailThread>(
    ids.map((id) => ({ path: `threads/${encodeURIComponent(id)}`, query: { format: "metadata", metadataHeaders: METADATA_HEADERS }, cost: 10 })),
    signal
  );
  const out: ThreadFetchOutcome = { threads: [], failed: [] };
  results.forEach((r, i) => {
    if (r.body && !r.error) {
      out.threads.push(r.body);
      return;
    }
    if (r.error && r.error.status === 404) return;
    out.failed.push({ id: ids[i]!, error: r.error ?? new GmailApiError(r.status, "batch part returned no body") });
  });
  return out;
}

export async function fetchThreadFull(client: GmailClient, id: string, signal?: AbortSignal): Promise<GmailThread> {
  return client.request<GmailThread>(`threads/${encodeURIComponent(id)}`, { query: { format: "full" }, signal });
}

export async function fetchMessageFull(client: GmailClient, id: string, signal?: AbortSignal) {
  return client.request<import("./mime.js").GmailMessage>(`messages/${encodeURIComponent(id)}`, { query: { format: "full" }, signal });
}

/** Runs the backfill from the given cursor. Returns the thread count written in this run. */
export async function backfill(opts: BackfillOptions, sink: BackfillSink): Promise<{ threads: number; finished: boolean }> {
  const { client } = opts;
  const days = opts.days ?? 90;
  let cursor = opts.cursor ?? null;
  let done = opts.doneSoFar ?? 0;
  let page = 0;
  if (!cursor) {
    const profile = await getProfile(client);
    sink.onHistoryId(profile.historyId);
  }
  for (;;) {
    if (opts.signal?.aborted) return { threads: done, finished: false };
    const list = await client.request<ThreadsListResponse>("threads", {
      query: { q: BACKFILL_QUERY(days), maxResults: opts.pageSize ?? 100, pageToken: cursor ?? undefined },
      signal: opts.signal,
    });
    page += 1;
    const ids = (list.threads ?? []).map((t) => t.id);
    if (ids.length > 0) {
      const threads = await fetchThreadsMetadata(client, ids, opts.signal);
      sink.onThreads(threads);
      done += threads.length;
    }
    cursor = list.nextPageToken ?? null;
    sink.onCursor(cursor);
    sink.onProgress?.({ done, estimate: list.resultSizeEstimate ?? null, page, finished: cursor === null });
    if (!cursor) return { threads: done, finished: true };
  }
}

// Incremental sync: history.list from the per-account watermark. Records are
// normalized into flat changes in the order Gmail lists them. A 404 means the
// watermark is older than Gmail keeps, and the caller reruns a backfill.

import type { GmailClient } from "./client.js";
import { GmailApiError, HistoryExpiredError } from "./errors.js";

export type HistoryChangeType = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";

export interface HistoryChange {
  type: HistoryChangeType;
  historyId: string;
  messageId: string;
  threadId: string;
  labelIds?: string[];
  changedLabelIds?: string[];
}

interface HistoryMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
}

export interface HistoryRecord {
  id: string;
  messages?: HistoryMessage[];
  messagesAdded?: Array<{ message: HistoryMessage }>;
  messagesDeleted?: Array<{ message: HistoryMessage }>;
  labelsAdded?: Array<{ message: HistoryMessage; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: HistoryMessage; labelIds: string[] }>;
}

export interface HistoryPage {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId: string;
}

export const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"];

export function normalizeHistory(page: HistoryPage): HistoryChange[] {
  const out: HistoryChange[] = [];
  for (const rec of page.history ?? []) {
    for (const a of rec.messagesAdded ?? []) {
      out.push({ type: "messageAdded", historyId: rec.id, messageId: a.message.id, threadId: a.message.threadId, labelIds: a.message.labelIds ?? [] });
    }
    for (const l of rec.labelsAdded ?? []) {
      out.push({ type: "labelAdded", historyId: rec.id, messageId: l.message.id, threadId: l.message.threadId, changedLabelIds: l.labelIds });
    }
    for (const l of rec.labelsRemoved ?? []) {
      out.push({ type: "labelRemoved", historyId: rec.id, messageId: l.message.id, threadId: l.message.threadId, changedLabelIds: l.labelIds });
    }
    for (const d of rec.messagesDeleted ?? []) {
      out.push({ type: "messageDeleted", historyId: rec.id, messageId: d.message.id, threadId: d.message.threadId });
    }
  }
  return out;
}

export interface PullHistoryOptions {
  client: GmailClient;
  startHistoryId: string;
  signal?: AbortSignal;
  onPage?: (changes: HistoryChange[]) => void;
}

/** Pulls every page since the watermark. Throws HistoryExpiredError on 404. */
export async function pullHistory(opts: PullHistoryOptions): Promise<{ changes: HistoryChange[]; historyId: string }> {
  const changes: HistoryChange[] = [];
  let pageToken: string | undefined;
  let historyId = opts.startHistoryId;
  for (;;) {
    let page: HistoryPage;
    try {
      page = await opts.client.request<HistoryPage>("history", {
        query: { startHistoryId: opts.startHistoryId, historyTypes: HISTORY_TYPES, pageToken, maxResults: 500 },
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) throw new HistoryExpiredError();
      throw err;
    }
    const batch = normalizeHistory(page);
    changes.push(...batch);
    opts.onPage?.(batch);
    if (page.historyId) historyId = page.historyId;
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return { changes, historyId };
}

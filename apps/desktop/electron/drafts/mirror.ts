// Local drafts and Gmail drafts are one list. Outbound: every local draft is
// pushed through users.drafts (create, then update by id) with the same RFC
// 822 the send path builds, via the outbox so it is serial per account,
// retried, and fine offline. Inbound: a DRAFT-labelled message the app did
// not write is fetched and becomes a local draft with origin gmail; an edit
// made in Gmail replaces the local text unless something was typed here in
// the last minute, in which case the local text goes up instead. Deleting in
// either place deletes in the other.
//
// Sending: the local row goes when the message is queued, the Gmail draft
// goes once the send has succeeded (scheduler.ts). Undo and a failed send put
// the row back, still tied to the Gmail draft, and mirror it again.

import { buildRawMessage, getGmailDraft, importGmailDraft, listGmailDrafts, type DraftUpsertResult, type GmailClient } from "@arcforma/gmail";
import {
  deleteDraft,
  dropPendingDraftUpserts,
  enqueueDraftUpsert,
  enqueueOutbox,
  getDraft,
  hasOpenDraftUpsert,
  knownGmailMessageIds,
  listMirroredDrafts,
  queuedGmailDraftIds,
  saveDraft,
  setDraftMirror,
  upsertGmailDraft,
  type Db,
  type DraftRow,
  type DraftUpsertPayload,
  type HistoryChange,
} from "@arcforma/store";
import { senderFor, signatureFor } from "../compose/queue.js";
import { log, logError } from "../log.js";
import { MirrorDebounce } from "./debounce.js";
import type { Address, ComposeDraft } from "../../shared/types.js";

/** An edit made here inside this window beats an edit made in Gmail at the same time. */
export const LOCAL_WINS_MS = 60_000;

function addresses(json: string): Address[] {
  return JSON.parse(json) as Address[];
}

/** The RFC 822 for a draft row: body, signature, quoted history, threading headers, exactly as it would be sent. */
export async function buildDraftRaw(db: Db, row: DraftRow, signatureHtml?: string | null): Promise<string> {
  const built = await buildRawMessage({
    from: senderFor(db, row.account_id),
    to: addresses(row.to_json),
    cc: addresses(row.cc_json),
    bcc: addresses(row.bcc_json),
    subject: row.subject,
    html: row.body_html.trim() || "<p></p>",
    quotedHtml: row.quoted_html,
    inReplyTo: row.in_reply_to,
    references: row.references_header,
    signatureHtml: signatureHtml === undefined ? signatureFor(db, row.account_id) : signatureHtml,
  });
  return built.raw;
}

/**
 * Queues the draft for Gmail. The outbox row carries the message built now;
 * a row already waiting for the same draft is replaced, so the drain sends
 * one call with the latest text. Returns the outbox id, or null when the
 * draft is gone.
 */
export async function mirrorDraft(db: Db, draftId: number, opts: { signatureHtml?: string | null } = {}): Promise<number | null> {
  const row = getDraft(db, draftId);
  if (!row) return null;
  const raw = await buildDraftRaw(db, row, opts.signatureHtml);
  const payload: DraftUpsertPayload = { draftId: row.id, raw, threadId: row.thread_id, gmailDraftId: row.gmail_draft_id };
  const outboxId = enqueueDraftUpsert(db, row.account_id, payload);
  setDraftMirror(db, row.id, { state: "pending" });
  return outboxId;
}

/** Puts a draft back after an undone or failed send, tied to the Gmail draft it had, and queues the mirror. */
export async function restoreDraft(db: Db, draft: ComposeDraft, gmailDraftId: string | null): Promise<number> {
  const id = saveDraft(db, {
    accountId: draft.accountId,
    threadId: draft.threadId ?? null,
    mode: draft.mode,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
    quotedHtml: draft.quotedHtml,
    inReplyTo: draft.inReplyTo ?? null,
    references: draft.references ?? null,
    gmailDraftId,
  });
  await mirrorDraft(db, id);
  return id;
}

export interface DiscardResult {
  accountId: string;
  /** True when a Gmail delete was queued, so the caller pokes the drain. */
  queued: boolean;
}

/** Discard: the local row goes, any waiting mirror goes, and the Gmail draft is deleted through the outbox. */
export function discardDraft(db: Db, draftId: number): DiscardResult | null {
  const row = getDraft(db, draftId);
  if (!row) return null;
  dropPendingDraftUpserts(db, draftId);
  deleteDraft(db, draftId);
  if (!row.gmail_draft_id) return { accountId: row.account_id, queued: false };
  enqueueOutbox(db, { accountId: row.account_id, op: "draftDelete", payload: { gmailDraftId: row.gmail_draft_id } });
  return { accountId: row.account_id, queued: true };
}

/**
 * Send: the local row leaves the drafts table now (the message lives in the
 * send queue) and the Gmail draft id comes back so the queue can delete it
 * once the send succeeds, or hand it back if the send is undone.
 */
export function detachDraftForSend(db: Db, draftId: number): string | null {
  const row = getDraft(db, draftId);
  if (!row) return null;
  dropPendingDraftUpserts(db, draftId);
  deleteDraft(db, draftId);
  return row.gmail_draft_id;
}

export interface DraftAckOutcome {
  accountId: string;
  /** The local row changed in a way the Drafts view shows. */
  changed: boolean;
}

/** Records what drafts.create or drafts.update returned. */
export function applyDraftUpsertAck(db: Db, accountId: string, result: DraftUpsertResult): DraftAckOutcome {
  const row = getDraft(db, result.draftId);
  if (result.gone) {
    // Deleted or sent in Gmail while the edit was in flight: deletion wins, the local row goes.
    if (row) {
      dropPendingDraftUpserts(db, row.id);
      deleteDraft(db, row.id);
      log("drafts", `draft ${row.id} vanished in Gmail while updating; dropped locally`);
    }
    return { accountId, changed: Boolean(row) };
  }
  if (!row) {
    // Sent or discarded while the create was in flight: the copy Gmail just made is an orphan.
    if (result.gmailDraftId) enqueueOutbox(db, { accountId, op: "draftDelete", payload: { gmailDraftId: result.gmailDraftId } });
    return { accountId, changed: false };
  }
  // Another edit is already waiting behind this one; the row stays Saving until it lands.
  const state = hasOpenDraftUpsert(db, row.id) ? "pending" : "synced";
  setDraftMirror(db, row.id, { gmailDraftId: result.gmailDraftId, gmailMessageId: result.gmailMessageId, state, error: null });
  return { accountId, changed: true };
}

/** A mirror attempt failed: terminal failures read Not in Gmail with the reason, retries keep reading Saving. */
export function applyDraftUpsertFail(db: Db, payload: DraftUpsertPayload, error: string, terminal: boolean): void {
  const row = getDraft(db, payload.draftId);
  if (!row) return;
  setDraftMirror(db, row.id, { state: terminal ? "failed" : "pending", error });
}

/**
 * Whether a history batch touched drafts on the Gmail side: a DRAFT message
 * the app did not write appeared, or a message behind a mirrored draft went
 * away or lost its DRAFT label (deleted or sent over there).
 */
export function draftsNeedReconcile(db: Db, accountId: string, changes: HistoryChange[]): boolean {
  if (changes.length === 0) return false;
  const known = knownGmailMessageIds(db, accountId);
  for (const ch of changes) {
    const labels = ch.type === "messageAdded" ? ch.labelIds ?? [] : ch.changedLabelIds ?? [];
    const draftLabel = labels.includes("DRAFT");
    if ((ch.type === "messageAdded" || ch.type === "labelAdded") && draftLabel && !known.has(ch.messageId)) return true;
    if ((ch.type === "messageDeleted" || (ch.type === "labelRemoved" && draftLabel)) && known.has(ch.messageId)) return true;
  }
  return false;
}

export interface ReconcileResult {
  imported: number;
  /** Local rows replaced by a Gmail-side edit. */
  updated: number;
  /** Local rows dropped because the Gmail draft is gone. */
  dropped: number;
  /** Local edits queued because they were newer than the Gmail-side edit. */
  pushed: number;
}

export interface ReconcileOptions {
  ownerAddresses?: string[];
  now?: number;
  signal?: AbortSignal;
}

/** Makes the local drafts table agree with users.drafts.list, one account at a time. */
export async function reconcileGmailDrafts(db: Db, accountId: string, client: GmailClient, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now();
  const result: ReconcileResult = { imported: 0, updated: 0, dropped: 0, pushed: 0 };
  const remote = await listGmailDrafts(client, opts.signal);
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const local = listMirroredDrafts(db, accountId);
  const localByGmail = new Map(local.map((l) => [l.gmail_draft_id!, l]));
  const queued = queuedGmailDraftIds(db, accountId);

  for (const l of local) {
    if (remoteById.has(l.gmail_draft_id!)) continue;
    // Gone in Gmail: deleted there, or sent there. Either way it is no longer a draft.
    dropPendingDraftUpserts(db, l.id);
    deleteDraft(db, l.id);
    result.dropped += 1;
  }

  for (const r of remote) {
    if (queued.has(r.id)) continue;
    const l = localByGmail.get(r.id);
    if (l && l.gmail_message_id === r.message.id) continue;
    if (l && l.local_edited_at !== null && now - l.local_edited_at < LOCAL_WINS_MS) {
      // Edited in both places within the minute: what was typed here goes up.
      await mirrorDraft(db, l.id);
      result.pushed += 1;
      continue;
    }
    const full = await getGmailDraft(client, r.id, opts.signal);
    const imported = importGmailDraft(full, opts.ownerAddresses ?? []);
    if (l) dropPendingDraftUpserts(db, l.id);
    upsertGmailDraft(db, { accountId, ...imported }, now);
    if (l) result.updated += 1;
    else result.imported += 1;
  }
  return result;
}

export function reconcileSummary(r: ReconcileResult): string {
  return `${r.imported} imported, ${r.updated} updated from Gmail, ${r.pushed} pushed, ${r.dropped} dropped`;
}

/** What the mirror host needs from the sync loop. */
export interface MirrorSync {
  poke(accountId: string, delay?: number): void;
}

/**
 * Runs the debounce against the wall clock: each fire builds the draft's
 * message, queues it, and pokes the account's drain.
 */
export class DraftMirror {
  private readonly debounce: MirrorDebounce;
  private readonly accounts = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly sync: MirrorSync,
    private readonly opts: { now?: () => number; quietMs?: number } = {}
  ) {
    this.debounce = new MirrorDebounce(opts.quietMs);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** An edit landed in the drafts table. Flush means mirror now (Esc, park, discard of the previous box). */
  touch(draftId: number, accountId: string, flush = false): void {
    if (this.stopped) return;
    this.accounts.set(draftId, accountId);
    this.debounce.touch(draftId, this.now(), flush);
    this.arm();
  }

  /** The draft is gone (sent or discarded); nothing more goes up for it. */
  cancel(draftId: number): void {
    this.debounce.cancel(draftId);
    this.accounts.delete(draftId);
    this.arm();
  }

  /** Pending fires happen now, for shutdown and tests. */
  async flush(): Promise<void> {
    await this.fire(Number.POSITIVE_INFINITY);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const at = this.debounce.next();
    if (at === null || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire(this.now());
    }, Math.max(0, at - this.now()));
  }

  private async fire(now: number): Promise<void> {
    const ready = this.debounce.take(now);
    const poke = new Set<string>();
    for (const id of ready) {
      const accountId = this.accounts.get(id);
      try {
        const queued = await mirrorDraft(this.db, id);
        if (queued !== null && accountId) poke.add(accountId);
        if (queued === null) this.accounts.delete(id);
      } catch (err) {
        logError("drafts", `mirror draft ${id}`, err);
      }
    }
    for (const accountId of poke) this.sync.poke(accountId);
    this.arm();
  }
}

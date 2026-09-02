// Per-account sync loop: backfill once, then history.list polling at 45 s
// while the window is focused and 180 s while hidden, plus the outbox drain.
// Accounts run independently; one failing never blocks another. One run per
// account at a time: a poke that lands while a run is in flight is remembered
// and honoured as soon as that run ends.

import { AuthExpiredError, HistoryExpiredError, LabelResolver, backfill, drainAccount, fetchThreadsMetadataPartial, pullHistory, type DraftUpsertResult, type GmailClient, type HistoryChange } from "@arcforma/gmail";
import {
  applyHistory,
  getAccount,
  getDraft,
  hasPendingMask,
  listAccounts,
  markOutboxDone,
  markOutboxFailed,
  markOutboxInflight,
  nextOutbox,
  resetInflightOutbox,
  transaction,
  updateAccount,
  upsertLabels,
  upsertThreadFromGmail,
  type AccountRow,
  type Db,
  type DraftUpsertPayload,
} from "@arcforma/store";
import { applyDraftUpsertAck, applyDraftUpsertFail, draftsNeedReconcile, reconcileGmailDrafts, reconcileSummary } from "./drafts/mirror.js";
import { emit } from "./events.js";
import { log, logError } from "./log.js";
import type { AccountsStatus } from "../shared/types.js";

export const POLL_FOCUSED_MS = 45_000;
export const POLL_HIDDEN_MS = 180_000;
/** A thread whose threads.get keeps failing is retried on this many polls, then dropped with a log line. */
export const THREAD_FETCH_ATTEMPTS = 5;

/** What the sync loop needs from the account registry. */
export interface SyncAccounts {
  client(accountId: string): GmailClient | null;
  ownerAddresses(accountId: string): string[];
  status(): AccountsStatus;
  onAuthExpired: ((accountId: string) => void) | null;
}

export interface SyncOptions {
  pollFocusedMs?: number;
  pollHiddenMs?: number;
}

export class SyncManager {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<string, Promise<void>>();
  /** Delay requested by a poke that arrived while the account was mid-run. */
  private pokes = new Map<string, number>();
  private resolvers = new Map<string, LabelResolver>();
  /** Threads a poll could not fetch, with how many times they were tried, per account. Retried at the front of the next poll. */
  private readonly retryFetch = new Map<string, Map<string, number>>();
  private focused = true;
  private stopped = false;
  private readonly pollFocusedMs: number;
  private readonly pollHiddenMs: number;
  /** Called after new or changed threads land, so the classifier can pick them up. */
  onThreadsChanged: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly accounts: SyncAccounts,
    opts: SyncOptions = {}
  ) {
    this.pollFocusedMs = opts.pollFocusedMs ?? POLL_FOCUSED_MS;
    this.pollHiddenMs = opts.pollHiddenMs ?? POLL_HIDDEN_MS;
    accounts.onAuthExpired = (id) => this.cancel(id);
  }

  start(): void {
    const reset = resetInflightOutbox(this.db);
    if (reset) log("sync", `reset ${reset} inflight outbox rows`);
    for (const a of listAccounts(this.db)) if (a.auth_state === "ok") this.schedule(a.id, 250);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pokes.clear();
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (focused) this.pokeAll();
  }

  /** Runs soon for one account, debounced so a burst of local edits becomes one drain. */
  poke(accountId: string, delay = 400): void {
    this.schedule(accountId, delay);
  }

  pokeAll(): void {
    for (const a of listAccounts(this.db)) if (a.auth_state === "ok") this.schedule(a.id, 100);
  }

  /** True while a run for the account is in flight. */
  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  private cancel(accountId: string): void {
    const t = this.timers.get(accountId);
    if (t) clearTimeout(t);
    this.timers.delete(accountId);
    this.pokes.delete(accountId);
  }

  private schedule(accountId: string, delay: number): void {
    if (this.stopped) return;
    if (this.running.has(accountId)) {
      // The run in flight may already be past its drain; remember the poke and rerun right after it.
      this.pokes.set(accountId, Math.min(this.pokes.get(accountId) ?? Number.POSITIVE_INFINITY, delay));
      return;
    }
    this.cancel(accountId);
    this.timers.set(
      accountId,
      setTimeout(() => void this.run(accountId), delay)
    );
  }

  run(accountId: string): Promise<void> {
    const inflight = this.running.get(accountId);
    if (inflight) return inflight;
    const t = this.timers.get(accountId);
    if (t) clearTimeout(t);
    this.timers.delete(accountId);
    const p = this.runOnce(accountId)
      .catch((err) => logError("sync", `${accountId} loop`, err))
      .finally(() => {
        this.running.delete(accountId);
        const poked = this.pokes.get(accountId);
        this.pokes.delete(accountId);
        const row = getAccount(this.db, accountId);
        if (row?.auth_state !== "ok") return;
        this.schedule(accountId, poked ?? (this.focused ? this.pollFocusedMs : this.pollHiddenMs));
      });
    this.running.set(accountId, p);
    return p;
  }

  private async runOnce(accountId: string): Promise<void> {
    const account = getAccount(this.db, accountId);
    if (!account || account.auth_state !== "ok") return;
    const client = this.accounts.client(accountId);
    if (!client) return;
    try {
      try {
        if (account.sync_state === "new" || account.sync_state === "backfill" || !account.history_id) {
          await this.backfill(account, client, 90);
        } else {
          await this.poll(account, client);
        }
      } catch (err) {
        if (!(err instanceof HistoryExpiredError)) throw err;
        // The watermark is older than Gmail keeps. Re-read the last week; local-only
        // state (snoozes, reminders, drafts, categories, pending outbox rows) stays.
        log("sync", `${accountId} history expired, rerunning a 7-day backfill`);
        updateAccount(this.db, accountId, { sync_state: "backfill", backfill_cursor: null, backfill_done: 0, backfill_total: null });
        const fresh = getAccount(this.db, accountId);
        if (fresh) await this.backfill(fresh, client, 7);
      }
      await this.drain(accountId, client);
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        updateAccount(this.db, accountId, { auth_state: "expired", sync_state: "reauth", error: err.message });
        emit("accounts:changed", this.accounts.status());
        this.cancel(accountId);
        return;
      }
      updateAccount(this.db, accountId, { error: (err as Error).message });
      emit("accounts:changed", this.accounts.status());
      throw err;
    }
  }

  private async backfill(account: AccountRow, client: GmailClient, days: number): Promise<void> {
    const id = account.id;
    updateAccount(this.db, id, { sync_state: "backfill", error: null });
    emit("accounts:changed", this.accounts.status());
    emit("sync:progress", { accountId: id, state: "backfill", done: account.backfill_done, total: account.backfill_total, finished: false });
    const owners = this.accounts.ownerAddresses(id);
    log("sync", `${id} backfill start (${days} days, cursor ${account.backfill_cursor ? "resume" : "fresh"})`);
    await backfill(
      { client, days, cursor: account.backfill_cursor, doneSoFar: account.backfill_cursor ? account.backfill_done : 0 },
      {
        onHistoryId: (historyId) => updateAccount(this.db, id, { history_id: historyId }),
        onThreads: (threads) => {
          transaction(this.db, () => {
            for (const t of threads) upsertThreadFromGmail(this.db, id, t, { ownerAddresses: owners });
          });
          emit("threads:changed", { accountId: id });
          this.onThreadsChanged?.();
        },
        onCursor: (cursor) => updateAccount(this.db, id, { backfill_cursor: cursor }),
        onProgress: (p) => {
          updateAccount(this.db, id, { backfill_done: p.done, backfill_total: p.estimate });
          emit("sync:progress", { accountId: id, state: "backfill", done: p.done, total: p.estimate, finished: p.finished });
        },
      }
    );
    await this.refreshLabels(id, client);
    // The drafts Gmail already holds join the local list once the threads they belong to are in.
    await this.reconcileDrafts(id, client);
    updateAccount(this.db, id, { sync_state: "live", backfill_cursor: null, last_sync_at: Date.now(), error: null });
    log("sync", `${id} backfill done`);
    emit("sync:progress", { accountId: id, state: "live", done: 0, total: null, finished: true });
    emit("accounts:changed", this.accounts.status());
  }

  private async poll(account: AccountRow, client: GmailClient): Promise<void> {
    const id = account.id;
    const { changes, historyId } = await pullHistory({ client, startHistoryId: account.history_id! });
    let changed = false;
    // Threads an earlier poll could not fetch come first; a failure there is not this page's problem.
    const retry = Array.from(this.retryFetch.get(id)?.keys() ?? []);
    if (changes.length > 0 || retry.length > 0) {
      const result = changes.length > 0 ? applyHistory(this.db, id, changes) : { threadsToFetch: [], touched: [], masked: 0, lastHistoryId: null };
      changed = result.touched.length > 0;
      const wanted = Array.from(new Set([...retry, ...result.threadsToFetch]));
      if (wanted.length > 0) {
        changed = (await this.fetchThreads(id, client, wanted)) > 0 || changed;
      }
      if (changes.length > 0) log("sync", `${id} history ${account.history_id} -> ${historyId}: ${changes.length} changes, ${result.threadsToFetch.length} fetched, ${result.masked} masked`);
      if (changes.length > 0 && draftsNeedReconcile(this.db, id, changes as HistoryChange[])) await this.reconcileDrafts(id, client);
    }
    // The watermark moves only after every page has been applied and every referenced thread fetched, or put down for a retry.
    updateAccount(this.db, id, { history_id: historyId, last_sync_at: Date.now(), error: null });
    if (changed) {
      emit("threads:changed", { accountId: id });
      this.onThreadsChanged?.();
    }
  }

  /**
   * Fetches thread metadata and writes it. Returns how many threads landed. A
   * thread whose part failed is remembered for the next poll rather than failing
   * the whole page: one bad thread must never hold the watermark, and with it
   * every other change, back for good.
   */
  private async fetchThreads(accountId: string, client: GmailClient, threadIds: string[]): Promise<number> {
    const { threads, failed } = await fetchThreadsMetadataPartial(client, threadIds);
    const owners = this.accounts.ownerAddresses(accountId);
    transaction(this.db, () => {
      for (const t of threads) upsertThreadFromGmail(this.db, accountId, t, { ownerAddresses: owners });
    });
    const retry = this.retryFetch.get(accountId) ?? new Map<string, number>();
    for (const t of threads) retry.delete(t.id);
    for (const f of failed) {
      const attempts = (retry.get(f.id) ?? 0) + 1;
      if (attempts >= THREAD_FETCH_ATTEMPTS) {
        retry.delete(f.id);
        logError("sync", `${accountId} thread ${f.id} gave up after ${attempts} attempts`, f.error);
      } else {
        retry.set(f.id, attempts);
        log("sync", `${accountId} thread ${f.id} not fetched (${f.error.status} ${f.error.message}); retry ${attempts} of ${THREAD_FETCH_ATTEMPTS} on the next poll`);
      }
    }
    if (retry.size > 0) this.retryFetch.set(accountId, retry);
    else this.retryFetch.delete(accountId);
    return threads.length;
  }

  /** Threads waiting for another fetch attempt, for tests and the status line. */
  pendingThreadFetches(accountId: string): string[] {
    return Array.from(this.retryFetch.get(accountId)?.keys() ?? []);
  }

  /** Brings the drafts table in line with users.drafts. A failure here waits for the next history batch that touches drafts. */
  private async reconcileDrafts(accountId: string, client: GmailClient): Promise<void> {
    try {
      const r = await reconcileGmailDrafts(this.db, accountId, client, { ownerAddresses: this.accounts.ownerAddresses(accountId) });
      if (r.imported || r.updated || r.dropped || r.pushed) {
        log("drafts", `${accountId} reconciled: ${reconcileSummary(r)}`);
        emit("drafts:changed", { accountId });
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) throw err;
      logError("drafts", `${accountId} reconcile`, err);
    }
  }

  private async refreshLabels(accountId: string, client: GmailClient): Promise<void> {
    try {
      const labels = await this.resolver(accountId, client).list();
      upsertLabels(this.db, accountId, labels);
    } catch (err) {
      logError("sync", `${accountId} labels`, err);
    }
  }

  private resolver(accountId: string, client: GmailClient): LabelResolver {
    let r = this.resolvers.get(accountId);
    if (!r) {
      r = new LabelResolver(client);
      this.resolvers.set(accountId, r);
    }
    return r;
  }

  private async drain(accountId: string, client: GmailClient): Promise<void> {
    let authExpired = false;
    const acked = new Set<string>();
    let draftsChanged = false;
    const result = await drainAccount(client, this.resolver(accountId, client), {
      next: () => {
        for (;;) {
          const row = nextOutbox(this.db, accountId);
          if (!row) return null;
          const payload = JSON.parse(row.payload_json) as unknown;
          if (row.op === "draftUpsert") {
            // The row was queued before an earlier create for the same draft landed: reuse that id.
            // A draft that was sent or discarded meanwhile has nothing left to mirror.
            const p = payload as DraftUpsertPayload;
            const draft = getDraft(this.db, p.draftId);
            if (!draft) {
              markOutboxDone(this.db, row.id);
              continue;
            }
            p.gmailDraftId = draft.gmail_draft_id;
          }
          return { id: row.id, op: row.op, payload, attempts: row.attempts };
        }
      },
      markInflight: (id) => markOutboxInflight(this.db, id),
      ack: (id, result) => {
        const row = this.db.prepare("SELECT op, payload_json FROM outbox WHERE id = ?").get(id) as { op: string; payload_json: string } | undefined;
        markOutboxDone(this.db, id);
        if (!row) return;
        if (row.op === "draftUpsert") {
          draftsChanged = applyDraftUpsertAck(this.db, accountId, result as DraftUpsertResult).changed || draftsChanged;
          return;
        }
        if (row.op === "draftDelete" || row.op === "send") return;
        const threadId = (JSON.parse(row.payload_json) as { threadId?: string }).threadId;
        if (threadId) acked.add(threadId);
      },
      fail: (id, error, retryAt, expired) => {
        markOutboxFailed(this.db, id, error, retryAt);
        if (expired) authExpired = true;
        log("outbox", `${accountId} #${id} failed: ${error}${retryAt ? ", retrying" : ""}`);
        const row = this.db.prepare("SELECT op, payload_json FROM outbox WHERE id = ?").get(id) as { op: string; payload_json: string } | undefined;
        if (row?.op === "draftUpsert") {
          applyDraftUpsertFail(this.db, JSON.parse(row.payload_json) as DraftUpsertPayload, error, retryAt === null && !expired);
          draftsChanged = true;
          if (retryAt === null && !expired) emit("toast", { eyebrow: "NOT IN GMAIL", text: `A draft did not reach Gmail: ${error}` });
          return;
        }
        if (retryAt === null && !expired) emit("toast", { eyebrow: "NOT SYNCED", text: `A change did not reach Gmail: ${error}` });
      },
    });
    if (draftsChanged) emit("drafts:changed", { accountId });
    if (result.done > 0) {
      log("outbox", `${accountId} drained ${result.done}`);
      emit("threads:changed", { accountId });
    }
    if (authExpired) throw new AuthExpiredError();
    // While a local change was pending, history for its thread was masked and is
    // gone for good. Now that Gmail has the change, re-read those threads so any
    // remote edits made in the meantime (read on the phone, starred on the web) land.
    const reconcile = Array.from(acked).filter((t) => !hasPendingMask(this.db, accountId, t));
    if (reconcile.length > 0) {
      try {
        const n = await this.fetchThreads(accountId, client, reconcile);
        if (n > 0) {
          emit("threads:changed", { accountId });
          this.onThreadsChanged?.();
        }
      } catch (err) {
        // The next poll or drain gets another chance; the local state is already right.
        logError("sync", `${accountId} reconcile after ack`, err);
      }
    }
  }
}

// Per-account sync loop: backfill once, then history.list polling at 45 s
// while the window is focused and 180 s while hidden, plus the outbox drain.
// Accounts run independently; one failing never blocks another. One run per
// account at a time: a poke that lands while a run is in flight is remembered
// and honoured as soon as that run ends.

import { AuthExpiredError, HistoryExpiredError, LabelResolver, backfill, drainAccount, fetchThreadsMetadata, pullHistory, type GmailClient } from "@arcforma/gmail";
import {
  applyHistory,
  getAccount,
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
} from "@arcforma/store";
import { emit } from "./events.js";
import { log, logError } from "./log.js";
import type { AccountsStatus } from "../shared/types.js";

export const POLL_FOCUSED_MS = 45_000;
export const POLL_HIDDEN_MS = 180_000;

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
    updateAccount(this.db, id, { sync_state: "live", backfill_cursor: null, last_sync_at: Date.now(), error: null });
    log("sync", `${id} backfill done`);
    emit("sync:progress", { accountId: id, state: "live", done: 0, total: null, finished: true });
    emit("accounts:changed", this.accounts.status());
  }

  private async poll(account: AccountRow, client: GmailClient): Promise<void> {
    const id = account.id;
    const { changes, historyId } = await pullHistory({ client, startHistoryId: account.history_id! });
    let changed = false;
    if (changes.length > 0) {
      const result = applyHistory(this.db, id, changes);
      changed = result.touched.length > 0;
      if (result.threadsToFetch.length > 0) {
        changed = (await this.fetchThreads(id, client, result.threadsToFetch)) > 0 || changed;
      }
      log("sync", `${id} history ${account.history_id} -> ${historyId}: ${changes.length} changes, ${result.threadsToFetch.length} fetched, ${result.masked} masked`);
    }
    // The watermark moves only after every page has been applied and every referenced thread fetched.
    updateAccount(this.db, id, { history_id: historyId, last_sync_at: Date.now(), error: null });
    if (changed) {
      emit("threads:changed", { accountId: id });
      this.onThreadsChanged?.();
    }
  }

  /** Fetches thread metadata and writes it. Returns how many threads landed. */
  private async fetchThreads(accountId: string, client: GmailClient, threadIds: string[]): Promise<number> {
    const threads = await fetchThreadsMetadata(client, threadIds);
    const owners = this.accounts.ownerAddresses(accountId);
    transaction(this.db, () => {
      for (const t of threads) upsertThreadFromGmail(this.db, accountId, t, { ownerAddresses: owners });
    });
    return threads.length;
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
    const result = await drainAccount(client, this.resolver(accountId, client), {
      next: () => {
        const row = nextOutbox(this.db, accountId);
        return row ? { id: row.id, op: row.op, payload: JSON.parse(row.payload_json) as unknown, attempts: row.attempts } : null;
      },
      markInflight: (id) => markOutboxInflight(this.db, id),
      ack: (id) => {
        const row = this.db.prepare("SELECT op, payload_json FROM outbox WHERE id = ?").get(id) as { op: string; payload_json: string } | undefined;
        markOutboxDone(this.db, id);
        if (row && row.op !== "send") {
          const threadId = (JSON.parse(row.payload_json) as { threadId?: string }).threadId;
          if (threadId) acked.add(threadId);
        }
      },
      fail: (id, error, retryAt, expired) => {
        markOutboxFailed(this.db, id, error, retryAt);
        if (expired) authExpired = true;
        log("outbox", `${accountId} #${id} failed: ${error}${retryAt ? ", retrying" : ""}`);
        if (retryAt === null && !expired) emit("toast", { eyebrow: "NOT SYNCED", text: `A change did not reach Gmail: ${error}` });
      },
    });
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

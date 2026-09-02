// Calendar sync runner: every signed-in account's primary calendar every five
// minutes through packages/gmail syncCalendar (syncToken incremental, 410
// falls back to a full window), written into calendar_events. Nothing here
// touches Claude or the mail sync; accounts run under allSettled, so a failing
// account logs and waits for the next tick while the others carry on.
//
// Google pins the timeMin/timeMax of the first list call to the sync token,
// so an incremental sync never reports events outside the window it started
// with. The token is therefore given a lifetime (WINDOW_REFRESH_MS) and a
// fresh full window is fetched once it lapses, which also drops stale rows
// inside that window and nothing outside it.

import { GmailApiError, isRateLimit, syncCalendar, type GmailClient, type Transport } from "@arcforma/gmail";
import { getCalendarSync, listAccounts, removeCalendarEvents, removeStaleCalendarEvents, setCalendarSync, upsertCalendarEvents, type Db } from "@arcforma/store";
import { emit } from "./events.js";
import { log, logError } from "./log.js";

export const CALENDAR_INTERVAL_MS = 5 * 60 * 1000;
/** How long a sync token (and its frozen window) is trusted before a full window is fetched again. */
export const WINDOW_REFRESH_MS = 24 * 60 * 60 * 1000;
const CALENDAR_ID = "primary";
/** Days ahead the full window covers; the rail shows seven, the picker seven, so two weeks leaves headroom. */
export const WINDOW_DAYS = 14;
/** Days behind, so the contact rail's "last meeting" has something to show. */
export const WINDOW_BEHIND_DAYS = 30;

/** The client's token source, reused so invalid_grant flows through the registry like any Gmail call. */
export function tokenSourceOf(client: GmailClient): (force?: boolean) => Promise<string> {
  return client.tokenSource();
}

/** What the runner needs from the account registry. */
export interface CalendarAccounts {
  client(accountId: string): GmailClient | null;
}

export interface CalendarSyncOptions {
  transport?: Transport;
  now?: () => number;
  /** Awaited between retries inside syncCalendar; tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
}

export class CalendarSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private readonly transport: Transport | undefined;
  private readonly now: () => number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(
    private readonly db: Db,
    private readonly accounts: CalendarAccounts,
    opts: CalendarSyncOptions = {}
  ) {
    this.transport = opts.transport;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runAll(), CALENDAR_INTERVAL_MS);
    void this.runAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runAll(): Promise<void> {
    const ids = listAccounts(this.db)
      .filter((a) => a.auth_state === "ok")
      .map((a) => a.id);
    await Promise.allSettled(ids.map((id) => this.runOne(id)));
  }

  /** True while a run for the account is in flight. */
  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  async runOne(accountId: string): Promise<void> {
    if (this.running.has(accountId)) return;
    const client = this.accounts.client(accountId);
    if (!client) return;
    this.running.add(accountId);
    try {
      const now = this.now();
      const state = getCalendarSync(this.db, accountId, CALENDAR_ID);
      const tokenFresh = Boolean(state?.sync_token) && (state?.sync_token_expires_at ?? 0) > now;
      const result = await syncCalendar({
        accessToken: tokenSourceOf(client),
        syncToken: tokenFresh ? state!.sync_token : null,
        windowDays: WINDOW_DAYS,
        windowBehindDays: WINDOW_BEHIND_DAYS,
        transport: this.transport,
        now: this.now,
        sleep: this.sleep,
      });
      upsertCalendarEvents(this.db, accountId, CALENDAR_ID, result.upserts);
      if (result.removed.length) removeCalendarEvents(this.db, accountId, CALENDAR_ID, result.removed);
      let stale = 0;
      if (result.fullSync) stale = removeStaleCalendarEvents(this.db, accountId, CALENDAR_ID, result.upserts.map((e) => e.id), result.window);
      // A full sync starts a new token lifetime; an incremental one keeps the old expiry so the window still refreshes on schedule.
      const expiresAt = result.fullSync ? now + WINDOW_REFRESH_MS : state?.sync_token_expires_at ?? now + WINDOW_REFRESH_MS;
      setCalendarSync(this.db, accountId, CALENDAR_ID, result.nextSyncToken, expiresAt);
      log("calendar", `${accountId} ${result.fullSync ? "full" : "incremental"}: ${result.upserts.length} upserts, ${result.removed.length + stale} removed`);
      if (result.upserts.length || result.removed.length || stale) emit("calendar:changed", { accountId });
    } catch (err) {
      if (err instanceof GmailApiError && (err.status === 401 || (err.status === 403 && !isRateLimit(err.status, err.reason)))) {
        log("calendar", `${accountId}: calendar scope not granted (${err.status}); sign in again to add it`);
      } else {
        logError("calendar", `${accountId} sync failed`, err);
      }
    } finally {
      this.running.delete(accountId);
    }
  }
}

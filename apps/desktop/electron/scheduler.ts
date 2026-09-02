// 10 second tick: wake snoozes, check reminders, release queued sends, and
// roll Daily 0 and Weekly 0 over when the latest activity opened a new day
// or week (electron/rollover.ts).
//
// A send_queue row is a state machine: queued -> sending -> sent | failed,
// or queued -> cancelled by undo. markSending is a conditional update, so two
// ticks can never pick the same row up, and a row left in "sending" by a
// crash is failed on the next start rather than sent again.

import { createRequire } from "node:module";
import { sendRaw, AuthExpiredError, GmailApiError, isRateLimit } from "@arcforma/gmail";
import {
  dueReminders,
  dueSnoozes,
  enqueueOutbox,
  failInterruptedSends,
  getThread,
  hasNewerInbound,
  bumpThread,
  moveToInbox,
  markSendFailed,
  markSending,
  markSent,
  releasableSends,
  resolveReminder,
  setQueue,
  wakeSnooze,
  listSends,
  pendingOutboxCount,
  type Db,
  type SendQueueRow,
} from "@arcforma/store";
import { sendMeta } from "./compose/queue.js";
import { restoreDraft } from "./drafts/mirror.js";
import { emit } from "./events.js";
import { log, logError } from "./log.js";
import { applyActivity, rolloverToast, type ActivityOutcome } from "./rollover.js";
import type { SyncManager } from "./sync.js";
import type { SchedulerStatus } from "../shared/types.js";
import type { GmailClient } from "@arcforma/gmail";

export const TICK_MS = 10_000;
/** Retry spacing for a send that failed on a transient error, in minutes per attempt, capped. */
export const SEND_RETRY_MAX_MIN = 10;

/** What the scheduler needs from the account registry. */
export interface SchedulerAccounts {
  client(accountId: string): GmailClient | null;
}

export interface SchedulerOptions {
  tickMs?: number;
  now?: () => number;
  /** Runs the platform notification; tests stub it. */
  notify?: (title: string, body: string) => void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private wake: NodeJS.Timeout | null = null;
  private announce: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Activity the renderer or power monitor reported and the boundary check has not consumed yet. */
  private pendingActivity: number | null = null;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly notifyImpl: (title: string, body: string) => void;

  constructor(
    private readonly db: Db,
    private readonly accounts: SchedulerAccounts,
    private readonly sync: Pick<SyncManager, "poke">,
    opts: SchedulerOptions = {}
  ) {
    this.tickMs = opts.tickMs ?? TICK_MS;
    this.now = opts.now ?? Date.now;
    this.notifyImpl = opts.notify ?? notify;
  }

  start(): void {
    const interrupted = this.recoverInterruptedSends();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
    if (interrupted.length > 0) {
      // The renderer is not listening yet at start; say it once the window is up.
      this.announce = setTimeout(() => {
        this.announce = null;
        emit("toast", {
          eyebrow: "NOT SENT",
          text: `${interrupted.length === 1 ? "A message was" : `${interrupted.length} messages were`} interrupted while sending. Check Sent; the draft is back under Drafts.`,
        });
      }, 4000);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.wake) clearTimeout(this.wake);
    if (this.announce) clearTimeout(this.announce);
    this.timer = null;
    this.wake = null;
    this.announce = null;
  }

  /** Rows stuck in "sending" from a crash: fail them, put the drafts back, never resend. */
  recoverInterruptedSends(): SendQueueRow[] {
    const rows = failInterruptedSends(this.db, this.now());
    for (const row of rows) {
      log("scheduler", `send ${row.id} was interrupted; failed without resending`);
      void this.restoreDraft(row);
    }
    return rows;
  }

  /** Ticks right after `at` so an undo window ends on time instead of on the next 10 s tick. */
  wakeSoon(at: number): void {
    if (!this.timer) return;
    if (this.wake) clearTimeout(this.wake);
    this.wake = setTimeout(() => {
      this.wake = null;
      void this.tick();
    }, Math.max(50, at - this.now() + 100));
  }

  status(): SchedulerStatus {
    const now = this.now();
    return {
      snoozes: (this.db.prepare("SELECT COUNT(*) AS n FROM snoozes WHERE status = 'pending'").get() as unknown as { n: number }).n,
      reminders: (this.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending'").get() as unknown as { n: number }).n,
      queuedSends: listSends(this.db, "queued").filter((s) => s.send_at > now).length,
      pendingOutbox: pendingOutboxCount(this.db),
    };
  }

  /**
   * Records keyboard or mouse activity. The boundary check runs right away so
   * the morning rollover lands with the first keystroke, and again on the next
   * tick in case this call raced one; the store rolls each boundary once.
   */
  noteActivity(at = this.now()): ActivityOutcome | null {
    this.pendingActivity = Math.max(this.pendingActivity ?? 0, at);
    return this.checkBoundaries();
  }

  /** Consumes pending activity: a new day rolls Daily 0 into Weekly 0, a new week drops old Weekly 0 rows to Later. */
  checkBoundaries(): ActivityOutcome | null {
    const at = this.pendingActivity;
    if (at === null) return null;
    this.pendingActivity = null;
    try {
      const o = applyActivity(this.db, at);
      if (o.newDay || o.newWeek) {
        log("scheduler", `${o.newDay ? "new day" : "same day"}, ${o.newWeek ? "new week" : "same week"}: rolled ${o.rolledDaily} into Weekly 0, moved ${o.rolledWeekly} into Later`, { dayStartAt: o.dayStartAt, weekStartAt: o.weekStartAt });
        const text = rolloverToast(o);
        if (text) emit("toast", { text });
        emit("threads:changed", { accountId: null });
      }
      return o;
    } catch (err) {
      logError("scheduler", "boundary check", err);
      return null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.checkBoundaries();
      this.wakeSnoozes(now);
      this.checkReminders(now);
      await this.releaseSends(now);
    } catch (err) {
      logError("scheduler", "tick", err);
    } finally {
      this.ticking = false;
    }
  }

  private wakeSnoozes(now: number): void {
    const touched = new Set<string>();
    for (const s of dueSnoozes(this.db, now)) {
      const woken = wakeSnooze(this.db, s.id, now);
      if (!woken) continue;
      touched.add(s.account_id);
      const thread = getThread(this.db, s.account_id, s.thread_id);
      const subject = thread?.subject || "(no subject)";
      emit("toast", { eyebrow: "BACK IN INBOX", text: subject });
      this.notifyImpl("Back in your inbox", subject);
      log("scheduler", `snooze ${s.id} woke ${s.account_id}/${s.thread_id}`);
    }
    for (const id of touched) {
      emit("threads:changed", { accountId: id });
      this.sync.poke(id);
    }
  }

  private checkReminders(now: number): void {
    const touched = new Set<string>();
    for (const r of dueReminders(this.db, now)) {
      if (hasNewerInbound(this.db, r.account_id, r.thread_id, r.last_message_id)) {
        resolveReminder(this.db, r.id, "replied", now);
        continue;
      }
      resolveReminder(this.db, r.id, "fired", now);
      const thread = getThread(this.db, r.account_id, r.thread_id);
      if (thread && !thread.in_inbox) moveToInbox(this.db, r.account_id, r.thread_id);
      bumpThread(this.db, r.account_id, r.thread_id, now);
      // A reminder that fires today is today's work.
      setQueue(this.db, r.account_id, r.thread_id, "daily", "reminder", now);
      touched.add(r.account_id);
      const subject = thread?.subject || "(no subject)";
      const eyebrow = `NO REPLY BY ${new Date(r.due_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase()}`;
      emit("toast", { eyebrow, text: subject });
      this.notifyImpl("No reply yet", subject);
    }
    for (const id of touched) {
      emit("threads:changed", { accountId: id });
      this.sync.poke(id);
    }
  }

  private async releaseSends(now: number): Promise<void> {
    for (const row of releasableSends(this.db, now)) {
      // Conditional: a row another tick (or an undo) already moved is skipped.
      if (!markSending(this.db, row.id)) continue;
      const client = this.accounts.client(row.account_id);
      if (!client) {
        markSendFailed(this.db, row.id, "Not signed in.", now + 60_000);
        continue;
      }
      try {
        const raw = Buffer.from(row.raw_mime, "utf8").toString("base64url");
        const sent = await sendRaw(client, raw, row.thread_id);
        markSent(this.db, row.id, sent.id);
        // The message is out; the Gmail draft it was mirrored as is no longer a draft.
        const gmailDraftId = sendMeta(row).gmailDraftId;
        if (gmailDraftId) enqueueOutbox(this.db, { accountId: row.account_id, op: "draftDelete", payload: { gmailDraftId } });
        emit("toast", { text: "Sent." });
        log("scheduler", `send ${row.id} delivered as ${sent.id}${gmailDraftId ? `, Gmail draft ${gmailDraftId} queued for deletion` : ""}`);
        this.sync.poke(row.account_id);
      } catch (err) {
        const terminal = isTerminalSendError(err);
        const message = (err as Error).message;
        if (terminal) {
          // The message will never go out as queued: fail the row and put the draft back where it can be fixed.
          markSendFailed(this.db, row.id, message, null);
          const restored = await this.restoreDraft(row);
          emit("toast", { eyebrow: "NOT SENT", text: `${message}${restored ? " The draft is back under Drafts." : ""}` });
        } else {
          markSendFailed(this.db, row.id, message, now + 60_000 * Math.min(SEND_RETRY_MAX_MIN, row.attempts + 1));
          emit("toast", { eyebrow: "NOT SENT", text: "Sending failed. Retrying." });
        }
        logError("scheduler", `send ${row.id}`, err);
      }
    }
  }

  /** Saves the draft a failed send carried so it shows under Drafts, still tied to its Gmail draft, and mirrors it. Returns true when a draft was written. */
  private async restoreDraft(row: SendQueueRow): Promise<boolean> {
    try {
      const meta = sendMeta(row);
      if (!meta.draft) return false;
      await restoreDraft(this.db, meta.draft, meta.gmailDraftId ?? null);
      this.sync.poke(row.account_id);
      return true;
    } catch (err) {
      logError("scheduler", `restore draft for send ${row.id}`, err);
      return false;
    }
  }
}

/** Auth loss and 4xx rejections the API will repeat are terminal; rate limits and server errors retry. */
export function isTerminalSendError(err: unknown): boolean {
  if (err instanceof AuthExpiredError) return true;
  if (err instanceof GmailApiError) {
    if (isRateLimit(err.status, err.reason)) return false;
    return err.status === 400 || err.status === 403 || err.status === 404 || err.status === 413;
  }
  return false;
}

function notify(title: string, body: string): void {
  try {
    const req = createRequire(import.meta.url);
    const electron = req("electron") as { Notification?: { isSupported(): boolean; new (opts: { title: string; body: string; silent: boolean }): { show(): void } } };
    const N = electron?.Notification;
    if (N && N.isSupported()) new N({ title, body, silent: true }).show();
  } catch {
    // Notifications are a courtesy; the toast already carried the news.
  }
}

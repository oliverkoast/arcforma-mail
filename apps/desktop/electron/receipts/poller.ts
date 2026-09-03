// Collects what the pixel service has seen, every two minutes, for as long as
// any armed message is younger than thirty days.
//
// Three rules it must not break:
//   1. It never blocks the mail path. The scheduler starts a run and moves on;
//      the run is guarded by its own flag, so a slow service delays nothing but
//      the next poll.
//   2. It backs off on failure the way the sync loop does, doubling from the
//      poll interval up to half an hour, and resets the moment a call works.
//   3. The watermark only ever moves forward, and only to an event actually
//      written, so a page that fails halfway is asked for again.
//
// With receipts off, no service configured, or nothing tracked, it does not
// run at all: none of this costs anything to someone who left the feature
// alone.

import { recordReceiptEvents, setReceiptWatermark, receiptWatermark, trackedReceiptCount, type Db } from "@arcforma/store";
import { receiptsUsable, type ReceiptService } from "./service.js";

/** How often the service is asked, while anything is being tracked. */
export const RECEIPT_POLL_MS = 120_000;
/** The longest a run of failures pushes the next poll out to. */
export const RECEIPT_BACKOFF_MAX_MS = 30 * 60_000;

/** Doubling from the poll interval, capped. One failure waits 2 minutes, two waits 4, and so on to 30. */
export function receiptBackoffMs(failures: number, base = RECEIPT_POLL_MS, max = RECEIPT_BACKOFF_MAX_MS): number {
  if (failures <= 0) return base;
  return Math.min(max, base * 2 ** (failures - 1));
}

export interface ReceiptPollResult {
  /** Events the service returned, whether or not they were new to this store. */
  received: number;
  /** Rows actually written: an event for a token this store never armed is dropped. */
  written: number;
  watermark: number;
}

export interface ReceiptPollerOptions {
  pollMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
  onPoll?: (result: ReceiptPollResult) => void;
}

export class ReceiptPoller {
  private nextAt = 0;
  private failures = 0;
  private inflight = false;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly service: ReceiptService,
    private readonly opts: ReceiptPollerOptions = {}
  ) {
    this.pollMs = opts.pollMs ?? RECEIPT_POLL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** How many failures in a row, for the tests and for a log line. */
  get failureCount(): number {
    return this.failures;
  }

  /** When the next poll may run. */
  get dueAt(): number {
    return this.nextAt;
  }

  /** Nothing to ask about: receipts off, no service, or no message young enough to still be worth a question. */
  private idle(): boolean {
    return !receiptsUsable(this.db) || trackedReceiptCount(this.db, this.now()) === 0;
  }

  /**
   * One tick's worth. Returns without waiting for the network: the caller is
   * the 10 second scheduler tick and must never sit on an HTTP call.
   */
  poke(): void {
    const now = this.now();
    if (this.inflight || now < this.nextAt || this.idle()) return;
    this.inflight = true;
    void this.run(now).finally(() => {
      this.inflight = false;
    });
  }

  /** The poll itself. Awaited by the tests; the app calls poke. */
  async run(now = this.now()): Promise<ReceiptPollResult | null> {
    if (this.idle()) return null;
    const since = receiptWatermark(this.db);
    try {
      const events = await this.service.events(since);
      const written = recordReceiptEvents(
        this.db,
        events.map((e) => ({ token: e.token, at: e.at, grade: e.grade, why: e.why, userAgent: e.userAgent }))
      );
      // Forward only, and only as far as an event that is now stored, so a
      // half-written page is asked for again rather than skipped.
      const newest = events.reduce((max, e) => Math.max(max, e.at), 0);
      const watermark = newest > 0 ? setReceiptWatermark(this.db, newest) : since;
      this.failures = 0;
      this.nextAt = now + this.pollMs;
      const result: ReceiptPollResult = { received: events.length, written, watermark };
      this.opts.onPoll?.(result);
      return result;
    } catch (err) {
      this.failures += 1;
      this.nextAt = now + receiptBackoffMs(this.failures, this.pollMs);
      this.opts.onError?.(err);
      return null;
    }
  }
}

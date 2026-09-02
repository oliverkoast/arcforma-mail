// When a draft mirrors to Gmail. Pure: the host owns the clock and the timer.
//
// A plain edit fires 2 s after the last one (trailing). A flush (Esc, park,
// the box closing under a new compose) fires now, except that one draft
// never fires more often than every 2 s, so a flush right after a fire waits
// for the gap. The Gmail row is read at fire time, so a later fire always
// carries the latest text and the two rules can only ever add a save.

export const MIRROR_QUIET_MS = 2000;

export class MirrorDebounce {
  private readonly due = new Map<number, number>();
  private readonly last = new Map<number, number>();

  constructor(private readonly quietMs = MIRROR_QUIET_MS) {}

  /** Records an edit (or a flush) and returns when the draft is now due to fire. */
  touch(id: number, now: number, flush = false): number {
    const earliest = (this.last.get(id) ?? Number.NEGATIVE_INFINITY) + this.quietMs;
    const at = flush ? Math.min(this.due.get(id) ?? Number.POSITIVE_INFINITY, Math.max(now, earliest)) : now + this.quietMs;
    this.due.set(id, at);
    return at;
  }

  /** Drafts due at `now`, marked fired. Order follows their due times. */
  take(now: number): number[] {
    const ready = Array.from(this.due.entries())
      .filter(([, at]) => at <= now)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
    for (const id of ready) {
      this.due.delete(id);
      this.last.set(id, now);
    }
    return ready;
  }

  /** The earliest pending due time, or null when nothing is waiting. */
  next(): number | null {
    let min: number | null = null;
    for (const at of this.due.values()) if (min === null || at < min) min = at;
    return min;
  }

  /** Forgets a draft that no longer exists. Returns true when a fire was pending. */
  cancel(id: number): boolean {
    this.last.delete(id);
    return this.due.delete(id);
  }

  pending(): number[] {
    return Array.from(this.due.keys());
  }
}

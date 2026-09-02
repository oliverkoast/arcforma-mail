// Calendar reads for the rail: the merged event list across accounts and the
// busy blocks the availability picker draws. Writes live in misc.ts next to
// the sync-token bookkeeping.

import type { Db } from "../db.js";
import type { CalendarEventRow } from "../types.js";

export interface BusyInterval {
  start: number;
  end: number;
}

/** Events in [from, to] across the given accounts (or all), sorted by start. Cancelled rows never make it in. */
export function listEventsInRange(db: Db, from: number, to: number, accountIds?: string[]): CalendarEventRow[] {
  const scope = accountIds && accountIds.length ? `AND account_id IN (${accountIds.map(() => "?").join(", ")})` : "";
  return db
    .prepare(`SELECT * FROM calendar_events WHERE status != 'cancelled' AND end_at > ? AND start_at < ? ${scope} ORDER BY start_at, end_at, account_id`)
    .all(from, to, ...(accountIds ?? [])) as unknown as CalendarEventRow[];
}

/**
 * Raw busy intervals in [from, to]: timed events marked busy that Oliver has
 * not declined. All-day and free (transparent) events do not block a slot.
 */
export function busyIntervals(db: Db, from: number, to: number, accountIds?: string[]): BusyInterval[] {
  const scope = accountIds && accountIds.length ? `AND account_id IN (${accountIds.map(() => "?").join(", ")})` : "";
  const rows = db
    .prepare(
      `SELECT start_at, end_at FROM calendar_events
       WHERE status != 'cancelled' AND busy = 1 AND all_day = 0 AND response_status != 'declined'
         AND end_at > ? AND start_at < ? ${scope}
       ORDER BY start_at`
    )
    .all(from, to, ...(accountIds ?? [])) as Array<{ start_at: number; end_at: number }>;
  return rows.map((r) => ({ start: r.start_at, end: r.end_at }));
}

/** Merges overlapping intervals from any number of accounts into one sorted list. */
export function mergeIntervals(blocks: BusyInterval[]): BusyInterval[] {
  const sorted = blocks.filter((b) => b.end > b.start).map((b) => ({ ...b })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: BusyInterval[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push(b);
  }
  return out;
}

/** Next and last event that lists the address as attendee or organizer, relative to `now`. */
export function eventsWithAttendee(db: Db, email: string, now: number): { next: CalendarEventRow | null; last: CalendarEventRow | null } {
  const e = email.toLowerCase();
  const match = `status != 'cancelled' AND (lower(COALESCE(organizer_email, '')) = ? OR EXISTS (SELECT 1 FROM json_each(attendees_json) a WHERE lower(COALESCE(a.value ->> 'email', '')) = ?))`;
  const next = db.prepare(`SELECT * FROM calendar_events WHERE ${match} AND end_at >= ? ORDER BY start_at LIMIT 1`).get(e, e, now) as unknown as CalendarEventRow | undefined;
  const last = db.prepare(`SELECT * FROM calendar_events WHERE ${match} AND end_at < ? ORDER BY start_at DESC LIMIT 1`).get(e, e, now) as unknown as CalendarEventRow | undefined;
  return { next: next ?? null, last: last ?? null };
}

// Day and week boundaries for the Daily 0 and Weekly 0 queues. A day does not
// start at midnight. It starts when the app sees activity after the night:
// either a gap of at least five hours that crosses a local calendar date, or
// the first activity after 4:00 local time since the last activity. At that
// moment the previous activity becomes dayStartAt, the last time Oliver was on
// mail the night before. Weeks start Monday 4:00 local.
//
// Pure over timestamps so node:test can drive it. Local time comes from Date,
// so tests build their instants with the local Date constructor.

export const DAY_GAP_MS = 5 * 3_600_000;
export const DAY_START_HOUR = 4;

export interface ActivityState {
  /** Last activity the app recorded, 0 when it has never seen any. */
  lastActiveAt: number;
  dayStartAt: number;
  weekStartAt: number;
}

export interface BoundaryResult {
  newDay: boolean;
  newWeek: boolean;
  /** The state to store after this activity. dayStartAt and weekStartAt only move on a boundary. */
  next: ActivityState;
}

function localDateKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** The most recent 4:00 local at or before t. */
export function dayBoundaryBefore(t: number): number {
  const d = new Date(t);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  if (d.getTime() > t) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** The most recent Monday 4:00 local at or before t. */
export function weekBoundaryBefore(t: number): number {
  const d = new Date(dayBoundaryBefore(t));
  // getDay: 0 Sunday, 1 Monday. Walk back to Monday.
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  return d.getTime();
}

/**
 * Decides whether activity at `now` opens a new day or week. The first
 * activity the app ever sees opens both, with the day starting at the last
 * 4:00 so the queue holds today's mail and not the whole store.
 */
export function detectBoundary(prev: ActivityState, now: number): BoundaryResult {
  const last = prev.lastActiveAt;
  const first = last <= 0;
  const gapAcrossDate = !first && now - last >= DAY_GAP_MS && localDateKey(now) !== localDateKey(last);
  const crossedFour = !first && last < dayBoundaryBefore(now);
  const newDay = first || gapAcrossDate || crossedFour;
  const weekBoundary = weekBoundaryBefore(now);
  const newWeek = first || last < weekBoundary;
  return {
    newDay,
    newWeek,
    next: {
      lastActiveAt: now,
      dayStartAt: newDay ? (first ? dayBoundaryBefore(now) : last) : prev.dayStartAt,
      weekStartAt: newWeek ? weekBoundary : prev.weekStartAt,
    },
  };
}

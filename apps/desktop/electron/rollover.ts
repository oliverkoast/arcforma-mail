// Turns recorded activity into day and week rollovers for Daily 0 and
// Weekly 0. The scheduler calls this from its tick and on power resume with
// the latest activity it has seen; the store's guards make each boundary
// roll at most once, whichever path gets there first.

import { detectBoundary, getSetting, rolloverDay, rolloverWeek, setSetting, transaction, type Db } from "@arcforma/store";

export interface ActivityOutcome {
  newDay: boolean;
  newWeek: boolean;
  /** Threads moved from Daily 0 into Weekly 0. */
  rolledDaily: number;
  /** Threads moved from Weekly 0 into Later. */
  rolledWeekly: number;
  dayStartAt: number;
  weekStartAt: number;
}

/** Records activity at `at`, rolling the queues over when it opens a new day or week. */
export function applyActivity(db: Db, at: number): ActivityOutcome {
  return transaction(db, () => {
    const prev = { lastActiveAt: getSetting(db, "lastActiveAt"), dayStartAt: getSetting(db, "dayStartAt"), weekStartAt: getSetting(db, "weekStartAt") };
    const r = detectBoundary(prev, at);
    let rolledDaily = 0;
    let rolledWeekly = 0;
    if (r.newDay) rolledDaily = rolloverDay(db, { dayStartAt: r.next.dayStartAt, now: at });
    if (r.newWeek) rolledWeekly = rolloverWeek(db, { weekStartAt: r.next.weekStartAt, now: at });
    if (at > prev.lastActiveAt) setSetting(db, "lastActiveAt", at);
    return { newDay: r.newDay, newWeek: r.newWeek, rolledDaily, rolledWeekly, dayStartAt: r.next.dayStartAt, weekStartAt: r.next.weekStartAt };
  });
}

/** The one line the toast shows for a rollover, or null when nothing moved. */
export function rolloverToast(o: Pick<ActivityOutcome, "rolledDaily" | "rolledWeekly">): string | null {
  const parts: string[] = [];
  if (o.rolledDaily > 0) parts.push(`Rolled ${o.rolledDaily} into Weekly 0.`);
  if (o.rolledWeekly > 0) parts.push(`Moved ${o.rolledWeekly} into Later.`);
  return parts.length ? parts.join(" ") : null;
}

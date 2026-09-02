// Availability maths shared by the main process (calendar:busy) and the
// picker in the rail. Pure: milliseconds in, milliseconds out, and every
// label comes from Intl with an explicit time zone so DST days format right.

export interface Interval {
  start: number;
  end: number;
}

export const SLOT_MS = 30 * 60 * 1000;

/** Merges overlapping or touching busy intervals from any number of accounts into one sorted list. */
export function mergeBusy(blocks: Interval[]): Interval[] {
  const sorted = blocks
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .map((b) => ({ start: b.start, end: b.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ start: b.start, end: b.end });
  }
  return out;
}

/** True when [start, end) touches any merged busy block. */
export function isBusy(busy: Interval[], start: number, end: number): boolean {
  for (const b of busy) {
    if (b.start >= end) break;
    if (b.end > start) return true;
  }
  return false;
}

/**
 * Free slots of `stepMs` inside [from, to), aligned to the step from `from`,
 * skipping anything that touches a busy block. Adjacent free slots are
 * returned separately so the picker can select them one by one.
 */
export function freeSlots(busy: Interval[], from: number, to: number, stepMs = SLOT_MS): Interval[] {
  const merged = mergeBusy(busy);
  const out: Interval[] = [];
  for (let t = from; t + stepMs <= to; t += stepMs) {
    if (!isBusy(merged, t, t + stepMs)) out.push({ start: t, end: t + stepMs });
  }
  return out;
}

/** Joins consecutive selected slots into ranges, so five picked half hours read as one line. */
export function coalesce(slots: Interval[]): Interval[] {
  return mergeBusy(slots);
}

/** The system zone id, e.g. America/Los_Angeles. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Short generic zone label such as PT, falling back to the offset-specific one (PDT) and then the id. */
export function timeZoneLabel(tz: string, at: number = Date.now()): string {
  for (const style of ["shortGeneric", "short"] as const) {
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: style }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName");
      if (part && !/^GMT[+-]/.test(part.value)) return part.value;
    } catch {
      // Older ICU without shortGeneric: try the next style.
    }
  }
  return tz;
}

function hhmm(t: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

function dayLabel(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(t)).replace(",", "");
}

/** "Tue Sep 2, 10:00 to 10:30 PT". A range that crosses midnight repeats the day on the end side. */
export function formatSlot(slot: Interval, tz: string): string {
  const label = timeZoneLabel(tz, slot.start);
  const startDay = dayLabel(slot.start, tz);
  const endDay = dayLabel(slot.end, tz);
  const end = endDay === startDay ? hhmm(slot.end, tz) : `${endDay} ${hhmm(slot.end, tz)}`;
  return `${startDay}, ${hhmm(slot.start, tz)} to ${end} ${label}`;
}

export function formatSlots(slots: Interval[], tz: string): string[] {
  return coalesce(slots).map((s) => formatSlot(s, tz));
}

/** Local-midnight boundaries for `days` days starting today. Uses wall-clock setters, so DST days keep 23 or 25 hours. */
export function dayStarts(days: number, now: number = Date.now()): number[] {
  const out: number[] = [];
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(d.getTime());
  }
  return out;
}

/** Wall-clock time on a given local day, DST-safe. */
export function atHour(dayStart: number, hour: number, minute = 0): number {
  const d = new Date(dayStart);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { AvailabilityPicker } from "./AvailabilityPicker";
import { invoke, on } from "../bridge";
import { useApp } from "../state/store";
import { dayStarts } from "../../shared/availability";
import type { CalendarEventView } from "../../shared/types";

const DAYS = 7;
const REFRESH_MS = 60_000;

declare global {
  interface Window {
    /** Smoke hooks for the calendar rail (scripts/smoke.mjs): switch to the picker and select a demo slot. */
    __arcmailCalendar?: { showAvailability: (on: boolean) => void; pickDemo: () => void };
  }
}

function dayTitle(dayStart: number, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  return new Date(dayStart).toLocaleDateString(undefined, { weekday: "long" });
}

function dayDate(dayStart: number): string {
  return new Date(dayStart).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timeRange(ev: CalendarEventView): string {
  if (ev.allDay) return "All day";
  const fmt = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${fmt(ev.startAt)} to ${fmt(ev.endAt)}`;
}

/** Events grouped by the local day they start on; a multi-day event shows on every day it covers. */
function groupByDay(events: CalendarEventView[], days: number[]): Map<number, CalendarEventView[]> {
  const out = new Map<number, CalendarEventView[]>(days.map((d) => [d, []]));
  for (let i = 0; i < days.length; i++) {
    const start = days[i]!;
    const end = days[i + 1] ?? start + 86_400_000;
    for (const ev of events) {
      if (ev.endAt > start && ev.startAt < end) out.get(start)!.push(ev);
    }
  }
  return out;
}

export function useCalendarEvents(days: number[]): { events: CalendarEventView[]; loaded: boolean; error: string | null } {
  const [events, setEvents] = useState<CalendarEventView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = days[0] ?? 0;
  const to = (days[days.length - 1] ?? 0) + 86_400_000;
  const load = useCallback(async () => {
    try {
      setEvents(await invoke("calendar:list", from, to));
      setError(null);
    } catch (err) {
      // Keep whatever was on screen; say that the read failed rather than showing a clean week.
      setError((err as Error).message);
    }
    setLoaded(true);
  }, [from, to]);
  useEffect(() => {
    void load();
    const off = on("calendar:changed", () => void load());
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [load]);
  return { events, loaded, error };
}

export function CalendarPanel() {
  const accounts = useApp((s) => s.status.accounts);
  const [availability, setAvailability] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  const days = useMemo(() => dayStarts(DAYS, Date.now() + tick), [tick]);
  const { events, loaded, error } = useCalendarEvents(days);
  const emailOf = useMemo(() => new Map(accounts.map((a) => [a.id, a.email])), [accounts]);
  const grouped = useMemo(() => groupByDay(events, days), [events, days]);
  const signedIn = accounts.some((a) => a.authState === "ok");

  useEffect(() => {
    // The picker fills in pickDemo when it mounts.
    window.__arcmailCalendar = { showAvailability: (v) => setAvailability(v), pickDemo: () => undefined };
    return () => {
      delete window.__arcmailCalendar;
    };
  }, []);

  return (
    <>
      <div className="rail-head">
        <span className="af-mono">Calendar</span>
        <button className="rail-link" onClick={() => setAvailability((v) => !v)}>
          {availability ? "Show events" : "Share free times"}
        </button>
      </div>
      {availability ? (
        <AvailabilityPicker days={days} />
      ) : (
        <>
          <div className="af-h3">Next 7 days</div>
          {error ? (
            <div className="contact-web-fail">
              <span className="af-mono eyebrow-flag">CALENDAR NOT READ</span>
              <span className="rail-muted">{error}</span>
            </div>
          ) : null}
          {!loaded ? (
            <p className="rail-muted">Reading the calendar.</p>
          ) : events.length === 0 && !error ? (
            <p className="rail-muted">{signedIn ? "Nothing on the calendar this week. Events land here within five minutes of a sign-in." : "Sign in to an account to see its calendar."}</p>
          ) : null}
          {days.map((d, i) => {
            const list = grouped.get(d) ?? [];
            if (list.length === 0 && i > 1) return null;
            return (
              <section className="cal-day" key={d}>
                <div className="cal-day-head">
                  <span className="cal-day-title">{dayTitle(d, i)}</span>
                  <span className="af-mono">{dayDate(d)}</span>
                </div>
                {list.length === 0 ? <p className="rail-muted">Free.</p> : null}
                {list.map((ev) => (
                  <div className={`cal-event${ev.responseStatus === "declined" ? " cal-event-declined" : ""}`} key={`${ev.accountId}:${ev.id}`}>
                    <div className="cal-event-main">
                      <span className="cal-event-time">{timeRange(ev)}</span>
                      <span className="cal-event-title">{ev.summary}</span>
                      <span className="af-mono cal-event-account">{emailOf.get(ev.accountId) ?? ev.accountId}</span>
                    </div>
                    {ev.joinUrl ? (
                      <a className="btn btn-nav btn-compact cal-join" href={ev.joinUrl} target="_blank" rel="noreferrer">
                        Join
                      </a>
                    ) : null}
                  </div>
                ))}
              </section>
            );
          })}
          <p className="rail-hint af-mono">Cmd+Shift+C closes this panel</p>
        </>
      )}
    </>
  );
}

// Google Calendar incremental sync, ported from OpenWhispr's
// googleCalendarManager.js: a full window fetch the first time, syncToken
// afterwards, 410 Gone falls back to a full fetch, 429 and 5xx back off.

import { GmailApiError, isRateLimit, parseRetryAfter } from "./errors.js";
import { fetchTransport, realSleep, type Sleep, type Transport } from "./transport.js";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const RESPONSE_STATUSES = new Set(["accepted", "declined", "tentative", "needsAction"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CalendarEvent {
  id: string;
  summary: string | null;
  startAt: number;
  endAt: number;
  allDay: boolean;
  status: string;
  busy: boolean;
  responseStatus: string;
  hangoutLink: string | null;
  organizerEmail: string | null;
  attendees: Array<{ email: string; displayName: string | null; responseStatus: string | null; self: boolean }>;
}

export interface CalendarSyncOptions {
  accessToken: (force?: boolean) => Promise<string>;
  transport?: Transport;
  sleep?: Sleep;
  now?: () => number;
  calendarId?: string;
  syncToken?: string | null;
  /** Days ahead for the full window. */
  windowDays?: number;
  /** Days behind for the full window, so past meetings survive for the contact rail. Default one day. */
  windowBehindDays?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface CalendarSyncResult {
  fullSync: boolean;
  upserts: CalendarEvent[];
  removed: string[];
  nextSyncToken: string | null;
  /**
   * The [timeMin, timeMax] a full sync covered, so the caller can drop stale
   * rows inside it and nothing outside it. Null for an incremental sync.
   * Google keeps this window on the sync token, so events outside it never
   * arrive incrementally; the caller must run a full sync again on a schedule.
   */
  window: { from: number; to: number } | null;
}

interface EventsPage {
  items?: Array<Record<string, unknown>>;
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * An all-day event arrives as a bare date ("2026-09-02") that means local
 * midnight, not UTC midnight; Date.parse would put it at 17:00 the previous
 * day in Los Angeles. The end date is exclusive, so a one-day event runs from
 * local midnight to the next local midnight.
 */
export function parseEventTime(v: { dateTime?: string; date?: string } | undefined): number | null {
  if (v?.dateTime) return Date.parse(v.dateTime);
  const m = v?.date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.date) : null;
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function toEvent(item: Record<string, unknown>): CalendarEvent | null {
  const start = item["start"] as { dateTime?: string; date?: string } | undefined;
  const end = item["end"] as { dateTime?: string; date?: string } | undefined;
  const startAt = parseEventTime(start);
  const endAt = parseEventTime(end);
  if (startAt === null || endAt === null || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return null;
  const attendees = (item["attendees"] as Array<{ email?: string; displayName?: string; responseStatus?: string; self?: boolean }> | undefined) ?? [];
  const self = attendees.find((a) => a.self === true);
  const organizer = item["organizer"] as { email?: string } | undefined;
  return {
    id: String(item["id"]),
    summary: (item["summary"] as string | undefined) ?? null,
    startAt,
    endAt,
    allDay: !start?.dateTime,
    status: (item["status"] as string | undefined) ?? "confirmed",
    busy: item["transparency"] !== "transparent",
    responseStatus: RESPONSE_STATUSES.has(self?.responseStatus ?? "") ? self!.responseStatus! : "unknown",
    hangoutLink: (item["hangoutLink"] as string | undefined) ?? null,
    organizerEmail: organizer?.email ?? null,
    attendees: attendees.filter((a) => a.email).map((a) => ({ email: a.email!, displayName: a.displayName ?? null, responseStatus: a.responseStatus ?? null, self: a.self === true })),
  };
}

export async function syncCalendar(opts: CalendarSyncOptions): Promise<CalendarSyncResult> {
  const transport = opts.transport ?? fetchTransport;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const calendarId = opts.calendarId ?? "primary";
  const maxAttempts = opts.maxAttempts ?? 5;
  const windowDays = opts.windowDays ?? 7;
  const windowBehindDays = opts.windowBehindDays ?? 1;

  let window: { from: number; to: number } | null = null;
  const fullParams = () => {
    const t = now();
    window = { from: t - windowBehindDays * DAY_MS, to: t + windowDays * DAY_MS };
    return new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date(window.from).toISOString(),
      timeMax: new Date(window.to).toISOString(),
      maxResults: "250",
    });
  };

  let fullSync = !opts.syncToken;
  let base = fullSync ? fullParams() : new URLSearchParams({ singleEvents: "true", syncToken: opts.syncToken!, maxResults: "250" });
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;
  const items: Array<Record<string, unknown>> = [];

  for (;;) {
    const params = new URLSearchParams(base);
    if (pageToken) params.set("pageToken", pageToken);
    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
    let page: EventsPage | null = null;
    for (let attempt = 0; page === null; attempt++) {
      const token = await opts.accessToken(false);
      const res = await transport(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: opts.signal });
      const text = await res.text();
      if (res.status === 200) {
        page = JSON.parse(text) as EventsPage;
        break;
      }
      let reason: string | null = null;
      let message = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
        reason = j.error?.errors?.[0]?.reason ?? null;
        message = j.error?.message ?? message;
      } catch {
        // Non-JSON error body; the status is enough.
      }
      if (res.status === 410 && !fullSync) {
        fullSync = true;
        base = fullParams();
        pageToken = null;
        items.length = 0;
        break;
      }
      if ((isRateLimit(res.status, reason) || res.status >= 500) && attempt + 1 < maxAttempts) {
        await sleep(parseRetryAfter(res.headers.get("retry-after"), now()) ?? Math.min(60_000, 1000 * 2 ** attempt));
        continue;
      }
      throw new GmailApiError(res.status, message, reason);
    }
    if (page === null) continue; // 410 reset; restart the loop with full params
    items.push(...(page.items ?? []));
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    pageToken = page.nextPageToken ?? null;
    if (!pageToken) break;
  }

  const upserts: CalendarEvent[] = [];
  const removed: string[] = [];
  for (const item of items) {
    if (item["status"] === "cancelled") {
      removed.push(String(item["id"]));
      continue;
    }
    const ev = toEvent(item);
    if (ev) upserts.push(ev);
  }
  return { fullSync, upserts, removed, nextSyncToken, window: fullSync ? window : null };
}

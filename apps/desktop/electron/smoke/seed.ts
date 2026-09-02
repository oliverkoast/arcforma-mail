// Seeds a throwaway store from scripts/fixtures/threads.json so the smoke run
// has a full inbox without any Gmail account: threads, bodies, classifications,
// a snoozed thread, a fired reminder, a cached summary, snippets, a category,
// and the Daily 0 / Weekly 0 / Later queues with their day and week start.

import fs from "node:fs";
import {
  createCategory,
  createReminder,
  createSavedSearch,
  createSnooze,
  enqueueSend,
  resolveReminder,
  saveBody,
  setQueue,
  setSetting,
  setSummary,
  updateAccount,
  upsertAccount,
  upsertCalendarEvents,
  upsertClassification,
  upsertSnippet,
  upsertThreadFromGmail,
  type Db,
  type GmailThreadInput,
} from "@arcforma/store";

interface FixtureMessage {
  id: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  hoursAgo: number;
  labels: string[];
  headers?: Record<string, string>;
  calendar?: boolean;
  html?: string;
  text?: string;
}

interface FixtureThread {
  accountId: string;
  id: string;
  messages: FixtureMessage[];
  classification?: { split: "important" | "other"; type?: string | null; categoryId?: string | null; source?: "rule" | "local" | "manual"; confidence?: number };
  summary?: string;
  snooze?: { wakeInHours: number };
  reminder?: { firedHoursAgo: number; dueHoursAgo: number };
  /** A stored queue choice; threads with no entry follow the automatic Daily 0 rule. */
  queue?: { queue: "daily" | "weekly" | "later"; source?: "user" | "wake" | "reminder" | "rollover"; addedHoursAgo?: number };
}

/** A calendar event placed by local day offset and wall-clock hour, so the grid always shows it in working hours. */
interface FixtureEvent {
  accountId: string;
  id: string;
  summary: string;
  day: number;
  hour: number;
  minute?: number;
  durationMinutes?: number;
  allDay?: boolean;
  busy?: boolean;
  responseStatus?: string;
  hangoutLink?: string;
  organizerEmail?: string;
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string; self?: boolean }>;
}

/** A send-later message already in the queue, placed by hours after the seed time. */
interface FixtureScheduledSend {
  accountId: string;
  to: string;
  subject: string;
  bodyHtml: string;
  sendInHours: number;
}

interface Fixture {
  accounts: Array<{ id: string; email: string; displayName: string; signatureHtml: string }>;
  snippets?: Array<{ trigger: string; name: string; bodyHtml: string; bodyText: string }>;
  categories?: Array<{ id: string; name: string; prompt: string }>;
  savedSearches?: Array<{ name: string; query: string }>;
  scheduledSends?: FixtureScheduledSend[];
  threads: FixtureThread[];
  calendar?: FixtureEvent[];
  /** Where the current day and week began, as hours before the seed time. The seed time itself is the last activity. */
  queueState?: { dayStartHoursAgo: number; weekStartHoursAgo: number };
}

const HOUR = 3_600_000;

function localAt(now: number, day: number, hour: number, minute: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + day);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

export function seedFixture(db: Db, file: string, now = Date.now()): { threads: number; events: number } {
  const fx = JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
  const owners = new Set<string>();
  for (const a of fx.accounts) {
    upsertAccount(db, { id: a.id, email: a.email, displayName: a.displayName, consent: a.id === "personal" ? "external" : "internal" });
    updateAccount(db, a.id, { auth_state: "ok", sync_state: "live", history_id: "1", last_sync_at: now, signature_html: a.signatureHtml, error: null });
    owners.add(a.email.toLowerCase());
  }
  for (const s of fx.snippets ?? []) upsertSnippet(db, s);
  if (fx.queueState) {
    setSetting(db, "dayStartAt", now - fx.queueState.dayStartHoursAgo * HOUR);
    setSetting(db, "weekStartAt", now - fx.queueState.weekStartHoursAgo * HOUR);
    setSetting(db, "lastActiveAt", now);
  }
  for (const c of fx.categories ?? []) {
    try {
      createCategory(db, { id: c.id, name: c.name, prompt: c.prompt });
    } catch {
      // Already there on a reused store.
    }
  }
  for (const s of fx.savedSearches ?? []) createSavedSearch(db, s);
  for (const s of fx.scheduledSends ?? []) {
    const sendAt = now + s.sendInHours * HOUR;
    const to = s.to.includes("<") ? { name: s.to.replace(/\s*<.*$/, ""), email: s.to.replace(/^.*<|>.*$/g, "") } : { name: "", email: s.to };
    const draft = { accountId: s.accountId, threadId: null, mode: "new" as const, to: [to], cc: [], bcc: [], subject: s.subject, bodyHtml: s.bodyHtml, quotedHtml: "" };
    // The smoke run never releases a send; a placeholder MIME is enough for the Scheduled view.
    enqueueSend(db, { accountId: s.accountId, threadId: null, rawMime: `Subject: ${s.subject}\r\n\r\n`, sendAt, undoUntil: sendAt, meta: { draft } });
  }
  for (const t of fx.threads) {
    const thread: GmailThreadInput = {
      id: t.id,
      historyId: "1",
      messages: t.messages.map((m) => {
        const date = now - m.hoursAgo * HOUR;
        const headers = [
          { name: "From", value: m.from },
          { name: "To", value: m.to },
          { name: "Subject", value: m.subject },
          { name: "Message-ID", value: `<${m.id}@fixture.example>` },
          { name: "Date", value: new Date(date).toUTCString() },
          ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
          ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
        ];
        return {
          id: m.id,
          threadId: t.id,
          labelIds: m.labels,
          snippet: (m.text ?? m.html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120),
          internalDate: String(date),
          historyId: "1",
          payload: { mimeType: m.calendar ? "multipart/mixed" : "text/html", headers, parts: m.calendar ? [{ mimeType: "text/calendar", filename: "invite.ics", body: { attachmentId: "att-1", size: 1200 } }] : [] },
        };
      }),
    };
    upsertThreadFromGmail(db, t.accountId, thread, { ownerAddresses: Array.from(owners) });
    for (const m of t.messages) saveBody(db, t.accountId, m.id, { html: m.html ?? null, text: m.text ?? null, attachments: m.calendar ? [{ filename: "invite.ics", mimeType: "text/calendar", size: 1200, inline: false }] : [] });
    const last = t.messages[t.messages.length - 1]!;
    if (t.classification) {
      upsertClassification(db, {
        accountId: t.accountId,
        threadId: t.id,
        split: t.classification.split,
        type: t.classification.type ?? null,
        categoryId: t.classification.categoryId ?? null,
        confidence: t.classification.confidence ?? 1,
        source: t.classification.source ?? "rule",
        lastMessageId: last.id,
      });
    }
    if (t.summary) setSummary(db, t.accountId, t.id, last.id, t.summary);
    if (t.snooze) createSnooze(db, { accountId: t.accountId, threadId: t.id, wakeAt: now + t.snooze.wakeInHours * HOUR });
    if (t.reminder) {
      const r = createReminder(db, { accountId: t.accountId, threadId: t.id, lastMessageId: last.id, dueAt: now - t.reminder.dueHoursAgo * HOUR });
      resolveReminder(db, r.id, "fired", now - t.reminder.firedHoursAgo * HOUR);
    }
    if (t.queue) setQueue(db, t.accountId, t.id, t.queue.queue, t.queue.source ?? "user", now - (t.queue.addedHoursAgo ?? 0) * HOUR);
  }
  const byAccount = new Map<string, FixtureEvent[]>();
  for (const ev of fx.calendar ?? []) byAccount.set(ev.accountId, [...(byAccount.get(ev.accountId) ?? []), ev]);
  for (const [accountId, events] of byAccount) {
    upsertCalendarEvents(
      db,
      accountId,
      "primary",
      events.map((ev) => {
        const startAt = ev.allDay ? localAt(now, ev.day, 0, 0) : localAt(now, ev.day, ev.hour, ev.minute ?? 0);
        const endAt = ev.allDay ? localAt(now, ev.day + 1, 0, 0) : startAt + (ev.durationMinutes ?? 30) * 60_000;
        return {
          id: ev.id,
          summary: ev.summary,
          startAt,
          endAt,
          allDay: ev.allDay === true,
          status: "confirmed",
          busy: ev.busy !== false,
          responseStatus: ev.responseStatus ?? "accepted",
          hangoutLink: ev.hangoutLink ?? null,
          organizerEmail: ev.organizerEmail ?? null,
          attendees: (ev.attendees ?? []).map((a) => ({ email: a.email, displayName: a.displayName ?? null, responseStatus: a.responseStatus ?? "accepted", self: a.self === true })),
        };
      })
    );
  }
  return { threads: fx.threads.length, events: (fx.calendar ?? []).length };
}

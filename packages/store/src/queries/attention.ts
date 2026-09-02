// The signals behind "the mail I need to see". Everything here is read from
// the store and computed deterministically: who the message was addressed to,
// what history Oliver has with the sender, whether he is already in the
// conversation, whether the last inbound message asks him for something, and
// what the sender's bulk behaviour looks like. Nothing here scores anything.
// The weights and the bands live in the desktop's classify/attention.ts, which
// is pure and takes these facts as input.
//
// The expensive parts (who he has written to, per-sender volume, per-sender
// archive-without-reading) are whole-table aggregates, so they are built once
// per pass into an AttentionContext and shared by every thread.

import type { Db } from "../db.js";
import { placeholders } from "../db.js";
import { scopedCategoryIds } from "./client-reminders.js";
import { listThreadMessages } from "./messages.js";
import { getSetting } from "./settings.js";
import type { MessageRow } from "../types.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Freemail domains are shared by strangers, so writing to one address there says nothing about the next. */
const SHARED_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "live.com",
  "msn.com",
]);

export function domainOf(email: string): string {
  return email.toLowerCase().split("@")[1] ?? "";
}

/** Where Oliver's address sits on the last inbound message. Direct beats Cc beats a group alias. */
export type Addressing = "to" | "to_with_others" | "cc" | "alias";

/** needs_you and important both file as Important; the band says which kind. */
export type AttentionBand = "needs_you" | "important" | "other";

/** How often a sender writes and what Oliver does with it. Keyed by the address that opened each thread. */
export interface SenderStats {
  /** Threads this address opened. */
  threads: number;
  firstAt: number;
  lastAt: number;
  /** Threads that left the inbox while still unread: archived without reading. */
  archivedUnread: number;
  /** Threads still carrying unread mail. */
  unread: number;
}

export interface AttentionContext {
  now: number;
  /** Lowercased addresses the accounts own. */
  ownerAddresses: Set<string>;
  /** Address Oliver wrote to, with how many of his messages went there and when the last one did. */
  sentTo: Map<string, { count: number; lastAt: number }>;
  /** Non-shared domains he has written to at all. */
  sentDomains: Set<string>;
  /** Domains of people he corresponds with under a Clients-style category, from remindScope. */
  clientDomains: Set<string>;
  senders: Map<string, SenderStats>;
  /** Sender address to how many times a re-file pushed one of their threads out of Important. */
  demoted: Map<string, number>;
}

/** Everything one thread contributes to its own score. Pure data, so the scorer can be driven from a literal. */
export interface AttentionFacts {
  accountId: string;
  threadId: string;
  now: number;
  senderEmail: string;
  senderName: string;
  senderDomain: string;
  /** The deciding message came from one of the accounts' own addresses. */
  isOwnSender: boolean;
  addressing: Addressing;
  /** Messages Oliver has sent to this exact address. */
  repliedCount: number;
  lastRepliedAt: number | null;
  /** He has written to this domain, and the domain is not shared freemail. */
  repliedDomain: boolean;
  isClientDomain: boolean;
  /** One inbound message from this address in the whole store, and he has never written to it. */
  isFirstTimeSender: boolean;
  /** He has sent a message inside this thread. */
  youAreInThread: boolean;
  /** The thread opens with something he sent. */
  youStartedThread: boolean;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  /** Milliseconds the last inbound message has gone unanswered, or null when he has written since. */
  unansweredMs: number | null;
  /** Subject and text of the last inbound message, for the ask signals. Never stored or printed. */
  askText: string;
  /** List-Id, List-Unsubscribe, or Precedence: bulk on the deciding message. */
  isBulk: boolean;
  isAuto: boolean;
  /** The mailbox type the thread carries, when it has one. */
  type: string | null;
  senderThreads: number;
  /** Threads a week from this sender, over the span the store has seen them. */
  threadsPerWeek: number;
  /** Share of this sender's threads archived while still unread, 0 to 1. */
  archiveWithoutReadRate: number;
  /** Every thread from this sender is still unread. */
  neverOpened: boolean;
  /** Re-files that took one of this sender's threads out of Important. */
  demotions: number;
}

function parseAddresses(json: string): string[] {
  try {
    return (JSON.parse(json) as Array<{ email?: string }>).map((a) => String(a.email ?? "").toLowerCase()).filter(Boolean);
  } catch {
    // A malformed recipient list cannot address anyone.
    return [];
  }
}

/** Owner addresses of every account in the store, lowercased. */
export function ownerAddresses(db: Db): Set<string> {
  return new Set((db.prepare("SELECT email FROM accounts").all() as Array<{ email: string }>).map((r) => r.email.toLowerCase()));
}

/** Every address Oliver has written to, with a count and a recency. One scan over his outbound mail. */
export function sentToCounts(db: Db): { addresses: Map<string, { count: number; lastAt: number }>; domains: Set<string> } {
  const rows = db.prepare("SELECT to_json, cc_json, internal_date FROM messages WHERE direction = 'out'").all() as Array<{ to_json: string; cc_json: string; internal_date: number }>;
  const addresses = new Map<string, { count: number; lastAt: number }>();
  const domains = new Set<string>();
  for (const r of rows) {
    for (const email of [...parseAddresses(r.to_json), ...parseAddresses(r.cc_json)]) {
      const seen = addresses.get(email);
      if (seen) {
        seen.count += 1;
        seen.lastAt = Math.max(seen.lastAt, r.internal_date);
      } else {
        addresses.set(email, { count: 1, lastAt: r.internal_date });
      }
      const d = domainOf(email);
      if (d && !SHARED_DOMAINS.has(d)) domains.add(d);
    }
  }
  return { addresses, domains };
}

/**
 * Domains that count as client domains: the correspondents in threads filed
 * under a category the remindScope setting names. Shared freemail domains are
 * left out, because the domain says nothing there.
 */
export function clientDomains(db: Db, scope: string[] = getSetting(db, "remindScope")): Set<string> {
  const ids = scopedCategoryIds(db, scope);
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const lower = ids.map((i) => i.toLowerCase());
  const ph = placeholders(lower.length);
  const rows = db
    .prepare(
      `SELECT DISTINCT lower(m.from_email) AS email FROM classifications c
       JOIN messages m ON m.account_id = c.account_id AND m.thread_id = c.thread_id AND m.direction = 'in'
       WHERE lower(COALESCE(c.category_id, '')) IN (${ph}) OR lower(COALESCE(c.type, '')) IN (${ph})`
    )
    .all(...lower, ...lower) as Array<{ email: string }>;
  for (const r of rows) {
    const d = domainOf(r.email);
    if (d && !SHARED_DOMAINS.has(d)) out.add(d);
  }
  return out;
}

/**
 * Per-sender volume and what Oliver does with it, keyed by the address that
 * opened each thread. One aggregate over threads joined to their first inbound
 * message, so a mailbox of thousands costs one query.
 */
export function senderStats(db: Db): Map<string, SenderStats> {
  const rows = db
    .prepare(
      `SELECT f.email AS email, COUNT(*) AS threads, MIN(f.at) AS first_at, MAX(f.at) AS last_at,
              SUM(CASE WHEN t.in_inbox = 0 AND t.unread = 1 THEN 1 ELSE 0 END) AS archived_unread,
              SUM(CASE WHEN t.unread = 1 THEN 1 ELSE 0 END) AS unread
       FROM threads t
       JOIN (SELECT account_id, thread_id, lower(from_email) AS email, MIN(internal_date) AS at
             FROM messages WHERE direction = 'in' GROUP BY account_id, thread_id) f
         ON f.account_id = t.account_id AND f.thread_id = t.id
       GROUP BY f.email`
    )
    .all() as Array<{ email: string; threads: number; first_at: number; last_at: number; archived_unread: number; unread: number }>;
  const out = new Map<string, SenderStats>();
  for (const r of rows) out.set(r.email, { threads: r.threads, firstAt: r.first_at, lastAt: r.last_at, archivedUnread: r.archived_unread, unread: r.unread });
  return out;
}

/** The sender an excerpt was built from. buildExcerpt writes "From: Name <a@b>" or "From: a@b" on the first line. */
export function excerptSender(excerpt: string): string | null {
  return /^From:[^\n]*?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)/im.exec(excerpt)?.[1]?.toLowerCase() ?? null;
}

/**
 * Senders a re-file has taken out of Important, counted from the corrections
 * bank. Re-filing a thread out of Needs you is a correction like any other, and
 * this is what lets it lower the next score for the same sender.
 */
export function demotedSenders(db: Db, limit = 500): Map<string, number> {
  const rows = db.prepare("SELECT to_split, text_excerpt FROM corrections ORDER BY id DESC LIMIT ?").all(limit) as Array<{ to_split: string | null; text_excerpt: string }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.to_split !== "other") continue;
    const email = excerptSender(r.text_excerpt);
    if (!email) continue;
    out.set(email, (out.get(email) ?? 0) + 1);
  }
  return out;
}

/** The shared half of the model, built once per classification pass. */
export function attentionContext(db: Db, now = Date.now()): AttentionContext {
  const sent = sentToCounts(db);
  return {
    now,
    ownerAddresses: ownerAddresses(db),
    sentTo: sent.addresses,
    sentDomains: sent.domains,
    clientDomains: clientDomains(db),
    senders: senderStats(db),
    demoted: demotedSenders(db),
  };
}

/** The last inbound message decides; a thread with nothing inbound is decided by its last message. */
function lastInbound(messages: MessageRow[]): MessageRow | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.direction === "in") return messages[i]!;
  return null;
}

function headerOf(m: MessageRow, name: string): string {
  try {
    const headers = JSON.parse(m.headers_json) as Record<string, string>;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key] ?? "") : "";
  } catch {
    return "";
  }
}

/** Where the owner sits on a message's recipient lists. */
export function addressingOf(m: MessageRow, owners: ReadonlySet<string>): Addressing {
  const to = parseAddresses(m.to_json);
  const cc = parseAddresses(m.cc_json);
  const onTo = to.some((e) => owners.has(e));
  if (onTo) return to.length > 1 ? "to_with_others" : "to";
  if (cc.some((e) => owners.has(e))) return "cc";
  return "alias";
}

export interface FactsOptions {
  /** The mailbox type the thread just took, when the caller already knows it. Read from the store otherwise. */
  type?: string | null;
  /** Text of the deciding message, when the caller has it. Falls back to the stored body, then the snippet. */
  bodyText?: string | null;
}

/** The most characters of a message body the ask signals look at. Enough for an opening ask, short enough to stay cheap. */
export const ASK_TEXT_CHARS = 2000;

/**
 * Every signal for one thread. Cheap: the thread's own messages, one body
 * lookup, and the shared context. Reads only, so the read-only report can call it.
 */
export function attentionFactsFor(db: Db, accountId: string, threadId: string, ctx: AttentionContext, opts: FactsOptions = {}): AttentionFacts | null {
  const messages = listThreadMessages(db, accountId, threadId);
  if (messages.length === 0) return null;
  const deciding = lastInbound(messages) ?? messages[messages.length - 1]!;
  const senderEmail = deciding.from_email.toLowerCase();
  const senderDomain = domainOf(senderEmail);
  const sent = ctx.sentTo.get(senderEmail) ?? null;
  const stats = ctx.senders.get(senderEmail) ?? null;

  let lastInboundAt: number | null = null;
  let lastOutboundAt: number | null = null;
  for (const m of messages) {
    if (m.direction === "in") lastInboundAt = Math.max(lastInboundAt ?? 0, m.internal_date);
    else lastOutboundAt = Math.max(lastOutboundAt ?? 0, m.internal_date);
  }
  const answered = lastInboundAt !== null && lastOutboundAt !== null && lastOutboundAt >= lastInboundAt;
  const unansweredMs = lastInboundAt !== null && !answered ? Math.max(0, ctx.now - lastInboundAt) : null;

  let bodyText = opts.bodyText ?? null;
  if (bodyText === null) {
    const body = db.prepare("SELECT text FROM message_bodies WHERE account_id = ? AND message_id = ?").get(accountId, deciding.id) as { text: string | null } | undefined;
    bodyText = body?.text ?? null;
  }
  const askText = `${deciding.subject}\n${bodyText || deciding.snippet}`.slice(0, ASK_TEXT_CHARS);

  const type =
    opts.type !== undefined
      ? opts.type
      : ((db.prepare("SELECT type FROM classifications WHERE account_id = ? AND thread_id = ?").get(accountId, threadId) as { type: string | null } | undefined)?.type ?? null);

  const listId = headerOf(deciding, "List-Id");
  const isBulk = Boolean(listId || headerOf(deciding, "List-Unsubscribe")) || headerOf(deciding, "Precedence").toLowerCase() === "bulk";

  const spanWeeks = stats ? Math.max(1, (Math.max(stats.lastAt - stats.firstAt, 0) + DAY) / WEEK) : 1;
  const senderThreads = stats?.threads ?? 0;

  return {
    accountId,
    threadId,
    now: ctx.now,
    senderEmail,
    senderName: deciding.from_name || "",
    senderDomain,
    isOwnSender: ctx.ownerAddresses.has(senderEmail),
    addressing: addressingOf(deciding, ctx.ownerAddresses),
    repliedCount: sent?.count ?? 0,
    lastRepliedAt: sent?.lastAt ?? null,
    repliedDomain: Boolean(senderDomain) && ctx.sentDomains.has(senderDomain),
    isClientDomain: Boolean(senderDomain) && ctx.clientDomains.has(senderDomain),
    isFirstTimeSender: senderThreads <= 1 && !sent,
    youAreInThread: messages.some((m) => m.direction === "out"),
    youStartedThread: messages[0]!.direction === "out",
    lastInboundAt,
    lastOutboundAt,
    unansweredMs,
    askText,
    isBulk,
    isAuto: deciding.is_auto === 1,
    type,
    senderThreads,
    threadsPerWeek: senderThreads / spanWeeks,
    archiveWithoutReadRate: stats && stats.threads > 0 ? stats.archivedUnread / stats.threads : 0,
    neverOpened: Boolean(stats) && stats!.threads >= 3 && stats!.unread === stats!.threads,
    demotions: ctx.demoted.get(senderEmail) ?? 0,
  };
}

/** Writes the attention half of a verdict without disturbing the type or the category. */
export function updateAttention(db: Db, input: { accountId: string; threadId: string; split: "important" | "other"; attention: number; band: AttentionBand; reason: string }): void {
  db.prepare("UPDATE classifications SET split = ?, attention = ?, band = ?, reason = ? WHERE account_id = ? AND thread_id = ?").run(
    input.split,
    Math.round(input.attention),
    input.band,
    input.reason,
    input.accountId,
    input.threadId
  );
}

/** Threads in the Needs you band right now, newest first: still in the inbox, not asleep, not junk. */
export function needsYouCount(db: Db, accountIds?: string[]): number {
  const scope = accountIds && accountIds.length ? `AND t.account_id IN (${placeholders(accountIds.length)})` : "";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM threads t
       JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
       WHERE c.band = 'needs_you' AND t.in_inbox = 1
         AND NOT EXISTS (SELECT 1 FROM thread_labels tl WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id IN ('TRASH', 'SPAM'))
         AND NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.account_id = t.account_id AND s.thread_id = t.id AND s.status = 'pending')
         ${scope}`
    )
    .get(...(accountIds ?? [])) as { n: number };
  return row.n;
}

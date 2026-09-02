// The search syntax: Gmail-style operators in front of free text, compiled to
// an FTS5 MATCH for the words plus SQL predicates for everything the index
// does not hold (dates, labels, flags, queues). The / search box, the saved
// search rows, and Ask AI all go through parseSearchQuery and compileSearch,
// so one query means the same thing everywhere.
//
//   from:dana to:maya cc:priya subject:invoice "exact phrase" free words
//   has:attachment is:unread is:read is:starred
//   in:inbox in:archive in:snoozed in:daily in:weekly
//   before:2026-09-01 after:2026-08-01 newer_than:7d older_than:2w
//   label:clients category:newsletters
//
// Anything that does not parse (a bad date, an unknown is: value) is dropped
// and reported in `ignored`; the rest of the query still runs. An operator the
// syntax does not know (foo:bar) is searched as text.

import { NOT_JUNK, PENDING_SNOOZE } from "./fragments.js";
import { effectiveQueueSql } from "./queues.js";

export type InFilter = "inbox" | "archive" | "snoozed" | "daily" | "weekly";

export interface ParsedSearch {
  /** Free words, matched as prefixes across every indexed column. */
  text: string[];
  /** Quoted phrases, matched in order. */
  phrases: string[];
  from: string[];
  to: string[];
  cc: string[];
  subject: string[];
  hasAttachment: boolean;
  isUnread: boolean;
  isRead: boolean;
  isStarred: boolean;
  in: InFilter | null;
  /** Local start of the given day, in ms. */
  before: number | null;
  after: number | null;
  /** Relative windows in ms. */
  newerThan: number | null;
  olderThan: number | null;
  /** label: and category: values, lowercased. */
  labels: string[];
  /** Tokens that were not understood and did not run. */
  ignored: string[];
}

const EMPTY: ParsedSearch = {
  text: [],
  phrases: [],
  from: [],
  to: [],
  cc: [],
  subject: [],
  hasAttachment: false,
  isUnread: false,
  isRead: false,
  isStarred: false,
  in: null,
  before: null,
  after: null,
  newerThan: null,
  olderThan: null,
  labels: [],
  ignored: [],
};

const DAY_MS = 86_400_000;
const IN_VALUES = new Set<InFilter>(["inbox", "archive", "snoozed", "daily", "weekly"]);
const TOKEN = /([a-z_]+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/gi;

/** Local midnight of YYYY-MM-DD or YYYY/MM/DD; null for anything else, including impossible dates. */
export function parseSearchDate(value: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

/** 7d, 2w, 1m, 1y as milliseconds; null for anything else. */
export function parseSearchWindow(value: string): number | null {
  const m = /^(\d{1,4})([dwmy])$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  const days = unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
  return days * DAY_MS;
}

export function parseSearchQuery(input: string): ParsedSearch {
  const out: ParsedSearch = { ...EMPTY, text: [], phrases: [], from: [], to: [], cc: [], subject: [], labels: [], ignored: [] };
  for (const m of (input ?? "").matchAll(TOKEN)) {
    const [raw, op, quotedValue, bareValue, phrase, word] = m;
    if (op !== undefined) {
      const value = (quotedValue ?? bareValue ?? "").trim();
      const key = op.toLowerCase();
      if (!value) {
        out.ignored.push(raw);
        continue;
      }
      switch (key) {
        case "from":
          out.from.push(value);
          break;
        case "to":
          out.to.push(value);
          break;
        case "cc":
          out.cc.push(value);
          break;
        case "subject":
          out.subject.push(value);
          break;
        case "has":
          if (value.toLowerCase() === "attachment" || value.toLowerCase() === "attachments") out.hasAttachment = true;
          else out.ignored.push(raw);
          break;
        case "is": {
          const v = value.toLowerCase();
          if (v === "unread") out.isUnread = true;
          else if (v === "read") out.isRead = true;
          else if (v === "starred") out.isStarred = true;
          else out.ignored.push(raw);
          break;
        }
        case "in": {
          const v = value.toLowerCase();
          if (IN_VALUES.has(v as InFilter)) out.in = v as InFilter;
          else out.ignored.push(raw);
          break;
        }
        case "before": {
          const t = parseSearchDate(value);
          if (t === null) out.ignored.push(raw);
          else out.before = t;
          break;
        }
        case "after": {
          const t = parseSearchDate(value);
          if (t === null) out.ignored.push(raw);
          else out.after = t;
          break;
        }
        case "newer_than": {
          const w = parseSearchWindow(value);
          if (w === null) out.ignored.push(raw);
          else out.newerThan = w;
          break;
        }
        case "older_than": {
          const w = parseSearchWindow(value);
          if (w === null) out.ignored.push(raw);
          else out.olderThan = w;
          break;
        }
        case "label":
        case "category":
          out.labels.push(value.toLowerCase());
          break;
        default:
          // Not an operator we know: the whole token is words.
          out.text.push(raw.replace(/"/g, ""));
      }
      continue;
    }
    if (phrase !== undefined) {
      const p = phrase.trim();
      if (p) out.phrases.push(p);
      continue;
    }
    if (word) out.text.push(word.replace(/"/g, ""));
  }
  return out;
}

/** True when the query asks for something: words, a phrase, or at least one filter. */
export function isEmptySearch(p: ParsedSearch): boolean {
  return (
    p.text.length === 0 &&
    p.phrases.length === 0 &&
    p.from.length === 0 &&
    p.to.length === 0 &&
    p.cc.length === 0 &&
    p.subject.length === 0 &&
    !p.hasAttachment &&
    !p.isUnread &&
    !p.isRead &&
    !p.isStarred &&
    p.in === null &&
    p.before === null &&
    p.after === null &&
    p.newerThan === null &&
    p.olderThan === null &&
    p.labels.length === 0
  );
}

/** One FTS5 string term: quotes stripped, the rest quoted so operators in the text never reach the parser. */
function ftsTerm(value: string, prefix: boolean): string {
  const clean = value.replace(/"/g, "").trim();
  if (!clean) return "";
  return `"${clean}"${prefix ? "*" : ""}`;
}

/** The FTS5 MATCH expression for the words in the query, or null when only SQL predicates are asked for. */
export function toFtsMatch(p: ParsedSearch): string | null {
  const parts: string[] = [];
  for (const t of p.text) {
    const term = ftsTerm(t, true);
    if (term) parts.push(term);
  }
  for (const ph of p.phrases) {
    const term = ftsTerm(ph, false);
    if (term) parts.push(term);
  }
  for (const f of p.from) {
    const term = ftsTerm(f, true);
    if (term) parts.push(`from_text : ${term}`);
  }
  for (const s of p.subject) {
    const term = ftsTerm(s, true);
    if (term) parts.push(`subject : ${term}`);
  }
  return parts.length ? parts.join(" ") : null;
}

export interface CompiledSearch {
  /** The MATCH expression, or null when the query is filters only. */
  fts: string | null;
  /** Predicates against aliases m (messages), t (threads), c (classifications), q (queue_items), joined with AND. */
  where: string[];
  args: Array<string | number>;
}

export interface CompileOptions {
  now?: number;
  /** Day start for in:daily; the caller reads it from settings. */
  dayStartAt?: number;
  accountIds?: string[];
}

/** An address list column holds a match when any entry's email or name contains the value. */
function addressListMatch(column: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${column}) j WHERE lower(COALESCE(j.value ->> 'email', '')) LIKE ? OR lower(COALESCE(j.value ->> 'name', '')) LIKE ?)`;
}

function like(value: string): string {
  return `%${value.toLowerCase().replace(/[%_]/g, "")}%`;
}

export function compileSearch(p: ParsedSearch, opts: CompileOptions = {}): CompiledSearch {
  const now = opts.now ?? Date.now();
  const where: string[] = [NOT_JUNK];
  const args: Array<string | number> = [];
  if (opts.accountIds && opts.accountIds.length) {
    where.push(`t.account_id IN (${opts.accountIds.map(() => "?").join(", ")})`);
    args.push(...opts.accountIds);
  }
  for (const v of p.to) {
    where.push(addressListMatch("m.to_json"));
    args.push(like(v), like(v));
  }
  for (const v of p.cc) {
    where.push(addressListMatch("m.cc_json"));
    args.push(like(v), like(v));
  }
  if (p.hasAttachment) where.push("t.has_attachments = 1");
  if (p.isUnread) where.push("t.unread = 1");
  if (p.isRead) where.push("t.unread = 0");
  if (p.isStarred) where.push("t.starred = 1");
  switch (p.in) {
    case "inbox":
      where.push("t.in_inbox = 1", `NOT ${PENDING_SNOOZE}`);
      break;
    case "archive":
      where.push("t.in_inbox = 0", `NOT ${PENDING_SNOOZE}`);
      break;
    case "snoozed":
      where.push(PENDING_SNOOZE);
      break;
    case "daily":
    case "weekly":
      where.push(`${effectiveQueueSql(opts.dayStartAt ?? 0)} = '${p.in}'`);
      break;
    case null:
      break;
  }
  if (p.before !== null) {
    where.push("m.internal_date < ?");
    args.push(p.before);
  }
  if (p.after !== null) {
    where.push("m.internal_date >= ?");
    args.push(p.after);
  }
  if (p.newerThan !== null) {
    where.push("m.internal_date >= ?");
    args.push(now - p.newerThan);
  }
  if (p.olderThan !== null) {
    where.push("m.internal_date < ?");
    args.push(now - p.olderThan);
  }
  for (const label of p.labels) {
    // A custom category by id or name, a builtin type, or a Gmail label by name or id (STARRED, INBOX, Arcforma/Snoozed).
    where.push(
      `(lower(COALESCE(c.category_id, '')) = ? OR lower(COALESCE(c.type, '')) = ?
        OR c.category_id IN (SELECT id FROM categories WHERE lower(name) = ?)
        OR EXISTS (SELECT 1 FROM thread_labels tl LEFT JOIN labels l ON l.account_id = tl.account_id AND l.id = tl.label_id
                   WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND (lower(tl.label_id) = ? OR lower(COALESCE(l.name, '')) = ?)))`
    );
    args.push(label, label, label, label, label);
  }
  return { fts: toFtsMatch(p), where, args };
}

/** Markers snippet() wraps a matched term in; the renderer turns them into <mark>. shared/types.ts carries the same pair. */
export const HIGHLIGHT_START = "\uE000";
export const HIGHLIGHT_END = "\uE001";

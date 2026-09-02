// What the deterministic rules would do to a real mailbox. Opens the store
// read-only, runs ruleType() over every thread's deciding message, and prints
// the counts per type, the senders behind each one, and how many threads the
// new rules move. Nothing is written and no message body is read: the report
// works from addresses, subjects, and headers, and it prints addresses only.
//
//   node scripts/classify-report.mjs [path/to/mail.db]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DEFAULT_DB = path.join(os.homedir(), "Library", "Application Support", "Arcforma Mail", "mail.db");
const file = path.resolve(process.argv[2] || DEFAULT_DB);

if (!fs.existsSync(file)) {
  console.error(`classify-report: no store at ${file}`);
  process.exit(1);
}

const built = path.resolve(here, "../../../packages/gmail/dist/normalize.js");
if (!fs.existsSync(built)) {
  console.error("classify-report: build the gmail package first (pnpm --filter @arcforma/gmail build)");
  process.exit(1);
}
const { ruleType } = await import(built);

const db = new DatabaseSync(file, { readOnly: true });

/** Every message the rules need, ordered so the last inbound one is easy to find. */
const rows = db
  .prepare(
    `SELECT m.account_id, m.thread_id, m.from_email, m.subject, m.headers_json, m.direction, m.is_auto, b.attachments_json
     FROM messages m
     LEFT JOIN message_bodies b ON b.account_id = m.account_id AND b.message_id = m.id
     JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
     ORDER BY m.account_id, m.thread_id, m.internal_date, m.id`
  )
  .all();

const stored = new Map();
for (const c of db.prepare("SELECT account_id, thread_id, type, source FROM classifications").all()) {
  stored.set(`${c.account_id}/${c.thread_id}`, { type: c.type ?? null, source: c.source });
}

/** Addresses the owner has written to. The rules read this as "a person lives here". */
const knownAddresses = new Set();
for (const r of db.prepare("SELECT to_json, cc_json FROM messages WHERE direction = 'out'").all()) {
  for (const list of [r.to_json, r.cc_json]) {
    try {
      for (const a of JSON.parse(list)) if (a.email) knownAddresses.add(String(a.email).toLowerCase());
    } catch {
      // A malformed row cannot name a person.
    }
  }
}

db.close();

/** Groups the flat message list into threads, keeping only what the rules read. */
const threads = new Map();
for (const r of rows) {
  const key = `${r.account_id}/${r.thread_id}`;
  let t = threads.get(key);
  if (!t) {
    t = { key, messages: [], hasOutbound: false };
    threads.set(key, t);
  }
  if (r.direction === "out") t.hasOutbound = true;
  t.messages.push(r);
}

function headersOf(row) {
  try {
    return JSON.parse(row.headers_json ?? "{}");
  } catch {
    return {};
  }
}

function hasCalendar(row, headers) {
  if (/text\/calendar|application\/ics/i.test(headers["Content-Type"] ?? "")) return true;
  try {
    return JSON.parse(row.attachments_json ?? "[]").some((a) => /\.ics$/i.test(a.filename ?? "") || /text\/calendar/i.test(a.mimeType ?? ""));
  } catch {
    return false;
  }
}

/** The same shape ruleInputFromRow builds, as a Gmail message the rules can read. */
function toGmailMessage(row) {
  const headers = headersOf(row);
  const calendar = hasCalendar(row, headers);
  const list = Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
  if (!headers["From"]) list.push({ name: "From", value: row.from_email });
  if (!headers["Subject"]) list.push({ name: "Subject", value: row.subject });
  return { id: "report", threadId: "report", payload: { mimeType: calendar ? "multipart/mixed" : "text/plain", headers: list, parts: calendar ? [{ mimeType: "text/calendar" }] : [] } };
}

/** The last inbound message decides; an all-outbound thread is decided by its last. */
function deciding(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].direction === "in") return messages[i];
  return messages[messages.length - 1] ?? null;
}

const NONE = "(no type, to the model or the split rules)";
const counts = new Map();
const sendersByType = new Map();
const before = new Map();
let changed = 0;
let total = 0;

for (const t of threads.values()) {
  const row = deciding(t.messages);
  if (!row) continue;
  total += 1;
  const type = ruleType(toGmailMessage(row), { knownAddresses, threadHasOutbound: t.hasOutbound }) ?? null;
  const key = type ?? NONE;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  const senders = sendersByType.get(key) ?? new Map();
  senders.set(row.from_email, (senders.get(row.from_email) ?? 0) + 1);
  sendersByType.set(key, senders);
  const was = stored.get(t.key)?.type ?? null;
  const wasKey = was ?? NONE;
  before.set(wasKey, (before.get(wasKey) ?? 0) + 1);
  if (was !== type) changed += 1;
}

const ORDER = ["newsletters", "promotions", "jobs", "calendar", "notifications", "receipts", NONE];
const order = (m) => [...new Set([...ORDER, ...m.keys()])].filter((k) => m.has(k));

function table(title, m) {
  console.log(`\n${title}`);
  console.log("  type                 threads");
  for (const k of order(m)) console.log(`  ${k.padEnd(20)} ${String(m.get(k)).padStart(7)}`);
  console.log(`  ${"total".padEnd(20)} ${String(total).padStart(7)}`);
}

console.log(`classify-report: ${file}`);
console.log(`threads: ${total}   stored verdicts: ${stored.size}`);
table("Stored today (whatever wrote it, rules or model)", before);
table("New deterministic rules", counts);

console.log(`\nThreads the new rules type differently: ${changed} of ${total} (${Math.round((changed / total) * 100)} percent)`);

for (const k of order(counts)) {
  const senders = [...sendersByType.get(k).entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`\nTop senders, ${k} (${counts.get(k)} threads)`);
  for (const [email, n] of senders) console.log(`  ${String(n).padStart(5)}  ${email}`);
}

// What the attention model says about a real mailbox. Opens the store
// read-only, builds the shared context once, scores every thread through the
// same code the app runs, and prints the band distribution, the senders behind
// Needs you, how much of Needs you is stale, and a sample of scored rows with
// the reason each one was given. Nothing is written. No message body is
// printed: the sample shows the sender's domain, the first characters of the
// subject, the score, and the reason sentence.
//
//   node scripts/attention-report.mjs [path/to/mail.db]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.join(os.homedir(), "Library", "Application Support", "Arcforma Mail", "mail.db");
const file = path.resolve(process.argv[2] || DEFAULT_DB);

if (!fs.existsSync(file)) {
  console.error(`attention-report: no store at ${file}`);
  process.exit(1);
}

const storeDist = path.resolve(here, "../../../packages/store/dist/index.js");
const gmailDist = path.resolve(here, "../../../packages/gmail/dist/index.js");
for (const [name, p] of [["@arcforma/store", storeDist], ["@arcforma/gmail", gmailDist]]) {
  if (!fs.existsSync(p)) {
    console.error(`attention-report: build ${name} first (pnpm --filter ${name} build)`);
    process.exit(1);
  }
}
const { attentionContext, attentionFactsFor } = await import(storeDist);
// The scorer is the app's own source. Node strips its types, so the report and the app cannot drift.
const { scoreAttention, NEEDS_YOU_FLOOR, IMPORTANT_FLOOR } = await import(path.resolve(here, "../electron/classify/attention.ts"));

const db = new DatabaseSync(file, { readOnly: true });
const now = Date.now();
const ctx = attentionContext(db, now);

const threads = db.prepare("SELECT account_id, id, subject, in_inbox, last_message_at FROM threads ORDER BY sort_at DESC").all();
const stored = new Map();
for (const c of db.prepare("SELECT account_id, thread_id, split, type FROM classifications").all()) {
  stored.set(`${c.account_id}/${c.thread_id}`, { split: c.split, type: c.type ?? null });
}

const DAY = 86_400_000;
const bands = new Map([
  ["needs_you", 0],
  ["important", 0],
  ["other", 0],
]);
const inboxBands = new Map([
  ["needs_you", 0],
  ["important", 0],
  ["other", 0],
]);
const needsYouSenders = new Map();
const needsYouRows = [];
const scored = [];
let wasImportant = 0;
let nowImportant = 0;
let skipped = 0;

for (const t of threads) {
  const facts = attentionFactsFor(db, t.account_id, t.id, ctx, { type: stored.get(`${t.account_id}/${t.id}`)?.type ?? null });
  if (!facts) {
    skipped += 1;
    continue;
  }
  const v = scoreAttention(facts);
  bands.set(v.band, bands.get(v.band) + 1);
  if (t.in_inbox === 1) inboxBands.set(v.band, inboxBands.get(v.band) + 1);
  if (stored.get(`${t.account_id}/${t.id}`)?.split === "important") wasImportant += 1;
  if (v.band !== "other") nowImportant += 1;
  const row = { key: `${t.account_id}/${t.id}`, subject: t.subject, inInbox: t.in_inbox === 1, lastAt: t.last_message_at, facts, v };
  scored.push(row);
  if (v.band === "needs_you" && t.in_inbox === 1) {
    needsYouRows.push(row);
    needsYouSenders.set(facts.senderEmail, (needsYouSenders.get(facts.senderEmail) ?? 0) + 1);
  }
}

db.close();

const pct = (n, of) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "0%");
const total = scored.length;

console.log(`attention-report: ${file}`);
console.log(`threads scored: ${total}${skipped ? ` (${skipped} with no messages skipped)` : ""}   stored verdicts: ${stored.size}`);
console.log(`bands: needs_you at ${NEEDS_YOU_FLOOR} and above with a person asking, important at ${IMPORTANT_FLOOR} and above`);

console.log("\nBand distribution");
console.log("  band          all threads          in the inbox");
for (const band of ["needs_you", "important", "other"]) {
  const a = bands.get(band);
  const i = inboxBands.get(band);
  console.log(`  ${band.padEnd(12)} ${String(a).padStart(6)} ${pct(a, total).padStart(6)}      ${String(i).padStart(6)} ${pct(i, inboxBands.get("needs_you") + inboxBands.get("important") + inboxBands.get("other")).padStart(6)}`);
}
console.log(`  ${"total".padEnd(12)} ${String(total).padStart(6)}`);
console.log(`\nImportant before (stored split): ${wasImportant}   after (needs_you plus important): ${nowImportant}`);

const stale = needsYouRows.filter((r) => now - (r.facts.lastInboundAt ?? r.lastAt) > 3 * DAY);
console.log(`\nNeeds you in the inbox: ${needsYouRows.length}   older than 3 days: ${stale.length} (${pct(stale.length, needsYouRows.length)})`);

console.log(`\nTop senders in Needs you (${needsYouSenders.size} distinct)`);
console.log("  threads  sender");
for (const [email, n] of [...needsYouSenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(7)}  ${email}`);
}

const sample = needsYouRows.slice(0, 15);
const filler = sample.length < 15 ? scored.filter((r) => r.v.band === "important").slice(0, 15 - sample.length) : [];
console.log(`\nSample rows (${sample.length} from Needs you, ${filler.length} from Important)`);
console.log("  score  band        sender domain              subject                                    reason");
for (const r of [...sample, ...filler]) {
  const domain = (r.facts.senderDomain || "(none)").slice(0, 24);
  const subject = (r.subject || "(no subject)").replace(/\s+/g, " ").slice(0, 40);
  console.log(`  ${String(r.v.score).padStart(5)}  ${r.v.band.padEnd(10)}  ${domain.padEnd(24)}  ${subject.padEnd(40)}  ${r.v.reason}`);
}

const buckets = new Map();
for (const r of scored) {
  const b = Math.min(9, Math.floor(r.v.score / 10)) * 10;
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
console.log("\nScore histogram");
for (const b of [...buckets.keys()].sort((a, c) => a - c)) {
  console.log(`  ${String(b).padStart(3)} to ${String(b + 9).padStart(3)}  ${String(buckets.get(b)).padStart(6)}  ${"#".repeat(Math.round((buckets.get(b) / total) * 60))}`);
}

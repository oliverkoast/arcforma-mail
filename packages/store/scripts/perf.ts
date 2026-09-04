// The speed budget. Seeds a synthetic mailbox the size of a heavy real one and
// times the reads that run while someone is using the app, so a change that
// makes the list slow fails a check rather than being noticed months later on
// a machine nobody can reproduce.
//
//   node --import tsx scripts/perf.ts [--threads=60000] [--json] [--write-baseline]
//
// Every probe here is synchronous work on the Electron main thread. A frame is
// 16 ms, so anything over that is a stutter the user can feel, and anything
// over 100 ms reads as the app hanging. That is the budget. Where the app does
// not meet it yet, the probe also carries an accepted ceiling and the backlog
// item that closes the gap, so a known problem stays visible without turning
// the whole check red and teaching everyone to ignore it.
//
// Accepted ceilings carry roughly twice the median measured on a development
// machine, because the machines vary by more than the thing being measured:
// one tree measured 524 ms here and 678 ms with a p95 of 966 ms on a GitHub
// macOS runner. A ceiling tighter than that flaps, and a check that flaps is a
// check nobody reads. Ceilings ratchet down only. The half of this that does
// not depend on the clock is src/plans.test.ts, which asserts the query plans
// and gives the same answer on any machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSnooze,
  listThreads,
  openStore,
  search,
  sidebarCounts,
  transaction,
  upsertAccount,
  upsertClassification,
  upsertThreadFromGmail,
  type Db,
  type GmailThreadInput,
} from "../src/index.js";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const writeBaseline = argv.includes("--write-baseline");
const threadCount = Number(argv.find((a) => a.startsWith("--threads="))?.split("=")[1] ?? 60_000);

const ACCOUNTS = ["work", "personal"];
const OWNER = "you@example.com";
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const HOUR = 3_600_000;

const SENDERS = [
  { from: "Dana Reyes <dana@northwind.example>", person: true },
  { from: "Sam Ortiz <sam@lumen.example>", person: true },
  { from: "Kim Lee <kim@friends.example>", person: true },
  { from: "The Weekly <news@publication.example>", person: false },
  { from: "no-reply@platform.example", person: false },
  { from: "receipts@store.example", person: false },
];

const SUBJECTS = [
  "Northwind deck for Thursday",
  "Invoice 4471 is due",
  "Re: onboarding questions",
  "Your weekly digest",
  "Order shipped",
  "Can you look at this before Friday",
  "Renewal notice",
  "Notes from the call",
];

/** One of a list that is never empty. The strict index checks do not know that, so say it once here. */
function pick<T>(list: readonly T[], n: number): T {
  return list[n % list.length] as T;
}

/**
 * One synthetic thread, shaped like what the Gmail sync hands the store, and
 * filed the way a real mailbox of this size is filed. That last part decides
 * whether the numbers below mean anything: a fixture where all 60,000 threads
 * sit in the inbox makes every inbox count look like a full table scan and
 * every archive count look free, which is the opposite of a mailbox someone
 * has actually been using for four years.
 *
 * The shape here: about 4 in 100 threads still in the inbox, 1 in 89 spam,
 * 1 in 97 trashed, 1 in 200 holding a draft, 1 in 50 starred, 1 in 7 carrying
 * a file, and a third unread. Snoozes are added separately because they live
 * in their own table.
 */
function thread(n: number): GmailThreadInput {
  const sender = pick(SENDERS, n);
  const subject = `${pick(SUBJECTS, n)} ${n}`;
  const date = T0 - n * (HOUR / 4);
  const attachment = n % 7 === 0;
  const labels: string[] = [];
  if (n % 89 === 0) labels.push("SPAM");
  else if (n % 97 === 0) labels.push("TRASH");
  else if (n % 25 === 0) labels.push("INBOX");
  if (n % 3 === 0) labels.push("UNREAD");
  if (n % 50 === 0) labels.push("STARRED");
  if (n % 200 === 0) labels.push("DRAFT");
  return {
    id: `t-${n}`,
    historyId: String(n),
    messages: [
      {
        id: `m-${n}`,
        threadId: `t-${n}`,
        labelIds: labels,
        snippet: `${subject}. Some body text so the index has words to match on.`,
        internalDate: String(date),
        historyId: String(n),
        payload: {
          mimeType: attachment ? "multipart/mixed" : "text/plain",
          headers: [
            { name: "From", value: sender.from },
            { name: "To", value: `Oliver Korzen <${OWNER}>` },
            { name: "Subject", value: subject },
            { name: "Message-ID", value: `<m-${n}@example.com>` },
            ...(sender.person ? [] : [{ name: "List-Id", value: "<list.example>" }]),
          ],
          parts: attachment ? [{ mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: `a-${n}`, size: 1024 } }] : [],
        },
      },
    ],
  };
}

function seed(count: number): { db: Db; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-perf-"));
  const db = openStore(path.join(dir, "mail.db"));
  for (const id of ACCOUNTS) upsertAccount(db, { id, email: id === "work" ? OWNER : "you@gmail.com" });
  const owners = { ownerAddresses: [OWNER, "you@gmail.com"] };
  // One transaction for the lot: 60k separate commits is the harness being slow,
  // not the store, and it would hide the numbers we came for behind a coffee break.
  transaction(db, () => {
    for (let n = 0; n < count; n++) {
      const accountId = pick(ACCOUNTS, n);
      // A thread whose only message is a draft is not a thread here: the store
      // drops the row and returns null, and there is nothing to classify.
      if (!upsertThreadFromGmail(db, accountId, thread(n), owners)) continue;
      // Two thirds of a real mailbox is filed away from Important, and the
      // split column is on the hot path of every list read.
      upsertClassification(db, {
        accountId,
        threadId: `t-${n}`,
        split: n % 3 === 0 ? "important" : "other",
        type: n % 3 === 0 ? undefined : "newsletters",
        attention: n % 3 === 0 ? 70 : 10,
        band: n % 9 === 0 ? "needs_you" : undefined,
      });
      // Snoozed threads are the reason PENDING_SNOOZE exists, and a fixture
      // with none of them hides what that subquery costs.
      if (n % 200 === 7) createSnooze(db, { accountId, threadId: `t-${n}`, wakeAt: T0 + 24 * HOUR });
    }
  });
  return { db, dir };
}

interface Probe {
  name: string;
  /** What the user is doing when this runs. */
  what: string;
  /** What the bar says this should cost. */
  budgetMs: number;
  /** What it costs today, when that is worse than the budget, plus the backlog item that closes the gap.
   *  The gate fails above this number, so a known breach stays visible without turning the whole
   *  check red and teaching everyone to ignore it. Lower it when the fix lands; never raise it
   *  without a line in loop/JOURNAL.md saying why. */
  acceptedMs?: number;
  trackedBy?: string;
  run: (db: Db) => void;
}

const PROBES: Probe[] = [
  {
    name: "list:inbox",
    what: "opening the app: the first page of the inbox, every account",
    budgetMs: 16,
    run: (db) => void listThreads(db, { view: "inbox", limit: 50 }),
  },
  {
    name: "list:inbox-important",
    what: "the Important half of the split inbox",
    budgetMs: 16,
    run: (db) => void listThreads(db, { view: "inbox", split: "important", limit: 50 }),
  },
  {
    name: "list:inbox-other",
    what: "the Other half of the split inbox",
    budgetMs: 16,
    run: (db) => void listThreads(db, { view: "inbox", split: "other", limit: 50 }),
  },
  {
    name: "list:needsyou",
    what: "the Needs you row, the first thing on the sidebar",
    budgetMs: 16,
    run: (db) => void listThreads(db, { view: "needsyou", limit: 50 }),
  },
  {
    name: "list:done",
    what: "the Done row: everything that ever left the inbox",
    budgetMs: 16,
    run: (db) => void listThreads(db, { view: "archive", limit: 50 }),
  },
  {
    name: "list:page-20",
    what: "one more page of the inbox, a thousand threads down",
    budgetMs: 16,
    run: (db) => void listThreads(db, { view: "inbox", limit: 50, cursor: deepCursor(db) }),
  },
  {
    name: "list:daily",
    what: "Daily 0, the queue the product is built around",
    budgetMs: 16,
    acceptedMs: 40,
    trackedBy: "L-011",
    run: (db) => void listThreads(db, { view: "daily", limit: 50 }),
  },
  {
    name: "sidebar:counts",
    what: "every count on the sidebar, refreshed after archive, snooze, star, re-file and eight more",
    budgetMs: 32,
    acceptedMs: 700,
    trackedBy: "L-001",
    run: (db) => void sidebarCounts(db),
  },
  {
    name: "search:word",
    what: "typing a word into search",
    budgetMs: 100,
    run: (db) => void search(db, "invoice", { limit: 40 }),
  },
  {
    name: "search:from",
    what: "search with a from: operator",
    budgetMs: 100,
    run: (db) => void search(db, "from:dana deck", { limit: 40 }),
  },
];

/** The cursor twenty pages into the inbox, worked out once so the probe times one page and not twenty. */
let cachedCursor: string | null | undefined;
function deepCursor(db: Db): string | undefined {
  if (cachedCursor === undefined) {
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: { nextCursor: string | null } = listThreads(db, { view: "inbox", limit: 50, cursor: cursor ?? undefined });
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    cachedCursor = cursor;
  }
  return cachedCursor ?? undefined;
}

function timeIt(fn: () => void, runs: number): { median: number; p95: number } {
  // One warm run first: the first prepare compiles the statement, and nobody
  // experiences that cost twice.
  fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const at = (i: number): number => samples[Math.min(samples.length - 1, Math.max(0, i))] ?? 0;
  return { median: at(Math.floor(samples.length / 2)), p95: at(Math.floor(samples.length * 0.95)) };
}

function main(): void {
  const started = performance.now();
  const { db, dir } = seed(threadCount);
  const seeded = performance.now() - started;

  const results = PROBES.map((p) => {
    const { median, p95 } = timeIt(() => p.run(db), 25);
    const ceiling = p.acceptedMs ?? p.budgetMs;
    return {
      name: p.name,
      what: p.what,
      budgetMs: p.budgetMs,
      acceptedMs: p.acceptedMs ?? null,
      trackedBy: p.trackedBy ?? null,
      medianMs: median,
      p95Ms: p95,
      /** Worse than what it costs today: a regression, and the gate fails. */
      failed: median > ceiling,
      /** Worse than the bar but no worse than today: a known gap with a backlog item on it. */
      overBudget: median > p.budgetMs,
    };
  });

  db.close?.();
  fs.rmSync(dir, { recursive: true, force: true });

  const report = { threads: threadCount, seededMs: Math.round(seeded), node: process.version, at: new Date().toISOString(), results };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const width = Math.max(...results.map((r) => r.name.length));
    process.stdout.write(`speed budget: ${threadCount.toLocaleString("en-US")} threads, seeded in ${(seeded / 1000).toFixed(1)}s, node ${process.version}\n\n`);
    for (const r of results) {
      const name = r.name.padEnd(width);
      const median = `${r.medianMs.toFixed(2)} ms`.padStart(9);
      const p95 = `${r.p95Ms.toFixed(2)} ms`.padStart(9);
      const budget = `${r.budgetMs} ms`.padStart(7);
      const state = r.failed ? "FAIL" : r.overBudget ? "GAP " : "ok  ";
      const tail = r.failed
        ? r.acceptedMs === null
          ? "  over the budget, with no accepted ceiling to sit under"
          : `  worse than the ${r.acceptedMs} ms this costs today`
        : r.overBudget
          ? `  known gap, tracked as ${r.trackedBy ?? "nothing yet"}`
          : "";
      process.stdout.write(`${state} ${name}  median ${median}  p95 ${p95}  budget ${budget}${tail}\n`);
    }
    process.stdout.write("\n");
  }

  if (writeBaseline) {
    const file = path.resolve(import.meta.dirname, "..", "..", "..", "loop", "perf-baseline.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`baseline written to ${file}\n`);
  }

  const gaps = results.filter((r) => r.overBudget && !r.failed);
  if (gaps.length > 0 && !asJson) process.stdout.write(`known gaps, not blocking: ${gaps.map((r) => `${r.name} (${r.trackedBy ?? "untracked"})`).join(", ")}\n`);

  const failed = results.filter((r) => r.failed);
  if (failed.length > 0) {
    process.stderr.write(`slower than it was: ${failed.map((r) => r.name).join(", ")}\n`);
    process.exitCode = 1;
  }
}

main();

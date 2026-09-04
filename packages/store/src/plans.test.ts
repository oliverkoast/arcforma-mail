// Query plans, asserted rather than timed. The speed budget in scripts/perf.ts
// says what the reads cost; this says why, in a way that gives the same answer
// on a fast laptop and a loaded CI runner. A plan that stops using an index is
// the change that makes the app feel broken, and it is invisible in a diff.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, type Db } from "./index.js";
import { NOT_JUNK, PENDING_SNOOZE } from "./queries/fragments.js";

function store(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-plans-"));
  return openStore(path.join(dir, "mail.db"));
}

function plan(db: Db, sql: string): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as Array<{ detail: string }>).map((r) => r.detail);
}

test("asking whether a thread is asleep is an index seek, not a walk of every snooze", () => {
  const db = store();
  const detail = plan(db, `SELECT COUNT(*) FROM threads t WHERE ${PENDING_SNOOZE}`).join("\n");
  // Without snoozes_thread (migration 17) SQLite falls back to snoozes_due, which seeks on status
  // alone and then walks every pending snooze, once per thread row. Every list and every count asks
  // this question, so at 60,000 threads and 300 pending snoozes the sidebar counts took 5.4 s.
  // Measured by scripts/perf.ts.
  assert.match(detail, /INDEX snoozes_thread/, detail);
  assert.doesNotMatch(detail, /INDEX snoozes_due/, detail);
});

test("asking whether a thread is junk is an index seek", () => {
  const db = store();
  const detail = plan(db, `SELECT COUNT(*) FROM threads t WHERE ${NOT_JUNK}`).join("\n");
  assert.match(detail, /INDEX sqlite_autoindex_thread_labels_1/, detail);
  assert.doesNotMatch(detail, /SCAN tl\b/, detail);
});

test("the unified thread list is served by threads_all_sort, not a sort of the whole table", () => {
  const db = store();
  const detail = plan(db, "SELECT t.* FROM threads t ORDER BY t.sort_at DESC, t.account_id, t.id LIMIT 50").join("\n");
  assert.match(detail, /threads_all_sort/, detail);
  assert.doesNotMatch(detail, /USE TEMP B-TREE FOR ORDER BY/, detail);
});

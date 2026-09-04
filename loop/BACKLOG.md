# Backlog

The queue the improvement loop works from. One item per iteration, top of the queue first,
verified before it is started and measured after it is finished.

Every item cites a clause of `loop/BAR.md`, or it is a plain bug. An item that cites neither is
scope creep and belongs in `docs/ROADMAP.md` as a product decision, not here as work.

**Status** is one of: `open`, `doing`, `done`, `dropped`.
**Verified** says when someone last confirmed the problem still exists, and how. This matters more
than it sounds: `docs/AUDIT.md` was written on 2026-09-02 and by 2026-09-04 three of its top ten
were already fixed, so an unverified item is a guess. The first step of every iteration is to
re-check.

---

## Queue

### L-001 Every sidebar count reads the whole mailbox
Area: speed. Size: M. Bar: 1. Status: open.
Verified 2026-09-04 by measurement, after L-012 removed the snooze scan: `sidebar:counts` is a
median of 308 ms at 60,000 threads. It splits into `queueCounts` 96 ms, the rest of `threadCounts`
65 ms, and the folder and group aggregates about 137 ms. All four read every row in `threads`,
whether or not the row can possibly contribute.
Why it matters: `refreshCounts` runs after archive, snooze, star, re-file, move to inbox and eight
other actions, synchronously on the Electron main thread.
Done when: `sidebar:counts` median is under 32 ms at 60,000 threads, the accepted ceiling in
`packages/store/scripts/perf.ts` is lowered to match, and no count changes value. Prove the last
part with a test that compares every field of `sidebarCounts` against the counts computed the naive
way, on a fixture that includes the awkward overlaps: a thread both snoozed and holding a draft, a
thread labelled both spam and trash, a queued thread that was then archived.
Shape of the fix, from the measurement: drive each count from the small set rather than the big one.
Queue counts from `queue_items` plus the inbox, not the whole table. Snoozed from `snoozes`. Spam
and trash from `thread_labels`. Done as arithmetic over those, since it is the only count that is
genuinely most of the mailbox.

### L-011 Daily 0 reads the whole mailbox to find the threads in it
Area: speed. Size: S. Bar: 1. Status: open.
Verified 2026-09-04 by measurement: `list:daily` is a median of 12.9 ms at 60,000 threads, against a
16 ms budget, and it is the queue the product is built around. The queue expression is evaluated for
every thread in the table because `listThreads` puts it in the WHERE clause. Same shape as the
`queueCounts` half of L-001 and probably the same fix.

### L-002 The sanitiser tests assert a configuration array and never sanitise anything
Area: security. Size: M. Bar: 7. Status: open.
Verified 2026-09-04 by reading: `apps/desktop/src/lib/mailhtml.test.ts` never calls
`sanitizeMailHtml`, and `apps/desktop/src/lib/quote-sanitize.test.ts` asserts that
`QUOTE_FORBID_TAGS` contains certain strings without ever invoking DOMPurify.
Why it matters: rendering mail written by strangers is the product's core risk, and its test
coverage is the most convincing-looking theatre in the tree. Deleting the sanitiser call entirely
would leave both suites green.
Done when: hostile HTML runs through the real sanitiser under `happy-dom`, one case per technique
already enumerated in `docs/STANDARDS.md`, for both the reading pane and the compose quote, and
removing one entry from the forbid lists turns a test red.

### L-003 Electron 41 reached end of life on 2026-08-25, and no fuses are set
Area: security. Size: M. Bar: 7. Status: open.
Verified 2026-09-04 by reading: `apps/desktop/package.json` pins `electron: ^41.10.7`;
`apps/desktop/scripts/afterPack.cjs` sets no fuses.
Why it matters: this app renders HTML written by strangers on a Chromium that no longer receives
security fixes. `docs/STANDARDS.md` section 1.2 argues it at length and calls it the highest-value
change in the repository.
Done when: the pin is on a supported major, the suite and the smoke walk pass on it, and
`afterPack.cjs` sets `runAsNode` off, `enableCookieEncryption` on, `nodeOptions` off,
`nodeCliInspect` off and `onlyLoadAppFromAsar` on, with the fuse state asserted by a test.

### L-004 Cold start is a claim, not a number
Area: speed. Size: S. Bar: 1. Status: open.
Verified 2026-09-04 by reading: nothing in the tree times startup. `docs/ROADMAP.md` asserts a
2 s budget and no check exists.
Why it matters: first paint is the impression the app makes, and the only budget in the bar with
nothing behind it.
Done when: the smoke walk prints milliseconds from launch to the first inbox row, `pnpm gate` fails
above a ceiling recorded the same way the speed probes record theirs, and the number goes in the
journal.

### L-005 No React component is rendered by any test
Area: correctness. Size: M. Bar: 3. Status: open.
Verified 2026-09-04 by reading: there is no `*.test.tsx` under `apps/desktop/src/components`.
Why it matters: every empty, error and loading state in the bar's third clause is currently checked
by a person remembering to look. The smoke walk covers five screens on the happy path and nothing
else.
Done when: the states of the thread list, the reading pane and compose are rendered under
`happy-dom` and asserted, starting with empty, loading, error and offline.

### L-006 The supply-chain cooldown is declared and switched off
Area: build. Size: S. Bar: 7. Status: open.
Verified 2026-09-04 by reading: `pnpm-workspace.yaml` carries a 31-entry `minimumReleaseAgeExclude`
list and no `minimumReleaseAge`, so there is no cooldown for the exclude list to except.
Done when: `minimumReleaseAge` is set, `pnpm install --frozen-lockfile` still resolves, and the
exclude list is trimmed to what actually needs excepting.

### L-007 The address parser exists twice, byte for byte
Area: correctness. Size: S. Status: open.
Verified 2026-09-04 by reading: `parseAddressList` is defined in both
`packages/gmail/src/mime.ts` and `packages/store/src/mail-headers.ts`, one on the sync path and one
on the write path, each tested only against its own copy.
Done when: one implementation, imported by both, with the union of both test suites against it.

### L-008 Most IPC handlers trust their arguments
Area: security. Size: L. Bar: 7. Status: open.
Claimed by `docs/AUDIT.md:234` (53 of 76 handlers), not re-verified. `apps/desktop/electron/
ipc-guard.ts` and `ipc-sender.ts` exist; how much of the surface they cover is the first thing to
check.
Done when: the count is re-measured, every handler that takes a structured payload validates it at
runtime, and `compose:send` is among them.

### L-009 The store is synchronous on the Electron main thread
Area: speed. Size: L. Bar: 1. Status: open.
Claimed by `docs/AUDIT.md:980`, not re-verified beyond the L-001 measurement, which is one symptom
of it. Do not start this before L-001: fixing the query may remove the reason to move the store.

### L-010 The Swift app is invisible to CI
Area: build. Size: S. Status: open.
Claimed by `docs/AUDIT.md:456`, verified by reading `.github/workflows/ci.yml`: nothing builds or
tests `packages/text-tools`.

---

## Standing passes

Not items to finish, rotations to run. One per iteration, in order, then start again. Record what
was looked at and what it produced in `loop/JOURNAL.md`, and put anything found into the queue
rather than fixing it in the same pass.

1. **States**, bar clause 3. One surface at a time: thread list, reading pane, compose, search,
   settings, onboarding, calendar rail, contact rail. For each: what does it show while loading,
   with nothing in it, after a failure, with the network off, when signed out, and when the thing it
   was showing has gone.
2. **Reversibility**, bar clause 4. One action at a time, in keymap order: does it leave an undo,
   does the undo run the reverse through the same channel, and if it cannot be taken back does it
   say so before it happens.
3. **Keyboard**, bar clause 2. Take a task a person does daily, do it with the mouse unplugged, and
   write down every point where that failed.
4. **One surface**, bar clause 6: the same idea rendered two different ways in two places.

---

## Done

### L-012 Nothing indexed the question every list and every count asks
Area: speed. Bar: 1. Closed 2026-09-04.
Found by the speed budget on the first run against a fixture shaped like a real mailbox rather than
one where every thread sits in the inbox. `snoozes` carried an index on `(status, wake_at)` and
none on the thread, so `PENDING_SNOOZE`, which every list and every count evaluates once per thread,
seeked on status alone and then walked every pending snooze. The cost was the product of the two
numbers: 60,000 threads by 300 sleeping threads.
Before: `sidebar:counts` 5,389 ms, `list:needsyou` 19.45 ms, `needsYouCount` 114 ms.
After: `sidebar:counts` 308 ms, `list:needsyou` 3.28 ms, `needsYouCount` 9.30 ms.
The fix is one index, migration 17. The regression test is `packages/store/src/plans.test.ts`, which
asserts the plan rather than the time, so it gives the same answer on a loaded CI runner as on a
laptop; without the migration it fails, because SQLite falls back to `snoozes_due`.

## Dropped

Nothing yet. An item is dropped with a reason, never deleted.

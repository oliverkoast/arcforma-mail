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

**Where a number came from is part of the number.** `pnpm perf` runs against 60,000 synthetic
threads. That is a stress test and a regression tripwire, not a description of anyone's mailbox: the
same query that reads 160 ms there reads 20 ms on a real 5,000 thread mailbox. Both belong in an
item. Neither may stand in for the other.

---

## Queue

### L-001 Every sidebar count reads the whole mailbox
Area: speed. Size: M. Bar: 1. Status: open.
Verified 2026-09-05 by measurement, two of them.
On a real mailbox (5,370 threads, no snoozes) `sidebarCounts` is a median of 20 ms, inside the 32 ms
budget. Nobody is feeling this today.
On the harness (60,000 synthetic threads) it is a median of 160 ms against the same budget, and it
splits into `queueCounts`, the rest of `threadCounts`, and the folder and group aggregates. All of
them read every row in `threads`, whether or not the row can possibly contribute, so the cost grows
with the whole mailbox rather than with the answer.
Why it matters: `refreshCounts` runs after archive, snooze, star, re-file, move to inbox and eight
other actions, synchronously on the Electron main thread. It is fine at today's size and it is the
shape that stops being fine as a mailbox grows.
Done when: `sidebar:counts` median is under 32 ms at 60,000 threads, the accepted ceiling in
`packages/store/scripts/perf.ts` is lowered to match, and no count changes value. Prove the last
part with a test comparing every field of `sidebarCounts` against the counts computed the naive way,
on a fixture with the awkward overlaps: a thread both snoozed and holding a draft, a thread labelled
both spam and trash, a queued thread that was then archived.
Shape of the fix, from the measurement: drive each count from the small set rather than the big one.
Queue counts from `queue_items` plus the inbox, not the whole table. Snoozed from `snoozes`. Spam and
trash from `thread_labels`. Done as arithmetic over those, since it is the only count that is
genuinely most of the mailbox.

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

### L-013 Nobody but Oliver can run `pnpm build`, and CI has never run it
Area: build. Size: S. Status: open, blocked on a decision.
Verified 2026-09-05 by reading `.github/workflows/ci.yml` on main and by measurement: CI still runs
`pnpm --filter desktop build`, and the desktop package runs `scripts/sync-brand.mjs` in its
`prebuild`, which exits 1 when the brand repo is not on the machine. `apps/desktop/public/brand/` is
gitignored, so no checkout of this repository can ever have it. The workflow already says the
opposite one line earlier (`pnpm sync-brand || echo "brand assets are not in this checkout;
skipping"`) and the prebuild overrides it.
Why it matters: the build and the smoke walk are the only checks that cross the renderer to IPC to
store seam, `CONTRIBUTING.md` calls them mandatory, and `docs/AUDIT.md` made putting them in CI item
four of ten. They have been in CI since it was written and have never run. A stranger cloning this
repository cannot build it either, which blocks the whole of roadmap phase 3.
Measured 2026-09-04 on Linux with no brand assets: the renderer builds, the Electron bundle builds,
the electron typecheck passes, and the smoke walk completes 41 screenshots with one console error,
which is a headless capture limit for the PDF preview window and not brand related. So the only
thing failing is the hard exit.
The decision, which is Oliver's because it touches the brand rules: either CI builds unbranded (the
screenshots then prove the app runs and prove nothing about how it looks), or CI is given the brand
repo through a deploy key and `ARCFORMA_BRAND_DIR`, which a fork or an outside contributor still
will not have. The first is needed anyway for anyone else to build this.

### L-011 Daily 0 reads the whole mailbox to find the threads in it
Area: speed. Size: S. Bar: 1. Status: open.
Verified 2026-09-04 by measurement: `list:daily` is a median of 12.9 ms at 60,000 synthetic threads
against a 16 ms budget, and 21 ms on the CI runner. It is the queue the product is built around. The
queue expression is evaluated for every thread in the table because `listThreads` puts it in the
WHERE clause. Same shape as the `queueCounts` half of L-001 and probably the same fix.

### L-014 The speed budget is not in CI
Area: build. Size: S. Bar: 1. Status: open.
Verified 2026-09-05 by reading `.github/workflows/ci.yml` on main: it runs typecheck, tests, brand,
secrets, build, smoke and audit, and not `pnpm perf`. The harness landed in c775102 without the
workflow step, so a change that makes a read slow is caught only by whoever remembers to run it.
Done when: CI runs `pnpm perf` on every pull request. It takes about 90 seconds, most of it seeding.

### L-004 Cold start is a claim, not a number
Area: speed. Size: S. Bar: 1. Status: open.
Verified 2026-09-05 by reading: nothing in the tree times startup. `docs/ROADMAP.md` asserts a 2 s
budget and no check exists, and `loop/BAR.md` marks it as the one budget with nothing behind it.
Why it matters: first paint is the impression the app makes.
Done when: the smoke walk prints milliseconds from launch to the first inbox row, the gate fails
above a ceiling recorded the way the speed probes record theirs, and the number goes in the journal.

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
Area: speed. Bar: 1. Closed 2026-09-05 on main as part of c775102, as migration 19.
Found by the speed budget on its first run against a fixture shaped like a mailbox rather than one
where every thread sits in the inbox and nothing is asleep. `snoozes` carried an index on
`(status, wake_at)` and none on the thread, so `PENDING_SNOOZE`, which every list and every count
evaluates once per thread row, seeked on status and then walked every pending snooze. The cost is
the product of the two numbers.
Before and after, on 60,000 synthetic threads with 300 asleep: `sidebar:counts` 5,389 ms to 327 ms,
`list:needsyou` 19.45 ms to 3.34 ms, `needsYouCount` 114 ms to 9.30 ms. Those are stress-test
numbers. On a real 5,370 thread mailbox with no snoozes the same counts run at 20 ms, inside budget,
before and after: nothing was on fire, and the index is worth having because the shape was quadratic
in threads by snoozes.
The regression test is `packages/store/src/plans.test.ts`, which asserts the query plan rather than
the clock, so it gives the same answer on a loaded CI runner as on a laptop. Without the migration it
fails, because SQLite falls back to `snoozes_due`.

## Dropped

Nothing yet. An item is dropped with a reason, never deleted.

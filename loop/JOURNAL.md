# Journal

One entry per iteration of the improvement loop, newest last. The entry is the evidence: a claim
that something got better without a before and an after is a claim, not a result.

Format:

```
## YYYY-MM-DD  L-000  Short title
Before: the measurement or the failure, as it was.
Change: what changed, in one or two sentences, and the files.
After: the same measurement, taken again.
Gate: passed, and which steps did not run here.
Noticed: anything found on the way, and the backlog item it became.
Commit: sha
```

---

## 2026-09-04  Setting up the loop
Before: no way to say whether a change made the app better or worse. `docs/AUDIT.md` was the
closest thing to a backlog and was two days old and already wrong in three places: the
`threads_all_sort` index it asks for exists as migration 14, the compose quote it says is
unsanitised is sanitised through `QUOTE_FORBID_TAGS`, and the log file and crash handlers it asks
for are in `electron/log.ts` and `main.ts`.
Change: added `loop/BAR.md` (what the product has to feel like, one clause at a time, each marked
checked or judged), `loop/BACKLOG.md` (a ranked queue where every item carries the check that
proves it is still real), this journal, `scripts/gate.mjs` (`pnpm gate`: one table saying whether
the tree is shippable, honest about what did not run on this platform), and
`packages/store/scripts/perf.ts` (`pnpm perf`: a synthetic 60,000 thread mailbox and the reads that
run while someone is holding a key down).
After: the speed harness found one thing immediately. `sidebar:counts`, the query that refreshes
every count on the sidebar after archive, snooze, star, re-file and eight other actions, takes a
median of 524 ms at 60,000 threads on the Electron main thread. The audit had measured 140 ms.
Every other probe is inside its budget: the inbox list 0.96 ms, the Needs you row 2.74 ms, a page
twenty screens down 1.01 ms, search 33.58 ms.
Gate: `typecheck`, `tests`, `brand`, `secrets`, `speed` and `audit` run on Linux. `build` and
`smoke` need macOS and were reported as skipped, not passed.
Noticed: the sanitiser suites assert that a configuration array contains certain strings and never
invoke DOMPurify, so deleting the sanitiser call would leave them green. Filed as L-002.
Commit: see the commit that adds this file.

## 2026-09-04  L-012  Nothing indexed the question every list and every count asks
Before: the first CI run of the speed budget failed on a GitHub macOS runner: `sidebar:counts` at a
median of 678 ms and a p95 of 966 ms, over an accepted ceiling of 600 ms set from one measurement on
one machine. Two problems, not one. The ceiling was calibrated too tightly for hardware that varies
by more than the thing being measured. And the fixture was wrong: it put all 60,000 threads in the
inbox and gave the mailbox no sleeping threads at all, which is not a mailbox anyone has.
Change: the fixture now looks like a real mailbox of that size. About 4 threads in 100 still in the
inbox, 1 in 89 spam, 1 in 97 trashed, 1 in 200 holding a draft, 1 in 50 starred, 1 in 7 carrying a
file, a third unread, and 300 asleep. Re-measured on that, `sidebar:counts` was 5,389 ms, ten times
worse than the number that had failed CI, and `list:needsyou` went from 2.74 ms to 19.45 ms.
The cause is one missing index. `snoozes` carried `(status, wake_at)` and nothing on the thread, so
`PENDING_SNOOZE`, which every list and every count evaluates once per thread row, seeked on status
and then walked every pending snooze. The cost is the product of the two numbers: 60,000 threads by
300 sleeping ones. Migration 17 adds `snoozes_thread ON snoozes(account_id, thread_id, status)`.
After, on the same realistic fixture: `sidebar:counts` 326.79 ms, `list:needsyou` 3.34 ms,
`needsYouCount` 114 ms to 9.30 ms, `list:inbox` 1.11 ms. The counts are seventeen times faster and
still eleven times over the bar, so L-001 stays open with its measurement updated and the shape of
the fix written down.
The accepted ceilings are now set at roughly twice the median measured here, with the reason written
at the top of the harness, and the half of the check that does not depend on the clock is new:
`packages/store/src/plans.test.ts` asserts the query plans, so it gives the same answer on a loaded
runner as on a laptop. Without migration 17 it fails, because SQLite falls back to `snoozes_due`.
Gate: `typecheck`, `tests` (86 in the store package, 0 failures), `brand`, `secrets` and `speed` ran
here. `build` and `smoke` need macOS and did not run; CI runs them.
Noticed: `list:daily` is 13.45 ms against a 16 ms budget, because the queue expression is evaluated
for every thread in the table. Same shape as the queue half of L-001. Filed as L-011, not fixed
here.
Commit: see the commit that adds migration 17.

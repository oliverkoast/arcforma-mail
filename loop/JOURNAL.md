# Journal

One entry per iteration of the improvement loop, newest last. The entry is the evidence: a claim
that something got better without a before and an after is a claim, not a result.

Format:

```
## YYYY-MM-DD  L-000  Short title
Before: the measurement or the failure, as it was, and the machine and mailbox it came from.
Change: what changed, in one or two sentences, and the files.
After: the same measurement, taken again the same way.
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
After: the speed harness found one thing immediately, described in the next entry.
Gate: `typecheck`, `tests`, `brand`, `secrets`, `speed` and `audit` run on Linux. `build` and
`smoke` need macOS and were reported as skipped, not passed.
Noticed: the sanitiser suites assert that a configuration array contains certain strings and never
invoke DOMPurify, so deleting the sanitiser call would leave them green. Filed as L-002.

## 2026-09-04  L-012  Nothing indexed the question every list and every count asks
Before: the first CI run of the speed budget failed on a GitHub macOS runner, `sidebar:counts` at a
median of 678 ms against an accepted ceiling of 600 ms set from one measurement on one machine. Two
problems. The ceiling was calibrated too tightly for hardware that varies by more than the thing
being measured. And the fixture was wrong: all 60,000 threads in the inbox, nothing asleep.
Change: the fixture now has about 4 threads in 100 in the inbox, 1 in 89 spam, 1 in 97 trashed, 1 in
200 holding a draft, 1 in 50 starred, 1 in 7 carrying a file, a third unread, and 300 asleep. On
that, `sidebar:counts` measured 5,389 ms. The cause is one missing index: `snoozes` carried
`(status, wake_at)` and nothing on the thread, so `PENDING_SNOOZE` seeked on status and then walked
every pending snooze, once per thread row. Cost is threads times snoozes.
After, same fixture, same machine: `sidebar:counts` 326.79 ms, `list:needsyou` 3.34 ms,
`needsYouCount` 9.30 ms.
Gate: typecheck, tests (86 in the store package), brand, secrets, speed. Build and smoke need macOS.
Noticed: `list:daily` evaluates the queue expression for every thread in the table. Filed as L-011.

## 2026-09-05  What the author corrected, and what the loop learned from it
Not an iteration. Oliver took the gate, the speed harness, `plans.test.ts` and the snooze index onto
main himself as c775102, did not merge the branch, and named two things wrong with it. Both were
right, and both are now rules rather than notes.

**The migration number was a real defect.** The branch numbered the index 17. Main had already spent
17 on a calendar column and 18 on draft attachments. Git merges two steps carrying the same version
with no conflict at all, so nothing would have reported it: the result is two version 17 steps, a
wrong `SCHEMA_VERSION`, and, worse, a store that had already run main's 17 skipping the index
permanently. It landed on main as 19. The gate did not catch this and could not have: the branch was
cut before those migrations existed, and no check reads the base branch. `.claude/skills/improve`
now says to take the next number from the base branch, never from your own.

**The 5.4 second figure did not describe a mailbox.** It described 60,000 synthetic threads with 300
asleep. On the machine the app actually runs on, 5,370 threads and no snoozes, the same counts run
at a median of 20 ms, inside the 32 ms budget. The harness reports 160 ms at 60,000 there, so the
gap is real and is tracked as L-001, but reporting the stress-test number as what the app does today
overstated it. Both numbers now go in the item, and the skill says a synthetic number is a ceiling
and a tripwire, never a description.

Left on this branch, which is what it now contains: `loop/BAR.md`, `loop/BACKLOG.md`, this journal,
and `.claude/skills/improve/SKILL.md`, rebuilt on main with the numbers corrected.
Noticed: main took the harness without the CI step, so `pnpm perf` runs nowhere automatically.
Filed as L-014.

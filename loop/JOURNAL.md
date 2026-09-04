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

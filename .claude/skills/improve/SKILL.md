---
name: improve
description: Run one iteration of the improvement loop against loop/BACKLOG.md - verify the top item is still real, change one thing, prove it with pnpm gate, record the measurement, commit. Use when asked to improve the app, work the backlog, run the loop, or make the product better, and when the user invokes /improve. Run it repeatedly (for example /loop /improve) to keep improving the app across sessions.
---

# One iteration of the improvement loop

The point of this loop is not ideas. `docs/AUDIT.md`, `docs/STANDARDS.md`, `docs/ROADMAP.md` and
`loop/BACKLOG.md` already hold more work than anyone will finish. The point is that each iteration
leaves the app measurably better and provably not worse, and that the evidence survives the session
it was gathered in.

One item. One commit. Never two.

## Before you start

Read `loop/BAR.md`. Everything below serves it. Then read the top of `loop/BACKLOG.md`.

## The steps

**1. Orient.** `git status`, `git log --oneline -5`, and check you are on the `Loop` branch. Read the
last two entries of `loop/JOURNAL.md` so you do not repeat a pass that was just run.

**2. Pick.** The top `open` item in the queue whose blockers are clear, or the next standing pass if
the queue's top item is blocked. Do not pick by what looks fun.

**3. Re-verify it.** Run the check the item's Verified line names, or read the file it names. Docs
go stale fast: when this loop was built, three of the audit's top ten were already fixed. If the
problem is gone, move the item to Done with a line saying it was fixed elsewhere and what proved it,
then take the next item. That is a complete, useful iteration. Say so and stop, or continue if there
is time.

**4. Baseline.** Capture the number or the failure the item is about, before touching anything:
`pnpm perf`, the failing test, the screenshot from the smoke walk. Paste it into the journal entry
as you go. An iteration with no before is an iteration with no after.

**5. Change it.** Smallest change that satisfies the item's Done-when. Match the surrounding code:
comments explain why and not what, no emoji, no em dashes, no new hex, buttons say what happens. If
the change is growing past roughly 300 lines, stop, split the item in the backlog, and do the first
half.

**6. Prove it.** `pnpm gate` must pass. During the work, `pnpm gate --fast` or
`pnpm gate --only=tests,speed` is fine; the full gate runs before the commit. Then re-run the
baseline measurement and record the after. The gate reports which steps did not run on this
platform: `build` and `smoke` need macOS. Write down which ones did not run, in the journal entry.
Never make a check pass by weakening it. Budgets and accepted ceilings ratchet down only.

**7. Record.** In `loop/BACKLOG.md`: move the item to Done with the commit, the before, the after.
In `loop/JOURNAL.md`: append an entry using the format at the top of that file. Anything you noticed
on the way in goes into the queue as a new item, with a Verified line. It does not get fixed now.

**8. Commit and push.** One commit, subject in the repository's voice: what is true now, not what
you did. Push to `Loop` with `git push -u origin Loop`. Open a draft pull request if there is no
open one for the branch.

**9. Stop.** Say what changed, the before and after numbers, and what the next item is. Do not start
it.

## Rules that do not bend

- Never skip, disable or delete a test to get green.
- Never raise a budget or an accepted ceiling to pass the speed check. Lowering one is the work;
  raising one needs a line in the journal saying why, and a person agreeing.
- Never add a feature that is not in `loop/BACKLOG.md` or `docs/ROADMAP.md`. A better idea goes in
  the queue and waits its turn like everything else.
- Never touch `qa/FINDINGS.md` decisions. Those belong to a person.
- Claude is never called from the sync path. Background classification is the local model only.
- If a change would need a decision that is a product decision, stop and ask. Do not guess at the
  product.

## What good looks like

A finished iteration reads like this in the journal: the item, the number before, what changed, the
number after, what the gate said, what did not run, and the one thing you noticed and wrote down
instead of fixing.

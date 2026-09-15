# The bar

What "as good as Superhuman, and sleeker" means for this app, written so a change can be measured
against it rather than argued about. `docs/STANDARDS.md` says what the outside world expects of an
Electron app. This file says what the product has to feel like. When the two disagree, both are
right about different things: that file is about safety, this one is about the person using it.

Every claim below is either **checked** by something in `pnpm gate`, or **judged** by a person or a
model looking at the app. Judged is not a lesser category, but it is an honest one: nothing here
pretends a screenshot review is a test.

---

## 1. Speed

Superhuman's whole reputation is one number: 100 ms. Nothing in this app should be slower, and the
reads that run on the Electron main thread should fit inside a frame, because a synchronous SQLite
call there does not just take time, it blocks the paint.

- Every read that runs while someone is holding a key down finishes in under 16 ms at 60,000
  threads. **Checked**: `packages/store/scripts/perf.ts`, run by `pnpm perf` and the `speed` step of
  the gate.
- Search returns in under 100 ms at 60,000 threads. **Checked**: same harness.
- Cold start to a usable inbox is under 2 s. **Not checked yet.** This needs a probe in the smoke
  walk that timestamps first paint; until it exists the claim is unverified and belongs in the
  backlog, not in the README.
- No action waits on the network to show its result. Every write is applied locally and queued.
  **Judged**, per surface.

The budgets in the harness are what the app currently meets with headroom, so the gate stays honest
and a regression is loud. The aspiration is one frame for everything, and a probe whose budget is
above 16 ms is a backlog item, not a settled decision.

## 2. Keyboard

The mouse is a fallback. A person who has learned this app should never need it.

- Every action a person can take has a key, or is in the command palette, or both. **Checked**:
  `apps/desktop/src/lib/commands.ts` builds the palette from `keys/keymap.ts`, and
  `commands.test.ts` asserts the registry for a given state. A new action that reaches neither table
  is the defect.
- The key is shown where the action is: in the tooltip of the button, on the palette row, in the
  toast that offers an undo. **Judged**.
- Keys never do something different depending on where the pointer happens to rest. **Checked**:
  `keys/hoverScope.test.ts`, `keys/scope.test.ts`.
- Nothing that types swallows a Cmd chord, and nothing that reads swallows a letter.
  **Checked**: `keys/dispatcher.test.ts`, `TYPING_SCOPES`.

## 3. Every state has a form

The gap between a demo and a product is what the screen says when things are not fine.

- Loading, empty, error, offline, signed out, too long, and gone each have a written form. No blank
  panes, no spinner without a sentence, no silent failure. **Judged**, one surface per pass.
- An error says what to do next, not what went wrong internally. **Judged**.
- A background failure that the person needs to know about reaches an eyebrow or a toast, and one
  that does not is in the log file instead. **Judged**, with `electron/log.ts` as the sink.

## 4. Everything is reversible, or says it is not

- Every write a person can trigger either leaves an undo that runs the reverse through the same
  channel, or says plainly that it cannot be taken back. **Judged**, per action, with the existing
  undo of E, snooze, star, re-file and unsubscribe as the reference.
- Nothing is deleted as a side effect of something else.
- Send has a window. Drafts survive a quit, a crash, and being edited in two places.

## 5. Words

These are already product rules in the README. They are here because they are part of the feel.

- No emoji. No em dashes. Buttons say what happens.
- Applies to UI strings, prompts, logs, comments, commit messages, and this file.
- **Checked** in part: `scripts/brand-check.mjs`.

## 6. One surface

- Colour, type, spacing and rules come from the brand tokens only. No new hex, no shadow, no dark
  mode. **Checked**: `scripts/brand-check.mjs`.
- The same idea looks the same everywhere: a count is a count, an eyebrow is an eyebrow, a
  destructive action reads the same way in the list and in the thread. **Judged**.
- Nothing moves that the person did not move. Animation earns its place or is removed.

## 7. Trust

The reason to use this instead of Superhuman.

- Nothing leaves the machine unless the person asked for it in that moment. Classification is local.
  Claude is called on demand and never from the sync path. **Checked** in part by review, and by the
  rule in the README.
- No telemetry by default, none added quietly.
- Mail HTML never renders in a privileged document. **Checked**, and the checking is currently weaker
  than it looks: see the backlog.

---

## How this file is used

`.claude/skills/improve/SKILL.md` runs one item at a time out of `loop/BACKLOG.md`. Every item cites
the clause here that it serves. An item that serves no clause is either a bug, which does not need a
clause, or it is scope creep, which does not need doing.

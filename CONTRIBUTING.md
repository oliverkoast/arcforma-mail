# Contributing

## Running it

```bash
source ~/.nvm/nvm.sh && nvm use 24
pnpm install
pnpm sync-brand
pnpm -r test
pnpm --filter desktop dev
```

`docs/google-cloud-setup.md` covers the Google OAuth clients you need before the app can sign in. `scripts/verify.sh` runs the whole matrix: tests, typecheck, the brand check, the voice sweep, the Swift self-tests, and the daemon health.

## What a change has to pass

`pnpm gate` runs the lot in one go and prints one table: typecheck, tests, the brand check, the secret scan, the speed budget, the desktop build, the smoke walk with zero console errors, and `pnpm audit`. It is honest about what did not run: `build` and `smoke` need macOS and are reported as skipped rather than passed anywhere else. A bug found in use becomes a regression test in the same change.

`pnpm perf` on its own seeds a synthetic 60,000 thread mailbox and times the reads that run while someone is holding a key down. Budgets and accepted ceilings live in `packages/store/scripts/perf.ts` and ratchet down only: making a check pass by raising one is not a fix.

## Improving it on purpose

`loop/BAR.md` says what the product has to feel like, one clause at a time, each marked checked or judged. `loop/BACKLOG.md` is the ranked queue, where every item carries the check that proves it is still real. `loop/JOURNAL.md` is the record, one entry per iteration, each with a before and an after. `.claude/skills/improve/SKILL.md` is the procedure: verify the top item is still real, change one thing, prove it with the gate, record the measurement, commit.

## House rules that are product, not preference

1. Read receipts are off by default and chosen per message. A pixel reports that software asked for an image, never that a person read anything, so the app grades every fetch and says "no signal" rather than "unread". Never let a caller collapse those two, and never store anything about the recipient beyond what `packages/pixel-service` already keeps.
2. Drafts, never automatic sends. The app may write for you; it does not speak for you.
3. Claude is never called from the sync path. Background work uses the local model only.
4. Message HTML renders sandboxed, with remote images off unless the setting allows them.
5. Replacing selected text fails closed: the selection is re-read and compared before anything is pasted.
6. The writing rules apply to code as well as copy: no emojis, no em dashes, buttons say what happens.
7. Colour, type, and spacing come from the design tokens. A conflict is logged in `qa/FINDINGS.md`, not resolved quietly in a component.

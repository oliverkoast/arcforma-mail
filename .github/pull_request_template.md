## What and why

<!-- One paragraph. What changes, and what problem it solves. Link the issue or discussion it came from. -->

## How it was tested

<!-- Which of these you ran, and anything you exercised by hand. -->

- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r test`
- [ ] `node scripts/brand-check.mjs` and `node scripts/secret-scan.mjs`
- [ ] `pnpm --filter desktop smoke` with zero console errors

## Checks

- [ ] A bug fix carries a regression test that fails without the fix.
- [ ] No emojis and no em dashes, in code, comments, copy, or this description.
- [ ] Colour, type, and spacing come from the design tokens.
- [ ] Commits are signed off (`git commit -s`), certifying the DCO at https://developercertificate.org.
- [ ] If a model helped write this, you have read it, you understand it, and you can defend every line.

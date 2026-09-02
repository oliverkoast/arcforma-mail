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

Every change runs `pnpm -r typecheck`, `pnpm -r test`, `node scripts/brand-check.mjs`, and `pnpm --filter desktop smoke` with zero console errors. A bug found in use becomes a regression test in the same change.

## House rules that are product, not preference

1. No tracking pixels, ever, not even behind a flag.
2. Drafts, never automatic sends. The app may write for you; it does not speak for you.
3. Claude is never called from the sync path. Background work uses the local model only.
4. Message HTML renders sandboxed, with remote images off unless the setting allows them.
5. Replacing selected text fails closed: the selection is re-read and compared before anything is pasted.
6. The writing rules apply to code as well as copy: no emojis, no em dashes, buttons say what happens.
7. Colour, type, and spacing come from the design tokens. A conflict is logged in `qa/FINDINGS.md`, not resolved quietly in a component.

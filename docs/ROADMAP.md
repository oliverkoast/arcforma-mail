# Roadmap: from Oliver's mail client to a product

Goal, set 2026-09-02: Arcforma Mail becomes a real tool other people install, first as open source, possibly sold later. Every change is judged against that.

## Phase 1: harden what exists (weeks 1 to 3)

Security
- Threat model written down: local attacker, malicious email, malicious calendar invite, compromised daemon token, stolen laptop.
- Tokens: keep safeStorage; add a "lock" that wipes decrypted state on sleep after N minutes; sign-out wipes the SQLite rows for that account, not just the token.
- Mail rendering: fuzz the sanitizer with a corpus of hostile HTML (CSS injection, SVG, MathML, form hijack, unicode tricks); keep the sandboxed frame with no scripts and no forms; add a per-message "Show original" that is text only.
- Daemon: bind to a unix socket instead of a TCP port, token in the keychain, rate limit per caller, refuse requests over a size cap, log without message content.
- Arcforma Text: Accessibility use limited to reading the focused element; no event taps; clipboard restore proven by the e2e harness on every release.
- Dependency audit in CI (`pnpm audit`, pinned Electron, monthly bump), CSP and navigation guards covered by tests, no `remote` module, fuses set (run-as-node off, cookie encryption on).
- Crash reporting that is opt-in and strips addresses and subjects.

Reliability
- Sync engine: a soak test against a synthetic Gmail that replays a week of history, including token expiry, 429 storms, and label churn; verify that the local state converges to Gmail's every time.
- Send path: exactly-once proven under crash injection; attachments supported (upload, size cap, virus-scan hook).
- Migration tests for every schema version from v1 forward, plus a backup of the database before each migration.
- Performance budget: 100k threads, list scroll at 60 fps, search under 100 ms, cold start under 2 s; measured in CI on fixture data.
- Offline mode: everything read-only works with the network off, every action queues and drains.

## Phase 2: make it installable by strangers (weeks 3 to 6)

Costs now measured rather than guessed. Every Gmail scope this app needs is restricted, including metadata; only `gmail.send` is merely sensitive. A shared verified client therefore means a CASA security assessment through a paid lab, roughly 540 to 1,800 dollars a year at the lower assurance level, renewed annually whether or not anything changed, and Google's own estimate for restricted-scope review is about six weeks. Self-scanning was deprecated. See `docs/adr/0004` for why each person brings their own client instead, and `docs/adr/0005` for what the policy requires before mail text reaches a model.

- OAuth: each person brings their own client, published unverified. See `docs/adr/0004`. The earlier plan here was to verify one shared client so nobody else had to; a survey of every open-source mail client that tried says the cost is not the paperwork but the outages. KDE's client was blocked by Google for fourteen months, K-9's for three and a half. A shared client is also a single point Google can switch off for every user at once. Revisit only with that evidence in view.
- Onboarding must state that a project left in Testing signs you out every seven days, and that publishing to production without verification removes it. This is the single most confusing thing about Google's OAuth for a new user, because the symptom arrives a week after the cause.
- Onboarding that needs no terminal: sign in, choose AI mode, done. AI modes: local only (bundled llama.cpp and a 4B model download), bring your own Anthropic key, or Claude Code login for people who have it. The daemon becomes part of the app, not a separate LaunchAgent.
- Apple Developer ID signing and notarization; auto-update; a Homebrew cask.
- Multiple providers: IMAP and Microsoft 365 behind the same store interface (the plan already separates the Gmail package).
- Settings export and import; a "reset everything" that provably deletes.
- Accessibility pass (VoiceOver on the list and compose), keyboard-only audit, localized dates and times.

## Phase 3: open source (weeks 6 to 8)

- License choice: AGPL keeps a hosted clone from free-riding and still allows a commercial license later; MIT maximizes adoption. Recommendation: AGPL for the mail app, MIT for the AI daemon and text tool.
- Repo hygiene: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md with a disclosure address, issue templates, architecture doc (the plan file, rewritten for readers who were not here), ADRs for the big decisions (node:sqlite, local-first sync, no tracking pixels, Claude Code login).
- The brand: the product needs a name and a mark that are not Arcforma's (the brand findings F-02 and F-MAIL-02 block shipping the wordmark in a public app). Keep the design system, rename the product, ship a neutral theme by default and the Arcforma theme as Oliver's.
- CI on GitHub: tests, typecheck, brand check, smoke screenshots as artifacts, signed builds on tags.
- Telemetry: none by default. If added, opt-in, counts only, documented.

## Phase 4: the paid version (month 3 onward)

What people would pay for, in the order they would pay:
1. Hosted AI without keys: summaries, drafts in your voice, Ask AI, classification, metered per seat. The local-first design means only the text you ask about leaves the machine, which is the sales pitch.
2. Team features: shared snippets, shared categories, delegated inboxes, read-only sharing of a thread by link.
3. Sync across devices for the app's own state (queues, snoozes, categories) through a small encrypted store; Gmail stays the mail store.
4. Mobile companion for Daily 0 only.

Pricing sketch: free open-source app; Pro at 15 to 20 dollars a month for hosted AI and sync; Team at 25 per seat. Superhuman charges 30; the local-first story and open code justify undercutting.

## What not to do

- No tracking pixels, ever, even as an option. It is the one thing that would sink the trust story.
- No general "AI writes and sends for you" automation. Drafts, never sends.
- No third inbox: Daily 0 stays a commitment, not a classifier output.

## Immediate next steps

1. Threat model and the sanitizer fuzz corpus (this week).
2. Start the Google verification paperwork (long lead time).
3. Product name and mark, so the brand blockers stop gating the public build.
4. Bundle the daemon and the local model into the app.

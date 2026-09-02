# Arcforma Mail

Oliver's own mail client and text tools. Three parts, one AI backend, Arcforma brand throughout.

| Part | What | Where |
|---|---|---|
| Arcforma Mail | Electron desktop mail client for three Gmail accounts: split inbox, keyboard flow, snooze, send later, snippets, AI sorting, Ask AI, calendar and contact rail | `apps/desktop`, `packages/gmail`, `packages/store` |
| Arcforma Text | Swift menu-bar app: Cmd+J fixes the selected text anywhere, Cmd+Shift+J edits it from an instruction, a floating toolbar on selection adds Bold, Italic, Bullets, Numbered | `packages/text-tools` |
| AI daemon | Loopback HTTP service both apps call. Claude through the Claude Code login (`claude -p`, no API key) for on-demand work, a local llama.cpp model for background classification | `packages/ai-daemon`, `packages/ai-core` |

Plan of record: `~/.claude/plans/create-me-a-custom-cosmic-owl.md`. Brand source: `~/Projects/arcforma-brand` (copied in by `pnpm sync-brand`, never edited here). Findings this app raises against the brand system live in `qa/FINDINGS.md`.

## Run it

```bash
source ~/.nvm/nvm.sh && nvm use 24
pnpm install
pnpm sync-brand
pnpm -r test                       # store (schema, FTS across VACUUM), gmail (sync, drafts, OAuth loopback with a fake Google), ai-core, ai-daemon, desktop (rules, golden set, compose, send queue, draft mirror, calendar sync, navigation guard)
pnpm typecheck && pnpm brand-check
pnpm --filter desktop smoke [outDir]   # seeds scripts/fixtures/threads.json into a throwaway store, walks inbox, thread, snooze, compose, Ask; fails on any console error
node apps/desktop/scripts/classify-report.mjs [mail.db]   # what the header rules would do to a real mailbox: counts per type, top senders, how many threads move. Read-only, prints no message bodies
pnpm --filter desktop dev          # mail app, dev mode
packages/ai-daemon/install.sh      # AI daemon as a LaunchAgent
packages/text-tools/build.sh       # Arcforma Text .app bundle
```

## Before first use

1. `claude auth login` in a terminal. Check from a fresh terminal that `claude auth status` says `"loggedIn": true`.
2. Google Cloud OAuth clients: follow `docs/google-cloud-setup.md`, then sign in to each account from the app's onboarding screen.
3. Grant Accessibility to Arcforma Text when it asks.

## What the mail app does today

C opens the floating compose panel. R, A, and F reply in the thread: the editor docks under the message it answers (the last one, or the one whose hover icons you used), with the recipients on one line, the quoted history folded away, and the cursor in the body; Esc collapses a written reply to a one-line strip that R or a click reopens, moving to another thread parks it under Drafts and its strip is back with the thread, and Send puts the message straight into the thread until the sync confirms it. Thread actions are icon buttons with the key in the tooltip. Compose runs in a TipTap editor with `;trigger` snippets (Space or Tab expands, Cmd+; picks), Cmd+Enter sends through the undo window (Settings, default 10 s; Z undoes and reopens the draft), Shift+Cmd+L sends later (T tomorrow 9:00, W next Monday 9:00, D pick). Esc keeps a draft. Drafts live in one list with Gmail's: every draft written here is mirrored to Gmail through `users.drafts` (two seconds after the last keystroke, at once on Esc or park, through the outbox so it is serial, retried, and fine offline), drafts written in Gmail are imported on the next sync and edit here like any other, deleting on either side deletes on both, and an edit made in both places within a minute keeps the local text; the Drafts row reads IN GMAIL, SAVING, or NOT IN GMAIL with the reason. Sending goes through `messages.send` from the send queue (undo window and send later unchanged), and the Gmail draft is deleted once the send has succeeded. The account's Gmail signature is appended at send time. Snooze and remind-if-no-reply resurface with a notification and a NO REPLY BY eyebrow. Classification runs in the background: header rules first (`electron/classify/rules.ts`), then the local model through the AI daemon with the eight nearest corrections as few-shot; re-filing a thread teaches it and mirrors the label to Gmail. Mail sorts into six types: Newsletters (editorial or recurring publication content someone subscribed to), Promotions (marketing, offers, product upsell, events, sales), Jobs (applicants, applications, candidate alerts, recruiter outreach, hiring platform mail), Calendar, Notifications (transactional or platform alerts reporting something that happened), and Receipts. People beat headers: a message a person wrote to Oliver never takes a bulk type, whatever list headers the transport stamped on it, because a hiring inbox run as a Google Group puts List-Id on every applicant. Where the deterministic signals disagree, a platform address sending a marketing subject for instance, the rules return nothing and the local model decides. A change to the rules bumps `RULES_VERSION` in `electron/classify/pipeline.ts`, which drops every rule-sourced verdict at the next start and re-decides them in batches; model verdicts and re-files are left alone. Custom categories live in Settings. Daily 0 holds every important thread with new mail since the last time Oliver was on mail the night before, plus anything added with D and every snooze or reminder that woke today; E clears it and advances. Weekly 0 takes W and whatever was left when the day rolled over; a day starts on the first activity after a five hour gap across a date or after 4:00, a week on the first activity after Monday 4:00, and Weekly 0 threads older than a week drop to Later. Thread summaries, instant replies (1, 2, 3), auto-draft (Tab accepts), and Ask AI (Cmd+Shift+A) go through Claude and degrade to a SIGN IN TO CLAUDE CODE eyebrow when Claude is signed out. The open thread re-reads itself after every sync, so a reply that arrives while reading shows without reopening, and a thread that leaves the store closes with a THREAD GONE toast; a message whose body could not be fetched shows its snippet with a MESSAGES NOT LOADED eyebrow and a Fetch again button, never a blank. Send refuses, with a toast and the draft untouched, when there is no recipient or nothing written (a forward may go with only its quoted history). A thread that holds nothing but a draft is not a thread here: the draft lives under Drafts and the phantom row is removed (schema 10). A draft edited in Gmail while its editor is open here replaces the text once the local edit is older than a minute, with an UPDATED FROM GMAIL toast. Drafts left SAVING by a quit are queued again on the next start. One thread carries one reply draft: replying to another message of a thread with a parked draft moves that draft there. The history poll never stalls on one thread whose threads.get fails; it is retried on the next five polls and the watermark moves on.

## Rules that are product, not preference

- No emojis, no em dashes, buttons say what happens. Applies to UI strings, prompts, logs, and comments.
- Brand tokens come from the copied `styles.css` only. No new hex values, no shadows, no dark mode. Conflicts go to `qa/FINDINGS.md`, not into the code.
- Claude is never called from the sync path. Background classification uses the local model only.
- Message HTML renders in a sandboxed iframe with remote images off by default. No frame may leave the app:// origin; http(s) links go to the default browser, everything else is dropped (`electron/navigation.ts`).
- Calendar events come from a 30-days-back, 14-days-ahead window per account. Google pins that window to the sync token, so the token lives 24 hours and then a full window is fetched again; stale rows are dropped only inside the window.
- Replacing selected text fails closed: the selection is re-read and compared before anything is pasted.
- Never launch the apps as children of a shell. Use `open -a`, `launchctl`, or the install scripts.

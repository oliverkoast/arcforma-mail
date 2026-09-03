# First-run setup

What a stranger sees the first time they open Arcforma Mail, and where each piece of it lives. Written for contributors: `docs/google-cloud-setup.md` is the version for the person doing the setup.

## The problem it solves

Before this, a new person had to create Google Cloud projects, hand-write `oauth-clients.json` in Application Support, run `packages/ai-daemon/install.sh`, run `claude setup-token` and `set-token.sh`, put a GGUF somewhere and edit `ai-daemon.json` to point at it, and run `packages/text-tools/install.sh`. Nothing in the app helped. The rule for this flow is that no step ever asks anyone to edit a file by hand. Hand-editing still works and is still documented, as the fallback.

## The six steps

| Step | Id | What it does |
|---|---|---|
| 1 | `welcome` | What the app is in three sentences, then four rows saying plainly what stays on the machine (mail, tokens, background sorting) and what does not (the thread you ask Claude about, requests to Google). One Get started pill. |
| 2 | `accounts` | Address, Workspace or personal, an optional project id, four buttons that open the Google Cloud console pages in order, then the client id and secret by paste. Save writes `oauth-clients.json` and runs the loopback sign-in at once. Repeatable for more accounts. |
| 3 | `ai` | Local only, Claude Code login, or an Anthropic API key, each with its trade-off written out. The daemon is asked what is already on the Mac first, so an existing login is reported rather than asked for again. |
| 4 | `model` | Whether the llama.cpp binary and a GGUF are present, and a resumable download with a real progress bar for the model. |
| 5 | `text` | What Cmd+J does, an Install button that runs the real script with its output streamed into the step, and a live read of the Accessibility grant. |
| 6 | `done` | J, K, E, C, Cmd+K, a paragraph on Daily 0, and Start reading. |

Every step is skippable. Skipping never leaves the app in a state that pretends to work: skipping accounts lands on a screen saying no mailbox is connected, skipping the AI step lands on local only, and skipping the model says background sorting stays off.

## Resuming

Progress is two rows in the settings table, `onboardingStep` and `onboardingDone` (`packages/store/src/queries/settings.ts`). Every move writes the step through `onboarding:setStep`, so a quit halfway comes back to the same screen. `resumeStepId` in `apps/desktop/shared/onboarding.ts` decides where a launch lands: the stored step when setup is unfinished, `done` when it is finished, `welcome` when the stored value is missing or is a step id that no longer exists.

While the flow is open it owns the whole window (`.setup`, fixed, above the shell grid) and the key scope is `setup`, which `resolveBinding` refuses outright, so no shortcut behind it can fire. Settings also stops opening itself when the last account connects.

Settings has a **Run setup again** button. It clears `onboardingDone`, resets the step, and reopens the flow. Nothing already set up is undone by walking it again: the clients file, the daemon config, and the model are all left as they are.

## Where the code is

| Path | Role |
|---|---|
| `apps/desktop/shared/onboarding.ts` | Step order, field validators, the Google Cloud console URLs, the daemon-health-to-AI-choice reading, the download state shape. Pure, and shared by the renderer, the main process, and the tests. |
| `apps/desktop/src/components/Onboarding.tsx` | The shell: the progress rail and the step router. Also `NoAccounts`, the screen for a finished setup with nothing connected. |
| `apps/desktop/src/components/onboarding/*.tsx` | One file per step, plus `parts.tsx` for the card, field, choice, bar, and fact row. |
| `apps/desktop/electron/ipc/onboarding.ts` | Every IPC handler. The only place that opens a browser, writes a file, spawns a process, or fetches. |
| `apps/desktop/electron/onboarding/clients.ts` | Reading and writing `oauth-clients.json` at mode 0600, through a temp file and a rename. |
| `apps/desktop/electron/onboarding/download.ts` | The model download state machine, with the fetch injected. |
| `apps/desktop/electron/onboarding/environment.ts` | The daemon config, the model catalog and paths, and the Arcforma Text install and its Accessibility grant. |

## The rules the flow keeps

**The renderer spawns nothing.** Every shell command, file write, and network fetch is behind an IPC handler with a narrow input. The console links are a four-name enum resolved to a URL in the main process, never a URL from the renderer. The account write takes five fields and validates all of them again on the main side.

**The secret goes one way.** `onboarding:addAccount` takes the client secret, writes it to the clients file at 0600, and answers with an `AccountsStatus`. There is no channel that reads a secret back, and `daemonConfigView` reports only whether a credential is stored, never its value.

**Nothing blocks without a visible state and a way out.** The sign-in button becomes "Waiting for the browser sign-in" and the step says it gives up after three minutes and leaves the credentials saved. The download has a bar, a byte count, and a Stop button. The installer streams its output. The daemon check has a "Checking" line.

**A stopped download is not a lost download.** Bytes land in `<model>.part` and the file is renamed only when the whole thing is there and the byte count matches. A cancel, a dropped connection, or a quit leaves the part file, and the next start sends `Range: bytes=<n>-`. A server that ignores the range and sends 200 restarts from zero rather than appending to stale bytes.

**The Accessibility grant is read, not guessed.** Only Arcforma Text can answer whether it has the grant, and it writes the answer to `~/Library/Logs/arcforma-text.log` at launch. Check the grant restarts the agent with `launchctl kickstart -k` and reads the newest line. No log at all reads as unknown, never as denied.

## The AI choices and what they mean

`aiAvailability` in `shared/onboarding.ts` maps daemon health to one of three pictures: no daemon answering, a daemon with Claude signed in, a daemon with Claude signed out. A stored credential wins the preselection.

Saving writes into `~/Library/Application Support/Arcforma/ai-daemon.json` at mode 0600, merging rather than replacing so the daemon's own port and bearer token survive. `claude-code` sets `claudeOAuthToken`, `api-key` sets `claudeApiKey`, and each clears the other so a machine never carries two credentials. Local only clears both, so opting out leaves no secret behind. The daemon picks up the change on its next restart, and the step says so rather than restarting the LaunchAgent behind anyone's back.

The API key option needed a matching change in `packages/ai-core/src/claude.mjs`: `apiKey` becomes `ANTHROPIC_API_KEY` in the child environment, and `authStatus()` reports a configured key as signed in without asking the CLI, because `claude auth status` answers about the subscription login only and would otherwise show "sign in to Claude Code" on a machine where every request works. The key is proved by the first completion, whose failure comes back as an ordinary `claude_error`.

## The model download

One catalog entry, in `environment.ts`: Qwen3 4B Instruct at 4-bit, 2,497,281,120 bytes, from Hugging Face into `~/Library/Application Support/Arcforma/models/qwen3-4b-instruct-q4_k_m.gguf`. That is the filename the daemon's own default already looks for, and a finished download also writes `local.model` into the daemon config.

There is no download for the llama.cpp binary. The step reports whether one is present and says what its absence means, because fetching and running an unsigned native binary is not something first-run setup should do on anyone's behalf.

## Testing it

`apps/desktop/src/lib/onboarding.test.ts` covers the validators, the step order and resume, the console URLs, the health-to-choice mapping, and the progress line. `electron/onboarding/clients.test.ts` covers the file writer: creating, appending without losing an entry, keeping 0600, refusing a duplicate id, address, or client id, and leaving a file that is not JSON alone. `electron/onboarding/download.test.ts` drives the state machine against a stubbed fetch: progress, cancel, resume with a Range header, a server that ignores the range, an HTTP error, a dead connection, a short file, and two overlapping starts. `electron/onboarding/environment.test.ts` covers the daemon config writes and the Accessibility log reading. `src/state/store.test.ts` covers the flow owning the window, recording each step, resuming, finishing, and reopening.

The flow is walked end to end by the smoke harness:

```bash
pnpm --filter desktop smoke -- <outDir> --onboarding
```

That runs Electron against an empty user-data folder, a clients file that does not exist, and an AI daemon config and text tool log that point into the temp folder, so it sees the machine a stranger would have. It photographs all six steps plus the account form answering a client id that is not one, and fails on any console error. It presses no button that would reach Google, run an installer, or start a download.

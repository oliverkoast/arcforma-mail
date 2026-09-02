# Arcforma Text

A menu-bar text tool for macOS. Select text in any app, press Cmd+J, and spelling,
grammar, and punctuation are fixed in place. Cmd+Shift+J takes a typed instruction.
A small toolbar appears on mouse selections with Fix, Edit, Bold, Italic, Bullets,
Numbered. Swift, SwiftPM, zero dependencies, macOS 14 and later.

## Chords

| Chord | What happens |
|---|---|
| Cmd+J | Fix the selection (spelling, grammar, punctuation; nothing else changes) |
| Cmd+Shift+J | Open the instruction panel; Return replaces, Escape cancels |
| Cmd+Option+J | Restore the last replacement (30 s memory), else the host's Cmd+Z |
| Escape | Cancels a model call in flight (taken system-wide only while one runs) |

Cmd+J pre-empts Chrome Downloads, Slack Jump to, the Xcode and Pages Jump to Selection,
and the VS Code panel toggle. That is a knowing decision. To change a chord:

```
defaults write ai.arcforma.text fixKeyCode -int 38        # virtual key code (38 = J on ANSI layouts)
defaults write ai.arcforma.text fixModifiers -int 256     # Carbon mask: cmd 256, shift 512, option 2048, control 4096
defaults write ai.arcforma.text instructKeyCode -int 38
defaults write ai.arcforma.text instructModifiers -int 768
defaults write ai.arcforma.text restoreKeyCode -int 38
defaults write ai.arcforma.text restoreModifiers -int 2304
launchctl kickstart -k gui/$(id -u)/ai.arcforma.text
```

Without overrides the J key is resolved through the active keyboard layout, the same
way the synthetic Cmd+V is (a hard-coded key code sends the wrong chord on Dvorak).

## Build and install

```
./build.sh                # swift build -c release, assembles build/Arcforma Text.app, signs
./install.sh              # build, copy to /Applications, bootstrap the LaunchAgent
"build/Arcforma Text.app/Contents/MacOS/ArcformaText" --selftest
"build/Arcforma Text.app/Contents/MacOS/ArcformaText" --e2e-status   # backend, claude binary, log path
```

Toolchain: Command Line Tools are enough (no Xcode.app). `swift test` does not work
under CLT because XCTest is not shipped there; the pure-logic checks (markdown wrapping,
host policy, prompt marker extraction, CLI JSON parsing, the model fallback chain
against a stub binary) run under `--selftest` instead.

The self-test writes its log lines to a temp file, not the live log; set
`ARCFORMA_TEXT_LOG=<path>` to redirect either process. It covers the fail-closed replace
path (target change, re-read mismatch, expired session, empty and oversized captures,
an identical model result never pasting), the pasteboard restore rule, the sentinel
route's predicates and restore rule, the CLI process hygiene (stdin closed, minimal
env, stderr flood, SIGTERM then SIGKILL, cancel), the daemon client against a fake
loopback daemon (bearer token, 503 not_logged_in with no CLI fallback, connection
refused with fallback, DELETE on cancel, `aiBackend=direct`), the Escape hotkey
lifecycle, and a dash, emoji, and keyDown scan of the source tree.

### End-to-end check (needs Accessibility)

`scripts/e2e-textedit.sh` drives the installed, launchd-run app against TextEdit with a
stub `claude` (`scripts/claude-stub.sh`, one fixed corrected sentence). It writes
`claudeBin` and `aiBackend=direct` into the app defaults, restarts the job, types a
misspelled sentence, presses Cmd+J with and without a selection, reads the document
back through AppleScript, and asserts the replacement and the "Select text first"
refusal. Every setting is reverted on exit and the job is restarted again. Run it once
Accessibility has been granted; the terminal needs Accessibility and Automation for
System Events. A process started from a terminal inherits the terminal's Accessibility
grant in TCC's eyes, so the harness reads the app's own "accessibility trusted" log
line rather than trusting `--e2e-status` from the shell.

`install.sh` never launches the app from the shell. launchd owns it
(`~/Library/LaunchAgents/ai.arcforma.text.plist`: RunAtLoad, KeepAlive on failure,
ProcessType Interactive). Restart it with `launchctl kickstart -k gui/$(id -u)/ai.arcforma.text`.

### Signing

`build.sh` signs with the local self-signed identity "Arcforma Dev" when it is in the
keychain, which pins the designated requirement to the certificate so the Accessibility
grant survives rebuilds. Create it once with `scripts/make-identity.sh`. Without it the
build signs ad-hoc and warns loudly: every rebuild then invalidates the grant. Override the
name with `ARCFORMA_SIGN_IDENTITY`. The certificate shows as `CSSMERR_TP_NOT_TRUSTED` in
`security find-identity`, which is expected.

## Permissions

Accessibility only. It covers reading the selection (AXSelectedText) and posting the
synthetic Cmd+V, Cmd+C, Cmd+B, Cmd+I, Cmd+Z. No event tap and no keyDown monitor, so
Input Monitoring never appears. Grant it once after the first install: System Settings
> Privacy & Security > Accessibility > Arcforma Text (the menu has a shortcut to the pane).

macOS 15.4 and later show a "Paste from Other Apps" prompt the first time an app reads
a pasteboard another app wrote. Arcforma Text writes its replacement and posts Cmd+V,
so the prompt belongs to the host app receiving the paste, and only appears in hosts
that opt in to that check. Allow it once per host.

## How a replacement works

1. Capture: frontmost pid and bundle id, then AXSelectedText of the focused element.
   Chromium-family hosts (Chrome, Arc, Slack, Notion, VS Code, Cursor) return no AX value,
   so they use a sentinel-clipboard Cmd+C round trip (20 ms poll, 1200 ms ceiling) and the
   original pasteboard is restored only if it still holds what we wrote.
2. Refuse terminals (Terminal, iTerm2, Ghostty, Alacritty, kitty, Warp), secure text
   fields, password managers, and our own process. Line-copy editors (VS Code, Cursor,
   Windsurf, JetBrains, Sublime) never get a bare caret's line rewritten.
3. Model call through the local AI daemon (`~/Library/Application Support/Arcforma/ai-daemon.json`),
   or directly through `claude -p` when the daemon cannot be reached (connection refused).
   A daemon that answers is final: 503 not_logged_in shows "Sign in to Claude Code" and
   never retries through the CLI, which would fail the same way. 20 s timeout, Escape
   cancels (a DELETE reaches the daemon). `defaults write ai.arcforma.text aiBackend direct`
   or `ARCFORMA_AI_BACKEND=direct` skips the daemon. Output must end with a completion
   marker; truncated or empty output is rejected, and a result identical to the
   selection shows "No changes" without pasting.
4. Verify: the selection is re-read and compared to the original. Any difference fails
   closed. Nothing is pasted blind.
5. Replace: every pasteboard flavor is saved, the replacement is written marked
   `org.nspasteboard.TransientType` (clipboard managers ignore it), Cmd+V is posted with
   the layout-resolved key code, and the pasteboard is restored after 350 ms if the
   changeCount is still ours.

Formatting from the toolbar: rich hosts (Notes, TextEdit, Mail, Pages, Safari, Chrome,
Slack, Notion) get native Cmd+B / Cmd+I and a `public.html` list with a plain-text
fallback; plain hosts (VS Code, Xcode, single-line fields, unknown apps) get `**bold**`,
`*italic*`, and `- ` / `1. ` line prefixes.

## Files

| Path | Role |
|---|---|
| `Sources/ArcformaText/AppDelegate.swift` | Status item, menu, hotkeys, the Fix, Instruct, Restore, and toolbar flows |
| `HotKeys.swift` | Carbon `RegisterEventHotKey` and the chord defaults |
| `InFlight.swift` | The one in-flight model call and the Escape chord's arm and release |
| `Selection/AXSelection.swift` | In-process AX reads, secure-field check, selection bounds |
| `Selection/ClipboardCapture.swift` | Sentinel Cmd+C route for dormant-AX hosts |
| `Selection/HostPolicy.swift` | Terminal, Chromium, rich, plain, and line-copy tables |
| `Selection/SelectionWatcher.swift` | Global mouse monitors and the toolbar show/hide policy |
| `Replace/Pasteboard.swift` | Save and restore all flavors, transient marker |
| `Replace/KeySynth.swift` | Layout-resolved key codes and synthetic Cmd chords |
| `Replace/Replacer.swift` | Session, verify, fail-closed paste, last-replacement memory |
| `AI/AIClient.swift` | Daemon client and the daemon-or-direct service |
| `AI/ClaudeCLI.swift` | `claude -p` fallback with the model chain |
| `AI/Prompts.swift` | Fix and Instruct system prompts, JSON envelope, marker extraction |
| `Actions/Action.swift` | Action protocol; Fix, Instruct, Bold, Italic, Bullets, Numbered, Undo |
| `UI/Brand.swift` | Tokens, bundled fonts, wordmark, the shared card panel |
| `UI/StatusChip.swift`, `UI/InstructPanel.swift`, `UI/ToolbarPanel.swift` | The three surfaces |
| `SelfTest.swift` | `--selftest` |
| `scripts/e2e-textedit.sh`, `scripts/claude-stub.sh` | The TextEdit end-to-end harness and its stub `claude` |

Log: `~/Library/Logs/arcforma-text.log` (also in Console under subsystem `ai.arcforma.text`).
Every request logs one timing line at INFO for the real-app latency matrix:

```
timing text.fix: capture 12 ms, model 1830 ms, replace 410 ms, total 2252 ms, outcome replaced, model opus, host com.apple.Notes, route ax
```

## Brand findings

- F-MAIL-03: the brand defines no shadow; the floating panels use the OS `hasShadow`
  default as the minimal deviation.
- F-MAIL-04: the toolbar is narrower than the 120 pt wordmark minimum, so it carries the
  mono "TEXT TOOLS" eyebrow instead of the wordmark, pending F-02.
- F-MAIL-05: the menu-bar glyph is the SF Symbol `textformat` as a placeholder until a
  standalone mark exists.

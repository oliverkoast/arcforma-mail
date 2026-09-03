# Standards

What a well-run open-source Electron desktop app looks like in September 2026, measured against this
repository. For each area: the current standard with a citation, what this project would have to do
to meet it, and an honest note on whether it is worth doing at one developer.

`docs/ROADMAP.md` says what we intend to do. This file says what the outside world currently expects
and where the evidence for that comes from. When the two disagree, this file is the reference and the
roadmap is the plan.

Written 2026-09-03. Anything dated is dated because it moves.

**Reading the verdicts.** Each item ends with one of:

- **Do it** — the standard applies, the cost is small, skipping it is a real gap.
- **Do it before strangers install** — not urgent today, blocking for a public release.
- **Cargo cult here** — a real practice at larger scale that buys this project nothing.

---

## 1. Electron security

### 1.1 The checklist and where this project stands

The authority is Electron's own security checklist, twenty numbered items
(<https://www.electronjs.org/docs/latest/tutorial/security>). Measured against the current tree:

| Checklist item | This project |
|---|---|
| 2. No Node integration for remote content | Met. `nodeIntegration: false`, `nodeIntegrationInWorker: false` (`apps/desktop/electron/main.ts`) |
| 3. Context isolation | Met. `contextIsolation: true` |
| 4. Process sandboxing | Met. `sandbox: true` |
| 6. Do not disable `webSecurity` | Met |
| 7. Define a CSP | Met, with two defects. See 1.4 |
| 8. No `allowRunningInsecureContent` | Met |
| 11/12. WebView rules | Met. `webviewTag: false` and `will-attach-webview` is prevented |
| 13. Limit navigation | Met. `will-navigate`, `will-frame-navigate`, `will-redirect` all denied off-origin (`electron/navigation.ts`) |
| 14. Limit new windows | Met. `setWindowOpenHandler` returns `{ action: "deny" }` unconditionally |
| 15. `shell.openExternal` care | Met. Only `http(s)` and `mailto` survive `isSafeHref`; everything else is dropped |
| 16. Current Electron version | **Not met.** See 1.2 |
| 17. Validate the `sender` of IPC messages | **Not met.** See 1.5 |
| 18. Prefer custom protocols over `file://` | Met, with a caveat. See 1.3 |
| 19. Fuses | **Not met.** No fuses are set. See 1.6 |
| 20. Do not expose Electron APIs to untrusted content | Met, and tested. `preload.test.ts` asserts the exposed surface is exactly `invoke`, `on`, `platform`, with a channel allowlist |

This is a better starting position than most Electron apps. The gaps below are specific, not
structural.

### 1.2 Electron 41 is end-of-life

Electron supports the latest three stable majors
(<https://www.electronjs.org/docs/latest/tutorial/electron-timelines>). Per the release schedule
(<https://releases.electronjs.org/schedule>), 41.0.0 shipped 2026-03-10 and reached end of life
**2026-08-25**. Supported today: 42, 43, 44, with 45 due 2026-10-20. This project pins
`electron: ^41.10.7`.

The pinned patch is not itself vulnerable. Electron's advisories of 2026-08-29 were backported to
41.10.6, so `^41.10.7` carries them. The problem is forward-looking: nothing found after 2026-08-25
will be backported to the 41 line, and Electron ships Chromium, so this is a browser engine that
stops receiving security fixes.

What lands in each major matters here. Electron 41 added ASAR integrity **digest** embedding on
macOS, which validates the integrity metadata itself rather than only the archive
(<https://www.electronjs.org/blog/electron-41-0>); it needs `@electron/asar` 4.1.0 or later and
`asar integrity-digest on /path/to/YourApp.app`. Electron 41 also moved WebAssembly trap handlers
behind the `WasmTrapHandlers` fuse.

**What to do.** Move to 44 (EOL 2027-03-02) rather than 42 (EOL 2026-10-20), so the next forced
upgrade is six months out rather than six weeks. Then adopt the discipline of one Electron major
upgrade per quarter. Signal Desktop is on 43.4.1
(<https://github.com/signalapp/Signal-Desktop/blob/main/package.json>), which is one useful
calibration for how current an audited Electron app keeps itself.

**Verdict: do it.** This is the single highest-value change in this document. An EOL Chromium in an
app that renders HTML written by strangers is the whole threat model in one line.

### 1.3 Custom protocol, and the CORS advisory that names this exact configuration

Serving from a custom scheme rather than `file://` is checklist item 18, and this project does it:
`app://mail/index.html`, registered as `{ standard: true, secure: true, supportFetchAPI: true,
corsEnabled: false }` (`electron/main.ts`). VS Code did the same thing when it sandboxed its
renderers, introducing `vscode-file` explicitly to "drop all uses of the file protocol"
(<https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox>).

That exact privilege combination has an advisory. **CVE-2026-70604 / GHSA-v3j7-r9gq-3gjw**, High,
CVSS 7.4 (<https://github.com/electron/electron/security/advisories/GHSA-v3j7-r9gq-3gjw>): a custom
scheme registered with `supportFetchAPI: true` but without `corsEnabled: true` did not enforce CORS,
so remote pages could `fetch()` cross-origin responses from that scheme. Patched in 41.4.0, 40.9.3,
39.8.10, 42.0.0. A companion advisory covers the built-in handlers
(<https://github.com/electron/electron/security/advisories/GHSA-j84w-jfhq-vhvj>).

Two things follow. The pinned 41.10.7 is patched, so this is not a live hole. But the advisory's
stated workaround is instructive: "Do not load untrusted content in sessions that can reach the
scheme," and it explicitly says setting `corsEnabled: true` is *not* a mitigation because that
permits cross-origin reads by design. The message iframe is `srcdoc` in the app session, so it can
reach `app://`. The structural answer is a separate `session` partition for message rendering, and
dropping `supportFetchAPI` if the renderer never actually fetches from `app://` (it loads scripts,
styles, images and attachments by URL, which do not need it).

**Verdict: do it before strangers install.** Check whether `supportFetchAPI` is used at all; if not,
remove it. A separate session partition for untrusted mail rendering is the more thorough fix and is
worth the afternoon.

### 1.4 CSP: two defects

The app origin's policy is set both as a `<meta>` tag in `index.html` and as a response header in
`protocol.handle` (`APP_CSP` in `electron/main.ts`), which is the right belt-and-braces shape, since
a header covers the whole origin and a meta tag does not.

Two defects:

**A static nonce is not a nonce.** Both `APP_CSP` and the meta tags carry `script-src 'self'
'nonce-arcmail'`. A CSP nonce "needs to be dynamically generated as it has to be unique for each HTTP
request" and must come from "a cryptographically secure random token generator"
(<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src>).
`arcmail` is a literal in a public repository. No script in `index.html` or `preview.html` actually
carries `nonce="arcmail"`, so it buys nothing today and would let any injected inline script run.
Delete it; `script-src 'self'` already covers the bundled scripts.

**Dev-only sources ship in production.** The meta tags in `index.html` and `preview.html` include
`connect-src 'self' ws://localhost:5173 http://localhost:5173`. Those are Vite's dev server. They
ship in `dist/` and are present in the packaged app. The header form (`APP_CSP`) correctly omits
them, and the header wins where both apply, but the meta tag is the one that governs before the
header lands and the divergence is a bug waiting to be inverted. Build the meta tag from the same
constant the header uses, or drop the meta tag and rely on the header.

Also worth a second look: `APP_CSP` sets `img-src 'self' data: https: http: cid:`. The app origin can
therefore load arbitrary remote images, including over plain `http:`. Nothing untrusted renders in
the top frame today, so this is not exploited, but it is a wider grant than the app needs and it is
the exact grant a tracking pixel wants.

**Verdict: do it.** All three are single-line changes with a test each.

### 1.5 IPC sender validation

Checklist item 17 is unambiguous: "You should always validate incoming IPC messages `sender` property
to ensure you aren't performing actions or sending information to untrusted renderers," because
"third-party iframes" can send IPC. The documented pattern checks `event.senderFrame`
(<https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/security.md>).

Every handler in `apps/desktop/electron/ipc/` ignores the event: `ipcMain.handle("ai:ask", (_e,
question) => ...)`. Argument validation is good (`ipc/guard.ts` resolves account ids against the
store and shape-checks emails before they reach SQL), but that is a different control. Nothing checks
*who* sent the message.

The mitigating facts: `contextIsolation` and `sandbox` are on, the preload exposes a fixed channel
allowlist, message HTML renders in a `srcdoc` iframe with `script-src 'none'`, and navigation off
`app://` is denied in every frame. A frame that could send IPC would already be a full compromise.
So this is defence in depth, not a live hole. It is also about ten lines: one `assertSender(e)` helper
that checks `e.senderFrame` is the top frame of the main window's WebContents on the `app://` origin,
called from a wrapper around `ipcMain.handle`.

**Verdict: do it.** Cheap, and it is a named checklist item a security reviewer will grep for.

### 1.6 Fuses

Fuses are build-time booleans flipped into the Electron binary
(<https://www.electronjs.org/docs/latest/tutorial/fuses>). The ones that matter and their defaults:

| Fuse | Default | Set it to | Why |
|---|---|---|---|
| `runAsNode` | enabled | **false** | `ELECTRON_RUN_AS_NODE=1` turns the signed app into a general Node interpreter. This is the classic living-off-the-land escalation and Electron's own statement on the run-as-node CVEs names disabling it as the mitigation (<https://www.electronjs.org/blog/statement-run-as-node-cves>) |
| `enableNodeCliInspectArguments` | enabled | **false** | `--inspect` against the signed binary; same class of abuse |
| `enableNodeOptionsEnvironmentVariable` | enabled | **false** | `NODE_OPTIONS` injection into the main process |
| `enableEmbeddedAsarIntegrityValidation` | disabled | **true** | Validates the SHA256 of the ASAR header at launch; mismatch terminates the app |
| `onlyLoadAppFromAsar` | disabled | **true** | Without it the integrity fuse is bypassable, because app code can still be found outside `app.asar` |
| `grantFileProtocolExtraPrivileges` | enabled | **false** | Safe here: the app serves from `app://`, not `file://` |
| `enableCookieEncryption` | disabled | leave | Little value: OAuth runs in the system browser via `shell.openExternal`, so the app holds no session cookies. Note the transition is one-way |

`runAsNode: false` has one consequence to check first: `child_process.fork` in the main process stops
working. This app shells out to a CLI and talks to a local daemon; confirm those use `spawn`/
`execFile` and not `fork` before flipping it.

electron-builder supports all of these through an `electronFuses` key, and importantly it flips them
"after packaging and **before** signing" so the final signature covers the modified binary
(<https://www.electron.build/docs/tutorials/adding-electron-fuses/>). The field names are
`runAsNode`, `enableCookieEncryption`, `enableNodeOptionsEnvironmentVariable`,
`enableNodeCliInspectArguments`, `enableEmbeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar`,
`loadBrowserProcessSpecificV8Snapshot`, `grantFileProtocolExtraPrivileges`, `wasmTrapHandlers`,
`resetAdHocDarwinSignature`.

ASAR integrity on macOS needs an `ElectronAsarIntegrity` dictionary in `Info.plist` holding the
algorithm and header hash (<https://www.electronjs.org/docs/latest/tutorial/asar-integrity>).
`@electron/packager` 18.3.1+ and Forge 7.4.0+ write it automatically; electron-builder computes it in
`app-builder-lib/src/asar/integrity.ts`, with a known gap that ASAR files under `extraResources` are
not covered (<https://github.com/electron-userland/electron-builder/issues/8660>).

Two honest limits. ASAR integrity protects against **post-install tampering on the user's disk**, not
against a malicious dependency you shipped, which gets hashed in as legitimate content. And it is
only meaningful once the app carries a real code signature: an attacker who can rewrite `app.asar`
can rewrite `Info.plist` too, unless the signature covers both. Fuses and integrity are downstream of
section 2.

Verify what shipped with `npx @electron/fuses read --app "/Applications/Arcforma Mail.app"`, and put
that in the release checklist.

Also relevant: **CVE-2025-55305 / GHSA-vmqv-hx8q-j7mg**
(<https://github.com/advisories/GHSA-vmqv-hx8q-j7mg>) was a V8 snapshot integrity gap that affected
*only* apps with `embeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` enabled. Turning
security features on adds surface as well as removing it; the answer is staying current, not staying
off.

**Verdict: do it, together with section 2.** Fuses without code signing are theatre. Fuses with code
signing are one of the few controls that survives an attacker with local file access.

### 1.7 Rendering untrusted HTML

This is the part of a mail client where the threat is not hypothetical, and the research moved this
year.

PortSwigger published *CSS: the bomb inside your inbox* on 2026-08-06
(<https://portswigger.net/research/css-the-bomb-inside-your-inbox>), affecting Yahoo Mail, AOL Mail,
Fastmail, ProtonMail, Gmail and Outlook. The techniques, all script-free:

- `<label for>` hijacking to drive UI controls outside the message.
- Token exfiltration by nested CSS attribute selectors.
- A **font-height oracle** using `@font-face` with `unicode-range` and `descent-override`, which
  leaks data with no network request at all and therefore is not stopped by CSP `img-src`.
- CSS mutation: hex-escaped identifiers such as `@keyframes \7b\7d\7d\2a\7b...` that decode inside
  the CSSOM into `@keyframes {}}*{color:red}` and break out of a sanitizer's restrictions.
- Keyloggers built from `<select>`/`<option>` plus `:has()` and `:checked`, with
  `-webkit-text-security: disc` to spoof a password field.
- Image-proxy bypasses via `url()` comment injection, backslash escapes, and
  `image-set(var(--x,'//host'))`.
- CSS gadgets: custom `data-*` attributes that the host app's own JavaScript turns into DOM carrying
  properties outside the sanitizer's allowlist.

The recommended defences, in the author's order: isolate the message in a sandboxed iframe; audit
custom data attributes; validate identifiers against a strict character allowlist to avoid CSSOM
mutation; block `:has()`, `:checked`, `:focus`, `:not()`; block `<select>`; proxy or block images and
block `data:` URLs used to spoof login screens; never allowlist attacker-controllable domains in CSP.

**Where this project already stands, and it stands well.** `PURIFY_CONFIG`
(`apps/desktop/src/lib/mailhtml.ts`) forbids `select`, `option`, `input`, `button`, `textarea`,
`form`, `svg`, `math`, `template`, `slot`, `object`, `embed`, `iframe`, `link`, `meta`, `base`, and
sets `ALLOW_DATA_ATTR: false`. That closes the keylogger, the form hijack and the data-attribute
gadget outright. The iframe is sandboxed without `allow-scripts`, and `buildMessageCsp` sets
`default-src 'none'`, `script-src 'none'`, `font-src 'none'`, `connect-src 'none'` and, with images
off, `img-src data: cid:`. `font-src 'none'` closes the font-height oracle. There is a size cap
(`MAX_HTML_CHARS`, 800k) and the sanitize pass runs in an inert `DOMParser` document so nothing
fetches during sanitization.

**The gaps, in order:**

1. **`scrubCss` is four regexes** (`CSS_URL`, `CSS_IMPORT`, `CSS_EXPRESSION`, `CSS_BEHAVIOR`). Regex
   CSS filtering is exactly what the CSSOM-mutation section of that research defeats: `\75rl(...)`
   does not match `/url\s*\(/`. With images off this is contained by `default-src 'none'`. With
   images **on**, `img-src https:` governs CSS `background-image`, so a hex-escaped `url()` reaches
   the network as a tracking pixel while the app believes it stripped it. The same blind spot makes
   `hasRemoteImages` under-report, so the "this message wants to load remote content" affordance can
   fail to appear. The fix is not a better regex; it is to state plainly that CSP is the control and
   `scrubCss` is a courtesy, and to add hostile-corpus tests for the escape forms.
2. **`<label>` is still allowed** by `USE_PROFILES: { html: true }`. Low risk here because every form
   control is forbidden, so `for` has nothing to target inside the frame, but it costs nothing to
   forbid `label` or strip `for`.
3. **No hostile corpus.** `docs/ROADMAP.md` already lists "fuzz the sanitizer with a corpus of hostile
   HTML." Seed it from the PortSwigger techniques above, one test per technique, and treat each as a
   regression test.

**The iframe sandbox attribute.** It is currently `sandbox="allow-same-origin allow-popups
allow-popups-to-escape-sandbox"`. MDN's warning is about combining `allow-scripts` **and**
`allow-same-origin`, which "lets the embedded document remove the `sandbox` attribute"
(<https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe>). `allow-scripts` is
absent, so that specific hazard does not apply.

`allow-popups` is worth re-examining in light of two advisories from 2026-08-29:
**GHSA-gr2m-v5gq-v685**, High, CVSS 8.2, "Windows opened from a sandboxed top-level document do not
inherit its sandbox restrictions"
(<https://github.com/electron/electron/security/advisories/GHSA-gr2m-v5gq-v685>), and
**GHSA-hq2x-r82h-9wj4** on the same theme, plus **GHSA-9f4c-93c8-jc8g** from 2026-07-27 on bypassing
`allow-popups` through the OpenURL path. The stated workaround for the first is exactly what this app
already does: "Return `{ action: 'deny' }` from `setWindowOpenHandler`," and "Apps that deny popups
from untrusted content with `setWindowOpenHandler` are not affected." So the app is protected by its
navigation guard rather than by the sandbox attribute. Given that, `allow-popups` and
`allow-popups-to-escape-sandbox` are not earning their place and should come out; link clicks are
already routed through `hardenNode` and `shell.openExternal`.

**DOMPurify is the dependency to watch.** It shipped at least eleven advisories between 2026-06-15
and 2026-08-18 (<https://github.com/advisories?query=dompurify>), including GHSA-748c-f84h-hp2v
(before 3.4.13) and GHSA-55q2-fjhq-7xh7 on `IN_PLACE` sanitization. The pinned `^3.4.14` is current.
The lesson is cadence, not version: DOMPurify needs to be on a fast lane, exempt from any release-age
delay, and its advisories watched directly. Cure53's own threat model
(<https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model>) is the right thing to read
before relying on it as a sole control, which this project correctly does not.

**Verdict: do it.** The hostile corpus and dropping `allow-popups` are the two items; both are small.
This section is the app's core risk and is also where it is already strongest.

### 1.8 Tooling

Electronegativity (<https://github.com/doyensec/electronegativity>) is the standard static analyser
for Electron misconfiguration and has a GitHub Action. It is effectively unmaintained: 1.10.3 is the
latest and Doyensec directs users to the commercial ElectroNG. It still detects the flat
configuration errors (`nodeIntegration`, `contextIsolation`, missing CSP), none of which this project
has.

**Verdict: cargo cult here.** It would find nothing this document has not, and adding an unmaintained
scanner to CI is a maintenance cost with no yield. Revisit if it gets picked up again.

### 1.9 Token storage

`safeStorage` on macOS wraps a Keychain-held key, which is the right primitive and what
`SECURITY.md` already claims. The limit worth documenting rather than fixing: any process running as
the same user can generally ask the Keychain for that item, so `safeStorage` protects a stolen disk
and a stolen backup, not a compromised user session. That is the same guarantee Chrome's "Safe
Storage" item gives, and it is honest to say so.

`docs/ROADMAP.md` already proposes a sleep-timeout wipe of decrypted state, which is the right next
step and goes beyond what most Electron apps do.

**Verdict: document the limit now, build the lock later.** A one-line correction in `SECURITY.md`
costs nothing and prevents a claim the code does not support.

---

## 2. Release engineering and auto-update

### 2.1 Where this project is

`apps/desktop/electron-builder.json` today: `hardenedRuntime: false`, `notarize: false`,
`identity: "Arcforma Dev"`, `type: "development"`, target `dmg` for `arm64` only, and an `afterPack`
hook that self-signs with a certificate the keychain reports as untrusted. `pack` runs with
`CSC_IDENTITY_AUTO_DISCOVERY=false`. There is no `electron-updater` dependency, no `zip` target, no
release workflow, and no signed release.

That is a correct configuration for a single-user app on the author's own machine, which is what the
README says this is. It is not a configuration anyone else can install. Everything below is the gap
between those two states.

### 2.2 Signing and notarisation are not optional

Apple's requirements, all mandatory together: a Developer ID Application certificate (Apple Developer
Program only, the free account cannot issue one), Hardened Runtime, a secure timestamp, notarisation
through `notarytool`, and a stapled ticket. `altool` uploads were rejected from 2023-11-01
(<https://developer.apple.com/news/upcoming-requirements/?id=11012023a>,
<https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool>).
Electron needs the `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory` entitlements for V8.

The cost is **$99 per year** (<https://developer.apple.com/programs/whats-included/>). There is no
open-source exemption. Apple's fee waiver covers recognised nonprofits, accredited educational
institutions and government entities that are legal entities
(<https://developer.apple.com/help/account/membership/fee-waivers/>); an individual or a company
does not qualify. Arcforma AI Inc. would enrol as an organisation.

What happens without it on current macOS matters, and the picture is sharper than folklore suggests:

- **Unsigned, or a broken signature: blocked outright.** The "damaged and can't be opened" dialog,
  with no bypass, even after stripping the quarantine attribute.
- **Ad-hoc signed but not notarised** (what `afterPack` produces today): runs when not quarantined,
  blocked when quarantined. Anything downloaded from GitHub Releases is quarantined. So this is not a
  distribution posture.
- **The Control-click Open bypass is gone.** Removed in macOS 15 Sequoia and tightened in 15.1; users
  must go to System Settings, Privacy and Security, "Open Anyway"
  (<https://support.apple.com/en-us/102445>). `spctl --master-disable` no longer works.

Three consequences follow that are easy to miss:

1. **Auto-update cannot work at all without a signature.** Electron's own docs: "Your application
   must be signed for automatic updates on macOS. This is a requirement of Squirrel.Mac"
   (<https://www.electronjs.org/docs/latest/api/auto-updater>).
2. **The fuses and ASAR integrity of section 1.6 are only meaningful once signed**, because the
   signature is what makes them tamper-evident.
3. **Homebrew will not take an unsigned cask.** Casks "must pass Homebrew's Gatekeeper checks and
   must not require System Integrity Protection or Gatekeeper to be disabled or bypassed"
   (<https://docs.brew.sh/Acceptable-Casks>).

**Verdict: do it before strangers install.** The $99 is the cheapest line item in the whole pipeline
and three separate goals depend on it. Set `forceCodeSigning: true` so CI fails loudly rather than
silently shipping an unsigned build (<https://www.electron.build/docs/features/code-signing/>).

For CI, prefer an App Store Connect API key (`.p8`) over an Apple ID plus app-specific password: it
does not break when a password rotates or 2FA changes. `@electron/notarize` supports `appleApiKey` +
`appleApiIssuer` + key id, `appleId` + `appleIdPassword` + `teamId`, or a stored `keychainProfile`
(<https://github.com/electron/notarize>). electron-builder reads `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`, `APPLE_TEAM_ID`, and `CSC_LINK` plus `CSC_KEY_PASSWORD` for the certificate
(<https://www.electron.build/docs/features/code-signing/notarization/>).

### 2.3 Which updater

Squirrel.Mac is not a choice. It is the Objective-C framework embedded inside Electron
(<https://github.com/Squirrel/Squirrel.Mac>), running a helper called `ShipIt`. Everything else is a
client on top of it.

- **Electron's built-in `autoUpdater`** is a thin binding over Squirrel.Mac and needs a server that
  speaks the Squirrel JSON protocol.
- **`update-electron-app`** (<https://github.com/electron/update-electron-app>, v3.3.0) is the
  Electron team's wrapper around the free update.electronjs.org service. It requires a public GitHub
  repo, GitHub Releases, and a code-signed macOS build, and it imposes its own asset naming. It gives
  you no channels and no staged rollout.
- **`electron-updater`** (stable 6.8.9) reads `latest-mac.yml` from a provider, then on macOS serves
  the downloaded ZIP to Squirrel.Mac over a short-lived localhost HTTP server with Basic auth and a
  random token (`packages/electron-updater/src/MacUpdater.ts`).

**Pick `electron-updater`.** electron-builder 26 already emits the metadata format it reads, and it
is the only one of the three that supports channels and percentage rollouts, both of which a one-
developer project needs precisely because there is nobody else to catch a bad release.

**The ZIP requirement has not changed.** electron-builder's macOS docs say the "Squirrel.Mac auto
update mechanism requires both `dmg` and `zip` to be enabled, even when only `dmg` is used"
(<https://www.electron.build/docs/mac/>); Squirrel.Mac requests updates with `Accept: application/zip`
and only installs ZIPs. This project currently builds `dmg` only. Ship the DMG for humans and the ZIP
for the updater, and never delete the ZIP from a published release.

macOS differential updates exist: `MacUpdater` caches the previous `update.zip` and downloads against
the `.zip.blockmap`, falling back to a full download. It landed in 6.2.0, was reverted in 6.2.1, and
came back in the 6.3 line. Maintainers have not published a support statement
(<https://github.com/electron-userland/electron-builder/issues/9498>) and macOS ZIP blockmap
generation cannot currently be disabled
(<https://github.com/electron-userland/electron-builder/issues/9479>). Treat it as best-effort
bandwidth saving; `disableDifferentialDownload` is the escape hatch.

### 2.4 How updates are actually verified, and what that means

This is worth understanding before trusting it. `electron-updater` performs **no cryptographic
signature validation of its own on macOS**. It checks the SHA-512 and file size from
`latest-mac.yml`, then hands the ZIP to Squirrel.Mac. Squirrel.Mac does the real check in
`SQRLCodeSignature.m` via `SecStaticCodeCheckValidityWithErrors` with `kSecCSCheckNestedCode |
kSecCSStrictValidate | kSecCSCheckAllArchitectures`, against a requirement derived from the
**currently running app's** designated requirement
(<https://github.com/Squirrel/Squirrel.Mac/blob/master/Squirrel/SQRLCodeSignature.m>).

So the update must be signed by the same identity as the installed app. That is a strong property,
and it is entirely inherited. Two consequences:

- If the installed app is unsigned or ad-hoc signed there is no usable designated requirement, and
  the chain degrades to nothing. This is the mechanical reason signing is a hard requirement.
- **The manifest itself is trusted on TLS and GitHub alone.** A compromised GitHub account or release
  token yields a valid-looking `latest-mac.yml`. The only thing standing between that and code
  execution on every user's machine is that the attacker lacks the Developer ID key. **The signing
  key and the release token are the security boundary of this product.** Keep the key off the laptop
  and in Actions secrets, and use a short-lived token.

**Advisories to pin against**, all in the electron-builder family:

| ID | CVE | Package | Fixed in | Note |
|---|---|---|---|---|
| GHSA-9jxc-qjr9-vjxq | CVE-2024-39698 | electron-updater | 6.3.0-alpha.6 | Signature-verification bypass. Windows only |
| GHSA-p2f4-r6v6-j797 | CVE-2026-54673 | builder-util-runtime | 9.7.0 | Case-sensitive `authorization` check leaked tokens on cross-origin redirect. **Affects the updater path** |
| GHSA-7g7r-gx96-252g | CVE-2026-54672 | app-builder-lib | 26.15.0 | AppImage only, not applicable here |

CVE-2026-54673 is new within the last year and is the one that matters: `builder-util-runtime` is
shared with `electron-updater`. Floor at `app-builder-lib >= 26.15.0` and
`builder-util-runtime >= 9.7.0`. The project's `electron-builder: ^26.15.3` clears it, but the
transitive floors should be asserted, not assumed.

Forward notice: `electron-updater` 7.0.0-alpha warns when signature verification is silently skipped,
and the changelog states that in electron-builder v28 a missing `publisherName` becomes a
verification *failure* rather than a silent pass. That is Windows-centric but shows the direction:
fail-closed.

### 2.5 Staged rollouts and channels

`stagingPercentage` is supported and cruder than it sounds. You add a top-level key to the published
manifest by hand (<https://www.electron.build/docs/features/auto-update/>):

```yaml
stagingPercentage: 10
```

The client hashes a locally persisted `stagingUserId` against it, so a given machine's decision is
stable across checks. The workflow on GitHub Releases is to publish, then re-upload the edited
`latest-mac.yml` with `gh release upload --clobber` at 10, 25, 50, then remove the key.

**The trap, stated in the docs: you cannot re-release the same version number.** Users already on a
broken 1.0.1 are stranded if you republish 1.0.1. A bad rollout is fixed by incrementing to 1.0.2.

Channels are `latest`, `beta`, `alpha`, with cascading visibility: alpha users see all three, beta
users see beta and latest (<https://www.electron.build/docs/tutorials/release-using-channels/>). Set
`generateUpdatesFilesForAllChannels: true` and encode the channel in the version (`1.2.3-beta`); on
the app side set `autoUpdater.channel`. A documented GitHub-specific gotcha: the GitHub publisher
does not infer the channel from the version tag, so set it explicitly in the publish options.

This is the same shape VS Code uses at much larger scale: two quality channels, stable and insider,
with progressive rollout and a "Check for Updates" force-fetch
(<https://code.visualstudio.com/docs/supporting/faq>).

**Verdict: channels yes, staged rollout yes, but only after the first hundred users.** With ten
installs a 10 percent rollout is one machine and tells you nothing. Build the channel split first
(you want a beta lane for yourself), and turn on `stagingPercentage` when the population is large
enough for it to mean something.

### 2.6 Reproducible builds

**Honest answer: not achievable for Electron on macOS today, and no comparable project claims it.**

Signal Desktop is the strongest existing effort and its own README says "Reproducible builds for
macOS and Windows are not available yet" and that reproducibility "is still experimental and may not
work on public releases yet"
(<https://github.com/signalapp/Signal-Desktop/blob/main/reproducible-builds/README.md>). Linux only.
Signal *Android* has had reproducible builds since 2016; the gap is the point.

Why it is hard, specifically: ZIP requires a modification timestamp and electron-builder does not
spoof it (<https://github.com/electron-userland/electron-builder/issues/3352>); code signing embeds a
timestamp from Apple's TSA and the stapled notarisation ticket is a per-submission artifact from
Apple's servers, so two builds of identical bytes produce different signed bundles by construction.
Any reproducibility claim would have to be about the pre-signing artifact, which is the harder and
less useful half.

**Could not confirm:** whether electron-builder or `app-builder-lib` honours `SOURCE_DATE_EPOCH`
anywhere. No documentation or changelog entry either way. Do not assume it does.

**What to do instead: deterministic inputs and tamper-evidence.** Commit the lockfile, pin the exact
Electron and electron-builder versions, pin the runner image and Node version, publish a
`SHA256SUMS` alongside the artifacts, and attach `actions/attest-build-provenance`. That is where the
ecosystem actually went, and it delivers the property users want (proof they got what you published)
without a claim you cannot honour.

**Verdict: chasing bit-for-bit reproducibility is cargo cult here.** `SHA256SUMS` plus provenance is
an afternoon and gets the real benefit.

### 2.7 Release checklist

One time:

1. Enrol Arcforma AI Inc. in the Apple Developer Program. Issue a Developer ID Application
   certificate, export as `.p12`.
2. Create an App Store Connect API key (`.p8`) for notarisation.
3. Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER`, `APPLE_TEAM_ID`.
4. `electron-builder.json`: `mac.target: ["dmg", "zip"]`, `hardenedRuntime: true`, `notarize: true`,
   an entitlements plist with `allow-jit` and `allow-unsigned-executable-memory`,
   `forceCodeSigning: true`, `generateUpdatesFilesForAllChannels: true`, and the `electronFuses`
   block from 1.6. Delete `type: "development"`, the `identity: "Arcforma Dev"` override and the
   self-signing `afterPack` hook.
5. Move off Electron 41.
6. Decide arm64-only or universal. `arm64` only excludes every Intel Mac still in use; universal
   doubles the download. arm64-only is defensible for a 2026 launch but should be stated on the
   download page rather than discovered.

Per release:

7. Bump the version, choose the channel, tag.
8. Build, sign, notarise and staple on a GitHub-hosted macOS runner (free and unmetered for public
   repos).
9. Verify all three, and fail the build on any of them:
   - `codesign --verify --deep --strict --verbose=2 "release/mac/Arcforma Mail.app"`
   - `xcrun stapler validate "release/mac/Arcforma Mail.app"`
   - `spctl --assess --verbose --type exec "release/mac/Arcforma Mail.app"`
10. `npx @electron/fuses read --app "release/mac/Arcforma Mail.app"` and diff against the expected set.
11. Publish as a **draft**. Confirm the assets include `.dmg`, `.zip`, `.zip.blockmap` and
    `latest-mac.yml`. **A release missing the ZIP or the manifest breaks auto-update for everyone.**
12. Attach `SHA256SUMS` and build provenance.
13. Publish. If staging, edit `latest-mac.yml` up through 10, 25, 50, then remove the key.
14. **Smoke-test the update path, not just the build.** Install the previous version from its DMG,
    launch it, let it update, confirm the relaunch. Squirrel.Mac failures are silent and only
    reproduce on a real signed install. This is the step everyone skips and it is the one that
    catches the bricking bug.
15. If a rollout goes wrong, increment the patch version. Never re-cut a published version number.

The existing `scripts/verify.sh` is the right place for steps 9 and 10.

---

## 3. Supply chain

### 3.1 What changed, and why the old advice is wrong

The npm ecosystem was attacked repeatedly and the platform response has been substantial. The short
history, because it explains every recommendation below:

- **2025-09-08, chalk/debug.** Phishing from the lookalike domain `npmjs.help` took over a maintainer
  account. Eighteen packages republished with a crypto-clipper. `debug@4.4.2`, `chalk@5.6.1`. Over
  two billion weekly downloads combined; live for roughly two and a half hours
  (<https://github.com/advisories/GHSA-4x49-vf9v-38px>).
- **2025-09-14, Shai-Hulud.** The first self-replicating npm worm: harvested credentials in
  `postinstall`, then used the victim's own publish rights to infect their other packages. GitHub
  removed 500+ packages
  (<https://github.blog/security/supply-chain-security/disrupting-supply-chain-attacks-on-npm-and-github-actions/>).
- **2025-11, Shai-Hulud 2.0.** ~796 packages, 1,092 versions, credentials from 500+ GitHub users
  across 150+ organisations.
- **2026-05-11, "Mini Shai-Hulud" (TeamPCP).** 84 artifacts across 42 `@tanstack` packages, spreading
  to 170+ including `@mistralai` and `@uipath`.

Platform changes, all on github.blog with dates: trusted publishing via OIDC went GA 2025-07-31;
new TOTP enrolment was permanently disabled and write-token expiry cut to 7 days default and 90 days
maximum on 2025-09-29; classic token creation was disabled 2025-11-05 and **all classic tokens were
permanently revoked 2025-12-09**, with `npm login` now issuing a two-hour session token; **staged
publishing** shipped 2026-05-22; Dependabot's 3-day cooldown became the default 2026-07-23; and npm
publish-time malware scanning went on by default 2026-07-28. npm v12 flipped `allowScripts` to off by
default (<https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/>).

### 3.2 The one lesson that reorders everything

The malicious `@tanstack` packages in Mini Shai-Hulud carried **cryptographically valid SLSA Build L3
provenance**. TeamPCP did not steal a token. They poisoned the GitHub Actions cache through a Pwn
Request, waited for the legitimate release workflow holding `id-token: write`, extracted the OIDC
token from runner memory, and signed through Sigstore and npm's own trusted-publishing
infrastructure. The attestations were *accurate*: they correctly named the real builder, repository
and workflow (<https://slsa.dev/blog/2026/05/mini-shai-hulud-what-slsa-can-and-cannot-do>,
<https://openssf.org/blog/2026/06/10/mini-shai-hulud-where-slsas-boundaries-fall/>).

**Provenance proves where a build ran. It never proves the code is safe.** Do not treat a provenance
badge as a substitute for a release-age delay, and do not let it inflate your confidence in a
dependency. OpenSSF's own reading is that pinning Actions by SHA, least-privilege `permissions:`, and
never using `pull_request_target` would have stopped this attack where provenance did not.

**Flag: this is the item where guidance genuinely changed in the last year.** Advice written before
mid-2026 treats provenance as an integrity guarantee. It is not one.

### 3.3 pnpm: this project is already close to current

pnpm 11 removed `onlyBuiltDependencies`, `neverBuiltDependencies`, `ignoredBuiltDependencies`,
`onlyBuiltDependenciesFile` and `ignoreDepScripts` in favour of a single `allowBuilds` map
(<https://pnpm.io/settings/build>). This repo already uses `allowBuilds`, which means any advice
found online that names the removed keys is stale.

pnpm 11 defaults (<https://pnpm.io/blog/releases/11.0>) that this project inherits without
configuring anything:

| Setting | pnpm 11 default | Previously |
|---|---|---|
| `minimumReleaseAge` | **1440** (24 hours) | 0 |
| `blockExoticSubdeps` | **true** | false |
| `strictDepBuilds` | **true** | false |
| `verifyDepsBeforeRun` | `install` | — |

That default 24-hour quarantine is why `pnpm-workspace.yaml` carries a long
`minimumReleaseAgeExclude` list for the TipTap and nodemailer pins. It is doing exactly what it
should: those entries are deliberate, dated exceptions rather than a blanket opt-out. Keep them
dated, and prune them when the versions age past the window.

Worth adopting: **`trustPolicy: no-downgrade`** (<https://pnpm.io/supply-chain-security>) blocks a
version whose trust evidence is weaker than an earlier published version, ranking approver (staged
publish) above trusted publisher above provenance above nothing. `namedRegistries` (11.20.0+) pins
packages to registries against substitution.

Worth knowing: **pnpm 12.0 shipped 2026-08-26**, backward compatible for commands, flags and settings
from 11 (<https://pnpm.io/blog/releases/12.0>). This repo pins `pnpm@11.18.0` in `packageManager`.
Low-risk upgrade, worth doing on a quiet day.

**On `pnpm audit`**: it takes `--audit-level`, `--prod`, `--json`, `--fix` (which writes
`overrides`), and there is `pnpm audit signatures` for registry signature verification
(<https://pnpm.io/cli/audit>). Note that `auditConfig.ignoreCves` became `auditConfig.ignoreGhsas` in
pnpm 11.

**The limit is the point.** `pnpm audit` reports only *known* advisories. Every incident in 3.1 was a
zero-day worm with no advisory at the time of attack. `pnpm audit` would have caught none of them.
`minimumReleaseAge` and `allowBuilds` are the controls that would have.

**Could not confirm:** whether the canonical audit-ignore key is `auditConfig.ignoreGhsas` or a newer
`audit:` block in `pnpm-workspace.yaml`; the docs show both shapes. Check against 11.18.0 before
writing config. `resolution-mode` no longer appears in the current dependency-resolution docs.

**Verdict: mostly already done.** Add `trustPolicy: no-downgrade`. Add `pnpm audit --audit-level high`
to CI as a signal, while writing down that it is not a control.

### 3.4 The CI workflow has three fixable weaknesses

`.github/workflows/ci.yml` is short and sensible, and has the three problems OpenSSF named as what
actually stopped Mini Shai-Hulud from being preventable:

1. **Actions are pinned by tag, not digest.** `actions/checkout@v4`, `pnpm/action-setup@v4`,
   `actions/setup-node@v4`. A tag is mutable. Pin by full commit SHA with the tag in a trailing
   comment, and let Dependabot or Renovate bump the SHA.
2. **No `permissions:` block.** The workflow inherits the repository default. Add
   `permissions: contents: read` at the top level and grant more only per job that needs it.
3. **No dependency review.** `actions/dependency-review-action` is free on public repositories and
   blocks pull requests that introduce vulnerable dependencies or disallowed licences. Set
   `fail-on-severity: high` (the default `low` will drown you) and
   `comment-summary-in-pr: on-failure` (<https://github.com/actions/dependency-review-action>).

Also add a scheduled `pnpm audit` job so advisories against already-installed versions surface
without waiting for a pull request.

**Verdict: do all three.** They are perhaps twenty lines and they are the highest-yield supply-chain
changes available to this repository.

### 3.5 Dependabot or Renovate

Both now have a cooldown, which is the setting that matters.

**Dependabot** (<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference>)
applies a 3-day cooldown by default for version updates since 2026-07-23; security updates are
deliberately exempt, since delaying a fix for a public flaw is worse than shipping it fast.

**Renovate** (<https://docs.renovatebot.com/configuration-options/>) has no key called "cooldown"; the
equivalent is `minimumReleaseAge`, which takes human strings. The setting people miss is
`internalChecksFilter: "strict"`, without which Renovate can automerge before `minimumReleaseAge`
elapses.

For a one-developer repository, Renovate's `dependencyDashboard` is the deciding feature: it replaces
a stream of pull requests with a single issue you triage when you feel like it. That is the
difference between dependency automation you use and dependency automation you mute. A defensible
combination is Dependabot for security updates only (native to GitHub advisories, zero config) plus
Renovate for version updates.

One project-specific rule whichever you pick: **`dompurify` and `electron` go on a fast lane**, exempt
from the release-age delay and never grouped, for the reasons in 1.2 and 1.7. Everything else can
wait three days and arrive in a weekly batch.

**Verdict: do it, one tool, with a dashboard.** Noisy dependency bots get ignored, and an ignored bot
is worse than none because it looks like coverage.

### 3.6 Provenance and publishing

Nothing is published to npm today: every package in `packages/` is `private: true`. So most of this
is contingent on section 4's decision.

If packages are ever published, the current shape is **trusted publishing (OIDC) configured as
stage-only, plus staged publishing**. A compromised workflow can then stage a release but cannot
release it without your interactive 2FA. That is the only control in this landscape that survived an
attacker holding a valid OIDC token inside the release workflow. Trusted publishing needs npm CLI
>= 11.5.1, Node >= 22.14.0, a GitHub-hosted runner, and `id-token: write`
(<https://docs.npmjs.com/trusted-publishers/>).

**Could not confirm:** whether current pnpm supports npm OIDC trusted publishing end to end.
`pnpm publish --provenance` exists (<https://pnpm.io/cli/publish>), but
<https://github.com/pnpm/pnpm/issues/9812> reads open and 11.0.8 had a real regression where OIDC
publish returned 404. Test with `--dry-run` on the installed version; the fallback is running
`npm publish` from a pnpm-installed workspace.

For the GitHub Release binaries, which is what this project actually ships,
`actions/attest-build-provenance` is cheap and one-time: permissions `id-token: write`,
`contents: read`, `attestations: write`, verified by users with `gh attestation verify PATH -R
oliverkoast/arcforma-mail`. Realistically a solo GitHub Actions project sits at **SLSA Build L2**, not
L3 (<https://slsa.dev/spec/v1.1/levels>); SLSA's own post-mortem notes GitHub Actions was issuing
L3-labelled attestations while not meeting L3 isolation.

**Verdict: attest the release binaries, yes. Claiming a SLSA level, no.** Say what you do, not what
tier you are.

### 3.7 Blast radius in an Electron app specifically

The renderer has the higher *attack surface*; the main process has the higher *severity*. A
compromised dependency in the main process gets `fs`, `child_process`, the network, the app's signed
identity and whatever Keychain access it holds. A compromised renderer dependency, with
`nodeIntegration: false`, `contextIsolation: true` and `sandbox: true` all holding here, is contained.

The practical instruction is therefore: **treat the main-process dependency list as a separate,
shorter, more carefully reviewed set than the renderer's, and push anything that can move to the
renderer.** Today the main process pulls in `@arcforma/gmail`, `@arcforma/store` and their transitive
tree; the renderer holds React, TipTap and DOMPurify. TipTap alone is roughly twenty packages, and it
is correctly on the renderer side.

Controls in value order:

1. **Lifecycle script blocking.** Already on via pnpm 11's `strictDepBuilds` plus the explicit
   `allowBuilds` map. This is where every Shai-Hulud generation lived.
2. **Fuses**, especially `runAsNode: false`, so a compromised dependency cannot use the signed binary
   as a general Node interpreter (<https://www.electronjs.org/blog/statement-run-as-node-cves>).
3. **ASAR integrity**, which catches post-install tampering on disk but hashes a malicious dependency
   in as legitimate content.
4. **Code signing**, which authenticates the publisher and makes the fuse settings tamper-evident. It
   does not inspect what was signed.
5. **Dependency count reduction**, the only control that shrinks the surface rather than containing
   it. The main-process tree is small enough here to actually audit once.

### 3.8 OpenSSF Scorecard

Twenty-five weighted checks, runnable as an Action with results in the Security tab
(<https://github.com/ossf/scorecard>).

**Run it once, act on three checks, then ignore the number.** The actionable ones are
Dangerous-Workflow, Token-Permissions and Pinned-Dependencies, which are exactly the three controls
in 3.4. The noise is structural and unfixable for a solo repository: Code-Review penalises you for
not having a second reviewer, Contributors wants people from two or more organisations,
Branch-Protection penalises a solo workflow, and Fuzzing, SAST and CII-Best-Practices want programmes
you do not have. Expect a mediocre aggregate score that says nothing about actual risk.

**Verdict: use it as a checklist, not as a metric.** Do not put the badge in the README; it will read
as a low number to anyone who does not know why.


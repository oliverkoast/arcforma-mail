# Engineering audit

Read-only assessment of this repository, carried out 2026-09-02 to 2026-09-03. Findings were
gathered against `dfb6885` and every headline finding was re-verified against `7b90864`, with line
numbers unchanged. Nothing was changed except the addition of this file, and no commit was made as
part of this work. Every claim below carries a file path and a line, or the output of a command that
was actually run.

## Verdict

This is a good codebase with a thin enforcement layer around it. The package boundaries are real and
correctly directed, the store's migration system is properly versioned and transactional, the
attachment path handling and the reading pane's sanitisation are better than most shipping mail
clients, and `docs/STANDARDS.md` is a genuinely excellent piece of security research that already
names the Electron 41 end-of-life problem, the static CSP nonce, the missing fuses and the missing
IPC sender check. The problem is that almost none of that rigour is enforced by anything: CI runs
typecheck, tests, a brand check and a secret scanner, and never builds the app, never runs the smoke
walk that `CONTRIBUTING.md` claims is mandatory, never builds the Swift app, and never runs `pnpm
audit`. Underneath that, three measured weaknesses stand out. There is a second, unsanitised HTML
rendering path in the compose editor that every control in `docs/STANDARDS.md` section 1.7 misses.
There is no diagnosability at all: no log file, no stack traces, no crash handler, so a bug a user
reports cannot be investigated. And the hot list and sidebar-count queries are O(n) over the whole
mailbox on the main thread, measurably 68 ms and 140 ms at 60,000 threads, one of which a single new
index reduces to 0.29 ms. The right way to read the finding list is that this repo has already done
the hard, non-obvious work, and is missing the cheap, boring work that turns it into something other
people can install.

**Working-tree caveat.** The repository was being actively edited during this audit: it advanced from
`1fb03e6` to `dfb6885` across three commits while the work was in progress, and `apps/desktop/src/
state/store.ts` grew from 1,571 to 1,713 lines under measurement. One `pnpm -r typecheck` run failed
mid-edit with `src/state/store.ts(418,54): error TS2739`; three subsequent runs on the settled tree
passed with exit 0. That failure is attributed to the live edit, not to a defect. All findings below
were re-verified against `dfb6885`.

**Baseline measurements.** 214 non-test source files (TypeScript, TSX, mjs, Swift), 78 test files
plus `SelfTest.swift`. `pnpm -r test` passes: 290 tests in `apps/desktop`, 73 in `packages/store`, 69
in `packages/gmail`, 37 in `packages/ai-core`, 5 in `packages/ai-daemon`, 0 failures, 0 skipped.
`pnpm -r typecheck` passes. `node scripts/brand-check.mjs` reports `clean (82 files)`. `node
scripts/secret-scan.mjs` reports `clean (368 files)`. `pnpm audit` reports `No known vulnerabilities
found`.

---

## 1. Structure and boundaries

### 1.1 The dependency direction is correct, and that is the repo's best structural property

**Severity: none. This is a strength.**

`packages/store` and `packages/gmail` contain no import of `electron` or `react` anywhere in
non-test source. `packages/gmail` references `@arcforma/store` in exactly one place, a test
(`packages/gmail/src/history.test.ts:6`), and never in shipped code. `packages/store` never
references `@arcforma/gmail`. The renderer under `apps/desktop/src` imports no Node builtin and no
Electron module in any non-test file; the only `node:` imports are `node:test` and `node:assert` in
test files. The renderer reaches the main process solely through `apps/desktop/src/bridge.ts` over
the preload allow-list.

This is the boundary most Electron projects get wrong, and it is worth saying plainly that it is
right here.

### 1.2 Only a third of `apps/desktop/electron` actually needs Electron

**Severity: medium.**

Of roughly 50 non-test TypeScript files under `apps/desktop/electron`, 16 import `electron`. The
other 34 are pure domain logic living inside the application shell:

| File | Lines | What it is |
| --- | --- | --- |
| `apps/desktop/electron/sync.ts` | 382 | The Gmail sync engine |
| `apps/desktop/electron/classify/pipeline.ts` | 380 | The classification sweep |
| `apps/desktop/electron/drafts/mirror.ts` | 351 | Two-way Gmail draft mirroring |
| `apps/desktop/electron/scheduler.ts` | 317 | Send queue, snoozes, reminders |
| `apps/desktop/electron/classify/attention.ts` | 295 | The attention model |
| `apps/desktop/electron/attachments/*.ts` | ~500 | Cache, paths, kind, reaper, service |
| `apps/desktop/electron/classify/{rules,corrections,fewshot,local}.ts` | 309 | Rule engine and few-shot |

That is roughly 3,500 lines of the most valuable and most testable logic in the product, and it is
not importable by anything other than the Electron app. A headless sync CLI, a background daemon, a
test harness that drives sync without launching a window, or any future non-Electron surface all
have to either import from an app directory or copy the code. It also explains finding 3.1: the IPC
layer is untested partly because it is fused to the same directory as the logic it calls.

**Fix (medium):** promote `sync`, `classify`, `drafts`, `scheduler` and `attachments` into a
`packages/mail-core` that depends on `@arcforma/store` and `@arcforma/gmail` and imports nothing from
Electron. `apps/desktop/electron` then keeps `main.ts`, `ipc/*`, `paths.ts`, `tokens.ts`,
`accounts.ts` and `attachments/window.ts`, which is the set that genuinely needs the runtime.

### 1.3 Verbatim duplicated logic across the store and gmail packages

**Severity: high.**

Seven exported function names exist in more than one package, and at least two pairs are
byte-for-byte identical implementations rather than a re-export:

- `parseAddressList` at `packages/gmail/src/mime.ts:160` and `packages/store/src/mail-headers.ts:19`,
  both preceded by an identical `ADDR_RE` constant
  (`/(?:"?([^"<]*)"?\s*)?<([^>]+)>|([^\s,<>]+@[^\s,<>]+)/g`).
- `normalizeSubject` at `packages/gmail/src/normalize.ts:8` and
  `packages/store/src/mail-headers.ts:33`, both preceded by an identical `REPLY_PREFIX`.
- `senderType`, `isAutoGenerated` (different signatures, same intent, both packages), `domainOf`
  (three copies: `packages/gmail/src/normalize.ts:59`, `packages/store/src/queries/attention.ts:41`,
  `apps/desktop/electron/classify/rules.ts:43`), and `htmlToText`
  (`packages/gmail/src/send.ts:27`, `apps/desktop/src/lib/mailhtml.ts:985`).

This is not a tidiness complaint. `parseAddressList` runs on the sync path in `gmail` and again on
the write path in `store`. If the two drift by one character in the regex, the addresses recorded on
a message and the addresses the UI computes from the same header silently disagree, and no test will
catch it because each package tests its own copy. `domainOf` in three copies feeds the attention
model, the rule engine, and normalisation, and a disagreement there changes how mail is sorted.

**Fix (medium):** one `packages/mail-headers` (or a `headers` export from `@arcforma/store`) that
both packages import. The store already exports `mail-headers.js` from its index
(`packages/store/src/index.ts:3`), so `packages/gmail` importing it is a one-line dependency change,
though it inverts the current direction and is better done as a third package.

### 1.4 Three import cycles, one of them at runtime

**Severity: low.**

A full import graph over the 165 non-test TypeScript files in `apps/desktop/{src,electron,shared}`
and `packages/{store,gmail}/src` finds exactly three cycles. Three in 165 files is good. Two of them
matter differently:

- `apps/desktop/shared/types.ts` and `apps/desktop/shared/onboarding.ts` import each other, both with
  `import type`. Harmless under `verbatimModuleSyntax`.
- `packages/store/src/db.ts` imports the values `recomputeThread` (line 1) and `reindexAllMessages`
  (line 7) from `./queries/messages.js`, which imports the value `transaction` back from `../db.js`
  (`packages/store/src/queries/messages.ts:3`). The same shape reaches `queries/labels.ts:2`. This is
  a real runtime cycle, and it sits in the migration path, which is the one place a partially
  initialised module binding would be hardest to debug and most destructive.

Also note `db.ts` imports from `./queries/messages.js` twice, at lines 1 and 7.

**Fix (small):** move `transaction`, `placeholders` and the `Db` type into a `packages/store/src/
sql.ts` that imports nothing from the package, and have both `db.ts` and `queries/*` depend on it.

### 1.5 Two god files

**Severity: medium.**

Ten largest non-test source files:

| Lines | File |
| --- | --- |
| 1713 | `apps/desktop/src/state/store.ts` |
| 1061 | `apps/desktop/src/lib/mailhtml.ts` |
| 897 | `packages/text-tools/Sources/ArcformaText/SelfTest.swift` |
| 669 | `apps/desktop/shared/types.ts` |
| 642 | `apps/desktop/electron/main.ts` |
| 443 | `apps/desktop/src/components/Settings.tsx` |
| 407 | `packages/store/src/types.ts` |
| 382 | `apps/desktop/electron/sync.ts` |
| 380 | `apps/desktop/electron/classify/pipeline.ts` |
| 375 | `packages/store/src/queries/attention.ts` |

Only two of these are doing too much.

`apps/desktop/src/state/store.ts` is a single Zustand store holding **121 state fields and 91 action
methods**. It owns account status, the sidebar layout and menu, sync progress, the list view and its
cursor and selection, the open thread, message expansion, keyboard scope, popovers, rails, search,
toasts, compose and inline reply placement, drafts, attachments, onboarding, and settings. It is also
where 53 of the repository's `as` casts live, the highest of any file. Any change to any of those
concerns touches the same file, and the 873-line test that covers it (which is genuinely the best
test file in the repo) has to reset a shared singleton between tests.

`apps/desktop/src/lib/mailhtml.ts` at 1,061 lines is more defensible: it is one coherent subject
(turn a stranger's HTML into something safe and readable) and it exports 33 small, individually
tested functions. It is large rather than confused. Splitting it into `sanitize`, `fold` and
`text` would help, but it is not urgent.

The other eight files are appropriately sized. Every React component is under 450 lines, which for a
mail client UI is disciplined.

**Fix (medium):** split `store.ts` along the seams that already exist in it, into slices for
`accounts`, `list`, `thread`, `compose`, `chrome` (toasts, popovers, scope) and `onboarding`,
composed into one store. Zustand supports this directly and the existing test can be split with it.

### 1.6 `shared/types.ts` is a healthy contract, not a dumping ground

**Severity: none. This is a strength.**

669 lines, 80 exports, and one import (`import type` from `./onboarding.js`). It contains type
declarations and four frozen constants (`HIGHLIGHT_START`, `HIGHLIGHT_END`, `EMPTY_COUNTS`,
`EMPTY_SIDEBAR_COUNTS`) and no logic. Every type in it is part of the renderer-to-main contract:
`ThreadSummary`, `MessageView`, `ListRequest`/`ListResponse`, the `AiFailure` discriminated unions,
`ToastEvent`. It contains no database row types (those stay in `packages/store/src/types.ts`, 407
lines) and no Gmail API types. The `ArcmailInvoke` interface in it is the single source of truth for
the preload allow-list, and `apps/desktop/electron/preload.test.ts` keeps the two in step.

This is what a boundary contract is supposed to look like. The only quibble is that at 669 lines it
would read better split by domain, but nothing is in it that does not belong.

---

## 2. Types

### 2.1 The SQLite row boundary is asserted, never validated

**Severity: high.**

There are **438 `as` casts** across the 165 non-test TypeScript files. There are essentially no
`any` types: a repository-wide grep for `: any`, `as any`, `<any>`, `@ts-ignore` and
`@ts-expect-error` returns zero real hits (the single apparent match,
`packages/store/src/queries/contacts.ts:42`, is a local variable named `any`). Non-null assertions
number about 20, each in a place where a preceding guard makes it locally sound. So the type
discipline is strong, and the escape hatches are almost entirely one pattern.

That pattern is the database read. `node:sqlite` returns rows as unknown-shaped objects, and every
query asserts the shape:

```ts
// packages/store/src/queries/threads.ts:159
const rows = db.prepare(sql).all(...args, limit + 1) as unknown as ThreadListRow[];
```

There are more than 30 of these across `packages/store/src/queries/`. Casts by file:
`apps/desktop/src/state/store.ts` 53, `packages/store/src/queries/scheduler.ts` 20,
`apps/desktop/electron/ipc/threads.ts` 14, `packages/store/src/queries/messages.ts` 11,
`packages/store/src/queries/attention.ts` 10, `packages/store/src/db.ts` 9,
`apps/desktop/electron/main.ts` 9.

`strict` and `noUncheckedIndexedAccess` cannot see through `as unknown as`. The consequence is
concrete: if a migration does not run, or a column is renamed, or a `LEFT JOIN` produces a null the
type says is non-null, the compiler is silent and the failure surfaces later as `undefined` in the
UI or a wrong sort order. Given finding 3.4 (migration 12 has no real coverage), that is not
theoretical.

**Fix (medium):** one `rows<T>(stmt, args, decode)` helper in `packages/store/src/db.ts` that
validates the first row of each distinct query shape in development and asserts in production, or a
generated row-type check derived from `schema.sql`. Even a development-only check would convert a
whole class of silent wrongness into a loud failure.

### 2.2 Fifty-three of seventy-six IPC handlers trust their arguments

**Severity: high.**

There are 76 `ipcMain.handle` registrations across 13 files in `apps/desktop/electron/ipc/`. The
guard module `apps/desktop/electron/ipc/guard.ts` is well designed and its comment states the threat
correctly ("an id it sends is still just a string"), providing `requireAccount` (which resolves the
id against the store rather than trusting it), `requireId` and `requireEmail` (which caps at 254
characters and shape-checks). It is called from **23 sites**, concentrated in `ipc/threads.ts` and
`ipc/accounts.ts`.

The rest declare a TypeScript parameter type and treat it as true. A TypeScript annotation on an
`ipcMain.handle` callback is a compile-time fiction: the value arrives over structured clone from
the renderer at runtime.

```ts
// apps/desktop/electron/ipc/compose.ts:36
ipcMain.handle("compose:send", async (_e, draft: ComposeDraft, sendAt?: number | null) => {
  const result = await sendDraft(db, draft, { sendAt: sendAt ?? null, ... });
```

`draft` is unvalidated and goes on to build MIME and enqueue an outbox row. Similarly
`apps/desktop/electron/ipc/threads.ts:223` and `:234` take `wakeAt: number` and `dueAt: number` with
no `Number.isFinite` or bounds check, so `NaN` writes a scheduler row that never fires;
`apps/desktop/electron/ipc/compose.ts:72` takes `accountIds?: string[]` unbounded;
`apps/desktop/electron/ipc/compose.ts:80` validates `trigger` tightly with a regex but accepts
`bodyHtml` unbounded.

The pattern for doing this correctly already exists twice in the codebase, which is what makes the
gap avoidable rather than unknown. `apps/desktop/electron/ipc/sidebar.ts:23` takes `layout: unknown`
and validates it with `isLayout` before use. `apps/desktop/electron/ipc/scheduler.ts:13` clamps an
incoming timestamp into a sane window with a comment explaining why.

There is no schema validation library in any manifest (no zod, valibot, ajv, superstruct, io-ts).

**Fix (medium):** widen `guard.ts` with `requireTimestamp`, `requireFiniteNumber`, `requireStringArray`
and a `requireDraft`, and apply them at every handler. A test that every key of `ArcmailInvoke` has a
handler and that every handler rejects a hostile payload would keep it honest.

### 2.3 Sender validation is written but inert

**Severity: medium.**

`dfb6885` added `apps/desktop/electron/ipc-sender.ts` and `apps/desktop/electron/ipc-guard.ts`,
implementing Electron security checklist item 17 (validate `event.senderFrame`), with a test at
`apps/desktop/electron/ipc-sender.test.ts`. Neither is imported by `main.ts` or by any file under
`ipc/`; a grep for `ipc-guard`, `ipc-sender` or `handleFrom` across `main.ts` and `ipc/*.ts` returns
nothing. The commit message says so explicitly: "Wiring it into main.ts waits for the build that
currently holds that file."

This is fine as a state of work in progress, but it is exactly the kind of thing that stays unwired.
`docs/STANDARDS.md:134` describes the control as done-shaped.

**Fix (small):** replace the direct `ipcMain.handle` calls in the 13 `ipc/*.ts` files with the
wrapper, and add a test that asserts no file under `ipc/` calls `ipcMain.handle` directly.

---

## 3. Tests

The suite is better than the file count suggests, and worse than the test count suggests. 78 test
files, 474 tests, all passing. The store and gmail packages are properly covered: every exported
function of every module in `@arcforma/store` and `@arcforma/gmail` is named in at least one test.
The failure is a single hard boundary at the Electron process edge.

### 3.1 The entire IPC layer and `main.ts` are untested

**Severity: critical.**

`apps/desktop/electron/ipc/` is 13 files and roughly 1,100 lines exporting 24 functions, and **none
of them is referenced by any test**. The one test file that sits in that directory,
`apps/desktop/electron/ipc/images.test.ts`, imports `../images.js` from the parent directory, so the
folder shows a green tick in a file listing while its contents have no coverage.
`apps/desktop/electron/ipc/guard.ts`, the sole input-validation layer for all 76 handlers, has no
test at all. `apps/desktop/electron/main.ts` (642 lines, including the `app://` protocol handlers,
CSP construction and navigation guards) has no test.

The consequence is that `apps/desktop/src/state/store.test.ts` verifies the renderer's side of the
contract against a hand-written fake main process, and `sync.test.ts` and `scheduler.test.ts` verify
the main process's side against real stores, and nothing verifies that the two halves agree.
`preload.test.ts` checks the two channel *lists* agree by regex over the file text, which catches
allow-list drift and nothing else.

**Fix (medium):** extract each handler body into a pure `(db, deps, args)` function in a
non-Electron module and test it against a temp store. The fixtures to do this already exist in
`sync.test.ts` and `scheduler.test.ts`. Add one test asserting every `ArcmailInvoke` key has a
registered handler.

### 3.2 Hostile HTML never reaches the real sanitiser

**Severity: critical.**

`apps/desktop/src/lib/mailhtml.test.ts` is 480 lines and makes the module look thoroughly tested. At
lines 83 to 90 it asserts `PURIFY_CONFIG.FORBID_TAGS.includes("script")`. That is a check that a
literal array contains a string. DOMPurify is never invoked in any test in the repository.
`hardenNode` is tested at lines 47 to 81 against a hand-rolled stub object built by the same author
from the same mental model, not against a real `Element`.

The composition that actually protects the user lives at `apps/desktop/src/components/MessageBody.tsx`
lines 14 to 18 (purify instance plus two hooks), line 40 (the sanitize call) and line 136 (the iframe
`sandbox` attribute), and none of it is tested. There is no DOM environment in
`apps/desktop/package.json`, so it currently cannot be.

A DOMPurify upgrade, a hook signature change, or a config edit could let script through and the
entire suite stays green. `docs/ROADMAP.md` already lists a hostile-HTML fuzz corpus as intended
work, and `docs/STANDARDS.md:206` enumerates the PortSwigger CSS techniques that corpus should
contain.

**Fix (small):** add `happy-dom` or `linkedom` as a dev dependency and one test that runs the real
`purify.sanitize(html, PURIFY_CONFIG)` over a hostile corpus, one case per technique.

### 3.3 No React component is rendered by any test

**Severity: high.**

37 files under `apps/desktop/src/components`, roughly 3,400 lines. The only symbol imported by any
test is `savedDraftFor` from `InlineReply.tsx` at `apps/desktop/src/state/store.test.ts:296`.
`Settings.tsx` (443), `ThreadList.tsx` (314), `ReadingPane.tsx` (240) and `AvailabilityPicker.tsx`
(255) are entirely unverified. Every UI regression is caught only by a human looking at smoke
screenshots.

**Fix (medium):** `happy-dom` plus `@testing-library/react`, starting with those four.

### 3.4 Migration 12 and migration 4 have no real coverage, because `schema.sql` was edited forward

**Severity: high.**

The migration system itself is well built: `packages/store/src/db.ts:248` walks a versioned step
list, each step inside a transaction, SQL first then a data fix-up, and line 276 throws hard if the
final version does not match `SCHEMA_VERSION`. Two of the migration tests are exemplary
(`packages/store/src/store.test.ts:317` rolls the FTS `fts_id` column back and asserts rowids stay
aligned; `:460` recreates the v2 `drafts` shape with a real row and asserts the backfill).

But `packages/store/src/schema.sql:148` already declares `attention` and `band`. So on any fresh
database, `migrateAttention` at `packages/store/src/db.ts:170` finds the columns present, adds
nothing, and runs its backfill `UPDATE` against an empty table. Migration 12 has zero real coverage.
The same applies to `repairSnippets` (`db.ts:255`, version 4), which is never invoked with
entity-carrying snippets.

A real user upgrading from schema 11 runs untested code, and if it fails the store will not open at
all, because of the hard throw at line 276.

**Fix (small):** follow the pattern already used at `store.test.ts:460`: roll `classifications` back
to its v11 shape with real rows, re-run `migrate`, assert the backfill.

### 3.5 The smoke walk is real integration coverage that asserts nothing, and CI does not run it

**Severity: high.**

`apps/desktop/scripts/smoke.mjs` is a good idea, well executed. It runs the production path (vite
build, esbuild the main process), launches real Electron against a throwaway user-data directory
seeded by `apps/desktop/electron/smoke/seed.ts` (269 lines of threads, bodies, classifications,
snoozes, reminders, queues, calendar events and real PNG and PDF attachment bytes), and walks about
35 steps in `apps/desktop/electron/main.ts:406` including expanding quoted history *inside the
sandboxed iframe*, the attachment preview windows, and clearing a queue to empty. That genuinely
crosses renderer to preload to ipcMain to store to attachment cache, which is the seam finding 3.1
says nothing else covers. It has an `--onboarding` mode that walks first-run setup against a
deliberately empty machine.

Its pass criteria (`apps/desktop/scripts/smoke.mjs:83`) are: no line matching `/^SMOKE \[(error|2|3)\]/`,
at least one screenshot, and exit 0. It never asserts content. A step that renders an empty thread
list, the wrong thread, or a blank compose box passes.

`CONTRIBUTING.md:17` states that every change runs `pnpm --filter desktop smoke` with zero console
errors. `.github/workflows/ci.yml` runs `pnpm -r typecheck`, `pnpm -r test`, `brand-check.mjs` and
`secret-scan.mjs`, and nothing else. It never builds the app. `scripts/verify.sh` also omits smoke.
The stated gate is enforced by nobody.

This was demonstrated during the audit. Run against the in-flight working tree, the smoke walk
produced `32 screenshot(s)`, `1 console error line(s)` and exit 1, failing at the attachments step
with `Cannot read properties of null (reading 'scrollIntoView')`. Re-run against the settled tree at
`dfb6885` it produced `39 screenshot(s)`, `0 console error line(s)` and exit 0. So the committed code
is fine and the harness works exactly as intended: it caught a real breakage in work in progress,
which is the whole point of it. Nothing automated was watching, and nothing would have been if that
state had been committed.

**Fix (small):** add `pnpm --filter desktop build` and `pnpm --filter desktop smoke` to CI (the
runner is already `macos-latest`), and add content assertions to two or three steps, for example the
thread count in the list and the subject of the opened thread.

### 3.6 The two integration tests skip permanently and silently

**Severity: high.**

Both files end in `.test.mjs`, so `node --test test/*.test.mjs` picks them up on every run, and
`node --test` exits 0 on skips.

`packages/ai-core/test/local.integration.test.mjs:9` gates on
`fs.existsSync(path.join(os.homedir(), "Projects", "openwhispr", "resources", "bin",
"llama-server-darwin-arm64"))`, a hardcoded path into a different, unrelated project on one
developer's machine, plus `!process.env.CI`. On CI it always skips. If openwhispr moves, it skips
forever and nobody is told.

`packages/ai-daemon/test/live.integration.test.mjs:8` skips unless the installed daemon answers
`/v1/health`, and the skipping continues inside the running test: line 21 turns a genuinely broken
local model into an early `return` that passes, and line 27 asserts a 503 when Claude is signed out,
so the actual completion path is never exercised.

These two files read as end-to-end proof of the AI stack and contribute no signal.

**Fix (small):** print an explicit `SKIPPED: <reason>` line, make the precondition a named
environment variable rather than a path into another project, and turn the 503 early return into a
failure unless an explicit opt-out flag is set.

### 3.7 The AI daemon HTTP contract is asserted three times and bound nowhere

**Severity: high.**

The contract exists in three independent places: the server (`packages/ai-daemon/src/server.mjs:77`,
`statusFor`), the Electron client (`apps/desktop/electron/ai/client.ts`, tested against a `FetchLike`
stub the test author wrote), and the Swift client
(`packages/text-tools/Sources/ArcformaText/AI/AIClient.swift`, tested against a Python fake daemon
inside `SelfTest.swift`). Rename a field in `service.status()` and all three suites stay green while
both clients break. The only test that crosses all three is the one from 3.6 that skips on CI.

Untested server branches: `/v1/tasks` (`server.mjs:62`), the 2 MB `MAX_BODY` cap (`:88`), and the
invalid-JSON path, which returns **500 `internal`** through the outer catch at `:67` rather than the
400 `bad_request` the code shape implies.

**Fix (small):** one shared JSON contract fixture that `server.test.mjs`, `ai/client.test.ts` and the
Swift self-test all read.

### 3.8 The Swift package is invisible to `pnpm test` and to CI

**Severity: medium.**

`packages/text-tools` has no `package.json`, so pnpm does not enrol it (confirmed by the lockfile
importers list, which contains only `.`, `apps/desktop`, and the four `packages/*` that have
manifests) and `pnpm -r --if-present test` skips it. `SelfTest.swift` is 897 lines covering
accessibility, host policy, clipboard capture, the fail-closed replace path, CLI process hygiene and
a fake daemon, and it runs only via `ArcformaText --selftest`, invoked by hand or by
`scripts/verify.sh`. CI never builds Swift, so a compile break lands on `main` green.

**Fix (small):** add `packages/text-tools/package.json` with a `test` script that builds and runs
`--selftest`.

### 3.9 Where the coverage is theatre

**Severity: medium.** Named specifically, because the headline of 474 tests is misleading:

- `packages/store/src/store.test.ts:217` asserts an `EXPLAIN QUERY PLAN` against a **hand-written
  copy** of the inbox query. Production `listThreads` builds its SQL dynamically from
  `fragments.ts`, `QUEUE_JOIN` and `CAN_UNSUBSCRIBE`. The production query can regress to a full
  scan and this test still passes. Section 6 below shows that several sibling views already do.
- `apps/desktop/src/lib/mailhtml.test.ts:83` as described in 3.2.
- `packages/ai-daemon/test/live.integration.test.mjs` and
  `packages/ai-core/test/local.integration.test.mjs` as described in 3.6.
- `apps/desktop/electron/preload.test.ts` greps `preload.cts` as text and never executes it. It does
  catch the one drift that matters and it fails loudly, so it earns its place, but it is a lint rule,
  not a test.
- `apps/desktop/src/lib/tips.test.ts` and `highlight.test.ts:33` restate string constants. They break
  on every copy edit and catch nothing.

### 3.10 Where the coverage is real

**Severity: none. These are strengths, and should not be disturbed.**

- `apps/desktop/src/state/store.test.ts` (873 lines) uses a **stateful** fake main process with a
  real in-memory drafts map, so "two overlapping autosaves write one row, not two" (line 626) is a
  meaningful assertion. Every assertion is on observable behaviour, never on call shapes. Races are
  constructed deliberately with injected delays.
- `packages/gmail/src/oauth.test.ts` binds a real loopback server and asserts the security properties
  directly: a wrong state returns 400 and **no token exchange happens** (line 100).
- `packages/gmail/src/client.test.ts` uses an injected clock and a real `multipart/mixed` fixture,
  and asserts partial-failure retry composition (line 115).
- `apps/desktop/electron/sync.test.ts` and `drafts/mirror.test.ts` use real SQLite, real Gmail JSON
  and real multipart bodies; `mirror.test.ts:249` decodes the outbox raw MIME and matches the
  `Subject:` header, asserting the wire format rather than a mock.
- `apps/desktop/electron/scheduler.test.ts:47` proves two workers racing the same due send dispatch
  it exactly once.
- `apps/desktop/electron/classify/golden.json` is a hand-labelled corpus of 18 attention threads and
  44 rule messages, with meta-assertions at `attention.test.ts:294` that the set stays at least 15
  cases and covers all three bands. That is proper golden-set discipline.
- `packages/ai-core/test/fixtures/fake-claude.sh` is a real subprocess emitting real `stream-json`,
  and line 17 asserts back on its **caller's** contract (that stdin was closed). A fixture that can
  fail is rare and valuable.
- No tautologies were found. Every one of the 82 sampled call-count assertions encodes a real
  behavioural claim.

### 3.11 Wall-clock sleeps and shared mutable state

**Severity: medium.**

The codebase injects `now` into `GmailClient`, `Scheduler`, `CalendarSync` and `AiService`, and
`packages/store/src/day-boundary.ts` is pure over timestamps with fixed local-time fixtures, so
timezone risk is low. What remains is 16 real sleeps, several with sub-100 ms margins, run by
`node --test` in parallel across files:

- `apps/desktop/src/state/store.test.ts:424` sleeps `AUTOSAVE_MS - 600` twice and asserts nothing has
  saved yet, a 600 ms margin against a 2,000 ms debounce. This test alone took 7,712 ms in the run
  above.
- `apps/desktop/electron/drafts/mirror.test.ts:258` sleeps 15 ms against `quietMs: 30` and asserts
  "still typing". One scheduler hiccup produces a confusing false failure.
- `apps/desktop/electron/classify/pipeline.test.ts` lines 115, 119, 149, 190; `scheduler.test.ts:52`;
  `sync.test.ts:108`; four more in `store.test.ts`.

Separately, `store.test.ts` shares module-level mutable state across all 22 tests (`calls[]` line 6,
`draftRows` line 9, `threadViews` line 8, `settingsRow` line 95) plus the zustand singleton, and
several tests assert on deltas (`savesBefore`, line 419) that only work top to bottom. Running a
subset with `--test-name-pattern` gives different results.

Hygiene: 24 test files call `fs.mkdtempSync`, **2** clean up, and **1** calls `db.close()`. Every
full run leaks temp directories with WAL and SHM sidecars.

**Fix (medium):** inject the autosave and mirror timers the way `Scheduler` already injects `now`, or
use `node:test` mock timers. Add a shared `tempDb()` helper with an `after()` hook. Add a
`beforeEach` in `store.test.ts` that resets every module-level fixture.

---

## 4. Errors and observability

### 4.1 There is no way to diagnose a bug a user reports

**Severity: critical.**

This is the single most consequential gap for the stated goal of other people installing the app.

`apps/desktop/electron/log.ts` is 11 lines. It writes to `console.log` and `console.error`. There is
no file sink, no rotation, no level, no redaction. A grep of `main.ts` and `log.ts` for
`createWriteStream`, `appendFile` or `getPath("logs")` returns nothing. In a packaged `.app`
launched from Finder, main-process stdout does not reach anywhere the user can find. **There is no
artifact to ask a user for.**

`logError` discards the stack trace:

```ts
// apps/desktop/electron/log.ts:7
export function logError(scope: string, message: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`${stamp} [${scope}] ${message}: ${detail}`);
}
```

So even in development, an error cannot be traced to a line. (This is deliberate in part, and it
does buy something: it keeps Gaxios response bodies out of the log, which is why the SECURITY.md
claim that tokens never reach a log holds. The two goals are reconcilable by redacting rather than
truncating.)

There is no `process.on("uncaughtException")` or `process.on("unhandledRejection")` anywhere in the
Electron main process; the only `process.on` in the repository is
`packages/ai-daemon/src/server.mjs:106` for SIGTERM and SIGINT. An unhandled rejection in the sync
loop or a scheduler tick terminates the main process and the app vanishes with no trace.

There is no React error boundary: a grep for `componentDidCatch`, `ErrorBoundary`, `window.onerror`
and `addEventListener("error"` across `apps/desktop/src` returns nothing. A render throw blanks the
window.

`ipcMain.handle("app:info", ...)` at `apps/desktop/electron/ipc/scheduler.ts:11` already returns
version and platform, which is exactly the raw material a "copy diagnostics" affordance would need,
and no such affordance exists.

The absence of telemetry is a good decision and is not the problem. The problem is that no-telemetry
was implemented as no-diagnostics.

**Fix (medium):** write the existing `log`/`logError` output to a rotating file under
`app.getPath("logs")`, keep the last few megabytes, include the stack in `logError` with a redaction
pass over known credential shapes, add `uncaughtException` and `unhandledRejection` handlers that log
and show a dialog, add a React error boundary, and add a "Reveal log in Finder" item to the Help
menu. None of that sends anything anywhere.

### 4.2 Logging is thin relative to what runs in the background

**Severity: medium.**

55 `log()` calls and 27 `logError()` calls across roughly 20 subsystems, against **209 catch sites**
in non-test code. The scope convention is good and consistent (`[sync]`, `[classify]`, `[scheduler]`,
`[drafts]`) and would grep well if it were persisted. But the ratio means the large majority of
failures produce nothing at all. The busiest subsystems by log volume are `classify` (9 lines),
`sync` (6) and `onboarding` (6), which is not enough to reconstruct what a background sync did.

**Fix (small):** log at the boundaries of each background pass (start, counts, outcome) rather than
only at exceptional points.

### 4.3 Swallowed errors are few and mostly deliberate

**Severity: low. Partly a strength.**

Only **8 fully empty catch blocks** exist, all in `packages/ai-core` and `packages/ai-daemon` and all
around `JSON.parse` or `child.kill`, where swallowing is correct:
`packages/ai-core/src/service.mjs:60`, `local.mjs:80` and `:98`, `claude.mjs:115`, `:233` and `:242`,
`packages/ai-daemon/test/live.integration.test.mjs:8` and `:11`.

Most silent catches elsewhere carry a comment explaining the decision, which is genuinely good
practice: `apps/desktop/electron/user-art.ts:28` ("Try the next extension"),
`apps/desktop/electron/accounts.ts:77` ("Older rows without send_as_json fall back to the primary
address"), `apps/desktop/electron/contacts.ts:40`, `packages/store/src/queries/threads.ts:82` ("A bad
cursor restarts from the top rather than failing the list").

The one that matters is `apps/desktop/electron/tokens.ts:52`, where a token read failure returns
`null` with no log. A corrupt or Keychain-inaccessible token store is then indistinguishable from
"signed out", and the user is told to sign in again rather than told what went wrong.

**Fix (small):** log the reason before returning null in `tokens.ts`.

### 4.4 Error types are consistent inside packages and absent across the boundary

**Severity: low.**

`packages/gmail/src/errors.ts` defines four well-named errors (`GmailApiError`, `AuthExpiredError`,
`HistoryExpiredError`, `OAuthConfigError`), plus `AttachmentError` and `AiError`. `sync.ts:172`
branches on `err instanceof AuthExpiredError` to set `auth_state` correctly. That is good design.

Across the IPC boundary the taxonomy vanishes. A thrown error becomes a string on the renderer side,
and the renderer's handling is uniform: `get().showToast({ eyebrow: "...", text: (err as
Error).message })`. This is applied consistently (there are no silent UI failures found), but it
means the renderer cannot distinguish "you are signed out, re-authenticate" from "the network is
down, retry" and offer the right affordance.

**Fix (medium):** serialise a `{ code, message }` shape over IPC and branch on `code` in the store.
The `AiFailure` union in `shared/types.ts:347` already does exactly this for the AI features and is
the model to copy.

---

## 5. Security

`docs/STANDARDS.md` (763 lines, written 2026-09-03) already covers this area to a high standard. It
correctly identifies Electron 41 reaching end of life on 2026-08-25 as the highest-value change, the
static CSP nonce, dev-origin sources shipping in the production meta tag, the missing fuses, the
missing IPC sender check, the regex weakness in `scrubCss`, and `allow-popups` no longer earning its
place. Those are not repeated here. What follows is what independent verification found that the
document does not cover, plus the state of enforcement.

### 5.1 A second, unsanitised HTML rendering path in the compose editor

**Severity: high. Not covered by `docs/STANDARDS.md`.**

`docs/STANDARDS.md:206` analyses the reading pane and concludes, correctly, that it "stands well".
There is a second path.

```tsx
// apps/desktop/src/components/ComposeEditor.tsx:113
<div className="compose-quote-body" dangerouslySetInnerHTML={{ __html: compose.quotedHtml }} />
```

This is the only place a stranger's mail HTML reaches the privileged app document rather than the
sandboxed iframe, and it has three distinct problems:

1. **Sanitise then store then render.** The value is sanitised once when the draft is built
   (`apps/desktop/src/state/store.ts:351`), written to SQLite as `quoted_html`, returned over IPC,
   and re-parsed into the DOM without re-sanitisation. That is the classic mutation-XSS shape: a
   string that is inert to one parse can differ after a round trip and a second parse.
2. **A path that is never sanitised at all.** `packages/gmail/src/drafts.ts:139` (`importGmailDraft`)
   applies no sanitisation, and `apps/desktop/electron/drafts/mirror.ts:1` documents the inbound
   direction: a DRAFT-labelled message the app did not write is fetched and becomes a local draft.
   That HTML lands in `quoted_html` and reaches line 113 raw.
3. **A weaker config than the reading pane's**, covered next.

The sibling `bodyHtml` goes to Tiptap `setContent` at `ComposeEditor.tsx:66`, which is
schema-filtered and therefore safe. It is only the quote block that is exposed.

**Fix (small):** sanitise at render rather than at store. Reuse the reading pane's purify instance
with `PURIFY_CONFIG` and `hardenNode` immediately before injection, or render the quote inside the
same sandboxed iframe the reading pane uses.

### 5.2 The remote-image setting is bypassed on reply and forward

**Severity: medium. Contradicts a `SECURITY.md` claim.**

```ts
// apps/desktop/src/state/store.ts:351
DOMPurify.sanitize(html, { USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base"] })
```

`img` is absent from that list, and inline `style` values are not passed through `scrubCss`. The
quote block then renders in the main app document under `APP_CSP`, whose `img-src` is
`'self' data: https: http: cid:` (`apps/desktop/electron/main.ts:132`). So an `<img
src="https://tracker/pixel">` in a message fires the moment the user presses R or F, regardless of
the per-sender toggle, the `remoteImages` setting, or the reading pane's much tighter per-message CSP
at `apps/desktop/src/lib/mailhtml.ts:10`.

The correct pattern exists nine lines away in a sibling file:
`apps/desktop/src/components/Settings.tsx:43` sanitises the signature preview with `FORBID_TAGS:
["style", "script", "iframe", "img"]`. Same author, same technique, `img` included there and omitted
here.

**Fix (small):** add `img` to the `FORBID_TAGS` at `store.ts:351`, or apply `hardenNode` and
`scrubCss` on that path.

### 5.3 The secret scanner cannot match this application's own credentials

**Severity: medium.**

`node scripts/secret-scan.mjs` reports `secret-scan: clean (368 files)`, exit 0, and it runs in CI
(`.github/workflows/ci.yml:23`). Its patterns (`scripts/secret-scan.mjs:9`) catch Google client
secrets (`GOCSPX-`), Google access tokens (`ya29.`), OpenAI-shaped `sk-` keys, Slack tokens, AWS key
ids and PEM blocks.

Tested against the credential shapes this repository actually writes to disk:

```
MISSED  anthropic api key      (sk-ant-api03-…)
MISSED  claude oauth token     (sk-ant-oat01-…)
MISSED  github pat             (ghp_…)
MISSED  stripe live            (sk_live_…)
MISSED  daemon bearer hex      (token: "<48 hex>")
CAUGHT  openai style           (sk-<48 alnum>)
```

The `sk-[A-Za-z0-9]{32,}` pattern requires 32 or more *alphanumeric* characters immediately after
`sk-`, and `sk-ant-api03-…` breaks that run at the first hyphen. So the two credentials
`apps/desktop/electron/onboarding/environment.ts:108` writes are exactly the two the scanner cannot
detect. Also missed: the app's own `tokens.json` shape, the daemon bearer token, and anything in git
**history** rather than the working tree (it reads `git ls-files` only). `text.match()` returns only
the first hit, so multiple secrets in one file collapse to one report.

The comment at `scripts/secret-scan.mjs:3` explains that the patterns are deliberately narrow so a
false alarm on every base64 string does not train people to ignore it. That instinct is right. The
patterns are just missing the ones that matter here.

**Fix (small):** add `sk-ant-[A-Za-z0-9_-]{20,}`, `ghp_|gho_|ghs_|github_pat_`, `sk_live_`, and
`"token"\s*:\s*"[0-9a-f]{32,}"`; switch to `matchAll`; add gitleaks or trufflehog in CI for history.

### 5.4 The attachment preview window receives the full 89-channel bridge

**Severity: medium.**

```ts
// apps/desktop/electron/attachments/window.ts:111
preload: path.join(opts.electronDir, "preload.cjs"),
```

The preview window shares the main preload, so its renderer can invoke every channel in
`apps/desktop/electron/preload.cts:12`, including `compose:send`, `accounts:signOut` and
`threads:trash`, while legitimately needing only `attachments:detail`, `attachments:download` and
`attachments:saveAs`. This is the odd one out in an otherwise least-privilege design: the PDF
`WebContentsView` at `window.ts:143` deliberately gets **no** preload at all.

**Fix (small):** a second preload exposing three channels.

### 5.5 The daemon config holds the Anthropic credential in plaintext, and SECURITY.md implies otherwise

**Severity: medium.**

`SECURITY.md` says "**Tokens** are encrypted with Electron `safeStorage`, which uses the macOS
Keychain". That is true of Gmail refresh tokens only (`apps/desktop/electron/tokens.ts:38`, with a
`requireEncryption()` that correctly refuses to store when the Keychain is unavailable). The Claude
OAuth token, the Anthropic API key and the daemon bearer token are cleartext JSON at mode 0600
(`apps/desktop/electron/onboarding/environment.ts:108`, `packages/ai-daemon/src/config.mjs:50`), as
are the Google client secrets (`apps/desktop/electron/onboarding/clients.ts:55`). Mode 0600 stops
other local users; it does not stop anything running as this user, nor backups.

This is harder to fix than it looks, because the daemon config is read by three separate processes
(Electron main, the Node daemon, and the Swift app at `AI/AIClient.swift:38`), so it cannot simply
move into an Electron Keychain item.

**Fix (medium):** a shared Keychain service name all three can read, or amend `SECURITY.md` to say
plainly which credentials are encrypted and which are a 0600 file.

### 5.6 Other verified findings

- **OAuth has no PKCE.** `packages/gmail/src/oauth.ts:158` calls `generateAuthUrl` with
  `access_type`, `prompt`, `scope`, `login_hint`, `state` and `include_granted_scopes`, and no
  `code_challenge`. RFC 8252 requires PKCE for installed apps. Mitigated by an ephemeral
  `127.0.0.1` redirect on an already-bound socket and a 24-byte state checked at `:199`, so the
  residual risk is a local process racing for the code. **Severity: medium. Fix: small**
  (`generateCodeVerifierAsync` is available in the pinned `google-auth-library`).
- **Unescaped reflection in the OAuth failure page.** `packages/gmail/src/oauth.ts:140` interpolates
  `url.searchParams.get("error")` into HTML with no escaping, on a page with no CSP, in a branch that
  runs **before** the state check at `:187`. The origin is an ephemeral loopback port alive for at
  most 180 seconds and holds no state, so impact is small. **Severity: low. Fix: small.**
- **A developer's home directory ships in a public repo.**
  `packages/text-tools/Sources/ArcformaText/AI/ClaudeCLI.swift:7` reads
  `static let defaultBinary = "/Users/oliverkorzen/.local/bin/claude"`. Every other resolver in the
  codebase uses `os.homedir()` or `NSHomeDirectory()`. The default path is dead for every other user.
  **Severity: low. Fix: small.**
- **Untrusted display name reaches a tool-enabled Claude run.**
  `apps/desktop/electron/contacts.ts:149` interpolates the sender-chosen `From` display name into a
  prompt run with `allowedTools: ["WebSearch"]`. This is the only place in the app where untrusted
  text meets a Claude invocation with tools; everything else takes the `--disallowedTools "*"` branch
  at `packages/ai-core/src/claude.mjs:186`. Impact is bounded (only a name and a domain travel, and
  it is gated behind a two-way-thread threshold at `contacts.ts:144`). **Severity: medium. Fix:
  small** (allow-list the name to letters, digits, spaces and a few punctuation marks, and cap it).
- **`frame-src` permits `data:`** at `apps/desktop/electron/main.ts:135`. Nothing frames a `data:`
  URL; message bodies use `srcDoc`, which `frame-src` does not govern. The preview window's policy at
  `:153` is correctly narrower. **Severity: low. Fix: small.**
- **`packages/pixel-service` is announced to users but not integrated.** `SECURITY.md` now describes
  read receipts as a shipped feature, and `docs/adr/0003` records the reversal honestly. But no file
  under `apps/desktop` or `packages/{store,gmail}` references it: a grep for `pixel-service`,
  `readReceipt` or `read_receipt` finds only unrelated comments. Its Cloudflare adapter
  (`packages/pixel-service/src/cloudflare.mjs`) has no test, and its `typecheck` script is
  `node --check`, a syntax check only. **Severity: low. Fix: small** (say in `SECURITY.md` that the
  endpoint exists and the client is not wired yet, or wire it).

### 5.7 What is genuinely well done

Not faint praise. Several of these are better than the norm for this class of application.

- **Attachment path handling is exemplary.** `apps/desktop/electron/attachments/paths.ts:25` rebuilds
  every filename from a Unicode-property allow-list rather than blacklisting, handling bidi
  overrides, NFC recomposition, leading and trailing dots, and length-capping that preserves the
  extension. `resolveInRoot` (`:96`) is applied as a containment check before every read, write and
  unlink, including refusing the root itself. Files land at 0600 in 0700 directories via temp file
  then rename (`cache.ts:70`). There is deliberately **no "open with default app"**
  (`ipc/attachments.ts:13`), which is the most common way mail clients get people owned.
- **The renderer never names a file, a path, or a Gmail attachment id**, only `(accountId, messageId,
  key)`, each resolved against the store (`ipc/attachments.ts:48`, `attachments/service.ts:56`). An
  entire vulnerability class is structurally unreachable rather than merely filtered.
- **Attachment serving refuses to be helpful.** `attachments/kind.ts:36`: a part declared `text/html`
  stays `none` whatever its extension; extension is consulted only for `octet-stream`; everything not
  image or PDF is served `application/octet-stream` with `X-Content-Type-Options: nosniff`
  (`main.ts:217`). The PDF viewer gets its own `WebContentsView` with no preload at all.
- **`webPreferences` is fully correct** (`main.ts:239`): `contextIsolation`, `sandbox`,
  `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `webSecurity`,
  `allowRunningInsecureContent: false`, `webviewTag: false`, `navigateOnDragDrop: false`, identical
  on the preview window.
- **Navigation policy is applied at `web-contents-created`** (`main.ts:68`), not per window, so it
  covers every frame the app will ever create, and it covers `will-navigate`, `will-frame-navigate`,
  `will-redirect`, `setWindowOpenHandler` and `will-attach-webview`, which is the complete set.
- **The preload is a true allow-list** enumerating all channels and rejecting unknown ones
  (`preload.cts:91`), with `preload.test.ts` keeping it in step with `shared/types.ts`.
- **SQL is properly parameterised throughout.** Every interpolated fragment checked
  (`queries/search.ts:98`, `searchQuery.ts:257`, `drafts.ts:84`) interpolates only code constants or
  generated `?` placeholders. FTS5 terms are quoted after stripping `"` (`searchQuery.ts:205`), so
  operator injection into `MATCH` is blocked.
- **The daemon's authentication is right**: `127.0.0.1` bind (`server.mjs:97`), 24 random bytes per
  install (`config.mjs:13`), constant-time comparison with a length pre-check (`server.mjs:80`), and
  a 2 MB body cap enforced during streaming with `req.destroy()` (`:88`).
- **Every subprocess uses argv-array form, and `shell: true` appears nowhere in the repository**,
  Node and Swift alike. No user or email content is ever interpolated into a command string. Claude
  child processes get a minimal constructed environment (`claude.mjs:24`) with a stated reason.
- **The Swift Accessibility app is conservative.** Terminals and password managers are refused with a
  stated reason (`HostPolicy.swift:22`), `AXSecureTextField` is never read (`AXSelection.swift:62`),
  selected text is read passively and **never transmitted** until the user presses the shortcut
  (`AppDelegate.swift:142`), and logs record character counts, never content (`Action.swift:110`).
- **Unsubscribe URL handling is closed**: `shell.openExternal` can only receive an `http(s)` URL,
  because `parseListUnsubscribe` (`packages/gmail/src/unsubscribe.ts:81`) only populates `url` on an
  `^https?://` match and `postOneClick` re-checks (`:99`).
- **The code comments are honest about threat models.** `attachments/paths.ts:5` names the exact
  hostile filenames it exists to defeat. Those claims held up under checking.

### 5.8 Enforcement is the real gap

**Severity: high.**

`docs/STANDARDS.md` is a plan, not a control. Nothing in CI enforces any of it. Every finding it
names was still present at `dfb6885`: `nonce-arcmail` at `main.ts:130`, `:148`,
`apps/desktop/index.html:7` and `apps/desktop/vite.config.ts:14`; `hardenedRuntime: false` at
`electron-builder.json:33`; no `@electron/fuses` anywhere in the repository; `electron: ^41.10.7`
with 41 end-of-life since 2026-08-25. `apps/desktop/electron/ipc-sender.ts` exists and is unwired.
The document's value depends entirely on someone acting on it, and a document that is not wired to a
check decays into a record of what was once true.

**Fix (small, then medium):** convert each "Do it" verdict into a checked item. The cheap ones are
CI-enforceable today: an `@electron/fuses` call in `afterPack.cjs`, a grep test that no file under
`ipc/` calls `ipcMain.handle` directly, and a test asserting the CSP constant contains no `nonce-`
and no `localhost`.

---

## 6. Performance

All measurements below come from a synthetic database built from the real migrated schema by
`openStore(":memory:")`, seeded with 2 accounts, 60,000 threads, 60,000 messages, classifications and
labels, then `ANALYZE`d. No real mailbox data was read, and no message body or address from the live
store appears anywhere in this report. A real five-year mailbox is typically 2 to 5 times larger than
this fixture with 3 to 5 messages per thread, so treat these numbers as a floor.

### 6.1 Half the sidebar views scan the whole threads table

**Severity: critical. One index fixes it.**

`listThreads` timings, first page of 50:

```
listThreads view=inbox        0.32 ms
listThreads view=archive      0.32 ms
listThreads view=needsyou     0.32 ms
listThreads view=unread       0.76 ms
listThreads view=starred      1.08 ms
listThreads view=attachments  1.17 ms
listThreads view=trash       22.43 ms
listThreads view=spam        24.27 ms
listThreads view=snoozed     35.45 ms
listThreads view=daily       66.25 ms
listThreads view=all         68.09 ms
```

`EXPLAIN QUERY PLAN` for `view=all`:

```
SCAN t USING INDEX sqlite_autoindex_threads_1
...
USE TEMP B-TREE FOR ORDER BY
```

The cause is that `packages/store/src/schema.sql:44` provides
`threads_sort ON threads(account_id, sort_at DESC)` and `:45` provides
`threads_inbox ON threads(in_inbox, sort_at DESC)`, and `listThreads`
(`packages/store/src/queries/threads.ts:152`) orders by
`t.sort_at DESC, t.account_id, t.id` **globally across accounts**. `threads_inbox` happens to serve
the views that filter on `in_inbox`, which is why those are fast. Every view that does not
(`all`, `daily`, `weekly`, `later`, `snoozed`, `spam`, `trash`) has no usable index for the ordering
and falls back to a full scan plus a temp B-tree sort.

The keyset cursor buys nothing, because the sort is not index-served: 20 sequential pages of
`view=all` cost **961 ms** in total, and page 21 still costs **45.63 ms**.

Adding one index and re-measuring on the same fixture:

```sql
CREATE INDEX threads_sort_global ON threads(sort_at DESC, account_id, id);
```

```
view=all    BEFORE 67.12 ms  ->  AFTER 0.29 ms   (231x)
view=daily  BEFORE 65.88 ms  ->  AFTER 2.39 ms   (28x)
```

Note that `packages/store/src/store.test.ts:217` asserts a query plan against a hand-written copy of
the *inbox* query, which is one of the fast ones, so this regression is invisible to the suite (see
3.9).

**Fix (small):** add the index as migration 14 and extend the plan test to cover `all`, `daily` and
`snoozed` using the SQL that `listThreads` actually builds.

### 6.2 The sidebar count refresh is a full table scan run on eleven different user actions

**Severity: critical.**

```
sidebarCounts() all accounts   139.9 ms
sidebarCounts(['a1'])           78.7 ms
queueCounts()                   42.1 ms
```

`packages/store/src/queries/sidebar.ts:109` runs
`SELECT SUM(CASE WHEN ...) ... FROM threads t WHERE 1 = 1`, an unconditional full scan of `threads`
with five `CASE` expressions each containing one to three correlated `EXISTS` subqueries against
`thread_labels` and `snoozes`. That is roughly ten index probes per thread over every thread in the
mailbox. Line 137 then runs a full FTS `savedSearchCount` **per saved search** inside the same call,
and line 154 adds `needsYouCount`.

`refreshCounts()` is invoked from **eleven** distinct places in
`apps/desktop/src/state/store.ts` (lines 662, 688, 747, 817, 878, 889, 901, 1047, 1632, plus the
definition at 753 and the initial load at 553): after archive, star, mark read, trash, snooze, queue
toggle, and on every `threads:changed` event from a sync tick.

**Fix (medium):** three parts. Give the count query a covering path (the same
`threads_sort_global` index plus a partial index on the junk labels helps materially). Debounce
`refreshCounts` in the renderer so a triage burst produces one refresh rather than ten. And move
saved-search counts out of the synchronous path entirely, since each is an FTS query whose cost
grows with the corpus, not with the sidebar.

### 6.3 The whole store is synchronous on the Electron main thread

**Severity: high.**

`apps/desktop/electron/main.ts:269` is `db = openStore(dbPath())`. `node:sqlite`'s `DatabaseSync` is,
as the name says, synchronous, and every `ipcMain.handle` calls into it directly. A grep for
`worker_threads`, `utilityProcess` and `new Worker` across `apps/desktop/electron` and `packages`
returns nothing.

So the 140 ms of 6.2 and the 68 ms of 6.1 are not background cost. They block the main process:
window dragging, menu opening, every other IPC handler, and the frame the renderer is waiting on.
Archive ten threads while triaging and the app is unresponsive for well over a second in aggregate.
This is the mechanism that turns the two query findings above from "slow query" into "the app feels
broken on a large mailbox".

**Fix (large):** move the store into a `utilityProcess` or a worker thread and make the IPC handlers
genuinely asynchronous. This is a significant change and should follow 6.1 and 6.2, which are cheap
and may make it unnecessary at realistic mailbox sizes.

### 6.4 The largest table, and full-text storage doubling

**Severity: medium.**

`messages_fts` (`packages/store/src/schema.sql:295`) is a plain FTS5 virtual table, not an
external-content or contentless one. Its `body` column is populated from the same text held in
`message_bodies.text`, so message text is stored twice: once as the row and once inside the FTS
index, plus the index structures themselves. On the synthetic fixture the FTS shadow tables are the
largest objects in the database by a wide margin.

For a mailbox of any age this roughly doubles the disk footprint of the largest data in the store.
`schema.sql:293` documents the reason for the current shape (updates are a delete plus insert by a
stable key, so a `VACUUM` cannot unhook the index), which is a legitimate trade, but it should be a
recorded decision rather than an accident.

**Fix (medium):** either move to `content=` external-content FTS with triggers, accepting the
`VACUUM` and rowid discipline that motivated the current design, or record the doubling as a
deliberate choice in an ADR and add a store-size line to the Settings screen so a user is not
surprised.

### 6.5 Bundle sizes and the resident model

**Severity: low to medium.**

Renderer, from `apps/desktop/dist/assets`:

```
index-DyyI67Gz.js   raw 655,858  gz 201,853
app-Ci7yXXCa.js     raw 198,353  gz  62,159
app-NVIlK1R8.css    raw  35,615  gz   6,723
preview-BOvcJ2td.js raw   4,016  gz   1,415
```

About 264 KB gzipped of JavaScript. For a local `app://` origin with no network latency this is
fine, and there is no code splitting or `manualChunks` in `apps/desktop/vite.config.ts`, which is a
reasonable choice at this size. The main-process bundle is 1.37 MB
(`apps/desktop/dist-electron/main.js`), and the shipped DMG is 111 MB, which is normal for Electron.

The local model is the real memory story. `packages/ai-daemon/src/config.mjs:23` and
`docs/onboarding.md:64` name Qwen3 4B Instruct at 4-bit, 2,497,281,120 bytes on disk, and
`packages/ai-core/src/local.mjs:14` sets `DEFAULT_CTX = 8192`. While `llama-server` is up, that model
plus its KV cache is resident, so the machine carries roughly 3 GB on top of Electron's own
footprint. The mitigating design is good and deliberate: `local.mjs:15` sets
`DEFAULT_IDLE_MS = 120 * 60 * 1000` and `:92` unloads the child after idle, with `unref()` on the
timer. Two hours is a long default for 3 GB on a laptop.

**Fix (small):** make the idle timeout a visible setting and default it lower, perhaps 15 minutes,
with the current 120 available for people who use the AI features constantly.

### 6.6 What is bounded, and correctly so

**Severity: none. This is a strength.**

The classification sweep is not O(n) on a hot path. `apps/desktop/electron/classify/pipeline.ts:122`
sets `SWEEP_BATCH = 200` and `:146` runs it on a 60-second interval with keyset pagination
(`:178`, `:242`). The scheduler ticks every 10 seconds (`scheduler.ts:43`). Both are the right shape:
bounded work per pass, resumable, and self-throttling. The store's pragmas
(`packages/store/src/db.ts:224`: WAL, `synchronous = NORMAL`, `foreign_keys = ON`,
`recursive_triggers = ON` with a comment explaining exactly why, `busy_timeout = 5000`) are correctly
chosen and individually justified.

The only genuinely unbounded sweeps are in migrations (`db.ts:309` and `:320` scan with `LIKE` over
the whole table), which run once and are acceptable, though they run with no progress indication and
would look like a hang on a large mailbox.

---

## 7. Build, release, and dependency hygiene

### 7.1 The lockfile discipline is correct and proven

**Severity: none. This is a strength.**

`pnpm-lock.yaml` is committed at lockfile version 9.0, clean in `git status`, and every `specifier:`
matches the manifests. CI runs `pnpm install --frozen-lockfile` and passed green on HEAD.
`pnpm-workspace.yaml:4` sets a tight postinstall allow-list (`electron: true`, `esbuild: true`,
`electron-winstaller: false`) with no `onlyBuiltDependencies` mixed in, and
`apps/desktop/electron-builder.json:19` additionally sets `npmRebuild: false` and
`nodeGypRebuild: false`, so packaging runs no scripts either. Only two dependencies may run install
scripts. That is better than most Electron repositories. `pnpm audit` reports
`No known vulnerabilities found`. `packages/text-tools/Package.swift` has zero third-party
dependencies.

### 7.2 The supply-chain cooldown is declared but switched off

**Severity: medium.**

`pnpm-workspace.yaml:8` declares a 31-entry `minimumReleaseAgeExclude` list (nodemailer 9.1.1 and 29
`@tiptap/*` at 3.31.0). There is no `minimumReleaseAge` key anywhere: not in `pnpm-workspace.yaml`,
not in any `.npmrc` (none exist), not in git history. `pnpm config get minimumReleaseAge` returns
`undefined`, and pnpm's default is 0, meaning disabled.

Someone hit the "package too new" gate while adding TipTap 3.31.0 and nodemailer 9.1.1, added the
exclude list, and the gate itself was never turned on. A reader of this file will reasonably believe
the repository has cooldown protection against a compromised-publish window. It does not, and that
window is exactly where npm account-takeover payloads live. It matters more than usual for an app
holding Gmail refresh tokens.

**Fix (small):** add `minimumReleaseAge: 1440`, which makes the exclude list meaningful, or delete
the exclude list as misleading.

### 7.3 Version pinning is deliberate in exactly one place

**Severity: medium for `dompurify`, low otherwise.**

Six exact pins (all `@tiptap/*` at 3.31.0, in `apps/desktop/package.json:27`), 20 caret ranges, no
tilde ranges. The TipTap block is a considered decision: 3.x ships its extension graph as about 30
co-versioned packages that break on mixed minors. Nothing else was decided; it floats by default.

With a committed lockfile and `--frozen-lockfile` in CI, floating ranges do not hurt reproducibility.
The exposure is that a `pnpm update` moves them with no review gate. The one that matters is
**`dompurify ^3.4.14`**: it is the single library standing between a malicious message and the
renderer, its minors have historically both fixed and introduced bypasses, and
`docs/STANDARDS.md:206` notes at least eleven advisories between 2026-06-15 and 2026-08-18.
`nodemailer ^9.1.1` (MIME construction on the send path) and `google-auth-library ^11.0.2` (the OAuth
flow) are the next two.

**Fix (small):** pin `dompurify` exactly with a one-line note saying why, and leave `electron` on
caret deliberately, saying so.

### 7.4 The Swift app is not in the workspace

**Severity: medium.**

`packages/text-tools/package.json` does not exist, so pnpm never enrols the directory
(`pnpm-workspace.yaml:1` globs `packages/*`, and pnpm requires a manifest). `pnpm -r build`,
`pnpm -r test` and `pnpm -r typecheck` all skip it, confirmed by the lockfile importers list. Only
`scripts/verify.sh:17` builds it, and CI does not run `verify.sh`. One of the three products the
README advertises has no automated build coverage at all.

The build itself is sound: `packages/text-tools/build.sh:15` runs `swift build -c release` and
hand-assembles the `.app`, and the certificate-versus-cdhash reasoning at `build.sh:3` (a pinned
designated requirement makes the Accessibility TCC grant survive rebuilds, where ad-hoc signing
revokes it every build) is genuinely well understood macOS engineering that most people rediscover
painfully. The built binary is correctly gitignored (`.gitignore:6`) and nothing built is committed
anywhere in the repository.

Gap: there is no `uninstall.sh` beside `packages/text-tools/install.sh`. A user who installs the
LaunchAgent has to know `launchctl bootout`, the plist path, the `/Applications` bundle, the log
path and the `defaults` domain to remove it.

**Fix (small):** a four-line `package.json` puts it back inside `pnpm -r`; the CI runner is already
`macos-latest`. Add `uninstall.sh`.

### 7.5 A release today is a file on one laptop

**Severity: high.**

`git tag -l` is empty. `gh release list` is empty. `.github/workflows/ci.yml` has no release or tag
trigger and no build or upload step. `apps/desktop/release/` is gitignored (`.gitignore:12`) and
holds a locally built `Arcforma Mail-0.1.0-arm64.dmg` (111 MB) that exists only on this machine.
There is no `publish` key in `electron-builder.json`. It is arm64 only
(`electron-builder.json:26`). Root, desktop and all packages are version `0.1.0`, so two different
builds are indistinguishable.

`apps/desktop/electron-builder.json:31` sets `"identity": "Arcforma Dev"`, `hardenedRuntime: false`,
`notarize: false`, `type: "development"`, and there is no entitlements file anywhere in the
repository. `CSC_IDENTITY_AUTO_DISCOVERY=false` in the `pack` script tells electron-builder not to
look in the keychain, and `apps/desktop/scripts/afterPack.cjs:34` signs by hand with the self-signed
identity instead, walking nested bundles inside-out (which is correct) and verifying with
`codesign --verify --deep --strict`.

For someone who downloads the DMG: the file carries `com.apple.quarantine`, Gatekeeper finds a
certificate chaining to nothing Apple trusts and no notarisation ticket, and refuses to launch it.
On macOS 15 and later that is not a right-click-Open bypass; it is a trip to System Settings per
launch attempt. The workaround you would have to document is "teach users to defeat Gatekeeper",
which is a worse security outcome than the signing gap itself.

The README is honest about this ("It is not packaged for other people yet") and `docs/ROADMAP.md:27`
lists Developer ID signing and notarisation. It is a known gap, not a blind spot, and it is the top
blocker.

**Fix (medium):** Developer ID certificate, `hardenedRuntime: true`, an entitlements plist (at
minimum `com.apple.security.cs.allow-jit` for V8), `notarize: true` with a notarytool key in CI
secrets, a tag-triggered workflow that builds and attaches the DMG to a GitHub Release, and drop the
`afterPack` hook once electron-builder can sign natively.

### 7.6 There is no update channel

**Severity: high.**

An exhaustive grep across `apps/`, `packages/`, `scripts/`, `.github/`, `docs/` and `README.md` for
`electron-updater`, `autoUpdater`, `checkForUpdate`, `feedURL`, `update-check` and `latest-mac.yml`
returns zero hits. `electron-updater` is in no manifest. `electron-builder.json` has no `publish`
block, so it does not even emit the feed file an updater would need. There is no in-app version
check.

Today the consequence is nil, because nothing ships. The moment 7.5 is solved, every copy that
reaches a stranger is frozen forever. A DOMPurify bypass fix, a Chromium CVE patch, or a
token-handling fix would require every user to notice a GitHub release unaided and re-download 111
MB. For an app that renders untrusted HTML and holds Gmail refresh tokens, an unpatchable installed
base is the worst of the three distribution gaps, and it is why they should be solved as one project
in the order signing, releases, updates.

**Fix (medium):** `electron-updater` with a GitHub Releases provider once notarisation exists. The
update must be signature-verified, which is another reason signing comes first.

### 7.7 CI has good bones and gates nothing

**Severity: medium.**

`.github/workflows/ci.yml` is 24 lines, triggers on push to `main` and every pull request, runs on
`macos-latest` with Node 24 and pnpm from `packageManager`, and executes `pnpm install
--frozen-lockfile`, `pnpm sync-brand` (soft-failing), `pnpm -r typecheck`, `pnpm -r test`,
`brand-check.mjs` and `secret-scan.mjs`.

What it does not run: **any build** (the `pre*` hooks build workspace dependencies, but
`pnpm --filter desktop build` and `pnpm pack` never run, so a packaging break is invisible), the
**smoke walk** that `CONTRIBUTING.md:17` says is mandatory, the **Swift build and self-test**, and
**`pnpm audit`** despite `docs/ROADMAP.md:13` listing it. There is no linter or formatter in the
repository at all.

`gh api repos/:owner/:repo/branches/main/protection` returns `404 Branch not protected`. Every commit
in `git log` is a direct push to `main`; there are no merge commits and no pull requests, so the
`pull_request` trigger has never fired and a red check blocks nothing. On a public repository, an
outside contributor's first PR will also be the first time that trigger runs.

CI has been green exactly once, on a commit pushed shortly before this audit began. The three actions
are pinned to floating major tags (`@v4`) rather than commit SHAs, and the green run carries a
deprecation annotation that all three target Node 20.

**Fix (small):** protect `main` and require the check; add build, smoke, Swift and `pnpm audit`; add
a top-level `permissions: contents: read`; pin actions by SHA.

---

## 8. Documentation and onboarding for a contributor

### 8.1 A competent stranger can find where to make a change

**Severity: none. This is a strength, and it is unusual.**

`docs/onboarding.md:30` and `packages/text-tools/README.md:124` are both proper path-to-role tables.
`docs/onboarding.md:42` records the *rules* behind the design ("the renderer spawns nothing", "the
secret goes one way", "a stopped download is not a lost download") with the reasoning intact, and
`:70` names the exact test file for every behaviour. `packages/ai-daemon/README.md` documents every
endpoint and the four-source auth precedence, and line 12 carries a dated field observation
explaining why the precedence is what it is. `CONTRIBUTING.md` is short and correct: five commands,
a pointer to the OAuth prerequisite, `scripts/verify.sh` as the one-command matrix, and seven house
rules that are product decisions rather than style preferences.

The hard-won macOS knowledge is written down adjacent to the code that needs it: the
certificate-versus-cdhash reasoning in `build.sh:3`, the `security find-identity -v` filtering trap
at `:47`, the `Bundle.module` trap in `Package.swift:6`, the inside-out nested-bundle signing order
in `afterPack.cjs:41`.

`docs/STANDARDS.md`, added 2026-09-03, is the strongest document in the repository: 763 lines of
cited, dated research on Electron security, release engineering and supply chain, with an explicit
three-way verdict scheme that includes "cargo cult here" for practices that buy this project nothing.
Writing down what is *not* worth doing is rarer and more useful than writing down what is.

### 8.2 README accuracy: eight claims checked, seven accurate

**Severity: low.**

| Claim | Verdict |
| --- | --- |
| `electron/classify/rules.ts`, `classify/attention.ts`, `navigation.ts`, `store/src/queries/attention.ts` exist | True |
| "A change to the rules bumps `RULES_VERSION` in `electron/classify/pipeline.ts`" | True: `pipeline.ts:111`, used at `:212` |
| "mail lives in a local SQLite database" | True: `packages/store/src/db.ts:6` |
| AGPL-3.0 root, MIT for ai-core, ai-daemon, text-tools | True: all four LICENSE files check out |
| "six-step setup flow" | True: `docs/onboarding.md:11` enumerates exactly six |
| The listed commands and scripts all exist | True |
| "Message HTML renders in a sandboxed iframe" | True of the reading pane; see finding 5.1 for the second path |
| "A thread that holds nothing but a draft is not a thread here **(schema 10)**" | **Stale as read**: `packages/store/src/db.ts:11` is `SCHEMA_VERSION = 13` |

The last one means "introduced at schema 10", which is true, but a stranger will read it as the
current schema version.

**Fix (small):** say "since schema 10".

### 8.3 The most valuable technical content is unfindable

**Severity: medium.**

`README.md:41` is a single unbroken paragraph of roughly 1,900 words running from compose through
drafts, Gmail draft mirroring, the send queue, snooze, the classification rules, the attention model
with its numeric thresholds, the six mail types, Daily 0 and Weekly 0 semantics, attachment handling
and the 0600 cache, and the history-poll retry policy. This is the densest and best technical
material in the repository and there is no way to scan it. A contributor wanting to change the
attention thresholds cannot find them. It also guarantees drift, because nobody edits a 1,900-word
paragraph surgically.

**Fix (medium):** split into `docs/architecture.md` with headed sections (Compose and drafts,
Classification and attention, Queues, Attachments, Sync) and leave a 200-word summary and a link in
the README. The material is good; it needs structure, not rewriting.

### 8.4 ADRs now exist, and the three most load-bearing decisions are not among them

**Severity: medium.**

`docs/adr/` was created at `dfb6885` and holds three records: 0001 (record architecture decisions),
0002 (mail and sorting stay on the machine), 0003 (read receipts reverse an earlier decision). 0003
is a model of the form: it names the reversal, names the documents that said the opposite, and
supersedes them explicitly. `qa/FINDINGS.md` has been doing the same job for brand conflicts with an
OPEN/NOTED/RESOLVED status key.

The decisions still unrecorded, in the order a contributor needs them:

1. **Why `node:sqlite` rather than `better-sqlite3`.** This is the load-bearing one. It is why the
   root `engines` field is `>=24`, why `electron-builder.json` can set `npmRebuild: false` and
   `nodeGypRebuild: false`, and why there is no native-module rebuild step anywhere in the pipeline.
   All three are downstream of it and none explains itself. A contributor who helpfully swaps in
   `better-sqlite3` for the richer API breaks packaging, signing and the Node floor at once.
2. **Why a local HTTP daemon rather than in-process.** The answer is inferable (two processes, an
   Electron app and a Swift menu-bar app, need the same model and the same Claude login, and a model
   held resident for two hours cannot live in a process the user quits) but never stated. It is also
   the decision carrying the most security surface, and `docs/ROADMAP.md:11` wants it moved to a unix
   socket, which is an unrecorded reversal waiting to happen.
3. **Why shell out to the `claude` CLI rather than call the API.** `packages/ai-daemon/README.md`
   documents the auth precedence in detail but never states the underlying reason: using the user's
   own Claude Code login means no Arcforma-held key and no per-request billing, which is the entire
   basis of the `SECURITY.md` claim that there is no Arcforma server in the path. The cost (a process
   spawn per request, clean-env requirements, PATH and HOME minimisation) is paid without the benefit
   being recorded.

Two more worth a paragraph each: the sync model (full versus incremental, watermarks, conflict
resolution, the offline queue) which `docs/ROADMAP.md:17` cannot specify a soak test without, and the
classification pipeline design (why rules first, why the model only speaks in the 30-to-40 band, why
corrections decay twice at most).

Several of these are already half-written as code comments (`Package.swift:6`, `afterPack.cjs:1`,
`build-electron.mjs:1`, `schema.sql:293`) and need lifting into `docs/adr/`.

**Fix (medium):** five short ADRs.

### 8.5 Smaller documentation gaps

**Severity: low.**

- `CONTRIBUTING.md:17` requires the smoke run on every change and CI does not run it (see 3.5 and
  7.7). A contributor reads the rule, believes it is enforced, and is contradicted by a green build.
- `README.md:23` invokes the smoke harness as `pnpm --filter desktop smoke [outDir] --onboarding`;
  `docs/onboarding.md:75` uses `-- <outDir>`. Both parse; pick one.
- `packages/gmail` and `packages/store` carry no `LICENSE` file while the other three packages do.
  They are AGPL by the root licence, but the asymmetry invites a reuser to assume they are
  unlicensed.
- `docs/` holds 14 date-stamped PNGs, about 5.9 MB, that no markdown file references. They are
  permanent git weight with no reader. Reference them from the architecture document 8.3 proposes,
  or move them out.
- `docs/ROADMAP.md:13` promises `pnpm audit` in CI and a pinned Electron; neither is done. The
  roadmap is dated 2026-09-02, so this is a fresh list rather than a rotted one.

---

## The ten things to do next, in order

1. **Add `threads_sort_global` as migration 14, and extend the query-plan test to the views that
   regress.** One line of SQL turns a 68 ms full scan into a 0.29 ms index seek on the busiest read
   path in the product, and the existing plan test asserts against a stale hand-copy so nothing would
   have caught it. Highest ratio of user-visible improvement to effort in this report.

2. **Sanitise `compose.quotedHtml` at render, and add `img` to the quote's `FORBID_TAGS`.** This is
   the one security finding that `docs/STANDARDS.md` does not cover, and it undoes two things the app
   otherwise does well: it puts a stranger's HTML in the privileged document rather than the iframe,
   and it fires tracking pixels the moment the user presses Reply, contradicting a published
   `SECURITY.md` claim. Two small edits in `apps/desktop/src/state/store.ts:351` and
   `apps/desktop/src/components/ComposeEditor.tsx:113`.

3. **Give the app a log file, stack traces, and crash handlers.** Right now a bug a user reports
   cannot be investigated at all, because there is no artifact to ask for. This is the prerequisite
   for anyone other than the author running the software, it costs a rotating file sink plus two
   `process.on` handlers plus a React error boundary, and it does not compromise the no-telemetry
   position in any way.

4. **Put build, smoke, the Swift self-test and `pnpm audit` into CI, and protect `main`.** The smoke
   walk is the only thing that crosses the renderer-to-IPC-to-store seam, `CONTRIBUTING.md` already
   claims it is mandatory, and it failed during this audit without anything noticing. Branch
   protection is what makes every other check matter, and the repository has never had a pull request
   run through it.

5. **Debounce `refreshCounts` and give the count query a covering path.** 140 ms of synchronous
   main-thread work on eleven different user actions is what will make the app feel broken on a real
   mailbox, and it compounds with finding 1 rather than being fixed by it.

6. **Run hostile HTML through the real DOMPurify in a test.** The 480-line `mailhtml.test.ts` asserts
   that a configuration array contains the string "script" and never invokes the sanitiser. Add
   `happy-dom` and one test per PortSwigger technique already enumerated in `docs/STANDARDS.md:206`.
   This is the product's core risk and its most convincing-looking piece of theatre.

7. **Upgrade Electron off the 41 line, and add fuses in `afterPack.cjs`.** `docs/STANDARDS.md:49`
   already argues this better than this report can, and calls it the single highest-value change:
   Electron 41 reached end of life on 2026-08-25, and an unpatched Chromium in an app that renders
   HTML written by strangers is the whole threat model in one line. Fuses belong in the same change
   because `afterPack.cjs` already walks and signs every nested bundle.

8. **Fix the secret scanner's patterns and turn on `minimumReleaseAge`.** Both are small, both are
   currently reporting protection that does not exist: the scanner cannot match the two Anthropic
   credential shapes the app itself writes to disk, and the 31-entry cooldown exclude list has no
   cooldown to exclude from.

9. **Deduplicate `parseAddressList`, `normalizeSubject`, `senderType`, `isAutoGenerated` and
   `domainOf`.** Two byte-identical copies of the address parser on the sync path and the write path
   is a silent-divergence bug waiting to happen, and each package tests only its own copy, so nothing
   would report it.

10. **Validate IPC payloads, and wire up the sender guard that is already written.** 53 of 76
    handlers trust a TypeScript annotation that does not exist at runtime, including `compose:send`,
    which takes an entire unvalidated draft and builds MIME from it. `ipc/guard.ts` and
    `ipc-sender.ts` already contain the right patterns; they just are not applied everywhere.

Below the line, and worth doing but not yet: splitting the 121-field, 91-action Zustand store;
promoting sync, classify, drafts and scheduler into a `packages/mail-core`; moving the store off the
main thread; signing, notarisation and an update channel (as one project, once the app is otherwise
ready for strangers); and the five missing ADRs.

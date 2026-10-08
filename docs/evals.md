# Evals

Three suites measure the AI in Arcforma's tools, each against the engines it could run on: the local model and Claude.

```bash
node scripts/evals.mjs                                       # all three, default engines
node scripts/evals.mjs --suite mail --claude claude-haiku-5-5
node scripts/evals.mjs --model "$HOME/Library/Application Support/Arcforma/models/qwen3-8b-q4_k_m.gguf"
```

Every run writes a dated summary to `~/Library/Application Support/Arcforma/evals/history/`, so a change is judged against the last run. Each suite also runs alone:

| Suite | Runner | Data | Scored by |
|---|---|---|---|
| Cmd+J | `packages/ai-core/eval/text-fix/run.mjs` | 36 selections in `cases.json` | plain checks: words that must and must not appear, line breaks, no dashes, length |
| Mail AI | `apps/desktop/eval/mail/run.ts` (`node --import tsx`) | 30 synthetic threads and 12 Ask questions in `threads.json`; the 44 labelled messages in `electron/classify/golden.json` | plain checks, plus Opus 5.5 grading drafts (faithful, in the owner's voice, answers what was asked) and summaries (accurate, current, says what to do) |
| Dictation | `packages/ai-core/eval/dictation/run.mjs` | the person's own OpenWhispr recordings; references kept private in `~/Library/Application Support/Arcforma/evals/dictation/references.json` | word error rate, named terms spelled right, filler words left, speed |

The Mail suite runs the app's own code: `electron/ai/features.ts`, the real AI client, the classify pipeline, and a daemon started in the process, against a store seeded with the smoke run's seeder. Each engine gets a fresh store, because summaries and instant replies are cached. Sorting is scored through the whole pipeline (rules, local model, attention), not the model's raw answer, because the attention score decides the split.

Dictation needs references first: `run.mjs --draft` transcribes every clip with Parakeet and Whisper and writes `references.draft.json`; a person corrects it into `references.json`.

A Claude result is only meaningful because calls are isolated (`claudeArgs` and `ISOLATION_ENV` in `packages/ai-core/src/claude.mjs`). Pass full model ids: what an alias means depends on the CLI version. On Claude Code 2.1.257 `sonnet` meant Sonnet 5 and `haiku` Haiku 4.5; on 2.1.294 they mean Sonnet 5.5 and Haiku 5.5. The grader is Opus 5.5, which needs 2.1.280 or newer; the 2026-10-08 numbers below were graded by Opus 5.

## Results, 2026-10-08

### Cmd+J (36 cases)

| Engine | Pass | p50 |
|---|---|---|
| daemon route, Qwen3 4B then Haiku 5.5 | 34 | 277 ms |
| Qwen3 4B alone | 33 | 270 ms |
| Qwen3 8B alone | 34 | 459 ms |
| Haiku 5.5 | 36 | 1.1 s |
| Sonnet 5.5 | 36 | 2.7 s |

### Mail AI

| Feature | Sonnet 5.5 | Sonnet 5 (old default) | Haiku 5.5 | Qwen3 4B | Qwen3 8B |
|---|---|---|---|---|---|
| Summary (30) | 24 | 24 | 28 | 9 | 8 |
| Draft (30) | 28 | 22 | 25 | 11 | 13 |
| Instant replies (28) | 27 | 27 | 26 | 24 | 23 |
| Ask (12) | 12 | 11 | 12 | 9 | 9 |
| Sorting, full pipeline (44) | | | | 36 | 36 |
| Median, draft | 5.1 s | 3.4 s | 4.0 s | 0.9 s | 1.5 s |

Before this work Ask answered 0 of 12: it searched for every word of the question at once. The local models invent deadlines, treat proposals as confirmed, and repeat claims planted in a thread; two prompt rounds and a model twice the size did not change that, so Mail's writing stays on Claude (Sonnet 5.5) and the local model keeps Cmd+J, sorting and instant replies. The eight sorting misses are the attention model's: client mail sent through a list tool reads as bulk, and a message with no explicit ask reads as nothing waiting.

### Dictation (14 clips, 223 s; references not yet confirmed)

| | Word error | Names right | Speed |
|---|---|---|---|
| Parakeet (in use) | 9.5% | 1 of 3 | 15x real time |
| Whisper large-v3-turbo | 4.5% (references lean on it) | 2 of 3 | 16x |

| Cleanup | Error vs clean text | Fillers left | p50 |
|---|---|---|---|
| none (today) | 10.1% | 6 of 14 | 0 |
| Qwen3 4B | 9.8% | 0 | 0.6 s |
| Qwen3 8B | 10.3% | 0 | 0.7 s |
| Haiku 5.5 | 7.8 to 10.1% | 0 | 1.0 s |

## Human grading

A blind grading page holds a sample of Mail outputs with the model name and the AI grader's verdict hidden until a grade is given, so a person and the grader can be compared. Agreement between the two says how far the grader can be trusted on its own.

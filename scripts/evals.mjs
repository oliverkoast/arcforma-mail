#!/usr/bin/env node
// Every AI eval in one command: Cmd+J, the Mail AI features, and dictation.
//
//   node scripts/evals.mjs                                    all three suites, default engines
//   node scripts/evals.mjs --suite textfix,mail               some of them
//   node scripts/evals.mjs --model ~/models/other.gguf        the local engines on another GGUF
//   node scripts/evals.mjs --claude claude-haiku-5-5,claude-sonnet-5-5   the Claude models to compare
//
// Each suite is its own runner (packages/ai-core/eval/text-fix, apps/desktop/eval/mail,
// packages/ai-core/eval/dictation) and stays runnable alone. This one runs them, keeps each
// suite's full JSON, and writes one dated summary to
// ~/Library/Application Support/Arcforma/evals/history/, so a change can be judged against the
// last run instead of against memory. Dictation needs the person's own references.json and is
// skipped with a note when it is missing.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY = path.join(os.homedir(), "Library", "Application Support", "Arcforma", "evals", "history");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const suites = arg("suite", "textfix,mail,dictation").split(",");
// Full ids: on Claude Code 2.1.257 the alias "sonnet" means Sonnet 5 and "haiku" means Haiku 4.5.
const claudeModels = arg("claude", "claude-haiku-5-5,claude-sonnet-5-5").split(",");
const model = arg("model", null);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(HISTORY, stamp);
fs.mkdirSync(runDir, { recursive: true });
const env = { ...process.env, ...(model ? { ARCFORMA_EVAL_MODEL: path.resolve(model.replace(/^~/, os.homedir())) } : {}) };

function run(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split("\n")) if (line && !/^\S+Z (POST|GET) \/v1/.test(line)) process.stdout.write(`  ${line}\n`);
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const summary = { at: new Date().toISOString(), model: env.ARCFORMA_EVAL_MODEL ?? "daemon config", suites: {} };
const pct = (rows) => `${rows.filter((r) => r.pass).length}/${rows.length}`;
const p50 = (rows) => {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  return ms.length ? ms[Math.floor(ms.length / 2)] : null;
};

if (suites.includes("textfix")) {
  console.log("\n# Cmd+J");
  const out = path.join(runDir, "textfix.json");
  const engines = ["daemon", "local:grammar_fix_local", ...claudeModels.map((m) => `claude:${m}:grammar_fix`)].join(",");
  await run(path.join(ROOT, "packages", "ai-core"), ["eval/text-fix/run.mjs", "--engines", engines, "--out", out]);
  if (fs.existsSync(out)) {
    const r = JSON.parse(fs.readFileSync(out, "utf8"));
    summary.suites.textfix = Object.fromEntries(Object.entries(r).map(([e, rows]) => [e, { pass: pct(rows), p50: p50(rows) }]));
  }
}

if (suites.includes("mail")) {
  console.log("\n# Mail AI");
  const out = path.join(runDir, "mail.json");
  await run(path.join(ROOT, "apps", "desktop"), ["--disable-warning=ExperimentalWarning", "--import", "tsx", "eval/mail/run.ts", "--engines", [...claudeModels, "local"].join(","), "--out", out]);
  if (fs.existsSync(out)) {
    const r = JSON.parse(fs.readFileSync(out, "utf8"));
    summary.suites.mail = Object.fromEntries(
      Object.entries(r).map(([e, rows]) => {
        const byFeature = {};
        for (const f of [...new Set(rows.map((x) => x.feature))]) {
          const fr = rows.filter((x) => x.feature === f);
          byFeature[f] = { pass: pct(fr), p50: p50(fr) };
        }
        return [e, byFeature];
      })
    );
  }
}

if (suites.includes("dictation")) {
  console.log("\n# Dictation");
  const refs = path.join(os.homedir(), "Library", "Application Support", "Arcforma", "evals", "dictation", "references.json");
  if (!fs.existsSync(refs)) {
    console.log("  skipped: no references.json yet (node packages/ai-core/eval/dictation/run.mjs --draft, then correct it)");
  } else {
    const out = path.join(runDir, "dictation.json");
    const cleanup = ["none", "local:default", ...claudeModels.map((m) => `claude:${m}:default`)].join(",");
    await run(path.join(ROOT, "packages", "ai-core"), ["eval/dictation/run.mjs", "--cleanup", cleanup, "--out", out]);
    if (fs.existsSync(out)) {
      const r = JSON.parse(fs.readFileSync(out, "utf8"));
      summary.suites.dictation = Object.fromEntries(Object.entries(r).map(([e, v]) => [e, { wer: +(v.wer * 100).toFixed(1), ...(v.terms ? { terms: v.terms } : {}), ...(v.flagged !== undefined ? { flagged: v.flagged } : {}) }]));
    }
  }
}

fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\n# Summary (${summary.model})\n${JSON.stringify(summary.suites, null, 2)}\n\nSaved in ${runDir}`);

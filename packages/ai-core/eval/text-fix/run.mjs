#!/usr/bin/env node
/**
 * Cmd+J eval: the same cases through each engine and prompt, scored by plain
 * checks, with latency. No judge model, so a score is a fact, not an opinion.
 *
 *   node eval/text-fix/run.mjs [--engines a,b,...] [--cases id,id] [--out file.json]
 *
 * An engine is one of
 *   local:<prompt>            the local GGUF on llama-server
 *   claude:<model>:<prompt>   the Claude Code CLI, isolated the way the daemon runs it
 *   daemon                    the whole text.fix route as the daemon runs it: local first, the
 *                             quality bars, Claude on its route model, the local rescue
 * and <prompt> is a library task (grammar_fix_local, grammar_fix) or a file in
 * eval/text-fix/prompts/ without its .md.
 *
 * The local model is the one the daemon config names, or ARCFORMA_EVAL_MODEL;
 * llama-server is ARCFORMA_EVAL_LLAMA, the bundled build, or openwhispr's. It
 * runs as its own process on its own port, so the daemon in use is not touched.
 * Claude runs on whatever login the CLI sees from this shell.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalModel } from "../../src/local.mjs";
import { ClaudeRunner } from "../../src/claude.mjs";
import { AiService } from "../../src/service.mjs";
import { loadPrompt, parsePrompt, render, voiceRules, extractMarked } from "../../src/prompts.mjs";
import { localMessages, tidyLocal, unwrapLocal } from "../../src/service.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "<<ARCFORMA_END>>";
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

const allCases = JSON.parse(fs.readFileSync(path.join(HERE, "cases.json"), "utf8"));
const only = arg("cases", "")?.split(",").filter(Boolean);
const cases = only?.length ? allCases.filter((c) => only.includes(c.id)) : allCases;
const engines = arg("engines", "local:grammar_fix_local").split(",");

function promptFile(name) {
  const file = path.join(HERE, "prompts", `${name}.md`);
  return fs.existsSync(file) ? parsePrompt(fs.readFileSync(file, "utf8")) : loadPrompt(name);
}
function prompt(name) {
  const { meta, body } = promptFile(name);
  return { meta, system: render(body, { voice: voiceRules(), marker: MARKER }) };
}

let local = null;
function localModel() {
  if (local) return local;
  const cfgFile = path.join(os.homedir(), "Library", "Application Support", "Arcforma", "ai-daemon.json");
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
  const model = process.env.ARCFORMA_EVAL_MODEL ?? cfg.local?.model;
  const binary = [process.env.ARCFORMA_EVAL_LLAMA, path.join(HERE, "..", "..", "..", "..", "apps", "desktop", "helpers", "llama", "llama-server"), cfg.local?.binary].find((p) => p && fs.existsSync(p));
  if (!model || !binary) throw new Error("no local model or llama-server for the eval");
  local = new LocalModel({ binary, model, ctx: 8192, threads: 4, idleMinutes: 5 });
  return local;
}

const claude = new ClaudeRunner({ env: { ...process.env }, concurrency: 3, timeoutMs: 90_000 });

let service = null;
function daemonService() {
  if (!service) {
    service = new AiService({ claude: { env: { ...process.env }, concurrency: 3 } });
    service.local = localModel();
  }
  return service;
}

async function runOne(engine, c) {
  const [kind, a, b] = engine.split(":");
  const user = JSON.stringify({ selectedText: c.input });
  const started = Date.now();
  if (kind === "daemon") {
    const r = await daemonService().complete({ task: "text.fix", system: `caller prompt ${MARKER}`, user, timeoutMs: 90_000 });
    const text = r.ok ? String(r.text).replace(MARKER, "") : "";
    return { text, ms: Date.now() - started, error: r.ok ? undefined : r.error, via: r.ok ? `${r.engine}${r.degraded ? " (rescue)" : ""}` : "failed" };
  }
  if (kind === "local") {
    const { meta, body } = promptFile(a);
    const msgs = localMessages(meta, body, c.input, user);
    const r = await localModel().complete({ ...msgs, maxTokens: Math.min(meta.maxTokens ?? 1200, Math.ceil(c.input.length / 2) + 200), temperature: 0, timeoutMs: 60_000 });
    // The text the daemon would paste: the same unwrap and tidy the local route applies.
    return { text: tidyLocal(unwrapLocal(r.text), c.input), ms: Date.now() - started, finish: r.finish };
  }
  const { system } = prompt(b);
  const r = await claude.complete({ system, user, model: a, timeoutMs: 90_000 });
  if (!r.ok) return { text: "", ms: Date.now() - started, error: r.error };
  let text = r.text;
  try {
    text = extractMarked(text, MARKER);
  } catch {
    return { text, ms: Date.now() - started, error: "no end marker" };
  }
  return { text, ms: Date.now() - started };
}

const lc = (s) => s.toLowerCase();
function score(c, out) {
  const fails = [];
  const t = out.text ?? "";
  if (out.error) fails.push(`error: ${out.error}`);
  if (!t.trim()) fails.push("empty");
  if (/[\u2014\u2013]/.test(t)) fails.push("dash");
  if (/^["\u201c]/.test(t.trim()) && !/^["\u201c]/.test(c.input.trim())) fails.push("wrapper");
  if (/^(corrected|edited|output)( text)?\s*:|^here (is|are) (the |your )?(corrected|edited|fixed|revised)/i.test(t.trim())) fails.push("wrapper");
  const ratio = t.length / Math.max(1, c.input.length);
  if (!c.unchanged && (ratio < 0.5 || ratio > 1.6)) fails.push(`length ${ratio.toFixed(2)}`);
  if (c.unchanged && t.trim() !== c.input.trim()) fails.push("changed clean text");
  if (c.keepLines && t.trim().split("\n").length !== c.input.trim().split("\n").length) fails.push("line breaks");
  for (const m of c.mustContain ?? []) if (!lc(t).includes(lc(m))) fails.push(`missing "${m}"`);
  for (const m of c.mustNotContain ?? []) if (lc(t).includes(lc(m))) fails.push(`has "${m}"`);
  // The daemon's own bar for a local answer; a reject there means Claude gets asked instead.
  const daemonReject = ratio < 0.6 || ratio > 1.6 || /[\u2014\u2013]/.test(t);
  return { pass: fails.length === 0, fails, daemonReject };
}

const results = {};
for (const engine of engines) {
  const rows = [];
  const jobs = cases.map((c) => async () => {
    const out = await runOne(engine, c).catch((e) => ({ text: "", ms: 0, error: String(e.message ?? e) }));
    rows.push({ id: c.id, kind: c.kind, input: c.input, output: out.text, ms: out.ms, via: out.via, ...score(c, out) });
  });
  // Local runs one at a time so latency is what one person sees; Claude runs three wide.
  const width = engine.startsWith("claude") ? 3 : 1;
  if (engine.startsWith("local") || engine === "daemon") await localModel().ensure();
  for (let i = 0; i < jobs.length; i += width) await Promise.all(jobs.slice(i, i + width).map((j) => j()));
  rows.sort((x, y) => cases.findIndex((c) => c.id === x.id) - cases.findIndex((c) => c.id === y.id));
  results[engine] = rows;
  const ms = rows.map((r) => r.ms).sort((p, q) => p - q);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  const passed = rows.filter((r) => r.pass).length;
  console.log(`\n${engine}: ${passed}/${rows.length} pass, p50 ${pct(0.5)} ms, p90 ${pct(0.9)} ms, daemon would reject ${rows.filter((r) => r.daemonReject).length}`);
  const byKind = {};
  for (const r of rows) (byKind[r.kind] ??= [0, 0])[r.pass ? 0 : 1]++;
  console.log("  " + Object.entries(byKind).map(([k, [p, f]]) => `${k} ${p}/${p + f}`).join(", "));
  if (engine === "daemon") {
    const via = {};
    for (const r of rows) via[r.via] = (via[r.via] ?? 0) + 1;
    console.log("  answered by " + Object.entries(via).map(([k, n]) => `${k} ${n}`).join(", "));
  }
  for (const r of rows.filter((x) => !x.pass)) console.log(`  FAIL ${r.id}: ${r.fails.join("; ")}\n       -> ${JSON.stringify(r.output).slice(0, 220)}`);
}
local?.stop();

const out = arg("out", null);
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(0);

// One command that says whether the tree is shippable. CONTRIBUTING lists the
// checks and CI runs them; this runs the same list locally, in the same order,
// and prints one table. The improvement loop in .claude/skills/improve calls it
// before every commit, so "it passed" is a thing that was measured rather than
// a thing that was remembered.
//
//   node scripts/gate.mjs                  everything that can run here
//   node scripts/gate.mjs --fast           typecheck, tests, brand, secrets
//   node scripts/gate.mjs --only=tests,speed
//   node scripts/gate.mjs --list
//
// A step that needs macOS is reported as skipped on other platforms rather than
// failed. A gate that lies green is worse than no gate, so the summary line
// always names what did not run.

import { spawn } from "node:child_process";
import process from "node:process";

const STEPS = [
  { name: "typecheck", why: "every package compiles", cmd: ["pnpm", "-r", "typecheck"], fast: true },
  { name: "tests", why: "the unit and integration suites", cmd: ["pnpm", "-r", "test"], fast: true },
  { name: "brand", why: "no hex outside the tokens, no shadows, no dark mode", cmd: ["node", "scripts/brand-check.mjs"], fast: true },
  { name: "secrets", why: "no credential shaped string in the tree", cmd: ["node", "scripts/secret-scan.mjs"], fast: true },
  { name: "speed", why: "the read budget at 60k threads", cmd: ["pnpm", "--filter", "@arcforma/store", "perf"] },
  { name: "build", why: "the renderer and main bundles", cmd: ["pnpm", "--filter", "desktop", "build"], mac: true },
  { name: "smoke", why: "the app launches and the walk finds no console error", cmd: ["pnpm", "--filter", "desktop", "smoke"], mac: true },
  { name: "audit", why: "known vulnerabilities in dependencies", cmd: ["pnpm", "audit", "--audit-level", "high"], soft: true },
];

const argv = process.argv.slice(2);
if (argv.includes("--list")) {
  for (const s of STEPS) process.stdout.write(`${s.name.padEnd(10)} ${s.why}\n`);
  process.exit(0);
}
const fast = argv.includes("--fast");
const only = argv.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",").map((s) => s.trim());
const isMac = process.platform === "darwin";

function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ code: 127, out: `${out}\n${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const chosen = STEPS.filter((s) => (only ? only.includes(s.name) : fast ? s.fast : true));
const results = [];

for (const step of chosen) {
  if (step.mac && !isMac) {
    results.push({ step, state: "skipped", note: "needs macOS", ms: 0 });
    process.stdout.write(`skip ${step.name}: needs macOS\n`);
    continue;
  }
  process.stdout.write(`run  ${step.name}: ${step.why}\n`);
  const started = Date.now();
  const { code, out } = await run(step.cmd);
  const ms = Date.now() - started;
  const ok = code === 0;
  results.push({ step, state: ok ? "passed" : step.soft ? "warned" : "failed", ms, out });
  if (!ok) {
    process.stdout.write(out.split("\n").slice(-40).join("\n"));
    process.stdout.write("\n");
  }
}

process.stdout.write("\n");
const width = Math.max(...results.map((r) => r.step.name.length));
for (const r of results) {
  const secs = r.ms ? `${(r.ms / 1000).toFixed(1)}s`.padStart(7) : "".padStart(7);
  process.stdout.write(`${r.state.padEnd(8)} ${r.step.name.padEnd(width)} ${secs}  ${r.step.why}\n`);
}

const failed = results.filter((r) => r.state === "failed");
const skipped = results.filter((r) => r.state === "skipped");
const warned = results.filter((r) => r.state === "warned");
process.stdout.write("\n");
if (failed.length) process.stdout.write(`gate failed: ${failed.map((r) => r.step.name).join(", ")}\n`);
else process.stdout.write("gate passed\n");
if (warned.length) process.stdout.write(`warnings, not blocking: ${warned.map((r) => r.step.name).join(", ")}\n`);
if (skipped.length) process.stdout.write(`did not run here: ${skipped.map((r) => `${r.step.name} (${r.note})`).join(", ")}\n`);
process.exitCode = failed.length ? 1 : 0;

// Production-path smoke: vite build, bundle main, launch Electron once in
// smoke mode against a throwaway user-data folder seeded from
// scripts/fixtures/threads.json, walk the inbox, an open thread, the snooze
// popover, compose, and Ask, saving one screenshot per step, print the
// renderer console, exit. Electron never outlives this script.
//
//   node scripts/smoke.mjs [outDir]     ARCMAIL_SMOKE_SKIP_BUILD=1 to reuse dist/

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), `arcmail-smoke-${Date.now()}`));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-smoke-data-"));
const fixture = process.env.ARCMAIL_FIXTURE || path.join(here, "fixtures", "threads.json");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out\n${out}`));
    }, opts.timeoutMs ?? 120_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${out}`));
    });
  });
}

if (!process.env.ARCMAIL_SMOKE_SKIP_BUILD) {
  await run("pnpm", ["exec", "vite", "build"]);
  await run(process.execPath, [path.join(here, "build-electron.mjs")]);
}
let out = "";
let exitError = null;
try {
  out = await run(electronBinary, ["."], {
    env: {
      ...process.env,
      ARCMAIL_SMOKE: outDir,
      ARCMAIL_FIXTURE: fixture,
      ARCMAIL_USER_DATA: userData,
      ARCMAIL_OAUTH_CLIENTS: process.env.ARCMAIL_OAUTH_CLIENTS || path.join(userData, "none.json"),
    },
    timeoutMs: 90_000,
  });
} catch (err) {
  exitError = err;
  out = String(err.message);
}
process.stdout.write(out);
fs.rmSync(userData, { recursive: true, force: true });
const errors = out.split("\n").filter((l) => /^SMOKE \[(error|2|3)\]/.test(l));
const shots = out.split("\n").filter((l) => /^SMOKE screenshot /.test(l)).length;
console.log(`smoke: ${shots} screenshot(s) in ${outDir}`);
console.log(`smoke: ${errors.length} console error line(s)`);
process.exit(errors.length || exitError || shots === 0 ? 1 : 0);

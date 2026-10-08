// Proves a packed Arcforma Mail brings Cmd+J with it, the way a Mac that has
// only the DMG would run it: no repository, no Node on PATH, no openwhispr.
//
//   node scripts/check-packed.mjs [path/to/Arcforma Mail.app]
//
// It checks the helpers are inside the bundle and signed, runs Arcforma
// Text's self-test from the bundle, then starts the bundled AI daemon on the
// app's own Electron binary (ELECTRON_RUN_AS_NODE) against a throwaway
// support folder and asks it for a real Cmd+J fix on the bundled
// llama-server. The model file is the one onboarding downloads; without it
// the fix step is skipped and says so. Touches nothing the installed app,
// the running daemon, or launchd use.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.argv[2] ?? path.join(here, "..", "release", "mac-arm64", "Arcforma Mail.app"));
const HELPERS = path.join(APP, "Contents", "Resources", "helpers");
const MODEL = process.env.ARCFORMA_CHECK_MODEL ?? path.join(os.homedir(), "Library", "Application Support", "Arcforma", "models", "qwen3-4b-instruct-q4_k_m.gguf");

let failed = 0;
const ok = (name, detail = "") => console.log(`ok    ${name}${detail ? `: ${detail}` : ""}`);
const fail = (name, detail = "") => {
  failed++;
  console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
};
const check = (name, cond, detail) => (cond ? ok(name, detail) : fail(name, detail));

if (!fs.existsSync(APP)) {
  console.error(`No app at ${APP}. Pack first: pnpm --filter desktop run pack`);
  process.exit(2);
}

// 1. What is in the bundle.
const manifestFile = path.join(HELPERS, "manifest.json");
check("helpers manifest", fs.existsSync(manifestFile), manifestFile);
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const textApp = path.join(HELPERS, "Arcforma Text.app");
const textBin = path.join(textApp, "Contents", "MacOS", "ArcformaText");
const daemon = path.join(HELPERS, "ai-daemon", "server.mjs");
const llama = path.join(HELPERS, "llama", "llama-server");
check("Arcforma Text.app in the bundle", fs.existsSync(textBin));
check("AI daemon in the bundle", fs.existsSync(daemon) && fs.existsSync(path.join(HELPERS, "ai-daemon", "prompts", "grammar_fix_local.md")));
check("llama-server in the bundle", fs.existsSync(llama) && (manifest.llama?.files ?? []).every((f) => fs.existsSync(path.join(HELPERS, "llama", f))));

// 2. Signatures. The outer seal covers every helper; each nested executable is signed too.
for (const [name, target] of [["app signature", APP], ["Arcforma Text signature", textApp], ["llama-server signature", llama]]) {
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", target], { stdio: "pipe" });
    ok(name);
  } catch (err) {
    fail(name, String(err.stderr ?? err.message).trim().slice(0, 300));
  }
}

// 3. Arcforma Text's own checks, run from inside the bundle.
try {
  const out = execFileSync(textBin, ["--selftest"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  check("Arcforma Text self-test", /all self-tests passed/i.test(out), out.trim().split("\n").at(-1));
} catch (err) {
  fail("Arcforma Text self-test", String(err.stdout ?? err.message).trim().split("\n").at(-1));
}

// 4. The daemon on the app's binary, with nothing from this machine's setup.
const support = fs.mkdtempSync(path.join(os.tmpdir(), "arcforma-packed-"));
const token = crypto.randomBytes(16).toString("hex");
const haveModel = fs.existsSync(MODEL);
fs.writeFileSync(
  path.join(support, "ai-daemon.json"),
  JSON.stringify({
    port: 0,
    token,
    // No Claude: the fix has to come from the bundled local model or not at all.
    claudeBin: path.join(support, "no-claude"),
    // A binary that is not there, so the daemon has to fall back to the bundled one, as it does on a Mac without openwhispr.
    local: { binary: path.join(support, "no-llama"), libDir: support, model: haveModel ? MODEL : path.join(support, "no-model.gguf"), ctx: 4096, idleMinutes: 1 },
  })
);
const exe = path.join(APP, "Contents", "MacOS", "Arcforma Mail");
const child = spawn(exe, [daemon], {
  cwd: path.dirname(daemon),
  env: { ELECTRON_RUN_AS_NODE: "1", HOME: os.homedir(), PATH: "/usr/bin:/bin", ARCFORMA_SUPPORT_DIR: support, ARCFORMA_LLAMA_DIR: path.dirname(llama) },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let daemonLog = "";
child.stdout.on("data", (c) => (daemonLog += c));
child.stderr.on("data", (c) => (daemonLog += c));

try {
  const port = await waitFor(() => {
    const cfg = JSON.parse(fs.readFileSync(path.join(support, "ai-daemon.json"), "utf8"));
    return cfg.port > 0 && /daemon up/.test(daemonLog) ? cfg.port : null;
  }, 20_000);
  check("daemon starts on the app's own binary with no node on PATH", Boolean(port), port ? `port ${port}` : daemonLog.slice(-300));
  if (port) {
    const health = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json();
    check("daemon health", health.ok === true, `claude ${health.claude}, local ${health.local}`);
    const stored = JSON.parse(fs.readFileSync(path.join(support, "ai-daemon.json"), "utf8"));
    check("daemon chose the bundled llama-server", stored.local.binary === llama, stored.local.binary);
    if (!haveModel) {
      console.log(`skip  Cmd+J fix on the local model: no model at ${MODEL} (onboarding downloads it)`);
    } else {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/v1/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ task: "text.fix", user: JSON.stringify({ selectedText: "i has went to the store yesterday and buyed three apple" }), timeoutMs: 90_000 }),
        signal: AbortSignal.timeout(120_000),
      });
      const r = await res.json();
      const text = String(r.text ?? "").replace("<<ARCFORMA_END>>", "");
      check("Cmd+J fix answered on the bundled local model", r.ok === true && r.engine === "local" && /bought/i.test(text), `${Date.now() - started} ms: ${r.ok ? text : r.error}`);
      const ps = execFileSync("/bin/ps", ["-axo", "command"], { encoding: "utf8" });
      check("the llama-server that answered is the bundled one", ps.split("\n").some((l) => l.startsWith(llama)));
    }
  }
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  fs.rmSync(support, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nPACKED APP CHECKS PASSED");
process.exit(failed ? 1 : 0);

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

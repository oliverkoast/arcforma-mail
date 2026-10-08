// Assembles apps/desktop/helpers/, which electron-builder copies into the
// packed app as Contents/Resources/helpers. A person who has only the DMG gets
// everything Cmd+J needs from there, with no repository and no Node install:
//
//   Arcforma Text.app   built by packages/text-tools/build.sh
//   ai-daemon/          packages/ai-daemon bundled into one file, plus the
//                       prompt library it reads at runtime. It runs on the
//                       mail app's own Electron binary (ELECTRON_RUN_AS_NODE).
//   llama/              llama-server and the dylibs it links, for the local
//                       model that answers Cmd+J
//   manifest.json       the daemon's content hash, so the app restarts an
//                       installed daemon running older code. Arcforma Text is
//                       compared byte for byte at launch instead, because
//                       packing re-signs it.
//
// The llama.cpp build is copied from ARCFORMA_LLAMA_DIR, else from an
// openwhispr checkout. A pack without it fails, because a build that cannot
// run the local model is not one to hand anybody. ARCFORMA_SKIP_LLAMA=1 skips
// it on purpose.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repo = path.resolve(root, "..", "..");
const out = path.join(root, "helpers");
const IDENTITY = process.env.ARCFORMA_SIGN_IDENTITY || "Arcforma Dev";

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. Arcforma Text.
const textDir = path.join(repo, "packages", "text-tools");
execFileSync("/bin/bash", [path.join(textDir, "build.sh")], { cwd: textDir, stdio: "inherit" });
const textApp = path.join(out, "Arcforma Text.app");
execFileSync("/usr/bin/ditto", [path.join(textDir, "build", "Arcforma Text.app"), textApp]);

// 2. The AI daemon, one file. prompts.mjs reads prompts/ beside its own module, which after
// bundling is server.mjs, so the library is copied next to it.
const daemonOut = path.join(out, "ai-daemon");
await build({
  entryPoints: [path.join(repo, "packages", "ai-daemon", "src", "server.mjs")],
  outfile: path.join(daemonOut, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
fs.cpSync(path.join(repo, "packages", "ai-core", "src", "prompts"), path.join(daemonOut, "prompts"), { recursive: true });
fs.writeFileSync(path.join(daemonOut, "package.json"), JSON.stringify({ type: "module" }) + "\n");

// 3. llama.cpp.
const llamaOut = path.join(out, "llama");
let llama = null;
if (process.env.ARCFORMA_SKIP_LLAMA === "1") {
  console.warn("build-helpers: ARCFORMA_SKIP_LLAMA=1, so this build has no local model runtime and Cmd+J needs Claude.");
} else {
  const source = llamaSource();
  if (!source) {
    throw new Error(
      "build-helpers: no llama-server found. Set ARCFORMA_LLAMA_DIR to a folder holding llama-server (or llama-server-darwin-arm64) and its dylibs, or ARCFORMA_SKIP_LLAMA=1 to pack without one."
    );
  }
  fs.mkdirSync(llamaOut, { recursive: true });
  const target = path.join(llamaOut, "llama-server");
  fs.copyFileSync(source.binary, target);
  fs.chmodSync(target, 0o755);
  const libs = rpathClosure(source.binary, source.dir);
  for (const lib of libs) {
    const dest = path.join(llamaOut, lib);
    fs.copyFileSync(path.join(source.dir, lib), dest);
    fs.chmodSync(dest, 0o755);
  }
  for (const file of [target, ...libs.map((l) => path.join(llamaOut, l))]) sign(file);
  fs.writeFileSync(
    path.join(llamaOut, "NOTICE.txt"),
    "llama-server and its libraries are llama.cpp by the ggml authors, MIT licensed: https://github.com/ggml-org/llama.cpp\n"
  );
  llama = { files: ["llama-server", ...libs] };
  console.log(`build-helpers: llama-server and ${libs.length} libraries from ${source.dir}`);
}

const manifest = {
  builtAt: new Date().toISOString(),
  daemon: { sha256: sha256Files(listFiles(daemonOut)) },
  llama,
};
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`build-helpers: ${path.relative(repo, out)} ready`);

function llamaSource() {
  const dirs = [process.env.ARCFORMA_LLAMA_DIR, path.join(os.homedir(), "Projects", "openwhispr", "resources", "bin")].filter(Boolean);
  for (const dir of dirs) {
    for (const name of ["llama-server", "llama-server-darwin-arm64"]) {
      const binary = path.join(dir, name);
      if (fs.existsSync(binary)) return { dir, binary };
    }
  }
  return null;
}

/** Every @rpath library the binary needs, followed through the libraries themselves. */
function rpathClosure(binary, dir) {
  const seen = new Set();
  const queue = [binary];
  while (queue.length) {
    const file = queue.shift();
    const lines = execFileSync("/usr/bin/otool", ["-L", file], { encoding: "utf8" }).split("\n").slice(1);
    for (const line of lines) {
      const m = /^\s*@rpath\/(\S+)/.exec(line);
      if (!m || seen.has(m[1])) continue;
      if (!fs.existsSync(path.join(dir, m[1]))) throw new Error(`build-helpers: ${path.basename(file)} needs ${m[1]}, which is not in ${dir}`);
      seen.add(m[1]);
      queue.push(path.join(dir, m[1]));
    }
  }
  return [...seen].sort();
}

function sign(file) {
  const listing = execFileSync("/usr/bin/security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
  const identity = listing.includes(`"${IDENTITY}"`) ? IDENTITY : "-";
  execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, "--timestamp=none", file], { stdio: "ignore" });
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

function sha256Files(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(out, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

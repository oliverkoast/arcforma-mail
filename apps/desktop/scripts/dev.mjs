// Waits for the Vite dev server, bundles the main process, and launches
// Electron against it. Used by `pnpm --filter desktop dev` under concurrently.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const url = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

async function waitForVite() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Vite did not answer at ${url} within 60 s`);
}

await waitForVite();
await new Promise((resolve, reject) => {
  const b = spawn(process.execPath, [path.join(here, "build-electron.mjs")], { stdio: "inherit" });
  b.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build-electron exited ${code}`))));
});

const child = spawn(electronBinary, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
const stop = () => {
  if (!child.killed) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));

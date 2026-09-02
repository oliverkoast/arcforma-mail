// Bundles the Electron main process (ESM) and the sandboxed preload (CJS)
// with esbuild, so packaging never depends on node_modules layout. The store
// reads schema.sql next to its entry, so the file is copied beside main.js.

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "dist-electron");
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, "electron", "main.ts")],
  outfile: path.join(out, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
  sourcemap: true,
  logLevel: "warning",
  banner: {
    js: 'import { createRequire as __arcmailCreateRequire } from "node:module"; const require = __arcmailCreateRequire(import.meta.url);',
  },
});

await build({
  entryPoints: [path.join(root, "electron", "preload.cts")],
  outfile: path.join(out, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  logLevel: "warning",
});

const schema = path.resolve(root, "..", "..", "packages", "store", "src", "schema.sql");
fs.copyFileSync(schema, path.join(out, "schema.sql"));
console.log("build-electron: dist-electron/main.js, preload.cjs, schema.sql");

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_CHANNELS } from "../shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = fs.readFileSync(path.join(here, "preload.cts"), "utf8");
const types = fs.readFileSync(path.join(here, "..", "shared", "types.ts"), "utf8");

function setLiteral(source: string, name: string): string[] {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`, "s").exec(source);
  assert.ok(m, `${name} not found in preload`);
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

test("the preload allows exactly the invoke channels the IPC contract declares", () => {
  const block = /export interface ArcmailInvoke \{([\s\S]*?)\n\}/.exec(types);
  assert.ok(block, "ArcmailInvoke interface not found");
  const declared = [...block![1]!.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]!).sort();
  const allowed = setLiteral(preload, "INVOKE_CHANNELS").sort();
  assert.deepEqual(allowed, declared);
  assert.deepEqual(setLiteral(preload, "EVENT_CHANNELS").sort(), [...EVENT_CHANNELS].sort());
});

test("the preload exposes only invoke, on, and platform, never ipcRenderer itself", () => {
  const exposed = /exposeInMainWorld\("arcmail",\s*\{([\s\S]*?)\n\}\);/.exec(preload);
  assert.ok(exposed, "exposeInMainWorld not found");
  const keys = [...exposed![1]!.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!).sort();
  assert.deepEqual(keys, ["invoke", "on", "platform"]);
  assert.equal(/ipcRenderer\s*[,}]/.test(exposed![1]!), false, "ipcRenderer is not handed to the renderer");
  assert.match(preload, /INVOKE_CHANNELS\.has\(channel\)/, "invoke checks the allowlist");
  assert.match(preload, /removeListener\(channel, listener\)/, "on returns an unsubscribe");
});

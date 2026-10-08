import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { agentOwner, daemonAction, daemonAgentPlist, helperLayout, textAgentPlist, textNeedsUpdate, type LayoutFs } from "./plan.js";

const RES = "/Applications/Arcforma Mail.app/Contents/Resources";
const MANIFEST = { builtAt: "2026-10-08T00:00:00Z", daemon: { sha256: "d1" }, llama: { files: ["llama-server"] } };

function fakeFs(files: Record<string, string>): LayoutFs {
  return { exists: (f) => f in files, read: (f) => files[f] ?? "" };
}

const full: Record<string, string> = {
  [`${RES}/helpers/manifest.json`]: JSON.stringify(MANIFEST),
  [`${RES}/helpers/Arcforma Text.app`]: "",
  [`${RES}/helpers/ai-daemon/server.mjs`]: "",
  [`${RES}/helpers/llama/llama-server`]: "",
};

test("a packed app's helpers are found, and a dev run or a half-packed build has none", () => {
  const layout = helperLayout(RES, fakeFs(full));
  assert.ok(layout);
  assert.equal(layout.daemonScript, `${RES}/helpers/ai-daemon/server.mjs`);
  assert.equal(layout.llamaDir, `${RES}/helpers/llama`);
  assert.equal(layout.manifest.daemon.sha256, "d1");

  assert.equal(helperLayout(RES, fakeFs({})), null, "a dev run has no helpers folder");
  const noText = { ...full };
  delete noText[`${RES}/helpers/Arcforma Text.app`];
  assert.equal(helperLayout(RES, fakeFs(noText)), null);
  assert.equal(helperLayout(RES, fakeFs({ ...full, [`${RES}/helpers/manifest.json`]: "not json" })), null);

  const noLlama = { ...full };
  delete noLlama[`${RES}/helpers/llama/llama-server`];
  assert.equal(helperLayout(RES, fakeFs(noLlama))?.llamaDir, null, "packed with ARCFORMA_SKIP_LLAMA=1");
});

test("the daemon agent runs the app's own binary as Node, with the bundled llama, and escapes paths", () => {
  const plist = daemonAgentPlist({ execPath: "/Applications/A & B.app/Contents/MacOS/Arcforma Mail", script: `${RES}/helpers/ai-daemon/server.mjs`, home: "/Users/x", llamaDir: `${RES}/helpers/llama` });
  assert.match(plist, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
  assert.match(plist, /<string>\/Applications\/A &amp; B\.app\/Contents\/MacOS\/Arcforma Mail<\/string>/);
  assert.match(plist, new RegExp(`<key>ARCFORMA_LLAMA_DIR</key><string>${RES}/helpers/llama</string>`));
  assert.match(plist, new RegExp(`<key>WorkingDirectory</key><string>${path.dirname(`${RES}/helpers/ai-daemon/server.mjs`)}</string>`));
  assert.match(plist, /<key>Label<\/key><string>ai\.arcforma\.ai-daemon<\/string>/);
  const bare = daemonAgentPlist({ execPath: "/x", script: "/y/server.mjs", home: "/Users/x", llamaDir: null });
  assert.doesNotMatch(bare, /ARCFORMA_LLAMA_DIR/);
});

test("the repository's daemon agent is never touched; the app's own is written, restarted, or kept", () => {
  const desired = daemonAgentPlist({ execPath: "/A/Arcforma Mail", script: "/A/server.mjs", home: "/Users/x", llamaDir: null });
  const repoAgent = "<plist><dict><key>ProgramArguments</key><array><string>/Users/x/.nvm/node</string><string>/Users/x/Projects/arcforma-mail/packages/ai-daemon/src/server.mjs</string></array></dict></plist>";
  assert.equal(agentOwner(repoAgent), "other");
  assert.equal(agentOwner(null), "missing");
  assert.equal(agentOwner(desired), "app");

  assert.equal(daemonAction(repoAgent, desired, null, "d1"), "leave");
  assert.equal(daemonAction(null, desired, null, "d1"), "write", "a fresh Mac");
  const moved = daemonAgentPlist({ execPath: "/B/Arcforma Mail", script: "/B/server.mjs", home: "/Users/x", llamaDir: null });
  assert.equal(daemonAction(moved, desired, "d1", "d1"), "write", "the app moved, so the agent points somewhere else");
  assert.equal(daemonAction(desired, desired, "d0", "d1"), "restart", "a new app version, same paths");
  assert.equal(daemonAction(desired, desired, null, "d1"), "restart");
  assert.equal(daemonAction(desired, desired, "d1", "d1"), "keep");
});

test("the text agent matches the one install.sh writes, and only an installed, different build is replaced", () => {
  const plist = textAgentPlist("/Users/x", "/Applications/Arcforma Text.app");
  assert.match(plist, /<string>\/Applications\/Arcforma Text\.app\/Contents\/MacOS\/ArcformaText<\/string>/);
  assert.match(plist, /<string>ai\.arcforma\.text<\/string>/);
  assert.equal(textNeedsUpdate(null, "t1"), false, "never installed: onboarding offers it, launch does not force it");
  assert.equal(textNeedsUpdate("t1", "t1"), false);
  assert.equal(textNeedsUpdate("t0", "t1"), true);
});

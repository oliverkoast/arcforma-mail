// Puts the helpers a packed app carries where macOS runs them: the AI daemon
// as a LaunchAgent on the app's own binary, and Arcforma Text in
// /Applications with its LaunchAgent. plan.ts decides; this does the writing,
// the copying, and the launchctl calls. Only a packed macOS app outside a
// smoke run gets here, so a dev or test process never registers itself.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { log, logError } from "../log.js";
import { TEXT_APP_PATH, supportDir } from "../onboarding/environment.js";
import { DAEMON_LABEL, TEXT_LABEL, daemonAction, daemonAgentPlist, helperLayout, textAgentPlist, textNeedsUpdate, type HelperLayout } from "./plan.js";

const run = promisify(execFile);

const realFs = {
  exists: (file: string) => fs.existsSync(file),
  read: (file: string) => fs.readFileSync(file, "utf8"),
};

export function bundledHelpers(resourcesPath = process.resourcesPath): HelperLayout | null {
  return helperLayout(resourcesPath, realFs);
}

function agentPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const STATE_FILE = () => path.join(supportDir(), "helpers-state.json");

function readState(): { daemonStarted?: string } {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as { daemonStarted?: string };
  } catch {
    return {};
  }
}

function writeState(state: { daemonStarted?: string }): void {
  fs.mkdirSync(supportDir(), { recursive: true });
  fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2) + "\n");
}

/** Loads a LaunchAgent from scratch: out if it was in, written, in, started. */
async function reload(label: string, plist: string): Promise<void> {
  const file = agentPath(label);
  await run("/bin/launchctl", ["bootout", `${domain()}/${label}`]).catch(() => undefined);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist);
  await run("/bin/launchctl", ["bootstrap", domain(), file]);
  await run("/bin/launchctl", ["kickstart", "-k", `${domain()}/${label}`]);
}

/** Writes, restarts, or leaves the daemon agent, as plan.ts says. Returns what it did. */
export async function ensureDaemon(layout: HelperLayout, execPath = process.execPath): Promise<string> {
  const desired = daemonAgentPlist({ execPath, script: layout.daemonScript, home: os.homedir(), llamaDir: layout.llamaDir });
  const action = daemonAction(readOrNull(agentPath(DAEMON_LABEL)), desired, readState().daemonStarted ?? null, layout.manifest.daemon.sha256);
  if (action === "write") await reload(DAEMON_LABEL, desired);
  else if (action === "restart") await run("/bin/launchctl", ["kickstart", "-k", `${domain()}/${DAEMON_LABEL}`]);
  // KeepAlive restarts a crash, not a clean exit, so a daemon that was stopped is started again here. A running one is left alone.
  else if (action === "keep") await run("/bin/launchctl", ["kickstart", `${domain()}/${DAEMON_LABEL}`]);
  if (action === "write" || action === "restart") writeState({ ...readState(), daemonStarted: layout.manifest.daemon.sha256 });
  return action;
}

/**
 * The executable's bytes. Both sides are hashed here at launch rather than at build time, because
 * packing re-signs the bundled copy and a signature lives inside the binary.
 */
function textHash(app: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(app, "Contents", "MacOS", "ArcformaText"))).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Copies the bundled Arcforma Text into /Applications and starts it through launchd, the same
 * steps packages/text-tools/install.sh takes after its build. The copy is signed with the same
 * identity as every earlier build, so an Accessibility grant already given still holds.
 */
export async function installText(layout: HelperLayout, say: (line: string) => void = () => undefined): Promise<void> {
  say("Stopping any running copy");
  await run("/bin/launchctl", ["bootout", `${domain()}/${TEXT_LABEL}`]).catch(() => undefined);
  await run("/usr/bin/pkill", ["-x", "ArcformaText"]).catch(() => undefined);
  say(`Copying Arcforma Text to ${TEXT_APP_PATH}`);
  const staging = `${TEXT_APP_PATH}.installing`;
  fs.rmSync(staging, { recursive: true, force: true });
  await run("/usr/bin/ditto", [layout.textApp, staging]);
  fs.rmSync(TEXT_APP_PATH, { recursive: true, force: true });
  fs.renameSync(staging, TEXT_APP_PATH);
  say("Starting it through launchd");
  await reload(TEXT_LABEL, textAgentPlist(os.homedir(), TEXT_APP_PATH));
  say(`Installed ${TEXT_APP_PATH}. Log: ~/Library/Logs/arcforma-text.log`);
}

/** At launch: the daemon running, and an installed Arcforma Text no older than the one this app carries. */
export async function ensureHelpers(): Promise<void> {
  const layout = bundledHelpers();
  if (!layout) {
    log("helpers", "this build carries no helpers; the AI daemon and Arcforma Text come from the repository");
    return;
  }
  try {
    const action = await ensureDaemon(layout);
    log("helpers", action === "leave" ? "AI daemon agent was installed from elsewhere; left as it is" : `AI daemon agent: ${action}`);
  } catch (err) {
    logError("helpers", "AI daemon agent", err);
  }
  const bundled = textHash(layout.textApp);
  if (bundled && textNeedsUpdate(textHash(TEXT_APP_PATH), bundled)) {
    try {
      await installText(layout);
      log("helpers", "Arcforma Text updated to the build this app carries");
    } catch (err) {
      logError("helpers", "Arcforma Text update", err);
    }
  }
}

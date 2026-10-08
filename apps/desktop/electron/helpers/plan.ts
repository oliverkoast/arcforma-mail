// The helpers a packed Arcforma Mail carries in Contents/Resources/helpers
// (scripts/build-helpers.mjs makes them): Arcforma Text, the AI daemon, and
// llama.cpp. This file decides what to do about them; install.ts does it.
// Pure, so node:test can check every decision without launchd.
//
// Ownership is the rule that keeps the developer's machine safe. A daemon
// LaunchAgent the app wrote runs the app's own binary with
// ELECTRON_RUN_AS_NODE, and the app keeps it current. A LaunchAgent anyone
// else wrote (packages/ai-daemon/install.sh, running the repository's node)
// is left exactly as it is.

import path from "node:path";

export const DAEMON_LABEL = "ai.arcforma.ai-daemon";
export const TEXT_LABEL = "ai.arcforma.text";

export interface HelperManifest {
  builtAt: string;
  daemon: { sha256: string };
  llama: { files: string[] } | null;
}

export interface HelperLayout {
  dir: string;
  textApp: string;
  daemonScript: string;
  /** Null when the build was packed with ARCFORMA_SKIP_LLAMA=1. */
  llamaDir: string | null;
  manifest: HelperManifest;
}

export interface LayoutFs {
  exists(file: string): boolean;
  read(file: string): string;
}

/** The helpers inside a packed app, or null for a dev run or a build packed without them. */
export function helperLayout(resourcesPath: string, fs: LayoutFs): HelperLayout | null {
  const dir = path.join(resourcesPath, "helpers");
  const manifestFile = path.join(dir, "manifest.json");
  if (!fs.exists(manifestFile)) return null;
  let manifest: HelperManifest;
  try {
    manifest = JSON.parse(fs.read(manifestFile)) as HelperManifest;
  } catch {
    return null;
  }
  const textApp = path.join(dir, "Arcforma Text.app");
  const daemonScript = path.join(dir, "ai-daemon", "server.mjs");
  if (!fs.exists(textApp) || !fs.exists(daemonScript)) return null;
  const llamaDir = path.join(dir, "llama");
  return { dir, textApp, daemonScript, llamaDir: fs.exists(path.join(llamaDir, "llama-server")) ? llamaDir : null, manifest };
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface DaemonAgentInput {
  /** The mail app's own executable, which runs the daemon as plain Node. */
  execPath: string;
  script: string;
  home: string;
  llamaDir: string | null;
}

/** The daemon's LaunchAgent. Same shape as packages/ai-daemon/launchd, on the app's binary instead of a node install. */
export function daemonAgentPlist(input: DaemonAgentInput): string {
  const env: Array<[string, string]> = [
    ["ELECTRON_RUN_AS_NODE", "1"],
    ["PATH", `${input.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`],
    ["HOME", input.home],
  ];
  if (input.llamaDir) env.push(["ARCFORMA_LLAMA_DIR", input.llamaDir]);
  const log = `${input.home}/Library/Logs/arcforma-ai-daemon.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.execPath)}</string>
    <string>${xml(input.script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>WorkingDirectory</key><string>${xml(path.dirname(input.script))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Arcforma Text's LaunchAgent, the same file packages/text-tools/install.sh writes. */
export function textAgentPlist(home: string, appPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${TEXT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(appPath)}/Contents/MacOS/ArcformaText</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xml(home)}/Library/Logs/arcforma-text.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${xml(home)}/Library/Logs/arcforma-text.stderr.log</string>
</dict>
</plist>
`;
}

/** Who wrote the daemon LaunchAgent on disk. Only the app's own agent carries ELECTRON_RUN_AS_NODE. */
export function agentOwner(plist: string | null): "missing" | "app" | "other" {
  if (plist === null) return "missing";
  return plist.includes("<key>ELECTRON_RUN_AS_NODE</key>") ? "app" : "other";
}

export type DaemonAction =
  /** No agent, or ours with different contents (the app moved, llama appeared): write it and load it. */
  | "write"
  /** Ours and unchanged, but the daemon code it runs changed under it: restart it. */
  | "restart"
  | "keep"
  /** Someone else's agent, a developer's repository daemon. Never touched. */
  | "leave";

export function daemonAction(existing: string | null, desired: string, startedHash: string | null, bundledHash: string): DaemonAction {
  const owner = agentOwner(existing);
  if (owner === "other") return "leave";
  if (owner === "missing" || existing !== desired) return "write";
  return startedHash === bundledHash ? "keep" : "restart";
}

/** An installed Arcforma Text is replaced only when it is there and is not the build this app carries. */
export function textNeedsUpdate(installedHash: string | null, bundledHash: string): boolean {
  return installedHash !== null && installedHash !== bundledHash;
}

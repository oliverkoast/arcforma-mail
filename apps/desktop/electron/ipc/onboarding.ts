// Everything the first-run flow needs to do outside the renderer: open the
// Google Cloud pages, write oauth-clients.json, store the AI credential,
// download the local model, run the text tool installer, and read the
// Accessibility grant. The renderer spawns nothing and writes no files; it
// calls these channels with narrow inputs and renders what comes back.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, shell } from "electron";
import { getSetting, setSetting, type Db } from "@arcforma/store";
import type { AccountRegistry } from "../accounts.js";
import type { AiClient } from "../ai/client.js";
import { defaultConfigPath } from "../ai/client.js";
import { emit } from "../events.js";
import { log, logError } from "../log.js";
import { oauthClientsPath } from "../paths.js";
import type { SyncManager } from "../sync.js";
import { addAccount, takenIds } from "../onboarding/clients.js";
import { ModelDownload, type DownloadResponse } from "../onboarding/download.js";
import { MODEL_CATALOG, applyAiChoice, daemonConfigView, modelPath, modelsDir, pointDaemonAtModel, textToolState, TEXT_LABEL } from "../onboarding/environment.js";
import {
  accountIdForEmail,
  aiAvailability,
  consoleUrl,
  isStepId,
  resumeStepId,
  validateApiKey,
  validateClaudeToken,
  validateEmail,
  type AiChoice,
  type ConsoleLink,
  type DownloadState,
  type OnboardingStepId,
} from "../../shared/onboarding.js";
import type { AddAccountRequest, AccountsStatus, OnboardingAiInfo, OnboardingInfo, OnboardingModelInfo, OnboardingTextInfo } from "../../shared/types.js";

const IDLE_DOWNLOAD: DownloadState = { phase: "idle", received: 0, total: null, resumed: false, file: null, error: null };

/** The only pages onboarding will open. A link name from the renderer can never become an arbitrary URL. */
const CONSOLE_LINKS: ReadonlySet<ConsoleLink> = new Set<ConsoleLink>(["createProject", "enableApis", "consentScreen", "credentials"]);

const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/** packages/text-tools/install.sh, resolved from the app folder. A packed build without the repo has none. */
export function textInstallScript(appPath = app.getAppPath()): string | null {
  const override = process.env["ARCMAIL_TEXT_INSTALL"];
  if (override) return fs.existsSync(override) ? override : null;
  const candidate = path.resolve(appPath, "..", "..", "packages", "text-tools", "install.sh");
  return fs.existsSync(candidate) ? candidate : null;
}

function onboardingInfo(db: Db): OnboardingInfo {
  const done = getSetting(db, "onboardingDone") === true;
  return { step: resumeStepId(getSetting(db, "onboardingStep"), done), done, clientsPath: oauthClientsPath() };
}

function textInfo(): OnboardingTextInfo {
  return { ...textToolState(), scriptPresent: textInstallScript() !== null };
}

async function aiInfo(ai: AiClient): Promise<OnboardingAiInfo> {
  const view = daemonConfigView(defaultConfigPath());
  ai.reload();
  const status = view.present ? await ai.status() : null;
  const storedChoice: AiChoice | null = view.hasClaudeToken ? "claude-code" : view.hasApiKey ? "api-key" : null;
  return {
    status,
    daemonConfigPath: view.path,
    daemonConfigPresent: view.present,
    hasClaudeToken: view.hasClaudeToken,
    hasApiKey: view.hasApiKey,
    storedChoice,
  };
}

/** node's fetch, narrowed to what the download needs, so tests can hand in their own. */
const realFetch = async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<DownloadResponse> => {
  const res = await fetch(url, { headers: init.headers, signal: init.signal, redirect: "follow" });
  return { status: res.status, headers: res.headers, body: res.body as AsyncIterable<Uint8Array> | null };
};

export function registerOnboardingIpc(db: Db, accounts: AccountRegistry, sync: SyncManager, ai: AiClient): void {
  let download: ModelDownload | null = null;
  let lastDownload: DownloadState = { ...IDLE_DOWNLOAD };
  let installing = false;

  const modelInfo = (): OnboardingModelInfo => {
    const view = daemonConfigView(defaultConfigPath());
    return {
      binaryPath: view.localBinary,
      binaryPresent: view.localBinaryPresent,
      modelPath: modelPath(),
      modelPresent: fs.existsSync(modelPath()) || view.localModelPresent,
      modelsDir: modelsDir(),
      catalog: { name: MODEL_CATALOG.name, file: MODEL_CATALOG.file, bytes: MODEL_CATALOG.bytes },
      download: download ? download.current() : lastDownload,
    };
  };

  ipcMain.handle("onboarding:get", (): OnboardingInfo => onboardingInfo(db));

  ipcMain.handle("onboarding:setStep", (_e, step: OnboardingStepId): OnboardingInfo => {
    if (!isStepId(step)) throw new Error(`${String(step)} is not an onboarding step.`);
    setSetting(db, "onboardingStep", step);
    return onboardingInfo(db);
  });

  ipcMain.handle("onboarding:setDone", (_e, done: boolean): OnboardingInfo => {
    setSetting(db, "onboardingDone", Boolean(done));
    if (!done) setSetting(db, "onboardingStep", "welcome");
    log("onboarding", done ? "finished" : "reopened from Settings");
    return onboardingInfo(db);
  });

  ipcMain.handle("onboarding:openConsole", (_e, link: ConsoleLink, projectId?: string) => {
    if (!CONSOLE_LINKS.has(link)) throw new Error(`${String(link)} is not one of the Google Cloud pages this app opens.`);
    const url = consoleUrl(link, typeof projectId === "string" ? projectId : "");
    log("onboarding", `opening ${link} in the browser`);
    void shell.openExternal(url);
  });

  ipcMain.handle("onboarding:openAccessibility", () => {
    void shell.openExternal(ACCESSIBILITY_PANE);
  });

  ipcMain.handle("onboarding:addAccount", async (_e, req: AddAccountRequest): Promise<AccountsStatus> => {
    const email = validateEmail(req?.email ?? "");
    if (!email.ok) throw new Error(email.message);
    const file = oauthClientsPath();
    const id = accountIdForEmail(email.value, takenIds(file));
    addAccount(file, {
      id,
      email: email.value,
      clientId: String(req?.clientId ?? ""),
      clientSecret: String(req?.clientSecret ?? ""),
      consent: req?.consent === "external" ? "external" : "internal",
    });
    // The secret is on disk at 0600 and stays there: nothing about it goes back over the bridge.
    log("onboarding", `wrote the OAuth client for ${id} into ${file}`);
    accounts.reloadConfig();
    const status = await accounts.signIn(id);
    sync.poke(id, 0);
    return status;
  });

  ipcMain.handle("onboarding:aiState", (): Promise<OnboardingAiInfo> => aiInfo(ai));

  ipcMain.handle("onboarding:setAi", async (_e, choice: AiChoice, secret?: string): Promise<OnboardingAiInfo> => {
    if (choice === "claude-code") {
      const token = validateClaudeToken(secret ?? "");
      if (!token.ok) throw new Error(token.message);
      applyAiChoice("claude-code", token.value, defaultConfigPath());
    } else if (choice === "api-key") {
      const key = validateApiKey(secret ?? "");
      if (!key.ok) throw new Error(key.message);
      applyAiChoice("api-key", key.value, defaultConfigPath());
    } else if (choice === "local") {
      applyAiChoice("local", "", defaultConfigPath());
    } else {
      throw new Error(`${String(choice)} is not one of the three AI choices.`);
    }
    log("onboarding", `AI choice set to ${choice}; the daemon picks it up when it restarts`);
    return aiInfo(ai);
  });

  ipcMain.handle("onboarding:modelState", (): OnboardingModelInfo => modelInfo());

  ipcMain.handle("onboarding:downloadModel", (): OnboardingModelInfo => {
    if (download) return modelInfo();
    const dest = modelPath();
    const run = new ModelDownload({
      url: MODEL_CATALOG.url,
      dest,
      expectedBytes: MODEL_CATALOG.bytes,
      fetchImpl: realFetch,
      onProgress: (state) => {
        lastDownload = state;
        emit("onboarding:progress", { kind: "model", state });
      },
    });
    download = run;
    log("onboarding", `model download started into ${dest}`);
    void run
      .start()
      .then((state) => {
        if (state.phase === "done" && state.file) {
          pointDaemonAtModel(state.file, defaultConfigPath());
          log("onboarding", `model in place at ${state.file}`);
        }
      })
      .catch((err: unknown) => logError("onboarding", "model download", err))
      .finally(() => {
        download = null;
        emit("onboarding:progress", { kind: "model", state: lastDownload });
      });
    return modelInfo();
  });

  ipcMain.handle("onboarding:cancelModel", (): OnboardingModelInfo => {
    download?.cancel();
    return modelInfo();
  });

  ipcMain.handle("onboarding:textState", (): OnboardingTextInfo => textInfo());

  ipcMain.handle("onboarding:installText", async (): Promise<OnboardingTextInfo> => {
    const script = textInstallScript();
    if (!script) throw new Error("This build has no packages/text-tools/install.sh next to it, so the text tool cannot be built from here.");
    if (installing) throw new Error("The install is already running.");
    installing = true;
    emit("onboarding:progress", { kind: "text", line: `Running ${script}`, phase: "running" });
    try {
      await runScript(script);
      emit("onboarding:progress", { kind: "text", line: "Installed. Grant Accessibility, then press Check the grant.", phase: "done" });
    } catch (err) {
      emit("onboarding:progress", { kind: "text", line: (err as Error).message, phase: "failed" });
      throw err;
    } finally {
      installing = false;
    }
    return textInfo();
  });

  ipcMain.handle("onboarding:checkAccessibility", async (): Promise<OnboardingTextInfo> => {
    // Arcforma Text only answers this question in its own launch log, so the agent is restarted and the newest line read.
    await kickstart(TEXT_LABEL).catch((err: unknown) => logError("onboarding", "kickstart arcforma text", err));
    await new Promise((r) => setTimeout(r, 2500));
    return textInfo();
  });
}

/** Runs a shell script to completion, sending every line it prints to the step. */
function runScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [script], { cwd: path.dirname(script), stdio: ["ignore", "pipe", "pipe"] });
    let rest = "";
    const feed = (chunk: Buffer) => {
      rest += chunk.toString();
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) emit("onboarding:progress", { kind: "text", line: line.trimEnd(), phase: "running" });
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (err) => reject(new Error(`The installer could not start: ${err.message}`)));
    child.on("close", (code) => {
      if (rest.trim()) emit("onboarding:progress", { kind: "text", line: rest.trimEnd(), phase: "running" });
      if (code === 0) resolve();
      else reject(new Error(`The installer exited ${code}. The lines above say where it stopped.`));
    });
  });
}

function kickstart(label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shell } from "electron";
import { emit } from "../events.js";
import { log } from "../log.js";
import type { ClaudeSignInState } from "../../shared/types.js";

/** The daemon's config names the CLI; the same binary signs in. */
function claudeBin(): string {
  const file = process.env["ARCMAIL_AI_CONFIG"] || path.join(os.homedir(), "Library", "Application Support", "Arcforma", "ai-daemon.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeBin?: string };
    if (cfg.claudeBin && fs.existsSync(cfg.claudeBin)) return cfg.claudeBin;
  } catch {
    /* no config yet: the default location */
  }
  return path.join(os.homedir(), ".local", "bin", "claude");
}

const URL_LINE = /https:\/\/\S+/;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/**
 * Signs the Claude Code CLI in from inside the app. Without a terminal the CLI opens the browser,
 * prints the link in case it did not, and waits for the code the sign-in page shows at the end
 * to be pasted on its stdin. That code is typed into Settings and written here. One sign-in at
 * a time; a smoke run never spawns the CLI and walks the same states on its own.
 */
export class ClaudeSignIn {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly smoke: boolean) {}

  start(): Promise<{ url: string | null }> {
    if (this.smoke) {
      this.url = "https://claude.ai/smoke-sign-in";
      this.announce("waiting");
      return Promise.resolve({ url: this.url });
    }
    if (this.child) return Promise.resolve({ url: this.url });
    const bin = claudeBin();
    log("ai", `signing in to Claude Code with ${bin}`);
    const child = spawn(bin, ["auth", "login"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: os.homedir() } });
    this.child = child;
    this.url = null;
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (!this.url) {
        const m = URL_LINE.exec(out);
        if (m) {
          this.url = m[0];
          this.announce("waiting");
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", (code) => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.child = null;
      if (code === 0) {
        log("ai", "Claude Code signed in");
        this.announce("done");
      } else {
        const tail = (err || out).trim().split("\n").slice(-2).join(" ").slice(0, 200);
        log("ai", `Claude Code sign-in ended with code ${code}: ${tail}`);
        this.announce("failed", tail || `the sign-in ended with code ${code}`);
      }
    });
    child.on("error", (e) => {
      this.child = null;
      this.announce("failed", e.message);
    });
    this.timer = setTimeout(() => this.cancel("the sign-in took more than ten minutes"), SIGN_IN_TIMEOUT_MS);
    // The link takes a moment to print; the browser is the CLI's to open, the link is shown in case it did not.
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (this.url || !this.child || Date.now() - started > 8000) resolve({ url: this.url });
        else setTimeout(tick, 100);
      };
      tick();
    });
  }

  /** The code the sign-in page shows, pasted into Settings. */
  submit(code: string): void {
    const c = code.trim();
    if (!c) return;
    if (this.smoke) {
      this.announce(c === "smoke-ok" ? "done" : "failed", c === "smoke-ok" ? undefined : "that code was not accepted");
      return;
    }
    if (!this.child?.stdin) {
      this.announce("failed", "no sign-in is waiting for a code");
      return;
    }
    this.child.stdin.write(c + "\n");
  }

  cancel(reason = "cancelled"): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.url = null;
    this.announce("idle", reason === "cancelled" ? undefined : reason);
  }

  openLink(): void {
    if (this.url && !this.smoke) void shell.openExternal(this.url);
  }

  private announce(state: ClaudeSignInState["state"], error?: string): void {
    emit("ai:signIn", { state, url: this.url, error: error ?? null });
  }
}

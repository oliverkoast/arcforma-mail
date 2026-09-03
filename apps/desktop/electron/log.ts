// Where the app says what happened, and the one place that has to survive the app not surviving.
//
// This used to be console.log alone. A packed app launched from Finder has nowhere for stdout to
// go, so every line was written to a pipe nobody was holding: when something went wrong on the one
// machine that matters, there was nothing to read afterwards and a bug could only be reported from
// memory. Lines go to a file now, and the crash paths that used to end the process in silence write
// there first.
//
// Two rules, both load-bearing:
//
//   Logging never throws. A full disk, a read-only volume, a folder that vanished: all of it is
//   swallowed, because a failure to record an event must not become a failure to handle it.
//
//   Logging never records mail. Scopes and outcomes, counts and ids, never subjects, bodies,
//   addresses or tokens. redact() is the backstop, not the policy: the policy is not to pass them.

import fs from "node:fs";
import path from "node:path";

/** Rotate at this size, keeping one previous file. Big enough for a long session, small enough to send. */
export const LOG_MAX_BYTES = 2_000_000;
export const LOG_FILE = "arcforma-mail.log";
export const LOG_PREVIOUS = "arcforma-mail.previous.log";

const BEARER = /\b(bearer|token|authorization|refresh_token|access_token|client_secret|api[_-]?key)\b(\s*[:=]\s*|\s+)("?)[\w.\-+/=]{8,}\3/gi;
const LONG_SECRET = /\b(?:[A-Za-z0-9_-]{12,}\.){2}[A-Za-z0-9_-]{12,}\b/g;
const GOOGLE_TOKEN = /\b(?:ya29|1\/\/)[\w.\-+/=]{10,}/g;

/**
 * Removes the shapes a credential takes, wherever one reached a log line by mistake.
 *
 * This is a net under the policy, not the policy. Anything it catches is a bug in the call site,
 * because secrets are not supposed to be passed here at all. It is here because a log file is a
 * file people attach to bug reports, and one leaked refresh token is worse than every line it took
 * to find the bug.
 */
export function redact(text: string): string {
  return text
    .replace(GOOGLE_TOKEN, "[redacted]")
    .replace(BEARER, (_m, key: string, sep: string) => `${key}${sep}[redacted]`)
    .replace(LONG_SECRET, "[redacted]");
}

/** One line, already stamped and redacted. Kept pure so the format is tested without touching a disk. */
export function formatLine(level: "info" | "error", scope: string, message: string, data?: unknown): string {
  const stamp = new Date().toISOString();
  const tail = data === undefined ? "" : ` ${typeof data === "string" ? data : safeJson(data)}`;
  return redact(`${stamp} [${level === "error" ? "error " : ""}${scope}] ${message}${tail}`);
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    // A cycle or a getter that throws is not worth losing the line over.
    return "[unserialisable]";
  }
}

let sink: { dir: string; file: string; bytes: number } | null = null;

/**
 * Starts writing to <dir>/arcforma-mail.log. Safe to call twice; safe to never call, in which case
 * lines only reach the console, which is what tests and `pnpm dev` want.
 */
export function initLogFile(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOG_FILE);
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    sink = { dir, file, bytes };
    return file;
  } catch {
    sink = null;
    return null;
  }
}

/** Where the log lives, for the button in Settings that opens it. Null when no file is being written. */
export function logFilePath(): string | null {
  return sink?.file ?? null;
}

/** Only for tests: forget the sink so one test's file does not follow another. */
export function resetLogFileForTests(): void {
  sink = null;
}

function append(line: string): void {
  const s = sink;
  if (!s) return;
  try {
    if (s.bytes > LOG_MAX_BYTES) {
      // One previous file is kept. Two would be a retention policy, and this is a debugging aid.
      fs.rmSync(path.join(s.dir, LOG_PREVIOUS), { force: true });
      fs.renameSync(s.file, path.join(s.dir, LOG_PREVIOUS));
      s.bytes = 0;
    }
    const withNewline = `${line}\n`;
    fs.appendFileSync(s.file, withNewline);
    s.bytes += Buffer.byteLength(withNewline);
  } catch {
    // Never let recording an event break handling it.
  }
}

export function log(scope: string, message: string, data?: unknown): void {
  const line = formatLine("info", scope, message, data);
  console.log(line);
  append(line);
}

export function logError(scope: string, message: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const line = formatLine("error", scope, `${message}: ${detail}`);
  console.error(line);
  append(line);
  // The stack goes to the file only. It is what makes a crash report worth reading, and it is too
  // noisy for a terminal that someone is watching while they work.
  if (err instanceof Error && err.stack) append(redact(err.stack));
}

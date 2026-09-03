// The log is a file people attach to bug reports, so the tests that matter are about what must
// never reach it and about it never becoming a way for the app to fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOG_FILE, LOG_PREVIOUS, formatLine, initLogFile, log, logError, logFilePath, redact, resetLogFileForTests } from "./log.js";

test("a bearer token never survives a log line", () => {
  assert.match(redact("Authorization: Bearer ya29.a0AfH6SMBx7Kq2Lm9"), /\[redacted\]/);
  assert.doesNotMatch(redact("Authorization: Bearer ya29.a0AfH6SMBx7Kq2Lm9"), /a0AfH6SMBx7Kq2Lm9/);
  assert.doesNotMatch(redact('refresh_token="1//04dXk9sLmQ2vwCgYIARAAGAQSNwF"'), /04dXk9sLmQ2vwCgYIARAAGAQSNwF/);
  assert.doesNotMatch(redact("client_secret=GOCSPX-abcdefghijklmnop"), /GOCSPX-abcdefghijklmnop/);
  assert.doesNotMatch(redact("api_key: sk-abcdefghijklmnopqrstuvwx"), /abcdefghijklmnopqrstuvwx/);
});

test("a JWT anywhere in a line is redacted, key or no key", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.doesNotMatch(redact(`sync failed for ${jwt}`), /eyJzdWIiOiIxMjM0NTY3ODkw/);
});

test("ordinary lines are left alone, so the log stays readable", () => {
  const line = "2026-09-03T12:00:00.000Z [sync] applied 14 history changes, 2 masked";
  assert.equal(redact(line), line);
  assert.equal(redact("archived thread t-kickoff for arcforma"), "archived thread t-kickoff for arcforma");
});

test("a line carries its level, scope and message, and redacts its data too", () => {
  const line = formatLine("error", "sync", "token refused", "refresh_token=1//04dXk9sLmQ2vwCgYIARAAGAQ");
  assert.match(line, /\[error sync\] token refused/);
  assert.doesNotMatch(line, /04dXk9sLmQ2vwCgYIARAAGAQ/);
  assert.match(formatLine("info", "app", "started"), /\[app\] started$/);
});

test("data that cannot be serialised costs the data, never the line", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.match(formatLine("info", "x", "m", cyclic), /\[unserialisable\]/);
});

test("lines reach the file, and the stack of an error goes with it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-log-"));
  assert.equal(initLogFile(dir), path.join(dir, LOG_FILE));
  assert.equal(logFilePath(), path.join(dir, LOG_FILE));
  log("test", "hello");
  logError("test", "it broke", new Error("the reason"));
  const text = fs.readFileSync(path.join(dir, LOG_FILE), "utf8");
  assert.match(text, /\[test\] hello/);
  assert.match(text, /\[error test\] it broke: Error: the reason/);
  assert.match(text, /log\.test\.ts/, "the stack is what makes a crash report worth reading");
  resetLogFileForTests();
});

test("a log directory that cannot be made costs the file, never the app", () => {
  // A path under a regular file can never be a directory, which is the shape of a read-only volume
  // or a vanished folder. Logging has to degrade to the console rather than throw into a caller.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-log-")), "not-a-dir");
  fs.writeFileSync(file, "x");
  assert.equal(initLogFile(path.join(file, "logs")), null);
  assert.equal(logFilePath(), null);
  assert.doesNotThrow(() => log("test", "still fine"));
  assert.doesNotThrow(() => logError("test", "still fine", new Error("x")));
});

test("the file rotates once it is too big, keeping exactly one previous", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-log-"));
  initLogFile(dir);
  fs.writeFileSync(path.join(dir, LOG_FILE), "x".repeat(2_000_001));
  initLogFile(dir);
  log("test", "the line that tips it over");
  assert.ok(fs.existsSync(path.join(dir, LOG_PREVIOUS)), "the old file is kept once");
  assert.match(fs.readFileSync(path.join(dir, LOG_FILE), "utf8"), /tips it over/);
  assert.ok(fs.statSync(path.join(dir, LOG_FILE)).size < 1000, "and the new one starts empty");
  resetLogFileForTests();
});

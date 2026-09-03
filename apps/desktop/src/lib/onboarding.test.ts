import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ONBOARDING_STEPS,
  accountIdForEmail,
  aiAvailability,
  consoleUrl,
  downloadLine,
  downloadPercent,
  isStepId,
  nextStepId,
  prevStepId,
  readableSize,
  resumeStepId,
  stepIndex,
  validateApiKey,
  validateClaudeToken,
  validateClientId,
  validateClientSecret,
  validateEmail,
  validateProjectId,
  type DownloadState,
} from "../../shared/onboarding";
import type { AiStatus } from "../../shared/types";

const GOOD_ID = "123456789012-abc1def2ghi3.apps.googleusercontent.com";

/** The refusal sentence, or an empty string when the value was accepted. */
const why = (v: { ok: true; value: string } | { ok: false; message: string }): string => (v.ok ? "" : v.message);
/** The cleaned value, or an empty string when it was refused. */
const value = (v: { ok: true; value: string } | { ok: false; message: string }): string => (v.ok ? v.value : "");

test("a client id is accepted only in Google's shape, and every refusal says what is wrong", () => {
  const ok = validateClientId(GOOD_ID);
  assert.equal(ok.ok, true);
  assert.equal(value(ok), GOOD_ID);
  // Whitespace around a paste is normal and is trimmed, not refused.
  assert.equal(validateClientId(`  ${GOOD_ID}\n`).ok, true);

  assert.match(why(validateClientId("")), /Paste the client id/);
  assert.match(why(validateClientId("a-secret-looking-value")), /ends in \.apps\.googleusercontent\.com/);
  // Right suffix, wrong body: the message points at the whole field rather than the domain.
  const wrongBody = validateClientId("no-digits-here.apps.googleusercontent.com");
  assert.equal(wrongBody.ok, false);
  assert.match(why(wrongBody), /digits, a dash/);
  const spaced = validateClientId(`${GOOD_ID} extra`);
  assert.equal(spaced.ok, false);
  assert.match(why(spaced), /space in it/);
  // Uppercase is not a client id shape; Google issues lowercase bodies.
  assert.equal(validateClientId("123456789012-ABCDEF.apps.googleusercontent.com").ok, false);
});

test("a client secret is any non-empty single token, and the client id pasted into it is caught", () => {
  const ok = validateClientSecret("  a-secret-value  ");
  assert.equal(ok.ok, true);
  assert.equal(value(ok), "a-secret-value");
  assert.equal(validateClientSecret("").ok, false);
  const swapped = validateClientSecret(GOOD_ID);
  assert.equal(swapped.ok, false);
  assert.match(why(swapped), /That is the client id/);
  assert.equal(validateClientSecret("two words").ok, false);
});

test("addresses, project ids, tokens, and keys each refuse with their own sentence", () => {
  assert.equal(value(validateEmail(" You@Example.com ")), "you@example.com");
  assert.equal(validateEmail("not-an-address").ok, false);
  // An empty project id is allowed: the console links then open without a project.
  assert.deepEqual(validateProjectId(""), { ok: true, value: "" });
  assert.equal(validateProjectId("arcforma-mail").ok, true);
  assert.equal(validateProjectId("Arcforma").ok, false);
  assert.equal(validateProjectId("ab").ok, false);
  assert.equal(validateClaudeToken("short").ok, false);
  assert.equal(validateClaudeToken("a-long-enough-token-value-here").ok, true);
  assert.equal(validateApiKey("sk-ant-example-key").ok, true);
  assert.match(why(validateApiKey("nope")), /start with sk-ant-/);
});

test("an account slot id comes from the address and never collides with one already in the file", () => {
  assert.equal(accountIdForEmail("oliver@arcforma.ai"), "arcforma");
  assert.equal(accountIdForEmail("oliver@gmail.com"), "gmail");
  assert.equal(accountIdForEmail("oliver@arcforma.ai", ["arcforma"]), "arcforma-2");
  assert.equal(accountIdForEmail("oliver@arcforma.ai", ["arcforma", "arcforma-2"]), "arcforma-3");
});

test("the steps run in order, the last one stays put, and the first has nothing behind it", () => {
  assert.deepEqual([...ONBOARDING_STEPS], ["welcome", "accounts", "ai", "model", "text", "done"]);
  assert.equal(nextStepId("welcome"), "accounts");
  assert.equal(nextStepId("text"), "done");
  assert.equal(nextStepId("done"), "done");
  assert.equal(prevStepId("welcome"), null);
  assert.equal(prevStepId("done"), "text");
  assert.equal(stepIndex("model"), 3);
  assert.equal(isStepId("model"), true);
  assert.equal(isStepId("nonsense"), false);
});

test("a quit mid-way resumes on the same step; a finished setup and unreadable state do not", () => {
  assert.equal(resumeStepId("model", false), "model");
  assert.equal(resumeStepId("model", true), "done");
  assert.equal(resumeStepId(null, false), "welcome");
  assert.equal(resumeStepId("", false), "welcome");
  assert.equal(resumeStepId(42, false), "welcome");
  assert.equal(resumeStepId("a step that was renamed", false), "welcome");
});

const status = (patch: Partial<AiStatus>): AiStatus => ({ ok: true, loggedIn: false, claude: "signed_out", local: "idle", model: null, cliVersion: null, ...patch });

test("daemon health maps to the three AI choices: no daemon, Claude already signed in, Claude signed out", () => {
  const down = aiAvailability(null);
  assert.equal(down.daemonRunning, false);
  assert.equal(down.claudeReady, false);
  assert.equal(down.choice, "local");
  assert.match(down.detail, /not answering/);

  // A daemon that answers with ok:false is the same as no daemon for this question.
  assert.equal(aiAvailability(status({ ok: false, claude: "daemon_down" })).daemonRunning, false);

  const ready = aiAvailability(status({ loggedIn: true, claude: "ok", cliVersion: "2.1.0" }));
  assert.equal(ready.claudeReady, true);
  assert.equal(ready.choice, "claude-code");
  assert.match(ready.detail, /already signed in on this Mac \(2\.1\.0\)/);

  const out = aiAvailability(status({}));
  assert.equal(out.daemonRunning, true);
  assert.equal(out.claudeReady, false);
  assert.equal(out.choice, "local");
  assert.match(out.detail, /signed out/);

  // A stored choice wins the preselection in every case; the facts around it do not change.
  assert.equal(aiAvailability(status({}), "api-key").choice, "api-key");
  assert.equal(aiAvailability(null, "claude-code").choice, "claude-code");
  assert.equal(aiAvailability(status({ loggedIn: true }), "api-key").choice, "api-key");
});

test("the console links carry the three APIs and pin the project only when the id is usable", () => {
  assert.equal(consoleUrl("createProject"), "https://console.cloud.google.com/projectcreate");
  const enable = consoleUrl("enableApis", "arcforma-mail");
  assert.equal(enable, "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,people.googleapis.com&project=arcforma-mail");
  assert.match(consoleUrl("enableApis"), /apiid=gmail\.googleapis\.com,calendar-json\.googleapis\.com,people\.googleapis\.com$/);
  assert.equal(consoleUrl("consentScreen", "arcforma-mail"), "https://console.cloud.google.com/auth/branding?project=arcforma-mail");
  assert.equal(consoleUrl("credentials"), "https://console.cloud.google.com/auth/clients");
  // A project id that would not validate is dropped rather than pasted into a URL.
  assert.equal(consoleUrl("credentials", "Not A Project"), "https://console.cloud.google.com/auth/clients");
});

const dl = (patch: Partial<DownloadState>): DownloadState => ({ phase: "idle", received: 0, total: null, resumed: false, file: null, error: null, ...patch });

test("the download bar and its line say what is happening, including nothing at all", () => {
  assert.equal(downloadPercent(dl({ received: 50, total: 200 })), 25);
  assert.equal(downloadPercent(dl({ received: 50, total: null })), null);
  assert.equal(downloadPercent(dl({ received: 300, total: 200 })), 100);
  assert.match(downloadLine(dl({})), /Nothing downloaded yet/);
  assert.match(downloadLine(dl({ phase: "starting", received: 1e9, resumed: true })), /1\.0 GB already here/);
  assert.match(downloadLine(dl({ phase: "downloading", received: 5e8, total: 2e9 })), /500 MB of 2\.0 GB/);
  assert.match(downloadLine(dl({ phase: "cancelled", received: 1e9 })), /1\.0 GB is kept/);
  assert.equal(downloadLine(dl({ phase: "failed", error: "the disk is full" })), "the disk is full");
  assert.match(downloadLine(dl({ phase: "done", file: "/tmp/m.gguf" })), /points at \/tmp\/m\.gguf/);
  assert.equal(readableSize(0), "unknown size");
  assert.equal(readableSize(2_497_281_120), "2.5 GB");
});

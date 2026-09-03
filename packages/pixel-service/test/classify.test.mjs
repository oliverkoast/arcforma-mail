import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFetch, summarise, PREFETCH_WINDOW_MS } from "../src/classify.mjs";

const SENT = 1_000_000;
const later = (ms) => SENT + PREFETCH_WINDOW_MS + ms;

test("a fetch seconds after sending is a machine, not a reader", () => {
  const r = classifyFetch({ userAgent: "Mozilla/5.0", at: SENT + 500, sentAt: SENT });
  assert.equal(r.grade, "automatic");
  assert.match(r.why, /within seconds/);
});

test("Apple Mail Privacy Protection is never counted as a read", () => {
  assert.equal(classifyFetch({ userAgent: "AppleMailProxy/1.0", at: later(60_000), sentAt: SENT }).grade, "automatic");
});

test("scanners and link checkers are machines", () => {
  for (const ua of ["Proofpoint-Scanner/2", "python-requests/2.31", "curl/8.4", "Slackbot-LinkExpanding 1.0", "HeadlessChrome/120"]) {
    assert.equal(classifyFetch({ userAgent: ua, at: later(60_000), sentAt: SENT }).grade, "automatic", ua);
  }
});

test("Gmail's image proxy means Gmail rendered the message", () => {
  const r = classifyFetch({ userAgent: "Mozilla/5.0 (Windows NT 10.0) GoogleImageProxy", at: later(60_000), sentAt: SENT });
  assert.equal(r.grade, "opened");
});

test("a client that says nothing is unknown, never a read", () => {
  assert.equal(classifyFetch({ userAgent: "", at: later(60_000), sentAt: SENT }).grade, "unknown");
});

test("no fetch is no signal, which is not the same as unread", () => {
  const s = summarise([]);
  assert.equal(s.status, "no signal");
  assert.equal(s.firstAt, null);
});

test("one human fetch among machines still reads as opened, at the human time", () => {
  const s = summarise([
    { at: 10, grade: "automatic" },
    { at: 30, grade: "opened" },
    { at: 40, grade: "opened" },
  ]);
  assert.equal(s.status, "opened");
  assert.equal(s.firstAt, 30);
  assert.equal(s.count, 2);
});

test("only machine fetches are reported as possibly automatic, never as opened", () => {
  const s = summarise([{ at: 10, grade: "automatic" }, { at: 20, grade: "unknown" }]);
  assert.equal(s.status, "possibly automatic");
  assert.equal(s.firstAt, 10);
});

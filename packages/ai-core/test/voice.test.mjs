import { test } from "node:test";
import assert from "node:assert/strict";
import { stripQuotesAndSignature, selectSample, buildPrompt } from "../scripts/build-voice.mjs";

test("stripQuotesAndSignature drops quoted history and signatures", () => {
  const t = "Thanks Sarah, Monday works.\n\nOliver\n-- \nOliver Korzen\nArcforma\n\nOn Tue, Sep 1, 2026 at 9:00 AM Sarah <s@x.com> wrote:\n> can we do Monday?";
  assert.equal(stripQuotesAndSignature(t), "Thanks Sarah, Monday works.\n\nOliver");
});

test("selectSample spreads across accounts and drops tiny messages", () => {
  const msgs = [
    ...Array.from({ length: 10 }, (_, i) => ({ account: "a", text: `a message number ${i} with enough words to count here` })),
    ...Array.from({ length: 10 }, (_, i) => ({ account: "b", text: `b message number ${i} with enough words to count here` })),
    { account: "a", text: "ok" },
  ];
  const picked = selectSample(msgs, 6);
  assert.equal(picked.length, 6);
  assert.equal(picked.filter((m) => m.account === "a").length, 3);
  assert.ok(picked.every((m) => m.text !== "ok"));
});

test("buildPrompt numbers exemplars and forbids dashes and emojis", () => {
  const p = buildPrompt([{ account: "a", to: "x@y.com", subject: "Hi", text: "hello there friend" }]);
  assert.match(p.user, /\[1\] to x@y.com/);
  assert.match(p.system, /No emojis\. No em dashes\./);
});

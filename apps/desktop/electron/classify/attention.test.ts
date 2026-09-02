import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GREY_FLOOR, IMPORTANT_FLOOR, NEEDS_YOU_FLOOR, WEIGHTS, detectAsk, isPersonMessage, relationshipPoints, scoreAttention, splitForBand, waitingPoints } from "./attention.js";
import type { AttentionFacts } from "@arcforma/store";

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

/** A thread nobody is waiting on: no history, no ask, nothing bulk. Every test names only what it changes. */
function facts(over: Partial<AttentionFacts> = {}): AttentionFacts {
  return {
    accountId: "arcforma",
    threadId: "t",
    now: NOW,
    senderEmail: "stranger@unknown.example",
    senderName: "",
    senderDomain: "unknown.example",
    isOwnSender: false,
    addressing: "alias",
    repliedCount: 0,
    lastRepliedAt: null,
    repliedDomain: false,
    isClientDomain: false,
    isFirstTimeSender: false,
    youAreInThread: false,
    youStartedThread: false,
    lastInboundAt: NOW - DAY,
    lastOutboundAt: null,
    unansweredMs: null,
    askText: "",
    isBulk: false,
    isAuto: false,
    type: null,
    senderThreads: 1,
    threadsPerWeek: 0.2,
    archiveWithoutReadRate: 0,
    neverOpened: false,
    demotions: 0,
    ...over,
  };
}

test("addressing: To alone beats To with others beats Cc beats a group alias", () => {
  const score = (addressing: AttentionFacts["addressing"]) => scoreAttention(facts({ addressing })).score;
  assert.equal(score("to"), WEIGHTS.addressing.to);
  assert.equal(score("to_with_others"), WEIGHTS.addressing.to_with_others);
  assert.equal(score("cc"), WEIGHTS.addressing.cc);
  assert.equal(score("alias"), 0);
  assert.ok(score("to") > score("to_with_others") && score("to_with_others") > score("cc") && score("cc") > score("alias"));
});

test("relationship: the tiers rise with the count and fall with the age of the last message he sent", () => {
  assert.equal(relationshipPoints(0, null, NOW), 0);
  assert.equal(relationshipPoints(1, NOW - DAY, NOW), WEIGHTS.replied.few);
  assert.equal(relationshipPoints(3, NOW - DAY, NOW), WEIGHTS.replied.some);
  assert.equal(relationshipPoints(10, NOW - DAY, NOW), WEIGHTS.replied.many);
  assert.equal(relationshipPoints(10, NOW - 100 * DAY, NOW), WEIGHTS.replied.many * WEIGHTS.repliedRecency.warm);
  assert.equal(relationshipPoints(10, NOW - 400 * DAY, NOW), WEIGHTS.replied.many * WEIGHTS.repliedRecency.cold);
  assert.equal(relationshipPoints(10, null, NOW), WEIGHTS.replied.many * WEIGHTS.repliedRecency.cold, "no date at all is treated as cold, never as fresh");

  // A domain he writes to lifts an address he has not written to; once he has, the address speaks for itself.
  assert.equal(scoreAttention(facts({ repliedDomain: true })).score, WEIGHTS.repliedDomain);
  assert.equal(scoreAttention(facts({ repliedDomain: true, repliedCount: 1, lastRepliedAt: NOW - DAY })).score, WEIGHTS.replied.few);
  assert.equal(scoreAttention(facts({ isClientDomain: true })).score, WEIGHTS.clientDomain);
  assert.equal(scoreAttention(facts({ isFirstTimeSender: true })).score, 0, "the first-time penalty cannot push a score below zero");
  assert.equal(scoreAttention(facts({ addressing: "to", isFirstTimeSender: true })).score, WEIGHTS.addressing.to + WEIGHTS.firstTimeSender);
  assert.equal(scoreAttention(facts({ addressing: "to", isFirstTimeSender: true, repliedDomain: true })).score, WEIGHTS.addressing.to + WEIGHTS.repliedDomain, "a known domain cancels the first-time penalty");
});

test("conversation: a thread he has written in, and one he started", () => {
  assert.equal(scoreAttention(facts({ youAreInThread: true })).score, WEIGHTS.inThread);
  assert.equal(scoreAttention(facts({ youAreInThread: true, youStartedThread: true })).score, WEIGHTS.inThread + WEIGHTS.startedByYou);
});

test("ask: a question has to be aimed at the reader, and the three signals are capped together", () => {
  assert.deepEqual(detectAsk("Ready for fall?"), { question: false, request: false, deadline: false }, "a newsletter subject is not an ask");
  assert.equal(detectAsk("Can you send the deck?").question, true);
  assert.equal(detectAsk("Does that work?").question, true, "an opener starts a real question");
  assert.equal(detectAsk("Subject line\nWhat time works for you?").question, true, "the subject line ends before the body starts");
  assert.equal(detectAsk("The new season is here. Shop now.").question, false);
  assert.equal(detectAsk("Please confirm the invoice.").request, true);
  assert.equal(detectAsk("Just following up on this.").request, true);
  assert.equal(detectAsk("Waiting on your side before we book.").request, true);
  assert.equal(detectAsk("We need this signed by Friday.").deadline, true);
  assert.equal(detectAsk("The deadline is next month.").deadline, true);
  assert.equal(detectAsk("").question, false);
  assert.equal(detectAsk("").request, false);

  // "Can you" is a question and a request at once, so the question weight is measured on its own with an opener.
  const q = scoreAttention(facts({ askText: "Does that work?" })).score;
  const r = scoreAttention(facts({ askText: "Please review the invoice." })).score;
  const d = scoreAttention(facts({ askText: "We need this signed by Friday." })).score;
  assert.equal(q, WEIGHTS.ask.question);
  assert.equal(r, WEIGHTS.ask.request);
  assert.equal(d, WEIGHTS.ask.deadline);
  assert.equal(scoreAttention(facts({ askText: "Can you please review this by Friday?" })).score, WEIGHTS.ask.cap, "all three together stop at the cap");
});

test("waiting: an unanswered message peaks between one and three days and fades after a week", () => {
  assert.equal(waitingPoints(null), 0, "a message he has answered is not waiting");
  assert.equal(waitingPoints(2 * 3_600_000), WEIGHTS.waiting.sameDay);
  assert.equal(waitingPoints(2 * DAY), WEIGHTS.waiting.days1to3);
  assert.equal(waitingPoints(5 * DAY), WEIGHTS.waiting.days3to7);
  assert.equal(waitingPoints(30 * DAY), WEIGHTS.waiting.older);
  assert.ok(WEIGHTS.waiting.days1to3 > WEIGHTS.waiting.days3to7 && WEIGHTS.waiting.days3to7 > WEIGHTS.waiting.older);
});

test("the negative signals each land on their own, and a person is only a person when nothing says otherwise", () => {
  const base = facts({ addressing: "to", repliedCount: 10, lastRepliedAt: NOW - DAY });
  const plain = scoreAttention(base).score;
  assert.equal(scoreAttention({ ...base, isBulk: true }).score, plain + WEIGHTS.bulk);
  assert.equal(scoreAttention({ ...base, isAuto: true }).score, plain + WEIGHTS.auto);
  assert.equal(scoreAttention({ ...base, type: "newsletters" }).score, plain + WEIGHTS.typed);
  assert.equal(scoreAttention({ ...base, senderEmail: "no-reply@render.com" }).score, plain + WEIGHTS.noReply);
  assert.equal(scoreAttention({ ...base, senderEmail: "support@render.com" }).score, plain + WEIGHTS.roleAddress);
  assert.equal(scoreAttention({ ...base, senderEmail: "reminder@superhuman.com" }).score, plain + WEIGHTS.roleAddress, "a reminder robot is not a person");
  assert.equal(scoreAttention({ ...base, isOwnSender: true }).score, 0, "his own address scores nothing, whatever else the message carries");
  assert.equal(scoreAttention({ ...base, senderThreads: 8, archiveWithoutReadRate: 0.9 }).score, plain + WEIGHTS.archivesUnread);
  assert.equal(scoreAttention({ ...base, senderThreads: 8, archiveWithoutReadRate: 0.7 }).score, plain, "below the 80 percent bar the signal does not fire");
  assert.equal(scoreAttention({ ...base, senderThreads: 4, archiveWithoutReadRate: 0.9 }).score, plain, "four threads is not enough to call it a habit");
  assert.equal(scoreAttention({ ...base, neverOpened: true }).score, plain + WEIGHTS.neverOpened);
  assert.equal(scoreAttention({ ...base, threadsPerWeek: 5 }).score, plain + WEIGHTS.busyPerWeek);
  assert.equal(scoreAttention({ ...base, threadsPerWeek: 20 }).score, plain + WEIGHTS.floodPerWeek);

  assert.equal(isPersonMessage(facts({ senderEmail: "dana@northwind.example" })), true);
  assert.equal(isPersonMessage(facts({ senderEmail: "noreply@render.com" })), false);
  assert.equal(isPersonMessage(facts({ senderEmail: "support@render.com" })), false);
  assert.equal(isPersonMessage(facts({ senderEmail: "reminder@superhuman.com" })), false);
  assert.equal(isPersonMessage(facts({ senderEmail: "dana@northwind.example", isBulk: true })), false);
  assert.equal(isPersonMessage(facts({ senderEmail: "dana@northwind.example", isAuto: true })), false);
  assert.equal(isPersonMessage(facts({ senderEmail: "you@example.com", isOwnSender: true })), false);
});

test("a re-file out of Important lowers the next score for that sender, and stops at the floor", () => {
  const base = facts({ addressing: "to", repliedCount: 10, lastRepliedAt: NOW - DAY, askText: "Can you confirm?", unansweredMs: 2 * DAY });
  const before = scoreAttention(base);
  assert.equal(before.band, "needs_you");
  const once = scoreAttention({ ...base, demotions: 1 });
  assert.equal(once.score, before.score + WEIGHTS.demotion);
  const twice = scoreAttention({ ...base, demotions: 2 });
  assert.equal(twice.score, before.score + 2 * WEIGHTS.demotion);
  assert.equal(scoreAttention({ ...base, demotions: 9 }).score, before.score + WEIGHTS.demotionFloor, "the penalty stops at the floor however many times he re-files");
  assert.ok(twice.score < once.score && once.score < before.score, "each re-file costs the sender something");
  assert.notEqual(twice.band, "needs_you", "two re-files take the sender out of Needs you");
});

test("bands at their edges: the score decides Important, and the model only speaks in the grey band", () => {
  // Addressing plus relationship is a clean dial: 18 plus a fresh tier lands exactly on each edge.
  const at = (score: number) => facts({ addressing: "to", repliedCount: 10, lastRepliedAt: NOW - DAY, askText: "x", unansweredMs: null, youAreInThread: score > 38 });
  const on = scoreAttention(facts({ addressing: "to", repliedCount: 10, lastRepliedAt: NOW - DAY, youAreInThread: false, askText: "" }));
  assert.equal(on.score, IMPORTANT_FLOOR - 2);
  assert.equal(on.band, "other");
  const over = scoreAttention(facts({ addressing: "to", repliedCount: 10, lastRepliedAt: NOW - DAY, unansweredMs: 2 * DAY }));
  assert.equal(over.score, IMPORTANT_FLOOR + 6);
  assert.equal(over.band, "important");
  assert.equal(at(40).accountId, "arcforma");

  // Exactly on the floor is Important; one point under is not.
  const onFloor = scoreAttention(facts({ addressing: "to", repliedCount: 10, lastRepliedAt: NOW - DAY, unansweredMs: 30 * DAY }));
  assert.equal(onFloor.score, IMPORTANT_FLOOR);
  assert.equal(onFloor.band, "important");

  // The grey band: the deterministic signals are undecided, so the local model's verdict is allowed in.
  const grey = facts({ addressing: "to", repliedCount: 3, lastRepliedAt: NOW - DAY, isFirstTimeSender: false });
  assert.equal(scoreAttention(grey).score, GREY_FLOOR + 2);
  assert.equal(scoreAttention(grey).band, "other");
  assert.equal(scoreAttention(grey, { modelSaidImportant: true }).band, "important");
  // Below the grey band the model is ignored, so a confident model cannot drag a newsletter back in.
  const low = facts({ addressing: "cc" });
  assert.ok(scoreAttention(low).score < GREY_FLOOR);
  assert.equal(scoreAttention(low, { modelSaidImportant: true }).band, "other");

  assert.equal(splitForBand("needs_you"), "important");
  assert.equal(splitForBand("important"), "important");
  assert.equal(splitForBand("other"), "other");
});

test("needs_you: a question he has already answered is not waiting on him", () => {
  const asked = facts({ senderEmail: "dana@northwind.example", senderName: "Dana Reyes", addressing: "to", repliedCount: 14, lastRepliedAt: NOW - 3 * DAY, youAreInThread: true, askText: "Can you confirm Thursday?", unansweredMs: 2 * DAY });
  const waiting = scoreAttention(asked);
  assert.equal(waiting.band, "needs_you");
  assert.equal(waiting.reason, "Dana asked a question, you have not replied in 2 days, and you have written to them 14 times");

  // The same thread after he answers: unansweredMs goes null and the row lets it go, score and all.
  const answered = scoreAttention({ ...asked, unansweredMs: null, lastOutboundAt: NOW - 3_600_000 });
  assert.equal(answered.band, "important", "still Important, because the relationship has not changed");
  assert.notEqual(answered.band, "needs_you");

  // Everything else the gate needs, one at a time.
  assert.notEqual(scoreAttention({ ...asked, askText: "Notes from today are attached." }).band, "needs_you", "nothing was asked");
  assert.notEqual(scoreAttention({ ...asked, addressing: "alias" }).band, "needs_you", "the message went to a group address");
  assert.notEqual(scoreAttention({ ...asked, isBulk: true }).band, "needs_you", "bulk mail never asks");
  assert.notEqual(scoreAttention({ ...asked, isAuto: true }).band, "needs_you", "software never asks");
  assert.notEqual(scoreAttention({ ...asked, senderEmail: "no-reply@northwind.example" }).band, "needs_you", "a no-reply address never asks");
  assert.notEqual(scoreAttention({ ...asked, type: "newsletters" }).band, "needs_you", "a thread with a mailbox type has a home already");
  assert.notEqual(scoreAttention({ ...asked, isOwnSender: true }).band, "needs_you", "his own mail never asks him for anything");
  // Cc counts, because he is still named on it.
  assert.equal(scoreAttention({ ...asked, addressing: "cc" }).band === "needs_you", scoreAttention({ ...asked, addressing: "cc" }).score >= NEEDS_YOU_FLOOR);
});

test("every verdict carries a sentence, in every band", () => {
  const needs = scoreAttention(facts({ senderName: "Jordin Hale", addressing: "to", repliedCount: 1, lastRepliedAt: NOW - DAY, askText: "Can you share these?", unansweredMs: 42 * DAY, isClientDomain: true, youAreInThread: true }));
  assert.equal(needs.band, "needs_you");
  assert.match(needs.reason, /^Jordin asked a question, you have not replied in 42 days, and you have written to them 1 time$/);

  const important = scoreAttention(facts({ senderName: "Mike", addressing: "to", repliedCount: 47, lastRepliedAt: NOW - DAY, youAreInThread: true }));
  assert.equal(important.band, "important");
  assert.match(important.reason, /^Important: you have written to them 47 times, you are in this thread, you are on To$/);

  const other = scoreAttention(facts({ senderEmail: "digest@weekly.example", isBulk: true, type: "newsletters", addressing: "to" }));
  assert.equal(other.band, "other");
  assert.match(other.reason, /^Other: filed under newsletters, bulk mail$/);

  const archived = scoreAttention(facts({ senderEmail: "shop@nordic.example", addressing: "to", senderThreads: 9, archiveWithoutReadRate: 0.95, threadsPerWeek: 4 }));
  assert.match(archived.reason, /you archive them unread/);
  assert.match(archived.reason, /threads a week from them/);

  // A first-time sender is named as one rather than counted at zero.
  const first = scoreAttention(facts({ senderName: "Ada", addressing: "to", isFirstTimeSender: true, repliedDomain: true, askText: "Could you take a look by Friday?", unansweredMs: 2 * DAY, isClientDomain: true, youAreInThread: true }));
  assert.equal(first.band, "needs_you");
  assert.match(first.reason, /this is their first mail to you$/);

  // No sentence anywhere quotes the message.
  for (const v of [needs, important, other, archived, first]) assert.equal(v.reason.includes("Can you share these"), false);
});

// ---- the golden set ------------------------------------------------------------

interface GoldenAttention {
  id: string;
  note: string;
  from: string;
  name?: string;
  subject: string;
  text?: string;
  addressing?: AttentionFacts["addressing"];
  repliedCount?: number;
  repliedDaysAgo?: number;
  repliedDomain?: boolean;
  clientDomain?: boolean;
  firstTime?: boolean;
  inThread?: boolean;
  startedByYou?: boolean;
  unansweredDays?: number | null;
  bulk?: boolean;
  auto?: boolean;
  ownSender?: boolean;
  type?: string | null;
  senderThreads?: number;
  threadsPerWeek?: number;
  archiveWithoutReadRate?: number;
  neverOpened?: boolean;
  demotions?: number;
  expect: "needs_you" | "important" | "other";
}

interface Golden {
  attention: GoldenAttention[];
}

const golden = JSON.parse(fs.readFileSync(path.join(here, "golden.json"), "utf8")) as Golden;

function goldenFacts(g: GoldenAttention): AttentionFacts {
  return facts({
    senderEmail: g.from,
    senderName: g.name ?? "",
    senderDomain: g.from.split("@")[1] ?? "",
    isOwnSender: g.ownSender === true,
    addressing: g.addressing ?? "to",
    repliedCount: g.repliedCount ?? 0,
    lastRepliedAt: g.repliedDaysAgo === undefined ? null : NOW - g.repliedDaysAgo * DAY,
    repliedDomain: g.repliedDomain === true,
    isClientDomain: g.clientDomain === true,
    isFirstTimeSender: g.firstTime === true,
    youAreInThread: g.inThread === true,
    youStartedThread: g.startedByYou === true,
    unansweredMs: g.unansweredDays === undefined || g.unansweredDays === null ? null : g.unansweredDays * DAY,
    askText: `${g.subject}\n${g.text ?? ""}`,
    isBulk: g.bulk === true,
    isAuto: g.auto === true,
    type: g.type ?? null,
    senderThreads: g.senderThreads ?? 1,
    threadsPerWeek: g.threadsPerWeek ?? 0.2,
    archiveWithoutReadRate: g.archiveWithoutReadRate ?? 0,
    neverOpened: g.neverOpened === true,
    demotions: g.demotions ?? 0,
  });
}

test("golden set: every labelled attention thread lands in the band it was labelled with", () => {
  assert.ok(golden.attention.length >= 15, `the attention golden set has ${golden.attention.length} threads, want at least 15`);
  for (const g of golden.attention) {
    const v = scoreAttention(goldenFacts(g));
    assert.equal(v.band, g.expect, `${g.id} (${g.note}): scored ${v.score}, reason "${v.reason}"`);
    assert.ok(v.reason.length > 0, `${g.id} carries a reason`);
  }
  // The set has to exercise all three bands, or it proves nothing about the boundaries.
  for (const band of ["needs_you", "important", "other"]) {
    assert.ok(golden.attention.some((g) => g.expect === band), `the set has at least one ${band} thread`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DraftRow } from "@arcforma/store";
import type { ThreadSummary } from "../shared/types.js";
import { DRAFT_PREFIX, draftIdOf, draftSummary, hasSubstance, isDraftThreadId, mergeDrafts } from "./drafted.js";

const me = { email: "you@example.com", name: "Oliver" };
const row = (over: Partial<DraftRow>): DraftRow =>
  ({ id: 7, account_id: "arcforma", thread_id: null, mode: "new", to_json: JSON.stringify([{ email: "dana@x.com", name: "Dana" }]), cc_json: "[]", bcc_json: "[]", subject: "Plan", body_html: "<p>Draft body here.</p>", quoted_html: "", in_reply_to: null, references_header: null, created_at: 1_000, updated_at: 9_000, ...over }) as DraftRow;
const thread = (id: string, sortAt: number): ThreadSummary =>
  ({ accountId: "arcforma", id, subject: id, snippet: "", participants: [], lastMessageAt: sortAt, sortAt, messageCount: 1, unread: false, starred: false, inInbox: true, hasAttachments: false, split: null, type: null, categoryId: null, attention: null, band: null, attentionReason: null, wakeAt: null, noReplyBy: null, queue: null, canUnsubscribe: false, unsubscribeState: null }) as ThreadSummary;

test("a draft row sits at the time it was started, not its last edit", () => {
  const s = draftSummary(row({}), me);
  assert.equal(s.id, `${DRAFT_PREFIX}7`);
  assert.equal(s.sortAt, 1_000, "created_at, so autosave cannot move it");
  assert.equal(s.lastMessageAt, 1_000);
  assert.deepEqual(s.draft, { draftId: 7, createdAt: 1_000 });
  assert.equal(s.participants[0]?.email, "dana@x.com");
  assert.equal(s.snippet, "Draft body here.");
  assert.equal(isDraftThreadId(s.id), true);
  assert.equal(draftIdOf(s.id), 7);
  assert.equal(draftIdOf("t-real"), null);
});

test("drafts interleave with threads by time, newest first", () => {
  const rows = [thread("t-new", 5_000), thread("t-old", 500)];
  const merged = mergeDrafts(rows, [row({ id: 1, created_at: 2_000 })], () => me);
  assert.deepEqual(merged.map((r) => r.id), ["t-new", "draft:1", "t-old"]);
});

test("a reply draft on a thread already listed marks that row instead of adding a second one", () => {
  const rows = [thread("t-kickoff", 5_000)];
  const merged = mergeDrafts(rows, [row({ id: 3, thread_id: "t-kickoff", mode: "reply", created_at: 6_000 })], () => me);
  assert.equal(merged.length, 1, "one conversation, one row");
  assert.deepEqual(merged[0]?.draft, { draftId: 3, createdAt: 6_000 });
});

test("no drafts means the page comes back untouched", () => {
  const rows = [thread("a", 2), thread("b", 1)];
  assert.equal(mergeDrafts(rows, [], () => me), rows);
});

test("a draft with nothing in it stays out of the inbox", () => {
  // Forty-eight imported drafts, many of them a recipient and a blank line, would have filled Everything.
  const empty = row({ id: 9, subject: "", to_json: "[]", cc_json: "[]", body_html: '<div dir="ltr"><br></div>' });
  assert.equal(hasSubstance(empty), false);
  assert.equal(mergeDrafts([thread("t", 1)], [empty], () => me).length, 1);
  assert.equal(hasSubstance(row({ subject: "", body_html: "", to_json: JSON.stringify([{ email: "a@b.c", name: "" }]) })), true, "someone on it counts");
  assert.equal(hasSubstance(row({ subject: "", to_json: "[]", body_html: "<p>half a thought</p>" })), true, "words count");
});

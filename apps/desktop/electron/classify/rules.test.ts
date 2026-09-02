import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyByRules, pickDecidingMessage, ruleInputFromRow, type RuleInput } from "./rules.js";
import type { MessageRow } from "@arcforma/store";

const here = path.dirname(fileURLToPath(import.meta.url));

interface GoldenMessage {
  id: string;
  from: string;
  subject: string;
  headers: Record<string, string>;
  hasCalendarPart?: boolean;
  body: string;
  label: { split: "important" | "other"; type: string | null };
  expect: { rules: { split: "important" | "other"; type: string | null } | null };
}

interface Golden {
  context: { repliedDomains: string[]; ownerAddresses: string[] };
  messages: GoldenMessage[];
}

const golden = JSON.parse(fs.readFileSync(path.join(here, "golden.json"), "utf8")) as Golden;
const ctx = { repliedDomains: new Set(golden.context.repliedDomains), ownerAddresses: new Set(golden.context.ownerAddresses) };

function input(m: Pick<GoldenMessage, "from" | "subject" | "headers" | "hasCalendarPart">, extra: Partial<RuleInput> = {}): RuleInput {
  const auto = /auto/i.test(m.headers["Auto-Submitted"] ?? "") || /^(mailer-daemon|no-?reply)@/i.test(m.from);
  return { fromEmail: m.from, subject: m.subject, headers: m.headers, hasCalendarPart: Boolean(m.hasCalendarPart), direction: "in", isAuto: auto, ...extra };
}

test("rules: list headers, calendar parts, receipts, notifications, replied domains", () => {
  assert.deepEqual(classifyByRules(input({ from: "digest@weekly.example", subject: "Hi", headers: { "List-Id": "x" } }), ctx), { split: "other", type: "newsletters", reason: "rule:newsletters" });
  assert.deepEqual(classifyByRules(input({ from: "team@figma.com", subject: "Hi", headers: { "List-Unsubscribe": "<mailto:x>" } }), ctx), { split: "other", type: "notifications", reason: "rule:notifications" });
  assert.equal(classifyByRules(input({ from: "dana@northwind-coaching.example", subject: "Invitation: Kickoff @ Tue", headers: {}, hasCalendarPart: true }), ctx).type, "calendar");
  // A person's reply that happens to carry an .ics is a conversation, not a calendar notice.
  assert.equal(classifyByRules(input({ from: "dana@northwind-coaching.example", subject: "Re: next session", headers: {}, hasCalendarPart: true }), ctx).type, null);
  assert.equal(classifyByRules(input({ from: "receipts@stripe.com", subject: "Receipt", headers: {} }), ctx).type, "receipts");
  assert.deepEqual(classifyByRules(input({ from: "dana@northwind-coaching.example", subject: "Notes", headers: {} }), ctx), { split: "important", type: null, reason: "rule:replied-domain" });
  assert.equal(classifyByRules(input({ from: "someone@gmail.com", subject: "Hi", headers: {} }), { repliedDomains: new Set(["gmail.com"]) }).split, null, "shared freemail domains never count as replied-to");
  assert.equal(classifyByRules(input({ from: "you@example.com", subject: "Hi", headers: {} }, { direction: "out" }), ctx).split, null, "outbound mail has no verdict");
  assert.equal(classifyByRules(input({ from: "you@example.com", subject: "Hi", headers: {} }), ctx).split, null, "mail from an owner address is not important by itself");
  assert.equal(classifyByRules(input({ from: "stranger@new.example", subject: "Hi", headers: {} }), ctx).split, null, "unknown people go to the model");
});

test("golden set: the rules layer alone resolves at least 60 percent, and never wrongly", () => {
  let resolved = 0;
  for (const m of golden.messages) {
    const v = classifyByRules(input(m), ctx);
    const got = v.split ? { split: v.split, type: v.type } : null;
    assert.deepEqual(got, m.expect.rules, `${m.id}: rules verdict`);
    if (got) {
      resolved += 1;
      assert.equal(got.split, m.label.split, `${m.id}: split matches the label`);
      assert.equal(got.type, m.label.type, `${m.id}: type matches the label`);
    }
  }
  const share = resolved / golden.messages.length;
  assert.equal(golden.messages.length, 20);
  assert.ok(share >= 0.6, `rules resolved ${resolved} of ${golden.messages.length} (${Math.round(share * 100)} percent), need 60`);
});

test("ruleInputFromRow reads stored headers, calendar attachments, and direction", () => {
  const row: MessageRow = {
    account_id: "a",
    id: "m",
    thread_id: "t",
    internal_date: 1,
    fts_id: 1,
    from_email: "dana@northwind-coaching.example",
    from_name: "Dana",
    to_json: "[]",
    cc_json: "[]",
    bcc_json: "[]",
    subject: "Invitation: Session 1 @ Tue Sep 8",
    snippet: "",
    message_id_header: null,
    in_reply_to: null,
    references_header: null,
    label_ids_json: "[]",
    headers_json: JSON.stringify({ "Content-Type": "multipart/mixed", "List-Id": "x" }),
    has_attachments: 1,
    size_estimate: null,
    is_auto: 0,
    sender_type: "person",
    direction: "in",
    history_id: null,
    updated_at: 1,
  };
  const ri = ruleInputFromRow(row, JSON.stringify([{ filename: "invite.ics", mimeType: "application/ics" }]));
  assert.equal(ri.hasCalendarPart, true);
  assert.equal(ri.headers["List-Id"], "x");
  assert.equal(classifyByRules(ri, ctx).type, "calendar", "a calendar part wins over list headers");
  assert.equal(ruleInputFromRow({ ...row, headers_json: "{}" }, "[]").hasCalendarPart, false);
});

test("pickDecidingMessage prefers the last inbound message", () => {
  const msgs = [{ id: 1, direction: "in" as const }, { id: 2, direction: "out" as const }, { id: 3, direction: "in" as const }, { id: 4, direction: "out" as const }];
  assert.equal(pickDecidingMessage(msgs)!.id, 3);
  assert.equal(pickDecidingMessage([{ id: 9, direction: "out" as const }])!.id, 9);
  assert.equal(pickDecidingMessage([]), null);
});

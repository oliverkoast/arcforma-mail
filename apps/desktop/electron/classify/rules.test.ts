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
  /** The thread already carries a message Oliver sent, which makes the sender a person. */
  threadHasOutbound?: boolean;
  body: string;
  label: { split: "important" | "other"; type: string | null };
  expect: { rules: { split: "important" | "other"; type: string | null } | null };
}

interface Golden {
  context: { repliedDomains: string[]; sentAddresses: string[]; ownerAddresses: string[] };
  messages: GoldenMessage[];
}

const golden = JSON.parse(fs.readFileSync(path.join(here, "golden.json"), "utf8")) as Golden;
const ctx = { repliedDomains: new Set(golden.context.repliedDomains), repliedAddresses: new Set(golden.context.sentAddresses), ownerAddresses: new Set(golden.context.ownerAddresses) };

function input(m: Pick<GoldenMessage, "from" | "subject" | "headers" | "hasCalendarPart" | "threadHasOutbound">, extra: Partial<RuleInput> = {}): RuleInput {
  const auto = /auto/i.test(m.headers["Auto-Submitted"] ?? "") || /^(mailer-daemon|no-?reply)@/i.test(m.from);
  return { fromEmail: m.from, subject: m.subject, headers: m.headers, hasCalendarPart: Boolean(m.hasCalendarPart), direction: "in", isAuto: auto, threadHasOutbound: m.threadHasOutbound === true, ...extra };
}

/** The same message with every person signal taken away, to show which signal did the work. */
function withoutPersonSignals(m: GoldenMessage): RuleInput {
  return input({ ...m, threadHasOutbound: false, subject: m.subject.replace(/^\s*(re|fwd?)\s*:\s*/i, "") });
}
const noHistory = { repliedDomains: ctx.repliedDomains, ownerAddresses: ctx.ownerAddresses };

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

test("golden set: the rules layer alone resolves at least 75 percent, and never wrongly", () => {
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
  assert.ok(golden.messages.length >= 40, `the golden set has ${golden.messages.length} messages, want at least 40`);
  // The old rules cleared 60 percent by sending everything with a list header to Newsletters. The
  // six types earn the same share honestly, so the bar goes up rather than staying where it was.
  assert.ok(share >= 0.75, `rules resolved ${resolved} of ${golden.messages.length} (${Math.round(share * 100)} percent), need 75`);
});

test("people beat headers: each of the four person signals stops a bulk type on its own", () => {
  const byId = new Map(golden.messages.map((m) => [m.id, m]));
  const freemail = byId.get("g21")!;
  const known = byId.get("g22")!;
  const outbound = byId.get("g23")!;
  const replyPrefix = byId.get("g24")!;

  // A hiring inbox run as a mailing list stamps List-Id on every applicant. The old rule read that
  // as a newsletter; the sender is a person, so no type is allowed to stick.
  assert.equal(classifyByRules(input(freemail), ctx).type, null, "a freemail sender is a person");
  // A role local part is never a person, even at a freemail domain, so the hiring list can still type it.
  assert.equal(classifyByRules(input({ ...freemail, from: "talent@gmail.com" }), ctx).type, "jobs");

  assert.equal(classifyByRules(input(known), ctx).type, null, "an address Oliver has written to belongs to a person");
  assert.equal(classifyByRules(withoutPersonSignals(known), noHistory).type, "newsletters", "without that history the same message is bulk mail");

  assert.equal(classifyByRules(input(outbound), ctx).type, null, "a thread Oliver has already written in holds a conversation");
  assert.equal(classifyByRules(withoutPersonSignals(outbound), ctx).type, "newsletters", "without the outbound message it is bulk mail");

  assert.equal(classifyByRules(input(replyPrefix), ctx).type, null, "a Re: subject is a reply to something Oliver sent");
  assert.equal(classifyByRules(withoutPersonSignals(replyPrefix), ctx).type, "newsletters", "without the Re: prefix it is bulk mail");

  // The override never costs a message its split: these four still land in Important.
  for (const m of [known, outbound, replyPrefix]) assert.equal(classifyByRules(input(m), ctx).split, "important", `${m.id} still reaches the split rules`);
});

test("the six types: each one has a rule, and the ambiguous cases go to the model", () => {
  const t = (from: string, subject: string, headers: Record<string, string> = {}) => classifyByRules(input({ from, subject, headers }), ctx).type;

  assert.equal(t("editor@long-reads.example", "Issue 41", { "List-Id": "<long-reads.example>" }), "newsletters");
  assert.equal(t("noreply@news.harbor-journal.example", "Markets Daily", { "List-Unsubscribe": "<mailto:x>" }), "newsletters", "a publication keeps its type through a no-reply address");
  assert.equal(t("shop@nordic-outfitters.example", "The autumn range", { "List-Unsubscribe": "<mailto:x>" }), "promotions", "the sender is a shop");
  assert.equal(t("hello@lumen-events.example", "Register now for the September webinar", { "List-Unsubscribe": "<mailto:x>" }), "promotions", "the subject is selling");
  assert.equal(t("talent@wellfound.com", "Avery Nolan is interested in AI Engineer", { "List-Unsubscribe": "<mailto:x>" }), "jobs", "a hiring platform");
  assert.equal(t("regis@sway-collective.example", "CV attached", { "List-Id": "<jobs.arcforma.example>" }), "jobs", "a hiring inbox run as a list");
  assert.equal(t("pat@denosys-labs.example", "Full-stack CV for your open role"), "jobs", "a subject about an application");
  assert.equal(t("dana@northwind-coaching.example", "Invitation: Kickoff", { "Content-Type": "text/calendar" }), null, "a calendar part needs the attachment flag");
  assert.equal(classifyByRules(input({ from: "calendar-notification@google.com", subject: "Invitation: Kickoff", headers: {}, hasCalendarPart: true }), ctx).type, "calendar");
  assert.equal(t("support@e.usa.experian.com", "Your credit report has an update", { "List-Unsubscribe": "<mailto:x>" }), "notifications", "a platform subdomain");
  assert.equal(t("security@vault-id.example", "New sign-in from a new device"), "notifications", "a notifier local part off the known platforms");
  assert.equal(t("gustonoreply@gusto.com", "Your payroll is ready", { "List-Unsubscribe": "<mailto:x>" }), "notifications", "no-reply buried in a longer local part still reads as no-reply");
  assert.equal(t("billing@mercury.com", "Your statement is ready"), "receipts");

  // A platform address with a marketing subject is neither plainly a notification nor plainly a
  // promotion. Guessing would be worse than asking the model.
  assert.equal(t("workspace-noreply@google.com", "Get paid by referring Google Workspace", { "List-Unsubscribe": "<mailto:x>" }), null);
  assert.equal(t("updates@e.stripe.com", "Save on your next payout with Capital", { "List-Unsubscribe": "<mailto:x>" }), null);
  assert.equal(t("hello@mail.wispr-tools.example", "We redesigned the mobile app", { "List-Unsubscribe": "<mailto:x>" }), null, "bulk mail with no editorial and no selling shape");
  // A shop that happens to sit on a platform domain is still a shop.
  assert.equal(t("microsoftstore@microsoftstore.microsoft.com", "Get a school-ready Surface", { "List-Unsubscribe": "<mailto:x>" }), "promotions");
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
  assert.equal(ri.threadHasOutbound, false, "the thread flag defaults off, so a caller has to look it up");
  assert.equal(ruleInputFromRow(row, "[]", true).threadHasOutbound, true);
  assert.equal(classifyByRules(ri, ctx).type, "calendar", "a calendar part wins over list headers");
  assert.equal(ruleInputFromRow({ ...row, headers_json: "{}" }, "[]").hasCalendarPart, false);
});

test("pickDecidingMessage prefers the last inbound message", () => {
  const msgs = [{ id: 1, direction: "in" as const }, { id: 2, direction: "out" as const }, { id: 3, direction: "in" as const }, { id: 4, direction: "out" as const }];
  assert.equal(pickDecidingMessage(msgs)!.id, 3);
  assert.equal(pickDecidingMessage([{ id: 9, direction: "out" as const }])!.id, 9);
  assert.equal(pickDecidingMessage([]), null);
});

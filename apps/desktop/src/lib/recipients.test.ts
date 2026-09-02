import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseNames, describeRecipients, initials, messageEyebrow, relativeTime, showSenderAddress } from "./recipients";
import type { Address } from "../../shared/types";

const OWNERS = ["you@example.com", "you@example.net", "you@gmail.com"];

function a(email: string, name = ""): Address {
  return { email, name };
}

const OLIVER = a("you@example.com", "Oliver Korzen");
const DANA = a("dana@northwind-coaching.example", "Dana Reyes");
const PRIYA = a("priya@northwind-coaching.example", "Priya Natarajan");
const SAM = a("sam@harbor-legal.example", "Sam Okafor");
const MIKA = a("mika@lumen-studio.example", "Mika Ruiz");
const CASEY = a("casey@applicant.example", "Casey Lin");

test("the recipient line names you first and collapses the rest", () => {
  assert.equal(describeRecipients([OLIVER], [], [], OWNERS).text, "to you");
  assert.equal(describeRecipients([OLIVER, DANA], [], [], OWNERS).text, "to you and Dana");
  assert.equal(describeRecipients([DANA, OLIVER], [], [], OWNERS).text, "to you and Dana", "the owner leads whatever order the header used");
  assert.equal(describeRecipients([OLIVER, DANA, PRIYA, SAM, MIKA], [], [], OWNERS).text, "to you and 4 others");
  assert.equal(describeRecipients([DANA, PRIYA, SAM, MIKA, CASEY], [], [], OWNERS).text, "to Dana and 4 others");
  assert.equal(describeRecipients([DANA], [], [], OWNERS).text, "to Dana");
  assert.equal(describeRecipients([DANA, PRIYA], [], [], OWNERS).text, "to Dana and Priya");
});

test("cc is its own segment and collapses the same way", () => {
  const one = describeRecipients([OLIVER], [PRIYA], [], OWNERS);
  assert.equal(one.to, "you");
  assert.equal(one.cc, "Priya");
  assert.equal(one.text, "to you, cc Priya");
  const many = describeRecipients([DANA], [OLIVER, PRIYA, SAM, MIKA], [], OWNERS);
  assert.equal(many.text, "to Dana, cc you and 3 others");
  // Copied only: the To line still reads for the person who is on it.
  const ccOnly = describeRecipients([], [OLIVER, DANA], [], OWNERS);
  assert.equal(ccOnly.to, "");
  assert.equal(ccOnly.text, "cc you and Dana");
});

test("a message with no recipients says so, and one address is never named twice", () => {
  const none = describeRecipients([], [], [], OWNERS);
  assert.equal(none.text, "No recipients");
  assert.deepEqual(none.rows, []);
  const dup = describeRecipients([DANA], [DANA, PRIYA], [], OWNERS);
  assert.equal(dup.text, "to Dana, cc Priya");
  assert.deepEqual(dup.rows.map((r) => `${r.group} ${r.email}`), ["To dana@northwind-coaching.example", "Cc priya@northwind-coaching.example"]);
});

test("the expanded rows carry every address, grouped, with you for the owner's own", () => {
  const d = describeRecipients([OLIVER, DANA], [PRIYA], [a("legal@northwind-coaching.example")], OWNERS);
  assert.deepEqual(
    d.rows.map((r) => [r.group, r.label, r.email, r.you]),
    [
      ["To", "you", "you@example.com", true],
      ["To", "Dana Reyes", "dana@northwind-coaching.example", false],
      ["Cc", "Priya Natarajan", "priya@northwind-coaching.example", false],
      ["Bcc", "legal@northwind-coaching.example", "legal@northwind-coaching.example", false],
    ]
  );
  // A bcc of the owner reads "you" too, and the line counts it.
  const blind = describeRecipients([DANA], [], [a("you@example.net", "Oliver")], OWNERS);
  assert.equal(blind.rows.at(-1)?.label, "you");
  assert.equal(blind.rows.at(-1)?.group, "Bcc");
  assert.equal(blind.text, "to Dana", "bcc stays out of the collapsed line");
});

test("names fall back to the address when the header carried none", () => {
  assert.equal(describeRecipients([a("billing@render.com")], [], [], OWNERS).text, "to billing");
  assert.equal(describeRecipients([a("dana@x.example", "dana@x.example")], [], [], OWNERS).text, "to dana");
  assert.equal(collapseNames([]), "");
  assert.equal(collapseNames(["a", "b", "c", "d"]), "a and 3 others");
});

test("initials take two letters from the name, else from the address", () => {
  assert.equal(initials("Dana Reyes", "dana@x.example"), "DR");
  assert.equal(initials("Dana", "dana@x.example"), "DA");
  assert.equal(initials("", "dana.reyes@x.example"), "DR");
  assert.equal(initials("", "billing@render.com"), "BI");
  assert.equal(initials("dana@x.example", "dana@x.example"), "DA");
  assert.equal(initials("", "d@x.example"), "D");
  assert.equal(initials("  ", ""), "?");
  assert.equal(initials("oliver korzen", "you@example.com"), "OK");
});

test("relative time reads in whole units and never rounds up past the truth", () => {
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  const ago = (ms: number) => relativeTime(now - ms, now);
  assert.equal(ago(0), "just now");
  assert.equal(ago(30_000), "just now");
  assert.equal(ago(60_000), "1 minute ago");
  assert.equal(ago(20 * 60_000), "20 minutes ago");
  assert.equal(ago(2 * 3_600_000), "2 hours ago");
  assert.equal(ago(90 * 60_000), "1 hour ago");
  assert.equal(ago(26 * 3_600_000), "1 day ago");
  assert.equal(ago(3 * 86_400_000), "3 days ago");
  assert.equal(ago(10 * 86_400_000), "1 week ago");
  assert.equal(ago(60 * 86_400_000), "2 months ago");
  assert.equal(ago(800 * 86_400_000), "2 years ago");
  assert.equal(relativeTime(now + 2 * 3_600_000, now), "in 2 hours");
  assert.equal(relativeTime(now + 1_000, now), "in a moment");
});

test("the eyebrow says only what is worth knowing about the addressing", () => {
  assert.equal(messageEyebrow({ from: DANA, to: [OLIVER], cc: [], direction: "in" }, OWNERS), "Only to you");
  assert.equal(messageEyebrow({ from: DANA, to: [OLIVER, PRIYA], cc: [], direction: "in" }, OWNERS), null);
  assert.equal(messageEyebrow({ from: DANA, to: [PRIYA], cc: [OLIVER], direction: "in" }, OWNERS), "You are cc");
  assert.equal(messageEyebrow({ from: DANA, to: [OLIVER], cc: [OLIVER], direction: "in" }, OWNERS), "Only to you");
  assert.equal(messageEyebrow({ from: OLIVER, to: [DANA], cc: [], direction: "out" }, OWNERS), "Sent by you");
  assert.equal(messageEyebrow({ from: OLIVER, to: [DANA], cc: [], direction: "in" }, OWNERS), "Sent by you", "a message from one of the owner's own addresses is his, whatever the label says");
  assert.equal(messageEyebrow({ from: DANA, to: [PRIYA], cc: [SAM], direction: "in" }, OWNERS), null);
});

test("the sender's address shows only when it adds something", () => {
  assert.equal(showSenderAddress(DANA, false), true);
  assert.equal(showSenderAddress(DANA, true), false, "a repeat message from the same person needs the address once");
  assert.equal(showSenderAddress(a("billing@render.com"), false), false, "no name, so the address is already the line");
  assert.equal(showSenderAddress(a("billing@render.com", "billing@render.com"), false), false);
});

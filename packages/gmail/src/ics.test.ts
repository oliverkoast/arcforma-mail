import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs, parseIcsDate, findCalendarText } from "./ics.js";

const INVITE = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:abc123@google.com",
  "SEQUENCE:2",
  "DTSTART;TZID=America/Los_Angeles:20260914T090000",
  "DTEND;TZID=America/Los_Angeles:20260914T100000",
  "SUMMARY:ICA x Arcforma \\, AI Partner",
  "LOCATION:600 Congress Ave\\, Austin",
  "DESCRIPTION:Agenda:\\n1. Scope\\n2. Pricing",
  "ORGANIZER;CN=Bailey Zelnik:mailto:bailey@infinitycreativeagency.com",
  "ATTENDEE;CN=Oliver Korzen;PARTSTAT=NEEDS-ACTION:mailto:oliver@arcforma.ai",
  "ATTENDEE;CN=Miranda Tosches;PARTSTAT=ACCEPTED:mailto:miranda.t@infinitycreativeagency.com",
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("an invitation gives up what a person needs to decide whether to go", () => {
  const e = parseIcs(INVITE);
  assert.ok(e);
  assert.equal(e.method, "REQUEST");
  assert.equal(e.summary, "ICA x Arcforma , AI Partner", "escaped commas come back as commas");
  assert.equal(e.location, "600 Congress Ave, Austin");
  assert.equal(e.description, "Agenda:\n1. Scope\n2. Pricing", "escaped newlines are newlines");
  assert.equal(e.organizer?.email, "bailey@infinitycreativeagency.com");
  assert.equal(e.organizer?.name, "Bailey Zelnik");
  assert.equal(e.attendees.length, 2);
  assert.equal(e.attendees[1]?.status, "ACCEPTED");
  assert.equal(e.recurrence, "FREQ=WEEKLY;BYDAY=MO");
  assert.equal(e.sequence, 2, "above zero means this is a revision, not a first ask");
  assert.equal(e.uid, "abc123@google.com");
});

test("a folded line is read whole", () => {
  // Lines wrap at 75 octets and continue with a space. Unfolding wrong truncates the title.
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Quarterly planning with the\r\n  whole partnerships team\r\nEND:VEVENT\r\nEND:VCALENDAR";
  assert.equal(parseIcs(ics)?.summary, "Quarterly planning with the whole partnerships team");
});

test("a UTC time and a floating time are told apart", () => {
  assert.equal(parseIcsDate("20260914T160000Z", new Map()).at, Date.UTC(2026, 8, 14, 16, 0, 0));
  const floating = parseIcsDate("20260914T090000", new Map()).at;
  assert.equal(floating, new Date(2026, 8, 14, 9, 0, 0).getTime(), "no zone means local, which is what a calendar client does");
});

test("an all-day event gets a date and no clock time", () => {
  const d = parseIcsDate("20260914", new Map([["VALUE", "DATE"]]));
  assert.equal(d.allDay, true);
  assert.equal(d.at, new Date(2026, 8, 14).getTime());
});

test("a cancellation is recognisable as one", () => {
  const ics = "BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nSTATUS:CANCELLED\r\nSUMMARY:Kickoff\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const e = parseIcs(ics);
  assert.equal(e?.method, "CANCEL");
  assert.equal(e?.status, "CANCELLED");
});

test("anything that is not a calendar is not one", () => {
  assert.equal(parseIcs(""), null);
  assert.equal(parseIcs("<p>Hello</p>"), null);
  assert.equal(parseIcs("BEGIN:VCALENDAR\r\nEND:VCALENDAR"), null, "a calendar with no event is nothing to show");
});

test("garbage does not throw, it comes back empty", () => {
  // A malformed invitation must degrade to the message body, never break the reading pane.
  const e = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Nowhere:not-a-date\r\nSEQUENCE:x\r\nEND:VEVENT");
  assert.equal(e?.startsAt, null);
  assert.equal(e?.sequence, 0);
});

test("the calendar part is found wherever it is nested, with or without a filename", () => {
  const decode = (d: string) => Buffer.from(d, "base64url").toString("utf8");
  const enc = (s: string) => Buffer.from(s).toString("base64url");
  const nested = { mimeType: "multipart/mixed", parts: [{ mimeType: "text/html", body: { data: enc("<p>hi</p>") } }, { mimeType: "multipart/alternative", parts: [{ mimeType: 'text/calendar; method=REQUEST', body: { data: enc(INVITE) } }] }] };
  assert.match(findCalendarText(nested, decode) ?? "", /BEGIN:VEVENT/);
  const byName = { mimeType: "multipart/mixed", parts: [{ mimeType: "application/octet-stream", filename: "invite.ics", body: { data: enc(INVITE) } }] };
  assert.match(findCalendarText(byName, decode) ?? "", /BEGIN:VEVENT/);
  assert.equal(findCalendarText({ mimeType: "text/plain", body: { data: enc("hi") } }, decode), null);
});

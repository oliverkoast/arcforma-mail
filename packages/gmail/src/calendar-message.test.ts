import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailClient } from "./client.js";
import { listAttachments } from "./mime.js";
import { readCalendarMessage } from "./calendar-message.js";

const reply = "BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nSUMMARY:Project meeting\r\nDTSTART:20260910T210000Z\r\nDTEND:20260910T220000Z\r\nATTENDEE;CN=David;PARTSTAT=ACCEPTED:mailto:david@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR";
const bytes = Buffer.from(reply);
const part = { mimeType: "text/calendar", filename: "invite.ics", body: { attachmentId: "file", size: bytes.length } };
test("attachment-backed calendar reply loads event details, including for a previously cached body", async () => {
  const calls: string[] = [];
  const client = new GmailClient({ accessToken: async () => "fake", transport: async (url) => {
    calls.push(url);
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: bytes.toString("base64url"), size: bytes.length }) };
  } });
  for (const payload of [part, null]) {
    const event = await readCalendarMessage(client, "msg", payload, listAttachments(part));
    assert.equal(event?.method, "REPLY");
    assert.equal(event?.summary, "Project meeting");
    assert.equal(event?.attendees[0]?.status, "ACCEPTED");
    assert.equal(event?.startsAt, Date.UTC(2026, 8, 10, 21));
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.endsWith("messages/msg/attachments/file")));
});
test("inline invite needs no extra request; a failed attachment remains retryable", async () => {
  const client = new GmailClient({ accessToken: async () => "fake", transport: async () => { throw new Error("offline"); } });
  const inline = { ...part, body: { data: bytes.toString("base64url") } };
  assert.equal((await readCalendarMessage(client, "msg", inline, []))?.method, "REPLY");
  await assert.rejects(readCalendarMessage(client, "msg", null, listAttachments(part)), /offline/);
});

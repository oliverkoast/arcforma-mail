import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getReplyOptions, openStore, upsertAccount, upsertThreadFromGmail, type Db } from "@arcforma/store";
import { AiClient, type FetchLike } from "./client.js";
import { cleanOutput, instantReplies, wantsInstantReplies } from "./features.js";

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-features-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  return db;
}

function configFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-ai-"));
  const file = path.join(dir, "ai-daemon.json");
  fs.writeFileSync(file, JSON.stringify({ port: 4321, token: "secret" }));
  return file;
}

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

function message(id: string, from: string, date: number, extra: Array<{ name: string; value: string }> = []) {
  return {
    id,
    threadId: "t1",
    labelIds: ["INBOX"],
    internalDate: String(date),
    snippet: "snippet",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: "you@example.com" }, { name: "Subject", value: "Kickoff" }, ...extra] },
  };
}

function seed(db: Db, messages: ReturnType<typeof message>[]): void {
  upsertThreadFromGmail(db, "arcforma", { id: "t1", historyId: "1", messages }, { ownerAddresses: ["you@example.com"] });
}

function ai(): { ai: AiClient; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return { status: 200, text: async () => JSON.stringify({ ok: true, text: "", json: { replies: ["Yes, Tuesday works.", "Let me check and come back to you.", "Can we do Wednesday instead?"] }, model: "m", latencyMs: 2, engine: "claude" }) };
  };
  return { ai: new AiClient({ configFile: configFile(), fetch }), urls };
}

test("instant replies only for an inbound, non-automated message that is still last in the thread", async () => {
  const db = tempDb();
  seed(db, [message("m1", "Dana <dana@northwind.example>", T0), message("m2", "Oliver Korzen <you@example.com>", T0 + 1000)]);
  const a = ai();
  const outbound = await instantReplies(db, a.ai, "arcforma", "m2");
  assert.equal(outbound.ok, false, "the last message is Oliver's own");
  const stale = await instantReplies(db, a.ai, "arcforma", "m1");
  assert.equal(stale.ok, false, "m1 is no longer the last message");
  assert.deepEqual(a.urls, [], "Claude was not called for either");

  seed(db, [message("m1", "Dana <dana@northwind.example>", T0), message("m2", "Oliver Korzen <you@example.com>", T0 + 1000), message("m3", "noreply@northwind.example", T0 + 2000, [{ name: "Auto-Submitted", value: "auto-replied" }])]);
  const auto = await instantReplies(db, a.ai, "arcforma", "m3");
  assert.equal(auto.ok, false, "an auto-reply gets no instant replies");
  assert.deepEqual(a.urls, []);

  seed(db, [message("m1", "Dana <dana@northwind.example>", T0), message("m4", "Dana <dana@northwind.example>", T0 + 3000)]);
  const fresh = await instantReplies(db, a.ai, "arcforma", "m4");
  assert.equal(fresh.ok, true);
  assert.equal(a.urls.length, 1);
  assert.match(a.urls[0]!, /\/v1\/complete$/);
  assert.deepEqual(getReplyOptions(db, "arcforma", "m4")?.length, 3, "cached by message id");
  const again = await instantReplies(db, a.ai, "arcforma", "m4");
  assert.equal(again.ok && again.cached, true);
  assert.equal(a.urls.length, 1, "the cache answered the second call");
});

test("wantsInstantReplies reads direction, automation, and position", () => {
  const rows = (dir: "in" | "out", auto: number) => [{ id: "a", direction: "out" as const, is_auto: 0 }, { id: "b", direction: dir, is_auto: auto }];
  assert.equal(wantsInstantReplies(rows("in", 0) as never, "b"), true);
  assert.equal(wantsInstantReplies(rows("in", 1) as never, "b"), false);
  assert.equal(wantsInstantReplies(rows("out", 0) as never, "b"), false);
  assert.equal(wantsInstantReplies(rows("in", 0) as never, "a"), false);
  assert.equal(wantsInstantReplies([], "a"), false);
});

// Inputs are written as escapes so this file itself carries no em dash and no emoji.
test("cleanOutput removes dashes and every kind of emoji before anything is shown", () => {
  assert.equal(cleanOutput("Tuesday works \u2014 see you then"), "Tuesday works, see you then");
  assert.equal(cleanOutput("Tuesday works\u2014see you then"), "Tuesday works, see you then");
  assert.equal(cleanOutput("Great news \u{1F389} let's go \u{1F680}"), "Great news let's go");
  assert.equal(cleanOutput("Done \u2705 and starred \u2B50 at \u23F0 nine"), "Done and starred at nine");
  assert.equal(cleanOutput("Thumbs \u{1F44D}\u{1F3FD} up"), "Thumbs up", "skin tone modifiers go with the base");
  assert.equal(cleanOutput("Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} time"), "Family time", "zero-width joiner sequences vanish whole");
  assert.equal(cleanOutput("Option 1\uFE0F\u20E3 or 2\uFE0F\u20E3"), "Option 1 or 2", "keycaps leave the digit");
  assert.equal(cleanOutput("Arcforma® and Form™ stay © 2026"), "Arcforma® and Form™ stay © 2026", "ordinary symbols are not emoji");
});

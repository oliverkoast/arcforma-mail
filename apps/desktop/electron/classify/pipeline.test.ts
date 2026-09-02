import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getClassification, openStore, upsertAccount, upsertThreadFromGmail, type Db } from "@arcforma/store";
import { AiClient, type FetchLike } from "../ai/client.js";
import { Classifier, classifyThread } from "./pipeline.js";

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-classify-"));
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

/** A person writing about work: no header rule applies, so the local model has to decide. */
function residueThread(id: string, date = Date.now() - 60_000) {
  return {
    id,
    historyId: "1",
    messages: [
      {
        id: `${id}-m1`,
        threadId: id,
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(date),
        snippet: "Can we move the kickoff to Tuesday?",
        payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Dana Reyes <dana@northwind.example>" }, { name: "To", value: "you@example.com" }, { name: "Subject", value: "Kickoff timing" }] },
      },
    ],
  };
}

function fakeFetch(handler: (url: string) => { status: number; body: unknown } | Error): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const r = handler(url);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, urls };
}

const ctx = { repliedDomains: new Set<string>(), ownerAddresses: new Set(["you@example.com"]) };

test("the residue goes to /v1/classify only; background classification never calls Claude", async () => {
  const db = tempDb();
  upsertThreadFromGmail(db, "arcforma", residueThread("t1"), { ownerAddresses: ["you@example.com"] });
  const { fetch, urls } = fakeFetch((url) => (url.endsWith("/v1/classify") ? { status: 200, body: { ok: true, json: { split: "important", type: "none", category: "none", confidence: 0.91 }, text: "", latencyMs: 3 } } : { status: 500, body: { ok: false, error: "wrong endpoint" } }));
  const ai = new AiClient({ configFile: configFile(), fetch });
  const out = await classifyThread(db, ai, "arcforma", "t1", ctx);
  assert.deepEqual(out, { split: "important", type: null, categoryId: null, confidence: 0.91, source: "local" });
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ["/v1/classify"]);
  assert.equal(urls.some((u) => u.includes("/v1/complete")), false);
});

test("below the 0.55 floor the thread stays Other with no category", async () => {
  const db = tempDb();
  upsertThreadFromGmail(db, "arcforma", residueThread("t1"), { ownerAddresses: ["you@example.com"] });
  const { fetch } = fakeFetch(() => ({ status: 200, body: { ok: true, json: { split: "important", type: "none", category: "none", confidence: 0.54 }, text: "", latencyMs: 3 } }));
  const ai = new AiClient({ configFile: configFile(), fetch });
  const out = await classifyThread(db, ai, "arcforma", "t1", ctx);
  assert.equal(out?.split, "other");
  assert.equal(out?.categoryId, null);
});

test("the background classifier backs off after a daemon error instead of hammering it", async () => {
  const db = tempDb();
  upsertThreadFromGmail(db, "arcforma", residueThread("t1"), { ownerAddresses: ["you@example.com"] });
  upsertThreadFromGmail(db, "arcforma", residueThread("t2"), { ownerAddresses: ["you@example.com"] });
  const { fetch, urls } = fakeFetch(() => Object.assign(new Error("connect ECONNREFUSED"), { name: "FetchError" }));
  const ai = new AiClient({ configFile: configFile(), fetch });
  const changed: string[] = [];
  const classifier = new Classifier(db, ai, () => ["you@example.com"], (ids) => changed.push(...ids));
  classifier.poke();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(urls.length, 1, "the pass stops at the first daemon error");
  classifier.poke();
  classifier.poke();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(urls.length, 1, "pokes during the pause do not reach the daemon");
  assert.equal(getClassification(db, "arcforma", "t1"), null, "nothing was written on the failed pass");
  assert.deepEqual(changed, []);
  classifier.stop();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attentionContext, getClassification, getSetting, listThreadMessages, openStore, setSetting, upsertAccount, upsertClassification, upsertThreadFromGmail, type Db } from "@arcforma/store";
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

/** The classifier context, with the attention half read from whichever store the test just built. */
const ctxOf = (db: Db) => ({ repliedDomains: new Set<string>(), repliedAddresses: new Set<string>(), ownerAddresses: new Set(["you@example.com"]), attention: attentionContext(db) });

/** One inbound message the header rules can type on their own. */
function ruledThread(id: string, from: string, subject: string, headers: Record<string, string> = {}, hoursAgo = 1) {
  return {
    id,
    historyId: "1",
    messages: [
      {
        id: `${id}-m1`,
        threadId: id,
        labelIds: ["INBOX"],
        internalDate: String(Date.now() - hoursAgo * 3_600_000),
        snippet: subject,
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: from }, { name: "To", value: "you@example.com" }, { name: "Subject", value: subject }, ...Object.entries(headers).map(([name, value]) => ({ name, value }))],
        },
      },
    ],
  };
}

test("the residue goes to /v1/classify only; background classification never calls Claude", async () => {
  const db = tempDb();
  upsertThreadFromGmail(db, "arcforma", residueThread("t1"), { ownerAddresses: ["you@example.com"] });
  const { fetch, urls } = fakeFetch((url) => (url.endsWith("/v1/classify") ? { status: 200, body: { ok: true, json: { split: "important", type: "none", category: "none", confidence: 0.91 }, text: "", latencyMs: 3 } } : { status: 500, body: { ok: false, error: "wrong endpoint" } }));
  const ai = new AiClient({ configFile: configFile(), fetch });
  const out = await classifyThread(db, ai, "arcforma", "t1", ctxOf(db));
  // The model names the type; the attention model decides the split, and Dana asking a question of a
  // thread addressed to him alone is Important with a reason attached.
  assert.equal(out?.type, null);
  assert.equal(out?.categoryId, null);
  assert.equal(out?.confidence, 0.91);
  assert.equal(out?.source, "local");
  assert.equal(out?.split, "important");
  assert.ok((out?.attention ?? 0) > 0, "the verdict carries an attention score");
  assert.ok(out?.reason, "the verdict carries a reason");
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ["/v1/classify"]);
  assert.equal(urls.some((u) => u.includes("/v1/complete")), false);
});

test("below the 0.55 floor the thread stays Other with no category", async () => {
  const db = tempDb();
  upsertThreadFromGmail(db, "arcforma", residueThread("t1"), { ownerAddresses: ["you@example.com"] });
  const { fetch } = fakeFetch(() => ({ status: 200, body: { ok: true, json: { split: "important", type: "none", category: "none", confidence: 0.54 }, text: "", latencyMs: 3 } }));
  const ai = new AiClient({ configFile: configFile(), fetch });
  const out = await classifyThread(db, ai, "arcforma", "t1", ctxOf(db));
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

test("a rules version bump re-decides every rule verdict and leaves model verdicts and corrections alone", async () => {
  const db = tempDb();
  const owners = { ownerAddresses: ["you@example.com"] };
  // Filed as a newsletter by the old rules because it carried List-Unsubscribe. It is hiring mail.
  upsertThreadFromGmail(db, "arcforma", ruledThread("t-jobs", "talent@wellfound.com", "Avery is interested in AI Engineer", { "List-Unsubscribe": "<mailto:x>" }), owners);
  // Filed as a newsletter by the old rules because the hiring inbox is a mailing list. A person wrote it.
  upsertThreadFromGmail(db, "arcforma", ruledThread("t-person", "avery@gmail.com", "AI engineer, available from October", { "List-Id": "<jobs.arcforma.example>" }), owners);
  // The model's own verdict, and a verdict the user set by re-filing. Neither is the rules' to touch.
  upsertThreadFromGmail(db, "arcforma", ruledThread("t-model", "editor@long-reads.example", "Issue 41", { "List-Id": "<long-reads.example>" }), owners);
  upsertThreadFromGmail(db, "arcforma", ruledThread("t-manual", "digest@weekly.example", "This week", { "List-Id": "<weekly.example>" }), owners);

  const lastOf = (id: string) => listThreadMessages(db, "arcforma", id).at(-1)!.id;
  upsertClassification(db, { accountId: "arcforma", threadId: "t-jobs", split: "other", type: "newsletters", confidence: 1, source: "rule", lastMessageId: lastOf("t-jobs") });
  upsertClassification(db, { accountId: "arcforma", threadId: "t-person", split: "other", type: "newsletters", confidence: 1, source: "rule", lastMessageId: lastOf("t-person") });
  upsertClassification(db, { accountId: "arcforma", threadId: "t-model", split: "important", type: null, confidence: 0.8, source: "local", lastMessageId: lastOf("t-model") });
  upsertClassification(db, { accountId: "arcforma", threadId: "t-manual", split: "important", type: null, categoryId: null, confidence: 1, source: "manual", lastMessageId: lastOf("t-manual") });
  setSetting(db, "rulesVersion", 2);

  // The daemon is away, so the sweep is the only thing that can write: this proves the new types
  // come from the rules and not from the model.
  const { fetch, urls } = fakeFetch(() => Object.assign(new Error("connect ECONNREFUSED"), { name: "FetchError" }));
  const classifier = new Classifier(db, new AiClient({ configFile: configFile(), fetch }), () => ["you@example.com"], () => {});
  classifier.start();
  await new Promise((r) => setTimeout(r, 60));
  classifier.stop();

  assert.equal(getSetting(db, "rulesVersion") >= 3, true, "the stored version moves up so the reset runs once");
  assert.deepEqual(
    { type: getClassification(db, "arcforma", "t-jobs")?.type, source: getClassification(db, "arcforma", "t-jobs")?.source },
    { type: "jobs", source: "rule" },
    "the stale newsletter verdict was dropped and re-decided"
  );
  // The applicant's mail is a person's, so the rules hand it back with no type. With the daemon away
  // nothing is written, and what matters is that the stale Newsletters verdict is gone for good.
  assert.equal(getClassification(db, "arcforma", "t-person")?.type ?? null, null, "a person's mail keeps no type at all");
  const model = getClassification(db, "arcforma", "t-model");
  assert.deepEqual({ type: model?.type, source: model?.source, confidence: model?.confidence }, { type: null, source: "local", confidence: 0.8 }, "the rules sweep leaves a model verdict's type alone");
  // The split is no longer the model's to keep: the attention sweep owns it, and a mailing list
  // nobody addressed personally scores nothing, so this one drops out of Important.
  assert.equal(model?.split, "other", "the attention sweep re-decided the split of a bulk thread");
  assert.equal(model?.band, "other");
  const manual = getClassification(db, "arcforma", "t-manual");
  assert.deepEqual({ split: manual?.split, type: manual?.type, source: manual?.source }, { split: "important", type: null, source: "manual" }, "a correction is untouched, split and all");
  assert.equal(manual?.band, "important", "the band follows the split the user chose");
  assert.equal(urls.length <= 1, true, "the sweep needs no model, so at most the one residue call was tried");
});

test("the sweep works in batches and hands the loop back between them, so a big mailbox never blocks", async () => {
  const db = tempDb();
  const owners = { ownerAddresses: ["you@example.com"] };
  // The newest 220 threads are ones the rules cannot answer, so a sweep that asked for "threads with
  // no verdict" would refill its batch with the same rows and never reach the 250 behind them.
  for (let i = 0; i < 220; i++) upsertThreadFromGmail(db, "arcforma", ruledThread(`u${i}`, `stranger${i}@unknown.example`, `A question about your work ${i}`), owners);
  for (let i = 0; i < 250; i++) {
    upsertThreadFromGmail(db, "arcforma", ruledThread(`t${i}`, "talent@wellfound.com", `Candidate ${i} is interested in AI Engineer`, { "List-Unsubscribe": "<mailto:x>" }, 3), owners);
    upsertClassification(db, { accountId: "arcforma", threadId: `t${i}`, split: "other", type: "newsletters", confidence: 1, source: "rule", lastMessageId: `t${i}-m1` });
  }
  setSetting(db, "rulesVersion", 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM classifications WHERE type = 'newsletters'").get() as { n: number }).n, 250, "they all start in Newsletters");
  const { fetch } = fakeFetch(() => Object.assign(new Error("connect ECONNREFUSED"), { name: "FetchError" }));
  const classifier = new Classifier(db, new AiClient({ configFile: configFile(), fetch }), () => ["you@example.com"], () => {});
  let ticks = 0;
  const beat = setInterval(() => (ticks += 1), 1);
  classifier.start();
  await new Promise((r) => setTimeout(r, 200));
  clearInterval(beat);
  classifier.stop();
  const typed = db.prepare("SELECT COUNT(*) AS n FROM classifications WHERE type = 'jobs'").get() as { n: number };
  assert.equal(typed.n, 250, "every thread past the first batch is re-decided too");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM classifications WHERE type = 'newsletters'").get() as { n: number }).n, 0);
  assert.ok(ticks > 0, "the timer kept firing while the sweep ran, so nothing was blocked");
});

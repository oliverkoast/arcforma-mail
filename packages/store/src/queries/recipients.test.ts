import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, openStore, suggestRecipients, upsertAccount, upsertThreadFromGmail } from "../index.js";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

function db() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-rec-")), "mail.db");
  const d = openStore(file);
  migrate(d);
  upsertAccount(d, { id: "arcforma", email: "oliver@arcforma.ai", displayName: "Oliver" });
  return d;
}

/** The Gmail thread shape the store actually ingests: addresses live in payload headers. */
function thread(id: string, m: { id: string; from: string; to?: string; cc?: string; date?: number; labels: string[] }) {
  return {
    id,
    historyId: "100",
    messages: [
      {
        id: m.id,
        threadId: id,
        labelIds: m.labels,
        snippet: "",
        internalDate: String(m.date ?? T0),
        historyId: "100",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: m.from },
            { name: "To", value: m.to ?? "Oliver <oliver@arcforma.ai>" },
            ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
            { name: "Subject", value: "s" },
            { name: "Message-ID", value: `<${m.id}@example.com>` },
          ],
          body: { size: 0 },
        },
      },
    ],
  };
}

function seed(d: ReturnType<typeof db>) {
  // Written to three times: the person the answer is about.
  for (let i = 0; i < 3; i++) {
    upsertThreadFromGmail(d, "arcforma", thread(`t-out-${i}`, { id: `m-out-${i}`, from: "Oliver <oliver@arcforma.ai>", to: "Zach Elin <zach.elin@equinox.com>", date: T0 - i * 1000, labels: ["SENT"] }) as never);
  }
  // Cc'd once on something sent.
  upsertThreadFromGmail(d, "arcforma", thread("t-cc", { id: "m-cc", from: "Oliver <oliver@arcforma.ai>", to: "Zach Elin <zach.elin@equinox.com>", cc: "Dana Hart <dana.hart@equinox.com>", labels: ["SENT"] }) as never);
  // Only ever wrote in: a weaker signal than anything sent to.
  upsertThreadFromGmail(d, "arcforma", thread("t-in", { id: "m-in", from: "Equinox <noreply@equinox.com>", labels: ["INBOX"] }) as never);
  return d;
}

test("a company name finds everyone at that domain", () => {
  const d = seed(db());
  const hits = suggestRecipients(d, "equinox");
  assert.ok(hits.length >= 2, "the domain matches through the address, not just the name");
  assert.deepEqual(hits.slice(0, 2).map((h) => h.email), ["zach.elin@equinox.com", "dana.hart@equinox.com"]);
});

test("people written to outrank people only heard from", () => {
  const d = seed(db());
  const hits = suggestRecipients(d, "equinox");
  const noreply = hits.findIndex((h) => h.email.startsWith("noreply@"));
  assert.ok(noreply === -1 || noreply === hits.length - 1, "a noreply address never leads the list");
  assert.equal(hits[0]?.sent, 4, "the most-written-to address leads");
});

test("a name matches at the start of any word, not in the middle of one", () => {
  const d = seed(db());
  assert.equal(suggestRecipients(d, "elin")[0]?.email, "zach.elin@equinox.com");
  assert.equal(suggestRecipients(d, "art").some((h) => h.name === "Dana Hart"), false, "art is a suffix of Hart, not the start of a word");
});

test("addresses already on the message are not offered again", () => {
  const d = seed(db());
  const hits = suggestRecipients(d, "equinox", { exclude: ["Zach.Elin@equinox.com"] });
  assert.equal(hits.some((h) => h.email === "zach.elin@equinox.com"), false, "case does not matter when excluding");
});

test("an empty query offers the people written to most, so the field is useful before typing", () => {
  const d = seed(db());
  assert.equal(suggestRecipients(d, "")[0]?.email, "zach.elin@equinox.com");
});

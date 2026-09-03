import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelDownload, type DownloadFetch, type DownloadResponse } from "./download.js";
import type { DownloadState } from "../../shared/onboarding.js";

function tempDest(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-model-")), "model.gguf");
}

const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });

/** A server that hands over `body` in fixed-size pieces, honouring Range when asked. */
function fakeServer(body: Buffer, opts: { chunk?: number; ranges?: boolean; status?: number; between?: () => Promise<void> } = {}) {
  const chunk = opts.chunk ?? 4;
  const seen: Array<Record<string, string>> = [];
  const fetchImpl: DownloadFetch = async (_url, init) => {
    seen.push({ ...init.headers });
    if (opts.status && opts.status !== 200) return { status: opts.status, headers: headers({}), body: null } as DownloadResponse;
    const range = opts.ranges ? /^bytes=(\d+)-/.exec(init.headers["range"] ?? "") : null;
    const from = range ? Number(range[1]) : 0;
    const slice = body.subarray(from);
    return {
      status: from > 0 ? 206 : 200,
      headers: headers({ "content-length": String(slice.length), "accept-ranges": "bytes" }),
      body: (async function* () {
        for (let i = 0; i < slice.length; i += chunk) {
          if (opts.between) await opts.between();
          yield new Uint8Array(slice.subarray(i, i + chunk));
        }
      })(),
    };
  };
  return { fetchImpl, seen };
}

test("a download reports progress, lands on done, and renames the part file into place", async () => {
  const dest = tempDest();
  const body = Buffer.from("0123456789abcdef");
  const { fetchImpl, seen } = fakeServer(body, { chunk: 4 });
  const states: DownloadState[] = [];
  const run = new ModelDownload({ url: "https://example.test/m.gguf", dest, expectedBytes: body.length, fetchImpl, onProgress: (s) => states.push(s) });

  const final = await run.start();
  assert.equal(final.phase, "done");
  assert.equal(final.received, body.length);
  assert.equal(final.total, body.length);
  assert.equal(final.file, dest);
  assert.equal(fs.readFileSync(dest, "utf8"), body.toString());
  assert.equal(fs.existsSync(run.partFile), false, "the part file is gone once the whole file is in place");
  assert.equal(seen[0]?.["range"], undefined, "a fresh download asks for no range");

  assert.deepEqual(states.map((s) => s.phase).filter((p, i, a) => p !== a[i - 1]), ["starting", "downloading", "done"]);
  assert.deepEqual(
    states.filter((s) => s.phase === "downloading").map((s) => s.received),
    [0, 4, 8, 12, 16],
    "every chunk moves the bar"
  );
});

test("cancel stops the download, keeps what arrived, and never renames a half file into place", async () => {
  const dest = tempDest();
  const body = Buffer.alloc(64, 7);
  let run: ModelDownload | null = null;
  const { fetchImpl } = fakeServer(body, {
    chunk: 8,
    between: async () => {
      // Cancel once a third of the file is on disk, the way a person would press the button.
      if (run && run.current().received >= 24) run.cancel();
      await new Promise((r) => setTimeout(r, 0));
    },
  });
  run = new ModelDownload({ url: "https://example.test/m.gguf", dest, expectedBytes: body.length, fetchImpl });

  const final = await run.start();
  assert.equal(final.phase, "cancelled");
  assert.equal(final.error, null, "a cancel is not a failure");
  assert.equal(fs.existsSync(dest), false);
  assert.ok(fs.existsSync(run.partFile), "what arrived is kept for the next run");
  assert.ok(run.partialBytes() > 0 && run.partialBytes() < body.length);
});

test("a cancelled download resumes with a Range header and finishes the file", async () => {
  const dest = tempDest();
  const body = Buffer.from("abcdefghijklmnopqrstuvwxyz");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, body.subarray(0, 10));
  const { fetchImpl, seen } = fakeServer(body, { chunk: 8, ranges: true });
  const run = new ModelDownload({ url: "https://example.test/m.gguf", dest, expectedBytes: body.length, fetchImpl });

  assert.equal(run.partialBytes(), 10);
  const final = await run.start();
  assert.equal(seen[0]?.["range"], "bytes=10-", "the rest is asked for, not the whole file");
  assert.equal(final.phase, "done");
  assert.equal(final.resumed, true);
  assert.equal(final.received, body.length);
  assert.equal(fs.readFileSync(dest, "utf8"), body.toString(), "the resumed half and the first half join up");
});

test("a server that ignores the range restarts from zero rather than appending to a part file", async () => {
  const dest = tempDest();
  const body = Buffer.from("abcdefghij");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, Buffer.from("XXXX"));
  const { fetchImpl } = fakeServer(body, { chunk: 5, ranges: false });
  const run = new ModelDownload({ url: "https://example.test/m.gguf", dest, expectedBytes: body.length, fetchImpl });

  const final = await run.start();
  assert.equal(final.phase, "done");
  assert.equal(final.resumed, false);
  assert.equal(fs.readFileSync(dest, "utf8"), body.toString(), "the stale bytes are overwritten, not prepended");
});

test("an HTTP error, a dead connection, and a short file each fail with a sentence and install nothing", async () => {
  const dest = tempDest();
  const refused = new ModelDownload({ url: "https://example.test/m.gguf", dest, expectedBytes: 10, fetchImpl: fakeServer(Buffer.alloc(0), { status: 503 }).fetchImpl });
  const httpFail = await refused.start();
  assert.equal(httpFail.phase, "failed");
  assert.match(httpFail.error ?? "", /answered 503/);
  assert.equal(fs.existsSync(dest), false);

  const dest2 = tempDest();
  const thrown = new ModelDownload({
    url: "https://example.test/m.gguf",
    dest: dest2,
    expectedBytes: 10,
    fetchImpl: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
  });
  const netFail = await thrown.start();
  assert.equal(netFail.phase, "failed");
  assert.match(netFail.error ?? "", /could not start.*ENOTFOUND/);

  // The server sends fewer bytes than it promised: the part file is kept, nothing is renamed.
  const dest3 = tempDest();
  const short: DownloadFetch = async () => ({
    status: 200,
    headers: headers({ "content-length": "100" }),
    body: (async function* () {
      yield new Uint8Array(Buffer.from("only ten!!"));
    })(),
  });
  const truncated = new ModelDownload({ url: "https://example.test/m.gguf", dest: dest3, expectedBytes: 100, fetchImpl: short });
  const shortFail = await truncated.start();
  assert.equal(shortFail.phase, "failed");
  assert.match(shortFail.error ?? "", /10 bytes instead of 100/);
  assert.equal(fs.existsSync(dest3), false);
  assert.equal(truncated.partialBytes(), 10, "what arrived is kept so the next start resumes");
});

test("two starts share one run rather than writing the same file twice", async () => {
  const dest = tempDest();
  const body = Buffer.from("abcdefgh");
  const { fetchImpl, seen } = fakeServer(body, { chunk: 2, between: () => new Promise((r) => setTimeout(r, 1)) });
  const run = new ModelDownload({ url: "https://example.test/m.gguf", dest, expectedBytes: body.length, fetchImpl });
  const [a, b] = await Promise.all([run.start(), run.start()]);
  assert.equal(a.phase, "done");
  assert.deepEqual(a, b);
  assert.equal(seen.length, 1, "the second start joined the first rather than opening its own request");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createFetchTransport } from "./transport.js";

for (const stage of ["headers", "body"] as const) {
  test(`a connection stalled at ${stage} times out and a subsequent request succeeds`, async (t) => {
    let recovered = false;
    const server = createServer((_req, res) => {
      if (recovered) { res.end("mail"); return; }
      if (stage === "body") { res.writeHead(200); res.flushHeaders(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const transport = createFetchTransport(100);
    await assert.rejects(transport(url, {}), { name: "TimeoutError" });
    recovered = true;
    const response = await transport(url, {});
    assert.equal(await response.text(), "mail");
  });
}

test("the caller can cancel before the request deadline", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createFetchTransport()("http://127.0.0.1:1", { signal: controller.signal }), { name: "AbortError" });
});

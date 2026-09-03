/**
 * Cloudflare Worker entry. Bind a KV namespace as EVENTS and set PIXEL_AUTH_TOKEN as a secret.
 * Deploy with wrangler; see README.md in this package.
 */
import { createHandler } from "./worker.mjs";

const kvStore = (kv) => ({
  async sentAt(token) {
    const v = await kv.get(`sent:${token}`);
    return v === null ? null : Number(v);
  },
  async register(token, sentAt) {
    // Ninety days is longer than anyone acts on a read receipt, and it bounds what is retained.
    await kv.put(`sent:${token}`, String(sentAt), { expirationTtl: 60 * 60 * 24 * 90 });
  },
  async events(token) {
    return JSON.parse((await kv.get(`ev:${token}`)) ?? "[]");
  },
  async record(token, event) {
    const list = await this.events(token);
    list.push(event);
    await kv.put(`ev:${token}`, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 90 });
    await kv.put(`idx:${String(event.at).padStart(15, "0")}:${token}`, "1", { expirationTtl: 60 * 60 * 24 * 90 });
  },
  async since(ts) {
    const list = await kv.list({ prefix: "idx:" });
    const out = [];
    for (const key of list.keys) {
      const [, at, token] = key.name.split(":");
      if (Number(at) <= ts) continue;
      for (const e of await this.events(token)) if (e.at > ts) out.push({ token, ...e });
    }
    return out;
  },
});

export default {
  async fetch(request, env) {
    return createHandler({ store: kvStore(env.EVENTS), authToken: env.PIXEL_AUTH_TOKEN })(request);
  },
};

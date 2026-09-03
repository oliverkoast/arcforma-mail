/**
 * The endpoint a tracked message's image points at. Deployable as a Cloudflare Worker (KV bound as
 * EVENTS) or behind any runtime that speaks the Fetch API.
 *
 * Two routes and nothing else:
 *   GET /p/<token>.gif   record the fetch, return a 1x1 transparent GIF, always 200
 *   GET /events?since=   the app collects what happened; bearer token required
 *
 * What it deliberately does not store: no IP address, no message subject, no recipient, no body,
 * nothing that identifies the person who fetched. A token, a timestamp, and the user agent string
 * are enough to grade the fetch, and everything else would be surveillance of the recipient rather
 * than a delivery signal for the sender.
 */
import { classifyFetch } from "./classify.mjs";

const PIXEL = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const TOKEN = /^[a-f0-9]{32}$/;
const MAX_EVENTS_PER_TOKEN = 50;

function gif() {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.length),
      // Every fetch must reach us, or a second open would be invisible.
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      pragma: "no-cache",
    },
  });
}

export function createHandler({ store, authToken, now = () => Date.now() }) {
  return async function handle(request) {
    const url = new URL(request.url);

    const pixel = url.pathname.match(/^\/p\/([a-f0-9]{32})\.gif$/);
    if (pixel && request.method === "GET") {
      const token = pixel[1];
      // The image is returned whatever happens. A tracked message must never look broken to its
      // recipient because our storage had a bad day.
      try {
        const sentAt = await store.sentAt(token);
        if (sentAt !== null) {
          const events = (await store.events(token)) ?? [];
          const { grade, why } = classifyFetch({
            userAgent: request.headers.get("user-agent") ?? "",
            at: now(),
            sentAt,
            seenBefore: events.length > 0,
          });
          if (events.length < MAX_EVENTS_PER_TOKEN) {
            await store.record(token, { at: now(), grade, why, userAgent: (request.headers.get("user-agent") ?? "").slice(0, 200) });
          }
        }
      } catch {
        // Recording is best effort by design.
      }
      return gif();
    }

    if (url.pathname === "/events" && request.method === "GET") {
      if (!authorised(request, authToken)) return json({ error: "unauthorised" }, 401);
      const since = Number(url.searchParams.get("since") ?? 0);
      return json({ events: await store.since(Number.isFinite(since) ? since : 0) });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      if (!authorised(request, authToken)) return json({ error: "unauthorised" }, 401);
      const body = await request.json().catch(() => null);
      if (!body || !TOKEN.test(String(body.token ?? "")) || !Number.isFinite(body.sentAt)) {
        return json({ error: "token and sentAt required" }, 400);
      }
      await store.register(String(body.token), Number(body.sentAt));
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  };
}

function authorised(request, authToken) {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!authToken || given.length !== authToken.length) return false;
  let same = 0;
  for (let i = 0; i < authToken.length; i++) same |= given.charCodeAt(i) ^ authToken.charCodeAt(i);
  return same === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

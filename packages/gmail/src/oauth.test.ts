import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { AuthExpiredError } from "./errors.js";
import { SCOPES, createTokenSource, runLoopbackFlow, type TokenTransporter, loadOAuthClients, loadAccountIdentities } from "./oauth.js";

interface Seen {
  url: string;
  method: string | undefined;
  data: Record<string, string> | null;
}

/** A transporter that answers the token exchange and the userinfo call from canned data and records what it saw. */
function fakeTransporter(handler: (seen: Seen) => unknown): { transporter: TokenTransporter; seen: Seen[] } {
  const seen: Seen[] = [];
  const transporter: TokenTransporter = {
    async request<T>(opts: { url?: string | URL; method?: string; data?: unknown }) {
      const data = opts.data instanceof URLSearchParams ? Object.fromEntries(opts.data.entries()) : typeof opts.data === "object" && opts.data ? (opts.data as Record<string, string>) : null;
      const s: Seen = { url: String(opts.url ?? ""), method: opts.method, data };
      seen.push(s);
      return { data: handler(s) as T, status: 200 };
    },
  };
  return { transporter, seen };
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

test("loopback flow: the consent URL carries the scopes, offline access, consent, state, and a 127.0.0.1 redirect; a wrong state is refused and the right one completes", async () => {
  let authUrl = "";
  const opened = new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const { transporter, seen } = fakeTransporter((s) => {
    if (s.url.includes("/token")) {
      return { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: SCOPES.join(" "), token_type: "Bearer" };
    }
    if (s.url.includes("userinfo")) return { email: "you@example.com" };
    throw new Error(`unexpected request ${s.url}`);
  });

  const flow = runLoopbackFlow({
    clientId: "client-id",
    clientSecret: "client-secret",
    loginHint: "you@example.com",
    transporter,
    timeoutMs: 5000,
    openUrl: (url) => {
      authUrl = url;
    },
  });
  await opened;
  assert.ok(authUrl, "the opener received the consent URL instead of a browser");

  const u = new URL(authUrl);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), "client-id");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("login_hint"), "you@example.com");
  assert.deepEqual((u.searchParams.get("scope") ?? "").split(" ").sort(), [...SCOPES].sort());
  const state = u.searchParams.get("state") ?? "";
  assert.match(state, /^[0-9a-f]{48}$/, "state is 24 random bytes as hex");
  const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(redirect.protocol, "http:");
  const port = Number(redirect.port);
  assert.ok(port > 0);

  // A stray request without a code is ignored; a redirect with the wrong state is refused and the flow keeps waiting.
  const favicon = await get(`http://127.0.0.1:${port}/favicon.ico`);
  assert.equal(favicon.status, 404);
  const wrong = await get(`http://127.0.0.1:${port}/?code=evil&state=not-ours`);
  assert.equal(wrong.status, 400);
  assert.match(wrong.body, /State mismatch/);
  assert.equal(await portOpen(port), true, "the server is still listening after a refused redirect");
  assert.equal(seen.length, 0, "no token exchange happened for the refused code");

  const right = await get(`http://127.0.0.1:${port}/?code=the-code&state=${state}`);
  assert.equal(right.status, 200);
  assert.match(right.body, /Signed in/);

  const result = await flow;
  assert.equal(result.refreshToken, "rt-1");
  assert.equal(result.accessToken, "at-1");
  assert.equal(result.email, "you@example.com");
  assert.ok(result.expiryDate && result.expiryDate > Date.now());
  assert.deepEqual(result.scopes.sort(), [...SCOPES].sort());

  const exchange = seen.find((s) => s.url.includes("/token"));
  assert.ok(exchange, "the token endpoint was called");
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.data?.["code"], "the-code");
  assert.equal(exchange.data?.["grant_type"], "authorization_code");
  assert.equal(exchange.data?.["redirect_uri"], `http://127.0.0.1:${port}`);
  assert.equal(exchange.data?.["client_id"], "client-id");
  assert.ok(seen.some((s) => s.url.includes("userinfo")), "the email was read after the exchange");

  assert.equal(await portOpen(port), false, "the loopback server closed once the code arrived");
});

test("loopback flow: Google returning an error rejects the sign-in and closes the server", async () => {
  let authUrl = "";
  const { transporter, seen } = fakeTransporter(() => {
    throw new Error("must not be called");
  });
  const flow = runLoopbackFlow({ clientId: "c", clientSecret: "s", transporter, timeoutMs: 5000, openUrl: (url) => void (authUrl = url) });
  // The rejection lands while this test is still driving the server; settle it into a value so nothing is unhandled meanwhile.
  const outcome = flow.then(() => null, (e: Error) => e);
  await new Promise((r) => setTimeout(r, 0));
  const port = Number(new URL(new URL(authUrl).searchParams.get("redirect_uri") ?? "").port);
  const res = await get(`http://127.0.0.1:${port}/?error=access_denied`);
  assert.equal(res.status, 200);
  assert.match(res.body, /SIGN-IN FAILED/);
  assert.match((await outcome)?.message ?? "", /access_denied/);
  assert.equal(seen.length, 0);
  assert.equal(await portOpen(port), false);
});

test("loopback flow: a token response without a refresh token is an error the user can act on", async () => {
  let authUrl = "";
  const { transporter } = fakeTransporter(() => ({ access_token: "at", expires_in: 3600 }));
  const flow = runLoopbackFlow({ clientId: "c", clientSecret: "s", transporter, timeoutMs: 5000, openUrl: (url) => void (authUrl = url) });
  const outcome = flow.then(() => null, (e: Error) => e);
  await new Promise((r) => setTimeout(r, 0));
  const u = new URL(authUrl);
  const port = Number(new URL(u.searchParams.get("redirect_uri") ?? "").port);
  await get(`http://127.0.0.1:${port}/?code=x&state=${u.searchParams.get("state")}`);
  assert.match((await outcome)?.message ?? "", /no refresh token/);
});

test("createTokenSource: invalid_grant on refresh fires onInvalidGrant once and surfaces as AuthExpiredError", async () => {
  let calls = 0;
  const { transporter, seen } = fakeTransporter(() => {
    calls += 1;
    const err = new Error("invalid_grant") as Error & { response?: { status: number; data: { error: string; error_description: string } } };
    err.response = { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    throw err;
  });
  let expired = 0;
  const source = createTokenSource({ clientId: "c", clientSecret: "s", refreshToken: "rt-old", transporter, onInvalidGrant: () => void (expired += 1) });
  await assert.rejects(source(), (e: unknown) => e instanceof AuthExpiredError);
  assert.equal(expired, 1);
  assert.equal(calls, 1);
  assert.equal(seen[0]?.data?.["grant_type"], "refresh_token");
  assert.equal(seen[0]?.data?.["refresh_token"], "rt-old");
});

test("createTokenSource: a good refresh returns the access token and reuses it until it expires", async () => {
  let calls = 0;
  const { transporter } = fakeTransporter(() => {
    calls += 1;
    return { access_token: `at-${calls}`, expires_in: 3600, token_type: "Bearer" };
  });
  const source = createTokenSource({ clientId: "c", clientSecret: "s", refreshToken: "rt", transporter });
  assert.equal(await source(), "at-1");
  assert.equal(await source(), "at-1", "a fresh token is not refreshed again");
  assert.equal(await source(true), "at-2", "force drops the cached token");
  assert.equal(calls, 2);
});

test("loadOAuthClients treats blank credentials as template rows, not errors", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(os.tmpdir(), `clients-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ accounts: [
    { id: "a", email: "A@x.com", clientId: "", clientSecret: "", consent: "internal" },
    { id: "b", email: "b@x.com", clientId: "id-b", clientSecret: "s-b", consent: "external" },
  ] }));
  const loaded = loadOAuthClients(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "b");
  assert.equal(loaded[0].consent, "external");
  fs.writeFileSync(file, JSON.stringify({ accounts: [{ id: "a", clientId: "x", clientSecret: "y" }] }));
  assert.throws(() => loadOAuthClients(file), /missing "email"/);
  fs.unlinkSync(file);
});

test("loadAccountIdentities lists every named account, configured or not, and tolerates a missing file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(os.tmpdir(), `ids-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ accounts: [
    { id: "work", email: "Person@Example.com", clientId: "id", clientSecret: "s", consent: "internal" },
    { id: "waiting", email: "other@example.com", clientId: "", clientSecret: "", consent: "external" },
    { id: "", email: "nameless@example.com" },
  ] }));
  const ids = loadAccountIdentities(file);
  assert.deepEqual(ids.map((a) => [a.id, a.email, a.configured, a.consent]), [
    ["work", "person@example.com", true, "internal"],
    ["waiting", "other@example.com", false, "external"],
  ]);
  assert.deepEqual(loadAccountIdentities(path.join(os.tmpdir(), "no-such-file.json")), [], "a missing file is not an error");
  fs.unlinkSync(file);
});

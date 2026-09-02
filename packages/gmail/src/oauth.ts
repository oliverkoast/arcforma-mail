// Loopback OAuth2 installed-app flow, ported from multi-email-mcp/src/auth.js.
// Desktop OAuth clients accept any http://127.0.0.1:<port> redirect, so an
// ephemeral port is bound per sign-in. Tokens are returned to the caller; how
// they are stored (Electron safeStorage in the app) is not this module's job.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OAuth2Client, type OAuth2ClientOptions } from "google-auth-library";
import { AuthExpiredError, OAuthConfigError } from "./errors.js";

/**
 * The slice of the google-auth-library transport the flows use: one request
 * method that resolves to a parsed body. Tests inject a fake so the token
 * exchange and the userinfo call never touch the network.
 */
export interface TokenTransporter {
  request<T = unknown>(opts: { url?: string | URL; method?: string; data?: unknown; headers?: unknown }): Promise<{ data: T; status?: number }>;
}

function clientOptions(base: OAuth2ClientOptions, transporter: TokenTransporter | undefined): OAuth2ClientOptions {
  if (!transporter) return base;
  // A fake transporter carries no interceptor chain, so the library must not try to attach its own.
  return { ...base, transporter: transporter as unknown as NonNullable<OAuth2ClientOptions["transporter"]>, useAuthRequestParameters: false };
}

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export interface OAuthClientConfig {
  id: string;
  email: string;
  clientId: string;
  clientSecret: string;
  consent: "internal" | "external";
}

export function defaultOAuthClientsPath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Arcforma Mail", "oauth-clients.json");
}

/** Reads oauth-clients.json: {"accounts":[{id,email,clientId,clientSecret,consent}]}. */
/** Who the app knows about, credentials or not. A template row with a blank id still gets a sidebar row. */
export interface AccountIdentity {
  id: string;
  email: string;
  consent: "internal" | "external";
  configured: boolean;
}

/**
 * Every account named in the clients file. Unlike loadOAuthClients this keeps entries whose
 * credentials are still blank, so the app can list an account that is waiting for its client id
 * rather than pretending it does not exist. Returns an empty list when the file is missing.
 */
export function loadAccountIdentities(file = defaultOAuthClientsPath()): AccountIdentity[] {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const accounts = (parsed as { accounts?: unknown[] })?.accounts;
  if (!Array.isArray(accounts)) return [];
  const out: AccountIdentity[] = [];
  for (const raw of accounts) {
    const a = raw as Partial<OAuthClientConfig>;
    if (typeof a.id !== "string" || !a.id || typeof a.email !== "string" || !a.email) continue;
    out.push({
      id: a.id,
      email: a.email.toLowerCase(),
      consent: a.consent === "external" ? "external" : "internal",
      configured: Boolean(a.clientId && a.clientSecret),
    });
  }
  return out;
}

export function loadOAuthClients(file = defaultOAuthClientsPath()): OAuthClientConfig[] {
  if (!fs.existsSync(file)) {
    throw new OAuthConfigError(`No OAuth clients at ${file}. Create the file with one entry per account before signing in.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new OAuthConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const accounts = (parsed as { accounts?: unknown[] })?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) throw new OAuthConfigError(`${file} has no "accounts" array.`);
  const configured: OAuthClientConfig[] = [];
  accounts.forEach((raw, i) => {
    const a = raw as Partial<OAuthClientConfig>;
    for (const key of ["id", "email"] as const) {
      if (!a[key] || typeof a[key] !== "string") throw new OAuthConfigError(`accounts[${i}] is missing "${key}".`);
    }
    // An entry with blank credentials is a template row waiting for its client id, not an error.
    if (!a.clientId || !a.clientSecret || typeof a.clientId !== "string" || typeof a.clientSecret !== "string") return;
    configured.push({
      id: a.id!,
      email: a.email!.toLowerCase(),
      clientId: a.clientId!,
      clientSecret: a.clientSecret!,
      consent: a.consent === "external" ? "external" : "internal",
    });
  });
  return configured;
}

export interface LoopbackOptions {
  clientId: string;
  clientSecret: string;
  loginHint?: string;
  scopes?: string[];
  /** Opens the consent URL in the user's browser. */
  openUrl: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Replaces the HTTP layer for the token exchange and the userinfo call (tests). */
  transporter?: TokenTransporter;
}

export interface LoopbackResult {
  refreshToken: string;
  accessToken: string | null;
  expiryDate: number | null;
  scopes: string[];
  email: string | null;
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>Arcforma Mail</title>
<body style="font: 16px -apple-system, Helvetica, Arial, sans-serif; padding: 48px; max-width: 32em">
<p style="font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .14em; text-transform: uppercase">ARCFORMA MAIL</p>
<p>Signed in. You can close this tab and return to the app.</p></body>`;

const FAILURE_HTML = (reason: string) => `<!doctype html><meta charset="utf-8"><title>Arcforma Mail</title>
<body style="font: 16px -apple-system, Helvetica, Arial, sans-serif; padding: 48px; max-width: 32em">
<p style="font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .14em; text-transform: uppercase">SIGN-IN FAILED</p>
<p>${reason}. Close this tab and try again from the app.</p></body>`;

/** Runs the consent flow and resolves with the refresh token. Rejects on denial or timeout; a redirect with the wrong state is refused and the flow keeps waiting. */
export async function runLoopbackFlow(opts: LoopbackOptions): Promise<LoopbackResult> {
  const scopes = opts.scopes ?? SCOPES;
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server has no port");
  const redirectUri = `http://127.0.0.1:${address.port}`;
  const client = new OAuth2Client(clientOptions({ clientId: opts.clientId, clientSecret: opts.clientSecret, redirectUri }, opts.transporter));
  const state = crypto.randomBytes(24).toString("hex");
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    login_hint: opts.loginHint,
    state,
    include_granted_scopes: true,
  });

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // close() alone waits for keep-alive connections from the browser; drop them so the port is released now.
      server.close();
      server.closeAllConnections();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Sign-in timed out. Try again."))), opts.timeoutMs ?? 180_000);
    const onAbort = () => finish(() => reject(new Error("Sign-in cancelled.")));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const err = url.searchParams.get("error");
      const returned = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (err) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(FAILURE_HTML(err));
        finish(() => reject(new Error(`Google returned ${err}`)));
        return;
      }
      if (!returned) {
        // Favicon or a stray GET; keep waiting for the real redirect.
        res.writeHead(404);
        res.end();
        return;
      }
      if (returnedState !== state) {
        // Not our redirect: something else on this machine hit the port. Refuse
        // it and keep waiting, so a stray request cannot cancel a real sign-in.
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(FAILURE_HTML("State mismatch"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      finish(() => resolve(returned));
    });
    void Promise.resolve(opts.openUrl(authUrl)).catch((e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and sign in again.");
  }
  client.setCredentials(tokens);
  let email: string | null = null;
  try {
    const info = await client.request<{ email?: string }>({ url: "https://www.googleapis.com/oauth2/v3/userinfo" });
    email = info.data.email?.toLowerCase() ?? null;
  } catch {
    // The email is a convenience for matching the account; the profile call during sync confirms it.
  }
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? null,
    expiryDate: tokens.expiry_date ?? null,
    scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
    email,
  };
}

export interface TokenSourceOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  onInvalidGrant?: () => void;
  /** Replaces the HTTP layer for the refresh call (tests). */
  transporter?: TokenTransporter;
}

function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } };
  return e?.response?.data?.error === "invalid_grant" || /invalid_grant/i.test(e?.message ?? "");
}

/** Access-token supplier for GmailClient. Refreshes through the stored refresh token only. */
export function createTokenSource(opts: TokenSourceOptions): (force?: boolean) => Promise<string> {
  const client = new OAuth2Client(clientOptions({ clientId: opts.clientId, clientSecret: opts.clientSecret }, opts.transporter));
  client.setCredentials({ refresh_token: opts.refreshToken });
  return async (force = false) => {
    if (force) client.setCredentials({ refresh_token: opts.refreshToken });
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new AuthExpiredError();
      return token;
    } catch (err) {
      if (isInvalidGrant(err)) {
        opts.onInvalidGrant?.();
        throw new AuthExpiredError();
      }
      throw err;
    }
  };
}

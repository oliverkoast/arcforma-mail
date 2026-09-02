// List-Unsubscribe (RFC 2369) and one-click unsubscribe (RFC 8058). The
// header lists targets in angle brackets, https and mailto in either order.
// One-click applies only when the message also carries
// List-Unsubscribe-Post: List-Unsubscribe=One-Click and the target is https:
// a POST of that exact body unsubscribes without a page. Otherwise a mailto
// target becomes a message through the normal send path, and a plain URL is
// opened in the browser for the user to finish.

import { fetchTransport, type Transport } from "./transport.js";
import { buildRawMessage, type BuiltMessage } from "./send.js";
import type { Address } from "./mime.js";

export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

export interface MailtoTarget {
  to: string;
  subject: string;
  body: string;
}

export interface UnsubscribeTargets {
  /** The https URL a one-click POST goes to, when the Post header allows it. */
  oneClick: string | null;
  mailto: MailtoTarget | null;
  /** The first http(s) URL, for opening in the browser. */
  url: string | null;
}

export type UnsubscribeMethod = "one-click" | "mailto" | "open";

/** Splits the header into its bracketed targets; bare targets without brackets are taken too. */
export function listUnsubscribeEntries(header: string): string[] {
  const out: string[] = [];
  const bracketed = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim()).filter(Boolean);
  if (bracketed.length) return bracketed;
  for (const part of header.split(",")) {
    const v = part.trim();
    if (v) out.push(v);
  }
  return out;
}

export function parseMailto(value: string): MailtoTarget | null {
  const m = /^mailto:([^?]+)(?:\?(.*))?$/i.exec(value.trim());
  if (!m) return null;
  const to = safeDecode(m[1]!).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(to)) return null;
  let subject = "";
  let body = "";
  for (const pair of (m[2] ?? "").split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const val = safeDecode(pair.slice(eq + 1).replace(/\+/g, " "));
    if (key === "subject") subject = val;
    else if (key === "body") body = val;
  }
  return { to, subject: subject || "unsubscribe", body };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The one-click flag: the Post header is exactly the RFC 8058 body, case-insensitively. */
export function isOneClickPost(listUnsubscribePost: string | null | undefined): boolean {
  return (listUnsubscribePost ?? "").trim().toLowerCase() === ONE_CLICK_BODY.toLowerCase();
}

export function parseListUnsubscribe(listUnsubscribe: string, listUnsubscribePost?: string | null): UnsubscribeTargets {
  const out: UnsubscribeTargets = { oneClick: null, mailto: null, url: null };
  for (const entry of listUnsubscribeEntries(listUnsubscribe ?? "")) {
    if (/^mailto:/i.test(entry)) {
      if (!out.mailto) out.mailto = parseMailto(entry);
      continue;
    }
    if (/^https?:\/\//i.test(entry)) {
      if (!out.url || (/^https:/i.test(entry) && !/^https:/i.test(out.url))) out.url = entry;
      if (!out.oneClick && /^https:\/\//i.test(entry) && isOneClickPost(listUnsubscribePost)) out.oneClick = entry;
    }
  }
  return out;
}

/** One-click first, then a mailto through the send path, then the page. Null when the header offered nothing usable. */
export function bestUnsubscribeMethod(t: UnsubscribeTargets): UnsubscribeMethod | null {
  if (t.oneClick) return "one-click";
  if (t.mailto) return "mailto";
  if (t.url) return "open";
  return null;
}

/** POSTs the RFC 8058 body to the one-click URL. Resolves on 2xx; throws with the status otherwise. */
export async function postOneClick(url: string, transport: Transport = fetchTransport): Promise<void> {
  if (!/^https:\/\//i.test(url)) throw new Error("One-click unsubscribe needs an https URL.");
  const res = await transport(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(ONE_CLICK_BODY)) },
    body: ONE_CLICK_BODY,
  });
  if (res.status >= 200 && res.status < 300) return;
  throw new Error(`The unsubscribe endpoint answered HTTP ${res.status}.`);
}

/** The bare message a mailto target asks for: no signature, no quote, plain text. */
export function buildUnsubscribeMessage(from: Address, target: MailtoTarget): Promise<BuiltMessage> {
  return buildRawMessage({
    from,
    to: [{ email: target.to, name: "" }],
    subject: target.subject || "unsubscribe",
    text: target.body || "unsubscribe",
    signatureHtml: null,
  });
}

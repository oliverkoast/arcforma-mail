// users.drafts: the wire calls and the mapping from a Gmail draft back into the
// shape the compose panel holds. A draft mirrored from here carries the
// signature and the quoted history inside its body, the way Gmail's own
// editor does; on the way back both are split off again so the editor shows
// only what was typed and the send path adds the signature exactly once.

import type { GmailClient } from "./client.js";
import { findBody, header, parseAddressList, type Address, type GmailMessage } from "./mime.js";

export interface GmailDraftRef {
  id: string;
  message: { id: string; threadId?: string };
}

export interface GmailDraft {
  id: string;
  message: GmailMessage;
}

interface DraftsListResponse {
  drafts?: GmailDraftRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** Every draft in the account: draft id to message id. Pages until Gmail runs out. */
export async function listGmailDrafts(client: GmailClient, signal?: AbortSignal): Promise<GmailDraftRef[]> {
  const out: GmailDraftRef[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await client.request<DraftsListResponse>("drafts", { query: { maxResults: 500, pageToken }, cost: 5, signal });
    out.push(...(page.drafts ?? []));
    pageToken = page.nextPageToken;
    if (!pageToken) return out;
  }
}

export async function getGmailDraft(client: GmailClient, id: string, signal?: AbortSignal): Promise<GmailDraft> {
  return client.request<GmailDraft>(`drafts/${encodeURIComponent(id)}`, { query: { format: "full" }, cost: 5, signal });
}

export interface DraftImport {
  gmailDraftId: string;
  gmailMessageId: string;
  threadId: string | null;
  mode: "new" | "reply" | "replyAll" | "forward";
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyHtml: string;
  quotedHtml: string;
  inReplyTo: string | null;
  references: string | null;
}

const SIGNATURE_OPEN = /<div\b[^>]*\bclass="[^"]*\bgmail_signature\b[^"]*"[^>]*>/i;
const QUOTE_OPEN = /<div\b[^>]*\bclass="[^"]*\bgmail_quote\b[^"]*"[^>]*>/i;
const DIV_TOKEN = /<div\b[^>]*>|<\/div\s*>/gi;

/** The </div> that closes the div opening at `open`, as [start, end] offsets; null when the markup never closes it. */
function closeOf(html: string, open: number): [number, number] | null {
  DIV_TOKEN.lastIndex = open;
  let depth = 0;
  for (let m = DIV_TOKEN.exec(html); m; m = DIV_TOKEN.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return [m.index, m.index + m[0].length];
  }
  return null;
}

/** Lifts one wrapped block out: the text before it, the block's inner HTML, and the text after it. */
function cut(html: string, open: RegExp): { before: string; inner: string; after: string } | null {
  const m = open.exec(html);
  if (!m) return null;
  const innerStart = m.index + m[0].length;
  const close = closeOf(html, m.index);
  if (!close) return { before: html.slice(0, m.index), inner: html.slice(innerStart), after: "" };
  return { before: html.slice(0, m.index), inner: html.slice(innerStart, close[0]), after: html.slice(close[1]) };
}

const TRAILING_BREAKS = /(?:\s|<br\s*\/?>)+$/i;
const LEADING_BREAKS = /^(?:\s|<br\s*\/?>)+/i;

/** Joins the two sides of a cut, dropping the line breaks Gmail put around the block that was lifted out. */
function join(before: string, after: string): string {
  return before.replace(TRAILING_BREAKS, "") + after.replace(LEADING_BREAKS, "");
}

/**
 * Splits a Gmail draft body into what was typed, and the quoted history.
 * The signature block goes: the account's signature is appended when the
 * message is sent, so keeping it here would send it twice.
 */
export function splitDraftHtml(html: string): { bodyHtml: string; quotedHtml: string } {
  let body = html;
  let quoted = "";
  const q = cut(body, QUOTE_OPEN);
  if (q) {
    quoted = q.inner.trim();
    body = join(q.before, q.after);
  }
  const s = cut(body, SIGNATURE_OPEN);
  if (s) body = join(s.before, s.after);
  return { bodyHtml: body.replace(TRAILING_BREAKS, "").trim(), quotedHtml: quoted };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain text to paragraphs: a blank line starts a new one, a single newline is a line break. */
export function textToParagraphs(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Plain-text drafts quote with "> " lines; those become the quoted history rather than the body. */
function splitDraftText(text: string): { body: string; quoted: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l, i) => /^>/.test(l) && (i === 0 || /wrote:\s*$/.test(lines[i - 1] ?? "") || /^>/.test(lines[i - 1] ?? "")));
  if (at === -1) return { body: text, quoted: "" };
  const start = at > 0 && /wrote:\s*$/.test(lines[at - 1] ?? "") ? at - 1 : at;
  return { body: lines.slice(0, start).join("\n"), quoted: lines.slice(start).join("\n") };
}

function modeOf(threadId: string | null, inReplyTo: string | null, subject: string, cc: Address[]): DraftImport["mode"] {
  if (/^\s*(fwd?|wg)\s*:/i.test(subject)) return "forward";
  if (threadId && inReplyTo) return cc.length > 0 ? "replyAll" : "reply";
  return "new";
}

/** The compose shape of a Gmail draft. The account's own addresses are dropped from Cc the way reply all builds it. */
export function importGmailDraft(draft: GmailDraft, ownerAddresses: string[] = []): DraftImport {
  const m = draft.message;
  const owners = new Set(ownerAddresses.map((a) => a.toLowerCase()));
  const to = parseAddressList(header(m, "To"));
  const cc = parseAddressList(header(m, "Cc")).filter((a) => !owners.has(a.email));
  const bcc = parseAddressList(header(m, "Bcc"));
  const subject = header(m, "Subject");
  const inReplyTo = header(m, "In-Reply-To") || null;
  const references = header(m, "References") || null;
  const found = findBody(m.payload);
  let bodyHtml: string;
  let quotedHtml: string;
  if (found.html !== null) {
    ({ bodyHtml, quotedHtml } = splitDraftHtml(found.html));
  } else {
    const { body, quoted } = splitDraftText(found.text ?? "");
    bodyHtml = textToParagraphs(body);
    quotedHtml = quoted ? `<blockquote class="gmail_quote">${escapeHtml(quoted.replace(/^>\s?/gm, "")).replace(/\n/g, "<br>")}</blockquote>` : "";
  }
  // A one-message thread that is only this draft is not a reply thread: the draft owns it.
  const threadId = inReplyTo || references ? m.threadId ?? null : null;
  return {
    gmailDraftId: draft.id,
    gmailMessageId: m.id,
    threadId,
    mode: modeOf(threadId, inReplyTo, subject, cc),
    to,
    cc,
    bcc,
    subject,
    bodyHtml,
    quotedHtml,
    inReplyTo,
    references,
  };
}

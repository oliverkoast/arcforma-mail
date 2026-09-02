// Pure compose rules: who a reply goes to, what the subject becomes, and how
// the quoted history reads. No DOM, so node:test covers it directly.

import type { Address, ComposeDraft, ComposeMode, MessageView, ThreadSummary } from "../../shared/types";

const RE_PREFIX = /^\s*(re|aw|sv)\s*:\s*/i;
const FWD_PREFIX = /^\s*(fwd?|wg)\s*:\s*/i;

export function replySubject(subject: string): string {
  const s = subject.trim();
  return RE_PREFIX.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject: string): string {
  const s = subject.trim();
  return FWD_PREFIX.test(s) ? s : `Fwd: ${s}`;
}

function dedupe(list: Address[], exclude: Set<string>): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of list) {
    const e = a.email.toLowerCase();
    if (!e || exclude.has(e) || seen.has(e)) continue;
    seen.add(e);
    out.push({ email: e, name: a.name });
  }
  return out;
}

/** The message a reply answers: the last inbound one, else the last message. */
export function replyTarget(messages: MessageView[]): MessageView | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.direction === "in") return messages[i]!;
  return messages[messages.length - 1] ?? null;
}

export interface Recipients {
  to: Address[];
  cc: Address[];
}

/**
 * Reply goes to Reply-To or From. When the target is Oliver's own message,
 * reply goes back to its recipients. Reply all adds everyone on To and Cc,
 * minus the owner addresses. Forward starts empty.
 */
export function recipientsFor(mode: ComposeMode, target: MessageView | null, owners: Set<string>): Recipients {
  if (mode === "new" || mode === "forward" || !target) return { to: [], cc: [] };
  const own = new Set(Array.from(owners, (o) => o.toLowerCase()));
  const sender = target.replyTo ?? target.from;
  const fromMe = own.has(target.from.email.toLowerCase());
  const primary = fromMe ? target.to : [sender];
  const to = dedupe(primary, own);
  if (mode === "reply") return { to, cc: [] };
  const toSet = new Set(to.map((a) => a.email));
  const rest = dedupe([...target.to, ...target.cc], new Set([...own, ...toSet]));
  return { to, cc: rest };
}

export function referencesFor(target: MessageView | null): { inReplyTo: string | null; references: string | null } {
  if (!target?.messageIdHeader) return { inReplyTo: null, references: null };
  const prior = target.references ? target.references.split(/\s+/).filter(Boolean) : [];
  if (!prior.includes(target.messageIdHeader)) prior.push(target.messageIdHeader);
  return { inReplyTo: target.messageIdHeader, references: prior.join(" ") };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function addressLine(list: Address[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}

export function bodyHtmlOf(m: MessageView): string {
  if (m.body?.html) return m.body.html;
  const text = m.body?.text ?? m.snippet;
  return `<div>${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
}

/** Gmail-style quote for a reply, or the forwarded-message header block. `sanitize` runs on the source HTML. */
export function quotedHtml(mode: ComposeMode, target: MessageView | null, sanitize: (html: string) => string = (h) => h): string {
  if (!target || mode === "new") return "";
  const when = new Date(target.internalDate).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const inner = sanitize(bodyHtmlOf(target));
  if (mode === "forward") {
    const head = [
      `From: ${escapeHtml(addressLine([target.from]))}`,
      `Date: ${escapeHtml(when)}`,
      `Subject: ${escapeHtml(target.subject)}`,
      `To: ${escapeHtml(addressLine(target.to))}`,
      target.cc.length ? `Cc: ${escapeHtml(addressLine(target.cc))}` : "",
    ]
      .filter(Boolean)
      .join("<br>");
    return `<div>---------- Forwarded message ---------<br>${head}</div><br>${inner}`;
  }
  const who = escapeHtml(addressLine([target.from]));
  return `<div>On ${escapeHtml(when)}, ${who} wrote:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;padding-left:1ex">${inner}</blockquote>`;
}

export interface BuildDraftInput {
  mode: ComposeMode;
  accountId: string;
  thread: ThreadSummary | null;
  messages: MessageView[];
  owners: Set<string>;
  sanitize?: (html: string) => string;
  bodyHtml?: string;
}

/** True when a message carries a real (non-inline) attachment. */
export function hasFileAttachments(m: MessageView | null): boolean {
  if (!m) return false;
  if (m.body) return m.body.attachments.some((a) => !a.inline);
  return m.hasAttachments;
}

/**
 * Everything the compose panel opens with. Forwarding a message that has
 * attachments throws rather than quietly sending the text without them.
 */
export function buildDraft(input: BuildDraftInput): ComposeDraft {
  const target = input.mode === "new" ? null : replyTarget(input.messages);
  if (input.mode === "forward" && hasFileAttachments(target)) {
    throw new Error("Forwarding attachments is not supported yet. Forward this one from Gmail.");
  }
  const { to, cc } = recipientsFor(input.mode, target, input.owners);
  const refs = input.mode === "forward" ? { inReplyTo: null, references: null } : referencesFor(target);
  const baseSubject = input.thread?.subject ?? target?.subject ?? "";
  const subject = input.mode === "new" ? "" : input.mode === "forward" ? forwardSubject(baseSubject) : replySubject(baseSubject);
  return {
    draftId: null,
    accountId: input.accountId,
    threadId: input.mode === "new" || input.mode === "forward" ? null : input.thread?.id ?? target?.threadId ?? null,
    mode: input.mode,
    to,
    cc,
    bcc: [],
    subject,
    bodyHtml: input.bodyHtml ?? "",
    quotedHtml: quotedHtml(input.mode, target, input.sanitize),
    inReplyTo: refs.inReplyTo,
    references: refs.references,
  };
}

const ADDR = /(?:"?([^"<,]*)"?\s*<([^>]+)>)|([^\s,<>]+@[^\s,<>]+)/g;

/** Parses what someone typed into a To field: names in quotes, angle brackets, or bare addresses, comma separated. */
export function parseAddresses(text: string): Address[] {
  const out: Address[] = [];
  for (const m of text.matchAll(ADDR)) {
    const email = (m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (!email) continue;
    out.push({ email, name: (m[1] ?? "").trim() });
  }
  return out;
}

export function formatAddresses(list: Address[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}

/** Plain text (from the model) to paragraphs the editor accepts. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

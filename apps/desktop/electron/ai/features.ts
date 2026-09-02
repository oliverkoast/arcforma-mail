// On-demand Claude features: thread summary, instant replies, auto-draft, and
// Ask AI. All cached where the plan says so and all failing softly: a 503 from
// the daemon becomes {ok:false, code:"not_logged_in"} and the UI keeps going.

import { getBody, getReplyOptions, getSummary, listThreadMessages, search, setReplyOptions, setSummary, stripHtml, type Db, type MessageRow } from "@arcforma/store";
import { toFailure, type AiClient } from "./client.js";
import type { AskResult, AskSource, DraftReplyResult, InstantRepliesResult, SummaryResult } from "../../shared/types.js";

export const SUMMARY_MIN_MESSAGES = 5;
export const SUMMARY_MIN_WORDS = 1500;
const BODY_CHARS = 6000;

/**
 * No em dashes and no emojis leave the model; the gate runs before anything is
 * shown. Emoji are matched by the Unicode Extended_Pictographic property plus
 * the joiners and keycap marks that ride along, minus the few symbols that are
 * ordinary text (copyright, registered, trademark, information).
 */
export function cleanOutput(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/\u2013/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/(?![\u00A9\u00AE\u2122\u2139])\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\uFE0F\u200D\u20E3]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function bodyText(db: Db, m: MessageRow): string {
  const body = getBody(db, m.account_id, m.id);
  const text = body?.text ?? (body?.html ? stripHtml(body.html) : m.snippet);
  return text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS)} [cut]` : text;
}

/** The thread rendered as plain text, oldest first, one block per message. */
export function threadText(db: Db, accountId: string, threadId: string): { text: string; messages: MessageRow[]; words: number } {
  const messages = listThreadMessages(db, accountId, threadId);
  const blocks = messages.map((m) => {
    const when = new Date(m.internal_date).toISOString().slice(0, 16).replace("T", " ");
    const to = (JSON.parse(m.to_json) as Array<{ email: string }>).map((a) => a.email).join(", ");
    return `From: ${m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email}\nTo: ${to}\nDate: ${when}\nSubject: ${m.subject}\n\n${bodyText(db, m)}`;
  });
  const text = blocks.join("\n\n----\n\n");
  return { text, messages, words: text.split(/\s+/).filter(Boolean).length };
}

export function wantsSummary(messageCount: number, words: number): boolean {
  return messageCount > SUMMARY_MIN_MESSAGES || words > SUMMARY_MIN_WORDS;
}

export async function summarize(db: Db, ai: AiClient, accountId: string, threadId: string): Promise<SummaryResult> {
  const { text, messages } = threadText(db, accountId, threadId);
  const last = messages.at(-1);
  if (!last) return { ok: false, code: "unknown", error: "Nothing to summarize." };
  const cached = getSummary(db, accountId, threadId, last.id);
  if (cached) return { ok: true, summary: cached, cached: true };
  try {
    const r = await ai.complete({ task: "summarize", user: text, timeoutMs: 60_000, requestId: `summary:${accountId}:${threadId}` });
    const summary = cleanOutput(r.text);
    setSummary(db, accountId, threadId, last.id, summary);
    return { ok: true, summary, cached: false };
  } catch (err) {
    return toFailure(err);
  }
}

/** Instant replies apply to an inbound, non-automated message that is still the last one in its thread. */
export function wantsInstantReplies(messages: MessageRow[], messageId: string): boolean {
  const last = messages.at(-1);
  return Boolean(last && last.id === messageId && last.direction === "in" && last.is_auto === 0);
}

export async function instantReplies(db: Db, ai: AiClient, accountId: string, messageId: string): Promise<InstantRepliesResult> {
  const cached = getReplyOptions(db, accountId, messageId);
  if (cached) return { ok: true, replies: cached, cached: true };
  const row = db.prepare("SELECT thread_id FROM messages WHERE account_id = ? AND id = ?").get(accountId, messageId) as { thread_id: string } | undefined;
  if (!row) return { ok: false, code: "unknown", error: "That message is not in the local store." };
  const { text, messages } = threadText(db, accountId, row.thread_id);
  if (!wantsInstantReplies(messages, messageId)) {
    return { ok: false, code: "unknown", error: "Instant replies apply to the last inbound message in a thread." };
  }
  try {
    const r = await ai.complete({ task: "instant_replies", user: text, json: true, timeoutMs: 45_000, requestId: `replies:${accountId}:${messageId}` });
    const parsed = (r.json ?? JSON.parse(r.text)) as { replies?: unknown };
    const replies = Array.isArray(parsed.replies) ? parsed.replies.filter((x): x is string => typeof x === "string").map(cleanOutput).slice(0, 3) : [];
    if (replies.length === 0) return { ok: false, code: "bad_response", error: "No replies came back." };
    setReplyOptions(db, accountId, messageId, replies);
    return { ok: true, replies, cached: false };
  } catch (err) {
    return toFailure(err);
  }
}

export async function draftReply(db: Db, ai: AiClient, accountId: string, threadId: string): Promise<DraftReplyResult> {
  const { text, messages } = threadText(db, accountId, threadId);
  if (messages.length === 0) return { ok: false, code: "unknown", error: "Nothing to reply to." };
  try {
    const r = await ai.complete({ task: "draft_reply", user: text, timeoutMs: 60_000, requestId: `draft:${accountId}:${threadId}` });
    return { ok: true, text: cleanOutput(r.text) };
  } catch (err) {
    return toFailure(err);
  }
}

/** FTS top 40 as numbered excerpts, then ask_inbox. The hits come back even when Claude cannot answer. */
export async function askInbox(db: Db, ai: AiClient, question: string, accountIds?: string[]): Promise<AskResult> {
  const hits = search(db, question, { accountIds, limit: 40 });
  const sources: AskSource[] = hits.map((h, i) => ({ n: i + 1, accountId: h.row.account_id, threadId: h.row.id, subject: h.row.subject, excerpt: h.excerpt }));
  if (sources.length === 0) return { ok: false, code: "unknown", error: "No mail matched that question. Try different words.", sources };
  const context = sources
    .map((s) => {
      const row = hits[s.n - 1]!.row;
      const from = (JSON.parse(row.participants_json) as Array<{ email: string }>).map((p) => p.email).join(", ");
      return `[${s.n}] Subject: ${s.subject}\nParticipants: ${from}\nDate: ${new Date(row.last_message_at).toISOString().slice(0, 10)}\nExcerpt: ${s.excerpt}`;
    })
    .join("\n\n");
  const user = `Question: ${question}\n\nExcerpts:\n\n${context}`;
  try {
    const r = await ai.complete({ task: "ask_inbox", user, timeoutMs: 90_000, requestId: `ask:${Date.now()}` });
    return { ok: true, answer: cleanOutput(r.text), sources };
  } catch (err) {
    return { ...toFailure(err), sources };
  }
}

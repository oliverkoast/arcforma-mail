// Deterministic layer of the classifier. Runs on every thread before the local
// model sees anything; the model only gets the residue. Uses ruleType() from
// the gmail package for the four builtin types and adds the Important rule:
// any sender domain Oliver replied to in the last 90 days is Important.

import { ruleType, type GmailMessage, type RuleType } from "@arcforma/gmail";
import type { MessageRow } from "@arcforma/store";

export type Split = "important" | "other";

/** The header subset the rules read. Built from a store row or a fixture. */
export interface RuleInput {
  fromEmail: string;
  subject: string;
  headers: Record<string, string>;
  /** True when any MIME part is text/calendar or an .ics attachment. */
  hasCalendarPart: boolean;
  direction: "in" | "out";
  isAuto: boolean;
}

export interface RuleContext {
  /** Lowercased domains Oliver sent to in the window. */
  repliedDomains: Set<string>;
  /** Lowercased addresses the accounts send from; mail from them is never Important by itself. */
  ownerAddresses?: Set<string>;
}

export interface RuleVerdict {
  split: Split | null;
  type: RuleType | null;
  /** Why the rules decided, for logs and the corrections excerpt. */
  reason: string | null;
}

/** Freemail domains are shared by strangers, so a reply to one address says nothing about the next. */
const SHARED_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "live.com", "msn.com"]);

export function domainOf(email: string): string {
  return email.toLowerCase().split("@")[1] ?? "";
}

function toGmailMessage(input: RuleInput): GmailMessage {
  const headers = Object.entries(input.headers).map(([name, value]) => ({ name, value }));
  if (!input.headers["From"] && !input.headers["from"]) headers.push({ name: "From", value: input.fromEmail });
  if (!input.headers["Subject"] && !input.headers["subject"]) headers.push({ name: "Subject", value: input.subject });
  return {
    id: "rule",
    threadId: "rule",
    payload: {
      mimeType: input.hasCalendarPart ? "multipart/mixed" : "text/plain",
      headers,
      parts: input.hasCalendarPart ? [{ mimeType: "text/calendar" }] : [],
    },
  };
}

/**
 * Header-only verdict for one message. Type comes from ruleType(); split is
 * "other" for anything typed or automated, "important" for a replied-to
 * domain, and null when the rules have no opinion.
 */
export function classifyByRules(input: RuleInput, ctx: RuleContext): RuleVerdict {
  const m = toGmailMessage(input);
  const type = ruleType(m);
  if (type) return { split: "other", type, reason: `rule:${type}` };
  const from = input.fromEmail.toLowerCase();
  const domain = domainOf(from);
  if (input.direction === "out" || ctx.ownerAddresses?.has(from)) return { split: null, type: null, reason: null };
  if (input.isAuto) return { split: "other", type: null, reason: "rule:auto-generated" };
  if (domain && !SHARED_DOMAINS.has(domain) && ctx.repliedDomains.has(domain)) return { split: "important", type: null, reason: "rule:replied-domain" };
  return { split: null, type: null, reason: null };
}

/** The last inbound message decides; when the whole thread is outbound, the last message does. */
export function pickDecidingMessage<T extends { direction: "in" | "out" }>(messages: T[]): T | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.direction === "in") return messages[i]!;
  return messages[messages.length - 1] ?? null;
}

export function ruleInputFromRow(m: MessageRow, attachmentsJson?: string | null): RuleInput {
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(m.headers_json) as Record<string, string>;
  } catch {
    headers = {};
  }
  let hasCalendar = /text\/calendar|application\/ics/i.test(headers["Content-Type"] ?? "");
  if (!hasCalendar && attachmentsJson) {
    try {
      hasCalendar = (JSON.parse(attachmentsJson) as Array<{ filename?: string; mimeType?: string }>).some((a) => /\.ics$/i.test(a.filename ?? "") || /text\/calendar/i.test(a.mimeType ?? ""));
    } catch {
      hasCalendar = false;
    }
  }
  return { fromEmail: m.from_email, subject: m.subject, headers, hasCalendarPart: hasCalendar, direction: m.direction, isAuto: m.is_auto === 1 };
}

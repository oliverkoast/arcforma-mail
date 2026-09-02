// The attention model: how much one thread deserves Oliver's eyes right now.
// Pure. Everything it reads comes in as facts from the store's
// queries/attention.ts, so node:test drives it from literals and the read-only
// report drives it from a real mailbox through the same code.
//
// The old rule was one line: any sender domain he had replied to in ninety days
// was Important. It put a shop he once emailed and a client asking a question
// in the same bucket. This scores the reasons instead, and separates the two
// answers he actually wants: "someone asked me something and I have not
// answered" from "this matters but nothing is waiting on me".
//
// WEIGHTS, and why each one is what it is.
//
// Addressing. Being the only name on To is the single clearest sign a message
// is for him. Sharing To with others is nearly as strong. Cc is a copy, not a
// request. A group alias with his address nowhere on the message is mail sent
// to a role, so it earns nothing.
//   to +18, to with others +12, cc only +4, alias 0
//
// Relationship. How often he has written to this exact address, damped by how
// long ago the last one was: a person he wrote to twenty times two years ago is
// not the same as one he wrote to twenty times last week.
//   10 or more +20, 3 to 9 +14, 1 or 2 +6; times 1 inside 30 days,
//   0.7 inside 180, 0.4 beyond
//   the domain is one he writes to, but this address is new: +8
//   a client domain (the remindScope categories): +12
//   a first-time sender at a domain he has never written to: -4
//
// Conversation. A thread he has already written in is a conversation, and a
// conversation he started is one he is waiting on.
//   he has written in the thread +14, the thread opens with his message +6
//
// Ask. What the last inbound message actually wants. A question aimed at him, a
// request in words, a date. Capped together at +26 so a message that does all
// three does not outweigh everything else.
//   question +18, request +14, deadline +8, capped at +26
//
// Waiting. An unanswered message is worth more after a day than after an hour,
// and less after a week: at that point it is either dead or already handled
// somewhere else.
//   under a day +6, one to three days +8, three to seven +5, beyond +2
//
// Against. These are the reasons mail does not need him, and they are large,
// because a false Important costs more than a false Other once the list is long.
//   bulk headers -35, a no-reply sender -30, auto-generated -25,
//   a role address -12, the thread already has a mailbox type -30,
//   archived unread more than 80 percent of the time over 5 or more threads -25,
//   every thread from this sender still unread over 3 or more -8,
//   more than 10 threads a week -18, more than 3 a week -10,
//   each re-file out of Important for this sender -20, no worse than -40
//
// One signal is not a weight at all: mail whose sender is one of his own
// addresses scores nothing, whatever else it carries. A calendar system writing
// in his name, or a message he sent to himself, is never mail he needs to see,
// and no amount of history or asking should be able to add up past that.
//
// Bands. needs_you is a promise, so it is gated rather than scored: a person
// wrote, asked something, addressed him, and he has not answered since. important
// is the score alone, at 40 and above. Between 30 and 40 the deterministic
// signals are genuinely undecided, and that grey band is the only place the
// local model's verdict is allowed to lift a thread into Important.

import { isNoReplyAddress, isRoleAddress } from "@arcforma/gmail";
import type { AttentionBand, AttentionFacts } from "@arcforma/store";

export const WEIGHTS = {
  addressing: { to: 18, to_with_others: 12, cc: 4, alias: 0 },
  replied: { many: 20, some: 14, few: 6 },
  repliedRecency: { fresh: 1, warm: 0.7, cold: 0.4 },
  repliedDomain: 8,
  clientDomain: 12,
  firstTimeSender: -4,
  inThread: 14,
  startedByYou: 6,
  ask: { question: 18, request: 14, deadline: 8, cap: 26 },
  waiting: { sameDay: 6, days1to3: 8, days3to7: 5, older: 2 },
  bulk: -35,
  noReply: -30,
  auto: -25,
  roleAddress: -12,
  typed: -30,
  archivesUnread: -25,
  neverOpened: -8,
  floodPerWeek: -18,
  busyPerWeek: -10,
  demotion: -20,
  demotionFloor: -40,
} as const;

/** A score at or above this, with the needs_you gate met, is a thread waiting on him. */
export const NEEDS_YOU_FLOOR = 55;
/**
 * A score at or above this is Important. Set from the real mailbox: a person he
 * has written to before, writing to him directly, with no ask the snippet can
 * see, lands at 40. Above that number the run reads as his own correspondence;
 * at 45 it dropped mail like "Signed NDA" and "Reschedule for Wednesday", which
 * is exactly the mail the row exists for.
 */
export const IMPORTANT_FLOOR = 40;
/** Below this the deterministic signals are clear enough that the model is not asked. */
export const GREY_FLOOR = 30;

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const HALF_YEAR = 180 * DAY;

export interface AskSignals {
  /** A sentence ending in a question mark that is aimed at the reader. */
  question: boolean;
  /** Words that ask for an action: can you, please, let me know, waiting on. */
  request: boolean;
  /** A date or a by-when. */
  deadline: boolean;
}

export const NO_ASK: AskSignals = { question: false, request: false, deadline: false };

/**
 * Local parts that only software writes from, on top of the gmail package's
 * role list. They are here rather than there because none of them changes a
 * message's mailbox type, which is all that list decides; what they change is
 * whether a person asked, and a reminder robot quoting his own mail back at him
 * did not. Superhuman's reminder@ address was the one that showed this up.
 */
const AUTOMATON_LOCAL = /^(reminders?|digest|digests|notify|notifier|bot|mailbot|mailer|daemon|robot|invites?|calendar|scheduler|replies|postmaster|feedback)([+._-]|$)/i;

/**
 * A question mark alone is not an ask: half the newsletters in the world put
 * one in the subject. The sentence has to speak to the reader, or open with a
 * word that only starts a real question.
 */
const QUESTION_OPENERS = /^\s*(can|could|would|will|do|did|does|are|is|was|were|have|has|had|should|shall|may|might|when|what|where|which|who|whom|whose|how|why|any)\b/i;
const SECOND_PERSON = /\b(you|your|you'?re|you'?ve|yours|u)\b/i;

const REQUEST =
  /\b(can you|could you|would you|will you|are you able|please (let|send|share|confirm|review|sign|approve|advise|reply|respond|take a look)|let me know|need your|needs your|waiting on|waiting for your|following up|circling back|any update|your thoughts|get back to (me|us)|send (me|us|over)|share (the|your)|confirm (the|that|whether|if)|sign off|approve|hoping (you|to hear)|do you have|would love your|look forward to your (reply|response|thoughts))\b/i;

const DEADLINE =
  /\b(by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|noon|eod|eow|cob|end of (the )?(day|week|month))|by (january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}|by \d{1,2}\/\d{1,2}|deadline|due (by|on|date)|no later than|before (monday|tuesday|wednesday|thursday|friday|the (call|meeting|deadline))|this week if|needs? to (go out|be (in|done|signed)) by)\b/i;

/**
 * The ask signals in one message's subject and text. Pure, so a signal can be
 * tested on its own sentence.
 */
export function detectAsk(text: string): AskSignals {
  // Line breaks end a sentence here as surely as a full stop: the first line is the subject, and a
  // question there would otherwise read as the tail of whatever line came before it.
  const t = (text || "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").trim();
  if (!t) return { ...NO_ASK };
  let question = false;
  for (const raw of t.split(/(?<=[?.!])\s+|\n+/)) {
    const s = raw.trim();
    if (!s.endsWith("?")) continue;
    if (SECOND_PERSON.test(s) || QUESTION_OPENERS.test(s)) {
      question = true;
      break;
    }
  }
  return { question, request: REQUEST.test(t), deadline: DEADLINE.test(t) };
}

/** The relationship points, damped by how long ago he last wrote to the address. */
export function relationshipPoints(repliedCount: number, lastRepliedAt: number | null, now: number): number {
  if (repliedCount <= 0) return 0;
  const base = repliedCount >= 10 ? WEIGHTS.replied.many : repliedCount >= 3 ? WEIGHTS.replied.some : WEIGHTS.replied.few;
  const age = lastRepliedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - lastRepliedAt);
  const factor = age <= MONTH ? WEIGHTS.repliedRecency.fresh : age <= HALF_YEAR ? WEIGHTS.repliedRecency.warm : WEIGHTS.repliedRecency.cold;
  return base * factor;
}

/** The points an unanswered inbound message is worth, by how long it has waited. */
export function waitingPoints(unansweredMs: number | null): number {
  if (unansweredMs === null) return 0;
  if (unansweredMs < DAY) return WEIGHTS.waiting.sameDay;
  if (unansweredMs < 3 * DAY) return WEIGHTS.waiting.days1to3;
  if (unansweredMs < WEEK) return WEIGHTS.waiting.days3to7;
  return WEIGHTS.waiting.older;
}

export interface AttentionVerdict {
  /** 0 to 100. */
  score: number;
  band: AttentionBand;
  /** One sentence saying why, for the row eyebrow and the thread head. */
  reason: string;
  ask: AskSignals;
  /** True when the sender is a person rather than software. */
  person: boolean;
}

/** True when a real person wrote this: not a role box, not a no-reply, not a list, not a machine. */
export function isPersonMessage(f: Pick<AttentionFacts, "senderEmail" | "isBulk" | "isAuto" | "isOwnSender">): boolean {
  if (!f.senderEmail || f.isOwnSender) return false;
  if (f.isBulk || f.isAuto) return false;
  if (AUTOMATON_LOCAL.test(f.senderEmail.split("@")[0] ?? "")) return false;
  return !isRoleAddress(f.senderEmail);
}

function shortName(f: AttentionFacts): string {
  const name = f.senderName.trim();
  if (name && !name.includes("@")) return name.split(/\s+/)[0] || name;
  return f.senderEmail.split("@")[0] || f.senderEmail;
}

function days(ms: number): number {
  return Math.floor(ms / DAY);
}

/** The sentence stored with the verdict. Plain words, no punctuation tricks, nothing from the body. */
export function attentionReason(f: AttentionFacts, band: AttentionBand, ask: AskSignals): string {
  const who = shortName(f);
  if (band === "needs_you") {
    const asked = ask.question ? `${who} asked a question` : ask.request ? `${who} asked you for something` : `${who} named a date`;
    const waited = f.unansweredMs === null ? "you have not replied" : days(f.unansweredMs) >= 1 ? `you have not replied in ${days(f.unansweredMs)} day${days(f.unansweredMs) === 1 ? "" : "s"}` : "you have not replied";
    const history = f.repliedCount >= 1 ? `you have written to them ${f.repliedCount} time${f.repliedCount === 1 ? "" : "s"}` : f.isFirstTimeSender ? "this is their first mail to you" : "you have not written to them before";
    return `${asked}, ${waited}, and ${history}`;
  }
  if (band === "important") {
    const parts: string[] = [];
    if (f.isClientDomain) parts.push("a client domain");
    if (f.repliedCount >= 3) parts.push(`you have written to them ${f.repliedCount} times`);
    else if (f.repliedCount >= 1) parts.push("you have written to them before");
    if (f.youAreInThread) parts.push("you are in this thread");
    if (f.addressing === "to" || f.addressing === "to_with_others") parts.push("you are on To");
    else if (f.addressing === "cc") parts.push("you are on Cc");
    if (parts.length === 0) parts.push("a person wrote to you directly");
    return `Important: ${parts.join(", ")}`;
  }
  const why: string[] = [];
  if (f.type) why.push(`filed under ${f.type}`);
  if (f.isOwnSender) why.push("sent from one of your own addresses");
  if (f.isBulk) why.push("bulk mail");
  else if (isNoReplyAddress(f.senderEmail)) why.push("a no-reply sender");
  else if (f.isAuto) why.push("automated");
  if (f.archiveWithoutReadRate >= 0.8 && f.senderThreads >= 5) why.push("you archive them unread");
  if (f.threadsPerWeek > 3) why.push(`${Math.round(f.threadsPerWeek)} threads a week from them`);
  if (f.demotions > 0) why.push("you re-filed them before");
  if (why.length === 0) why.push(f.addressing === "alias" ? "sent to a group address, nothing asked of you" : "nothing here is waiting on you");
  return `Other: ${why.join(", ")}`;
}

/**
 * The score, the band, and the sentence. modelSaidImportant is the local
 * model's verdict, and it only counts inside the grey zone: everywhere else the
 * deterministic signals already decide.
 */
export function scoreAttention(f: AttentionFacts, opts: { modelSaidImportant?: boolean } = {}): AttentionVerdict {
  const ask = detectAsk(f.askText);
  const person = isPersonMessage(f);

  let score: number = WEIGHTS.addressing[f.addressing];
  score += relationshipPoints(f.repliedCount, f.lastRepliedAt, f.now);
  if (f.repliedCount === 0 && f.repliedDomain) score += WEIGHTS.repliedDomain;
  if (f.isClientDomain) score += WEIGHTS.clientDomain;
  if (f.isFirstTimeSender && !f.repliedDomain) score += WEIGHTS.firstTimeSender;
  if (f.youAreInThread) score += WEIGHTS.inThread;
  if (f.youStartedThread) score += WEIGHTS.startedByYou;

  const askPoints = (ask.question ? WEIGHTS.ask.question : 0) + (ask.request ? WEIGHTS.ask.request : 0) + (ask.deadline ? WEIGHTS.ask.deadline : 0);
  score += Math.min(askPoints, WEIGHTS.ask.cap);
  score += waitingPoints(f.unansweredMs);

  if (f.isBulk) score += WEIGHTS.bulk;
  if (isNoReplyAddress(f.senderEmail)) score += WEIGHTS.noReply;
  else if (isRoleAddress(f.senderEmail) || AUTOMATON_LOCAL.test(f.senderEmail.split("@")[0] ?? "")) score += WEIGHTS.roleAddress;
  if (f.isAuto) score += WEIGHTS.auto;
  if (f.type) score += WEIGHTS.typed;
  if (f.senderThreads >= 5 && f.archiveWithoutReadRate > 0.8) score += WEIGHTS.archivesUnread;
  if (f.neverOpened) score += WEIGHTS.neverOpened;
  if (f.threadsPerWeek > 10) score += WEIGHTS.floodPerWeek;
  else if (f.threadsPerWeek > 3) score += WEIGHTS.busyPerWeek;
  if (f.demotions > 0) score += Math.max(WEIGHTS.demotionFloor, f.demotions * WEIGHTS.demotion);

  // His own address writing to him is not correspondence, so nothing above it counts.
  score = f.isOwnSender ? 0 : Math.max(0, Math.min(100, Math.round(score)));

  const addressed = f.addressing !== "alias";
  const unanswered = f.unansweredMs !== null;
  const asked = ask.question || ask.request || ask.deadline;
  const needsYou = person && !f.type && addressed && asked && unanswered && score >= NEEDS_YOU_FLOOR;

  let band: AttentionBand;
  if (needsYou) band = "needs_you";
  else if (score >= IMPORTANT_FLOOR) band = "important";
  else if (score >= GREY_FLOOR && opts.modelSaidImportant === true) band = "important";
  else band = "other";

  return { score, band, reason: attentionReason(f, band, ask), ask, person };
}

/** The split column every existing query reads. needs_you and important are both Important. */
export function splitForBand(band: AttentionBand): "important" | "other" {
  return band === "other" ? "other" : "important";
}

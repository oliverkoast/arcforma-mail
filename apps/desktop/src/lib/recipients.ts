// Who a message came from and who else is on it, written the way a person
// would say it out loud: "to you and Dana", "to Dana and 4 others", with a
// separate cc segment. Pure, so node:test covers it without a DOM.

import type { Address } from "../../shared/types";

export type RecipientGroup = "To" | "Cc" | "Bcc";

export interface RecipientRow {
  group: RecipientGroup;
  /** The address book name, empty when the message carried none. */
  name: string;
  email: string;
  /** What the expanded list shows for this person: "you", the name, or the address. */
  label: string;
  /** True when the address is one of the owner's own. */
  you: boolean;
}

export interface RecipientDescription {
  /** "you and Dana", "Dana and 4 others"; empty when the message names no To recipient. */
  to: string;
  /** "Priya and 2 others"; null when nothing is copied. */
  cc: string | null;
  /** The whole collapsed line: "to you and Dana, cc Priya". */
  text: string;
  /** Every address in the message, grouped To, then Cc, then Bcc. */
  rows: RecipientRow[];
}

const YOU = "you";

function ownerSet(owners: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const o of owners) if (o) set.add(o.trim().toLowerCase());
  return set;
}

/** The first name, else the part of the address before the @. "you" for the owner. */
function shortName(a: Address, own: Set<string>): string {
  if (own.has(a.email.trim().toLowerCase())) return YOU;
  const name = a.name.trim();
  if (name && !name.includes("@")) return name.split(/\s+/)[0] ?? name;
  const local = a.email.split("@")[0] ?? "";
  return local || a.email || "someone";
}

/** One name, two names joined by "and", or the first name and how many others. */
export function collapseNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

function dedupe(list: ReadonlyArray<Address>, seen: Set<string>): Address[] {
  const out: Address[] = [];
  for (const a of list) {
    const key = a.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** The owner first, so a line about Oliver always starts with "you". */
function order(list: Address[], own: Set<string>): Address[] {
  const mine = list.filter((a) => own.has(a.email.trim().toLowerCase()));
  return mine.length ? [...mine.slice(0, 1), ...list.filter((a) => a !== mine[0])] : list;
}

function rowsFor(group: RecipientGroup, list: Address[], own: Set<string>): RecipientRow[] {
  return list.map((a) => {
    const you = own.has(a.email.trim().toLowerCase());
    return { group, name: a.name.trim(), email: a.email, label: you ? YOU : a.name.trim() || a.email, you };
  });
}

/**
 * The collapsed recipient line and the rows behind it. Addresses repeated
 * across To, Cc, and Bcc are named once, in the first group that carries them.
 */
export function describeRecipients(
  to: ReadonlyArray<Address>,
  cc: ReadonlyArray<Address>,
  bcc: ReadonlyArray<Address>,
  ownerAddresses: Iterable<string>
): RecipientDescription {
  const own = ownerSet(ownerAddresses);
  const seen = new Set<string>();
  const toList = order(dedupe(to, seen), own);
  const ccList = order(dedupe(cc, seen), own);
  const bccList = order(dedupe(bcc, seen), own);
  const toText = collapseNames(toList.map((a) => shortName(a, own)));
  const ccText = collapseNames(ccList.map((a) => shortName(a, own)));
  const parts: string[] = [];
  if (toText) parts.push(`to ${toText}`);
  if (ccText) parts.push(`cc ${ccText}`);
  return {
    to: toText,
    cc: ccText || null,
    text: parts.length ? parts.join(", ") : "No recipients",
    rows: [...rowsFor("To", toList, own), ...rowsFor("Cc", ccList, own), ...rowsFor("Bcc", bccList, own)],
  };
}

function letters(source: string): string {
  const words = source
    .split(/[\s._+-]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return "";
}

/** Two letters for the avatar: the display name's first two words, else the address. */
export function initials(name: string, email: string): string {
  const n = name.trim();
  const fromName = n && !n.includes("@") ? letters(n) : "";
  if (fromName) return fromName;
  return letters(email.split("@")[0] ?? "") || letters(email) || "?";
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

function unit(count: number, name: string): string {
  const n = Math.max(1, Math.floor(count));
  return `${n} ${name}${n === 1 ? "" : "s"}`;
}

/** "2 hours ago", "3 days ago". A time still ahead reads "in 2 hours". */
export function relativeTime(ts: number, now = Date.now()): string {
  const ms = now - ts;
  const ahead = ms < 0;
  const s = Math.abs(ms) / 1000;
  if (s < 45) return ahead ? "in a moment" : "just now";
  let said: string;
  if (s < HOUR) said = unit(s / MINUTE, "minute");
  else if (s < DAY) said = unit(s / HOUR, "hour");
  else if (s < 7 * DAY) said = unit(s / DAY, "day");
  else if (s < 35 * DAY) said = unit(s / (7 * DAY), "week");
  else if (s < 365 * DAY) said = unit(s / (30 * DAY), "month");
  else said = unit(s / (365 * DAY), "year");
  return ahead ? `in ${said}` : `${said} ago`;
}

export interface EyebrowInput {
  from: Address;
  to: ReadonlyArray<Address>;
  cc: ReadonlyArray<Address>;
  direction: "in" | "out";
}

/**
 * The one thing worth knowing about a message's addressing, or null when
 * there is nothing to say: Oliver wrote it, it is addressed to him alone, or
 * he is only copied.
 */
export function messageEyebrow(m: EyebrowInput, ownerAddresses: Iterable<string>): string | null {
  const own = ownerSet(ownerAddresses);
  const mine = (a: Address): boolean => own.has(a.email.trim().toLowerCase());
  if (m.direction === "out" || mine(m.from)) return "Sent by you";
  if (m.to.length === 1 && mine(m.to[0]!)) return "Only to you";
  if (!m.to.some(mine) && m.cc.some(mine)) return "You are cc";
  return null;
}

/**
 * True when the sender's address adds nothing the name has not already said:
 * the name is the address, or the same person wrote an earlier message in
 * this thread and the address was shown there.
 */
export function showSenderAddress(from: Address, seenBefore: boolean): boolean {
  if (seenBefore) return false;
  const name = from.name.trim();
  if (!name) return false;
  return !name.toLowerCase().includes(from.email.trim().toLowerCase());
}

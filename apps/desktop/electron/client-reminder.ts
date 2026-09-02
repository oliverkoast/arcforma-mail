// The default reminder for client mail, applied when a send succeeds. A
// message into a thread filed under a category in remindScope, or to anyone
// with a two-way history under one, gets a remind-if-no-reply due in
// remindClientsAfterDays. The scheduler's reminder check already resolves it
// as replied when an inbound message newer than the sent one has arrived by
// then, so nothing here needs to watch for the answer.

import { clientReminderApplies, createReminder, getSetting, pendingReminder, type Db, type ReminderRow } from "@arcforma/store";
import { sendMeta } from "./compose/queue.js";
import type { Address } from "../shared/types.js";

const DAY_MS = 86_400_000;

export interface ClientReminderInput {
  accountId: string;
  /** The thread the message was sent into, when it was a reply. */
  threadId: string | null;
  /** The thread and message Gmail assigned the sent message. */
  sentThreadId: string;
  sentMessageId: string;
  recipients: Address[];
  /** The account's own addresses, so a message to oneself never counts. */
  ownAddresses: string[];
  now: number;
}

/** Creates the reminder when the rule applies and none is pending on the thread. Returns the row, or null when nothing was made. */
export function applyClientReminder(db: Db, input: ClientReminderInput): ReminderRow | null {
  const days = Number(getSetting(db, "remindClientsAfterDays"));
  if (!Number.isFinite(days) || days <= 0) return null;
  const scope = getSetting(db, "remindScope");
  if (!Array.isArray(scope) || scope.length === 0) return null;
  const own = new Set(input.ownAddresses.map((a) => a.toLowerCase()));
  const recipients = Array.from(new Set(input.recipients.map((a) => a.email.toLowerCase()).filter((e) => e && !own.has(e))));
  if (recipients.length === 0) return null;
  const threadId = input.sentThreadId || input.threadId;
  if (!threadId) return null;
  if (pendingReminder(db, input.accountId, threadId)) return null;
  if (!clientReminderApplies(db, { accountId: input.accountId, threadId: input.threadId, recipients, scope })) return null;
  return createReminder(db, { accountId: input.accountId, threadId, lastMessageId: input.sentMessageId, dueAt: input.now + days * DAY_MS, now: input.now });
}

/** The recipients a send_queue row carried, from the draft in its meta. Empty for rows without one (an unsubscribe request). */
export function sentRecipients(row: { meta_json: string }): Address[] {
  const draft = sendMeta(row).draft;
  if (!draft) return [];
  return [...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])];
}

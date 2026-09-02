// One-line answers to "what is this" for the sidebar. Builtin rows have a
// fixed sentence; a custom category answers with its description and a saved
// search with its query, so the tooltip is never blanker than the row itself.

import type { AccountInfo, CategoryInfo, SavedSearchInfo } from "../../shared/types";
import type { SidebarRowDescriptor } from "./sidebarLayout";

const ROW_TIPS: Record<string, string> = {
  needsyou: "Threads where a person asked you something and you have not replied since. Nothing bulk, nothing automated, nothing you have already answered.",
  daily: "Important threads with new mail since you last left the app, plus anything added with D and every snooze or reminder that woke today. Clear it every day.",
  weekly: "Threads added with W, and whatever was left in Daily 0 when the day rolled over. Clear it by the end of the week.",
  later: "Weekly 0 threads older than a week. Nothing here is on a clock.",
  inbox: "Every thread in the inbox, important and other together.",
  important: "What the classifier thinks needs you.",
  other: "Everything else in the inbox.",
  unread: "Threads with mail you have not opened yet.",
  attachments: "Threads with a file attached.",
  "category:newsletters": "Editorial mail you subscribed to: publications, digests, and mailing lists.",
  "category:promotions": "Mail that is selling something: offers, sales, product upsell, and event invitations.",
  "category:jobs": "Hiring mail: applicants, applications, candidate alerts, and recruiter outreach.",
  "category:calendar": "Calendar invitations and replies.",
  "category:notifications": "Transactional alerts from apps and services, reporting something that happened.",
  "category:receipts": "Receipts, invoices, and statements.",
  snoozed: "Threads that are away until their snooze time, then back in the inbox with a notification.",
  starred: "Threads you starred.",
  sent: "Mail you sent, from every account.",
  drafts: "Drafts written here and in Gmail, in one list.",
  scheduled: "Mail waiting to send later. Open one to cancel the send.",
  archive: "Out of the inbox, still in All Mail.",
  spam: "What Gmail flagged as spam.",
  trash: "Deleted mail. Gmail empties it after 30 days.",
};

/** What a sidebar row contains. */
export function sidebarRowTip(row: Pick<SidebarRowDescriptor, "id" | "kind" | "ref" | "label">, categories: ReadonlyArray<CategoryInfo>, searches: ReadonlyArray<SavedSearchInfo>): string {
  const fixed = ROW_TIPS[row.id];
  if (fixed) return fixed;
  if (row.kind === "category") {
    const c = categories.find((x) => x.id === row.ref);
    return c?.prompt.trim() ? `Category: ${c.prompt.trim()}` : `Category ${row.label}. Describe what belongs in Settings.`;
  }
  if (row.kind === "search") {
    const s = searches.find((x) => String(x.id) === row.ref);
    return s ? `Saved search: ${s.query}` : `Saved search ${row.label}.`;
  }
  return row.label;
}

/** The account row: what a click and a double-click do, and where the account stands. */
export function accountTip(a: Pick<AccountInfo, "authState" | "syncState" | "error">): string {
  const state =
    a.authState === "expired"
      ? "Google expired the token. Sign in again from Settings."
      : a.authState === "signed_out"
        ? "Signed out. Sign in from Settings."
        : a.syncState === "backfill" || a.syncState === "new"
          ? "Signed in. First sync running."
          : a.error
            ? `Signed in. Sync error: ${a.error}`
            : "Signed in and syncing.";
  return `Click to filter the list to this account. Double-click to open its inbox.\n${state}`;
}

import type { InboxView } from "../../shared/types";
// One table drives every shortcut. Scope decides where a key applies; the
// dispatcher adds "global" to whatever scope is active. Inside "compose",
// "ask", "settings", and the command palette plain letters never reach list actions.

export type Scope = "global" | "list" | "thread" | "compose" | "sendLater" | "popover" | "sidebar" | "search" | "ask" | "settings" | "snippets" | "palette" | "setup";

export interface Binding {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  scope: Scope;
  action: string;
  label: string;
}

/** Scopes where the user is typing: only Cmd chords, Escape, Tab, and Enter bindings apply. */
export const TYPING_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["compose", "ask", "settings", "search", "snippets", "palette", "setup"]);

export const KEYMAP: Binding[] = [
  { key: "j", scope: "list", action: "next", label: "Next thread" },
  { key: "k", scope: "list", action: "prev", label: "Previous thread" },
  { key: "j", scope: "thread", action: "next", label: "Next thread" },
  { key: "k", scope: "thread", action: "prev", label: "Previous thread" },
  { key: "e", scope: "list", action: "archive", label: "Mark done" },
  { key: "e", scope: "thread", action: "archive", label: "Mark done" },
  // Shift+E is the way back. U was taken by unsubscribe long before Done had a row of its own.
  { key: "e", shift: true, scope: "list", action: "moveToInbox", label: "Move back to inbox" },
  { key: "e", shift: true, scope: "thread", action: "moveToInbox", label: "Move back to inbox" },
  { key: "c", scope: "list", action: "compose", label: "Compose" },
  { key: "c", scope: "thread", action: "compose", label: "Compose" },
  { key: "/", scope: "list", action: "search", label: "Search" },
  { key: "/", scope: "thread", action: "search", label: "Search" },
  { key: "h", scope: "list", action: "snooze", label: "Snooze" },
  { key: "h", scope: "thread", action: "snooze", label: "Snooze" },
  { key: "s", scope: "list", action: "star", label: "Star" },
  { key: "s", scope: "thread", action: "star", label: "Star" },
  { key: "d", scope: "list", action: "toggleDaily", label: "Add to or remove from Daily 0" },
  { key: "d", scope: "thread", action: "toggleDaily", label: "Add to or remove from Daily 0" },
  { key: "w", scope: "list", action: "toggleWeekly", label: "Add to or remove from Weekly 0" },
  { key: "w", scope: "thread", action: "toggleWeekly", label: "Add to or remove from Weekly 0" },
  { key: "r", scope: "list", action: "reply", label: "Reply" },
  { key: "r", scope: "thread", action: "reply", label: "Reply" },
  { key: "a", scope: "list", action: "replyAll", label: "Reply all" },
  { key: "a", scope: "thread", action: "replyAll", label: "Reply all" },
  { key: "f", scope: "list", action: "forward", label: "Forward" },
  { key: "f", scope: "thread", action: "forward", label: "Forward" },
  { key: "u", scope: "list", action: "unsubscribe", label: "Unsubscribe and archive" },
  { key: "u", scope: "thread", action: "unsubscribe", label: "Unsubscribe and archive" },
  // O in a thread: every earlier message open at once, and again to fold them back.
  { key: "o", scope: "thread", action: "toggleAllMessages", label: "Expand or collapse the earlier messages" },
  { key: "z", scope: "list", action: "undo", label: "Undo" },
  { key: "z", scope: "thread", action: "undo", label: "Undo" },
  { key: "z", scope: "popover", action: "undo", label: "Undo" },
  { key: "Enter", scope: "list", action: "open", label: "Open thread" },
  // Also while reading: hovering a row selects it, so Enter has something to open even with a
  // thread already on the right.
  { key: "Enter", scope: "thread", action: "open", label: "Open thread" },
  { key: "Escape", scope: "thread", action: "close", label: "Back to list" },
  { key: "Escape", scope: "popover", action: "closePopover", label: "Close" },
  // The sidebar's add and row menus: only Escape, so T, W, D, R never snooze a thread while the menu is up.
  { key: "Escape", scope: "sidebar", action: "closeSidebarMenu", label: "Close" },
  { key: "Escape", scope: "search", action: "leaveSearch", label: "Leave search" },
  { key: "Enter", scope: "search", action: "runSearch", label: "Search" },
  { key: "1", scope: "thread", action: "instantReply1", label: "Accept instant reply 1" },
  { key: "2", scope: "thread", action: "instantReply2", label: "Accept instant reply 2" },
  { key: "3", scope: "thread", action: "instantReply3", label: "Accept instant reply 3" },
  { key: "Tab", scope: "compose", action: "acceptDraft", label: "Accept auto-draft" },
  { key: "Escape", scope: "compose", action: "closeCompose", label: "Keep the draft" },
  { key: "Enter", meta: true, scope: "compose", action: "send", label: "Send" },
  { key: "l", meta: true, shift: true, scope: "compose", action: "sendLater", label: "Send later, pick a time" },
  { key: "d", meta: true, shift: true, scope: "compose", action: "discardCompose", label: "Discard draft" },
  { key: "Escape", scope: "sendLater", action: "closeSendLater", label: "Back to the message" },
  { key: "t", scope: "sendLater", action: "sendTomorrow", label: "Tomorrow 9:00" },
  { key: "w", scope: "sendLater", action: "sendNextMonday", label: "Next Monday 9:00" },
  { key: "d", scope: "sendLater", action: "sendPick", label: "Pick a time" },
  { key: ";", meta: true, scope: "compose", action: "snippets", label: "Snippet picker" },
  { key: "Escape", scope: "snippets", action: "closeSnippets", label: "Close" },
  { key: "\\", meta: true, scope: "global", action: "toggleReadingPane", label: "Show or hide the reading pane" },
  { key: "c", meta: true, shift: true, scope: "global", action: "toggleCalendar", label: "Calendar rail" },
  { key: "i", meta: true, shift: true, scope: "global", action: "toggleContact", label: "Contact rail" },
  { key: "a", meta: true, shift: true, scope: "global", action: "ask", label: "Ask AI" },
  { key: "Escape", scope: "ask", action: "closeAsk", label: "Close Ask" },
  { key: "Enter", scope: "ask", action: "runAsk", label: "Ask" },
  { key: ",", meta: true, scope: "global", action: "settings", label: "Settings" },
  // The command palette: Cmd+K opens it from the list, the thread, and the compose editor; the same chord or Escape closes it.
  { key: "k", meta: true, scope: "global", action: "palette", label: "Command palette" },
  { key: "Escape", scope: "palette", action: "closePalette", label: "Close the palette" },
  { key: "Escape", scope: "settings", action: "closeSettings", label: "Close settings" },
  { key: "t", scope: "popover", action: "snoozeTomorrow", label: "Tomorrow" },
  { key: "w", scope: "popover", action: "snoozeNextWeek", label: "Next week" },
  { key: "d", scope: "popover", action: "snoozePick", label: "Pick a date" },
  { key: "r", scope: "popover", action: "remindThreeDays", label: "Remind if no reply in 3 days" },
];

/**
 * G, then a letter: go to a view. Superhuman's "go to" chords, and the reason they are worth having
 * is that they are the only way to reach a view without leaving the keyboard or reading the sidebar.
 *
 * The letters are not arbitrary. Wherever an action already owns a letter, the view that action
 * sends mail to owns the same one: E marks done, so G E is Done; H snoozes, so G H is Snoozed; S
 * stars, so G S is Starred; U is unread. That way there is one alphabet to learn rather than two.
 */
export const GO_TO: ReadonlyArray<{ key: string; view: InboxView; label: string }> = [
  { key: "i", view: "inbox", label: "Inbox" },
  { key: "a", view: "all", label: "Everything" },
  { key: "n", view: "needsyou", label: "Needs you" },
  { key: "t", view: "sent", label: "Sent" },
  { key: "d", view: "drafts", label: "Drafts" },
  { key: "e", view: "archive", label: "Done" },
  { key: "h", view: "snoozed", label: "Snoozed" },
  { key: "s", view: "starred", label: "Starred" },
  { key: "u", view: "unread", label: "Unread" },
  { key: "c", view: "scheduled", label: "Scheduled" },
];

/** The view a letter goes to after G, or null when that letter means nothing here. */
export function resolveGoTo(key: string): { view: InboxView; label: string } | null {
  const hit = GO_TO.find((g) => g.key === key.toLowerCase());
  return hit ? { view: hit.view, label: hit.label } : null;
}

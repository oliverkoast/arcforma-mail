// Which messages of an open thread start expanded, and what the control above
// them says. Order stays chronological, oldest first, because that is the only
// order in which a quoted reply reads correctly; what changes is how much of
// the history is on screen. A collapsed message renders no body iframe at all,
// so a 47 message thread mounts the two or three frames it is showing rather
// than 47 sandboxed documents.
//
// Everything here is pure, so node:test can drive the rules without a DOM.

import type { MessageView } from "../../shared/types";

/** The fields the rules read. */
export type CollapsibleMessage = Pick<MessageView, "id" | "labelIds">;

export function isUnread(m: CollapsibleMessage): boolean {
  return m.labelIds.includes("UNREAD");
}

/**
 * The messages a thread opens with expanded: the newest one, the one that
 * started the thread, and anything still unread. Everything else is a one-line
 * row until it is clicked.
 */
export function defaultExpanded(messages: readonly CollapsibleMessage[]): string[] {
  return messages.filter((m, i) => i === 0 || i === messages.length - 1 || isUnread(m)).map((m) => m.id);
}

/** How many messages the control above the first one would open. */
export function collapsedCount(messages: readonly CollapsibleMessage[]): number {
  return messages.length - defaultExpanded(messages).length;
}

/** The control's two labels. Each says what pressing it does. */
export function expandAllLabel(n: number): string {
  return `Show all ${n} earlier ${n === 1 ? "message" : "messages"}`;
}
export const COLLAPSE_ALL_LABEL = "Collapse earlier messages";

/** About this many characters of the message on a collapsed row. */
export const SNIPPET_CHARS = 90;

/** The one-line preview on a collapsed row: whitespace flattened, cut at a word boundary. */
export function rowSnippet(text: string, max = SNIPPET_CHARS): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

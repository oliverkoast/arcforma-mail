// The command palette's registry and matcher. One list of commands is built
// from the keymap (every action, its label, its key) plus what the current
// state adds: the custom categories to move a thread to, the sidebar rows to
// open, the accounts still signed out, the snippets a compose can insert.
// Everything here is pure so node:test can check the list for a given state.

import { KEYMAP, type Binding, type Scope } from "../keys/keymap";
import { formatBinding, keyLabel } from "../keys/keyLabel";
import { SIDEBAR_GROUPS, reconcileLayout, rowDescriptors, visibleRows, type ViewSpec } from "./sidebarLayout";
import type { AccountInfo, CategoryInfo, SavedSearchInfo, SidebarLayout, SnippetInfo, ThreadSummary } from "../../shared/types";

export type CommandRun =
  | { kind: "action"; action: string }
  | { kind: "moveTo"; categoryId: string }
  | { kind: "openView"; view: ViewSpec }
  | { kind: "signIn"; accountId: string }
  | { kind: "insertSnippet"; snippetId: number }
  | { kind: "search"; query: string };

export interface Command {
  id: string;
  label: string;
  /** The key that does the same thing, shown in mono at the right of the row; null when there is none. */
  key: string | null;
  run: CommandRun;
}

/** The slice of app state the registry reads. */
export interface CommandSource {
  /** The scope the palette opened from: "compose" gets the compose commands, everything else the mail commands. */
  scope: Scope;
  categories: CategoryInfo[];
  savedSearches: SavedSearchInfo[];
  sidebarLayout: SidebarLayout | null;
  accounts: AccountInfo[];
  snippets: SnippetInfo[];
  /** The thread a command acts on: the open thread, or the cursor row. Null when the list is empty. */
  thread: Pick<ThreadSummary, "canUnsubscribe" | "queue" | "starred"> | null;
}

/** Keymap actions that move or close things; they are keys, not commands. */
const NOT_COMMANDS = new Set(["next", "prev", "open", "close", "closePopover", "closeSidebarMenu", "leaveSearch", "runSearch", "instantReply1", "instantReply2", "instantReply3", "acceptDraft", "closeCompose", "closeSendLater", "closeSnippets", "closeAsk", "runAsk", "closeSettings", "palette", "closePalette", "sendTomorrow", "sendNextMonday", "sendPick", "snippets"]);

/** Actions that need a thread under the cursor. */
const THREAD_ACTIONS = new Set(["archive", "snooze", "snoozeTomorrow", "snoozeNextWeek", "snoozePick", "remindThreeDays", "star", "toggleDaily", "toggleWeekly", "reply", "replyAll", "forward", "unsubscribe"]);

/** The order the mail commands list in when nothing is typed. Actions the keymap adds later append after these. */
const ORDER = ["compose", "reply", "replyAll", "forward", "archive", "snooze", "snoozeTomorrow", "snoozeNextWeek", "snoozePick", "remindThreeDays", "star", "toggleDaily", "toggleWeekly", "unsubscribe", "search", "undo", "toggleReadingPane", "toggleCalendar", "toggleContact", "ask", "settings"];

/** Palette wording where the keymap's label reads as a key hint rather than a command. */
function labelFor(action: string, fallback: string, thread: CommandSource["thread"]): string {
  switch (action) {
    case "snoozeTomorrow":
      return "Snooze until tomorrow";
    case "snoozeNextWeek":
      return "Snooze until next week";
    case "snoozePick":
      return "Snooze until a date you pick";
    case "remindThreeDays":
      return "Remind me if no reply in 3 days";
    case "star":
      return thread?.starred ? "Unstar" : "Star";
    case "toggleDaily":
      return thread?.queue === "daily" ? "Remove from Daily 0" : "Add to Daily 0";
    case "toggleWeekly":
      return thread?.queue === "weekly" ? "Remove from Weekly 0" : "Add to Weekly 0";
    case "toggleCalendar":
      return "Toggle calendar rail";
    case "toggleContact":
      return "Toggle contact rail";
    case "toggleReadingPane":
      return "Show or hide the reading pane";
    default:
      return fallback;
  }
}

/** The key hint for an action. A snooze preset lives in the popover, so its hint reads "H T": the snooze key, then the preset. */
function keyFor(action: string, b: Binding): string | null {
  if (b.scope === "popover") {
    const snooze = keyLabel("snooze", "list");
    return snooze ? `${snooze} ${formatBinding(b)}` : formatBinding(b);
  }
  return keyLabel(action, "list") ?? keyLabel(action);
}

function keymapCommands(src: CommandSource): Command[] {
  const byAction = new Map<string, Binding>();
  for (const b of KEYMAP) {
    if (!["list", "thread", "global", "popover"].includes(b.scope)) continue;
    if (NOT_COMMANDS.has(b.action) || byAction.has(b.action)) continue;
    byAction.set(b.action, b);
  }
  const actions = [...ORDER.filter((a) => byAction.has(a)), ...[...byAction.keys()].filter((a) => !ORDER.includes(a))];
  const out: Command[] = [];
  for (const action of actions) {
    const b = byAction.get(action)!;
    if (THREAD_ACTIONS.has(action) && !src.thread) continue;
    if (action === "unsubscribe" && !src.thread?.canUnsubscribe) continue;
    out.push({ id: `action:${action}`, label: labelFor(action, b.label, src.thread), key: keyFor(action, b), run: { kind: "action", action } });
  }
  return out;
}

function composeCommands(src: CommandSource): Command[] {
  const out: Command[] = [
    { id: "action:send", label: "Send", key: keyLabel("send", "compose"), run: { kind: "action", action: "send" } },
    { id: "action:sendLater", label: "Send later", key: keyLabel("sendLater", "compose"), run: { kind: "action", action: "sendLater" } },
    { id: "action:discardCompose", label: "Discard draft", key: keyLabel("discardCompose", "compose"), run: { kind: "action", action: "discardCompose" } },
  ];
  for (const s of src.snippets) out.push({ id: `snippet:${s.id}`, label: `Insert snippet ${s.name}`, key: `;${s.trigger}`, run: { kind: "insertSnippet", snippetId: s.id } });
  return out;
}

/** Every sidebar row on screen, in sidebar order, as an "Open" command. */
export function sidebarCommands(src: Pick<CommandSource, "categories" | "savedSearches" | "sidebarLayout">): Command[] {
  const rows = rowDescriptors(src.categories, src.savedSearches);
  const layout = reconcileLayout(src.sidebarLayout, rows);
  return SIDEBAR_GROUPS.flatMap((g) => visibleRows(layout, g.id, rows)).map((r) => ({ id: `view:${r.id}`, label: `Open ${r.label}`, key: null, run: { kind: "openView", view: r.view } }));
}

/** The full registry for a state. Order is the order shown when nothing is typed. */
export function buildCommands(src: CommandSource): Command[] {
  if (src.scope === "compose") return composeCommands(src);
  const out = keymapCommands(src);
  // Move to <category>, right after the queue commands so filing sits with the other thread actions.
  const moves = src.thread ? src.categories.filter((c) => c.kind === "custom").map((c) => ({ id: `move:${c.id}`, label: `Move to ${c.name}`, key: null, run: { kind: "moveTo", categoryId: c.id } as CommandRun })) : [];
  const at = out.findIndex((c) => c.id === "action:search");
  out.splice(at < 0 ? out.length : at, 0, ...moves);
  out.push(...sidebarCommands(src));
  for (const a of src.accounts) if (a.authState === "signed_out") out.push({ id: `signIn:${a.id}`, label: `Sign in ${a.email}`, key: null, run: { kind: "signIn", accountId: a.id } });
  return out;
}

// ---- matching -----------------------------------------------------------------------

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  return !/[a-z0-9]/i.test(prev);
}

/**
 * Subsequence match: every character of the query appears in the text, in
 * order. The score rewards characters that land on the start of a word and
 * characters that follow the previous match directly, so "sno" prefers
 * "Snooze until tomorrow" to "Sign in oliver". Null when it does not match.
 * Case-insensitive; whitespace in the query is ignored.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let pos = 0;
  let prev = -2;
  for (const ch of q) {
    // Prefer a word-start occurrence when one is ahead, else the next occurrence.
    let i = -1;
    for (let j = t.indexOf(ch, pos); j >= 0; j = t.indexOf(ch, j + 1)) {
      if (isWordStart(t, j) || j === prev + 1) {
        i = j;
        break;
      }
      if (i < 0) i = j;
    }
    if (i < 0) return null;
    score += isWordStart(t, i) ? 3 : 1;
    if (i === prev + 1) score += 2;
    prev = i;
    pos = i + 1;
  }
  // A match that starts early edges out one that starts late; a short label edges out a long one.
  return score - Math.min(t.indexOf(q[0]!), 20) * 0.05 - Math.min(t.length, 60) * 0.005;
}

export const PALETTE_ROWS = 8;

/**
 * The rows the palette shows for what is typed: the best eight matches by
 * score, keeping registry order among equals. With text that is not a
 * command, a "Search for <text>" row closes the list.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim();
  if (!q) return commands.slice(0, PALETTE_ROWS);
  const scored = commands.map((c, i) => ({ c, i, s: fuzzyScore(q, c.label) })).filter((x): x is { c: Command; i: number; s: number } => x.s !== null);
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const exact = scored.some((x) => x.c.label.toLowerCase() === q.toLowerCase());
  const search: Command = { id: "search", label: `Search for ${q}`, key: null, run: { kind: "search", query: q } };
  if (exact) return scored.slice(0, PALETTE_ROWS).map((x) => x.c);
  return [...scored.slice(0, PALETTE_ROWS - 1).map((x) => x.c), search];
}

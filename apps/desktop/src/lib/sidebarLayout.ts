// The sidebar is data: a list of row descriptors (what a row is, which view it
// opens, where its count comes from) and a layout (which group each row sits
// in, in what order, shown or hidden). The layout is what persists; the
// descriptors are rebuilt from categories and saved searches every render, and
// reconcileLayout brings a stored layout up to date with them: rows that no
// longer exist drop out, rows the store never saw append to their default
// group. Every function here is pure so node:test can drive it.

import type { CategoryInfo, InboxView, SavedSearchInfo, SidebarCounts, SidebarGroupId, SidebarLayout, SidebarLayoutRow } from "../../shared/types";

export type SidebarRowKind = "builtin" | "category" | "search";

export interface ViewSpec {
  view: InboxView;
  split?: "important" | "other" | null;
  category?: string | null;
}

export interface SidebarRowDescriptor {
  id: string;
  kind: SidebarRowKind;
  label: string;
  /** Where the row lands when the layout has never seen it. */
  group: SidebarGroupId;
  view: ViewSpec;
  count: (c: SidebarCounts) => number;
  hiddenByDefault?: boolean;
  /**
   * A row that earns its place whether or not it has anything in it. Everything else is a filter or
   * an overflow, and a filter matching nothing is noise: it is folded away until it has something,
   * or until the reader asks to see the whole group.
   */
  alwaysShown?: boolean;
  /** Where a row the stored layout never saw wants to land: right after this row id, when that row is in the same group. */
  after?: string;
  /** A row the stored layout never saw that belongs at the head of its group rather than the end. */
  first?: boolean;
  /** The category id or saved search id behind a category or search row, for rename and remove. */
  ref?: string;
}

export const SIDEBAR_GROUPS: ReadonlyArray<{ id: SidebarGroupId; label: string }> = [
  { id: "queues", label: "Queues" },
  { id: "inbox", label: "Inbox" },
  { id: "folders", label: "Folders" },
];

/** The builtin type rows, in the order the Inbox group lists them. */
const BUILTIN_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "newsletters", label: "Newsletters" },
  { id: "promotions", label: "Promotions" },
  { id: "jobs", label: "Jobs" },
  { id: "calendar", label: "Calendar" },
  { id: "notifications", label: "Notifications" },
  { id: "receipts", label: "Receipts" },
];

const none = () => 0;

const BUILTIN_ROWS: SidebarRowDescriptor[] = [
  // The one row that answers "what do I have to deal with". It sits above the queues because it is
  // the only list where something is waiting on him rather than on his calendar.
  { id: "needsyou", kind: "builtin", label: "Needs you", group: "queues", view: { view: "needsyou" }, count: (c) => c.needsYou, first: true, alwaysShown: true },
  { id: "daily", kind: "builtin", label: "Daily 0", group: "queues", view: { view: "daily" }, count: (c) => c.daily, alwaysShown: true },
  { id: "weekly", kind: "builtin", label: "Weekly 0", group: "queues", view: { view: "weekly" }, count: (c) => c.weekly },
  { id: "later", kind: "builtin", label: "Later", group: "queues", view: { view: "later" }, count: (c) => c.later },
  { id: "inbox", kind: "builtin", label: "Everything", group: "inbox", view: { view: "inbox" }, count: (c) => c.inbox, alwaysShown: true },
  { id: "important", kind: "builtin", label: "Important", group: "inbox", view: { view: "inbox", split: "important" }, count: (c) => c.important, alwaysShown: true },
  { id: "other", kind: "builtin", label: "Other", group: "inbox", view: { view: "inbox", split: "other" }, count: (c) => c.other, alwaysShown: true },
  { id: "unread", kind: "builtin", label: "Unread", group: "inbox", view: { view: "unread" }, count: (c) => c.unread },
  { id: "attachments", kind: "builtin", label: "With attachments", group: "inbox", view: { view: "attachments" }, count: (c) => c.attachments },
  { id: "snoozed", kind: "builtin", label: "Snoozed", group: "folders", view: { view: "snoozed" }, count: (c) => c.snoozed },
  { id: "starred", kind: "builtin", label: "Starred", group: "folders", view: { view: "starred" }, count: (c) => c.starred },
  { id: "sent", kind: "builtin", label: "Sent", group: "folders", view: { view: "sent" }, count: none, alwaysShown: true },
  { id: "drafts", kind: "builtin", label: "Drafts", group: "folders", view: { view: "drafts" }, count: none, alwaysShown: true },
  { id: "scheduled", kind: "builtin", label: "Scheduled", group: "folders", view: { view: "scheduled" }, count: (c) => c.scheduled },
  // Done in the interface, "archive" as the stored id, so a layout saved when
  // the row was called Archive keeps its place, its order, and its hidden flag.
  { id: "archive", kind: "builtin", label: "Done", group: "folders", view: { view: "archive" }, count: (c) => c.archive, alwaysShown: true },
  { id: "spam", kind: "builtin", label: "Spam", group: "folders", view: { view: "spam" }, count: (c) => c.spam, hiddenByDefault: true },
  { id: "trash", kind: "builtin", label: "Trash", group: "folders", view: { view: "trash" }, count: (c) => c.trash, hiddenByDefault: true },
];

/** Every row the sidebar can show right now: the builtins, the four builtin types, each custom category, each saved search. */
export function rowDescriptors(categories: CategoryInfo[], searches: SavedSearchInfo[]): SidebarRowDescriptor[] {
  const custom = categories.filter((c) => c.kind === "custom");
  const withOrder = (rows: SidebarRowDescriptor[], afterId: string, extra: SidebarRowDescriptor[]) => {
    const i = rows.findIndex((r) => r.id === afterId);
    return [...rows.slice(0, i + 1), ...extra, ...rows.slice(i + 1)];
  };
  const types: SidebarRowDescriptor[] = BUILTIN_TYPES.map((t, i) => ({
    id: `category:${t.id}`,
    kind: "builtin",
    label: t.label,
    group: "inbox",
    view: { view: "inbox", category: t.id },
    count: (c) => c.categories[t.id] ?? 0,
    // A type row added after a layout was saved slots in behind the type before it rather than
    // landing under the custom categories at the end of the group.
    after: i === 0 ? "attachments" : `category:${BUILTIN_TYPES[i - 1]!.id}`,
  }));
  const customRows: SidebarRowDescriptor[] = custom.map((c) => ({
    id: `category:${c.id}`,
    kind: "category",
    label: c.name,
    group: "inbox",
    view: { view: "inbox", category: c.id },
    count: (n) => n.categories[c.id] ?? 0,
    ref: c.id,
  }));
  const searchRows: SidebarRowDescriptor[] = searches.map((s) => ({
    id: `search:${s.id}`,
    kind: "search",
    label: s.name,
    group: "folders",
    view: { view: `search:${s.id}` },
    count: (n) => n.searches[String(s.id)] ?? 0,
    ref: String(s.id),
  }));
  return [...withOrder(BUILTIN_ROWS, "attachments", [...types, ...customRows]), ...searchRows];
}

/**
 * Which rows a group actually shows. A row is shown when it is pinned, when it holds something,
 * when it is the view being read, or when the reader has asked for the whole group. The rest are
 * counted so the group can offer them, and a group whose every row is empty still shows its pinned
 * rows rather than collapsing to nothing.
 */
export function rowsToShow(
  rows: SidebarRowDescriptor[],
  countOf: (row: SidebarRowDescriptor) => number,
  isActive: (row: SidebarRowDescriptor) => boolean,
  showAll: boolean
): { shown: SidebarRowDescriptor[]; folded: number } {
  if (showAll) return { shown: rows, folded: 0 };
  const shown = rows.filter((r) => r.alwaysShown === true || isActive(r) || countOf(r) > 0);
  return { shown, folded: rows.length - shown.length };
}

export function defaultLayout(rows: SidebarRowDescriptor[]): SidebarLayout {
  return {
    version: 1,
    groups: SIDEBAR_GROUPS.map((g) => ({ id: g.id, rows: rows.filter((r) => r.group === g.id).map((r) => ({ id: r.id, hidden: r.hiddenByDefault === true })) })),
  };
}

function isGroupId(v: unknown): v is SidebarGroupId {
  return v === "queues" || v === "inbox" || v === "folders";
}

/**
 * Brings a stored layout in step with the rows that exist now. Known rows keep
 * their saved group, order, and hidden flag. Rows the layout never saw land in
 * their default group, behind the row they name in `after` when that row is
 * there and at the end otherwise. Ids the app no longer knows are dropped.
 * Anything unreadable falls back to the default layout.
 */
export function reconcileLayout(saved: unknown, rows: SidebarRowDescriptor[]): SidebarLayout {
  const known = new Map(rows.map((r) => [r.id, r]));
  const s = saved as { version?: unknown; groups?: unknown } | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.groups)) return defaultLayout(rows);
  const placed = new Set<string>();
  const groups = SIDEBAR_GROUPS.map((g) => {
    const stored = (s.groups as unknown[]).find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === g.id) as { rows?: unknown } | undefined;
    const out: SidebarLayoutRow[] = [];
    for (const raw of Array.isArray(stored?.rows) ? (stored!.rows as unknown[]) : []) {
      const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : raw;
      if (typeof id !== "string" || !known.has(id) || placed.has(id)) continue;
      placed.add(id);
      out.push({ id, hidden: Boolean((raw as { hidden?: unknown }).hidden) });
    }
    return { id: g.id, rows: out };
  });
  // Passes over the unplaced rows in descriptor order, so a run of new rows keeps its own order
  // while each one lands behind the anchor it names.
  for (const r of rows) {
    if (placed.has(r.id)) continue;
    placed.add(r.id);
    const group = groups.find((g) => g.id === r.group)!;
    const row = { id: r.id, hidden: r.hiddenByDefault === true };
    const at = r.after ? group.rows.findIndex((x) => x.id === r.after) : -1;
    if (at >= 0) group.rows.splice(at + 1, 0, row);
    else if (r.first) group.rows.unshift(row);
    else group.rows.push(row);
  }
  return { version: 1, groups };
}

/** Moves a row into a group, before the given row id, or to the end of the group when beforeId is null or unknown. */
export function moveRow(layout: SidebarLayout, rowId: string, toGroup: SidebarGroupId, beforeId: string | null): SidebarLayout {
  if (!isGroupId(toGroup) || rowId === beforeId) return layout;
  let moving: SidebarLayoutRow | null = null;
  for (const g of layout.groups) {
    const found = g.rows.find((r) => r.id === rowId);
    if (found) moving = found;
  }
  if (!moving) return layout;
  const row = moving;
  return {
    version: 1,
    groups: layout.groups.map((g) => {
      const rows = g.rows.filter((r) => r.id !== rowId);
      if (g.id !== toGroup) return { id: g.id, rows };
      const at = beforeId === null ? -1 : rows.findIndex((r) => r.id === beforeId);
      if (at < 0) return { id: g.id, rows: [...rows, row] };
      return { id: g.id, rows: [...rows.slice(0, at), row, ...rows.slice(at)] };
    }),
  };
}

export function setRowHidden(layout: SidebarLayout, rowId: string, hidden: boolean): SidebarLayout {
  return { version: 1, groups: layout.groups.map((g) => ({ id: g.id, rows: g.rows.map((r) => (r.id === rowId ? { id: r.id, hidden } : r)) })) };
}

export function groupOf(layout: SidebarLayout, rowId: string): SidebarGroupId | null {
  return layout.groups.find((g) => g.rows.some((r) => r.id === rowId))?.id ?? null;
}

/** The rows a group shows, in order, resolved to their descriptors. */
export function visibleRows(layout: SidebarLayout, group: SidebarGroupId, rows: SidebarRowDescriptor[]): SidebarRowDescriptor[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (layout.groups.find((g) => g.id === group)?.rows ?? []).filter((r) => !r.hidden).map((r) => byId.get(r.id)).filter((r): r is SidebarRowDescriptor => Boolean(r));
}

/** Every hidden row across the groups, in layout order, for "Show a hidden row". */
export function hiddenRows(layout: SidebarLayout, rows: SidebarRowDescriptor[]): SidebarRowDescriptor[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return layout.groups.flatMap((g) => g.rows.filter((r) => r.hidden).map((r) => byId.get(r.id))).filter((r): r is SidebarRowDescriptor => Boolean(r));
}

export function layoutsEqual(a: SidebarLayout, b: SidebarLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ViewState {
  view: InboxView;
  split: "important" | "other" | null;
  category: string | null;
}

export function isActiveView(spec: ViewSpec, state: ViewState): boolean {
  return spec.view === state.view && (spec.split ?? null) === state.split && (spec.category ?? null) === state.category;
}

/** The list title for the current view, from the row that opens it. */
export function viewTitle(rows: SidebarRowDescriptor[], state: ViewState): string | null {
  return rows.find((r) => isActiveView(r.view, state))?.label ?? null;
}

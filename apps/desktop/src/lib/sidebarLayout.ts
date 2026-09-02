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
  /** The category id or saved search id behind a category or search row, for rename and remove. */
  ref?: string;
}

export const SIDEBAR_GROUPS: ReadonlyArray<{ id: SidebarGroupId; label: string }> = [
  { id: "queues", label: "Queues" },
  { id: "inbox", label: "Inbox" },
  { id: "folders", label: "Folders" },
];

const BUILTIN_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "newsletters", label: "Newsletters" },
  { id: "calendar", label: "Calendar" },
  { id: "notifications", label: "Notifications" },
  { id: "receipts", label: "Receipts" },
];

const none = () => 0;

const BUILTIN_ROWS: SidebarRowDescriptor[] = [
  { id: "daily", kind: "builtin", label: "Daily 0", group: "queues", view: { view: "daily" }, count: (c) => c.daily },
  { id: "weekly", kind: "builtin", label: "Weekly 0", group: "queues", view: { view: "weekly" }, count: (c) => c.weekly },
  { id: "later", kind: "builtin", label: "Later", group: "queues", view: { view: "later" }, count: (c) => c.later },
  { id: "inbox", kind: "builtin", label: "Everything", group: "inbox", view: { view: "inbox" }, count: (c) => c.inbox },
  { id: "important", kind: "builtin", label: "Important", group: "inbox", view: { view: "inbox", split: "important" }, count: (c) => c.important },
  { id: "other", kind: "builtin", label: "Other", group: "inbox", view: { view: "inbox", split: "other" }, count: (c) => c.other },
  { id: "unread", kind: "builtin", label: "Unread", group: "inbox", view: { view: "unread" }, count: (c) => c.unread },
  { id: "attachments", kind: "builtin", label: "With attachments", group: "inbox", view: { view: "attachments" }, count: (c) => c.attachments },
  { id: "snoozed", kind: "builtin", label: "Snoozed", group: "folders", view: { view: "snoozed" }, count: (c) => c.snoozed },
  { id: "starred", kind: "builtin", label: "Starred", group: "folders", view: { view: "starred" }, count: (c) => c.starred },
  { id: "sent", kind: "builtin", label: "Sent", group: "folders", view: { view: "sent" }, count: none },
  { id: "drafts", kind: "builtin", label: "Drafts", group: "folders", view: { view: "drafts" }, count: none },
  { id: "scheduled", kind: "builtin", label: "Scheduled", group: "folders", view: { view: "scheduled" }, count: (c) => c.scheduled },
  { id: "archive", kind: "builtin", label: "Archive", group: "folders", view: { view: "archive" }, count: (c) => c.archive },
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
  const types: SidebarRowDescriptor[] = BUILTIN_TYPES.map((t) => ({
    id: `category:${t.id}`,
    kind: "builtin",
    label: t.label,
    group: "inbox",
    view: { view: "inbox", category: t.id },
    count: (c) => c.categories[t.id] ?? 0,
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
 * their saved group, order, and hidden flag. Rows the layout never saw append
 * to their default group. Ids the app no longer knows are dropped. Anything
 * unreadable falls back to the default layout.
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
  for (const r of rows) {
    if (placed.has(r.id)) continue;
    const group = groups.find((g) => g.id === r.group)!;
    group.rows.push({ id: r.id, hidden: r.hiddenByDefault === true });
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

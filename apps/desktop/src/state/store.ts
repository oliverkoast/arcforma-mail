import { create } from "zustand";
import { QUOTE_FORBID_ATTR, QUOTE_FORBID_TAGS } from "../lib/quote-policy";
import DOMPurify from "dompurify";
import { invoke, isElectron, on } from "../bridge";
import {
  EMPTY_SIDEBAR_COUNTS,
  type AccountsStatus,
  type AiErrorCode,
  type AttachmentSaveResult,
  type AiStatus,
  type AskResult,
  type CategoryInfo,
  type ComposeDraft,
  type ComposeMode,
  type DraftInfo,
  type InboxView,
  type InstantRepliesResult,
  type QueueName,
  type RefileTarget,
  type SavedSearchInfo,
  type SearchHitView,
  type SettingsInfo,
  type SidebarCounts,
  type SidebarGroupId,
  type SidebarLayout,
  type AddAccountRequest,
  type OnboardingInfo,
  type SnippetInfo,
  type SummaryResult,
  type SyncProgress,
  type ThreadSummary,
  type ThreadView,
  type ToastEvent,
  type ToastUndo,
} from "../../shared/types";
import { ONBOARDING_STEPS, type OnboardingStepId } from "../../shared/onboarding";
import { TYPING_SCOPES, type Scope } from "../keys/keymap";
import { scopeFor } from "../keys/scope";
import { installActivityTracker } from "../lib/activity";
import { defaultExpanded } from "../lib/collapse";
import { buildDraft, hasBody, isPending, mergePending, sameMessages, sentMessage, textToHtml } from "../lib/compose";
import { nextMondayAt, tomorrowAt } from "../lib/format";
import { expandSnippet, missingVariablesText, stripCursorToken, type ExpandedSnippet, type SnippetContext } from "../lib/snippets";

export type Rail = "none" | "calendar" | "contact";
/** Where the open compose lives: docked under a message in the reading pane, or the floating panel. */
export type ComposePlacement = "inline" | "panel";
/** The message an inline reply is docked under. A forward has no threadId of its own, so the thread is tracked here too. */
export interface InlineAnchor {
  accountId: string;
  threadId: string;
  messageId: string;
}
export interface OpenComposeOptions {
  bodyHtml?: string;
  draft?: ComposeDraft;
  placement?: ComposePlacement;
  /** Reply to this message rather than the thread's latest. */
  messageId?: string;
}
export type Popover = "snooze" | "snoozePick" | null;

/** Where a sidebar popover anchors, in window pixels. */
export interface Anchor {
  x: number;
  y: number;
}

/** The sidebar's popover: the "+" on a group header, or the "..." on a row. */
export type SidebarMenu = { kind: "add"; group: SidebarGroupId; anchor: Anchor } | { kind: "row"; rowId: string; anchor: Anchor };

export interface Ghost {
  status: "loading" | "ready" | "failed";
  text: string;
  code?: AiErrorCode;
}

/** What the compose panel exposes so store actions can reach the editor. */
export interface EditorApi {
  insertHtml: (html: string) => void;
  setHtml: (html: string) => void;
  focus: () => void;
  /** Inserts an expanded snippet and lands the caret on its {cursor}. Optional: without it the caret token is stripped and the html inserted plain. */
  insertExpanded?: (expanded: ExpandedSnippet) => void;
}

export type Loading<T> = T | { ok: "loading" } | null;

export interface AppState {
  ready: boolean;
  smoke: boolean;
  /** User-supplied art the main process can serve, by name. */
  userArt: string[];
  status: AccountsStatus;
  categories: CategoryInfo[];
  savedSearches: SavedSearchInfo[];
  counts: SidebarCounts;
  /** The stored sidebar arrangement; null until loaded or when nothing was ever saved. */
  sidebarLayout: SidebarLayout | null;
  sidebarMenu: SidebarMenu | null;
  progress: Record<string, SyncProgress>;
  view: InboxView;
  split: "important" | "other" | null;
  category: string | null;
  accountFilter: string | null;
  rows: ThreadSummary[];
  nextCursor: string | null;
  loading: boolean;
  selected: number;
  open: ThreadView | null;
  openLoading: boolean;
  /**
   * The ids of the open thread's messages that are showing their body. A
   * message not in here is a one-line row and mounts no iframe, which is the
   * whole point: a 47 message thread used to mount 47 sandboxed frames.
   */
  expandedMessages: string[];
  /** True once the "Show all N earlier messages" control (or O) has opened everything. */
  allExpanded: boolean;
  scope: Scope;
  popover: Popover;
  rail: Rail;
  /** The reading pane can be hidden so the list runs full width. Enter on a row shows it again. */
  readingPane: boolean;
  searchQuery: string;
  searchHits: SearchHitView[] | null;
  toast: ToastEvent | null;
  /** True while the pointer rests on the toast or the keyboard is in it: the dismissal timer is held. */
  toastPaused: boolean;
  error: string | null;

  settings: SettingsInfo;
  settingsOpen: boolean;
  /** Where first-run setup stands, or null before the main process has been asked. */
  onboarding: OnboardingInfo | null;
  /** True while the setup flow owns the window: first run, or Run setup again from Settings. */
  onboardingOpen: boolean;
  snippets: SnippetInfo[];
  drafts: DraftInfo[];
  aiStatus: AiStatus | null;

  compose: ComposeDraft | null;
  /**
   * The drafts row the open compose autosaves into, kept off `compose` so the
   * editor (keyed on compose.draftId) does not remount mid-sentence when the
   * first autosave lands. Close, collapse, and send fold it back in.
   */
  autosavedDraftId: number | null;
  composePlacement: ComposePlacement;
  /** An inline reply collapsed to its one-line strip. Always false for the panel. */
  inlineCollapsed: boolean;
  inlineAnchor: InlineAnchor | null;
  composeGhost: Ghost | null;
  sendLaterOpen: boolean;
  sendLaterPick: boolean;
  snippetPickerOpen: boolean;
  editorApi: EditorApi | null;

  summary: Loading<SummaryResult>;
  replies: Loading<InstantRepliesResult>;

  ask: { open: boolean; question: string; running: boolean; result: AskResult | null };

  /** The command palette (Cmd+K): open, what is typed, and the scope it opened from, which decides the command set. */
  paletteOpen: boolean;
  paletteQuery: string;
  paletteScope: Scope;

  init: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  loadThreads: (reset?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  setView: (view: InboxView, opts?: { split?: "important" | "other" | null; category?: string | null }) => void;
  setAccountFilter: (id: string | null) => void;
  /** Double-click on an account row: filter to it and open its Everything view. */
  openAccountInbox: (id: string) => void;
  select: (index: number) => void;
  move: (delta: number) => void;
  openSelected: () => Promise<void>;
  /** Opens a thread in the reading pane. Resolves true when it is showing; false when the fetch failed (the error shows unless quiet) or a later open overtook it. */
  openThreadById: (accountId: string, threadId: string, opts?: { quiet?: boolean }) => Promise<boolean>;
  closeThread: () => void;
  archiveSelected: () => Promise<void>;
  /** Shift+E, and Move back to inbox in the thread head: the thread gets INBOX again, through the outbox exactly as E takes it off. */
  moveToInboxSelected: () => Promise<void>;
  /** Click on a collapsed row, or on the header of an expanded one. */
  toggleMessage: (messageId: string) => void;
  /** O, and the control above the first message: every earlier message open, or folded back to how the thread opened. */
  toggleAllMessages: () => void;
  starSelected: () => Promise<void>;
  /** D or W on the cursor row. */
  toggleQueue: (queue: "daily" | "weekly") => Promise<void>;
  snoozeSelected: (wakeAt: number) => Promise<void>;
  remindSelected: (dueAt: number) => Promise<void>;
  /** U: runs the best unsubscribe method on the cursor row and archives it when the request went out. */
  unsubscribeSelected: () => Promise<void>;
  setLoadImages: (email: string, load: boolean) => Promise<void>;
  /**
   * Attachments whose bytes are being fetched right now, as
   * "<account>/<message>/<key>". A chip in this list shows its spinner and
   * refuses a second press, so one click never starts two fetches.
   */
  attachmentsBusy: string[];
  /** Click, or Enter, on an attachment chip: fetch if needed, then open the preview window. */
  previewAttachment: (accountId: string, messageId: string, key: string) => Promise<void>;
  /** The chip's Download glyph: fetch if needed, copy into Downloads, and show it in Finder. */
  downloadAttachment: (accountId: string, messageId: string, key: string) => Promise<void>;
  refreshCounts: () => Promise<void>;
  setPopover: (p: Popover) => void;
  openSidebarMenu: (m: SidebarMenu) => void;
  closeSidebarMenu: () => void;
  saveSidebarLayout: (layout: SidebarLayout) => Promise<void>;
  createSavedSearch: (name: string, query: string) => Promise<boolean>;
  updateSavedSearch: (id: number, patch: { name?: string; query?: string }) => Promise<boolean>;
  deleteSavedSearch: (id: number) => Promise<void>;
  /** Cancel send on an open scheduled message: the row leaves the queue and the draft reopens. */
  cancelScheduledSend: () => Promise<void>;
  setScope: (s: Scope) => void;
  syncScope: () => void;
  toggleRail: (rail: Rail) => void;
  toggleReadingPane: () => void;
  setReadingPane: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  runSearch: () => Promise<void>;
  leaveSearch: () => void;
  signIn: (id: string) => Promise<void>;
  showToast: (t: ToastEvent | null) => void;
  /** Pointer over the toast, or focus in it: the dismissal timer stops, so Undo stays reachable. */
  pauseToast: () => void;
  /** Pointer or focus leaving the toast: the timer picks up the time that was left. */
  resumeToast: () => void;
  undo: () => Promise<void>;
  notBuilt: (feature: string) => void;

  loadAiForOpen: () => Promise<void>;
  acceptInstantReply: (n: 1 | 2 | 3) => void;
  refile: (to: RefileTarget) => Promise<void>;

  openCompose: (mode: ComposeMode, opts?: OpenComposeOptions) => void;
  updateCompose: (patch: Partial<ComposeDraft>) => void;
  /** Saves the open compose to the drafts table (and so to Gmail) two seconds after the last edit. */
  autosaveCompose: () => Promise<void>;
  closeCompose: (keepDraft?: boolean) => Promise<void>;
  /** Esc: the panel closes and keeps the draft; an inline reply collapses to its strip, or closes when nothing was written. */
  dismissCompose: () => Promise<void>;
  /** Reopens a collapsed inline reply from its strip. */
  expandInline: () => void;
  /**
   * After a sync: re-reads the open thread so a reply that just arrived shows, a sent message the sync confirmed
   * replaces its optimistic copy, and bodies that failed to load get another try. Nothing changed means the pane
   * keeps its messages as they are. A thread that left the store closes with a toast.
   */
  refreshOpen: () => Promise<void>;
  sendCompose: (sendAt?: number | null) => Promise<void>;
  setSendLater: (open: boolean, pick?: boolean) => void;
  setSnippetPicker: (open: boolean) => void;
  insertSnippet: (s: SnippetInfo) => void;
  /** The recipients and account the snippet variables read from: the first To of the open compose and its account. */
  snippetContext: () => SnippetContext;
  acceptGhost: () => void;
  setEditorApi: (api: EditorApi | null) => void;

  openAsk: () => void;
  closeAsk: () => void;
  setAskQuestion: (q: string) => void;
  runAsk: (question?: string) => Promise<void>;

  openSettings: () => void;
  closeSettings: () => void;
  /** Reads the stored step and decides whether setup owns the window. */
  loadOnboarding: () => Promise<void>;
  /** Moves to a step and records it, so a quit halfway comes back to the same screen. */
  goToOnboardingStep: (step: OnboardingStepId) => void;
  finishOnboarding: () => void;
  /** Settings, Run setup again: the flow starts at the first step. */
  reopenOnboarding: () => void;
  /** Writes one OAuth client through the main process and runs its sign-in. Never resolves with the secret. */
  addOnboardingAccount: (req: AddAccountRequest) => Promise<{ ok: true } | { ok: false; error: string }>;

  /** Cmd+K. Opens from every non-typing scope and from the compose editor; a no-op while Settings, Ask, the search field, or the snippet picker has the keys. */
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setPaletteQuery: (q: string) => void;
  saveSettings: (patch: Partial<SettingsInfo>) => Promise<void>;
  saveSnippet: (s: { id?: number | null; trigger: string; name: string; bodyHtml: string; bodyText: string }) => Promise<void>;
  deleteSnippet: (id: number) => Promise<void>;
  createCategory: (name: string, prompt: string) => Promise<void>;
  updateCategory: (id: string, patch: { name?: string; prompt?: string }) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  loadDrafts: () => Promise<void>;
  /** After a drafts reload: when the open compose's row now carries different text (edited in Gmail), the compose takes it. */
  adoptDraftChange: (drafts: DraftInfo[]) => void;
  openDraft: (d: DraftInfo) => void;
  deleteDraft: (id: number) => Promise<void>;
}

function readStoredBool(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; }
}
function writeStoredBool(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* storage may be unavailable */ }
}

const EMPTY_STATUS: AccountsStatus = { accounts: [], configPath: "", configError: null };
const DEFAULT_SETTINGS: SettingsInfo = { undoWindowSec: 10, autoDraft: false, remoteImages: "always", remindClientsAfterDays: 3, remindScope: ["Clients"] };
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** How much of the current toast's time is still to run, and when that run started, so a hover can hold it. */
let toastRemaining = 0;
let toastStartedAt = 0;
/** A toast with no undo on it. */
export const TOAST_MS = 4000;
function clearToastTimer(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}
/** Autosave runs this long after the last keystroke; the main process mirrors to Gmail on the same cadence. */
export const AUTOSAVE_MS = 2000;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
/** The autosave in flight, so a close or send waits for its row id instead of racing it. */
let autosaveInflight: Promise<void> | null = null;
/** Bumped whenever a compose opens or closes; an autosave that resolves for an older session drops its result. */
let composeSession = 0;
/** What the open compose last wrote to the drafts table, so an unchanged compose is not saved again and a row that differs is known to have changed elsewhere (Gmail). */
let lastSaved: { draftId: number; key: string } | null = null;
function saveKey(d: ComposeDraft): string {
  return JSON.stringify([d.to, d.cc, d.bcc, d.subject, d.bodyHtml]);
}
/** Bumped on every open, close, or view change of the reading pane; a threads:get that resolves for an older open is dropped, so a fast J J never lands the first thread over the second. */
let openSeq = 0;

function cancelAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = null;
}
/** init runs twice under StrictMode; the tracker is installed once. */
let activityUninstall: (() => void) | null = null;

function selectedAccountIds(state: Pick<AppState, "accountFilter" | "status">): string[] | undefined {
  if (state.accountFilter) return [state.accountFilter];
  const signedIn = state.status.accounts.filter((a) => a.authState !== "signed_out").map((a) => a.id);
  return signedIn.length ? signedIn : undefined;
}

export { scopeFor };

export function isQueueView(view: InboxView): view is QueueName {
  return view === "daily" || view === "weekly" || view === "later";
}

// The quoted history a reply carries is rendered by the compose editor directly in the app, not in
// the sandboxed frame the reading pane uses, so it gets a stricter rule than a message body does.
// Remote images are removed outright rather than gated on a setting: an image here would be fetched
// the moment the reply is opened, which tells the sender both that the mail was read and that a
// reply is being written, and the remote-images setting cannot express that. Anything that could
// load or execute goes with them.
//
// The renderer always has a DOM. Without one (node:test) DOMPurify cannot parse, so the quote keeps only the text.
const sanitize = (html: string) =>
  DOMPurify.isSupported
    ? DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: QUOTE_FORBID_TAGS, FORBID_ATTR: QUOTE_FORBID_ATTR })
    : html.replace(/<[^>]+>/g, "");

function wordsOf(view: ThreadView): number {
  let n = 0;
  for (const m of view.messages) {
    const text = m.body?.text ?? (m.body?.html ? m.body.html.replace(/<[^>]+>/g, " ") : m.snippet);
    n += text.split(/\s+/).filter(Boolean).length;
  }
  return n;
}

/**
 * The reverse of one action, through the same channel that made it. Every
 * branch is a write the main process already exposes, so undo adds no new way
 * for the store and Gmail to disagree.
 */
async function reverse(u: Exclude<ToastUndo, { kind: "send" }>): Promise<void> {
  switch (u.kind) {
    case "archive":
      await invoke("threads:moveToInbox", u.accountId, u.threadId);
      return;
    case "moveToInbox":
      await invoke("threads:archive", u.accountId, u.threadId);
      return;
    case "snooze":
      await invoke("threads:unsnooze", u.accountId, u.threadId);
      return;
    case "star":
      await invoke("threads:star", u.accountId, u.threadId, u.starred);
      return;
    case "refile":
      await invoke("classify:refile", u.accountId, u.threadId, u.to);
      return;
  }
}

/** When an offer of undo stops standing: the same window Settings gives a send, so one number governs both. */
function undoUntil(s: AppState): number {
  return Date.now() + Math.max(1, s.settings.undoWindowSec) * 1000;
}

/** Where a thread is filed right now, in the shape refile takes, so an undo can put it back. */
export function currentTarget(t: Pick<ThreadSummary, "split" | "type" | "categoryId">): RefileTarget {
  return { split: t.split === "important" ? "important" : "other", category: t.categoryId ?? t.type ?? null };
}

/** Rows in the Scheduled view are queued sends, not threads: E, H, S, D, W have nothing to act on. */
function scheduledOnly(row: ThreadSummary, showToast: (t: ToastEvent) => void): boolean {
  if (!row.scheduled) return false;
  showToast({ eyebrow: "SCHEDULED", text: "Open the message and use Cancel send." });
  return true;
}

/**
 * One attachment action. The chip is marked busy for as long as the main
 * process is working, and whatever goes wrong comes back as a toast with the
 * reason on it: a fetch that fails is never silent, and never leaves a chip
 * spinning.
 */
async function runAttachment(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState,
  channel: "attachments:preview" | "attachments:download",
  accountId: string,
  messageId: string,
  key: string,
  toastFor: (result: AttachmentSaveResult) => ToastEvent | null
): Promise<void> {
  const id = attachmentBusyId(accountId, messageId, key);
  if (get().attachmentsBusy.includes(id)) return;
  set((s) => ({ attachmentsBusy: [...s.attachmentsBusy, id] }));
  try {
    const result = (await invoke(channel, accountId, messageId, key)) as AttachmentSaveResult | undefined;
    const toast = result ? toastFor(result) : null;
    if (toast) get().showToast(toast);
  } catch (err) {
    get().showToast({ eyebrow: "ATTACHMENT NOT OPENED", text: (err as Error).message });
  } finally {
    set((s) => ({ attachmentsBusy: s.attachmentsBusy.filter((x) => x !== id) }));
  }
}

/** The busy key for one attachment. The reading pane builds the same string to decide whether a chip is spinning. */
export function attachmentBusyId(accountId: string, messageId: string, key: string): string {
  return `${accountId}/${messageId}/${key}`;
}

function hasContent(d: ComposeDraft): boolean {
  const text = d.bodyHtml.replace(/<[^>]+>/g, "").trim();
  return Boolean(text || d.subject.trim() || d.to.length || d.cc.length || d.bcc.length);
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  smoke: false,
  userArt: [],
  status: EMPTY_STATUS,
  categories: [],
  savedSearches: [],
  counts: EMPTY_SIDEBAR_COUNTS,
  sidebarLayout: null,
  sidebarMenu: null,
  progress: {},
  view: "inbox",
  split: null,
  category: null,
  accountFilter: null,
  rows: [],
  nextCursor: null,
  loading: false,
  selected: 0,
  open: null,
  openLoading: false,
  expandedMessages: [],
  allExpanded: false,
  scope: "list",
  popover: null,
  rail: "none",
  readingPane: readStoredBool("arcmail.readingPane", true),
  searchQuery: "",
  searchHits: null,
  toast: null,
  toastPaused: false,
  error: null,

  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  onboarding: null,
  onboardingOpen: false,
  snippets: [],
  drafts: [],
  aiStatus: null,

  compose: null,
  autosavedDraftId: null,
  composePlacement: "panel",
  inlineCollapsed: false,
  inlineAnchor: null,
  composeGhost: null,
  sendLaterOpen: false,
  sendLaterPick: false,
  snippetPickerOpen: false,
  editorApi: null,

  summary: null,
  replies: null,

  ask: { open: false, question: "", running: false, result: null },

  paletteOpen: false,
  paletteQuery: "",
  paletteScope: "list",

  async init() {
    await get().refreshStatus();
    const [categories, settings, snippets, info, savedSearches, sidebarLayout] = await Promise.all([
      invoke("categories:list").catch(() => [] as CategoryInfo[]),
      invoke("settings:get").catch(() => DEFAULT_SETTINGS),
      invoke("snippets:list").catch(() => [] as SnippetInfo[]),
      invoke("app:info").catch(() => ({ version: "", platform: "", smoke: false, userArt: [] as string[] })),
      invoke("searches:list").catch(() => [] as SavedSearchInfo[]),
      invoke("sidebar:getLayout").catch(() => null),
    ]);
    set({ categories, settings, snippets, savedSearches, sidebarLayout, smoke: Boolean(info.smoke), userArt: info.userArt ?? [], ready: true });
    await get().loadOnboarding();
    // Throttled activity drives the Daily 0 day boundary in the main process.
    activityUninstall ??= installActivityTracker((at) => void invoke("app:activity", at).catch(() => undefined));
    await get().loadThreads(true);
    void get().loadDrafts();
    void invoke("ai:status")
      .then((aiStatus) => set({ aiStatus }))
      .catch(() => set({ aiStatus: null }));
    on("accounts:changed", (status) => {
      set({ status });
      void get().loadThreads(true);
    });
    on("threads:changed", () => {
      void get().loadThreads(true);
      void get().refreshOpen();
    });
    on("sync:progress", (p) => set((s) => ({ progress: { ...s.progress, [p.accountId]: p } })));
    on("toast", (t) => get().showToast(t));
    on("categories:changed", (categories) => set({ categories }));
    on("drafts:changed", () => void get().loadDrafts());
  },

  async refreshStatus() {
    try {
      set({ status: await invoke("accounts:status"), error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async loadThreads(reset = false) {
    const s = get();
    if (s.searchHits && !reset) return;
    const accountIds = selectedAccountIds(s);
    set({ loading: true });
    try {
      // Drafts is one list of drafts, local and Gmail alike (loadDrafts); the threads they sit in are not rows here.
      const page = s.view === "drafts" ? { rows: [], nextCursor: null } : await invoke("threads:list", { view: s.view, split: s.split, category: s.category, accountIds, cursor: reset ? null : s.nextCursor, limit: 60 });
      const counts = await invoke("sidebar:counts", accountIds);
      set((cur) => {
        const rows = reset ? page.rows : [...cur.rows, ...page.rows];
        const selected = Math.min(cur.selected, Math.max(0, rows.length - 1));
        return { rows, nextCursor: page.nextCursor, counts, selected, loading: false, searchHits: reset ? null : cur.searchHits };
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadMore() {
    const s = get();
    if (!s.nextCursor || s.loading) return;
    await s.loadThreads(false);
  },

  setView(view, opts = {}) {
    openSeq += 1;
    set({ view, split: opts.split ?? null, category: opts.category ?? null, selected: 0, open: null, searchHits: null, searchQuery: "", summary: null, replies: null });
    get().syncScope();
    void get().loadThreads(true);
    if (view === "drafts") void get().loadDrafts();
  },

  setAccountFilter(id) {
    openSeq += 1;
    set({ accountFilter: id, selected: 0, open: null, summary: null, replies: null });
    get().syncScope();
    void get().loadThreads(true);
  },

  openAccountInbox(id) {
    openSeq += 1;
    set({ accountFilter: id, view: "inbox", split: null, category: null, selected: 0, open: null, searchHits: null, searchQuery: "", summary: null, replies: null });
    get().syncScope();
    void get().loadThreads(true);
  },

  select(index) {
    const max = Math.max(0, get().rows.length - 1);
    set({ selected: Math.min(Math.max(0, index), max) });
  },

  move(delta) {
    const s = get();
    const next = Math.min(Math.max(0, s.selected + delta), Math.max(0, s.rows.length - 1));
    set({ selected: next });
    if (s.open) void s.openSelected();
    if (next >= s.rows.length - 5) void s.loadMore();
  },

  async openSelected() {
    if (!get().readingPane) get().setReadingPane(true);
    const s = get();
    const row = s.rows[s.selected];
    if (!row) return;
    await s.openThreadById(row.accountId, row.id);
  },

  async openThreadById(accountId, threadId, opts = {}) {
    const seq = ++openSeq;
    set({ openLoading: true, popover: null, summary: null, replies: null });
    try {
      const view = await invoke("threads:get", accountId, threadId);
      // A later open (or a close) won the race: this result is for a thread nobody is looking at.
      if (seq !== openSeq) return false;
      // The thread opens on its newest message with the history folded away. No animation: this is the first paint.
      set({ open: view, openLoading: false, expandedMessages: defaultExpanded(view.messages), allExpanded: false });
      get().syncScope();
      const row = get().rows.find((r) => r.id === threadId && r.accountId === accountId);
      if (row?.unread) {
        set((cur) => ({ rows: cur.rows.map((r) => (r.id === threadId && r.accountId === accountId ? { ...r, unread: false } : r)) }));
        invoke("threads:markRead", accountId, threadId, true).catch((err: Error) => get().showToast({ eyebrow: "NOT MARKED READ", text: err.message }));
      }
      void get().loadAiForOpen();
      return true;
    } catch (err) {
      if (seq !== openSeq) return false;
      set(opts.quiet ? { openLoading: false } : { openLoading: false, error: (err as Error).message });
      get().syncScope();
      return false;
    }
  },

  closeThread() {
    openSeq += 1;
    set({ open: null, openLoading: false, popover: null, summary: null, replies: null, expandedMessages: [], allExpanded: false });
    get().syncScope();
  },

  async archiveSelected() {
    const s = get();
    const row = s.rows[s.selected];
    if (!row || scheduledOnly(row, s.showToast)) return;
    const wasOpen = s.open?.thread.id === row.id;
    // In a queue view E advances: the next row is selected, and opened when the reading pane is showing.
    const advance = wasOpen || (isQueueView(s.view) && s.readingPane);
    set((cur) => {
      const rows = cur.rows.filter((r) => !(r.id === row.id && r.accountId === row.accountId));
      const selected = Math.min(cur.selected, Math.max(0, rows.length - 1));
      return { rows, selected, open: wasOpen ? null : cur.open };
    });
    get().syncScope();
    try {
      await invoke("threads:archive", row.accountId, row.id);
      get().showToast({ text: "Marked done.", undo: { kind: "archive", accountId: row.accountId, threadId: row.id, until: undoUntil(get()), text: "Back in the inbox." } });
      const next = get().rows[get().selected];
      if (advance && next) void get().openSelected();
      void get().refreshCounts();
    } catch (err) {
      set({ error: (err as Error).message });
      void get().loadThreads(true);
    }
  },

  async moveToInboxSelected() {
    const s = get();
    // Reachable from the Done list and from an open thread, so the open thread wins when there is one.
    const row = s.open?.thread ?? s.rows[s.selected] ?? null;
    if (!row || scheduledOnly(row, s.showToast)) return;
    if (row.inInbox) {
      s.showToast({ text: "That thread is already in the inbox." });
      return;
    }
    // In the Done list the thread is no longer one of its rows; everywhere else it stays put and stops reading DONE.
    const leaves = s.view === "archive" || s.view === "snoozed";
    set((cur) => {
      const rows = leaves ? cur.rows.filter((r) => !(r.id === row.id && r.accountId === row.accountId)) : cur.rows.map((r) => (r.id === row.id && r.accountId === row.accountId ? { ...r, inInbox: true } : r));
      const open = cur.open && cur.open.thread.id === row.id && cur.open.thread.accountId === row.accountId ? { ...cur.open, thread: { ...cur.open.thread, inInbox: true } } : cur.open;
      return { rows, selected: Math.min(cur.selected, Math.max(0, rows.length - 1)), open };
    });
    try {
      await invoke("threads:moveToInbox", row.accountId, row.id);
      get().showToast({ text: "Back in the inbox.", undo: { kind: "moveToInbox", accountId: row.accountId, threadId: row.id, until: undoUntil(get()), text: "Back out of the inbox." } });
      void get().refreshCounts();
    } catch (err) {
      set({ error: (err as Error).message });
      void get().loadThreads(true);
    }
  },

  toggleMessage(messageId) {
    set((cur) => {
      const on = cur.expandedMessages.includes(messageId);
      const expandedMessages = on ? cur.expandedMessages.filter((id) => id !== messageId) : [...cur.expandedMessages, messageId];
      // Closing one by hand means the thread is no longer all the way open, so the control offers to open it again.
      return { expandedMessages, allExpanded: on ? false : cur.allExpanded };
    });
  },

  toggleAllMessages() {
    const cur = get();
    if (!cur.open) return;
    // Everything already open folds back to how the thread opened; anything still folded opens.
    const all = cur.open.messages.length > 0 && cur.open.messages.every((m) => cur.expandedMessages.includes(m.id));
    if (all) set({ expandedMessages: defaultExpanded(cur.open.messages), allExpanded: false });
    else set({ expandedMessages: cur.open.messages.map((m) => m.id), allExpanded: true });
  },

  async starSelected() {
    const s = get();
    const row = s.rows[s.selected];
    if (!row || scheduledOnly(row, s.showToast)) return;
    const starred = !row.starred;
    set((cur) => ({ rows: cur.rows.map((r) => (r.id === row.id && r.accountId === row.accountId ? { ...r, starred } : r)) }));
    try {
      await invoke("threads:star", row.accountId, row.id, starred);
      get().showToast({
        text: starred ? "Starred." : "Star removed.",
        undo: { kind: "star", accountId: row.accountId, threadId: row.id, starred: row.starred, until: undoUntil(get()), text: starred ? "Star removed." : "Starred again." },
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async toggleQueue(queue) {
    const s = get();
    const row = s.rows[s.selected];
    if (!row || scheduledOnly(row, s.showToast)) return;
    try {
      const result = await invoke("threads:toggleQueue", row.accountId, row.id, queue);
      const name = queue === "daily" ? "Daily 0" : "Weekly 0";
      const was = row.queue;
      const text = result === null ? `Removed from ${name}.` : was && was !== result ? `Moved to ${name}.` : `Added to ${name}.`;
      const leaves = isQueueView(get().view) && get().view !== result;
      set((cur) => {
        const rows = leaves ? cur.rows.filter((r) => !(r.id === row.id && r.accountId === row.accountId)) : cur.rows.map((r) => (r.id === row.id && r.accountId === row.accountId ? { ...r, queue: result } : r));
        const open = cur.open && cur.open.thread.id === row.id && cur.open.thread.accountId === row.accountId ? (leaves ? null : { ...cur.open, thread: { ...cur.open.thread, queue: result } }) : cur.open;
        return { rows, selected: Math.min(cur.selected, Math.max(0, rows.length - 1)), open };
      });
      get().syncScope();
      get().showToast({ text });
      void get().refreshCounts();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async refreshCounts() {
    try {
      set({ counts: await invoke("sidebar:counts", selectedAccountIds(get())) });
    } catch {
      // The next list load refreshes them.
    }
  },

  async snoozeSelected(wakeAt) {
    const s = get();
    const row = s.rows[s.selected];
    if (!row || scheduledOnly(row, s.showToast)) return;
    const wasOpen = s.open?.thread.id === row.id;
    set((cur) => {
      const rows = cur.rows.filter((r) => !(r.id === row.id && r.accountId === row.accountId));
      return { popover: null, rows, selected: Math.min(cur.selected, Math.max(0, rows.length - 1)), open: wasOpen ? null : cur.open };
    });
    get().syncScope();
    try {
      await invoke("threads:snooze", row.accountId, row.id, wakeAt);
      get().showToast({
        eyebrow: "SNOOZED",
        text: `Back ${new Date(wakeAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
        undo: { kind: "snooze", accountId: row.accountId, threadId: row.id, until: undoUntil(get()), text: "Back in the inbox." },
      });
    } catch (err) {
      set({ error: (err as Error).message });
      void get().loadThreads(true);
    }
  },

  async remindSelected(dueAt) {
    const s = get();
    const row = s.rows[s.selected];
    if (!row || scheduledOnly(row, s.showToast)) return;
    try {
      await invoke("threads:remind", row.accountId, row.id, dueAt);
      get().showToast({
        eyebrow: "REMINDER SET",
        text: `If no reply by ${new Date(dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
        noUndo: "Set another reminder to change it.",
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async unsubscribeSelected() {
    const s = get();
    const row = s.rows[s.selected];
    if (!row || scheduledOnly(row, s.showToast)) return;
    if (!row.canUnsubscribe) {
      get().showToast({ eyebrow: "NO UNSUBSCRIBE LINK", text: "This sender did not include one." });
      return;
    }
    try {
      const r = await invoke("threads:unsubscribe", row.accountId, row.id);
      if (r.archived) {
        const wasOpen = get().open?.thread.id === row.id && get().open?.thread.accountId === row.accountId;
        set((cur) => {
          const rows = cur.rows.filter((x) => !(x.id === row.id && x.accountId === row.accountId));
          return { rows, selected: Math.min(cur.selected, Math.max(0, rows.length - 1)), open: wasOpen ? null : cur.open };
        });
        get().syncScope();
        void get().refreshCounts();
      } else {
        set((cur) => ({ rows: cur.rows.map((x) => (x.id === row.id && x.accountId === row.accountId ? { ...x, unsubscribeState: r.state } : x)) }));
      }
      const eyebrow = r.ok ? (r.state === "opened" ? "UNSUBSCRIBE PAGE" : "UNSUBSCRIBED") : "NOT UNSUBSCRIBED";
      // The request itself is gone the moment it goes out. What Undo can still do is put the thread back in the inbox.
      if (r.archived) {
        get().showToast({ eyebrow, text: r.text, undo: { kind: "archive", accountId: row.accountId, threadId: row.id, until: undoUntil(get()), text: "Back in the inbox. The unsubscribe request had already gone out." } });
      } else {
        get().showToast({ eyebrow, text: r.text, noUndo: r.ok ? "A request that has gone out cannot be recalled." : "Nothing changed, so there is nothing to take back." });
      }
    } catch (err) {
      get().showToast({ eyebrow: "NOT UNSUBSCRIBED", text: (err as Error).message });
    }
  },

  async setLoadImages(email, load) {
    await invoke("contacts:setLoadImages", email, load);
    set((cur) => (cur.open ? { open: { ...cur.open, messages: cur.open.messages.map((m) => (m.from.email === email ? { ...m, loadImages: load } : m)) } } : {}));
  },

  attachmentsBusy: [],

  async previewAttachment(accountId, messageId, key) {
    await runAttachment(set, get, "attachments:preview", accountId, messageId, key, () => null);
  },

  async downloadAttachment(accountId, messageId, key) {
    await runAttachment(set, get, "attachments:download", accountId, messageId, key, (r) =>
      r.saved ? { eyebrow: "DOWNLOADED", text: `${r.filename} is in your Downloads folder.` } : null
    );
  },

  setPopover(p) {
    set({ popover: p });
    get().syncScope();
  },

  openSidebarMenu(m) {
    set({ sidebarMenu: m });
    get().syncScope();
  },

  closeSidebarMenu() {
    if (!get().sidebarMenu) return;
    set({ sidebarMenu: null });
    get().syncScope();
  },

  async saveSidebarLayout(layout) {
    set({ sidebarLayout: layout });
    try {
      await invoke("sidebar:setLayout", layout);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async createSavedSearch(name, query) {
    try {
      set({ savedSearches: await invoke("searches:create", name, query) });
      void get().refreshCounts();
      return true;
    } catch (err) {
      get().showToast({ eyebrow: "NOT SAVED", text: (err as Error).message });
      return false;
    }
  },

  async updateSavedSearch(id, patch) {
    try {
      set({ savedSearches: await invoke("searches:update", id, patch) });
      void get().refreshCounts();
      return true;
    } catch (err) {
      get().showToast({ eyebrow: "NOT SAVED", text: (err as Error).message });
      return false;
    }
  },

  async deleteSavedSearch(id) {
    try {
      set({ savedSearches: await invoke("searches:delete", id) });
      if (get().view === `search:${id}`) get().setView("inbox");
      else void get().refreshCounts();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async cancelScheduledSend() {
    const open = get().open;
    const scheduled = open?.thread.scheduled;
    if (!open || !scheduled) return;
    try {
      const r = await invoke("send:undo", scheduled.sendId);
      set({ open: null, popover: null, summary: null, replies: null });
      get().syncScope();
      if (r.cancelled) {
        get().showToast({ text: "Send cancelled. The draft is back." });
        if (r.draft) get().openCompose(r.draft.mode, { draft: r.draft });
      } else {
        get().showToast({ text: "Already sent." });
      }
      void get().loadThreads(true);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setScope(scope) {
    set({ scope });
  },

  syncScope() {
    set((cur) => ({ scope: scopeFor(cur) }));
  },

  toggleReadingPane() {
    get().setReadingPane(!get().readingPane);
  },
  setReadingPane(open) {
    writeStoredBool("arcmail.readingPane", open);
    // An inline reply lives in the reading pane; hiding the pane parks it as a draft.
    if (!open && get().compose && get().composePlacement === "inline") void get().closeCompose(true);
    set({ readingPane: open });
  },
  toggleRail(rail) {
    set((cur) => ({ rail: cur.rail === rail ? "none" : rail }));
  },

  setSearchQuery(q) {
    set({ searchQuery: q });
  },

  async runSearch() {
    const s = get();
    const q = s.searchQuery.trim();
    if (!q) {
      s.leaveSearch();
      return;
    }
    try {
      const hits = await invoke("search:query", q, selectedAccountIds(s));
      set({ searchHits: hits, rows: hits.map((h) => h.thread), nextCursor: null, selected: 0, open: null });
      get().syncScope();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  leaveSearch() {
    const had = get().searchHits;
    set({ searchQuery: "", searchHits: null });
    get().syncScope();
    if (had) void get().loadThreads(true);
    (document.activeElement as HTMLElement | null)?.blur();
  },

  async signIn(id) {
    set({ error: null });
    try {
      const status = await invoke("accounts:signIn", id);
      set({ status });
      get().showToast({ text: `Signed in. Syncing ${status.accounts.find((a) => a.id === id)?.email ?? id}.` });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  showToast(t) {
    clearToastTimer();
    set({ toast: t, toastPaused: false });
    if (t) {
      toastRemaining = t.undo ? Math.max(1000, t.undo.until - Date.now()) : TOAST_MS;
      toastStartedAt = Date.now();
      toastTimer = setTimeout(() => {
        toastTimer = null;
        set({ toast: null, toastPaused: false });
      }, toastRemaining);
    }
  },

  pauseToast() {
    const s = get();
    if (!s.toast || s.toastPaused) return;
    clearToastTimer();
    // Whatever was left when the pointer arrived is what runs when it leaves.
    toastRemaining = Math.max(1000, toastRemaining - (Date.now() - toastStartedAt));
    set({ toastPaused: true });
  },

  resumeToast() {
    const s = get();
    if (!s.toast || !s.toastPaused) return;
    toastStartedAt = Date.now();
    toastTimer = setTimeout(() => {
      toastTimer = null;
      set({ toast: null, toastPaused: false });
    }, toastRemaining);
    set({ toastPaused: false });
  },

  /**
   * Z, and the toast's own Undo control. One code path for both, and one for
   * every action: a send comes back as a draft, everything else is the reverse
   * write through the same channel that made the change, and the follow-up
   * toast says what was undone.
   */
  async undo() {
    const u = get().toast?.undo;
    if (!u) return;
    try {
      if (u.kind === "send") {
        const r = await invoke("send:undo", u.id);
        if (r.cancelled) {
          // The message shown optimistically in the thread goes away with the send.
          const pendingId = `pending:${u.id}`;
          set((cur) => (cur.open && cur.open.messages.some((m) => m.id === pendingId) ? { open: { ...cur.open, messages: cur.open.messages.filter((m) => m.id !== pendingId) } } : {}));
          get().showToast({ text: "Send cancelled. The draft is back." });
          if (r.draft) get().openCompose(r.draft.mode, { draft: r.draft });
        } else {
          get().showToast({ text: "Already sent." });
        }
        return;
      }
      await reverse(u);
      get().showToast({ text: u.text });
      void get().loadThreads(true);
      void get().refreshOpen();
      void get().refreshCounts();
    } catch (err) {
      get().showToast({ eyebrow: "NOT UNDONE", text: (err as Error).message });
    }
  },

  notBuilt(feature) {
    get().showToast({ eyebrow: "NEXT SLICE", text: `${feature} is not in this build yet.` });
  },

  // ---- AI on the open thread ---------------------------------------------------

  async loadAiForOpen() {
    const view = get().open;
    if (!view) return;
    const key = `${view.thread.accountId}:${view.thread.id}`;
    const still = () => {
      const o = get().open;
      return o && `${o.thread.accountId}:${o.thread.id}` === key;
    };
    const tasks: Promise<void>[] = [];
    if (view.messages.length > 5 || wordsOf(view) > 1500) {
      set({ summary: { ok: "loading" } });
      tasks.push(
        invoke("ai:summary", view.thread.accountId, view.thread.id)
          .then((r) => {
            if (still()) set({ summary: r });
          })
          .catch((err: Error) => {
            if (still()) set({ summary: { ok: false, code: "unknown", error: err.message } });
          })
      );
    }
    const last = view.messages[view.messages.length - 1];
    if (last && last.direction === "in" && !last.isAuto) {
      set({ replies: { ok: "loading" } });
      tasks.push(
        invoke("ai:instantReplies", view.thread.accountId, last.id)
          .then((r) => {
            if (still()) set({ replies: r });
          })
          .catch((err: Error) => {
            if (still()) set({ replies: { ok: false, code: "unknown", error: err.message } });
          })
      );
    }
    await Promise.all(tasks);
  },

  acceptInstantReply(n) {
    const r = get().replies;
    if (!r || r.ok !== true) return;
    const text = r.replies[n - 1];
    if (!text) return;
    get().openCompose("reply", { bodyHtml: textToHtml(text) });
  },

  async refile(to) {
    // The open thread, or from the palette with nothing open, the cursor row.
    const s = get();
    const thread = s.open?.thread ?? s.rows[s.selected] ?? null;
    if (!thread) return;
    const was = currentTarget(thread);
    const nameOf = (t: RefileTarget) => (t.category ? get().categories.find((c) => c.id === t.category)?.name ?? t.category : t.split === "important" ? "Important" : "Other");
    try {
      await invoke("classify:refile", thread.accountId, thread.id, to);
      get().showToast({
        eyebrow: "FILED",
        text: `${nameOf(to)}. The classifier learns from this.`,
        undo: { kind: "refile", accountId: thread.accountId, threadId: thread.id, to: was, until: undoUntil(get()), text: `Filed back under ${nameOf(was)}.` },
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  // ---- compose ----------------------------------------------------------------------

  openCompose(mode, opts = {}) {
    const s = get();
    const view = s.open;
    const lastId = view?.messages[view.messages.length - 1]?.id ?? null;
    const docked = s.compose && s.composePlacement === "inline" && s.inlineAnchor && view && s.inlineAnchor.threadId === view.thread.id && s.inlineAnchor.accountId === view.thread.accountId ? s.inlineAnchor : null;

    if (opts.draft) {
      const d = { ...opts.draft, mode: opts.draft.mode ?? mode };
      // A draft docks under the message it answers when that thread is open; anywhere else it gets the panel.
      const anchorMessage = view && d.threadId === view.thread.id && d.accountId === view.thread.accountId ? view.messages.find((m) => m.messageIdHeader && m.messageIdHeader === d.inReplyTo)?.id ?? lastId : null;
      const placement: ComposePlacement = opts.placement ?? (anchorMessage ? "inline" : "panel");
      if (placement === "inline" && (!view || !anchorMessage)) return;
      if (s.compose && !docked) void s.closeCompose(true);
      composeSession += 1;
      lastSaved = null;
      set({
        compose: d,
        autosavedDraftId: null,
        composePlacement: placement,
        inlineCollapsed: false,
        inlineAnchor: placement === "inline" && view ? { accountId: view.thread.accountId, threadId: view.thread.id, messageId: anchorMessage! } : null,
        composeGhost: null,
        sendLaterOpen: false,
        snippetPickerOpen: false,
        popover: null,
      });
      get().syncScope();
      return;
    }

    const row = s.rows[s.selected];
    const accountId = view?.thread.accountId ?? row?.accountId ?? s.accountFilter ?? s.status.accounts.find((a) => a.authState !== "signed_out")?.id ?? s.status.accounts[0]?.id;
    if (!accountId) {
      get().showToast({ eyebrow: "NO ACCOUNT", text: "Sign in to an account before composing." });
      return;
    }
    if (mode !== "new" && !view) {
      // Reply from the list: open the thread first, then compose on it.
      if (!row) return;
      void s.openThreadById(row.accountId, row.id).then(() => {
        if (get().open) get().openCompose(mode, opts);
      });
      return;
    }

    // Reply, reply all, and forward dock under a message in the reading pane. C keeps the floating panel.
    const placement: ComposePlacement = opts.placement ?? (mode === "new" || !view ? "panel" : "inline");

    if (docked && s.compose && placement === "inline") {
      const existing = s.compose;
      if (opts.bodyHtml && !opts.messageId) {
        // An instant reply prefills whatever box is docked, collapsed or open.
        set({ compose: { ...existing, bodyHtml: opts.bodyHtml }, inlineCollapsed: false, composeGhost: null });
        get().syncScope();
        if (!s.inlineCollapsed) get().editorApi?.setHtml(opts.bodyHtml);
        return;
      }
      if (s.inlineCollapsed && !opts.messageId) {
        get().expandInline();
        return;
      }
      const targetId = opts.messageId ?? docked.messageId;
      if (mode === existing.mode && targetId === docked.messageId) {
        get().editorApi?.focus();
        return;
      }
      // A different message or mode moves the box there; what was typed comes along.
      const owners = new Set(s.status.accounts.map((a) => a.email.toLowerCase()));
      let moved: ComposeDraft;
      try {
        moved = buildDraft({ mode, accountId, thread: view!.thread, messages: view!.messages, owners, sanitize, bodyHtml: existing.bodyHtml, targetId });
      } catch (err) {
        get().showToast({ eyebrow: "NOT SUPPORTED YET", text: (err as Error).message });
        return;
      }
      set({ compose: { ...moved, draftId: existing.draftId ?? null }, inlineAnchor: { ...docked, messageId: targetId }, inlineCollapsed: false, sendLaterOpen: false, snippetPickerOpen: false });
      get().syncScope();
      return;
    }

    // Coming back to a thread with a parked reply: R reopens that draft rather than starting over. A reply
    // aimed at another message of the thread moves that draft there, the way it moves an open box: one thread,
    // one reply draft, never a second row the strip cannot show.
    if (placement === "inline" && view && !opts.bodyHtml && (mode === "reply" || mode === "replyAll")) {
      const saved = s.drafts.find((d) => d.threadId === view.thread.id && d.accountId === view.thread.accountId);
      if (saved) {
        get().openCompose(saved.mode, { draft: saved, placement: "inline" });
        const anchor = get().inlineAnchor;
        if (get().compose && anchor && ((opts.messageId && opts.messageId !== anchor.messageId) || mode !== saved.mode)) get().openCompose(mode, { messageId: opts.messageId ?? anchor.messageId });
        return;
      }
    }

    // Only one compose at a time. A panel over an inline reply parks the reply as a draft; its strip stays under the thread.
    if (s.compose) void s.closeCompose(true);

    const owners = new Set(s.status.accounts.map((a) => a.email.toLowerCase()));
    const targetId = placement === "inline" ? opts.messageId ?? lastId : null;
    let draft: ComposeDraft;
    try {
      draft = buildDraft({ mode, accountId, thread: view?.thread ?? null, messages: view?.messages ?? [], owners, sanitize, bodyHtml: opts.bodyHtml, targetId });
    } catch (err) {
      get().showToast({ eyebrow: "NOT SUPPORTED YET", text: (err as Error).message });
      return;
    }
    if (placement === "inline" && !get().readingPane) get().setReadingPane(true);
    composeSession += 1;
    lastSaved = null;
    set({
      compose: draft,
      autosavedDraftId: null,
      composePlacement: placement,
      inlineCollapsed: false,
      inlineAnchor: placement === "inline" && view && targetId ? { accountId: view.thread.accountId, threadId: view.thread.id, messageId: targetId } : null,
      composeGhost: null,
      sendLaterOpen: false,
      snippetPickerOpen: false,
      popover: null,
    });
    get().syncScope();
    const wantsGhost = s.settings.autoDraft && (mode === "reply" || mode === "replyAll") && !opts.bodyHtml && view;
    if (wantsGhost) {
      set({ composeGhost: { status: "loading", text: "" } });
      void invoke("ai:draftReply", view.thread.accountId, view.thread.id)
        .then((r) => {
          if (get().compose !== draft && get().compose?.threadId !== draft.threadId) return;
          set({ composeGhost: r.ok ? { status: "ready", text: r.text } : { status: "failed", text: "", code: r.code } });
        })
        .catch((err: Error) => set({ composeGhost: { status: "failed", text: err.message, code: "unknown" } }));
    }
  },

  updateCompose(patch) {
    set((cur) => (cur.compose ? { compose: { ...cur.compose, ...patch } } : {}));
    cancelAutosave();
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void get().autosaveCompose();
    }, AUTOSAVE_MS);
  },

  async autosaveCompose() {
    // One save at a time: a second save leaving before the first has its row id back would open a second row for the same text.
    while (autosaveInflight) await autosaveInflight;
    const s = get();
    const d = s.compose;
    if (!d || s.inlineCollapsed) return;
    // Recipients alone are not a draft; the same bar Esc uses.
    if (!(s.composePlacement === "inline" ? hasBody(d) : hasContent(d))) return;
    const session = composeSession;
    const rowId = d.draftId ?? s.autosavedDraftId;
    // Nothing typed since the last save (the text came back from Gmail, or a stray update event): no row churn.
    if (rowId && lastSaved && lastSaved.draftId === rowId && lastSaved.key === saveKey(d)) return;
    const run = (async () => {
      try {
        const id = await invoke("drafts:save", { ...d, draftId: rowId });
        lastSaved = { draftId: id, key: saveKey(d) };
        if (composeSession === session && get().compose) set({ autosavedDraftId: id });
        void get().loadDrafts();
      } catch {
        // The next keystroke tries again; Esc still saves.
      }
    })();
    autosaveInflight = run;
    await run;
    if (autosaveInflight === run) autosaveInflight = null;
  },

  async closeCompose(keepDraft = true) {
    const d = get().compose;
    if (!d) return;
    const inline = get().composePlacement === "inline";
    cancelAutosave();
    // An autosave that has left but not landed owns the row id; wait for it so the delete or save hits that row.
    while (autosaveInflight) await autosaveInflight;
    const draftId = d.draftId ?? get().autosavedDraftId ?? null;
    composeSession += 1;
    lastSaved = null;
    set({ compose: null, autosavedDraftId: null, composePlacement: "panel", inlineCollapsed: false, inlineAnchor: null, composeGhost: null, sendLaterOpen: false, snippetPickerOpen: false, editorApi: null });
    get().syncScope();
    // An untouched inline reply has recipients but nothing written; that is not a draft worth keeping.
    if (keepDraft && (inline ? hasBody(d) : hasContent(d))) {
      try {
        await invoke("drafts:save", { ...d, draftId }, { flush: true });
        get().showToast({ eyebrow: "DRAFT KEPT", text: d.subject || "(no subject)" });
        void get().loadDrafts();
      } catch (err) {
        set({ error: (err as Error).message });
      }
    } else if (draftId) {
      try {
        await invoke("drafts:delete", draftId);
      } catch (err) {
        get().showToast({ eyebrow: "NOT DELETED", text: (err as Error).message });
      }
      void get().loadDrafts();
    }
  },

  async dismissCompose() {
    const s = get();
    const d = s.compose;
    if (!d) return;
    if (s.composePlacement !== "inline") {
      await s.closeCompose(true);
      return;
    }
    if (!hasBody(d)) {
      await s.closeCompose(false);
      return;
    }
    cancelAutosave();
    while (autosaveInflight) await autosaveInflight;
    set({ inlineCollapsed: true, sendLaterOpen: false, snippetPickerOpen: false, editorApi: null });
    get().syncScope();
    // The strip shows from memory at once; the draft also lands in the drafts table (and Gmail) so it survives a restart.
    try {
      const draftId = await invoke("drafts:save", { ...d, draftId: d.draftId ?? get().autosavedDraftId }, { flush: true });
      lastSaved = { draftId, key: saveKey(d) };
      set((cur) => (cur.compose && cur.compose.threadId === d.threadId && cur.compose.mode === d.mode ? { compose: { ...cur.compose, draftId }, autosavedDraftId: null } : {}));
      void get().loadDrafts();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  expandInline() {
    if (!get().compose || get().composePlacement !== "inline") return;
    set({ inlineCollapsed: false });
    get().syncScope();
  },

  async refreshOpen() {
    const open = get().open;
    if (!open || open.thread.scheduled || get().openLoading) return;
    const { accountId, id } = open.thread;
    const seq = openSeq;
    try {
      const fresh = await invoke("threads:get", accountId, id);
      if (seq !== openSeq) return;
      set((cur) => {
        if (!cur.open || cur.open.thread.id !== id || cur.open.thread.accountId !== accountId) return {};
        const messages = mergePending(fresh.messages, cur.open.messages.filter(isPending));
        // Same messages, same bodies: keep the array the frames are keyed on, so nothing reloads under the reader.
        const same = sameMessages(cur.open.messages, messages);
        const open = { ...fresh, messages: same ? cur.open.messages : messages };
        if (same) return { open };
        // A reply that arrived while reading is the newest message, so it shows open; what was folded stays folded.
        const known = new Set(cur.expandedMessages);
        const last = messages[messages.length - 1]?.id;
        if (last) known.add(last);
        const expandedMessages = cur.allExpanded ? messages.map((m) => m.id) : messages.filter((m) => known.has(m.id)).map((m) => m.id);
        return { open, expandedMessages };
      });
    } catch (err) {
      if (seq !== openSeq) return;
      // Gone from the store: deleted in Gmail, or its account signed out. The pane closes rather than showing stale mail as current.
      const still = get().open;
      if (!still || still.thread.id !== id || still.thread.accountId !== accountId) return;
      get().closeThread();
      get().showToast({ eyebrow: "THREAD GONE", text: (err as Error).message });
    }
  },

  async sendCompose(sendAt = null) {
    const d = get().compose;
    if (!d) return;
    // Refused here, before the main process touches the draft: the compose stays open with everything in it.
    if (d.to.length === 0 && d.cc.length === 0 && d.bcc.length === 0) {
      get().showToast({ eyebrow: "NOT SENT", text: "Add at least one recipient." });
      return;
    }
    // A forward may go with only its quoted history; a reply with nothing written is a slip.
    if (!hasBody(d) && !(d.mode === "forward" && d.quotedHtml.trim())) {
      get().showToast({ eyebrow: "NOT SENT", text: "Write something before sending." });
      return;
    }
    const inline = get().composePlacement === "inline";
    cancelAutosave();
    while (autosaveInflight) await autosaveInflight;
    try {
      const r = await invoke("compose:send", { ...d, draftId: d.draftId ?? get().autosavedDraftId ?? null }, sendAt);
      composeSession += 1;
      lastSaved = null;
      set({ compose: null, autosavedDraftId: null, composePlacement: "panel", inlineCollapsed: false, inlineAnchor: null, composeGhost: null, sendLaterOpen: false, snippetPickerOpen: false, editorApi: null });
      get().syncScope();
      void get().loadDrafts();
      // An inline reply shows up in the thread right away; the sync replaces it with the real message.
      if (inline && !sendAt && d.threadId) {
        const account = get().status.accounts.find((a) => a.id === d.accountId);
        const sent = sentMessage({ draft: d, sendId: r.id, sentAt: r.sendAt, from: { email: account?.email ?? d.accountId, name: account?.displayName ?? "" } });
        set((cur) => (cur.open && cur.open.thread.id === d.threadId && cur.open.thread.accountId === d.accountId ? { open: { ...cur.open, messages: [...cur.open.messages, sent] } } : {}));
      }
      if (sendAt) {
        get().showToast({ eyebrow: "SCHEDULED", text: `Sends ${new Date(r.sendAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Undo (Z)`, undo: { kind: "send", id: r.id, until: Math.min(r.undoUntil, Date.now() + 15_000) } });
      } else {
        get().showToast({ text: "Sent. Undo (Z)", undo: { kind: "send", id: r.id, until: r.undoUntil } });
      }
    } catch (err) {
      get().showToast({ eyebrow: "NOT SENT", text: (err as Error).message });
    }
  },

  setSendLater(open, pick = false) {
    set({ sendLaterOpen: open, sendLaterPick: open && pick });
    get().syncScope();
  },

  setSnippetPicker(open) {
    set({ snippetPickerOpen: open });
    get().syncScope();
    if (!open) get().editorApi?.focus();
  },

  insertSnippet(s) {
    const expanded = expandSnippet({ bodyHtml: s.bodyHtml || textToHtml(s.bodyText), bodyText: s.bodyText }, get().snippetContext());
    const api = get().editorApi;
    if (api?.insertExpanded) api.insertExpanded(expanded);
    else api?.insertHtml(stripCursorToken(expanded.html));
    get().setSnippetPicker(false);
    const missing = missingVariablesText(expanded.missing);
    if (missing) get().showToast({ eyebrow: "SNIPPET", text: missing });
  },

  snippetContext() {
    const s = get();
    const d = s.compose;
    const account = d ? s.status.accounts.find((a) => a.id === d.accountId) ?? null : null;
    return { recipient: d?.to[0] ?? null, account: account ? { email: account.email, displayName: account.displayName } : null };
  },

  acceptGhost() {
    const g = get().composeGhost;
    if (!g || g.status !== "ready") return;
    get().editorApi?.setHtml(textToHtml(g.text));
    set({ composeGhost: null });
  },

  setEditorApi(api) {
    set({ editorApi: api });
  },

  // ---- Ask AI -------------------------------------------------------------------------

  openAsk() {
    set((cur) => ({ ask: { ...cur.ask, open: true } }));
    get().syncScope();
  },

  closeAsk() {
    set((cur) => ({ ask: { ...cur.ask, open: false, running: false } }));
    get().syncScope();
  },

  setAskQuestion(q) {
    set((cur) => ({ ask: { ...cur.ask, question: q } }));
  },

  async runAsk(question) {
    const s = get();
    const q = (question ?? s.ask.question).trim();
    if (!q) return;
    set((cur) => ({ ask: { ...cur.ask, question: q, running: true, result: null } }));
    try {
      const result = await invoke("ai:ask", q, selectedAccountIds(s));
      set((cur) => ({ ask: { ...cur.ask, running: false, result } }));
    } catch (err) {
      set((cur) => ({ ask: { ...cur.ask, running: false, result: { ok: false, code: "unknown", error: (err as Error).message, sources: [] } } }));
    }
  },

  // ---- settings, snippets, categories, drafts ----------------------------------------

  openSettings() {
    set({ settingsOpen: true });
    get().syncScope();
  },

  closeSettings() {
    set({ settingsOpen: false });
    get().syncScope();
  },

  // ---- first-run setup ----------------------------------------------------------------

  async loadOnboarding() {
    try {
      const onboarding = await invoke("onboarding:get");
      set({ onboarding, onboardingOpen: !onboarding.done });
    } catch {
      // No handler (the browser preview) means no setup flow; the app renders the way it always did.
      set({ onboarding: null, onboardingOpen: false });
    }
    get().syncScope();
  },

  goToOnboardingStep(step) {
    if (!ONBOARDING_STEPS.includes(step)) return;
    set((s) => ({ onboarding: s.onboarding ? { ...s.onboarding, step } : s.onboarding }));
    void invoke("onboarding:setStep", step).catch(() => undefined);
  },

  finishOnboarding() {
    set({ onboardingOpen: false });
    void invoke("onboarding:setDone", true)
      .then((onboarding) => set({ onboarding }))
      .catch(() => undefined);
    get().syncScope();
    void get().refreshStatus();
    void get().loadThreads(true);
  },

  reopenOnboarding() {
    set((s) => ({ settingsOpen: false, onboardingOpen: true, onboarding: s.onboarding ? { ...s.onboarding, step: "welcome", done: false } : s.onboarding }));
    void invoke("onboarding:setDone", false)
      .then((onboarding) => set({ onboarding }))
      .catch(() => undefined);
    get().syncScope();
  },

  async addOnboardingAccount(req) {
    try {
      const status = await invoke("onboarding:addAccount", req);
      set({ status });
      void get().loadThreads(true);
      return { ok: true as const };
    } catch (err) {
      // The clients file may already hold the entry: the message says which half failed.
      void get().refreshStatus();
      return { ok: false as const, error: (err as Error).message };
    }
  },

  // ---- command palette --------------------------------------------------------------

  openPalette() {
    const s = get();
    if (s.paletteOpen) return;
    if (TYPING_SCOPES.has(s.scope) && s.scope !== "compose") return;
    set({ paletteOpen: true, paletteQuery: "", paletteScope: s.scope, popover: null, sidebarMenu: null });
    get().syncScope();
  },

  closePalette() {
    if (!get().paletteOpen) return;
    set({ paletteOpen: false, paletteQuery: "" });
    get().syncScope();
    // The keys go back to where they came from: the editor when a compose is open, otherwise the list or thread.
    const s = get();
    if (s.compose && !s.inlineCollapsed) s.editorApi?.focus();
    else if (typeof document !== "undefined") (document.activeElement as HTMLElement | null)?.blur();
  },

  togglePalette() {
    if (get().paletteOpen) get().closePalette();
    else get().openPalette();
  },

  setPaletteQuery(q) {
    set({ paletteQuery: q });
  },

  async saveSettings(patch) {
    try {
      set({ settings: await invoke("settings:set", patch) });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async saveSnippet(s) {
    try {
      set({ snippets: await invoke("snippets:save", s) });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async deleteSnippet(id) {
    try {
      set({ snippets: await invoke("snippets:delete", id) });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async createCategory(name, prompt) {
    try {
      set({ categories: await invoke("categories:create", name, prompt) });
      get().showToast({ eyebrow: "CATEGORY ADDED", text: `${name}. The last 30 days are being re-sorted in the background.` });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async updateCategory(id, patch) {
    try {
      set({ categories: await invoke("categories:update", id, patch) });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async deleteCategory(id) {
    try {
      set({ categories: await invoke("categories:delete", id) });
      if (get().category === id) get().setView("inbox");
      else void get().refreshCounts();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async loadDrafts() {
    try {
      const drafts = await invoke("drafts:list", selectedAccountIds(get()));
      set({ drafts });
      get().adoptDraftChange(drafts);
    } catch (err) {
      // The list on screen stays; emptying it would make the sidebar count and the strips lie.
      get().showToast({ eyebrow: "DRAFTS", text: `Drafts could not be read: ${(err as Error).message}` });
    }
  },

  adoptDraftChange(drafts) {
    // The open compose's row changed under it: an edit made in Gmail replaced the text, because nothing was typed
    // here in the last minute (the main process keeps a fresher local edit and pushes it instead). The compose
    // takes that text, so the next keystroke builds on Gmail's version rather than writing over it.
    const s = get();
    const d = s.compose;
    const rowId = d?.draftId ?? s.autosavedDraftId;
    if (!d || !rowId || !lastSaved || lastSaved.draftId !== rowId) return;
    const row = drafts.find((r) => r.draftId === rowId);
    if (!row) return;
    const rowKey = saveKey(row);
    if (rowKey === lastSaved.key || rowKey === saveKey(d)) return;
    const adopted: ComposeDraft = { ...d, to: row.to, cc: row.cc, bcc: row.bcc, subject: row.subject, bodyHtml: row.bodyHtml, quotedHtml: row.quotedHtml };
    lastSaved = { draftId: rowId, key: rowKey };
    cancelAutosave();
    set({ compose: adopted });
    if (!s.inlineCollapsed) s.editorApi?.setHtml(row.bodyHtml);
    get().showToast({ eyebrow: "UPDATED FROM GMAIL", text: "This draft was edited in Gmail. The editor now shows that version." });
  },

  openDraft(d) {
    // A reply goes back under its thread when that thread can be shown; a new message or a forward, and a reply whose thread is not in the store, get the panel.
    const s = get();
    const inlineable = Boolean(d.threadId) && (d.mode === "reply" || d.mode === "replyAll");
    if (!inlineable) {
      s.openCompose(d.mode, { draft: d });
      return;
    }
    const showing = s.open && s.open.thread.id === d.threadId && s.open.thread.accountId === d.accountId;
    if (showing) {
      s.openCompose(d.mode, { draft: d, placement: "inline" });
      return;
    }
    void s.openThreadById(d.accountId, d.threadId!, { quiet: true }).then((opened) => {
      const o = get().open;
      if (opened && o && o.thread.id === d.threadId && o.thread.accountId === d.accountId) get().openCompose(d.mode, { draft: d, placement: "inline" });
      else get().openCompose(d.mode, { draft: d, placement: "panel" });
    });
  },

  async deleteDraft(id) {
    try {
      await invoke("drafts:delete", id);
    } catch (err) {
      get().showToast({ eyebrow: "NOT DELETED", text: (err as Error).message });
    }
    void get().loadDrafts();
  },
}));

/**
 * An inline reply is docked under one thread. Whenever the reading pane moves
 * to another thread or closes (J and K, a click, a view change, E, snooze),
 * the draft is kept and the box goes; the strip is back when the thread is.
 */
useApp.subscribe((s, prev) => {
  if (s.open === prev.open || !s.compose || s.composePlacement !== "inline" || !s.inlineAnchor) return;
  const same = s.open && s.open.thread.id === s.inlineAnchor.threadId && s.open.thread.accountId === s.inlineAnchor.accountId;
  if (!same) void s.closeCompose(true);
});

/** Send-later presets: T tomorrow 9:00, W next Monday 9:00. */
export const SEND_LATER = { tomorrow: () => tomorrowAt(9), nextMonday: () => nextMondayAt(9) };

export { isElectron };

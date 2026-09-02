// The IPC contract between the Electron main process and the renderer. Both
// sides import from here; nothing else crosses the bridge.

export type AuthState = "signed_out" | "ok" | "expired";
export type SyncState = "new" | "backfill" | "live" | "reauth" | "error";

export interface AccountInfo {
  id: string;
  email: string;
  displayName: string | null;
  consent: "internal" | "external";
  authState: AuthState;
  syncState: SyncState;
  configured: boolean;
  backfill: { done: number; total: number | null } | null;
  lastSyncAt: number | null;
  error: string | null;
}

export interface AccountsStatus {
  accounts: AccountInfo[];
  configPath: string;
  configError: string | null;
}

export interface Address {
  email: string;
  name: string;
}

export interface ThreadSummary {
  accountId: string;
  id: string;
  subject: string;
  snippet: string;
  participants: Address[];
  lastMessageAt: number;
  sortAt: number;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  hasAttachments: boolean;
  split: "important" | "other" | null;
  type: string | null;
  categoryId: string | null;
  wakeAt: number | null;
  /** Set when a remind-if-no-reply fired and nothing has arrived since: eyebrow NO REPLY BY. */
  noReplyBy: number | null;
  /** Daily 0, Weekly 0, Later, or none. */
  queue: QueueName | null;
  /** Set on the pseudo-threads the Scheduled view lists: a send_queue row waiting for its send-later time. */
  scheduled?: ScheduledInfo | null;
}

export interface ScheduledInfo {
  sendId: number;
  sendAt: number;
}

export type QueueName = "daily" | "weekly" | "later";

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
}

export interface MessageView {
  accountId: string;
  id: string;
  threadId: string;
  internalDate: number;
  from: Address;
  replyTo: Address | null;
  to: Address[];
  cc: Address[];
  messageIdHeader: string | null;
  references: string | null;
  subject: string;
  snippet: string;
  labelIds: string[];
  direction: "in" | "out";
  isAuto: boolean;
  hasAttachments: boolean;
  body: { html: string | null; text: string | null; attachments: AttachmentInfo[] } | null;
  loadImages: boolean;
}

export interface ThreadView {
  thread: ThreadSummary;
  messages: MessageView[];
  bodiesPending: boolean;
}

export type InboxView = "inbox" | "all" | "snoozed" | "sent" | "drafts" | "starred" | "unread" | "attachments" | "scheduled" | "archive" | "spam" | "trash" | `search:${string}` | QueueName;

export interface ListRequest {
  view: InboxView;
  split?: "important" | "other" | null;
  category?: string | null;
  accountIds?: string[];
  cursor?: string | null;
  limit?: number;
}

export interface ListResponse {
  rows: ThreadSummary[];
  nextCursor: string | null;
}

export interface SearchHitView {
  thread: ThreadSummary;
  messageId: string;
  excerpt: string;
}

export interface Counts {
  inbox: number;
  unread: number;
  snoozed: number;
  daily: number;
  weekly: number;
  later: number;
  /** E presses on Daily 0 threads since the day started, and on Weekly 0 threads since the week started. */
  clearedDaily: number;
  clearedWeekly: number;
}

export const EMPTY_COUNTS: Counts = { inbox: 0, unread: 0, snoozed: 0, daily: 0, weekly: 0, later: 0, clearedDaily: 0, clearedWeekly: 0 };

/** Every number the sidebar shows, in one payload. */
export interface SidebarCounts extends Counts {
  attachments: number;
  archive: number;
  spam: number;
  trash: number;
  starred: number;
  scheduled: number;
  important: number;
  other: number;
  /** Inbox threads per builtin type and custom category id. */
  categories: Record<string, number>;
  /** Matching threads per saved search id. */
  searches: Record<string, number>;
}

export const EMPTY_SIDEBAR_COUNTS: SidebarCounts = { ...EMPTY_COUNTS, attachments: 0, archive: 0, spam: 0, trash: 0, starred: 0, scheduled: 0, important: 0, other: 0, categories: {}, searches: {} };

export interface SavedSearchInfo {
  id: number;
  name: string;
  /** The same syntax the / search takes. */
  query: string;
}

/** The sidebar rows as the user arranged them: three fixed groups, each an ordered list of row ids with a hidden flag. Stored as JSON in the settings table. */
export interface SidebarLayoutRow {
  id: string;
  hidden: boolean;
}

export interface SidebarLayoutGroup {
  id: SidebarGroupId;
  rows: SidebarLayoutRow[];
}

export type SidebarGroupId = "queues" | "inbox" | "folders";

export interface SidebarLayout {
  version: 1;
  groups: SidebarLayoutGroup[];
}

export interface AppInfo {
  version: string;
  platform: string;
  smoke: boolean;
  /** User-supplied art files present in the data folder, by name: "inbox-zero" means app://mail/user-art/inbox-zero will answer. */
  userArt: string[];
}

export interface CategoryInfo {
  id: string;
  name: string;
  kind: "builtin" | "custom";
  prompt: string;
}

export interface SnippetInfo {
  id: number;
  trigger: string;
  name: string;
  bodyHtml: string;
  bodyText: string;
}

export interface SettingsInfo {
  undoWindowSec: number;
  autoDraft: boolean;
  remoteImages: "always" | "known" | "never";
}

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** Everything a compose panel holds; the same shape is saved as a local draft and queued for send. */
export interface ComposeDraft {
  draftId?: number | null;
  accountId: string;
  threadId?: string | null;
  mode: ComposeMode;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyHtml: string;
  /** Quoted history, rendered under the body and sent with it. */
  quotedHtml: string;
  inReplyTo?: string | null;
  references?: string | null;
}

export type DraftMirrorState = "pending" | "synced" | "failed";

export interface DraftInfo extends ComposeDraft {
  draftId: number;
  updatedAt: number;
  /** Written here, or found in Gmail and imported. Both edit and mirror the same way. */
  origin: "local" | "gmail";
  /** Whether the last edit has reached Gmail: the Drafts row reads In Gmail, Saving, or Not in Gmail with the error. */
  mirror: { state: DraftMirrorState; error: string | null; at: number | null };
}

export interface SaveDraftOptions {
  /** Esc, park, discard of a previous box: mirror now rather than after the typing pause. */
  flush?: boolean;
}

export interface SendResult {
  id: number;
  sendAt: number;
  undoUntil: number;
}

/** A queued send that was cancelled in time comes back as a draft to reopen. */
export interface UndoSendResult {
  cancelled: boolean;
  draft: ComposeDraft | null;
}

export type AiErrorCode = "not_logged_in" | "daemon_down" | "unauthorized" | "timeout" | "bad_response" | "model_unsupported" | "unknown";

export interface AiFailure {
  ok: false;
  code: AiErrorCode;
  error: string;
}

export interface AiStatus {
  ok: boolean;
  loggedIn: boolean;
  claude: string;
  local: string;
  model: string | null;
  cliVersion: string | null;
}

export type SummaryResult = { ok: true; summary: string; cached: boolean } | AiFailure;
export type InstantRepliesResult = { ok: true; replies: string[]; cached: boolean } | AiFailure;
export type DraftReplyResult = { ok: true; text: string } | AiFailure;

export interface AskSource {
  n: number;
  accountId: string;
  threadId: string;
  subject: string;
  excerpt: string;
}

export type AskResult = { ok: true; answer: string; sources: AskSource[] } | (AiFailure & { sources: AskSource[] });

export interface RefileTarget {
  split: "important" | "other";
  /** A builtin type id, a custom category id, or null for no category. */
  category: string | null;
}

export interface SyncProgress {
  accountId: string;
  state: SyncState;
  done: number;
  total: number | null;
  finished: boolean;
}

export interface ToastEvent {
  text: string;
  eyebrow?: string;
  undo?: { kind: "send"; id: number; until: number } | null;
}

export interface SchedulerStatus {
  snoozes: number;
  reminders: number;
  queuedSends: number;
  pendingOutbox: number;
}

export interface ThreadsChanged {
  accountId: string | null;
}

/** One calendar event, merged across accounts in the rail. */
export interface CalendarEventView {
  accountId: string;
  id: string;
  summary: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  busy: boolean;
  responseStatus: string;
  joinUrl: string | null;
  organizerEmail: string | null;
  attendees: Array<{ email: string; name: string | null; responseStatus: string | null; self: boolean }>;
}

/** A merged busy interval; the availability picker never sees which account it came from. */
export interface BusyBlock {
  start: number;
  end: number;
}

export interface ContactThreadRef {
  accountId: string;
  threadId: string;
  subject: string;
  lastMessageAt: number;
  messageCount: number;
}

export interface ContactEventRef {
  accountId: string;
  id: string;
  summary: string;
  startAt: number;
  endAt: number;
  joinUrl: string | null;
}

export interface ContactWebSummary {
  text: string;
  at: number;
}

/** Everything the contact rail shows for one address, read from the local store. */
export interface ContactCard {
  email: string;
  name: string;
  domain: string;
  /** A data: URL the renderer can show under the CSP, or null while the photo is still being resolved. */
  photo: string | null;
  twoWayThreads: number;
  lastFromAt: number | null;
  lastToAt: number | null;
  recentThreads: ContactThreadRef[];
  nextEvent: ContactEventRef | null;
  lastEvent: ContactEventRef | null;
  web: ContactWebSummary | null;
  /** True once the store shows at least three two-way threads with this address. */
  webEligible: boolean;
}

export type ContactWebResult = { ok: true; web: ContactWebSummary } | AiFailure;

export interface LoginItemInfo {
  openAtLogin: boolean;
  /** False in dev and smoke runs, where the login item is left alone. */
  supported: boolean;
}

/** Event channels pushed from main to the renderer. */
export interface ArcmailEvents {
  "accounts:changed": AccountsStatus;
  "threads:changed": ThreadsChanged;
  "sync:progress": SyncProgress;
  "toast": ToastEvent;
  "categories:changed": CategoryInfo[];
  "calendar:changed": { accountId: string | null };
  /** A draft reached Gmail, failed to, arrived from Gmail, or went away there. The Drafts view reloads. */
  "drafts:changed": { accountId: string | null };
}

/** Request channels the renderer can invoke. */
export interface ArcmailInvoke {
  "accounts:status": () => AccountsStatus;
  "accounts:signIn": (accountId: string) => AccountsStatus;
  "accounts:signOut": (accountId: string) => AccountsStatus;
  "threads:list": (req: ListRequest) => ListResponse;
  "threads:get": (accountId: string, threadId: string) => ThreadView;
  "threads:markRead": (accountId: string, threadId: string, read: boolean) => void;
  "threads:star": (accountId: string, threadId: string, starred: boolean) => void;
  "threads:archive": (accountId: string, threadId: string) => void;
  "threads:moveToInbox": (accountId: string, threadId: string) => void;
  "threads:trash": (accountId: string, threadId: string) => void;
  "threads:snooze": (accountId: string, threadId: string, wakeAt: number) => void;
  "threads:remind": (accountId: string, threadId: string, dueAt: number) => void;
  "threads:counts": (accountIds?: string[]) => Counts;
  "sidebar:counts": (accountIds?: string[]) => SidebarCounts;
  "sidebar:getLayout": () => SidebarLayout | null;
  "sidebar:setLayout": (layout: SidebarLayout) => void;
  "searches:list": () => SavedSearchInfo[];
  "searches:create": (name: string, query: string) => SavedSearchInfo[];
  "searches:update": (id: number, patch: { name?: string; query?: string }) => SavedSearchInfo[];
  "searches:delete": (id: number) => SavedSearchInfo[];
  /** D or W. Returns the queue the thread ends up in, null when the key took it out. */
  "threads:toggleQueue": (accountId: string, threadId: string, queue: "daily" | "weekly") => QueueName | null;
  /** Throttled keyboard or mouse activity while the window is focused; drives the Daily 0 day boundary. */
  "app:activity": (at: number) => void;
  "categories:list": () => CategoryInfo[];
  "contacts:setLoadImages": (email: string, load: boolean) => void;
  "search:query": (query: string, accountIds?: string[]) => SearchHitView[];
  "scheduler:status": () => SchedulerStatus;
  "send:undo": (id: number) => UndoSendResult;
  "sync:now": () => void;
  "app:info": () => AppInfo;
  "compose:send": (draft: ComposeDraft, sendAt?: number | null) => SendResult;
  "compose:signature": (accountId: string) => string;
  "drafts:save": (draft: ComposeDraft, opts?: SaveDraftOptions) => number;
  "drafts:list": (accountIds?: string[]) => DraftInfo[];
  "drafts:delete": (id: number) => void;
  "snippets:list": () => SnippetInfo[];
  "snippets:save": (s: { id?: number | null; trigger: string; name: string; bodyHtml: string; bodyText: string }) => SnippetInfo[];
  "snippets:delete": (id: number) => SnippetInfo[];
  "settings:get": () => SettingsInfo;
  "settings:set": (patch: Partial<SettingsInfo>) => SettingsInfo;
  "categories:create": (name: string, prompt: string) => CategoryInfo[];
  "categories:update": (id: string, patch: { name?: string; prompt?: string }) => CategoryInfo[];
  "categories:delete": (id: string) => CategoryInfo[];
  "classify:refile": (accountId: string, threadId: string, to: RefileTarget) => void;
  "ai:status": () => AiStatus;
  "ai:summary": (accountId: string, threadId: string) => SummaryResult;
  "ai:instantReplies": (accountId: string, messageId: string) => InstantRepliesResult;
  "ai:draftReply": (accountId: string, threadId: string) => DraftReplyResult;
  "ai:ask": (question: string, accountIds?: string[]) => AskResult;
  "calendar:list": (from: number, to: number) => CalendarEventView[];
  "calendar:busy": (from: number, to: number) => BusyBlock[];
  "calendar:syncNow": () => void;
  "contacts:get": (email: string) => ContactCard;
  "contacts:photo": (email: string) => string | null;
  "contacts:lookupWeb": (email: string) => ContactWebResult;
  "app:loginItem": () => LoginItemInfo;
  "app:setLoginItem": (openAtLogin: boolean) => LoginItemInfo;
}

export type InvokeChannel = keyof ArcmailInvoke;
export type EventChannel = keyof ArcmailEvents;

export const EVENT_CHANNELS: EventChannel[] = ["accounts:changed", "threads:changed", "sync:progress", "toast", "categories:changed", "calendar:changed", "drafts:changed"];

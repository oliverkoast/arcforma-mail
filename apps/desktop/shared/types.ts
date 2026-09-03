// The IPC contract between the Electron main process and the renderer. Both
// sides import from here; nothing else crosses the bridge.

import type { AiChoice, ConsoleLink, DownloadState, OnboardingStepId } from "./onboarding.js";

export type { AiChoice, ConsoleLink, DownloadState, OnboardingStepId };

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
  /** 0 to 100 from the attention model, null when the thread has no verdict yet. */
  attention: number | null;
  /** needs_you, important, or other. needs_you and important both carry split = important. */
  band: AttentionBand | null;
  /** One sentence saying why the thread landed in its band, for the row eyebrow and the thread head. */
  attentionReason: string | null;
  wakeAt: number | null;
  /** Set when a remind-if-no-reply fired and nothing has arrived since: eyebrow NO REPLY BY. */
  noReplyBy: number | null;
  /** Daily 0, Weekly 0, Later, or none. */
  queue: QueueName | null;
  /** True when an inbound message carries a List-Unsubscribe header, so U has something to run. */
  canUnsubscribe: boolean;
  /** What U did to this thread, or null when it never ran. */
  unsubscribeState: UnsubscribeState | null;
  /** Set on the pseudo-threads the Scheduled view lists: a send_queue row waiting for its send-later time. */
  scheduled?: ScheduledInfo | null;
}

/** needs_you is Important that is waiting on a reply from Oliver; important is Important that is not. */
export type AttentionBand = "needs_you" | "important" | "other";

export type UnsubscribeState = "none" | "sent" | "opened" | "failed";

/** What U did: the method that ran and the sentence the toast shows. */
export interface UnsubscribeResult {
  method: "one-click" | "mailto" | "open" | "none";
  ok: boolean;
  /** True when the thread left the inbox with the unsubscribe. */
  archived: boolean;
  state: UnsubscribeState;
  text: string;
}

export interface ScheduledInfo {
  sendId: number;
  sendAt: number;
}

export type QueueName = "daily" | "weekly" | "later";

/** What the preview window does with an attachment. Nothing outside these four is ever rendered, and none of them is executed. */
export type AttachmentPreviewKind = "image" | "pdf" | "text" | "none";

export interface AttachmentInfo {
  /**
   * Names this part within its message. The renderer passes this back to
   * preview or download; it never handles a path or a Gmail attachment id, and
   * the main process resolves the key against the stored message.
   */
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  /** What a preview of this would show, so the chip's tooltip can say it before the window opens. */
  preview: AttachmentPreviewKind;
}

/** Everything the preview window shows for one attachment. Built in the main process; the bytes are cached before it opens. */
export interface AttachmentDetail {
  accountId: string;
  messageId: string;
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: AttachmentPreviewKind;
  /** app://mail/attachment/... for an image or a PDF, served from the cache folder. null for the other kinds. */
  src: string | null;
  /** The file as text, for a text preview. Never HTML, never executed. null for the other kinds. */
  text: string | null;
  /** True when the file was longer than the preview reads and the text above stops early. */
  truncated: boolean;
  /** The message it came on, for the window title. */
  subject: string;
  from: string;
}

/** Where a copy of an attachment landed. saved is false only when a Save as dialog was closed without choosing. */
export interface AttachmentSaveResult {
  saved: boolean;
  path: string | null;
  filename: string | null;
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
  /** Blind copies, from the stored Bcc header. Only ever on the messages the owner sent. */
  bcc: Address[];
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
  /** True when at least one message has no body yet: the fetch failed or there was no client. Retry reopens the thread. */
  bodiesPending: boolean;
  /** Why the bodies did not come, for the eyebrow; null when they did. */
  bodiesError?: string | null;
}

export type InboxView = "inbox" | "all" | "snoozed" | "sent" | "drafts" | "starred" | "unread" | "attachments" | "scheduled" | "archive" | "spam" | "trash" | "needsyou" | `search:${string}` | QueueName;

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

/** Wraps each matched term in a search highlight. The store's searchQuery.ts carries the same pair. */
export const HIGHLIGHT_START = "\uE000";
export const HIGHLIGHT_END = "\uE001";

export type HighlightField = "subject" | "from" | "to" | "body";

export interface SearchHighlight {
  /** Which field the marked text comes from; null when the query had no words to mark. */
  field: HighlightField | null;
  /** The field's text with HIGHLIGHT_START and HIGHLIGHT_END around each hit. */
  text: string;
}

export interface SearchHitView {
  thread: ThreadSummary;
  messageId: string;
  /** Plain words around the match, unmarked. */
  excerpt: string;
  highlight: SearchHighlight;
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
  /** Inbox threads a person asked something in and nothing has gone back to. */
  needsYou: number;
  /** Inbox threads per builtin type and custom category id. */
  categories: Record<string, number>;
  /** Matching threads per saved search id. */
  searches: Record<string, number>;
}

export const EMPTY_SIDEBAR_COUNTS: SidebarCounts = { ...EMPTY_COUNTS, attachments: 0, archive: 0, spam: 0, trash: 0, starred: 0, scheduled: 0, important: 0, other: 0, needsYou: 0, categories: {}, searches: {} };

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
  /** Days after a message to a client goes out before a remind-if-no-reply fires on its thread. 0 turns the rule off. */
  remindClientsAfterDays: number;
  /** Category ids or names whose threads and correspondents count as clients for that rule. */
  remindScope: string[];
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

/** First-run onboarding: where the flow is, and what the machine already has. */
export interface OnboardingInfo {
  step: OnboardingStepId;
  done: boolean;
  /** The clients file the flow writes, shown so nobody has to guess where credentials landed. */
  clientsPath: string;
}

export interface OnboardingAiInfo {
  /** Daemon health, or null when the daemon could not be reached at all. */
  status: AiStatus | null;
  daemonConfigPath: string;
  daemonConfigPresent: boolean;
  /** A long-lived Claude Code token is stored. The token itself never crosses the bridge. */
  hasClaudeToken: boolean;
  /** An Anthropic key is stored. The key itself never crosses the bridge. */
  hasApiKey: boolean;
  /** What the config says was chosen, or null when nothing has been stored. */
  storedChoice: AiChoice | null;
}

export interface OnboardingModelInfo {
  /** The llama.cpp server binary the daemon config points at. */
  binaryPath: string | null;
  binaryPresent: boolean;
  /** Where the GGUF goes, and whether it is there. */
  modelPath: string;
  modelPresent: boolean;
  modelsDir: string;
  catalog: { name: string; file: string; bytes: number };
  download: DownloadState;
}

export type OnboardingAccessibility = "granted" | "not_granted" | "unknown";

export interface OnboardingTextInfo {
  installed: boolean;
  appPath: string;
  label: string;
  logPath: string;
  accessibility: OnboardingAccessibility;
  /** When the log line the state came from was written, or null when there is no log. */
  checkedAt: number | null;
  /** False when this build carries no install script, so the button says so instead of failing. */
  scriptPresent: boolean;
}

/** Long-running onboarding work, pushed as it happens: the model download and the text tool install. */
export type OnboardingProgress =
  | { kind: "model"; state: DownloadState }
  | { kind: "text"; line: string; phase: "running" | "done" | "failed" };

export interface AddAccountRequest {
  email: string;
  consent: "internal" | "external";
  clientId: string;
  clientSecret: string;
}

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
  /** The model download or the text tool install said something while onboarding is open. */
  "onboarding:progress": OnboardingProgress;
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
  /** U: runs the best List-Unsubscribe method on the thread and archives it when the request went out. */
  "threads:unsubscribe": (accountId: string, threadId: string) => UnsubscribeResult;
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
  /** Fetches the attachment if it is not cached, then opens it in its own preview window. Nothing is executed and nothing is handed to the system opener. */
  "attachments:preview": (accountId: string, messageId: string, key: string) => void;
  /** Fetches if needed, then copies into the Downloads folder under a name nothing there has, and reveals it in Finder. */
  "attachments:download": (accountId: string, messageId: string, key: string) => AttachmentSaveResult;
  /** The same, to a folder and name chosen in the native save dialog. saved is false when the dialog was cancelled. */
  "attachments:saveAs": (accountId: string, messageId: string, key: string) => AttachmentSaveResult;
  /** What the preview window shows. Only answers for an attachment whose bytes are already cached. */
  "attachments:detail": (accountId: string, messageId: string, key: string) => AttachmentDetail;
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
  "onboarding:get": () => OnboardingInfo;
  /** Records the step on screen so a quit mid-way comes back to it. */
  "onboarding:setStep": (step: OnboardingStepId) => OnboardingInfo;
  /** Start reading at the end, or Run setup again from Settings. */
  "onboarding:setDone": (done: boolean) => OnboardingInfo;
  /** Opens one of the four Google Cloud pages in the default browser. The URL is built in the main process. */
  "onboarding:openConsole": (link: ConsoleLink, projectId?: string) => void;
  /** Opens the Accessibility pane of System Settings. */
  "onboarding:openAccessibility": () => void;
  /** Writes one account into oauth-clients.json at mode 0600, then runs the browser sign-in for it. */
  "onboarding:addAccount": (req: AddAccountRequest) => AccountsStatus;
  "onboarding:aiState": () => OnboardingAiInfo;
  /** Stores the credential for a choice in the daemon config at mode 0600. Local only clears both. */
  "onboarding:setAi": (choice: AiChoice, secret?: string) => OnboardingAiInfo;
  "onboarding:modelState": () => OnboardingModelInfo;
  /** Starts or resumes the model download. Progress arrives on onboarding:progress. */
  "onboarding:downloadModel": () => OnboardingModelInfo;
  "onboarding:cancelModel": () => OnboardingModelInfo;
  "onboarding:textState": () => OnboardingTextInfo;
  /** Runs packages/text-tools/install.sh, streaming its output on onboarding:progress. */
  "onboarding:installText": () => OnboardingTextInfo;
  /** Restarts Arcforma Text and reads its own answer about the Accessibility grant. */
  "onboarding:checkAccessibility": () => OnboardingTextInfo;
}

export type InvokeChannel = keyof ArcmailInvoke;
export type EventChannel = keyof ArcmailEvents;

export const EVENT_CHANNELS: EventChannel[] = ["accounts:changed", "threads:changed", "sync:progress", "toast", "categories:changed", "calendar:changed", "drafts:changed", "onboarding:progress"];

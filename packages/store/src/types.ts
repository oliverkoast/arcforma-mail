// Row shapes as they come back from SQLite, plus the minimal Gmail wire shapes
// the store accepts. The gmail package owns the full API types; these are the
// structural subset the store reads, so the two packages do not depend on each
// other at runtime.

export type AuthState = "signed_out" | "ok" | "expired";
export type SyncState = "new" | "backfill" | "live" | "reauth" | "error";

export interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  consent: "internal" | "external";
  auth_state: AuthState;
  sync_state: SyncState;
  history_id: string | null;
  backfill_cursor: string | null;
  backfill_total: number | null;
  backfill_done: number;
  last_sync_at: number | null;
  signature_html: string | null;
  send_as_json: string | null;
  error: string | null;
  created_at: number;
}

export interface ThreadRow {
  account_id: string;
  id: string;
  subject: string;
  snippet: string;
  participants_json: string;
  first_message_at: number;
  last_message_at: number;
  sort_at: number;
  message_count: number;
  unread: number;
  starred: number;
  in_inbox: number;
  has_attachments: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  history_id: string | null;
  updated_at: number;
}

export interface ThreadListRow extends ThreadRow {
  split: "important" | "other" | null;
  type: string | null;
  category_id: string | null;
  /** 0 to 100 from the attention model, null when the thread has no verdict yet. */
  attention: number | null;
  /** needs_you, important, or other. needs_you and important both carry split = important. */
  band: "needs_you" | "important" | "other" | null;
  /** One sentence saying why the thread landed in its band. */
  attention_reason: string | null;
  wake_at: number | null;
  /** Due date of a fired remind-if-no-reply that nothing newer has answered. */
  no_reply_by: number | null;
  /** Daily 0, Weekly 0, Later, or none. Manual rows and the automatic Daily 0 rule, resolved. */
  queue: "daily" | "weekly" | "later" | null;
  /** What U did to the thread, or null when it never ran. */
  unsubscribe_state: "none" | "sent" | "opened" | "failed" | null;
  /** 1 when an inbound message carries a List-Unsubscribe header. */
  can_unsubscribe: number;
}

export interface MessageRow {
  account_id: string;
  id: string;
  thread_id: string;
  internal_date: number;
  from_email: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  snippet: string;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  label_ids_json: string;
  headers_json: string;
  has_attachments: number;
  size_estimate: number | null;
  is_auto: number;
  sender_type: string;
  direction: "in" | "out";
  history_id: string | null;
  updated_at: number;
  /** Stable key of the message's messages_fts row. */
  fts_id: number;
}

export interface MessageBodyRow {
  account_id: string;
  message_id: string;
  html: string | null;
  text: string | null;
  attachments_json: string;
  fetched_at: number;
}

/**
 * One attachment whose bytes are cached on disk (schema 13). filename is the
 * sanitised name the file actually has, never the raw one off the network, and
 * path is inside the app's attachments folder. The row goes when the message
 * does, and the trigger hands the path to orphan_attachments so the file can be
 * unlinked afterwards.
 */
export interface AttachmentFileRow {
  account_id: string;
  message_id: string;
  attachment_key: string;
  filename: string;
  mime_type: string;
  bytes: number;
  path: string;
  cached_at: number;
}

export interface LabelRow {
  account_id: string;
  id: string;
  name: string;
  type: string;
  color_json: string | null;
}

export interface OutboxRow {
  id: number;
  account_id: string;
  op: OutboxOp;
  payload_json: string;
  status: "pending" | "inflight" | "done" | "failed";
  attempts: number;
  next_attempt_at: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export type OutboxOp = "modifyLabels" | "trash" | "untrash" | "send" | "draftUpsert" | "draftDelete";

export interface ModifyLabelsPayload {
  threadId: string;
  addLabelIds: string[];
  removeLabelIds: string[];
  /** Label names resolved (and created if missing) at drain time, e.g. Arcforma/Snoozed. */
  addLabelNames?: string[];
  removeLabelNames?: string[];
}

/** Mirrors a local draft to Gmail: drafts.create when gmailDraftId is null, drafts.update otherwise. */
export interface DraftUpsertPayload {
  /** The local drafts.id the result is written back to. */
  draftId: number;
  /** base64url RFC 822, the same build the send path uses. */
  raw: string;
  threadId?: string | null;
  /** Filled in at drain time from the local row, so a create that landed earlier is reused. */
  gmailDraftId?: string | null;
}

export interface DraftDeletePayload {
  gmailDraftId: string;
}

export type DraftMirrorState = "pending" | "synced" | "failed";
export type DraftOrigin = "local" | "gmail";

export interface SnoozeRow {
  id: number;
  account_id: string;
  thread_id: string;
  wake_at: number;
  status: "pending" | "woken" | "cancelled";
  created_at: number;
  woken_at: number | null;
}

export interface ReminderRow {
  id: number;
  account_id: string;
  thread_id: string;
  last_message_id: string;
  due_at: number;
  status: "pending" | "fired" | "replied" | "cancelled";
  created_at: number;
  resolved_at: number | null;
}

export interface DraftRow {
  id: number;
  account_id: string;
  thread_id: string | null;
  mode: "new" | "reply" | "replyAll" | "forward";
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body_html: string;
  quoted_html: string;
  in_reply_to: string | null;
  references_header: string | null;
  created_at: number;
  updated_at: number;
  /** Gmail's draft id once the mirror landed, null until then. */
  gmail_draft_id: string | null;
  /** The message id behind the Gmail draft. Changes on every update on either side. */
  gmail_message_id: string | null;
  mirror_state: DraftMirrorState;
  mirror_error: string | null;
  mirrored_at: number | null;
  /** Where the draft started: written here, or found in Gmail. */
  origin: DraftOrigin;
  /** Last edit made in this app; imports from Gmail leave it alone. Decides who wins a conflict. */
  local_edited_at: number | null;
  /** 1 when the writer armed a read receipt for this one message. Off unless they turned it on. */
  read_receipt: number;
}

/**
 * One message a sender armed a read receipt on (schema 15). The token is what
 * the image URL carries; message_id is filled in once the send succeeds.
 * Nothing here records that anyone read anything, because the pixel cannot
 * know that; the events say what asked for the image and when.
 */
export interface ReadReceiptRow {
  token: string;
  account_id: string;
  thread_id: string | null;
  send_id: number | null;
  message_id: string | null;
  sent_at: number;
  created_at: number;
}

/** One fetch of a receipt's image, as the pixel service graded it. */
export interface ReadReceiptEventRow {
  token: string;
  at: number;
  /** opened, automatic, or unknown, from classifyFetch in packages/pixel-service. */
  grade: string;
  why: string;
  user_agent: string;
}

export interface CorrectionRow {
  id: number;
  account_id: string;
  thread_id: string;
  message_id: string | null;
  from_split: string | null;
  to_split: string | null;
  from_type: string | null;
  to_type: string | null;
  from_category: string | null;
  to_category: string | null;
  text_excerpt: string;
  created_at: number;
}

export interface ClassificationRow {
  account_id: string;
  thread_id: string;
  split: "important" | "other";
  type: string | null;
  category_id: string | null;
  confidence: number;
  source: "rule" | "local" | "manual";
  last_message_id: string | null;
  /** 0 to 100 from the attention model. */
  attention: number;
  band: "needs_you" | "important" | "other";
  /** One sentence saying why. */
  reason: string | null;
  classified_at: number;
}

export interface SendQueueRow {
  id: number;
  account_id: string;
  thread_id: string | null;
  raw_mime: string;
  meta_json: string;
  send_at: number;
  undo_until: number;
  status: "queued" | "sending" | "sent" | "cancelled" | "failed";
  attempts: number;
  gmail_message_id: string | null;
  error: string | null;
  tracking_token: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContactRow {
  email: string;
  name: string | null;
  domain: string;
  last_seen_at: number | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  thread_count: number;
  photo_url: string | null;
  web_json: string | null;
  load_images: number;
}

export interface CalendarEventRow {
  account_id: string;
  calendar_id: string;
  id: string;
  summary: string | null;
  start_at: number;
  end_at: number;
  all_day: number;
  status: string;
  busy: number;
  response_status: string;
  hangout_link: string | null;
  organizer_email: string | null;
  attendees_json: string;
  updated_at: number;
}

export interface CategoryRow {
  id: string;
  name: string;
  kind: "builtin" | "custom";
  prompt: string;
  examples_json: string;
  gmail_label: string | null;
  position: number;
  created_at: number;
}

export interface ClassificationInput {
  accountId: string;
  threadId: string;
  split: "important" | "other";
  type?: string | null;
  categoryId?: string | null;
  confidence?: number;
  source?: "rule" | "local" | "manual";
  lastMessageId?: string | null;
  /** 0 to 100 from the attention model. Left at 0 when the caller has not scored the thread. */
  attention?: number;
  band?: "needs_you" | "important" | "other";
  reason?: string | null;
}

// ---- Gmail wire subset -----------------------------------------------------

export interface GmailHeaderInput {
  name: string;
  value: string;
}

export interface GmailPartInput {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeaderInput[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPartInput[];
}

export interface GmailMessageInput {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPartInput;
}

export interface GmailThreadInput {
  id: string;
  historyId?: string;
  messages?: GmailMessageInput[];
}

export type HistoryChangeType = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";

export interface HistoryChange {
  type: HistoryChangeType;
  historyId: string;
  messageId: string;
  threadId: string;
  /** Labels on the message at the time of a messageAdded record. */
  labelIds?: string[];
  /** Labels added or removed for labelAdded and labelRemoved records. */
  changedLabelIds?: string[];
}

export interface ApplyHistoryResult {
  /** Threads referenced by messageAdded records that the store has not seen; caller fetches them. */
  threadsToFetch: string[];
  /** Threads whose rows changed locally. */
  touched: string[];
  /** Records skipped because a local change for that thread is still pending in the outbox. */
  masked: number;
  lastHistoryId: string | null;
}

export type InboxView = "inbox" | "all" | "snoozed" | "sent" | "drafts" | "starred" | "needsyou" | "daily" | "weekly" | "later" | "unread" | "attachments" | "archive" | "spam" | "trash";

export interface SavedSearchRow {
  id: number;
  name: string;
  query: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface ListThreadsOptions {
  accountIds?: string[];
  view?: InboxView;
  split?: "important" | "other" | null;
  /** A builtin type (newsletters, promotions, jobs, calendar, notifications, receipts) or a custom category id. */
  category?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface ListThreadsResult {
  rows: ThreadListRow[];
  nextCursor: string | null;
}

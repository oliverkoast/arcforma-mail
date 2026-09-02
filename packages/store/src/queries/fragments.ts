// SQL fragments shared by the thread list and the queue queries. All of them
// are written against the alias t for threads.

export const PENDING_SNOOZE = "EXISTS (SELECT 1 FROM snoozes s WHERE s.account_id = t.account_id AND s.thread_id = t.id AND s.status = 'pending')";

export const HAS_LABEL = (label: string): string => `EXISTS (SELECT 1 FROM thread_labels tl WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = '${label}')`;

/** Neither trashed nor spam: the baseline for every list and count. */
export const NOT_JUNK = `NOT ${HAS_LABEL("TRASH")} AND NOT ${HAS_LABEL("SPAM")}`;

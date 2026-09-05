// The rules about files going out on a message.
//
// Kept apart from the picker and the send path because they are the part that has to be right: a
// message refused by Gmail after the writer has pressed Send has already cost them the send, and
// "message too large" arriving as a bounce an hour later is the worst version of that.

/** One file chosen to go out. The bytes are not held: only where they are, read again at send. */
export interface OutgoingAttachment {
  /** Absolute path on this machine. Read at send, never sooner. */
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

/**
 * Gmail refuses a message whose total exceeds 25 MB, and base64 makes every attachment about a
 * third larger on the wire. So the limit worth enforcing is on the encoded size, which is what the
 * server counts, rather than on what the file browser shows.
 */
export const GMAIL_LIMIT_BYTES = 25 * 1024 * 1024;
const BASE64_OVERHEAD = 4 / 3;

export function encodedSize(bytes: number): number {
  return Math.ceil(bytes * BASE64_OVERHEAD);
}

/** "253 KB", "1.4 MB", "25 MB". Whole numbers below a megabyte, and no trailing .0 above one. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

export interface AttachmentCheck {
  ok: boolean;
  totalBytes: number;
  /** Plain words for the writer when the message cannot go, empty when it can. */
  problem: string;
}

/**
 * Whether these files can go out together.
 *
 * Checked as the files are added rather than at send, so the answer arrives while there is still
 * something to do about it.
 */
export function checkAttachments(files: OutgoingAttachment[]): AttachmentCheck {
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const encoded = encodedSize(totalBytes);
  if (encoded > GMAIL_LIMIT_BYTES) {
    return {
      ok: false,
      totalBytes,
      problem: `Gmail will not send more than ${formatBytes(GMAIL_LIMIT_BYTES)} of attachments, and these come to about ${formatBytes(encoded)} once encoded. Take one off, or send a link instead.`,
    };
  }
  return { ok: true, totalBytes, problem: "" };
}

/** The same file chosen twice is one attachment, not two. Compared by path, which is what identity is here. */
export function addAttachments(existing: OutgoingAttachment[], chosen: OutgoingAttachment[]): OutgoingAttachment[] {
  const have = new Set(existing.map((f) => f.path));
  return [...existing, ...chosen.filter((f) => !have.has(f.path))];
}

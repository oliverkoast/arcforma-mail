// Fetching one attachment's bytes out of Gmail. Everything here is bytes in
// memory: nothing is written to disk, nothing is opened, nothing is executed.
// The caller decides where the bytes land.
//
// Two shapes arrive from the API. A large part carries an attachmentId and its
// bytes have to be asked for separately through users.messages.attachments.get.
// A small part carries its base64url data inline in the message payload and has
// no attachmentId at all; those bytes are already in hand and no call goes out.

import type { GmailClient } from "./client.js";
import type { Attachment } from "./mime.js";

/** Anything that went wrong getting the bytes, with a code the UI can turn into a sentence. */
export class AttachmentError extends Error {
  code: AttachmentErrorCode;
  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

export type AttachmentErrorCode =
  /** Neither an attachmentId nor inline data: there is nothing to fetch. */
  | "no_source"
  /** Gmail answered, but with no data field: the attachment is gone or was never stored. */
  | "missing"
  /** The bytes that came back are not the length the message part declared. */
  | "size_mismatch";

/** What to fetch. attachmentId and data both come from the stored part; one of them has to be there. */
export interface AttachmentRequest {
  messageId: string;
  attachmentId?: string | null;
  /** base64url data already present on the part, for an attachment small enough that Gmail inlined it. */
  data?: string | null;
  /** The size the part declared, checked against what came back. Skipped when 0 or absent. */
  size?: number | null;
}

export interface FetchedAttachment {
  bytes: Buffer;
  /** True when the bytes came off the stored part and no network call went out. */
  inline: boolean;
}

/**
 * base64url to bytes. Gmail is not consistent about padding, and a part that
 * has travelled through a store and back may have gained or lost "=" on the
 * end, so the padding is recomputed rather than trusted. Whitespace (a
 * line-wrapped body) is dropped first.
 */
export function decodeBase64Url(data: string): Buffer {
  const compact = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const pad = compact.length % 4 === 0 ? "" : "=".repeat(4 - (compact.length % 4));
  return Buffer.from(compact + pad, "base64");
}

/** The Gmail path for one attachment. Both ids are path segments, so both are encoded. */
export function attachmentPath(messageId: string, attachmentId: string): string {
  return `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

interface AttachmentResponse {
  size?: number;
  data?: string | null;
  attachmentId?: string;
}

/**
 * The bytes of one attachment. An inline part is decoded in place; anything
 * else goes through users.messages.attachments.get. The length is checked
 * against what the message part declared, so a truncated response is an error
 * rather than a half file on disk.
 */
export async function fetchAttachment(client: Pick<GmailClient, "request">, req: AttachmentRequest, signal?: AbortSignal): Promise<FetchedAttachment> {
  if (req.data) {
    const bytes = decodeBase64Url(req.data);
    checkSize(bytes, req.size ?? null, req.messageId);
    return { bytes, inline: true };
  }
  if (!req.attachmentId) {
    throw new AttachmentError("no_source", "This attachment carries no data and no id, so there is nothing to fetch.");
  }
  const res = await client.request<AttachmentResponse | null>(attachmentPath(req.messageId, req.attachmentId), { signal });
  if (!res || typeof res.data !== "string" || res.data.length === 0) {
    throw new AttachmentError("missing", "Gmail returned no data for this attachment. It may have been removed from the message.");
  }
  const bytes = decodeBase64Url(res.data);
  // Gmail reports its own size on the response. When the part disagrees with
  // it, the part is the number the person was shown, so that is what is checked.
  checkSize(bytes, req.size ?? res.size ?? null, req.messageId);
  return { bytes, inline: false };
}

function checkSize(bytes: Buffer, expected: number | null, messageId: string): void {
  if (!expected || expected <= 0) return;
  if (bytes.length === expected) return;
  throw new AttachmentError("size_mismatch", `The attachment on message ${messageId} came back as ${bytes.length} bytes where ${expected} were expected, so it was not saved.`);
}

/** The request for a stored attachment part, so a caller with an Attachment row does not rebuild it by hand. */
export function requestFor(messageId: string, part: Pick<Attachment, "attachmentId" | "size"> & { data?: string | null }): AttachmentRequest {
  return { messageId, attachmentId: part.attachmentId ?? null, data: part.data ?? null, size: part.size ?? null };
}

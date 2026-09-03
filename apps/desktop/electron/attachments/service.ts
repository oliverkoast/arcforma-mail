// Getting one attachment's bytes onto disk: read the part out of the stored
// message body, use the cached file if there is one, otherwise ask Gmail and
// cache what comes back.
//
// The renderer never names a file, a path, or a Gmail attachment id. It names
// an account, a message, and an attachment key, and everything else is resolved
// here against the store. That is deliberate: a bug or a compromise in the
// renderer then cannot ask for an arbitrary file, only for a part of a message
// the store already holds.

import { fetchAttachment, type AttachmentError, type GmailClient } from "@arcforma/gmail";
import { getBody, type Db } from "@arcforma/store";
import { readCached, writeCached, type CachedAttachment } from "./cache.js";
import { previewKind, type PreviewKind } from "./kind.js";

/** One attachment as message_bodies.attachments_json holds it. */
export interface StoredPart {
  partId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
  contentId?: string | null;
  inline: boolean;
  /** base64url bytes, present only on a part Gmail did not give an attachmentId. */
  data?: string | null;
}

/**
 * How the renderer names one attachment: the Gmail part id, which is stable for
 * the life of the message, falling back to the position in the list for a part
 * that has none. Both sides compute it the same way, so it never travels as an
 * opaque token that has to be kept in step.
 */
export function attachmentKey(part: Pick<StoredPart, "partId">, index: number): string {
  return part.partId ?? `i${index}`;
}

export function listParts(db: Db, accountId: string, messageId: string): StoredPart[] {
  const body = getBody(db, accountId, messageId);
  if (!body) return [];
  try {
    const parsed = JSON.parse(body.attachments_json) as StoredPart[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface FoundPart {
  part: StoredPart;
  key: string;
  kind: PreviewKind;
}

export function findPart(db: Db, accountId: string, messageId: string, key: string): FoundPart | null {
  const parts = listParts(db, accountId, messageId);
  for (const [index, part] of parts.entries()) {
    const k = attachmentKey(part, index);
    if (k !== key) continue;
    return { part, key: k, kind: previewKind(part.mimeType, part.filename) };
  }
  return null;
}

export interface EnsureContext {
  db: Db;
  root: string;
  /** The signed-in client for the account, or null when it is signed out. */
  client: GmailClient | null;
  onProgress?: ((state: AttachmentProgress) => void) | undefined;
}

export type AttachmentProgress = { phase: "fetching"; bytes: number } | { phase: "done"; bytes: number };

/** Anything over this reports progress while it is being fetched; below it the fetch is over before a bar would paint. */
export const PROGRESS_THRESHOLD = 1_048_576;

/**
 * The cached file for one attachment, fetching it first if it is not there.
 * Returns the file plus whether this call went to the network, so the caller can
 * say "Downloaded" rather than "Copied" when it matters.
 */
export async function ensureCached(ctx: EnsureContext, accountId: string, messageId: string, found: FoundPart): Promise<{ file: CachedAttachment; fetched: boolean }> {
  const cached = readCached(ctx.db, ctx.root, accountId, messageId, found.key);
  if (cached) return { file: cached, fetched: false };
  const large = (found.part.size ?? 0) >= PROGRESS_THRESHOLD;
  if (large) ctx.onProgress?.({ phase: "fetching", bytes: found.part.size ?? 0 });
  const bytes = await fetchBytes(ctx.client, messageId, found.part);
  const file = writeCached(ctx.db, ctx.root, {
    accountId,
    messageId,
    attachmentKey: found.key,
    filename: found.part.filename,
    mimeType: found.part.mimeType,
    bytes,
  });
  if (large) ctx.onProgress?.({ phase: "done", bytes: file.bytes });
  return { file, fetched: true };
}

async function fetchBytes(client: GmailClient | null, messageId: string, part: StoredPart): Promise<Buffer> {
  // A part that carried its own bytes needs no account at all, so the signed-out
  // check comes after that case rather than before it.
  if (!part.data && !client) throw new Error("Not signed in to this account, so the attachment cannot be fetched.");
  const got = await fetchAttachment(client ?? { request: () => Promise.reject(new Error("no client")) }, {
    messageId,
    attachmentId: part.attachmentId ?? null,
    data: part.data ?? null,
    size: part.size ?? null,
  });
  return got.bytes;
}

/** The sentence a failed fetch shows in a toast. Typed codes get their own wording; anything else says what it said. */
export function fetchErrorText(err: unknown): string {
  const e = err as AttachmentError & { message?: string };
  switch (e?.code) {
    case "missing":
      return "Gmail no longer has this attachment.";
    case "size_mismatch":
      return "The attachment arrived the wrong size, so it was not saved.";
    case "no_source":
      return "This attachment has no bytes to fetch.";
    default:
      return e?.message || "The attachment could not be fetched.";
  }
}

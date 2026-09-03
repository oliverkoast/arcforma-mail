// The attachment cache: bytes on disk under <userData>/attachments, one folder
// per account and message, indexed by the attachment_files table.
//
// Rules this file keeps, all of them for the same reason (an attachment is a
// file a stranger chose the name and the contents of):
//   - the name on disk is rebuilt by safeFilename, never taken from the network
//   - the finished path is resolved and checked against the root before every
//     read, write, and unlink (resolveInRoot)
//   - files are written 0600 and folders 0700, so nothing else on the machine
//     reads a person's mail attachments
//   - a write goes to a temp file in the same folder and is renamed into place,
//     so a failed fetch cannot leave a half file that looks cached
//   - nothing here opens, launches, or hands a path to the system

import fs from "node:fs";
import path from "node:path";
import { forgetAttachmentFile, getAttachmentFile, recordAttachmentFile, type AttachmentFileRow, type Db } from "@arcforma/store";
import { messageCacheDir, resolveInRoot, safeFilename, uniqueFilename } from "./paths.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface CachePut {
  accountId: string;
  messageId: string;
  attachmentKey: string;
  /** The name off the message. Sanitised here; the caller must not have used it as a path. */
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface CachedAttachment {
  path: string;
  filename: string;
  mimeType: string;
  bytes: number;
}

/**
 * The cached file for one attachment, or null when it is not cached or the file
 * behind the row has gone. A row pointing at a missing file is dropped so the
 * next open fetches instead of failing forever.
 */
export function readCached(db: Db, root: string, accountId: string, messageId: string, attachmentKey: string): CachedAttachment | null {
  const row = getAttachmentFile(db, accountId, messageId, attachmentKey);
  if (!row) return null;
  const full = safePath(root, row);
  if (!full) {
    // The row points somewhere it must not. Treat it as a miss and forget it rather than trusting it.
    forgetAttachmentFile(db, accountId, messageId, attachmentKey);
    return null;
  }
  if (!fs.existsSync(full)) {
    forgetAttachmentFile(db, accountId, messageId, attachmentKey);
    return null;
  }
  return { path: full, filename: row.filename, mimeType: row.mime_type, bytes: row.bytes };
}

function safePath(root: string, row: AttachmentFileRow): string | null {
  try {
    return resolveInRoot(root, row.path);
  } catch {
    return null;
  }
}

/** Writes the bytes into the cache and records where they went. The path is confined to the root before the write, not after. */
export function writeCached(db: Db, root: string, put: CachePut): CachedAttachment {
  const dir = resolveInRoot(root, messageCacheDir(root, put.accountId, put.messageId));
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const wanted = safeFilename(put.filename);
  // A message with two parts called "scan.pdf" gets scan.pdf and scan-1.pdf.
  // The existing file for this very part is not a collision: it is being replaced.
  const mine = getAttachmentFile(db, put.accountId, put.messageId, put.attachmentKey);
  const mineName = mine ? mine.filename : null;
  const filename = uniqueFilename(wanted, (candidate) => candidate !== mineName && fs.existsSync(path.join(dir, candidate)));
  const full = resolveInRoot(root, path.join(dir, filename));
  const temp = `${full}.part`;
  fs.writeFileSync(temp, put.bytes, { mode: FILE_MODE });
  fs.renameSync(temp, full);
  // rename keeps the temp file's mode, but an existing file it replaced could
  // have had another; state it rather than assume it.
  fs.chmodSync(full, FILE_MODE);
  recordAttachmentFile(db, {
    accountId: put.accountId,
    messageId: put.messageId,
    attachmentKey: put.attachmentKey,
    filename,
    mimeType: put.mimeType,
    bytes: put.bytes.length,
    path: full,
  });
  return { path: full, filename, mimeType: put.mimeType, bytes: put.bytes.length };
}

/**
 * Unlinks paths handed back by drainOrphanAttachments, skipping anything that
 * does not resolve inside the root. A path that escaped is a bug or a tampered
 * store, and either way the answer is to leave the file alone.
 */
export function unlinkOrphans(root: string, paths: string[]): { removed: number; refused: number } {
  let removed = 0;
  let refused = 0;
  for (const p of paths) {
    let full: string;
    try {
      full = resolveInRoot(root, p);
    } catch {
      refused += 1;
      continue;
    }
    try {
      fs.rmSync(full, { force: true });
      removed += 1;
      pruneEmpty(root, path.dirname(full));
    } catch {
      // A file already gone, or one the disk will not give up right now. The
      // row is drained either way; a leftover file is not worth a retry loop.
    }
  }
  return { removed, refused };
}

/** Removes the message and account folders once the last file in them has gone. Never climbs past the root. */
function pruneEmpty(root: string, dir: string): void {
  let at = dir;
  for (let depth = 0; depth < 2; depth++) {
    if (path.resolve(at) === path.resolve(root)) return;
    try {
      if (fs.readdirSync(at).length > 0) return;
      fs.rmdirSync(at);
    } catch {
      return;
    }
    at = path.dirname(at);
  }
}

/**
 * A name nothing in dir has yet, for a copy into Downloads or a Save as
 * default. The name is sanitised first: the file is leaving our folder for a
 * folder of the person's own, which is exactly where a traversal would hurt.
 */
export function nonClobberingPath(dir: string, filename: string): string {
  const safe = safeFilename(filename);
  const name = uniqueFilename(safe, (candidate) => fs.existsSync(path.join(dir, candidate)));
  return path.join(dir, name);
}

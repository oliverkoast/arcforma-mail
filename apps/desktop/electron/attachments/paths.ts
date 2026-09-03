// Where attachment bytes are allowed to land, and what they are allowed to be
// called. Pure functions with no filesystem in them, so node:test can drive
// every hostile name without a temp folder.
//
// The threat this file exists for: a filename is attacker-controlled text. It
// arrives in a MIME header written by whoever sent the mail, it is copied
// through Gmail unchanged, and it reaches this app as an ordinary string. A
// name like "../../../../Library/LaunchAgents/x.plist", "/etc/hosts", or
// "invoice.pdf‮gnp.exe" is a perfectly legal MIME filename. So no name off
// the network is ever used as a path: it is rebuilt from a small allowed set of
// characters, and the finished path is resolved and checked against the
// attachments root before anything opens it.

import path from "node:path";

/** Long enough for a real invoice name, short enough that name plus suffix plus extension stays inside any filesystem limit. */
export const MAX_FILENAME = 120;
/** What a nameless part is called. */
export const FALLBACK_FILENAME = "attachment";

// Every code point that is not one of these is dropped. Letters and digits from
// any script are kept, so a Japanese or Cyrillic filename survives; separators,
// control characters, quotes, wildcards, and the bidi overrides that let a name
// lie about its extension do not.
const KEEP = /[^\p{L}\p{N}._ ()\[\]+@,'&#%!$^~=-]/gu;

/**
 * A filename that is safe to join onto a directory. Never returns an empty
 * string, a name with a separator in it, a name starting with a dot, or a name
 * that is only dots.
 */
export function safeFilename(raw: unknown, fallback = FALLBACK_FILENAME): string {
  const text = typeof raw === "string" ? raw : "";
  // Decompose first so a combining sequence cannot be used to smuggle a
  // separator past the filter once the filesystem recomposes it.
  let name = text.normalize("NFC").replace(KEEP, "");
  // Path separators are already gone with KEEP; this catches the whole-name
  // cases that survive as pure dots: ".", "..", "...".
  name = name.replace(/\s+/g, " ").trim();
  // A leading dot hides the file from Finder and from ls, and ".." is a
  // traversal step; neither is ever what a mail attachment wanted to be called.
  name = name.replace(/^[.\s]+/, "");
  // Trailing dots and spaces are silently dropped by some filesystems, so two
  // different names could land on one file. Drop them here instead.
  name = name.replace(/[.\s]+$/, "");
  if (!name) return safeFallback(fallback);
  if (name.length <= MAX_FILENAME) return name;
  // Over the cap the extension is what has to survive, so the stem is cut and
  // the extension kept: a truncated name must not become extensionless.
  const ext = extensionOf(name);
  const stem = name.slice(0, Math.max(1, MAX_FILENAME - ext.length)).replace(/[.\s]+$/, "");
  return `${stem || safeFallback(fallback)}${ext}`;
}

function safeFallback(fallback: string): string {
  const cleaned = fallback.normalize("NFC").replace(KEEP, "").replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned || FALLBACK_FILENAME;
}

/** The trailing extension including its dot, capped so a name ending in a long word is not read as one. */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0 || at === name.length - 1) return "";
  const ext = name.slice(at);
  return ext.length <= 12 ? ext : "";
}

/**
 * One path segment for an id (an account id, a Gmail message id). These are
 * ours or Gmail's rather than a sender's, but they still become directory
 * names, so they go through the same door.
 */
export function safeSegment(raw: unknown, fallback = "unknown"): string {
  const text = typeof raw === "string" ? raw : "";
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, "").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80);
  return cleaned || fallback;
}

/** The root every cached attachment lives under. Nothing this feature writes or reads may sit outside it. */
export function attachmentsRoot(userDataDir: string): string {
  return path.join(userDataDir, "attachments");
}

/** One message's folder inside the root: <root>/<account>/<message>. */
export function messageCacheDir(root: string, accountId: string, messageId: string): string {
  return path.join(root, safeSegment(accountId, "account"), safeSegment(messageId, "message"));
}

/**
 * Resolves a path and refuses it if it does not sit inside root. This is the
 * last gate before any read, write, or unlink: the sanitiser above is what
 * should make an escape impossible, and this is what makes it impossible if the
 * sanitiser is ever wrong. A path equal to the root itself is refused too, since
 * the root is a directory and never a file to open.
 */
export function resolveInRoot(root: string, candidate: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, candidate);
  if (full === base || !full.startsWith(base + path.sep)) {
    throw new Error("That attachment path is outside the attachments folder, so it was not opened.");
  }
  return full;
}

/** True when the path sits inside root. The question form of resolveInRoot, for a sweep that skips rather than throws. */
export function isInRoot(root: string, candidate: string): boolean {
  try {
    resolveInRoot(root, candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * A name nothing in the folder already has. "report.pdf" becomes "report-1.pdf",
 * then "report-2.pdf". The suffix goes before the extension so the file still
 * opens as what it is.
 */
export function uniqueFilename(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

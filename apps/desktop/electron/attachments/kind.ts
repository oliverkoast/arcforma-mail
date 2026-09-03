// What the preview window does with a file. Four answers and no fifth: an
// image, a PDF, plain text, or a card saying this type is not previewed here.
//
// Nothing outside this list is ever rendered, and nothing on it is ever
// executed. Text types are shown as text in the app's own type; they are never
// parsed as HTML, never put in an iframe, and never handed to a shell. HTML,
// scripts, archives, and executables all land on "none" on purpose: an mail
// attachment is the last thing that should be able to run.

export type PreviewKind = "image" | "pdf" | "text" | "none";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json", "text/json"]);
const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log"]);

const PDF_EXT = new Set([".pdf"]);

/** The mime type without its parameters, lowercased. "text/plain; charset=UTF-8" is text/plain. */
export function baseMime(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
}

function extensionOf(filename: string): string {
  const at = filename.lastIndexOf(".");
  return at > 0 ? filename.slice(at).toLowerCase() : "";
}

/**
 * The declared type decides. The extension is only consulted when the type is
 * missing or the generic application/octet-stream that senders use for
 * everything, and it can only ever move a file onto this list, never off it: a
 * part declared text/html stays "none" whatever it is called.
 */
export function previewKind(mimeType: string | null | undefined, filename = ""): PreviewKind {
  const mime = baseMime(mimeType);
  if (IMAGE_TYPES.has(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (TEXT_TYPES.has(mime)) return "text";
  if (mime && mime !== "application/octet-stream" && mime !== "binary/octet-stream") return "none";
  const ext = extensionOf(filename);
  if (IMAGE_EXT.has(ext)) return "image";
  if (PDF_EXT.has(ext)) return "pdf";
  if (TEXT_EXT.has(ext)) return "text";
  return "none";
}

/**
 * The Content-Type the cached bytes are served with. An image or a PDF is
 * served as itself so Chromium renders it; everything else is served as a
 * download of unknowable bytes, because a type the browser recognises is a type
 * it might try to run. Paired with X-Content-Type-Options: nosniff at the
 * response, so the browser cannot decide otherwise on its own.
 */
export function serveType(mimeType: string | null | undefined, filename = ""): string {
  switch (previewKind(mimeType, filename)) {
    case "image":
      return baseMime(mimeType) || guessImageType(filename);
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function guessImageType(filename: string): string {
  const ext = extensionOf(filename);
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

/** The window a preview of this kind opens at, in points. Fitted to the content afterwards. */
export function previewWindowSize(kind: PreviewKind): { width: number; height: number } {
  switch (kind) {
    case "pdf":
      return { width: 900, height: 1000 };
    case "image":
      return { width: 860, height: 760 };
    case "text":
      return { width: 820, height: 720 };
    default:
      return { width: 560, height: 320 };
  }
}

/** The most text the preview reads into the window. Past this it says so rather than freezing on a log file. */
export const MAX_TEXT_PREVIEW = 2_000_000;

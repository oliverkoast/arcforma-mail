// MIME helpers for Gmail API payloads. Ported from multi-email-mcp
// gmail-api.js (decodeBody, findBody, listAttachments) and extended to walk
// nested multipart/alternative parts and honour part charsets.

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
  raw?: string;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessage[];
}

export interface Attachment {
  partId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
  contentId: string | null;
  inline: boolean;
  /**
   * base64url bytes Gmail put straight on the part. Only kept when the part
   * carries no attachmentId, which is the one case where there is nothing else
   * to fetch the bytes with; otherwise the id is the source and the data would
   * only bloat the store.
   */
  data?: string | null;
}

export interface Address {
  email: string;
  name: string;
}

export function decodeBodyBytes(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Decodes base64url body data using the part's charset when it is not UTF-8. */
export function decodeBody(data: string, charset = "utf-8"): string {
  const bytes = decodeBodyBytes(data);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

export function header(source: GmailHeader[] | GmailPart | GmailMessage | undefined, name: string): string {
  const headers = Array.isArray(source) ? source : (source as GmailMessage)?.payload?.headers ?? (source as GmailPart)?.headers ?? [];
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

export function headersToMap(headers: GmailHeader[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers ?? []) map[h.name.toLowerCase()] = h.value;
  return map;
}

export function charsetOf(part: GmailPart): string {
  const ct = header(part.headers, "Content-Type");
  const m = /charset="?([^";\s]+)"?/i.exec(ct);
  return (m?.[1] ?? "utf-8").toLowerCase();
}

/** Depth-first search for the first part with the given mime type that carries data. */
export function findPart(payload: GmailPart | undefined, mime: string): GmailPart | null {
  if (!payload) return null;
  if ((payload.mimeType ?? "").toLowerCase() === mime && payload.body?.data) return payload;
  for (const part of payload.parts ?? []) {
    const hit = findPart(part, mime);
    if (hit) return hit;
  }
  return null;
}

export interface Body {
  html: string | null;
  text: string | null;
}

/** Prefers text/html, then text/plain. Attachments with those types are skipped. */
export function findBody(payload: GmailPart | undefined): Body {
  const htmlPart = findRenderable(payload, "text/html");
  const textPart = findRenderable(payload, "text/plain");
  return {
    html: htmlPart?.body?.data ? decodeBody(htmlPart.body.data, charsetOf(htmlPart)) : null,
    text: textPart?.body?.data ? decodeBody(textPart.body.data, charsetOf(textPart)) : null,
  };
}

function findRenderable(payload: GmailPart | undefined, mime: string): GmailPart | null {
  if (!payload) return null;
  const isAttachment = Boolean(payload.filename) && Boolean(payload.body?.attachmentId);
  if ((payload.mimeType ?? "").toLowerCase() === mime && payload.body?.data && !isAttachment) return payload;
  for (const part of payload.parts ?? []) {
    const hit = findRenderable(part, mime);
    if (hit) return hit;
  }
  return null;
}

/**
 * Whether a part is part of the message's own layout rather than a file attached to it.
 *
 * A Content-ID alone does not mean inline, and assuming it did hid real attachments. Anything
 * composed in Gmail gets a Content-ID stamped on every attachment, so a CV sent from Gmail arrived
 * carrying one and was filtered out of the chips, the paperclip and the With attachments view. The
 * file was in the database the whole time and simply never rendered.
 *
 * The reliable signals, in order:
 *
 *   Content-Disposition: attachment is explicit and settles it, whatever else the part carries.
 *   Content-Disposition: inline is the other explicit answer.
 *   Otherwise a Content-ID counts only when the HTML actually points at it with cid:, which is what
 *   being part of the layout means.
 */
function isInline(disposition: string, cid: string, html: string | null): boolean {
  const d = disposition.trimStart();
  if (d.startsWith("attachment")) return false;
  if (d.startsWith("inline")) return true;
  if (!cid) return false;
  return html !== null && html.includes(`cid:${cid}`);
}

/**
 * @param html the message's HTML, when it is known. Without it a Content-ID cannot be checked for a
 *   reference, and the safe answer is that the part is a real attachment: showing a layout image as
 *   a file is untidy, hiding someone's CV is not.
 */
export function listAttachments(payload: GmailPart | undefined, out: Attachment[] = [], html: string | null = null): Attachment[] {
  if (!payload) return out;
  if (payload.filename && (payload.body?.attachmentId || payload.body?.data)) {
    const disposition = header(payload.headers, "Content-Disposition").toLowerCase();
    const cid = header(payload.headers, "Content-ID").replace(/^<|>$/g, "");
    const attachmentId = payload.body?.attachmentId ?? null;
    out.push({
      partId: payload.partId ?? null,
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      size: payload.body?.size ?? 0,
      attachmentId,
      contentId: cid || null,
      inline: isInline(disposition, cid, html),
      // Without an attachmentId this data is the only copy of the bytes.
      data: attachmentId ? null : payload.body?.data ?? null,
    });
  }
  for (const part of payload.parts ?? []) listAttachments(part, out, html);
  return out;
}

export function hasCalendarPart(payload: GmailPart | undefined): boolean {
  if (!payload) return false;
  const mime = (payload.mimeType ?? "").toLowerCase();
  if (mime === "text/calendar" || mime === "application/ics" || /\.ics$/i.test(payload.filename ?? "")) return true;
  return (payload.parts ?? []).some(hasCalendarPart);
}

const ADDR_RE = /(?:"?([^"<]*)"?\s*)?<([^>]+)>|([^\s,<>]+@[^\s,<>]+)/g;

export function parseAddressList(value: string): Address[] {
  const out: Address[] = [];
  if (!value) return out;
  for (const m of value.matchAll(ADDR_RE)) {
    const email = (m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (!email) continue;
    out.push({ email, name: (m[1] ?? "").trim().replace(/^"|"$/g, "") });
  }
  return out;
}

export function formatAddress(a: Address): string {
  return a.name ? `"${a.name.replace(/"/g, "'")}" <${a.email}>` : a.email;
}

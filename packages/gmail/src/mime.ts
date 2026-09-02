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

export function listAttachments(payload: GmailPart | undefined, out: Attachment[] = []): Attachment[] {
  if (!payload) return out;
  if (payload.filename && (payload.body?.attachmentId || payload.body?.data)) {
    const disposition = header(payload.headers, "Content-Disposition").toLowerCase();
    const cid = header(payload.headers, "Content-ID").replace(/^<|>$/g, "");
    out.push({
      partId: payload.partId ?? null,
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      size: payload.body?.size ?? 0,
      attachmentId: payload.body?.attachmentId ?? null,
      contentId: cid || null,
      inline: disposition.startsWith("inline") || Boolean(cid),
    });
  }
  for (const part of payload.parts ?? []) listAttachments(part, out);
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

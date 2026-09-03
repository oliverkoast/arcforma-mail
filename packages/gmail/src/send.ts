// Builds RFC 822 messages with nodemailer's MailComposer (build only, no
// transport) and sends them raw. The account's Gmail signature is appended
// to every outgoing message here, so no composer has to remember it.

import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { GmailClient } from "./client.js";
import { formatAddress, type Address } from "./mime.js";

export interface ComposeInput {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  html?: string | null;
  text?: string | null;
  /** Quoted history for a reply or forward. Rendered after the signature, the way Gmail does. */
  quotedHtml?: string | null;
  inReplyTo?: string | null;
  references?: string[] | string | null;
  signatureHtml?: string | null;
  /**
   * A read receipt's 1x1 image, appended as the very last element of the HTML
   * part and never written into the plain text part. Absent unless the sender
   * armed a receipt for this one message. See packages/pixel-service.
   */
  trackingPixelHtml?: string | null;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string; cid?: string }>;
  messageId?: string;
  date?: Date;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function appendSignature(html: string, signatureHtml: string | null | undefined): string {
  if (!signatureHtml) return html;
  return `${html}<br><br><div class="gmail_signature" data-smartmail="gmail_signature">${signatureHtml}</div>`;
}

export function appendQuote(html: string, quotedHtml: string | null | undefined): string {
  if (!quotedHtml || !quotedHtml.trim()) return html;
  return `${html}<br><div class="gmail_quote">${quotedHtml}</div>`;
}

/**
 * The read receipt image, last of everything. It goes into the HTML part only:
 * a plain text reader has no way to fetch it, and putting a URL there would
 * show the recipient a tracker rather than hide one.
 */
export function appendPixel(html: string, pixelHtml: string | null | undefined): string {
  if (!pixelHtml) return html;
  return `${html}${pixelHtml}`;
}

export interface BuiltMessage {
  /** base64url for messages.send. */
  raw: string;
  /** The RFC 822 text, for the send queue and for tests. */
  mime: string;
}

export async function buildRawMessage(input: ComposeInput): Promise<BuiltMessage> {
  if (input.attachments && input.attachments.length > 0) {
    throw new Error("Attachments are not supported yet. Send this one from Gmail.");
  }
  const bodyHtml = input.html ?? (input.text ? `<div>${input.text.replace(/\n/g, "<br>")}</div>` : "");
  // Body, then signature, then the quoted history: signature once, above the quote.
  // A read receipt's image, when one is armed, goes after all of it.
  const html = appendPixel(appendQuote(appendSignature(bodyHtml, input.signatureHtml), input.quotedHtml), input.trackingPixelHtml);
  const bodyText = input.text ?? htmlToText(bodyHtml);
  // The text part is built from the body, signature, and quote only: the pixel is never in it.
  const textParts = [bodyText];
  if (input.signatureHtml) textParts.push(htmlToText(input.signatureHtml));
  if (input.quotedHtml && input.quotedHtml.trim()) textParts.push(htmlToText(input.quotedHtml));
  const text = textParts.filter(Boolean).join("\n\n");
  const references = Array.isArray(input.references) ? input.references.join(" ") : input.references ?? undefined;
  const composer = new MailComposer({
    from: formatAddress(input.from),
    to: input.to.map(formatAddress).join(", "),
    cc: input.cc?.length ? input.cc.map(formatAddress).join(", ") : undefined,
    bcc: input.bcc?.length ? input.bcc.map(formatAddress).join(", ") : undefined,
    subject: input.subject,
    html,
    text,
    inReplyTo: input.inReplyTo ?? undefined,
    references,
    messageId: input.messageId,
    date: input.date,
    textEncoding: "quoted-printable",
  });
  const buffer = await composer.compile().build();
  return { raw: buffer.toString("base64url"), mime: buffer.toString("utf8") };
}

export interface SentMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
}

export async function sendRaw(client: GmailClient, raw: string, threadId?: string | null): Promise<SentMessage> {
  const body: Record<string, string> = { raw };
  if (threadId) body["threadId"] = threadId;
  return client.request<SentMessage>("messages/send", { method: "POST", body, cost: 100 });
}

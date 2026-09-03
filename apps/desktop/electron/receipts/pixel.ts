// The token and the image tag a read receipt puts in one outgoing message.
//
// What this is, plainly: an image hosted on a service the sender deployed. If
// the recipient's mail client fetches it, the service learns that something
// asked for the image. It does not learn that a person read the message, and
// no fetch does not mean the message went unread, because images are widely
// blocked. packages/pixel-service says the same thing at more length, and
// docs/adr/0003-read-receipts-reverse-an-earlier-decision.md says why the
// feature exists at all.

import { randomBytes } from "node:crypto";

/** 32 hex characters, which is what the pixel route matches and nothing else. */
export const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

/** 128 bits of randomness written as 32 hex characters. Guessing one buys nothing, but a collision would cross two messages' signals. */
export function newReceiptToken(): string {
  return randomBytes(16).toString("hex");
}

/** Trailing slashes off, so joining a path never doubles one. */
export function normaliseServiceUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The image URL for a token on a given service. */
export function pixelUrl(serviceUrl: string, token: string): string {
  return `${normaliseServiceUrl(serviceUrl)}/p/${token}.gif`;
}

/**
 * The tag itself. One pixel, hidden, no alt text to read out: a screen reader
 * announcing "tracking pixel" would be honest but the recipient cannot act on
 * it either way, and an empty alt keeps it out of the reading order.
 */
export function pixelImg(serviceUrl: string, token: string): string {
  return `<img src="${pixelUrl(serviceUrl, token)}" width="1" height="1" alt="" style="display:none">`;
}

import type { Address } from "../shared/types.js";

/** What a mailto: link asks for, in the shape a compose can start from. */
export interface MailtoRequest {
  to: Address[];
  subject: string;
  bodyHtml: string;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, "%20"));
  } catch {
    return s;
  }
};
const addresses = (s: string): Address[] =>
  s
    .split(",")
    .map((a) => decode(a).trim())
    .filter((a) => a.includes("@"))
    .map((email) => ({ email, name: "" }));

/**
 * Parses a mailto: link the way a mail client is expected to: addresses before the "?",
 * then subject, body, cc and bcc as query fields, percent-decoded. Anything that is not a
 * mailto: link, or names nobody, is null. A body arrives as plain text and is escaped into
 * paragraphs, so a link can never inject markup into a message.
 */
export function parseMailto(url: string): MailtoRequest | null {
  const m = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(url.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[2] ?? "");
  const to = [...addresses(m[1] ?? ""), ...addresses(params.get("to") ?? "")];
  if (to.length === 0) return null;
  const subject = (params.get("subject") ?? "").trim();
  const body = (params.get("body") ?? "").replace(/\r\n?/g, "\n").trim();
  const bodyHtml = body ? body.split("\n").map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`).join("") : "";
  return { to, subject, bodyHtml };
}

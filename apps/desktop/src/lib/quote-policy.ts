// What a reply's quoted history is allowed to contain.
//
// The reading pane renders a message body inside a sandboxed frame with a content security policy
// and a per-sender setting for remote images. The compose editor does not: it renders the quoted
// history directly in the app. Anything there that fetches a URL fires the moment Reply is pressed,
// which tells the sender both that the mail was read and that a reply is being written, and the
// per-sender setting has no way to express that. So nothing that loads is allowed here at all.
//
// Kept free of any browser import so it can be tested. See docs/adr and the audit finding that
// found tracking pixels firing on Reply.

export const QUOTE_FORBID_TAGS = [
  "style", "script", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base",
  "img", "picture", "source", "video", "audio", "svg", "canvas", "track",
];

export const QUOTE_FORBID_ATTR = ["srcset", "background", "poster", "formaction", "ping", "style"];

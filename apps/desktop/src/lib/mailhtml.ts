// Pure pieces of the mail HTML renderer, so node:test can cover them without a
// DOM: the per-message CSP, the CSS scrubber, the size cap, and the DOMPurify
// configuration plus hooks that harden links. MessageBody.tsx wires them to a
// DOMPurify instance and a sandboxed iframe.

/** Above this many characters of HTML the message renders as text; a runaway newsletter must not freeze the renderer. */
export const MAX_HTML_CHARS = 800_000;

/** The iframe's own CSP. It sits on top of the app policy, so it can only tighten. */
export function buildMessageCsp(loadImages: boolean): string {
  const img = loadImages ? "https: data: cid:" : "data: cid:";
  return [
    "default-src 'none'",
    `img-src ${img}`,
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const CSS_URL = /url\s*\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi;
const CSS_IMPORT = /@import\b[^;]*;?/gi;
// The whole declaration goes, so nested parentheses in expression(alert(1)) cannot leave a tail behind.
const CSS_EXPRESSION = /[^;{}]*expression\s*\([^;{}]*/gi;
const CSS_BEHAVIOR = /(?:-moz-)?binding\s*:[^;]*;?|behavior\s*:[^;]*;?/gi;

/** Removes every remote or scriptable hook from a style value: url(), @import, expression(), behavior. */
export function scrubCss(css: string): string {
  return css.replace(CSS_IMPORT, "").replace(CSS_URL, "none").replace(CSS_EXPRESSION, "").replace(CSS_BEHAVIOR, "");
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/** True for the only link schemes a mail body may keep. Everything else is dropped, including javascript:, data:, and file:. */
export function isSafeHref(href: string): boolean {
  return SAFE_HREF.test(href.trim());
}

export function tooLarge(html: string): boolean {
  return html.length > MAX_HTML_CHARS;
}

const REMOTE_IMG = /<img[^>]+src\s*=\s*["']?\s*https?:/i;
const REMOTE_CSS = /url\s*\(\s*["']?\s*https?:/i;

/** Whether the raw HTML would fetch anything remote once images are allowed. */
export function hasRemoteImages(html: string): boolean {
  return REMOTE_IMG.test(html) || REMOTE_CSS.test(html);
}

export interface PurifyConfig {
  USE_PROFILES: { html: boolean };
  FORBID_TAGS: string[];
  FORBID_ATTR: string[];
  ADD_ATTR: string[];
  ALLOW_DATA_ATTR: boolean;
  WHOLE_DOCUMENT: boolean;
}

export const PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "textarea", "select", "option", "link", "meta", "base", "video", "audio", "source", "track", "svg", "math", "template", "slot", "portal", "noscript"],
  FORBID_ATTR: ["srcset", "ping", "formaction", "action", "background", "poster", "xlink:href", "autofocus", "tabindex"],
  ADD_ATTR: ["target"],
  ALLOW_DATA_ATTR: false,
  WHOLE_DOCUMENT: false,
};

/** Minimal shape of an element the hooks touch, so the hooks type-check without lib.dom in node tests. */
export interface HookNode {
  nodeName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  textContent: string | null;
}

/**
 * Runs after DOMPurify has sanitized a node's attributes. Links open in a
 * new window (the app denies the window and hands http(s) to the browser),
 * carry rel=noopener, and keep only http(s) or mailto hrefs. Inline styles
 * lose url() and @import so nothing is fetched before the images toggle.
 */
export function hardenNode(node: HookNode): void {
  const name = node.nodeName.toLowerCase();
  if (name === "a" || name === "area") {
    const href = node.getAttribute("href");
    if (href !== null && !isSafeHref(href)) node.removeAttribute("href");
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
  if (node.hasAttribute("style")) {
    const style = node.getAttribute("style") ?? "";
    const clean = scrubCss(style);
    if (clean !== style) node.setAttribute("style", clean);
  }
  if (name === "style" && node.textContent) {
    const clean = scrubCss(node.textContent);
    if (clean !== node.textContent) node.textContent = clean;
  }
}

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

// ---- Reading aids: quoted history, security banners, signatures ----
//
// Everything below runs on the DOM of a body DOMPurify has already cleaned.
// It only removes elements, moves them into a details element, and adds
// classes, so it cannot widen what the sanitizer allowed. The node interfaces
// are the small slice of the DOM the pass touches: MessageBody casts real
// nodes to them, and the tests drive them through the parser in minidom.ts.

export interface MailNode {
  readonly nodeType: number;
  readonly nodeName: string;
  textContent: string | null;
  readonly childNodes: ArrayLike<MailNode>;
  readonly parentNode: MailNode | null;
  remove(): void;
}

export interface MailElement extends MailNode {
  className: string;
  id: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  appendChild(node: MailNode): MailNode;
  insertBefore(node: MailNode, ref: MailNode | null): MailNode;
}

export interface MailDocument {
  readonly body: MailElement;
  createElement(tag: string): MailElement;
}

const ELEMENT = 1;
const TEXT = 3;

/** "On <date>, <name> wrote:" and its French and German forms, as a whole line. */
const ATTRIBUTION_LINE = /^(?:On .{5,200}wrote:|Le .{5,200}a écrit\s*:|Am .{5,200}schrieb .{0,200}:)\s*$/;
/** Outlook's separators: the Original Message banner and the line of underscores. */
const ORIGINAL_SEPARATOR = /^(?:-{2,}\s*(?:Original|Forwarded) Message\s*-{2,}|-{2,}\s*Ursprüngliche Nachricht\s*-{2,}|_{10,})\s*$/i;
/** Gateway banners stamped on mail from outside the organisation. */
const BANNER = /^\s*(?:caution|warning|external(?: email)?|attention)\s*[:!]?\s*(?:this (?:email|e-mail|message) (?:originated|was sent|came) from outside|this is an external email|external sender)/i;
const BRACKET_PREFIX = /^\s*\[(?:EXTERNAL|EXT)\]\s*:?\s*/i;
const SIGNATURE_LINE = /^-- ?$/;
const QUOTED_LINE = /^\s*>/;
/** A banner block longer than this is holding the message too, so it stays. */
const BANNER_MAX_CHARS = 600;
/** How many leading top-level blocks a banner may sit in. */
const BANNER_WINDOW = 3;
/** A repeated segment shorter than this is a sign-off, not history. */
const REPEAT_MIN_SEGMENT_CHARS = 20;
const REPEAT_MIN_PARAGRAPHS = 2;
const REPEAT_MIN_CHARS = 40;

export const SHOW_QUOTED = "Show quoted text";
export const HIDE_QUOTED = "Hide quoted text";

export function isAttributionLine(line: string): boolean {
  return ATTRIBUTION_LINE.test(line.trim());
}

export function isOriginalSeparator(line: string): boolean {
  return ORIGINAL_SEPARATOR.test(line.trim());
}

/** From:, then Sent: or Date:, To:, and Subject: within the next few lines, the way Outlook pastes a reply header. */
export function isOutlookHeader(lines: string[]): boolean {
  const head = lines.map((l) => l.trim()).filter(Boolean).slice(0, 6);
  if (!head[0] || !/^From:/i.test(head[0])) return false;
  const rest = head.slice(1).join("\n");
  return /^(?:Sent|Date):/im.test(rest) && /^To:/im.test(rest) && /^Subject:/im.test(rest);
}

export function isBannerText(text: string): boolean {
  return BANNER.test(text.replace(/\s+/g, " "));
}

/** The rest of a gateway banner after its opening line: the advice, not the message. */
const BANNER_ADVICE =
  /^(?:do not (?:click|open|reply)|unless you (?:recognize|recognise|know)|please (?:verify|report|exercise)|verify the sender|report (?:it|this|any)|be (?:careful|cautious)|think before you click|this message came from|if you (?:are not|did not|do not))/i;

/**
 * A preview line with the gateway banner taken off the front.
 *
 * Gmail builds its snippet from the first text in the body, so on any organisation that stamps
 * "CAUTION: This email originated from outside..." every row in the list previews the warning
 * instead of the message. The warning is identical on every one of them, so the column carries no
 * information at all: the reader learns nothing about any thread from a line that is the same on all
 * of them. Stripping it is what makes the preview column worth its width.
 *
 * Only the opening banner sentence and the advice that follows it come off, capped at
 * BANNER_MAX_CHARS, and a snippet that turns out to be nothing but banner is returned untouched:
 * showing the warning beats showing an empty row.
 */
export function stripBannerPrefix(snippet: string): string {
  const flat = snippet.replace(/\s+/g, " ").trim();
  const withoutBracket = flat.replace(BRACKET_PREFIX, "").trim();
  if (!isBannerText(withoutBracket)) return withoutBracket;

  const sentences = withoutBracket.split(/(?<=[.!?])\s+/);
  let drop = 0;
  let dropped = 0;
  while (drop < sentences.length) {
    const sentence = sentences[drop] ?? "";
    const first = drop === 0;
    if (!first && !BANNER_ADVICE.test(sentence)) break;
    if (dropped + sentence.length > BANNER_MAX_CHARS) break;
    dropped += sentence.length + 1;
    drop += 1;
  }
  const rest = sentences.slice(drop).join(" ").trim();
  return rest || withoutBracket;
}

const LINE_BREAK_TAGS = new Set(["p", "div", "li", "tr", "table", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "td", "th", "section", "article", "header", "footer", "dd", "dt", "hr", "address", "center"]);
const WRAPPER_TAGS = new Set(["div", "span", "font", "center", "table", "tbody", "tr", "td", "section", "article", "body"]);
const SKIPPED_TAGS = new Set(["style", "script", "head", "title"]);

function isElement(n: MailNode): n is MailElement {
  return n.nodeType === ELEMENT;
}

function tagOf(n: MailNode): string {
  return n.nodeName.toLowerCase();
}

function kids(n: MailNode): MailNode[] {
  return Array.from(n.childNodes);
}

function classSet(el: MailElement): Set<string> {
  return new Set((el.className ?? "").split(/\s+/).filter(Boolean));
}

function addClass(el: MailElement, name: string): void {
  const set = classSet(el);
  if (set.has(name)) return;
  set.add(name);
  el.className = Array.from(set).join(" ");
}

/** The node's text with a newline wherever a br or a block boundary breaks the line. */
export function lineText(node: MailNode): string {
  const parts: string[] = [];
  const walk = (n: MailNode): void => {
    if (n.nodeType === TEXT) {
      parts.push((n.textContent ?? "").replace(/\u00a0/g, " "));
      return;
    }
    if (!isElement(n)) return;
    const t = tagOf(n);
    if (SKIPPED_TAGS.has(t)) return;
    if (t === "br") {
      parts.push("\n");
      return;
    }
    const block = LINE_BREAK_TAGS.has(t);
    if (block) parts.push("\n");
    for (const k of kids(n)) walk(k);
    if (block) parts.push("\n");
  };
  walk(node);
  return parts.join("").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function linesOf(node: MailNode): string[] {
  return lineText(node).split("\n").map((s) => s.trim()).filter(Boolean);
}

function flatText(node: MailNode): string {
  return lineText(node).replace(/\s+/g, " ").trim();
}

function isBlank(n: MailNode): boolean {
  if (n.nodeType === TEXT) return (n.textContent ?? "").trim() === "";
  return !isElement(n);
}

/** Child nodes that carry content or structure: elements and non-blank text. Comments and whitespace are dropped. */
function blocksOf(el: MailNode): MailNode[] {
  return kids(el).filter((k) => !isBlank(k));
}

function containsImage(n: MailNode): boolean {
  if (!isElement(n)) return false;
  if (tagOf(n) === "img") return true;
  return kids(n).some(containsImage);
}

function hasVisibleContent(nodes: MailNode[]): boolean {
  return nodes.some((n) => flatText(n) !== "" || containsImage(n));
}

/** Walks down through single-child wrappers (Gmail's div dir=ltr, Outlook's WordSection1, a layout table) to where the message's own blocks sit. */
function contentRoot(body: MailElement): MailElement {
  let el = body;
  for (;;) {
    const ks = kids(el).filter((k) => !isBlank(k) && !(isElement(k) && (tagOf(k) === "br" || SKIPPED_TAGS.has(tagOf(k)))));
    const only = ks.length === 1 ? ks[0] : undefined;
    if (!only || !isElement(only) || !WRAPPER_TAGS.has(tagOf(only)) || classSet(only).has("gmail_quote")) return el;
    el = only;
  }
}

function previousContent(blocks: MailNode[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    const b = blocks[j]!;
    if (isElement(b) && tagOf(b) === "br") continue;
    return j;
  }
  return -1;
}

function nextContent(blocks: MailNode[], i: number): number {
  for (let j = i + 1; j < blocks.length; j++) {
    const b = blocks[j]!;
    if (isElement(b) && tagOf(b) === "br") continue;
    return j;
  }
  return -1;
}

/** Gmail's quote container or blockquote, Apple Mail's cite blockquote, Yahoo's quoted div; the element itself or its single-child wrapper. */
function isQuoteContainer(el: MailElement): boolean {
  let cur = el;
  for (;;) {
    const cls = classSet(cur);
    if (cls.has("gmail_quote") || cls.has("gmail_quote_container") || cls.has("yahoo_quoted")) return true;
    if (tagOf(cur) === "blockquote" && (cur.getAttribute("type") ?? "").toLowerCase() === "cite") return true;
    const ks = kids(cur).filter((k) => !isBlank(k) && !(isElement(k) && tagOf(k) === "br"));
    const only = ks.length === 1 ? ks[0] : undefined;
    if (!only || !isElement(only)) return false;
    cur = only;
  }
}

function isAttributionBlock(n: MailNode): boolean {
  return isAttributionLine(flatText(n));
}

/** Index of the first top-level block that starts quoted history, or -1. */
function quoteStartIndex(blocks: MailNode[]): number {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (isElement(b)) {
      const t = tagOf(b);
      if (t === "br") continue;
      if (isQuoteContainer(b)) {
        const j = previousContent(blocks, i);
        return j >= 0 && isAttributionBlock(blocks[j]!) ? j : i;
      }
      if (t === "blockquote") {
        const j = previousContent(blocks, i);
        if (j >= 0 && isAttributionBlock(blocks[j]!)) return j;
        continue;
      }
      if (t === "hr") {
        const j = nextContent(blocks, i);
        if (j >= 0 && (isOutlookHeader(linesOf(blocks[j]!)) || isOriginalSeparator(linesOf(blocks[j]!)[0] ?? ""))) return i;
        continue;
      }
      const ls = linesOf(b);
      if (ls[0] && isOriginalSeparator(ls[0])) return i;
      if (isOutlookHeader(ls)) return i;
    } else if (b.nodeType === TEXT && isOriginalSeparator(b.textContent ?? "")) {
      return i;
    }
  }
  return -1;
}

/** Steps `at` back over the br elements right before it, so they fold too and no blank line sits above the toggle. */
function backOverBreaks(blocks: MailNode[], at: number): number {
  while (at > 0) {
    const prev = blocks[at - 1]!;
    if (!isElement(prev) || tagOf(prev) !== "br") break;
    at--;
  }
  return at;
}

function makeFold(doc: MailDocument): { details: MailElement; body: MailElement } {
  const details = doc.createElement("details");
  details.className = "quote-fold";
  const summary = doc.createElement("summary");
  const show = doc.createElement("span");
  show.className = "qf-show";
  show.textContent = SHOW_QUOTED;
  const hide = doc.createElement("span");
  hide.className = "qf-hide";
  hide.textContent = HIDE_QUOTED;
  summary.appendChild(show);
  summary.appendChild(hide);
  details.appendChild(summary);
  const body = doc.createElement("div");
  body.className = "quote-fold-body";
  details.appendChild(body);
  return { details, body };
}

function foldBody(details: MailElement): MailElement {
  const last = kids(details).filter(isElement).pop();
  if (!last) throw new Error("fold without a body");
  return last;
}

/** Moves every child of root from `from` to the end into the fold, creating the fold at `from`'s position when there is none yet. */
function foldFrom(doc: MailDocument, root: MailElement, from: MailNode, existing: MailElement | null): MailElement {
  const all = kids(root);
  const start = all.indexOf(from);
  const stop = existing ? all.indexOf(existing) : all.length;
  const moving = all.slice(start, stop);
  if (existing) {
    const body = foldBody(existing);
    const first = kids(body)[0] ?? null;
    for (const n of moving) body.insertBefore(n, first);
    return existing;
  }
  const { details, body } = makeFold(doc);
  root.insertBefore(details, from);
  for (const n of moving) body.appendChild(n);
  return details;
}

/** The smallest element within `el` whose text is the banner and little else, or null. */
function bannerElement(el: MailElement): MailElement | null {
  if (!isBannerText(flatText(el))) return null;
  const inner = kids(el).filter(isElement).map(bannerElement).find((x) => x !== null);
  if (inner) return inner;
  return flatText(el).length <= BANNER_MAX_CHARS ? el : null;
}

/** Removes external-sender banners from the first blocks and a [EXTERNAL] prefix from the first words. Returns how many banners went. */
function removeBanners(root: MailElement): number {
  let removed = 0;
  for (const b of blocksOf(root).slice(0, BANNER_WINDOW)) {
    if (!isElement(b)) {
      if (isBannerText(b.textContent ?? "") && (b.textContent ?? "").length <= BANNER_MAX_CHARS) {
        // A bare text banner: the line breaks after it go too, so the message does not start with blank lines.
        const all = kids(root);
        for (const n of all.slice(all.indexOf(b) + 1)) {
          if (isElement(n) ? tagOf(n) !== "br" : !isBlank(n)) break;
          n.remove();
        }
        b.remove();
        removed += 1;
      }
      continue;
    }
    let target = bannerElement(b);
    if (!target) continue;
    // Climb while the parent adds no text of its own, so the whole table or div around the sentence goes.
    while (target.parentNode && target.parentNode !== root && isElement(target.parentNode) && flatText(target.parentNode) === flatText(target)) target = target.parentNode;
    target.remove();
    removed += 1;
  }
  const first = firstTextNode(root);
  if (first && BRACKET_PREFIX.test(first.textContent ?? "")) first.textContent = (first.textContent ?? "").replace(BRACKET_PREFIX, "");
  return removed;
}

function firstTextNode(n: MailNode): MailNode | null {
  if (n.nodeType === TEXT) return (n.textContent ?? "").trim() === "" ? null : n;
  if (!isElement(n) || SKIPPED_TAGS.has(tagOf(n))) return null;
  for (const k of kids(n)) {
    const hit = firstTextNode(k);
    if (hit) return hit;
  }
  return null;
}

function firstMatchingElement(n: MailNode, pred: (el: MailElement) => boolean, stop: MailNode | null): MailElement | null {
  if (n === stop || !isElement(n)) return null;
  if (pred(n)) return n;
  for (const k of kids(n)) {
    const hit = firstMatchingElement(k, pred, stop);
    if (hit) return hit;
  }
  return null;
}

function markSiblingsFrom(el: MailElement, stop: MailNode | null): void {
  addClass(el, "sig");
  const parent = el.parentNode;
  if (!parent) return;
  const all = kids(parent);
  for (const n of all.slice(all.indexOf(el) + 1)) {
    if (n === stop) break;
    if (isElement(n)) addClass(n, "sig");
  }
}

/** Gives the signature block and what follows it the class sig. Gmail and Outlook name theirs; otherwise a lone "-- " block marks it. */
function dimSignature(root: MailElement, fold: MailElement | null): boolean {
  const named = firstMatchingElement(root, (el) => classSet(el).has("gmail_signature") || el.id === "Signature", fold);
  if (named) {
    markSiblingsFrom(named, fold);
    return true;
  }
  for (const b of blocksOf(root)) {
    if (b === fold) break;
    if (isElement(b) && SIGNATURE_LINE.test(flatText(b))) {
      markSiblingsFrom(b, fold);
      return true;
    }
  }
  return false;
}

/** Lowercase, one space between words, no ">" prefixes, nothing after a "-- " line: the shape both sides of a repeat comparison take. */
export function normaliseRepeatText(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/^\s*(?:>\s?)+/, ""));
  const sigAt = lines.findIndex((l) => SIGNATURE_LINE.test(l));
  const kept = sigAt >= 0 ? lines.slice(0, sigAt) : lines;
  return kept.join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Index of the first unit of the trailing run that repeats earlier messages,
 * or -1. Units are normalised paragraphs in order; empties are transparent.
 * The run is built from the end in segments, each of which appears verbatim
 * in one earlier message. The first paragraph never folds, a segment shorter
 * than a sentence does not count, and the run needs at least two paragraphs.
 */
export function repeatedTailStart(units: string[], priors: string[]): number {
  const hay = priors.filter(Boolean);
  const firstContent = units.findIndex((u) => u !== "");
  if (!hay.length || firstContent < 0) return -1;
  let end = units.length;
  let start = -1;
  let matched = 0;
  let chars = 0;
  for (;;) {
    let found = -1;
    for (let k = firstContent + 1; k < end; k++) {
      if (units[k] === "") continue;
      const run = units.slice(k, end).filter(Boolean);
      const joined = run.join(" ");
      if (joined.length < REPEAT_MIN_SEGMENT_CHARS) continue;
      if (hay.some((h) => h.includes(joined))) {
        found = k;
        matched += run.length;
        chars += joined.length;
        break;
      }
    }
    if (found < 0) break;
    start = found;
    end = found;
  }
  return matched >= REPEAT_MIN_PARAGRAPHS && chars >= REPEAT_MIN_CHARS ? start : -1;
}

/** What a folded trailing region is made of. The fold's label names the kinds it holds. */
export type RegionKind = "quote" | "repeat" | "signature" | "legal" | "client" | "bulk" | "links";

/** How many lines of a signature stay visible when the signature is the only thing that would fold. */
const SIGNATURE_KEEP_LINES = 2;
/** A confidentiality paragraph longer than this has to be mostly boilerplate before it folds. */
const LEGAL_LONG_CHARS = 200;
/** How much of a long block must be boilerplate for the whole block to count as a notice. */
const LEGAL_RATIO = 0.6;
/** Above this many link-only blocks in a row, a marketing tail is a link farm. */
const LINK_FARM_BLOCKS = 8;
/** Text this long reads as the message itself, whatever else it looks like. */
const PROSE_CHARS = 60;
/** An image this small in either dimension is a tracker or a spacer, never a picture. */
const PIXEL_MAX = 3;

const LEGAL_PATTERNS: RegExp[] = [
  /this (e-?mail|message|communication)( and any (files|attachments))? (is|are|may be) (intended|confidential|privileged)/i,
  /if you (are not|have received) (the intended|this in error)/i,
  /unauthorised (use|disclosure)|unauthorized (use|disclosure)/i,
  /the contents of this (e-?mail|message)/i,
];

/** The line a phone or a mail client adds on its own behalf. */
const CLIENT_FOOTER = /^(?:sent from my (?:iphone|ipad)|get outlook for ios|sent via superhuman|sent with shortwave|sent from gmail mobile)[\s.!]*$/i;

/** What a bulk sender puts under the mail: why you got it, how to stop it, where to read it. */
const BULK_PHRASE = /you are receiving this|manage (?:your )?(?:e-?mail )?preferences|view (?:this )?(?:e-?mail|message)?\s*in (?:your )?browser|privacy policy\s*[|/·•–—-]\s*terms|terms\s*[|/·•–—-]\s*privacy policy/i;
const UNSUBSCRIBE = /\bunsubscribe\b|\bopt[\s-]?out\b/i;
const COPYRIGHT = /^(?:copyright\s*)?(?:©|\(c\))?\s*\d{4}\b[^.]{0,120}$|all rights reserved/i;
/** A sentence: two letters, a run of words, and a full stop. */
const SENTENCE = /[A-Za-z]{2}[^.!?]{24,}[.!?]/;

/** True when the text carries a sentence of the message rather than a label or a link. */
export function isProse(text: string): boolean {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length >= PROSE_CHARS) return true;
  return SENTENCE.test(s);
}

/** True for a confidentiality or legal notice: a short paragraph that matches, or a long one that is mostly boilerplate. */
export function isLegalText(text: string): boolean {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s || !LEGAL_PATTERNS.some((re) => re.test(s))) return false;
  if (s.length <= LEGAL_LONG_CHARS) return true;
  let hit = 0;
  for (const sentence of s.split(/(?<=[.!?])\s+/)) if (LEGAL_PATTERNS.some((re) => re.test(sentence))) hit += sentence.length;
  return hit / s.length > LEGAL_RATIO;
}

/** True for a line that reads like a postal address: a street number, a locality, and a postcode or a country. */
export function isPostalAddressLine(line: string): boolean {
  const s = line.replace(/\s+/g, " ").trim();
  if (s.length < 12 || s.length > 200) return false;
  const commas = (s.match(/,/g) ?? []).length;
  if (commas < 1) return false;
  const street = /\b\d{1,6}[a-z]?\s+[A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*){0,5}\b/.test(s);
  const usZip = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(s);
  const ukPostcode = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(s);
  const intlPostcode = /\b\d{4,6}\b/.test(s);
  if (street && usZip) return true;
  if (ukPostcode && (street || commas >= 2)) return true;
  return street && intlPostcode && commas >= 2;
}

function descendants(node: MailNode, tag: string): MailElement[] {
  const out: MailElement[] = [];
  const walk = (n: MailNode): void => {
    for (const k of kids(n)) {
      if (!isElement(k)) continue;
      if (tagOf(k) === tag) out.push(k);
      walk(k);
    }
  };
  walk(node);
  return out;
}

/** A block whose text is its links and nothing else: a button, a row of footer links, a logo. */
function isLinkOnly(node: MailNode): boolean {
  const links = descendants(node, "a");
  if (links.length === 0) return false;
  const inLinks = links.reduce((n, a) => n + flatText(a).length, 0);
  return flatText(node).length - inLinks < 8;
}

function isBulkBlock(node: MailNode, text: string): boolean {
  if (BULK_PHRASE.test(text)) return true;
  const links = descendants(node, "a");
  if (links.some((a) => UNSUBSCRIBE.test(flatText(a)) || UNSUBSCRIBE.test(a.getAttribute("href") ?? ""))) return true;
  if (UNSUBSCRIBE.test(text)) return true;
  if (lineText(node).split("\n").some(isPostalAddressLine)) return true;
  return links.length > LINK_FARM_BLOCKS && !isProse(text);
}

/**
 * A top-level block that starts the signature: a lone "-- " line, a block
 * whose first line is that marker, or a block that holds only the client's
 * own signature element.
 */
function isSignatureBlock(node: MailNode): boolean {
  if (!isElement(node)) return false;
  const text = flatText(node);
  if (SIGNATURE_LINE.test(text)) return true;
  if (!text) return false;
  const first = linesOf(node)[0];
  if (first !== undefined && SIGNATURE_LINE.test(first)) return true;
  const named = firstMatchingElement(node, (el) => classSet(el).has("gmail_signature") || el.id === "Signature", null);
  return named !== null && flatText(named) === text;
}

/** True when a block carries an attribution line, an Original Message banner, or a pasted Outlook header anywhere inside it. */
function holdsQuotedHistory(node: MailNode): boolean {
  const lines = linesOf(node);
  return lines.some((l, i) => isAttributionLine(l) || isOriginalSeparator(l) || isOutlookHeader(lines.slice(i, i + 6)));
}

type BlockKind = RegionKind | "neutral" | "message";

/** What one top-level block is: part of the message, part of a trailing region, or neither. */
function blockKind(node: MailNode): BlockKind {
  if (isElement(node)) {
    const t = tagOf(node);
    if (t === "br" || t === "hr") return "neutral";
  }
  const text = flatText(node);
  if (isSignatureBlock(node)) return "signature";
  if (isLegalText(text)) return "legal";
  if (CLIENT_FOOTER.test(text)) return "client";
  // A bulk footer sitting inside a quoted message is history, and the fold should say so.
  if (isBulkBlock(node, text)) return holdsQuotedHistory(node) ? "quote" : "bulk";
  if (!text) return "neutral";
  if (COPYRIGHT.test(text)) return "neutral";
  if (isLinkOnly(node)) return "neutral";
  return isProse(text) ? "message" : "neutral";
}

/** A block the region may reach back over: it carries no words of its own. */
function isStructural(node: MailNode): boolean {
  if (isElement(node)) {
    const t = tagOf(node);
    if (t === "br" || t === "hr") return true;
  }
  const text = flatText(node);
  if (!text) return true;
  if (COPYRIGHT.test(text)) return true;
  return isLinkOnly(node);
}

export interface TrailingRegion {
  /** Index of the first block that folds. */
  start: number;
  kinds: RegionKind[];
}

/**
 * The run at the end of the message that is not the message: a signature, a
 * confidentiality notice, a client footer, a bulk-mail footer, a link farm,
 * or several of them. Nothing before the last block of real prose is ever
 * part of it, so a notice quoted in the middle of a message stays put.
 */
export function findTrailingRegion(blocks: MailNode[]): TrailingRegion | null {
  let sweep = blocks.length;
  while (sweep > 0 && blockKind(blocks[sweep - 1]!) !== "message") sweep--;
  if (sweep >= blocks.length) return null;
  let start = -1;
  for (let i = sweep; i < blocks.length; i++) {
    const k = blockKind(blocks[i]!);
    if (k !== "neutral" && k !== "message") {
      start = i;
      break;
    }
  }
  // A tail of nothing but links is a link farm once it is long enough, even though no single block says so.
  let run = 0;
  let runStart = blocks.length;
  for (let i = blocks.length - 1; i >= sweep; i--) {
    if (!isLinkOnly(blocks[i]!)) break;
    run++;
    runStart = i;
  }
  const links = run > LINK_FARM_BLOCKS;
  if (links && (start < 0 || runStart < start)) start = runStart;
  if (start < 0) return null;
  while (start > sweep && isStructural(blocks[start - 1]!)) start--;
  const kinds = new Set<RegionKind>();
  for (let i = start; i < blocks.length; i++) {
    const k = blockKind(blocks[i]!);
    if (k !== "neutral" && k !== "message") kinds.add(k);
  }
  if (links) kinds.add("links");
  if (kinds.size === 0) return null;
  return { start, kinds: Array.from(kinds) };
}

/** True when anything outside `exclude` still carries text or a picture. */
function hasContentOutside(node: MailNode, exclude: Set<MailNode>): boolean {
  if (exclude.has(node)) return false;
  if (node.nodeType === TEXT) return (node.textContent ?? "").trim() !== "";
  if (!isElement(node)) return false;
  const t = tagOf(node);
  if (SKIPPED_TAGS.has(t)) return false;
  if (t === "img") return true;
  return kids(node).some((k) => hasContentOutside(k, exclude));
}

const WORDS: Record<RegionKind, string> = {
  quote: "quoted text",
  repeat: "quoted text",
  signature: "signature",
  legal: "footer",
  client: "footer",
  bulk: "footer",
  links: "footer",
};

const WORD_ORDER = ["quoted text", "signature", "footer"];

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * What the disclosure says: the kinds it holds, and how many lines are behind
 * it. The summary is mono and uppercased by the stylesheet, so
 * "Show footer, 14 lines" reads as SHOW FOOTER, 14 LINES.
 */
export function foldLabels(kinds: ReadonlyArray<RegionKind>, lines: number): { show: string; hide: string } {
  const words = WORD_ORDER.filter((w) => kinds.some((k) => WORDS[k] === w));
  const what = joinWords(words) || "quoted text";
  const count = lines > 0 ? `, ${lines} ${lines === 1 ? "line" : "lines"}` : "";
  return { show: `Show ${what}${count}`, hide: `Hide ${what}` };
}

function pixelDimension(el: MailElement, name: "width" | "height"): number | null {
  const attr = el.getAttribute(name);
  if (attr !== null) {
    const n = Number(attr.trim().replace(/px$/i, ""));
    if (Number.isFinite(n)) return n;
  }
  const style = el.getAttribute("style") ?? "";
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([0-9.]+)\\s*px`, "i").exec(style);
  return m ? Number(m[1]) : null;
}

/** True for a tracking pixel or a layout spacer: one to three pixels in either dimension. */
export function isTrackingImage(el: MailElement): boolean {
  const w = pixelDimension(el, "width");
  const h = pixelDimension(el, "height");
  return (w !== null && w <= PIXEL_MAX) || (h !== null && h <= PIXEL_MAX);
}

/** Removes tracking pixels and spacers outright. They are never worth a fold. */
function removeTrackingImages(root: MailNode): number {
  let removed = 0;
  const walk = (n: MailNode): void => {
    for (const k of kids(n)) {
      if (!isElement(k)) continue;
      if (tagOf(k) === "img") {
        if (isTrackingImage(k)) {
          k.remove();
          removed += 1;
        }
        continue;
      }
      walk(k);
    }
  };
  walk(root);
  return removed;
}

/**
 * Moves everything after the first `keep` lines of `el` into a copy of it,
 * inserted right after. Null when there is no line break to split on, so a
 * signature the renderer cannot cut stays whole and visible.
 */
function splitAfterLines(doc: MailDocument, el: MailElement, keep: number): MailElement | null {
  const parent = el.parentNode;
  if (!parent || !isElement(parent)) return null;
  const children = kids(el);
  let lines = 0;
  let pending = false;
  let at = -1;
  for (let i = 0; i < children.length && at < 0; i++) {
    const c = children[i]!;
    if (isElement(c) && tagOf(c) === "br") {
      if (pending) lines += 1;
      pending = false;
      if (lines >= keep) at = i + 1;
      continue;
    }
    const text = lineText(c);
    if (!text) continue;
    if (SIGNATURE_LINE.test(text)) continue;
    if (isElement(c) && LINE_BREAK_TAGS.has(tagOf(c))) {
      lines += text.split("\n").filter((l) => l.trim()).length;
      pending = false;
      if (lines >= keep) at = i + 1;
    } else pending = true;
  }
  if (at < 0 || at >= children.length) return null;
  const tail = doc.createElement(tagOf(el));
  if (el.className) tail.className = el.className;
  for (const n of children.slice(at)) tail.appendChild(n);
  const siblings = kids(parent);
  parent.insertBefore(tail, siblings[siblings.indexOf(el) + 1] ?? null);
  return tail;
}

/** The lines a signature would show, not counting the "-- " marker. */
function signatureLines(node: MailNode): number {
  return linesOf(node).filter((l) => !SIGNATURE_LINE.test(l)).length;
}

/**
 * Where the fold starts when the signature is the only trailing content: the
 * first block past the first two lines, splitting one block if it carries
 * them all. Null when the whole signature is two lines or fewer, in which
 * case nothing folds and the name and title stay where they are.
 */
function signatureCut(doc: MailDocument, root: MailElement, start: number): MailNode | null {
  let kept = 0;
  for (let i = start; ; i++) {
    const blocks = blocksOf(root);
    const block = blocks[i];
    if (!block) return null;
    if (kept >= SIGNATURE_KEEP_LINES) return block;
    const lines = signatureLines(block);
    if (kept + lines > SIGNATURE_KEEP_LINES && isElement(block)) {
      const tail = splitAfterLines(doc, block, SIGNATURE_KEEP_LINES - kept);
      if (tail) return tail;
    }
    kept += lines;
  }
}

/** The lines the reader no longer sees, so the disclosure can say how much is behind it. */
function foldedLineCount(details: MailElement): number {
  return lineText(foldBody(details))
    .split("\n")
    .filter((l) => l.trim())
    .length;
}

function setFoldLabel(details: MailElement, kinds: ReadonlyArray<RegionKind>, lines: number): void {
  const labels = foldLabels(kinds, lines);
  for (const el of kids(details).filter(isElement).flatMap((s) => kids(s).filter(isElement))) {
    const cls = classSet(el);
    if (cls.has("qf-show")) el.textContent = labels.show;
    if (cls.has("qf-hide")) el.textContent = labels.hide;
  }
}

/** Where a trailing region is looked for: the content root, or the one container the whole message sits in. */
function regionRoot(root: MailElement): MailElement {
  let el = root;
  for (let depth = 0; depth < 3; depth++) {
    const blocks = blocksOf(el);
    const only = blocks.length === 1 ? blocks[0] : undefined;
    if (!only || !isElement(only) || SKIPPED_TAGS.has(tagOf(only)) || blocksOf(only).length < 2) return el;
    el = only;
  }
  return el;
}

export interface TidyResult {
  /** What the fold holds of the thread's history: structural quoted text, a repeat of earlier messages, both, or nothing. */
  folded: "quote" | "repeat" | "quote+repeat" | null;
  /** Every kind of thing behind the fold, history and trailing regions together. */
  kinds: RegionKind[];
  /** How many lines the fold hides. */
  lines: number;
  banners: number;
  /** True when a signature was found, whether it was dimmed in place or folded away. */
  signature: boolean;
  /** Tracking pixels and spacers removed outright. */
  pixels: number;
}

/**
 * Reshapes a sanitized body for reading, in place: external-sender banners
 * and tracking pixels go, and everything below the message that is not the
 * message (quoted history, a repeat of earlier messages, the signature, a
 * confidentiality notice, a phone or client footer, a bulk-mail footer, a
 * link farm) moves into one disclosure that says what is inside it. Nothing
 * but the pixels is deleted, and the message itself is never folded away.
 * priorTexts are the earlier messages of the thread as plain text, oldest
 * first, for the repeat pass.
 */
export function tidyMessage(doc: MailDocument, priorTexts: string[] = []): TidyResult {
  const root = contentRoot(doc.body);
  const banners = removeBanners(root);
  const pixels = removeTrackingImages(doc.body);
  let fold: MailElement | null = null;
  let folded: TidyResult["folded"] = null;
  const kinds = new Set<RegionKind>();

  const blocks = blocksOf(root);
  const start = quoteStartIndex(blocks);
  if (start >= 0 && hasVisibleContent(blocks.slice(0, start))) {
    fold = foldFrom(doc, root, blocks[backOverBreaks(blocks, start)]!, null);
    folded = "quote";
    kinds.add("quote");
  }

  if (priorTexts.length) {
    const visible = blocksOf(root).filter((b) => b !== fold);
    const units = visible.map((b) => normaliseRepeatText(lineText(b)));
    const at = repeatedTailStart(units, priorTexts.map(normaliseRepeatText));
    if (at >= 0 && hasVisibleContent(visible.slice(0, at))) {
      fold = foldFrom(doc, root, visible[backOverBreaks(visible, at)]!, fold);
      folded = folded ? "quote+repeat" : "repeat";
      kinds.add("repeat");
    }
  }

  // The trailing region. With no quoted history the search may step into the one container the message sits in,
  // which is where a marketing footer usually hides; with a fold in place it stays at the level the fold sits on.
  const container = fold ? root : regionRoot(root);
  const scanned = blocksOf(container).filter((b) => b !== fold);
  const region = findTrailingRegion(scanned);
  let foldedSignature = false;
  if (region) {
    const onlySignature = !fold && region.kinds.length === 1 && region.kinds[0] === "signature";
    const from = onlySignature ? signatureCut(doc, container, region.start) : scanned[region.start] ?? null;
    const after = from ? blocksOf(container).slice(blocksOf(container).indexOf(from)) : [];
    if (from && hasContentOutside(doc.body, new Set(after))) {
      fold = foldFrom(doc, container, from, fold);
      for (const k of region.kinds) kinds.add(k);
      foldedSignature = region.kinds.includes("signature");
    }
  }

  const signature = dimSignature(root, fold) || foldedSignature;
  const lines = fold ? foldedLineCount(fold) : 0;
  if (fold) setFoldLabel(fold, Array.from(kinds), lines);
  return { folded, kinds: Array.from(kinds), lines, banners, signature, pixels };
}

// ---- Plain text bodies ----

export interface TextFold {
  /** The message's own text, banner and prefix removed. */
  text: string;
  /** Everything from the "-- " line on, when the visible text has one. */
  sig: string | null;
  /** The quoted history, from the attribution line or first ">" line to the end; null when nothing folds. */
  quoted: string | null;
}

/** Plain text of a message body for the repeat pass: the text part, else the HTML stripped to text. */
export function messageText(body: { html: string | null; text: string | null } | null): string | null {
  if (!body) return null;
  if (body.text && body.text.trim()) return body.text;
  return body.html ? htmlToText(body.html) : null;
}

/** HTML to text with line breaks at br and block ends. Good enough to find repeated paragraphs; never shown. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|pre|table|section|article|dd|dt|td|th|address|center)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Where quoted history starts in plain text lines, stepping back over the attribution line (one or two lines) before a ">" run. */
function textQuoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === "") continue;
    if (isOriginalSeparator(l) || isOutlookHeader(lines.slice(i, i + 6))) return i;
    if (!QUOTED_LINE.test(l)) continue;
    let j = i - 1;
    while (j >= 0 && lines[j]!.trim() === "") j--;
    if (j >= 0 && isAttributionLine(lines[j]!)) return j;
    if (j >= 1 && isAttributionLine(`${lines[j - 1]!.trim()} ${lines[j]!.trim()}`)) return j - 1;
    return i;
  }
  return -1;
}

export function foldPlainText(raw: string, priorTexts: string[] = []): TextFold {
  let lines = raw.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
  // Banner: a [EXTERNAL] prefix on the first words, or a leading paragraph that is the gateway sentence.
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx >= 0) lines[firstIdx] = lines[firstIdx]!.replace(BRACKET_PREFIX, "");
  for (let p = 0, i = 0; p < BANNER_WINDOW && i < lines.length; p++) {
    while (i < lines.length && lines[i]!.trim() === "") i++;
    let j = i;
    while (j < lines.length && lines[j]!.trim() !== "") j++;
    const para = lines.slice(i, j).join(" ");
    if (isBannerText(para) && para.length <= BANNER_MAX_CHARS) {
      while (j < lines.length && lines[j]!.trim() === "") j++;
      lines.splice(i, j - i);
      break;
    }
    i = j;
  }

  let quoted: string[] = [];
  const q = textQuoteStart(lines);
  if (q > 0 && lines.slice(0, q).some((l) => l.trim() !== "")) {
    quoted = lines.slice(q);
    lines = lines.slice(0, q);
  }

  if (priorTexts.length) {
    const paragraphs = lines.join("\n").split(/\n{2,}/);
    const at = repeatedTailStart(paragraphs.map(normaliseRepeatText), priorTexts.map(normaliseRepeatText));
    if (at > 0) {
      const tail = paragraphs.slice(at).join("\n\n");
      quoted = quoted.length ? [tail, "", ...quoted] : [tail];
      lines = paragraphs.slice(0, at).join("\n\n").split("\n");
    }
  }

  let sig: string | null = null;
  const s = lines.findIndex((l) => SIGNATURE_LINE.test(l));
  if (s >= 0) {
    sig = lines.slice(s).join("\n").replace(/\s+$/, "");
    lines = lines.slice(0, s);
  }
  return { text: lines.join("\n").replace(/^\n+/, "").replace(/\s+$/, ""), sig, quoted: quoted.length ? quoted.join("\n").replace(/\s+$/, "") : null };
}

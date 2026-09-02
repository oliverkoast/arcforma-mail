// A minimal HTML DOM for node:test: enough of the DOM's shape (nodeType,
// nodeName, childNodes, textContent, remove, insertBefore, attributes) for
// the reading-aid pass in mailhtml.ts to run without a browser. Test harness
// only; nothing in the app imports it. Well-formed HTML in, the same out.

import type { MailDocument, MailElement, MailNode } from "./mailhtml";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["style", "script"]);

export class MiniNode implements MailNode {
  parentNode: MiniElement | null = null;
  childNodes: MiniNode[] = [];
  private data: string;

  constructor(
    public readonly nodeType: number,
    public readonly nodeName: string,
    data = "",
  ) {
    this.data = data;
  }

  get textContent(): string {
    if (this.nodeType !== 1) return this.data;
    return this.childNodes.filter((c) => c.nodeType !== 8).map((c) => c.textContent).join("");
  }

  set textContent(value: string | null) {
    if (this.nodeType !== 1) {
      this.data = value ?? "";
      return;
    }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new MiniNode(3, "#text", value));
  }

  remove(): void {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }

  appendChild(node: MailNode): MailNode {
    return this.insertBefore(node, null);
  }

  insertBefore(node: MailNode, ref: MailNode | null): MailNode {
    const n = node as MiniNode;
    n.remove();
    const i = ref ? this.childNodes.indexOf(ref as MiniNode) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    n.parentNode = this as unknown as MiniElement;
    return n;
  }
}

export class MiniElement extends MiniNode implements MailElement {
  readonly attrs = new Map<string, string>();

  constructor(tag: string) {
    super(1, tag.toUpperCase());
  }

  get tag(): string {
    return this.nodeName.toLowerCase();
  }

  get className(): string {
    return this.attrs.get("class") ?? "";
  }

  set className(v: string) {
    this.attrs.set("class", v);
  }

  get id(): string {
    return this.attrs.get("id") ?? "";
  }

  set id(v: string) {
    this.attrs.set("id", v);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), value);
  }
}

export class MiniDocument implements MailDocument {
  readonly body = new MiniElement("body");

  createElement(tag: string): MiniElement {
    return new MiniElement(tag);
  }
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, "&");
}

function encode(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Parses a body fragment (what DOMPurify hands back) into a MiniDocument. */
export function parseHtml(html: string): MiniDocument {
  const doc = new MiniDocument();
  const stack: MiniElement[] = [doc.body];
  const top = (): MiniElement => stack[stack.length - 1]!;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const stop = end < 0 ? html.length : end;
      top().appendChild(new MiniNode(8, "#comment", html.slice(i + 4, stop)));
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      const name = html.slice(i + 2, end < 0 ? html.length : end).trim().toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html[i] === "<" && /[a-zA-Z]/.test(html[i + 1] ?? "")) {
      let j = i + 1;
      while (j < html.length && /[^\s/>]/.test(html[j]!)) j++;
      const name = html.slice(i + 1, j).toLowerCase();
      let end = j;
      let quote: string | null = null;
      while (end < html.length) {
        const c = html[end]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
        end++;
      }
      const inside = html.slice(j, end);
      const selfClosing = /\/\s*$/.test(inside);
      const el = new MiniElement(name);
      for (const m of inside.replace(/\/\s*$/, "").matchAll(ATTR)) el.attrs.set(m[1]!.toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ""));
      top().appendChild(el);
      i = end + 1;
      if (VOID.has(name) || selfClosing) continue;
      if (RAW_TEXT.has(name)) {
        const close = html.toLowerCase().indexOf(`</${name}`, i);
        const stop = close < 0 ? html.length : close;
        el.appendChild(new MiniNode(3, "#text", html.slice(i, stop)));
        const gt = html.indexOf(">", stop);
        i = gt < 0 ? html.length : gt + 1;
        continue;
      }
      stack.push(el);
      continue;
    }
    const next = html.indexOf("<", i + 1);
    const stop = next < 0 ? html.length : next;
    top().appendChild(new MiniNode(3, "#text", decode(html.slice(i, stop))));
    i = stop;
  }
  return doc;
}

export function serialize(node: MiniNode): string {
  if (node.nodeType === 3) return encode(node.textContent);
  if (node.nodeType === 8) return `<!--${node.textContent}-->`;
  const el = node as MiniElement;
  const attrs = Array.from(el.attrs).map(([k, v]) => ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join("");
  const inner = el.childNodes.map(serialize).join("");
  if (el.tag === "body") return inner;
  if (VOID.has(el.tag)) return `<${el.tag}${attrs}>`;
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}

export function innerHtml(el: MiniElement): string {
  return el.childNodes.map(serialize).join("");
}

export function find(root: MiniNode, pred: (el: MiniElement) => boolean): MiniElement | null {
  for (const k of root.childNodes) {
    if (k.nodeType !== 1) continue;
    const el = k as MiniElement;
    if (pred(el)) return el;
    const hit = find(el, pred);
    if (hit) return hit;
  }
  return null;
}

export function findAll(root: MiniNode, pred: (el: MiniElement) => boolean): MiniElement[] {
  const out: MiniElement[] = [];
  for (const k of root.childNodes) {
    if (k.nodeType !== 1) continue;
    const el = k as MiniElement;
    if (pred(el)) out.push(el);
    out.push(...findAll(el, pred));
  }
  return out;
}

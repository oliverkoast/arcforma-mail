import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_HTML_CHARS, PURIFY_CONFIG, buildMessageCsp, hardenNode, hasRemoteImages, isSafeHref, scrubCss, tooLarge, type HookNode } from "./mailhtml";

function directive(csp: string, name: string): string {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `) || s === name);
  assert.ok(d, `${name} missing from ${csp}`);
  return d!;
}

test("the message CSP blocks everything remote by default and opens only https images when allowed", () => {
  const off = buildMessageCsp(false);
  assert.equal(directive(off, "img-src"), "img-src data: cid:");
  for (const d of ["font-src", "frame-src", "child-src", "connect-src", "media-src", "object-src", "script-src", "form-action", "base-uri"]) {
    assert.equal(directive(off, d), `${d} 'none'`, d);
  }
  assert.equal(directive(off, "default-src"), "default-src 'none'");
  const on = buildMessageCsp(true);
  assert.equal(directive(on, "img-src"), "img-src https: data: cid:");
  assert.equal(on.includes("http:"), false, "plain http images stay blocked even when images are on");
  assert.equal(directive(on, "script-src"), "script-src 'none'");
});

test("scrubCss strips url(), @import, expression(), and behavior from inline styles", () => {
  assert.equal(scrubCss("background:url(https://t.example/p.gif);color:red"), "background:none;color:red");
  assert.equal(scrubCss("background-image: url( 'https://t.example/p.gif' )"), "background-image: none");
  assert.equal(scrubCss('@import url("https://t.example/x.css"); p{color:red}'), " p{color:red}");
  assert.equal(scrubCss("@import 'x.css'; a{b:c}"), " a{b:c}");
  assert.equal(scrubCss("width: expression(alert(1)); color: blue"), "; color: blue");
  assert.equal(scrubCss("a{width:expression(document.cookie)}"), "a{}");
  assert.equal(scrubCss("behavior: url(x.htc); color: blue"), " color: blue");
  assert.equal(scrubCss("color: blue"), "color: blue");
});

test("only http(s) and mailto links survive", () => {
  assert.equal(isSafeHref("https://arcforma.ai"), true);
  assert.equal(isSafeHref("http://example.com/x"), true);
  assert.equal(isSafeHref("mailto:you@example.com"), true);
  assert.equal(isSafeHref("javascript:alert(1)"), false);
  assert.equal(isSafeHref(" JavaScript:alert(1)"), false);
  assert.equal(isSafeHref("data:text/html,<script>1</script>"), false);
  assert.equal(isSafeHref("file:///etc/passwd"), false);
  assert.equal(isSafeHref("vbscript:x"), false);
  assert.equal(isSafeHref("app://mail/index.html"), false);
  assert.equal(isSafeHref("#anchor"), false);
});

function node(name: string, attrs: Record<string, string>, text: string | null = null): HookNode & { attrs: Record<string, string> } {
  return {
    attrs,
    nodeName: name,
    textContent: text,
    getAttribute: (n) => (n in attrs ? attrs[n]! : null),
    setAttribute: (n, v) => {
      attrs[n] = v;
    },
    removeAttribute: (n) => {
      delete attrs[n];
    },
    hasAttribute: (n) => n in attrs,
  };
}

test("hardenNode forces target and rel on links, drops unsafe hrefs, and scrubs style attributes and style tags", () => {
  const a = node("A", { href: "https://arcforma.ai", target: "_self" });
  hardenNode(a);
  assert.deepEqual(a.attrs, { href: "https://arcforma.ai", target: "_blank", rel: "noopener noreferrer nofollow" });
  const js = node("a", { href: "javascript:alert(1)" });
  hardenNode(js);
  assert.equal("href" in js.attrs, false);
  assert.equal(js.attrs["target"], "_blank");
  const styled = node("DIV", { style: "background:url(https://t.example/p.gif);color:red" });
  hardenNode(styled);
  assert.equal(styled.attrs["style"], "background:none;color:red");
  const sheet = node("STYLE", {}, "@import url(https://t.example/x.css); body{background:url(https://t.example/bg.png)}");
  hardenNode(sheet);
  assert.equal(sheet.textContent, " body{background:none}");
  const plain = node("P", { style: "color:red" });
  hardenNode(plain);
  assert.equal(plain.attrs["style"], "color:red");
});

test("the sanitizer config forbids active content, forms, and base, and never adds allow-scripts", () => {
  for (const t of ["script", "iframe", "object", "embed", "form", "input", "button", "base", "meta", "link", "svg", "math"]) {
    assert.ok(PURIFY_CONFIG.FORBID_TAGS.includes(t), t);
  }
  for (const a of ["srcset", "ping", "formaction", "background"]) assert.ok(PURIFY_CONFIG.FORBID_ATTR.includes(a), a);
  assert.deepEqual(PURIFY_CONFIG.ADD_ATTR, ["target"]);
  assert.equal(PURIFY_CONFIG.ALLOW_DATA_ATTR, false);
});

test("very large messages fall back to text, and remote CSS backgrounds count as remote images", () => {
  assert.equal(tooLarge("x".repeat(MAX_HTML_CHARS)), false);
  assert.equal(tooLarge("x".repeat(MAX_HTML_CHARS + 1)), true);
  assert.equal(hasRemoteImages('<p style="background:url(https://t.example/p.gif)">x</p>'), true);
  assert.equal(hasRemoteImages('<img src="https://t.example/p.gif">'), true);
  assert.equal(hasRemoteImages('<img src="data:image/gif;base64,R0lGOD">'), false);
  assert.equal(hasRemoteImages("<p>plain</p>"), false);
});

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

// ---- Reading aids: quoted history, banners, signatures, repeats ----

import { HIDE_QUOTED, SHOW_QUOTED, foldPlainText, htmlToText, isAttributionLine, isOutlookHeader, lineText, messageText, normaliseRepeatText, repeatedTailStart, tidyMessage } from "./mailhtml";
import { find, findAll, innerHtml, parseHtml, type MiniElement } from "./minidom";

const SUMMARY = `<summary><span class="qf-show">${SHOW_QUOTED}</span><span class="qf-hide">${HIDE_QUOTED}</span></summary>`;
const ANY_SUMMARY = /<summary><span class="qf-show">[^<]*<\/span><span class="qf-hide">[^<]*<\/span><\/summary>/;

function tidy(html: string, priors: string[] = []) {
  const doc = parseHtml(html);
  const result = tidyMessage(doc, priors);
  const fold = find(doc.body, (el) => el.tag === "details" && el.className === "quote-fold");
  const foldBody = fold ? find(fold, (el) => el.className === "quote-fold-body") : null;
  const label = fold ? lineText(find(fold, (el) => el.className === "qf-show")!) : null;
  const hideLabel = fold ? lineText(find(fold, (el) => el.className === "qf-hide")!) : null;
  // The summary text is checked on its own; every other assertion reads the markup with a fixed placeholder in it.
  const out = innerHtml(doc.body).replace(ANY_SUMMARY, SUMMARY);
  // What the reader sees with the fold closed: the body's lines with the fold lifted out, blank lines dropped.
  let visible: string;
  if (fold) {
    const parent = fold.parentNode!;
    const next = parent.childNodes[parent.childNodes.indexOf(fold) + 1] ?? null;
    fold.remove();
    visible = lineText(doc.body);
    parent.insertBefore(fold, next);
  } else visible = lineText(doc.body);
  visible = visible.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  return { doc, result, fold, foldBody, out, visible, label, hideLabel, quoted: foldBody ? lineText(foldBody) : "" };
}

test("minidom round-trips the markup the fixtures use", () => {
  const html = '<div dir="ltr">Hi &lt;there&gt;<br><blockquote type="cite" class="a b">x&nbsp;y</blockquote><hr><!-- c --></div>';
  assert.equal(innerHtml(parseHtml(html).body), html);
  // A br is one line break; a block boundary is a paragraph gap.
  assert.equal(lineText(parseHtml("<p>one<br>two</p><div>three</div>").body), "one\ntwo\n\nthree");
});

test("a Gmail reply folds from the quote container, keeps the new text and dims the signature", () => {
  const html =
    '<div dir="ltr">Thanks, that works.<br><div class="gmail_signature"><div>Oliver Korzen</div></div></div><br>' +
    '<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Wed, Sep 2, 2026 at 9:18 AM George Bell &lt;george@example.com&gt; wrote:<br></div>' +
    '<blockquote class="gmail_quote">Earlier text from George.</blockquote></div>';
  const t = tidy(html);
  assert.equal(t.result.folded, "quote");
  assert.equal(t.result.signature, true);
  assert.ok(t.out.startsWith('<div dir="ltr">Thanks, that works.<br><div class="gmail_signature sig">'), t.out);
  assert.ok(t.out.includes(`<details class="quote-fold">${SUMMARY}<div class="quote-fold-body"><br><div class="gmail_quote gmail_quote_container">`), t.out);
  assert.ok(t.out.endsWith("</blockquote></div></div></details>"), t.out);
  assert.equal(t.visible.includes("Earlier text"), false);
  assert.ok(t.quoted.startsWith("On Wed, Sep 2, 2026"));
});

test("an Apple Mail reply folds the cite blockquote and its attribution, wherever the attribution sits", () => {
  const inside = 'Looks good to me.<div><br></div><div>Oliver</div><div><br><blockquote type="cite"><div>On Sep 2, 2026, at 9:18 AM, George Bell &lt;george@example.com&gt; wrote:</div><br><div>Earlier from George</div></blockquote></div><br>';
  const a = tidy(inside);
  assert.equal(a.result.folded, "quote");
  assert.equal(a.visible, "Looks good to me.\nOliver");
  assert.ok(a.quoted.startsWith("On Sep 2, 2026, at 9:18 AM"));
  const outside = "<div>Sure.</div><div>On 2 Sep 2026, at 09:18, George Bell &lt;george@example.com&gt; wrote:</div><br><blockquote>Earlier</blockquote>";
  const b = tidy(outside);
  assert.equal(b.visible, "Sure.");
  assert.ok(b.quoted.startsWith("On 2 Sep 2026"));
  assert.equal(b.quoted.includes("Earlier"), true);
  const german = "<div>Danke.</div><div>Am 02.09.2026 um 09:18 schrieb George Bell &lt;george@example.com&gt;:</div><blockquote>Alt</blockquote>";
  assert.equal(tidy(german).visible, "Danke.");
  const french = "<div>Merci.</div><div>Le 2 sept. 2026 à 09:18, George Bell &lt;george@example.com&gt; a écrit :</div><blockquote>Ancien</blockquote>";
  assert.equal(tidy(french).visible, "Merci.");
  // A blockquote without an attribution or cite type is ordinary formatting and stays.
  assert.equal(tidy("<p>Quote of the day:</p><blockquote>Be kind.</blockquote>").result.folded, null);
});

test("an Outlook reply folds from the From/Sent/To/Subject header, the hr before it, or the Original Message line", () => {
  const header =
    '<div class="WordSection1"><p class="MsoNormal">Thanks, will do.</p><p class="MsoNormal">&nbsp;</p>' +
    '<div><div style="padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Oliver Korzen &lt;you@example.com&gt;<br><b>Sent:</b> Tuesday, September 1, 2026 4:02 PM<br><b>To:</b> George Bell<br><b>Subject:</b> Re: Kickoff</p></div>' +
    '<p class="MsoNormal">Earlier from Oliver.</p></div></div>';
  const h = tidy(header);
  assert.equal(h.result.folded, "quote");
  assert.equal(h.visible, "Thanks, will do.");
  assert.ok(h.quoted.startsWith("From: Oliver Korzen"));
  assert.ok(h.quoted.endsWith("Earlier from Oliver."));
  const rule = '<div>New text</div><div id="Signature">George</div><hr><div id="divRplyFwdMsg"><b>From:</b> A<br><b>Sent:</b> B<br><b>To:</b> C<br><b>Subject:</b> D</div><div>Old</div>';
  const r = tidy(rule);
  // The signature joins the quoted history in the one fold, and the label names both.
  assert.equal(r.visible, "New text");
  assert.equal(r.result.signature, true);
  assert.ok(r.out.includes('<div>New text</div><details'), r.out);
  assert.equal(r.label, "Show quoted text and signature, 6 lines");
  assert.equal(r.hideLabel, "Hide quoted text and signature");
  assert.ok(r.quoted.startsWith("George"));
  assert.ok(r.quoted.includes("From: A"));
  const original = "<p>New</p><hr><p>-----Original Message-----<br>From: X<br>Sent: Y<br>To: Z<br>Subject: S</p><p>Old</p>";
  const o = tidy(original);
  assert.equal(o.visible, "New");
  assert.ok(o.out.includes('<details class="quote-fold">' + SUMMARY + '<div class="quote-fold-body"><hr>'), o.out);
  const underscores = "<p>New</p><p>________________________________</p><p>From: X</p><p>Old</p>";
  assert.equal(tidy(underscores).visible, "New");
  // An hr that is just a divider, with prose after it, stays.
  assert.equal(tidy("<p>Intro</p><hr><p>Section two</p>").result.folded, null);
  assert.ok(isOutlookHeader(["From: a", "Date: b", "To: c", "Cc: d", "Subject: e"]));
  assert.equal(isOutlookHeader(["From: a", "Subject: e"]), false);
  assert.equal(isAttributionLine("On Tue, Sep 2, 2026 at 9:18 AM George Bell <george@example.com> wrote:"), true);
  assert.equal(isAttributionLine("On the other hand we wrote: nothing"), false);
});

test("a forward with no new text stays open, and a message with no quote is untouched", () => {
  const forward = '<div dir="ltr"><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: George<br>Date: Tue<br>Subject: Deck<br>To: Oliver</div><br><br>Here is the deck.</div></div>';
  const f = tidy(forward);
  assert.equal(f.result.folded, null);
  assert.equal(f.out, forward);
  const plain = "<p>Hi Oliver,</p><p>Two things.</p>";
  assert.equal(tidy(plain).out, plain);
});

test("an external-sender banner at the top goes, the same sentence in the body stays, and [EXTERNAL] prefixes are trimmed", () => {
  const table =
    '<table cellpadding="0"><tbody><tr><td class="bar"><p><b>CAUTION:</b> This email originated from outside your organization. Do not click links or open attachments unless you recognize the sender and know the content is safe.</p></td></tr></tbody></table>' +
    "<p>Hi Oliver,</p><p>Body</p>";
  const t = tidy(table);
  assert.equal(t.result.banners, 1);
  assert.equal(t.out, "<p>Hi Oliver,</p><p>Body</p>");
  const wrapped = '<div dir="ltr"><div>WARNING: This message was sent from outside the company.</div><div>Real text</div></div>';
  assert.equal(tidy(wrapped).out, '<div dir="ltr"><div>Real text</div></div>');
  const spaced = "<p>External email: this is an external email.</p><p>Hi</p>";
  assert.equal(tidy(spaced).out, "<p>Hi</p>");
  const middle = "<p>a</p><p>b</p><p>c</p><p>d</p><p>Caution: this email originated from outside the organisation.</p>";
  const m = tidy(middle);
  assert.equal(m.result.banners, 0);
  assert.equal(m.out, middle);
  // A bare text banner above the message in the same div: the sentence and its line breaks go, the message stays.
  const long = "Long paragraph of real content. ".repeat(25);
  const merged = `<div>CAUTION: This email originated from outside your organization.<br><br>${long}</div>`;
  assert.equal(tidy(merged).out, `<div>${long}</div>`);
  // The sentence inside one element that also holds the message is left alone, since removing the element would remove the mail.
  const shared = `<p><b>CAUTION:</b> This email originated from outside your organization. ${long}</p><p>More</p>`;
  assert.equal(tidy(shared).result.banners, 0);
  assert.equal(tidy(shared).out, shared);
  assert.equal(tidy('<div dir="ltr">[EXTERNAL] Hi Oliver, quick one.</div>').out, '<div dir="ltr">Hi Oliver, quick one.</div>');
  assert.equal(tidy("<p>[EXT]: Hi</p>").out, "<p>Hi</p>");
  assert.equal(tidy("<p>Hi [EXTERNAL] there</p>").out, "<p>Hi [EXTERNAL] there</p>");
});

test("a signature after a lone -- line is dimmed, and a signature inside the fold is not", () => {
  const dashes = "<p>Text</p><p>-- </p><p>Dana Reyes</p><p>Northwind</p>";
  const d = tidy(dashes);
  assert.equal(d.result.signature, true);
  assert.equal(d.out, '<p>Text</p><p class="sig">-- </p><p class="sig">Dana Reyes</p><p class="sig">Northwind</p>');
  const inQuote = '<p>Hi</p><div class="gmail_quote"><div class="gmail_signature">x</div></div>';
  const q = tidy(inQuote);
  assert.equal(q.result.folded, "quote");
  assert.equal(q.result.signature, false);
  assert.equal(findAll(q.doc.body, (el) => el.className.split(" ").includes("sig")).length, 0);
});

test("plain text folds the > run with its attribution line, even when the attribution wraps", () => {
  const gmail = "Thanks George.\n\nOn Tue, Sep 2, 2026 at 9:18 AM George Bell <george@example.com> wrote:\n> Earlier line one\n> Earlier line two\n";
  const g = foldPlainText(gmail);
  assert.equal(g.text, "Thanks George.");
  assert.equal(g.quoted, "On Tue, Sep 2, 2026 at 9:18 AM George Bell <george@example.com> wrote:\n> Earlier line one\n> Earlier line two");
  const wrapped = "Thanks.\n\nOn Tue, Sep 2, 2026 at 9:18 AM George Bell <\ngeorge@example.com> wrote:\n> x";
  assert.ok(foldPlainText(wrapped).quoted?.startsWith("On Tue, Sep 2"));
  const outlook = "Will do.\n\n-----Original Message-----\nFrom: X\nSent: Y\nTo: Z\nSubject: S\n\nOld";
  assert.equal(foldPlainText(outlook).text, "Will do.");
  assert.ok(foldPlainText(outlook).quoted?.startsWith("-----Original Message-----"));
  const header = "Will do.\n\nFrom: X\nSent: Y\nTo: Z\nSubject: S\n\nOld";
  assert.ok(foldPlainText(header).quoted?.startsWith("From: X"));
  // Nothing before the quote: a forward stays open.
  const forward = "> a\n> b";
  assert.deepEqual(foldPlainText(forward), { text: "> a\n> b", sig: null, quoted: null });
  const nothing = "Just a line.";
  assert.deepEqual(foldPlainText(nothing), { text: "Just a line.", sig: null, quoted: null });
});

test("plain text drops a leading banner or [EXTERNAL] prefix and splits off a -- signature", () => {
  const banner = "CAUTION: This email originated from outside your organization. Do not click links.\n\nHi Oliver,\n\nBody\n-- \nDana\nNorthwind\n\nOn Tue, Sep 2, 2026 at 9:18 AM Oliver <o@a.ai> wrote:\n> Old";
  const b = foldPlainText(banner);
  assert.equal(b.text, "Hi Oliver,\n\nBody");
  assert.equal(b.sig, "-- \nDana\nNorthwind");
  assert.ok(b.quoted?.startsWith("On Tue"));
  assert.equal(foldPlainText("[EXTERNAL] Hi there").text, "Hi there");
  const later = "a\n\nb\n\nc\n\nd\n\nCaution: this email originated from outside.";
  assert.equal(foldPlainText(later).text, later);
});

const M1 = "<p>Hi Oliver,</p><p>We are set for Tuesday. Could you send the session plan and the first invoice before then?</p><p>Dana</p>";
const M2 = "<p>Yes. Plan and invoice go out today.</p>";
const M3 = "<p>Sounds good, see you Tuesday.</p><p>Dana</p>" + M2 + M1;

test("a reply that pastes the earlier messages as plain paragraphs folds the repeated tail and keeps its own sign-off", () => {
  const priors = [htmlToText(M1), htmlToText(M2)];
  const t = tidy(M3, priors);
  assert.equal(t.result.folded, "repeat");
  assert.equal(t.visible, "Sounds good, see you Tuesday.\nDana");
  assert.equal(t.out, `<p>Sounds good, see you Tuesday.</p><p>Dana</p><details class="quote-fold">${SUMMARY}<div class="quote-fold-body">${M2}${M1}</div></details>`);
  // One new sentence over pasted history folds from the second block; the first block never folds.
  const short = tidy(M2 + M1, priors);
  assert.equal(short.result.folded, "repeat");
  assert.equal(short.visible, "Yes. Plan and invoice go out today.");
  // One shared sentence is not history.
  assert.equal(tidy("<p>Agreed.</p>" + M2, priors).result.folded, null);
  // Without earlier messages there is nothing to compare against.
  assert.equal(tidy(M3).result.folded, null);
  // Whitespace, case, and > prefixes do not break the match.
  const loose = "<p>Sounds good.</p><p>Dana</p><p>YES.  Plan and invoice<br>go out today.</p><p>Hi Oliver,</p><p>We are set for Tuesday. Could you send the session plan and the first invoice before then?</p>";
  assert.equal(tidy(loose, priors).visible, "Sounds good.\nDana");
});

test("repeated paragraphs before a structural quote join the same fold, and plain text folds repeats too", () => {
  const html = M3.replace("</p>" + M1, "</p>") + M1.replace(/<\/?p>/g, "") + '<div class="gmail_quote"><div class="gmail_attr">On Tue wrote:</div><blockquote class="gmail_quote">older</blockquote></div>';
  const priors = [htmlToText(M1), htmlToText(M2)];
  const t = tidy("<p>Sounds good, see you Tuesday.</p><p>Dana</p>" + M2 + M1 + '<div class="gmail_quote"><blockquote class="gmail_quote">older</blockquote></div>', priors);
  assert.equal(t.result.folded, "quote+repeat");
  assert.equal(findAll(t.doc.body, (el) => el.tag === "details").length, 1);
  assert.ok(t.foldBody && innerHtml(t.foldBody as MiniElement).startsWith(M2 + M1 + '<div class="gmail_quote">'), t.out);
  assert.equal(t.visible, "Sounds good, see you Tuesday.\nDana");
  assert.equal(html.length > 0, true);
  const text = "Sounds good, see you Tuesday.\n\nDana\n\nYes. Plan and invoice go out today.\n\nHi Oliver,\n\nWe are set for Tuesday. Could you send the session plan and the first invoice before then?\n\nDana";
  const p = foldPlainText(text, priors);
  assert.equal(p.text, "Sounds good, see you Tuesday.\n\nDana");
  assert.equal(p.quoted, "Yes. Plan and invoice go out today.\n\nHi Oliver,\n\nWe are set for Tuesday. Could you send the session plan and the first invoice before then?\n\nDana");
});

test("repeat matching helpers: normalisation, tail search, html to text, and which body text is used", () => {
  assert.equal(normaliseRepeatText("> Hi  There\n>> second\n-- \nsig"), "hi there second");
  assert.equal(repeatedTailStart(["own text here", "one long enough sentence", "another long enough one"], ["prefix one long enough sentence another long enough one suffix"]), 1);
  assert.equal(repeatedTailStart(["own text here", "", "one long enough sentence", "another long enough one"], ["one long enough sentence another long enough one"]), 2);
  assert.equal(repeatedTailStart(["one long enough sentence", "another long enough one"], ["one long enough sentence another long enough one"]), -1, "the first block never folds");
  assert.equal(repeatedTailStart(["own", "short"], ["short"]), -1);
  assert.equal(repeatedTailStart(["own", "a sentence long enough to count"], ["a sentence long enough to count"]), -1, "one paragraph is not history");
  assert.equal(htmlToText("<style>p{}</style><p>Hi &amp; bye</p><div>x<br>y</div>"), "Hi & bye\nx\ny");
  assert.equal(messageText({ html: "<p>h</p>", text: "t" }), "t");
  assert.equal(messageText({ html: "<p>h</p>", text: "  " }), "h");
  assert.equal(messageText({ html: null, text: null }), null);
  assert.equal(messageText(null), null);
});

// ---- Trailing regions: signature, legal notice, client footer, bulk footer, link farms ----

import { findTrailingRegion, foldLabels, isLegalText, isPostalAddressLine, isProse, isTrackingImage } from "./mailhtml";

test("a signature that is the only thing below the message keeps its first two lines and folds the rest", () => {
  const html = "<p>The plan and the invoice go out tonight.</p><p>-- </p><p>Dana Reyes</p><p>Head of Product, Northwind</p><p>+1 555 0100</p><p>northwind-coaching.example</p>";
  const t = tidy(html);
  assert.equal(t.visible, "The plan and the invoice go out tonight.\n--\nDana Reyes\nHead of Product, Northwind");
  assert.equal(t.label, "Show signature, 2 lines");
  assert.equal(t.hideLabel, "Hide signature");
  assert.equal(t.quoted, "+1 555 0100\n\nnorthwind-coaching.example");
  assert.equal(t.result.signature, true);
  // Two lines is the whole signature, so there is nothing to put behind a toggle.
  assert.equal(tidy("<p>Text</p><p>-- </p><p>Dana Reyes</p><p>Northwind</p>").fold, null);
  // One block with the whole signature in it is cut at the line breaks.
  const oneBlock = tidy("<p>Sending the plan tonight, as promised.</p><div>-- <br>Dana Reyes<br>Head of Product<br>+1 555 0100<br>northwind-coaching.example</div>");
  assert.equal(oneBlock.visible, "Sending the plan tonight, as promised.\n--\nDana Reyes\nHead of Product");
  assert.equal(oneBlock.quoted, "+1 555 0100\nnorthwind-coaching.example");
});

test("a confidentiality notice folds, and the same words inside the message do not", () => {
  const notice = "This email and any attachments are confidential and may be privileged. If you are not the intended recipient, delete it and tell the sender.";
  const t = tidy(`<p>Redlines attached. The only open point is the termination notice period.</p><p>${notice}</p>`);
  assert.deepEqual(t.result.kinds, ["legal"]);
  assert.equal(t.label, "Show footer, 1 line");
  assert.equal(t.visible, "Redlines attached. The only open point is the termination notice period.");
  assert.ok(t.quoted.startsWith("This email and any attachments"));
  // Over 200 characters the block has to be mostly boilerplate: a message that mentions the phrase once stays.
  const mentions = "The contents of this email were agreed on the call this morning. We ship the plan on Tuesday and the invoice on Wednesday, then review both at the end of the month with the wider team before the next coaching block starts in October.";
  assert.equal(tidy(`<p>Hi Oliver, here is where we landed.</p><p>${mentions}</p>`).fold, null);
  assert.equal(isLegalText(mentions), false);
  const boilerplate = "This message is confidential and intended solely for the addressee. If you have received this in error, notify the sender and delete it. Unauthorised use or disclosure is prohibited. The contents of this email may not be copied.";
  assert.equal(isLegalText(boilerplate), true);
  assert.equal(isLegalText("Unauthorized disclosure is a breach of the agreement."), true);
  assert.equal(isLegalText("Two things about Tuesday."), false);
});

test("a phone or client footer folds on its own line", () => {
  for (const line of ["Sent from my iPhone", "Sent from my iPad", "Get Outlook for iOS", "Sent via Superhuman", "Sent with Shortwave", "Sent from Gmail Mobile"]) {
    const t = tidy(`<p>On my way now, should be there in about ten minutes.</p><p>${line}</p>`);
    assert.equal(t.label, "Show footer, 1 line", line);
    assert.equal(t.visible, "On my way now, should be there in about ten minutes.", line);
    assert.equal(t.quoted, line, line);
  }
  // The same words in a sentence are the message, not a footer.
  assert.equal(tidy("<p>Hi</p><p>I sent from my iPhone the wrong file this morning, sorry about the mix-up.</p>").fold, null);
});

test("a bulk mail footer folds as one region, tracking pixel and all", () => {
  const html =
    "<p>Five releases worth a look this week, including the new editor.</p>" +
    '<div><img src="https://t.example/p.gif" width="1" height="1"></div>' +
    "<div>You are receiving this because you subscribed to Product Weekly.</div>" +
    '<div><a href="https://product-weekly.example/u/1">Unsubscribe</a> | <a href="https://product-weekly.example/prefs">Manage preferences</a></div>' +
    "<div>Product Weekly, 1200 Market Street, Springfield, IL 62704</div>";
  const t = tidy(html);
  assert.equal(t.result.pixels, 1);
  assert.deepEqual(t.result.kinds, ["bulk"]);
  assert.equal(t.visible, "Five releases worth a look this week, including the new editor.");
  assert.equal(t.label, "Show footer, 3 lines");
  assert.ok(t.quoted.includes("Unsubscribe"));
  // View in browser and a privacy line count too.
  const other = tidy('<p>Your invoice for September is ready to download from the dashboard.</p><div><a href="https://x.example/w">View in browser</a></div><div>Privacy Policy | Terms</div>');
  assert.equal(other.label, "Show footer, 2 lines");
});

test("a tail of nothing but links folds once there are more than eight of them", () => {
  const link = (n: number) => `<div><a href="https://shop.example/c/${n}">Category ${n}</a></div>`;
  const tail = (n: number) => Array.from({ length: n }, (_, i) => link(i)).join("");
  const opening = "<p>Your order shipped this morning and arrives on Thursday.</p>";
  const t = tidy(opening + tail(9));
  assert.deepEqual(t.result.kinds, ["links"]);
  assert.equal(t.label, "Show footer, 9 lines");
  assert.equal(t.visible, "Your order shipped this morning and arrives on Thursday.");
  // Eight is a set of buttons, not a farm.
  assert.equal(tidy(opening + tail(8)).fold, null);
});

test("quoted history and a footer in the same message share one fold, and the label names both", () => {
  const html =
    "<p>Yes, Tuesday at nine works for me.</p><p>-- </p><p>Dana Reyes</p><p>Northwind</p>" +
    '<div>This message is confidential and intended solely for the addressee.</div>' +
    '<div class="gmail_quote"><div class="gmail_attr">On Tue, Sep 1, 2026 at 7:40 PM Oliver Korzen &lt;you@example.com&gt; wrote:<br></div><blockquote class="gmail_quote">Does nine suit you?</blockquote></div>';
  const t = tidy(html);
  assert.equal(t.visible, "Yes, Tuesday at nine works for me.");
  assert.deepEqual(t.result.kinds.sort(), ["legal", "quote", "signature"]);
  assert.equal(t.label, "Show quoted text, signature and footer, 6 lines");
  assert.equal(findAll(t.doc.body, (el) => el.tag === "details").length, 1, "one fold, not three");
  assert.equal(t.result.signature, true);
});

test("tracking pixels and spacers are removed outright, and a real picture is left alone", () => {
  const t = tidy('<p>Hi</p><img src="https://t.example/o.gif" width="1" height="1"><img src="https://t.example/s.gif" style="width:2px;height:400px"><img src="https://cdn.example/hero.png" width="600" height="300">');
  assert.equal(t.result.pixels, 2);
  assert.ok(t.out.includes("hero.png"), t.out);
  assert.equal(t.out.includes("o.gif"), false);
  assert.equal(t.out.includes("s.gif"), false);
});

test("nothing folds when the message would disappear behind the toggle", () => {
  const onlyFooter = '<div>You are receiving this because you subscribed to Product Weekly.</div><div><a href="https://x.example/u">Unsubscribe</a></div>';
  const f = tidy(onlyFooter);
  assert.equal(f.fold, null);
  assert.equal(f.out, onlyFooter);
  const onlyLegal = "<p>This message is confidential and intended solely for the addressee.</p>";
  assert.equal(tidy(onlyLegal).fold, null);
  const onlyClient = "<p>Sent from my iPhone</p>";
  assert.equal(tidy(onlyClient).fold, null);
  // A signature with no message above it keeps its first two lines, so the mail is never blank.
  const sigOnly = "<p>-- </p><p>Dana Reyes</p><p>Northwind</p><p>+1 555 0100</p>";
  assert.equal(tidy(sigOnly).visible, "--\nDana Reyes\nNorthwind");
});

test("the disclosure label says what is inside it and how many lines", () => {
  assert.equal(foldLabels(["quote"], 14).show, "Show quoted text, 14 lines");
  assert.equal(foldLabels(["repeat"], 2).show, "Show quoted text, 2 lines");
  assert.equal(foldLabels(["bulk"], 14).show, "Show footer, 14 lines");
  assert.equal(foldLabels(["signature"], 1).show, "Show signature, 1 line");
  assert.equal(foldLabels(["quote", "bulk"], 22).show, "Show quoted text and footer, 22 lines");
  assert.equal(foldLabels(["legal", "client", "bulk"], 5).show, "Show footer, 5 lines");
  assert.equal(foldLabels(["quote", "signature", "bulk"], 30).show, "Show quoted text, signature and footer, 30 lines");
  assert.equal(foldLabels(["quote"], 0).show, "Show quoted text");
  assert.equal(foldLabels(["bulk"], 3).hide, "Hide footer");
});

test("the region helpers: prose, postal addresses, tracking sizes, and where a region starts", () => {
  assert.equal(isProse("Could you send the session plan before Tuesday?"), true);
  assert.equal(isProse("Dana Reyes"), false);
  assert.equal(isProse("Unsubscribe"), false);
  assert.equal(isPostalAddressLine("Product Weekly, 1200 Market Street, Springfield, IL 62704"), true);
  assert.equal(isPostalAddressLine("Acme Ltd, 40 Rosebery Avenue, London, EC1R 4RX"), true);
  assert.equal(isPostalAddressLine("Studio Lumen, 12 Rue de la Paix, 75002 Paris, France"), true);
  assert.equal(isPostalAddressLine("Dana Reyes, Head of Product"), false);
  assert.equal(isPostalAddressLine("Tuesday at 9:00"), false);
  const img = (attrs: string) => find(parseHtml(`<img ${attrs}>`).body, (el) => el.tag === "img")!;
  assert.equal(isTrackingImage(img('src="x" width="1" height="1"')), true);
  assert.equal(isTrackingImage(img('src="x" height="3"')), true);
  assert.equal(isTrackingImage(img('src="x" style="width:1px;height:600px"')), true);
  assert.equal(isTrackingImage(img('src="x" width="600" height="300"')), false);
  assert.equal(isTrackingImage(img('src="x"')), false);
  const blocks = Array.from(parseHtml("<p>Hi Oliver, here is the plan you asked for on Tuesday.</p><p>-- </p><p>Dana</p>").body.childNodes);
  assert.deepEqual(findTrailingRegion(blocks), { start: 1, kinds: ["signature"] });
  assert.equal(findTrailingRegion(Array.from(parseHtml("<p>Hi Oliver, here is the plan you asked for on Tuesday.</p>").body.childNodes)), null);
});

import { stripBannerPrefix } from "./mailhtml";

// ---- the preview line -------------------------------------------------------------------------
// A gateway banner is identical on every message it is stamped on, so a list that previews it shows
// the same sentence on every row and tells the reader nothing about any of them.

test("stripBannerPrefix drops the banner and its advice, leaving what the message says", () => {
  const snippet =
    "CAUTION: This email originated from outside your organization. Do not click links or open attachments unless you recognize the sender and know the content is safe. Hi Oliver, We are set for Tuesday. Could you send the session plan?";
  assert.equal(stripBannerPrefix(snippet), "Hi Oliver, We are set for Tuesday. Could you send the session plan?");
});

test("a snippet with no banner is passed through, whitespace tidied", () => {
  assert.equal(stripBannerPrefix("  Redlines attached.\n The only open point is the term. "), "Redlines attached. The only open point is the term.");
});

test("an [EXTERNAL] tag comes off even when no banner sentence follows", () => {
  assert.equal(stripBannerPrefix("[EXTERNAL] Your August statement is ready."), "Your August statement is ready.");
});

test("a snippet that is nothing but banner keeps the banner, because an empty row is worse", () => {
  const onlyBanner = "CAUTION: This email originated from outside your organization.";
  assert.equal(stripBannerPrefix(onlyBanner), onlyBanner);
});

test("prose that merely mentions the outside is not mistaken for a banner", () => {
  const real = "This email originated from outside our usual process, so I wanted to flag it before we reply.";
  assert.equal(stripBannerPrefix(real), real, "the banner pattern must anchor at the start with a caution word");
});

test("stripping never eats the message when the banner runs unusually long", () => {
  const long = `CAUTION: ${"This email originated from outside your organization. ".repeat(20)}Hi Oliver.`;
  const out = stripBannerPrefix(long);
  assert.ok(out.length > 0);
  assert.ok(out.length <= long.length);
});

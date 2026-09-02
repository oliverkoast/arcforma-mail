import { test } from "node:test";
import assert from "node:assert/strict";
import { appendQuote, appendSignature, buildRawMessage, htmlToText } from "./send.js";

test("buildRawMessage carries threading headers and appends the signature", async () => {
  const built = await buildRawMessage({
    from: { email: "you@example.com", name: "Oliver Korzen" },
    to: [{ email: "maya@arcforma.ai", name: "Maya Glenn" }],
    subject: "Re: Kickoff",
    html: "<p>Works for me. See you Tuesday.</p>",
    inReplyTo: "<kickoff-1@arcforma.ai>",
    references: ["<kickoff-0@arcforma.ai>", "<kickoff-1@arcforma.ai>"],
    signatureHtml: '<div><b>Oliver Korzen</b><br>President, Arcforma AI Inc.</div>',
    messageId: "<reply-1@arcforma.ai>",
    date: new Date("2026-09-01T17:00:00Z"),
  });
  const mime = built.mime;
  assert.match(mime, /^From: "?Oliver Korzen"? <you@example.com>/m);
  assert.match(mime, /^To: "?Maya Glenn"? <maya@arcforma.ai>/m);
  assert.match(mime, /^Subject: Re: Kickoff/m);
  assert.match(mime, /^In-Reply-To: <kickoff-1@arcforma.ai>/m);
  assert.match(mime, /^References: <kickoff-0@arcforma.ai> <kickoff-1@arcforma.ai>/m);
  assert.match(mime, /^Message-ID: <reply-1@arcforma.ai>/m);
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /gmail_signature/);
  assert.match(mime, /President, Arcforma AI Inc\./);
  assert.match(mime, /Works for me\. See you Tuesday\./, "the plain text part is derived from the html");
  const decoded = Buffer.from(built.raw, "base64url").toString("utf8");
  assert.equal(decoded, mime, "raw is the base64url of the same MIME");
});

test("appendSignature and htmlToText", () => {
  assert.equal(appendSignature("<p>hi</p>", null), "<p>hi</p>");
  assert.match(appendSignature("<p>hi</p>", "<b>O</b>"), /<p>hi<\/p><br><br><div class="gmail_signature"/);
  assert.equal(htmlToText("<p>One</p><p>Two &amp; three</p>"), "One\nTwo & three");
});

test("the MIME is RFC 822: CRLF, encoded non-ASCII headers, quoted-printable bodies", async () => {
  const built = await buildRawMessage({
    from: { email: "you@example.com", name: "Ölïver Körzen" },
    to: [{ email: "zoe@example.com", name: 'Zoë "Z" Ångström' }],
    subject: "Ré: Café plan für Straße",
    html: `<p>Grüße from the café. ${"long line ".repeat(30)}</p>`,
  });
  const mime = built.mime;
  assert.equal(mime.includes("\r\n"), true);
  assert.equal(/[^\r]\n/.test(mime), false, "every line break is CRLF");
  assert.match(mime, /^From: =\?UTF-8\?[QB]\?[^\r\n]+\?= <you@example.com>/m);
  assert.match(mime, /^To: =\?UTF-8\?[QB]\?[^\r\n]+\?= <zoe@example.com>/m);
  assert.match(mime, /^Subject: =\?UTF-8\?[QB]\?/m);
  assert.equal(/^Subject: .*[^\x00-\x7f]/m.test(mime), false, "no raw non-ASCII in headers");
  assert.match(mime, /Content-Transfer-Encoding: quoted-printable/);
  for (const line of mime.split("\r\n")) assert.ok(line.length <= 998, `line too long: ${line.length}`);
  assert.equal(/[^\x00-\x7f]/.test(mime), false, "the whole message is 7-bit clean");
});

test("the signature is appended once, above the quoted history, and attachments are an explicit error", async () => {
  const built = await buildRawMessage({
    from: { email: "you@example.com", name: "Oliver" },
    to: [{ email: "dana@example.com", name: "" }],
    subject: "Re: Kickoff",
    html: "<p>9:00 works.</p>",
    quotedHtml: "<blockquote>Can we do 9:00?</blockquote>",
    signatureHtml: "<div>Oliver Korzen<br>Arcforma</div>",
  });
  const qp = (s: string) => s.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  const htmlPart = qp(built.mime.split("Content-Type: text/html")[1]!);
  assert.equal((htmlPart.match(/class="gmail_signature"/g) ?? []).length, 1, "one signature");
  assert.ok(htmlPart.indexOf("9:00 works") < htmlPart.indexOf("gmail_signature"), "body before signature");
  assert.ok(htmlPart.indexOf("gmail_signature") < htmlPart.indexOf("gmail_quote"), "signature before the quote");
  const textPart = qp(built.mime.split("Content-Type: text/plain")[1]!.split("Content-Type: text/html")[0]!);
  assert.ok(textPart.indexOf("Arcforma") < textPart.indexOf("Can we do 9:00?"), "the text part follows the same order");
  assert.equal(appendQuote("<p>a</p>", "  "), "<p>a</p>");
  await assert.rejects(
    buildRawMessage({ from: { email: "o@x.com", name: "" }, to: [{ email: "a@b.com", name: "" }], subject: "x", html: "<p>x</p>", attachments: [{ filename: "a.pdf", content: "x" }] }),
    /Attachments are not supported yet/
  );
});

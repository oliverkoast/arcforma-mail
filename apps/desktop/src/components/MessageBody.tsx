import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import type { MessageView } from "../../shared/types";
import { useApp } from "../state/store";
import { HIDE_QUOTED, PURIFY_CONFIG, SHOW_QUOTED, buildMessageCsp, foldPlainText, hardenNode, hasRemoteImages, tidyMessage, tooLarge, type HookNode, type MailDocument } from "../lib/mailhtml";

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// One DOMPurify instance for mail bodies, with the hardening hook attached
// once. DOMPurify parses into an inert document, so tracking pixels are not
// fetched while sanitizing; the iframe CSP decides what loads afterwards.
const purify = DOMPurify();
purify.addHook("afterSanitizeAttributes", (node) => hardenNode(node as unknown as HookNode));
purify.addHook("uponSanitizeElement", (node) => {
  if (node.nodeName.toLowerCase() === "style") hardenNode(node as unknown as HookNode);
});

const NO_PRIORS: string[] = [];

/**
 * Sanitized HTML in a sandboxed iframe. Remote images are blocked by CSP until
 * the sender is allowed. Quoted history sits behind a Show quoted text toggle,
 * gateway banners are dropped, and the signature is dimmed. priorTexts are the
 * earlier messages of the thread as plain text, oldest first, so history pasted
 * without quote markup folds too.
 */
export function MessageBody({ message, priorTexts = NO_PRIORS }: { message: MessageView; priorTexts?: string[] }) {
  const setLoadImages = useApp((s) => s.setLoadImages);
  const ref = useRef<HTMLIFrameElement>(null);
  const rawHtml = message.body?.html ?? null;
  const oversized = rawHtml ? tooLarge(rawHtml) : false;
  const html = oversized ? null : rawHtml;
  const remoteImages = html ? hasRemoteImages(html) : false;

  const srcdoc = useMemo(() => {
    if (!html) return null;
    const clean = purify.sanitize(html, PURIFY_CONFIG);
    // A DOMParser document has no browsing context, so nothing loads while the reading pass reshapes the body.
    const doc = new DOMParser().parseFromString(clean, "text/html");
    tidyMessage(doc as unknown as MailDocument, priorTexts);
    const body = doc.body.innerHTML;
    const csp = buildMessageCsp(message.loadImages);
    const vars = `--af-sans:${token("--af-sans")};--af-mono:${token("--af-mono")};--af-text:${token("--af-text")};--af-text-body:${token("--af-text-body")};--af-text-soft:${token("--af-text-soft")};--af-rule:${token("--af-rule")};--af-accent:${token("--af-accent")}`;
    return [
      "<!doctype html><html><head><meta charset=\"utf-8\">",
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      `<style>:root{${vars}}`,
      "body{margin:0;padding:2px 0 8px;font:15px/1.5 var(--af-sans);color:var(--af-text-body);overflow-wrap:anywhere}",
      "img{max-width:100%;height:auto}",
      "a{color:var(--af-accent)}",
      "blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:2px solid var(--af-rule);color:var(--af-text-soft)}",
      "pre{white-space:pre-wrap}table{max-width:100%}",
      // The quoted-history fold: a details element the CSS labels, so it works with scripts off. Mirrors .af-mono.
      "details.quote-fold{margin:10px 0 0}",
      "details.quote-fold>summary{list-style:none;cursor:pointer;display:inline-block;padding:2px 0;font:11px/1.6 var(--af-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--af-text-soft)}",
      "details.quote-fold>summary::-webkit-details-marker{display:none}",
      "details.quote-fold>summary .qf-hide{display:none}",
      "details.quote-fold[open]>summary .qf-show{display:none}",
      "details.quote-fold[open]>summary .qf-hide{display:inline}",
      ".quote-fold-body{margin-top:8px}",
      ".sig{color:var(--af-text-soft)}",
      "</style></head><body>",
      body,
      "</body></html>",
    ].join("");
  }, [html, message.loadImages, priorTexts]);

  const text = message.body?.text ?? null;
  const textFold = useMemo(() => (srcdoc || !text ? null : foldPlainText(text, priorTexts)), [srcdoc, text, priorTexts]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let cancelled = false;
    const fit = () => {
      if (cancelled) return;
      const doc = frame.contentDocument;
      if (!doc?.documentElement || !doc.body) return;
      // The body's own height first, so a fold closing can shrink the frame; the document's scroll height after, so nothing overflowing is clipped.
      frame.style.height = `${Math.max(40, Math.ceil(doc.body.getBoundingClientRect().height))}px`;
      const full = doc.documentElement.scrollHeight;
      if (full > frame.clientHeight) frame.style.height = `${full}px`;
    };
    const onLoad = () => {
      fit();
      // Show quoted text and Hide quoted text change the document height; toggle does not bubble, so listen in the capture phase.
      frame.contentDocument?.addEventListener("toggle", fit, true);
    };
    frame.addEventListener("load", onLoad);
    const timers = [200, 800, 2000].map((ms) => setTimeout(fit, ms));
    return () => {
      cancelled = true;
      frame.removeEventListener("load", onLoad);
      for (const t of timers) clearTimeout(t);
    };
  }, [srcdoc]);

  if (!message.body) return <div className="af-mono">Loading message</div>;

  return (
    <div className="message-body">
      {remoteImages ? (
        <div className="images-bar">
          {message.loadImages ? (
            <>
              <span>Images load from {message.from.email}.</span>
              <button onClick={() => void setLoadImages(message.from.email, false)}>Stop loading images</button>
            </>
          ) : (
            <>
              <span>Images from {message.from.email} are blocked.</span>
              <button onClick={() => void setLoadImages(message.from.email, true)}>Load images</button>
            </>
          )}
        </div>
      ) : null}
      {oversized ? <div className="af-mono">Message too large to render as HTML. Showing text.</div> : null}
      {srcdoc ? (
        // No allow-scripts, no allow-forms, no allow-top-navigation: links open through the window handler, which hands http(s) to the browser.
        <iframe ref={ref} title={`Message from ${message.from.email}`} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={srcdoc} />
      ) : textFold ? (
        <div className="message-text-wrap">
          <pre className="message-text">{textFold.text}</pre>
          {textFold.sig ? <pre className="message-text sig">{textFold.sig}</pre> : null}
          {textFold.quoted !== null ? (
            <details className="quote-fold">
              <summary>
                <span className="af-mono qf-show">{SHOW_QUOTED}</span>
                <span className="af-mono qf-hide">{HIDE_QUOTED}</span>
              </summary>
              <pre className="message-text message-text-quoted">{textFold.quoted}</pre>
            </details>
          ) : null}
        </div>
      ) : (
        <pre className="message-text">{message.body.text ?? message.snippet}</pre>
      )}
    </div>
  );
}

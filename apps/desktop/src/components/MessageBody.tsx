import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import type { MessageView } from "../../shared/types";
import { useApp } from "../state/store";
import { PURIFY_CONFIG, buildMessageCsp, hardenNode, hasRemoteImages, tooLarge, type HookNode } from "../lib/mailhtml";

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

/** Sanitized HTML in a sandboxed iframe. Remote images are blocked by CSP until the sender is allowed. */
export function MessageBody({ message }: { message: MessageView }) {
  const setLoadImages = useApp((s) => s.setLoadImages);
  const ref = useRef<HTMLIFrameElement>(null);
  const rawHtml = message.body?.html ?? null;
  const oversized = rawHtml ? tooLarge(rawHtml) : false;
  const html = oversized ? null : rawHtml;
  const remoteImages = html ? hasRemoteImages(html) : false;

  const srcdoc = useMemo(() => {
    if (!html) return null;
    const clean = purify.sanitize(html, PURIFY_CONFIG);
    const csp = buildMessageCsp(message.loadImages);
    const vars = `--af-sans:${token("--af-sans")};--af-text:${token("--af-text")};--af-text-body:${token("--af-text-body")};--af-text-soft:${token("--af-text-soft")};--af-rule:${token("--af-rule")};--af-accent:${token("--af-accent")}`;
    return [
      "<!doctype html><html><head><meta charset=\"utf-8\">",
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      `<style>:root{${vars}}`,
      "body{margin:0;padding:2px 0 8px;font:15px/1.5 var(--af-sans);color:var(--af-text-body);overflow-wrap:anywhere}",
      "img{max-width:100%;height:auto}",
      "a{color:var(--af-accent)}",
      "blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:2px solid var(--af-rule);color:var(--af-text-soft)}",
      "pre{white-space:pre-wrap}table{max-width:100%}",
      "</style></head><body>",
      clean,
      "</body></html>",
    ].join("");
  }, [html, message.loadImages]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let cancelled = false;
    const fit = () => {
      if (cancelled) return;
      const doc = frame.contentDocument;
      if (doc?.documentElement) frame.style.height = `${Math.max(40, doc.documentElement.scrollHeight)}px`;
    };
    frame.addEventListener("load", fit);
    const timers = [200, 800, 2000].map((ms) => setTimeout(fit, ms));
    return () => {
      cancelled = true;
      frame.removeEventListener("load", fit);
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
      ) : (
        <pre className="message-text">{message.body.text ?? message.snippet}</pre>
      )}
    </div>
  );
}

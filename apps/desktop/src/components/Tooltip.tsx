import { useEffect, useRef, useState } from "react";
import { TIP_DELAY_MS, anyTruncated, placeTooltip } from "../lib/tooltip";

/**
 * The one tooltip layer, mounted once in App. Any element with data-tip (or,
 * as a fallback, a title or an aria-label on a control) gets a small card
 * after the pointer has rested on it for 700 ms: the text, and the key from
 * data-key when there is one. It hides at once on leave, key press, click,
 * or scroll. Native title bubbles never double up: the first hover moves a
 * title into data-tip and removes it.
 *
 * data-tip-if-truncated holds a selector; the card then shows only when one
 * of the matching descendants has its text cut off, so a thread row explains
 * itself only when the row could not.
 *
 * No shadow: the brand declares no shadow token (qa/FINDINGS.md F-MAIL-03),
 * so the card separates with its 1 px rule edge alone.
 */

interface Tip {
  text: string;
  key: string | null;
  anchor: Element;
}

/** Controls whose aria-label can stand in for a missing data-tip. Sections and regions carry aria-labels too, and those are not tooltips. */
const CONTROL = "button, a[href], input, select, textarea, summary, [role='button'], [role='option'], [role='gridcell'], [role='separator']";
const CANDIDATE = "[data-tip], [title], [aria-label]";

/** Moves a native title into data-tip the moment the pointer arrives, before the browser's own bubble is due. */
function adoptTitle(el: Element): void {
  if (el.tagName === "IFRAME") return;
  const title = el.getAttribute("title");
  if (title === null) return;
  if (!el.hasAttribute("data-tip")) el.setAttribute("data-tip", title);
  el.removeAttribute("title");
}

function resolve(target: Element): Tip | null {
  let el: Element | null = target;
  while (el && el !== document.documentElement) {
    if (el.tagName === "IFRAME") return null;
    adoptTitle(el);
    const tip = el.getAttribute("data-tip");
    if (tip !== null) {
      if (tip === "") return null;
      const when = el.getAttribute("data-tip-if-truncated");
      if (when && !anyTruncated(Array.from(el.querySelectorAll<HTMLElement>(when)))) return null;
      return { text: tip, key: el.getAttribute("data-key"), anchor: el };
    }
    const aria = el.getAttribute("aria-label");
    if (aria && el.matches(CONTROL)) return { text: aria, key: el.getAttribute("data-key"), anchor: el };
    el = el.parentElement;
  }
  return null;
}

export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armed: Element | null = null;
    let shown: Element | null = null;
    // After a click, key, or scroll the card stays away until the pointer moves to another element.
    let suppressed: Element | null = null;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      armed = null;
    };
    const hide = () => {
      clear();
      if (shown) {
        shown = null;
        setTip(null);
        setPos(null);
      }
    };
    const arm = (target: Element) => {
      const candidate = target.closest(CANDIDATE);
      if (!candidate) {
        hide();
        return;
      }
      if (candidate === armed || candidate === shown || candidate === suppressed) return;
      hide();
      suppressed = null;
      armed = candidate;
      adoptTitle(candidate);
      timer = setTimeout(() => {
        timer = null;
        if (!armed || !armed.isConnected) return;
        const t = resolve(armed);
        if (!t) return;
        shown = t.anchor;
        setTip(t);
      }, TIP_DELAY_MS);
    };
    const onOver = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && t.nodeType === 1) arm(t);
    };
    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      const current = shown ?? armed;
      if (!current) return;
      if (to && current.contains(to)) return;
      if (to === null || !document.contains(to)) {
        hide();
        return;
      }
      if (!current.contains(to)) hide();
    };
    const dismiss = () => {
      suppressed = shown ?? armed;
      hide();
    };
    window.addEventListener("mouseover", onOver, true);
    window.addEventListener("mousemove", onOver, { capture: true, passive: true });
    window.addEventListener("mouseout", onOut, true);
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      clear();
      window.removeEventListener("mouseover", onOver, true);
      window.removeEventListener("mousemove", onOver, true);
      window.removeEventListener("mouseout", onOut, true);
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("mousedown", dismiss, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("blur", dismiss);
    };
  }, []);

  // Measure the card once it has rendered, then place it against the element.
  useEffect(() => {
    if (!tip || !card.current) return;
    const r = tip.anchor.getBoundingClientRect();
    const c = card.current.getBoundingClientRect();
    const p = placeTooltip({ left: r.left, top: r.top, width: r.width, height: r.height }, { width: c.width, height: c.height }, { width: window.innerWidth, height: window.innerHeight });
    setPos({ left: p.left, top: p.top });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={card} className={`tip${pos ? " is-placed" : ""}`} role="tooltip" style={pos ? { left: pos.left, top: pos.top } : undefined}>
      <span className="tip-text">{tip.text}</span>
      {tip.key ? <span className="tip-key">{tip.key}</span> : null}
    </div>
  );
}

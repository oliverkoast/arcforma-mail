import { useCallback, useEffect, useRef } from "react";
import { useApp } from "../state/store";

const MIN = 260;
const MAX = 900;
const SIDEBAR = 240;
const RAIL = 320;
/** The reading pane needs at least this much; dragging the list past it hides the pane. */
const READING_MIN = 300;
const DEFAULT = 440;
const KEY = "arcmail.listWidth";

/** Widest the list may be right now: what fits beside the sidebar, the rail, and a minimal reading pane. */
export function maxListWidth(railOpen: boolean): number {
  return window.innerWidth - SIDEBAR - (railOpen ? RAIL : 0) - READING_MIN - 6;
}

export function readListWidth(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= MIN && v <= MAX ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/**
 * The handle between the thread list and the reading pane. Drag to resize the list; double-click
 * resets. The width lives in a CSS variable on the app grid so both panes follow it instantly.
 */
export function PaneSplitter() {
  const dragging = useRef(false);
  const setReadingPane = useApp((s) => s.setReadingPane);
  const rail = useApp((s) => s.rail);

  const apply = useCallback((px: number) => {
    const w = Math.max(MIN, Math.min(MAX, Math.round(px)));
    document.documentElement.style.setProperty("--list-width", `${w}px`);
    try { localStorage.setItem(KEY, String(w)); } catch { /* storage may be unavailable */ }
  }, []);

  useEffect(() => {
    // Keep the list inside the window at all times. A resize that leaves no room for the reading
    // pane hides it; Enter on a row brings it back.
    const fit = () => {
      const cap = maxListWidth(rail !== "none");
      if (cap < MIN) { setReadingPane(false); return; }
      const w = Math.min(readListWidth(), cap);
      document.documentElement.style.setProperty("--list-width", `${w}px`);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [rail, setReadingPane]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.classList.add("is-resizing");
    const move = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const wanted = ev.clientX - SIDEBAR;
      if (wanted > maxListWidth(rail !== "none") + 40) {
        // Past the point where a reading pane still fits: hide it and let the list run full width.
        dragging.current = false;
        up();
        setReadingPane(false);
        return;
      }
      apply(Math.min(wanted, maxListWidth(rail !== "none")));
    };
    const up = () => {
      dragging.current = false;
      document.body.classList.remove("is-resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className="pane-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the thread list"
      title="Drag to resize. Double-click to reset."
      onMouseDown={onMouseDown}
      onDoubleClick={() => apply(DEFAULT)}
    />
  );
}

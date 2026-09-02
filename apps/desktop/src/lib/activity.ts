// Reports keyboard and mouse activity to the main process, throttled, so the
// store can tell when a day begins for Daily 0. Only interaction inside the
// focused window counts: a window sitting open overnight reports nothing.

export const ACTIVITY_THROTTLE_MS = 30_000;

const EVENTS = ["keydown", "mousedown", "mousemove", "wheel"] as const;

/**
 * Installs the listeners and returns the uninstall. `report` receives the
 * activity time at most once per throttle window; the first event reports
 * immediately so the morning rollover does not wait.
 */
export function installActivityTracker(report: (at: number) => void, opts: { throttleMs?: number; now?: () => number; focused?: () => boolean } = {}): () => void {
  const throttleMs = opts.throttleMs ?? ACTIVITY_THROTTLE_MS;
  const now = opts.now ?? Date.now;
  const focused = opts.focused ?? (() => document.hasFocus());
  let lastReported = 0;
  const handler = () => {
    if (!focused()) return;
    const t = now();
    if (t - lastReported < throttleMs) return;
    lastReported = t;
    report(t);
  };
  for (const e of EVENTS) window.addEventListener(e, handler, { passive: true, capture: true });
  return () => {
    for (const e of EVENTS) window.removeEventListener(e, handler, { capture: true });
  };
}

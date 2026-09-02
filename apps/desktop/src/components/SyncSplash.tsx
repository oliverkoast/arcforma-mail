import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../state/store";

const W = 480;
const H = 160;
const CELL = 8;
const SETTLE_MS = 600;

/** Backfill progress across every account still syncing, 0 to 1, or null while no total is known yet. */
export function backfillProgress(progress: Record<string, { done: number; total: number | null; finished: boolean }>): { p: number | null; done: number; total: number; anyFinished: boolean; allFinished: boolean } {
  const all = Object.values(progress);
  const active = all.filter((x) => !x.finished);
  const done = active.reduce((n, x) => n + x.done, 0);
  const total = active.reduce((n, x) => n + (x.total ?? 0), 0);
  const known = active.some((x) => x.total !== null) && total > 0;
  return { p: known ? Math.min(1, done / total) : null, done, total, anyFinished: all.some((x) => x.finished), allFinished: all.length > 0 && all.every((x) => x.finished) };
}

/**
 * The house dither resolve, driven by real backfill progress. The fill only
 * ever rises (one-shot: a total that grows never pulls cells back), eases
 * toward the latest figure, and resolves fully once every account is live.
 * Under prefers-reduced-motion the resolved state is drawn straight away.
 */
export function SyncSplash() {
  const progress = useApp((s) => s.progress);
  const accounts = useApp((s) => s.status.accounts);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cells = useMemo(() => window.DS?.dither(W, H, { cell: CELL, seed: 7 }) ?? [], []);
  const reduced = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  const { p, done, total, allFinished } = backfillProgress(progress);
  // Target never goes backwards. Unknown totals show a small opening fill.
  const targetRef = useRef(0);
  const target = allFinished ? 1 : p === null ? 0.12 : Math.max(0.12, p);
  targetRef.current = Math.max(targetRef.current, target);
  const [shown, setShown] = useState(() => (reduced ? 1 : 0));

  useEffect(() => {
    if (reduced) {
      setShown(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = shown;
    const to = targetRef.current;
    if (to <= from) return;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / SETTLE_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Re-run only when the target moves; `shown` is read once as the tween origin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef.current, reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const DS = window.DS;
    if (!canvas || !DS) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    DS.drawDither(ctx, cells, reduced ? 1 : shown, { cell: CELL, fill: DS.color["cobalt"] });
  }, [cells, shown, reduced]);

  const syncing = accounts.filter((a) => a.syncState === "backfill" || a.syncState === "new").map((a) => a.email);
  const percent = Math.round((reduced ? 1 : shown) * 100);

  return (
    <div className="splash" role="status" aria-live="polite" data-progress={percent}>
      <canvas ref={canvasRef} style={{ width: W, height: H }} />
      <div className="splash-text">
        <span className="af-mono">{allFinished ? "Synced" : "Syncing"}</span>
        <span>{p !== null ? `${done} of ${total} threads` : allFinished ? "Opening your inbox" : "Reading the last 90 days"}</span>
        <span className="af-mono">{syncing.join(" · ")}</span>
      </div>
    </div>
  );
}

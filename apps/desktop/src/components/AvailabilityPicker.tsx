import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { insertComposeText } from "./ComposeEditor";
import { invoke, on } from "../bridge";
import { useApp } from "../state/store";
import { atHour, coalesce, formatSlots, isBusy, SLOT_MS, systemTimeZone, timeZoneLabel, type Interval } from "../../shared/availability";
import type { BusyBlock } from "../../shared/types";

const START_HOUR = 8;
const END_HOUR = 18;
const ROWS = (END_HOUR - START_HOUR) * 2;

type CellState = "free" | "busy" | "past";

interface Drag {
  day: number;
  from: number;
  to: number;
  /** Dragging from an already selected slot clears instead of adding. */
  clearing: boolean;
}

const key = (day: number, row: number) => `${day}:${row}`;

/**
 * A week of 30-minute cells, busy blocks merged across every account. Click
 * or drag over free cells to pick them; Insert times writes one line per
 * range into the open compose at the caret.
 */
export function AvailabilityPicker({ days }: { days: number[] }) {
  const compose = useApp((s) => s.compose);
  const openCompose = useApp((s) => s.openCompose);
  const showToast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState<BusyBlock[] | null>(null);
  const [busyError, setBusyError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const gridRef = useRef<HTMLDivElement>(null);
  const tz = useMemo(() => systemTimeZone(), []);
  const tzLabel = useMemo(() => timeZoneLabel(tz, now), [tz, now]);

  const from = days[0] ?? now;
  const to = (days[days.length - 1] ?? now) + 86_400_000;
  const load = useCallback(async () => {
    try {
      setBusy(await invoke("calendar:busy", from, to));
      setBusyError(null);
    } catch (err) {
      // An all-free grid on a failed read would hand out times that are taken. Keep the last good blocks, block Insert if there are none.
      setBusyError((err as Error).message);
    }
  }, [from, to]);
  useEffect(() => {
    void load();
    const off = on("calendar:changed", () => void load());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [load]);

  const slotAt = useCallback(
    (day: number, row: number): Interval => {
      const start = atHour(days[day] ?? from, START_HOUR + Math.floor(row / 2), (row % 2) * 30);
      return { start, end: start + SLOT_MS };
    },
    [days, from]
  );
  const stateOf = useCallback(
    (day: number, row: number): CellState => {
      const s = slotAt(day, row);
      if (s.end <= now) return "past";
      return isBusy(busy ?? [], s.start, s.end) ? "busy" : "free";
    },
    [busy, now, slotAt]
  );

  const applyDrag = useCallback(
    (d: Drag) => {
      setSelected((cur) => {
        const next = new Set(cur);
        const lo = Math.min(d.from, d.to);
        const hi = Math.max(d.from, d.to);
        for (let r = lo; r <= hi; r++) {
          if (stateOf(d.day, r) !== "free") continue;
          if (d.clearing) next.delete(key(d.day, r));
          else next.add(key(d.day, r));
        }
        return next;
      });
    },
    [stateOf]
  );

  useEffect(() => {
    if (!drag) return;
    const up = () => {
      applyDrag(drag);
      setDrag(null);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [drag, applyDrag]);

  const cellFrom = (target: EventTarget | null): { day: number; row: number } | null => {
    const el = (target as HTMLElement | null)?.closest?.("[data-day]") as HTMLElement | null;
    if (!el) return null;
    return { day: Number(el.dataset["day"]), row: Number(el.dataset["row"]) };
  };

  const slots = useMemo(() => {
    const out: Interval[] = [];
    for (const k of selected) {
      const [d, r] = k.split(":").map(Number);
      if (d === undefined || r === undefined) continue;
      out.push(slotAt(d, r));
    }
    return out.sort((a, b) => a.start - b.start);
  }, [selected, slotAt]);
  const lines = useMemo(() => formatSlots(slots, tz), [slots, tz]);

  const canInsert = lines.length > 0 && busy !== null;

  const insert = () => {
    if (!canInsert) return;
    const text = lines.join("\n");
    if (insertComposeText(text)) {
      showToast({ eyebrow: "INSERTED", text: `${lines.length} time${lines.length === 1 ? "" : "s"} added to the message.` });
      setSelected(new Set());
      return;
    }
    // No compose yet: open one and insert as soon as the editor is mounted.
    openCompose("new");
    let tries = 0;
    const retry = () => {
      if (insertComposeText(text)) {
        showToast({ eyebrow: "INSERTED", text: `${lines.length} time${lines.length === 1 ? "" : "s"} added to a new message.` });
        setSelected(new Set());
      } else if (tries++ < 20) setTimeout(retry, 100);
      else showToast({ eyebrow: "NOT INSERTED", text: "Open a message first, then press Insert times." });
    };
    setTimeout(retry, 100);
  };

  const removeLine = (index: number) => {
    // Lines are the coalesced ranges in order; drop every selected slot inside that range.
    const merged = coalesce(slots)[index];
    if (!merged) return;
    setSelected((cur) => {
      const next = new Set(cur);
      for (const k of cur) {
        const [d, r] = k.split(":").map(Number);
        if (d === undefined || r === undefined) continue;
        const s = slotAt(d, r);
        if (s.start >= merged.start && s.end <= merged.end) next.delete(k);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!window.__arcmailCalendar) return;
    window.__arcmailCalendar.pickDemo = () => {
      // Tomorrow, first three free half hours from 10:00.
      const day = Math.min(1, days.length - 1);
      const picks: string[] = [];
      for (let r = 4; r < ROWS && picks.length < 3; r++) if (stateOf(day, r) === "free") picks.push(key(day, r));
      setSelected(new Set(picks));
    };
  }, [days, stateOf]);

  const inDrag = (day: number, row: number) => drag && drag.day === day && row >= Math.min(drag.from, drag.to) && row <= Math.max(drag.from, drag.to);

  return (
    <div className="avail">
      <div className="avail-top">
        <span className="af-h3">Free times</span>
        <span className="af-mono">{tzLabel}</span>
      </div>
      <p className="rail-muted">Drag over free half hours. Busy blocks are merged across every account.</p>
      {busyError ? (
        <div className="contact-web-fail">
          <span className="af-mono eyebrow-flag">{busy === null ? "BUSY TIMES NOT READ" : "BUSY TIMES STALE"}</span>
          <span className="rail-muted">{busy === null ? `${busyError} Nothing can be inserted until the calendar reads.` : busyError}</span>
        </div>
      ) : busy === null ? (
        <p className="rail-muted">Reading busy times.</p>
      ) : null}
      <div
        className="avail-grid"
        ref={gridRef}
        role="grid"
        aria-label="Availability"
        onMouseDown={(e) => {
          const c = cellFrom(e.target);
          if (!c || stateOf(c.day, c.row) !== "free") return;
          e.preventDefault();
          setDrag({ day: c.day, from: c.row, to: c.row, clearing: selected.has(key(c.day, c.row)) });
        }}
        onMouseOver={(e) => {
          if (!drag) return;
          const c = cellFrom(e.target);
          if (c && c.day === drag.day) setDrag({ ...drag, to: c.row });
        }}
      >
        <div className="avail-corner" />
        {days.map((d, i) => (
          <div className="avail-col-head" key={d}>
            <span className="af-mono">{new Date(d).toLocaleDateString(undefined, { weekday: "short" })}</span>
            <span className="avail-col-day">{new Date(d).getDate()}</span>
          </div>
        ))}
        {Array.from({ length: ROWS }, (_, row) => (
          <div className="avail-row" key={row} style={{ display: "contents" }}>
            <div className="avail-row-head">{row % 2 === 0 ? <span className="af-mono">{String(START_HOUR + row / 2).padStart(2, "0")}:00</span> : null}</div>
            {days.map((d, day) => {
              const state = stateOf(day, row);
              const picked = selected.has(key(day, row));
              const dragging = inDrag(day, row) && state === "free";
              const cls = ["avail-cell", `is-${state}`, picked && !(dragging && drag?.clearing) ? "is-picked" : "", dragging && !drag?.clearing ? "is-picked" : "", row % 2 === 1 ? "is-half" : ""].filter(Boolean).join(" ");
              return <div className={cls} key={`${d}:${row}`} data-day={day} data-row={row} role="gridcell" aria-selected={picked} aria-label={`${new Date(slotAt(day, row).start).toLocaleString()} ${state}`} />;
            })}
          </div>
        ))}
      </div>
      <div className="avail-picks">
        {lines.length === 0 ? (
          <p className="rail-muted">Nothing picked yet.</p>
        ) : (
          lines.map((l, i) => (
            <div className="avail-pick" key={l}>
              <span>{l}</span>
              <button className="rail-link" onClick={() => removeLine(i)}>
                Remove
              </button>
            </div>
          ))
        )}
      </div>
      <div className="avail-actions">
        <button className="btn btn-sweep btn-compact" disabled={!canInsert} onClick={insert}>
          {compose ? "Insert times" : "Insert times in a new message"}
        </button>
        {lines.length > 0 ? (
          <button className="btn btn-ghost btn-compact" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

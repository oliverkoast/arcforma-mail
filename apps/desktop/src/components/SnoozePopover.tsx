import { useState } from "react";
import { useApp } from "../state/store";
import { inDays, nextMondayMorning, tomorrowMorning } from "../lib/format";

export function SnoozePopover() {
  const popover = useApp((s) => s.popover);
  const setPopover = useApp((s) => s.setPopover);
  const snoozeSelected = useApp((s) => s.snoozeSelected);
  const remindSelected = useApp((s) => s.remindSelected);
  const [when, setWhen] = useState("");
  if (!popover) return null;

  if (popover === "snoozePick") {
    return (
      <div className="popover" role="dialog" aria-label="Pick a date">
        <span className="af-mono">Snooze until</span>
        <div className="popover-row">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} autoFocus />
          <button
            className="btn btn-sweep btn-compact"
            disabled={!when}
            onClick={() => {
              const t = new Date(when).getTime();
              if (Number.isFinite(t)) void snoozeSelected(t);
            }}
          >
            Snooze
          </button>
        </div>
        <button className="popover-item" onClick={() => setPopover("snooze")}>
          <span>Back</span>
          <span className="af-mono">Esc</span>
        </button>
      </div>
    );
  }

  const item = (label: string, key: string, onClick: () => void) => (
    <button className="popover-item" onClick={onClick}>
      <span>{label}</span>
      <span className="af-mono">{key}</span>
    </button>
  );

  return (
    <div className="popover" role="dialog" aria-label="Snooze">
      <span className="af-mono">Snooze</span>
      {item("Tomorrow, 8:00", "T", () => void snoozeSelected(tomorrowMorning()))}
      {item("Next Monday, 8:00", "W", () => void snoozeSelected(nextMondayMorning()))}
      {item("Pick a date", "D", () => setPopover("snoozePick"))}
      <span className="af-mono">Remind</span>
      {item("If no reply in 3 days", "R", () => {
        setPopover(null);
        void remindSelected(inDays(3));
      })}
    </div>
  );
}

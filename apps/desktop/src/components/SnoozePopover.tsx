import { useState } from "react";
import { useApp } from "../state/store";
import { inDays, nextMondayMorning, tomorrowMorning } from "../lib/format";
import { keyLabel } from "../keys/keyLabel";

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
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} autoFocus data-tip="When the thread comes back to the inbox, in your time zone." />
          <button
            className="btn btn-sweep btn-compact"
            disabled={!when}
            data-tip="The thread leaves the inbox until that time, then comes back with a notification."
            onClick={() => {
              const t = new Date(when).getTime();
              if (Number.isFinite(t)) void snoozeSelected(t);
            }}
          >
            Snooze
          </button>
        </div>
        <button className="popover-item" data-tip="Back to the snooze choices." data-key={keyLabel("closePopover") ?? undefined} onClick={() => setPopover("snooze")}>
          <span>Back</span>
          <span className="af-mono">Esc</span>
        </button>
      </div>
    );
  }

  const item = (label: string, key: string, tip: string, onClick: () => void) => (
    <button className="popover-item" data-tip={tip} data-key={key} onClick={onClick}>
      <span>{label}</span>
      <span className="af-mono">{key}</span>
    </button>
  );

  return (
    <div className="popover" role="dialog" aria-label="Snooze">
      <span className="af-mono">Snooze</span>
      {item("Tomorrow, 8:00", "T", "The thread leaves the inbox until tomorrow at 8:00, then comes back with a notification.", () => void snoozeSelected(tomorrowMorning()))}
      {item("Next Monday, 8:00", "W", "The thread leaves the inbox until Monday at 8:00, then comes back with a notification.", () => void snoozeSelected(nextMondayMorning()))}
      {item("Pick a date", "D", "Choose any date and time for the thread to come back.", () => setPopover("snoozePick"))}
      <span className="af-mono">Remind</span>
      {item("If no reply in 3 days", "R", "The thread stays where it is. If nobody answers within three days it comes back with a NO REPLY BY eyebrow.", () => {
        setPopover(null);
        void remindSelected(inDays(3));
      })}
    </div>
  );
}

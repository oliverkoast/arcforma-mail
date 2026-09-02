import { CalendarPanel } from "./CalendarPanel";
import { ContactPanel } from "./ContactPanel";
import { useApp } from "../state/store";

/** The 320 px rail: calendar (Cmd+Shift+C) or the contact for the open thread's sender (Cmd+Shift+I). */
export function RightRail() {
  const rail = useApp((s) => s.rail);
  return (
    <aside className="rail" aria-label={rail === "calendar" ? "Calendar" : "Contact"}>
      {rail === "calendar" ? <CalendarPanel /> : <ContactPanel />}
    </aside>
  );
}

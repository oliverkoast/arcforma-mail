import { ipcMain } from "electron";
import { busyIntervals, listEventsInRange, type CalendarEventRow, type Db } from "@arcforma/store";
import type { CalendarSync } from "../calendar.js";
import { mergeBusy } from "../../shared/availability.js";
import type { BusyBlock, CalendarEventView } from "../../shared/types.js";

const MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1000;

export function toEventView(row: CalendarEventRow): CalendarEventView {
  let attendees: CalendarEventView["attendees"] = [];
  try {
    attendees = (JSON.parse(row.attendees_json) as Array<{ email: string; displayName?: string | null; responseStatus?: string | null; self?: boolean }>).map((a) => ({
      email: a.email,
      name: a.displayName ?? null,
      responseStatus: a.responseStatus ?? null,
      self: a.self === true,
    }));
  } catch {
    attendees = [];
  }
  return {
    accountId: row.account_id,
    id: row.id,
    summary: row.summary ?? "(no title)",
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: row.all_day === 1,
    busy: row.busy === 1,
    responseStatus: row.response_status,
    joinUrl: row.hangout_link,
    organizerEmail: row.organizer_email,
    attendees,
  };
}

function clampRange(from: number, to: number): [number, number] {
  const a = Number.isFinite(from) ? from : Date.now();
  const b = Number.isFinite(to) ? Math.min(to, a + MAX_RANGE_MS) : a + MAX_RANGE_MS;
  return [a, Math.max(a, b)];
}

export function registerCalendarIpc(db: Db, calendar: CalendarSync | null): void {
  ipcMain.handle("calendar:list", (_e, from: number, to: number): CalendarEventView[] => {
    const [a, b] = clampRange(from, to);
    return listEventsInRange(db, a, b).map(toEventView);
  });
  ipcMain.handle("calendar:busy", (_e, from: number, to: number): BusyBlock[] => {
    const [a, b] = clampRange(from, to);
    return mergeBusy(busyIntervals(db, a, b));
  });
  ipcMain.handle("calendar:syncNow", () => {
    void calendar?.runAll();
  });
}

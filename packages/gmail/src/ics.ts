// Reading a calendar invitation well enough to answer "what is this, and when".
//
// An .ics arrives as a MIME part next to the message body, and the body Google writes around it is
// a picture of a table: unreadable as text, and it does not say what changed when an invitation is
// updated. So the part itself is parsed, and the reading pane shows the event rather than the
// rendering of it.
//
// This is not a general iCalendar implementation and does not try to be. It reads one VEVENT and
// the fields a person needs to decide whether to go: what, when, where, who called it, who else is
// coming, and whether this message is an invitation, a change, or a cancellation.

export interface IcsAttendee {
  email: string;
  name: string;
  /** ACCEPTED, DECLINED, TENTATIVE, NEEDS-ACTION, or "" when the invitation does not say. */
  status: string;
  organizer: boolean;
}

export interface IcsEvent {
  /** REQUEST is an invitation, CANCEL a cancellation, REPLY someone answering one. */
  method: string;
  summary: string;
  location: string;
  description: string;
  /** Milliseconds. Null for a date with no time, which is what an all-day event has. */
  startsAt: number | null;
  endsAt: number | null;
  /** True when the event is a whole day and a clock time would be a lie. */
  allDay: boolean;
  /** The raw recurrence rule, if any. Shown as a plain sentence, never re-implemented. */
  recurrence: string;
  organizer: IcsAttendee | null;
  attendees: IcsAttendee[];
  /** CANCELLED when the event itself is off, whatever the method says. */
  status: string;
  /** Rises every time an invitation is revised, so anything above zero is a change, not a first ask. */
  sequence: number;
  uid: string;
}

/** Folded lines continue with a space or tab. Unfolding first is what makes everything else simple. */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

/** "DTSTART;TZID=America/Los_Angeles:20260914T090000" into its three pieces. */
function splitLine(line: string): { name: string; params: Map<string, string>; value: string } | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = head.split(";");
  const params = new Map<string, string>();
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params.set(p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, ""));
  }
  return { name: (name ?? "").toUpperCase(), params, value };
}

/** Text values escape commas, semicolons and newlines. Unescaping is what makes a description readable. */
function unescapeText(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/**
 * An iCalendar time to milliseconds.
 *
 * A trailing Z is UTC. A floating time, one with no zone and no Z, is left to the local zone, which
 * is what a calendar client does and is right far more often than guessing at the TZID would be.
 * A bare date is all-day and gets no clock time at all.
 */
export function parseIcsDate(value: string, params: Map<string, string>): { at: number | null; allDay: boolean } {
  const v = value.trim();
  if (params.get("VALUE") === "DATE" || /^\d{8}$/.test(v)) {
    const y = Number(v.slice(0, 4));
    const mo = Number(v.slice(4, 6));
    const d = Number(v.slice(6, 8));
    if (!y || !mo || !d) return { at: null, allDay: true };
    return { at: new Date(y, mo - 1, d).getTime(), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return { at: null, allDay: false };
  const [, y, mo, d, h, mi, sec, z] = m;
  const nums = [y, mo, d, h, mi, sec].map(Number) as [number, number, number, number, number, number];
  const at = z ? Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]) : new Date(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]).getTime();
  return { at, allDay: false };
}

function person(value: string, params: Map<string, string>, organizer: boolean): IcsAttendee {
  return {
    email: value.replace(/^mailto:/i, "").trim().toLowerCase(),
    name: unescapeText(params.get("CN") ?? "").trim(),
    status: (params.get("PARTSTAT") ?? "").toUpperCase(),
    organizer,
  };
}

/** Reads the first VEVENT out of an .ics. Null when there is not one, which is not an error. */
export function parseIcs(text: string): IcsEvent | null {
  if (!text || !/BEGIN:VEVENT/i.test(text)) return null;
  const lines = unfold(text);
  const event: IcsEvent = {
    method: "",
    summary: "",
    location: "",
    description: "",
    startsAt: null,
    endsAt: null,
    allDay: false,
    recurrence: "",
    organizer: null,
    attendees: [],
    status: "",
    sequence: 0,
    uid: "",
  };
  let inEvent = false;
  for (const line of lines) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;
    // METHOD sits outside the VEVENT, in the calendar itself.
    if (!inEvent && name === "METHOD") event.method = value.trim().toUpperCase();
    if (name === "BEGIN" && value.trim().toUpperCase() === "VEVENT") {
      inEvent = true;
      continue;
    }
    if (name === "END" && value.trim().toUpperCase() === "VEVENT") break;
    if (!inEvent) continue;
    switch (name) {
      case "SUMMARY":
        event.summary = unescapeText(value).trim();
        break;
      case "LOCATION":
        event.location = unescapeText(value).trim();
        break;
      case "DESCRIPTION":
        event.description = unescapeText(value).trim();
        break;
      case "DTSTART": {
        const d = parseIcsDate(value, params);
        event.startsAt = d.at;
        event.allDay = d.allDay;
        break;
      }
      case "DTEND":
        event.endsAt = parseIcsDate(value, params).at;
        break;
      case "RRULE":
        event.recurrence = value.trim();
        break;
      case "ORGANIZER":
        event.organizer = person(value, params, true);
        break;
      case "ATTENDEE":
        event.attendees.push(person(value, params, false));
        break;
      case "STATUS":
        event.status = value.trim().toUpperCase();
        break;
      case "SEQUENCE":
        event.sequence = Number(value.trim()) || 0;
        break;
      case "UID":
        event.uid = value.trim();
        break;
      default:
        break;
    }
  }
  return event;
}

/** The decoded text/calendar part of a message, or null. Kept here so the walker stays about MIME. */
export function findCalendarText(payload: unknown, decode: (data: string, charset?: string) => string): string | null {
  const part = payload as { mimeType?: string; filename?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!part) return null;
  const mime = (part.mimeType ?? "").toLowerCase();
  if ((mime.startsWith("text/calendar") || mime === "application/ics" || /\.ics$/i.test(part.filename ?? "")) && part.body?.data) {
    return decode(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const hit = findCalendarText(child, decode);
    if (hit) return hit;
  }
  return null;
}

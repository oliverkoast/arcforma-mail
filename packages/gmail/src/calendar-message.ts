import type { GmailClient } from "./client.js";
import { fetchAttachment, requestFor } from "./attachments.js";
import { findCalendarText, parseIcs, type IcsEvent } from "./ics.js";
import { decodeBody, type Attachment } from "./mime.js";

export function isCalendarAttachment(part: Pick<Attachment, "filename" | "mimeType">): boolean {
  return /^(text\/calendar|application\/(ics|icalendar))(;|$)/i.test(part.mimeType) || /\.ics$/i.test(part.filename);
}

/** Gmail may put even a tiny invitation behind a separate attachment request. */
export async function readCalendarMessage(client: Pick<GmailClient, "request">, messageId: string, payload: unknown, attachments: Attachment[]): Promise<IcsEvent | null> {
  const inline = parseIcs(findCalendarText(payload, decodeBody) ?? "");
  if (inline) return inline;
  for (const part of attachments.filter(isCalendarAttachment)) {
    const { bytes } = await fetchAttachment(client, requestFor(messageId, part));
    const event = parseIcs(bytes.toString("utf8"));
    if (event) return event;
  }
  return null;
}

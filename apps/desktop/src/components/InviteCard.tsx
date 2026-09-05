import type { CalendarInvite } from "../../shared/types";

/**
 * What a calendar invitation actually says, above the message that carried it.
 *
 * Google sends invitations as a picture of a table, which is unreadable as text and does not say
 * what changed when one is revised. This reads the message's own .ics instead, so the event is shown
 * rather than a rendering of it: what, when, where, who called it, and who has answered.
 *
 * Times come from the invitation and are shown in this machine's zone, which is the zone the day
 * will be lived in. An all-day event is shown as a day, never as midnight.
 */
function when(invite: CalendarInvite): string {
  if (invite.startsAt === null) return "No time given";
  const start = new Date(invite.startsAt);
  const day = start.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  if (invite.allDay) return `${day}, all day`;
  const from = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (invite.endsAt === null) return `${day}, ${from}`;
  const end = new Date(invite.endsAt);
  const sameDay = start.toDateString() === end.toDateString();
  const to = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(start).find((p) => p.type === "timeZoneName")?.value ?? "";
  return sameDay ? `${day}, ${from} to ${to} ${zone}`.trim() : `${day}, ${from} until ${end.toLocaleString(undefined, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/** What kind of message this is, in the words a person would use. */
function eyebrow(invite: CalendarInvite): string {
  if (invite.status === "CANCELLED" || invite.method === "CANCEL") return "CANCELLED";
  if (invite.method === "REPLY") return "REPLY TO AN INVITATION";
  // A revision, not a first ask. Worth saying, because the two look identical otherwise.
  if (invite.sequence > 0) return "UPDATED INVITATION";
  return "INVITATION";
}

/** ACCEPTED into "yes", so a list of answers reads as a list of answers. */
function answer(status: string): string {
  if (status === "ACCEPTED") return "yes";
  if (status === "DECLINED") return "no";
  if (status === "TENTATIVE") return "maybe";
  return "no answer";
}

export function InviteCard({ invite }: { invite: CalendarInvite }) {
  const going = invite.attendees.filter((a) => a.status === "ACCEPTED").length;
  const cancelled = invite.status === "CANCELLED" || invite.method === "CANCEL";
  return (
    <section className={`invite${cancelled ? " is-cancelled" : ""}`} aria-label="Calendar invitation">
      <div className="af-mono invite-eyebrow">{eyebrow(invite)}</div>
      <div className="invite-title">{invite.summary || "No title"}</div>
      <div className="invite-when">{when(invite)}</div>
      {invite.recurrence ? <div className="invite-repeat">Repeats. The series rule is {invite.recurrence}.</div> : null}
      {invite.location ? <div className="invite-where">{invite.location}</div> : null}
      {invite.organizer ? (
        <div className="invite-org">
          Called by {invite.organizer.name || invite.organizer.email}
        </div>
      ) : null}
      {invite.attendees.length > 0 ? (
        <details className="invite-people">
          <summary>
            {invite.attendees.length} invited{going > 0 ? `, ${going} said yes` : ""}
          </summary>
          <ul>
            {invite.attendees.map((a) => (
              <li key={a.email}>
                <span className="invite-person">{a.name || a.email}</span>
                <span className="af-mono invite-answer">{answer(a.status)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {invite.description ? <p className="invite-note">{invite.description}</p> : null}
    </section>
  );
}

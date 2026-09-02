import { useState, type ReactNode } from "react";
import { fullDate } from "../lib/format";
import { describeRecipients, initials, messageEyebrow, relativeTime, showSenderAddress } from "../lib/recipients";
import type { MessageView } from "../../shared/types";

/**
 * Who wrote a message, who else is on it, and when. The avatar carries the
 * sender's initials; the recipient line reads as a sentence and opens to the
 * full list, grouped To, Cc, and Bcc, with the owner's own addresses shown as
 * "you". The eyebrow appears only when the addressing is worth knowing.
 */
export function MessageHeader({ message, owners, repeatSender, actions }: { message: MessageView; owners: string[]; repeatSender: boolean; actions?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const people = describeRecipients(message.to, message.cc, message.bcc ?? [], owners);
  const eyebrow = messageEyebrow(message, owners);
  const own = new Set(owners.map((o) => o.toLowerCase()));
  const isOwner = own.has(message.from.email.toLowerCase());
  const name = message.from.name.trim() || message.from.email;
  const when = fullDate(message.internalDate);
  return (
    <div className="message-head">
      <div className={`message-avatar${isOwner ? " is-you" : ""}`} aria-hidden="true">
        {initials(message.from.name, message.from.email)}
      </div>
      <div className="message-who">
        {eyebrow ? <div className="af-mono message-eyebrow">{eyebrow}</div> : null}
        <div className="message-from">
          {name}
          {showSenderAddress(message.from, repeatSender) ? <span>{message.from.email}</span> : null}
        </div>
        <button
          type="button"
          className="message-to"
          aria-expanded={expanded}
          data-tip={expanded ? "Click to close the full list of recipients." : "Who else got this message. Click to show every address, grouped To, Cc, and Bcc."}
          onClick={() => setExpanded(!expanded)}
        >
          {people.to ? <span>to {people.to}</span> : null}
          {people.cc ? <span className="message-cc">cc {people.cc}</span> : null}
          {!people.to && !people.cc ? <span>{people.text}</span> : null}
        </button>
        {expanded && people.rows.length > 0 ? (
          <dl className="message-recipients">
            {people.rows.map((r, i) => (
              <div className="message-recipient" key={`${r.group}-${r.email}`}>
                <dt className="af-mono">{people.rows[i - 1]?.group === r.group ? "" : r.group}</dt>
                <dd>
                  <span className={r.you ? "message-recipient-you" : "message-recipient-name"}>{r.label}</span>
                  {r.label === r.email ? null : <span className="message-recipient-mail">{r.email}</span>}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <div className="message-meta">
        <div className="message-date" data-tip={when}>
          {relativeTime(message.internalDate)}
        </div>
        {actions}
      </div>
    </div>
  );
}

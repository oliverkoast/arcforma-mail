import type React from "react";
import { useState, type ReactNode } from "react";
import { fullDate } from "../lib/format";
import { describeRecipients, initials, messageEyebrow, relativeTime, showSenderAddress } from "../lib/recipients";
import { receiptLine } from "../lib/receipts";
import { Icon } from "./IconButton";
import { attachmentMarker } from "../lib/attachments";
import type { MessageView } from "../../shared/types";

/**
 * Who wrote a message, who else is on it, and when. The avatar carries the
 * sender's initials; the recipient line reads as a sentence and opens to the
 * full list, grouped To, Cc, and Bcc, with the owner's own addresses shown as
 * "you". The eyebrow appears only when the addressing is worth knowing.
 *
 * A message with files says so here, at the top, next to the date. The chips themselves sit under
 * the body, which on a long message is a screen or two away: an attachment nobody scrolls far enough
 * to see is an attachment that was not sent. Pressing the marker scrolls to them.
 *
 * A message you sent with a receipt armed also carries what the pixel service knows, under the date.
 * It reads "Opened", "Possibly automatic" or "No signal" and never a count of opens, because one
 * reader's client can fetch an image many times and a proxy can fetch it once for many people. The
 * hover sentence carries the limit, which the three words alone cannot.
 */
export function MessageHeader({ message, owners, repeatSender, actions, onCollapse }: { message: MessageView; owners: string[]; repeatSender: boolean; actions?: ReactNode; onCollapse?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const people = describeRecipients(message.to, message.cc, message.bcc ?? [], owners);
  const eyebrow = messageEyebrow(message, owners);
  const own = new Set(owners.map((o) => o.toLowerCase()));
  const isOwner = own.has(message.from.email.toLowerCase());
  const name = message.from.name.trim() || message.from.email;
  const when = fullDate(message.internalDate);
  const { count: files, exact } = attachmentMarker(message);
  // Clicking the header folds the message back to a row. Anything that is
  // already a control of its own keeps its own job: the recipient list, the
  // reply icons, the address rows.
  const headClick = onCollapse
    ? (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest("button, a, select, input, dl")) return;
        onCollapse();
      }
    : undefined;
  return (
    <div className={`message-head${onCollapse ? " is-collapsible" : ""}`} onClick={headClick}>
      <div className={`message-avatar${isOwner ? " is-you" : ""}`} aria-hidden="true">
        {initials(message.from.name, message.from.email)}
      </div>
      <div className="message-who">
        {eyebrow ? <div className="af-mono message-eyebrow">{eyebrow}</div> : null}
        {onCollapse ? (
          <button type="button" className="message-from message-fold" data-tip="Fold this message back to a single row." onClick={onCollapse}>
            {name}
            {showSenderAddress(message.from, repeatSender) ? <span>{message.from.email}</span> : null}
          </button>
        ) : (
          <div className="message-from">
            {name}
            {showSenderAddress(message.from, repeatSender) ? <span>{message.from.email}</span> : null}
          </div>
        )}
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
        {files > 0 ? (
          <button
            type="button"
            className="af-mono message-files"
            data-tip={exact ? `${files} ${files === 1 ? "file is" : "files are"} attached. Press to scroll down to them.` : "This message has files attached. Press to scroll down to them."}
            onClick={(e) => {
              e.stopPropagation();
              const block = (e.currentTarget.closest(".message") ?? e.currentTarget.parentElement)?.querySelector(".attachments");
              block?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }}
          >
            <Icon glyph="paperclip" />
            {exact ? <span>{files}</span> : null}
          </button>
        ) : null}
        {message.receipt ? (
          <div className={`af-mono message-receipt is-${message.receipt.status === "opened" ? "opened" : "quiet"}`} data-tip={message.receipt.tip}>
            {receiptLine(message.receipt)}
          </div>
        ) : null}
        {actions}
      </div>
    </div>
  );
}

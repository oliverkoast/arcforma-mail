import { useLayoutEffect, useMemo, useRef } from "react";
import { attachmentBusyId, useApp } from "../state/store";
import { COLLAPSE_ALL_LABEL, expandAllLabel, isUnread, rowSnippet } from "../lib/collapse";
import { bodyNotice } from "../lib/compose";
import { bytes, eyebrowDate, fullDate, sendsAt } from "../lib/format";
import { messageText } from "../lib/mailhtml";
import { initials, relativeTime } from "../lib/recipients";
import { keyLabel } from "../keys/keyLabel";
import { InstantReplies, SummaryCard } from "./AiCards";
import { InlineReply } from "./InlineReply";
import { IconButton, ReplyIcons, hint } from "./IconButton";
import { MessageBody } from "./MessageBody";
import { MessageHeader } from "./MessageHeader";
import { InviteCard } from "./InviteCard";
import type { AttachmentInfo, MessageView, RefileTarget, ThreadSummary } from "../../shared/types";

const NO_PRIORS: string[] = [];

const BUILTIN: Array<{ id: string; label: string }> = [
  { id: "newsletters", label: "Newsletters" },
  { id: "promotions", label: "Promotions" },
  { id: "jobs", label: "Jobs" },
  { id: "calendar", label: "Calendar" },
  { id: "notifications", label: "Notifications" },
  { id: "receipts", label: "Receipts" },
];

function currentFile(t: ThreadSummary): string {
  if (t.categoryId) return `cat:${t.categoryId}`;
  if (t.type) return `type:${t.type}`;
  return t.split === "important" ? "important" : "other";
}

function targetFor(value: string): RefileTarget {
  if (value === "important") return { split: "important", category: null };
  if (value === "other") return { split: "other", category: null };
  if (value.startsWith("type:")) return { split: "other", category: value.slice(5) };
  return { split: "important", category: value.slice(4) };
}

function RefileSelect() {
  const open = useApp((s) => s.open);
  const categories = useApp((s) => s.categories);
  const refile = useApp((s) => s.refile);
  if (!open) return null;
  return (
    <label className="refile" data-tip="Where this thread is filed: Important, Other, a type, or a category. Changing it teaches the classifier and mirrors the label to Gmail.">
      <span className="af-mono">File under</span>
      <select value={currentFile(open.thread)} onChange={(e) => void refile(targetFor(e.target.value))}>
        <option value="important">Important</option>
        <option value="other">Other</option>
        {BUILTIN.map((b) => (
          <option key={b.id} value={`type:${b.id}`}>
            {b.label}
          </option>
        ))}
        {categories
          .filter((c) => c.kind === "custom")
          .map((c) => (
            <option key={c.id} value={`cat:${c.id}`}>
              {c.name}
            </option>
          ))}
      </select>
    </label>
  );
}

/** What clicking a chip will do, in the words the tooltip uses. */
function previewPromise(a: AttachmentInfo): string {
  switch (a.preview) {
    case "image":
      return "Opens this image in its own window.";
    case "pdf":
      return "Opens this PDF in its own window.";
    case "text":
      return "Opens this file as text in its own window. Nothing in it is run.";
    default:
      return "Opens a window saying this kind of file has no preview here, with Download and Save as.";
  }
}

/**
 * The attachments on one message. Each chip is a button: pressing it (or Enter
 * on it, since it is in the tab order) fetches the bytes if they are not
 * already on this machine and opens the preview window. The Download glyph
 * beside it puts a copy in Downloads instead. Neither ever opens the file in
 * another app.
 */
function Attachments({ message }: { message: MessageView }) {
  const busy = useApp((s) => s.attachmentsBusy);
  const previewAttachment = useApp((s) => s.previewAttachment);
  const downloadAttachment = useApp((s) => s.downloadAttachment);
  const files = (message.body?.attachments ?? []).filter((a) => !a.inline);
  if (files.length === 0) return null;
  return (
    <div className="attachments">
      {files.map((a) => {
        const working = busy.includes(attachmentBusyId(message.accountId, message.id, a.key));
        return (
          <span className={`attachment${working ? " is-busy" : ""}`} key={a.key}>
            <button
              type="button"
              className="attachment-open"
              disabled={working}
              data-tip={`${a.filename}, ${bytes(a.size)}. ${previewPromise(a)}`}
              onClick={() => void previewAttachment(message.accountId, message.id, a.key)}
            >
              {working ? <span className="attachment-spinner" aria-hidden="true" /> : null}
              <span className="attachment-name">{a.filename}</span>
              <span className="af-mono attachment-size">{bytes(a.size)}</span>
            </button>
            <button
              type="button"
              className="attachment-download"
              disabled={working}
              aria-label={`Download ${a.filename}`}
              data-tip={`Puts a copy of ${a.filename} in your Downloads folder and shows it in Finder. Nothing is opened.`}
              onClick={() => void downloadAttachment(message.accountId, message.id, a.key)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13h11" />
              </svg>
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * One message of the history, folded to a single row: who wrote it, the first
 * ninety characters or so, when, and how many files came with it. It mounts no
 * iframe, which is what keeps a long thread cheap. Pressing it opens the
 * message in place.
 */
function CollapsedMessage({ message, owners, onExpand }: { message: MessageView; owners: string[]; onExpand: () => void }) {
  const own = new Set(owners.map((o) => o.toLowerCase()));
  const isOwner = own.has(message.from.email.toLowerCase());
  const name = message.from.name.trim() || message.from.email;
  const files = (message.body?.attachments ?? []).filter((a) => !a.inline).length;
  const text = rowSnippet(message.snippet || messageText(message.body) || "");
  return (
    <button type="button" className={`message-row${isUnread(message) ? " is-unread" : ""}`} data-tip="Open this message here. Its body is not loaded until it opens." onClick={onExpand}>
      <span className={`message-avatar${isOwner ? " is-you" : ""}`} aria-hidden="true">
        {initials(message.from.name, message.from.email)}
      </span>
      <span className="message-row-from">{name}</span>
      <span className="message-row-snippet">{text}</span>
      {files > 0 ? <span className="af-mono message-row-files">{files} {files === 1 ? "file" : "files"}</span> : null}
      <span className="af-mono message-row-date">{relativeTime(message.internalDate)}</span>
    </button>
  );
}

export function ReadingPane() {
  const open = useApp((s) => s.open);
  const openLoading = useApp((s) => s.openLoading);
  const accounts = useApp((s) => s.status.accounts);
  const archiveSelected = useApp((s) => s.archiveSelected);
  const setPopover = useApp((s) => s.setPopover);
  const starSelected = useApp((s) => s.starSelected);
  const toggleQueue = useApp((s) => s.toggleQueue);
  const openCompose = useApp((s) => s.openCompose);
  const cancelScheduledSend = useApp((s) => s.cancelScheduledSend);
  const unsubscribeSelected = useApp((s) => s.unsubscribeSelected);
  const moveToInboxSelected = useApp((s) => s.moveToInboxSelected);
  const expandedMessages = useApp((s) => s.expandedMessages);
  const toggleMessage = useApp((s) => s.toggleMessage);
  const toggleAllMessages = useApp((s) => s.toggleAllMessages);
  const refreshOpen = useApp((s) => s.refreshOpen);
  const messages = open?.messages;
  // Every address the owner reads mail on, so the header can say "you" wherever one of them appears.
  const owners = useMemo(() => accounts.map((a) => a.email), [accounts]);
  // Each message's predecessors as plain text, oldest first, so MessageBody can fold history pasted without quote
  // markup. Memoised on the messages array, so the iframes do not re-render on every store change.
  const priorTexts = useMemo(() => {
    const texts: string[] = [];
    return (messages ?? []).map((m) => {
      const before = texts.slice();
      const t = messageText(m.body);
      if (t) texts.push(t);
      return before;
    });
  }, [messages]);

  const expanded = useMemo(() => new Set(expandedMessages), [expandedMessages]);
  const collapsedNow = (messages?.length ?? 0) - (messages ?? []).filter((m) => expanded.has(m.id)).length;
  const foldable = collapsedNow > 0 || (messages ?? []).some((m, i) => i > 0 && i < (messages?.length ?? 0) - 1 && !isUnread(m));

  const box = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const threadKey = open ? `${open.thread.accountId}:${open.thread.id}` : "";
  /**
   * A thread opens scrolled to its newest message, with the folded history
   * above it. Written straight to scrollTop in a layout effect, so the first
   * paint is already in the right place and nothing animates into it. The
   * summary card and the newest message's frame settle a moment later and move
   * the anchor, so the same jump runs again until the reader takes over.
   */
  useLayoutEffect(() => {
    moved.current = false;
    const el = box.current;
    if (!el || !threadKey) return;
    const toNewest = () => {
      if (moved.current) return;
      const last = el.querySelector<HTMLElement>(".message.is-last");
      if (!last) return;
      el.scrollTop += last.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    };
    const onReader = () => {
      moved.current = true;
    };
    el.addEventListener("wheel", onReader, { passive: true });
    el.addEventListener("pointerdown", onReader);
    toNewest();
    const timers = [80, 350, 1000].map((ms) => setTimeout(toNewest, ms));
    return () => {
      el.removeEventListener("wheel", onReader);
      el.removeEventListener("pointerdown", onReader);
      for (const t of timers) clearTimeout(t);
    };
  }, [threadKey]);

  if (!open) {
    return (
      <section className="reading" aria-label="Reading pane">
        <div className="empty">
          {openLoading ? (
            <div className="af-mono">Loading</div>
          ) : (
            <>
              <div className="af-h3">Pick a thread</div>
              <div>J and K move. Enter opens. E marks it done. C writes a new message.</div>
            </>
          )}
        </div>
      </section>
    );
  }

  const account = accounts.find((a) => a.id === open.thread.accountId);
  const t = open.thread;
  return (
    <section className="reading" aria-label="Reading pane">
      <div className="reading-head">
        <div className="drag" />
        <span className="af-mono">
          {account?.email ?? t.accountId} · {open.messages.length} {open.messages.length === 1 ? "message" : "messages"}
        </span>
        {open.bodiesPending ? (
          <span className="af-mono eyebrow-flag">
            {bodyNotice(open)}{" "}
            <button data-tip="Asks Gmail for the message bodies again." onClick={() => void refreshOpen()}>Fetch the messages again</button>
          </span>
        ) : null}
        {t.band === "needs_you" && t.attentionReason ? (
          <span className="af-mono eyebrow-flag" data-tip="Why this thread is in Needs you. Re-file it if the app has this wrong; that teaches the score.">{t.attentionReason}</span>
        ) : null}
        {t.noReplyBy ? <span className="af-mono eyebrow-flag">No reply by {eyebrowDate(t.noReplyBy)}</span> : null}
        {t.wakeAt ? <span className="af-mono eyebrow-flag">Snoozed · back {eyebrowDate(t.wakeAt, true)}</span> : null}
        {!t.scheduled && !t.inInbox && !t.wakeAt ? <span className="af-mono eyebrow-flag" data-tip="This thread is not in the inbox. Move back to inbox (Shift+E) puts it back.">Done</span> : null}
        {t.unsubscribeState === "sent" ? <span className="af-mono eyebrow-flag">Unsubscribed</span> : null}
        {t.unsubscribeState === "opened" ? <span className="af-mono eyebrow-flag">Unsubscribe page opened</span> : null}
        {t.scheduled ? <span className="af-mono eyebrow-flag">Sends {sendsAt(t.scheduled.sendAt)} · {fullDate(t.scheduled.sendAt)}</span> : null}
        <h1 className="reading-subject">{t.subject || "(no subject)"}</h1>
        {t.scheduled ? (
          <div className="reading-actions">
            <button className="btn btn-nav btn-compact" data-tip="Stops the scheduled send. The message reopens as a draft." onClick={() => void cancelScheduledSend()}>Cancel send</button>
            <span className="af-mono">Cancelling reopens it as a draft.</span>
          </div>
        ) : (
        <div className="reading-actions icon-row">
          <ReplyIcons onReply={() => openCompose("reply")} onReplyAll={() => openCompose("replyAll")} onForward={() => openCompose("forward")} />
          <span className="icon-sep" aria-hidden="true" />
          <IconButton glyph="done" label="Mark done" keyHint={hint("archive")} tip="Mark done. The thread leaves the inbox and stays in All Mail. In a queue, it clears and the next one opens." onClick={() => void archiveSelected()} />
          {t.inInbox ? null : <IconButton glyph="inbox" label="Move back to inbox" keyHint={hint("moveToInbox")} tip="Move back to inbox. The thread gets INBOX again, here and in Gmail, and leaves the Done list." onClick={() => void moveToInboxSelected()} />}
          <IconButton glyph="snooze" label="Snooze" keyHint={hint("snooze")} tip="Snooze. The thread leaves until a time you pick, then comes back with a notification." onClick={() => setPopover("snooze")} />
          <IconButton glyph="star" label={t.starred ? "Unstar" : "Star"} keyHint={hint("star")} tip={t.starred ? "Remove the star. The thread leaves Starred." : "Star this thread. It shows under Starred and in Gmail."} active={t.starred} onClick={() => void starSelected()} />
          <IconButton glyph="daily" label={t.queue === "daily" ? "Remove from Daily 0" : "Add to Daily 0"} keyHint={hint("toggleDaily")} tip={t.queue === "daily" ? "Remove from Daily 0, today's queue." : "Add to Daily 0, the queue to clear today."} active={t.queue === "daily"} onClick={() => void toggleQueue("daily")} />
          <IconButton glyph="weekly" label={t.queue === "weekly" ? "Remove from Weekly 0" : "Add to Weekly 0"} keyHint={hint("toggleWeekly")} tip={t.queue === "weekly" ? "Remove from Weekly 0, this week's queue." : "Add to Weekly 0, the queue to clear this week."} active={t.queue === "weekly"} onClick={() => void toggleQueue("weekly")} />
          {t.canUnsubscribe ? <IconButton glyph="unsubscribe" label="Unsubscribe and archive" keyHint={hint("unsubscribe")} tip="Unsubscribe and archive. The sender's List-Unsubscribe link runs (one click or an email); the thread leaves the inbox when the request went out." onClick={() => void unsubscribeSelected()} /> : null}
          <RefileSelect />
        </div>
        )}
      </div>
      <div className="messages" ref={box}>
        <SummaryCard />
        {foldable ? (
          <button type="button" className="af-mono messages-fold" data-key={keyLabel("toggleAllMessages") ?? undefined} data-tip={collapsedNow > 0 ? "Opens every folded message of this thread, in order." : "Folds the earlier messages back to one row each. The newest one stays open."} onClick={toggleAllMessages}>
            {collapsedNow > 0 ? expandAllLabel(collapsedNow) : COLLAPSE_ALL_LABEL}
          </button>
        ) : null}
        {open.messages.map((m, i) => {
          const isLast = i === open.messages.length - 1;
          const isOpen = expanded.has(m.id);
          return (
            <article className={`message${isLast ? " is-last" : ""}${isOpen ? "" : " is-folded"}`} key={m.id}>
              {isOpen ? (
                <>
                  <MessageHeader
                    message={m}
                    owners={owners}
                    repeatSender={open.messages.slice(0, i).some((p) => p.from.email.toLowerCase() === m.from.email.toLowerCase())}
                    onCollapse={() => toggleMessage(m.id)}
                    actions={
                      t.scheduled ? null : (
                        <div className="message-actions">
                          <ReplyIcons onReply={() => openCompose("reply", { messageId: m.id })} onReplyAll={() => openCompose("replyAll", { messageId: m.id })} onForward={() => openCompose("forward", { messageId: m.id })} />
                        </div>
                      )
                    }
                  />
                  {m.invite ? <InviteCard invite={m.invite} /> : null}
                  <MessageBody message={m} priorTexts={priorTexts[i] ?? NO_PRIORS} pending={open.bodiesPending} />
                  <Attachments message={m} />
                </>
              ) : (
                <CollapsedMessage message={m} owners={owners} onExpand={() => toggleMessage(m.id)} />
              )}
              <InlineReply messageId={m.id} isLast={isLast} />
            </article>
          );
        })}
        <InstantReplies />
      </div>
    </section>
  );
}

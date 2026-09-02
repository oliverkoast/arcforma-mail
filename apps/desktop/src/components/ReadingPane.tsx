import { useMemo } from "react";
import { useApp } from "../state/store";
import { bytes, eyebrowDate, fullDate, sendsAt } from "../lib/format";
import { messageText } from "../lib/mailhtml";
import { InstantReplies, SummaryCard } from "./AiCards";
import { InlineReply } from "./InlineReply";
import { IconButton, ReplyIcons } from "./IconButton";
import { MessageBody } from "./MessageBody";
import type { RefileTarget, ThreadSummary } from "../../shared/types";

const NO_PRIORS: string[] = [];

const BUILTIN: Array<{ id: string; label: string }> = [
  { id: "newsletters", label: "Newsletters" },
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
    <label className="refile">
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
  const messages = open?.messages;
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
          {open.bodiesPending ? " · bodies pending" : ""}
        </span>
        {t.noReplyBy ? <span className="af-mono eyebrow-flag">No reply by {eyebrowDate(t.noReplyBy)}</span> : null}
        {t.wakeAt ? <span className="af-mono eyebrow-flag">Snoozed · back {eyebrowDate(t.wakeAt, true)}</span> : null}
        {t.scheduled ? <span className="af-mono eyebrow-flag">Sends {sendsAt(t.scheduled.sendAt)} · {fullDate(t.scheduled.sendAt)}</span> : null}
        <h1 className="reading-subject">{t.subject || "(no subject)"}</h1>
        {t.scheduled ? (
          <div className="reading-actions">
            <button className="btn btn-nav btn-compact" onClick={() => void cancelScheduledSend()}>Cancel send</button>
            <span className="af-mono">Cancelling reopens it as a draft.</span>
          </div>
        ) : (
        <div className="reading-actions icon-row">
          <ReplyIcons onReply={() => openCompose("reply")} onReplyAll={() => openCompose("replyAll")} onForward={() => openCompose("forward")} />
          <span className="icon-sep" aria-hidden="true" />
          <IconButton glyph="done" label="Mark done" keyHint="E" onClick={() => void archiveSelected()} />
          <IconButton glyph="snooze" label="Snooze" keyHint="H" onClick={() => setPopover("snooze")} />
          <IconButton glyph="star" label={t.starred ? "Unstar" : "Star"} keyHint="S" active={t.starred} onClick={() => void starSelected()} />
          <IconButton glyph="daily" label={t.queue === "daily" ? "Remove from Daily 0" : "Add to Daily 0"} keyHint="D" active={t.queue === "daily"} onClick={() => void toggleQueue("daily")} />
          <IconButton glyph="weekly" label={t.queue === "weekly" ? "Remove from Weekly 0" : "Add to Weekly 0"} keyHint="W" active={t.queue === "weekly"} onClick={() => void toggleQueue("weekly")} />
          <RefileSelect />
        </div>
        )}
      </div>
      <div className="messages">
        <SummaryCard />
        {open.messages.map((m, i) => (
          <article className={`message${i === open.messages.length - 1 ? " is-last" : ""}`} key={m.id}>
            <div className="message-head">
              <div>
                <div className="message-from">
                  {m.from.name || m.from.email} {m.from.name ? <span>{m.from.email}</span> : null}
                </div>
                <div className="message-to">
                  to {m.to.map((a) => a.name || a.email).join(", ") || "(none)"}
                  {m.cc.length ? `, cc ${m.cc.map((a) => a.name || a.email).join(", ")}` : ""}
                </div>
              </div>
              <div className="message-meta">
                <div className="message-date">{fullDate(m.internalDate)}</div>
                {t.scheduled ? null : (
                  <div className="message-actions">
                    <ReplyIcons onReply={() => openCompose("reply", { messageId: m.id })} onReplyAll={() => openCompose("replyAll", { messageId: m.id })} onForward={() => openCompose("forward", { messageId: m.id })} />
                  </div>
                )}
              </div>
            </div>
            <MessageBody message={m} priorTexts={priorTexts[i] ?? NO_PRIORS} />
            {m.body && m.body.attachments.filter((a) => !a.inline).length > 0 ? (
              <div className="attachments">
                {m.body.attachments
                  .filter((a) => !a.inline)
                  .map((a) => (
                    <span className="attachment" key={a.filename}>
                      {a.filename} · {bytes(a.size)}
                    </span>
                  ))}
              </div>
            ) : null}
            <InlineReply messageId={m.id} isLast={i === open.messages.length - 1} />
          </article>
        ))}
        <InstantReplies />
      </div>
    </section>
  );
}

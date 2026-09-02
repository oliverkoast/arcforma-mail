import { useApp } from "../state/store";
import { bytes, eyebrowDate, fullDate, sendsAt } from "../lib/format";
import { InstantReplies, SummaryCard } from "./AiCards";
import { MessageBody } from "./MessageBody";
import type { RefileTarget, ThreadSummary } from "../../shared/types";

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
        <div className="reading-actions">
          <button className="btn btn-nav btn-compact" onClick={() => openCompose("reply")}>Reply</button>
          <button className="btn btn-nav btn-compact" onClick={() => openCompose("replyAll")}>Reply all</button>
          <button className="btn btn-nav btn-compact" onClick={() => openCompose("forward")}>Forward</button>
          <button className="btn btn-nav btn-compact" onClick={() => void archiveSelected()}>Mark done</button>
          <button className="btn btn-nav btn-compact" onClick={() => setPopover("snooze")}>Snooze</button>
          <button className="btn btn-nav btn-compact" onClick={() => void starSelected()}>{t.starred ? "Unstar" : "Star"}</button>
          <button className="btn btn-nav btn-compact" onClick={() => void toggleQueue("daily")}>{t.queue === "daily" ? "Remove from Daily 0" : "Add to Daily 0"}</button>
          <button className="btn btn-nav btn-compact" onClick={() => void toggleQueue("weekly")}>{t.queue === "weekly" ? "Remove from Weekly 0" : "Add to Weekly 0"}</button>
          <RefileSelect />
        </div>
        )}
      </div>
      <div className="messages">
        <SummaryCard />
        {open.messages.map((m) => (
          <article className="message" key={m.id}>
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
              <div className="message-date">{fullDate(m.internalDate)}</div>
            </div>
            <MessageBody message={m} />
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
          </article>
        ))}
        <InstantReplies />
      </div>
    </section>
  );
}

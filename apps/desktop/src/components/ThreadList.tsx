import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isQueueView, useApp } from "../state/store";
import { attentionEyebrow, eyebrowDate, listDate, participantsLine, sendsAt } from "../lib/format";
import { rowDescriptors, viewTitle } from "../lib/sidebarLayout";
import { stripBannerPrefix } from "../lib/mailhtml";
import { threadRowTip } from "../lib/tooltip";
import { keyLabel } from "../keys/keyLabel";
import { SearchExcerpt } from "./SearchExcerpt";
import type { DraftInfo, SearchHighlight, ThreadSummary } from "../../shared/types";

/** The search operators, each with what it does, for the hint under an empty focused search field. */
const SEARCH_OPS: Array<[string, string]> = [
  ["from:", "Sender name or address: from:dana"],
  ["to:", "Recipient name or address: to:maya"],
  ["subject:", "A word in the subject: subject:invoice"],
  ["has:attachment", "Only threads with a file attached"],
  ["is:unread", "Only threads with unread mail. Also is:read and is:starred."],
  ["before:", "Mail before a date: before:2026-09-01"],
  ["after:", "Mail after a date: after:2026-08-01"],
  ["newer_than:7d", "Mail from the last N days, weeks, or months: newer_than:7d, older_than:2w"],
];

const VIEW_TITLES: Record<string, string> = {
  inbox: "Inbox",
  all: "All mail",
  snoozed: "Snoozed",
  sent: "Sent",
  drafts: "Drafts",
  starred: "Starred",
  needsyou: "Needs you",
  daily: "Daily 0",
  weekly: "Weekly 0",
  later: "Later",
  unread: "Unread",
  attachments: "With attachments",
  scheduled: "Scheduled",
  archive: "Done",
  spam: "Spam",
  trash: "Trash",
};

/**
 * Inbox zero and queue zero share one empty state. The picture is user-supplied
 * art the main process serves from the data folder; it only renders when the
 * file exists, and drops out on any load error so the words always stand alone.
 */
function EmptyState({ headline, detail }: { headline: string; detail: string | null }) {
  const userArt = useApp((s) => s.userArt);
  const [artFailed, setArtFailed] = useState(false);
  const showArt = userArt.includes("inbox-zero") && !artFailed;
  return (
    <>
      {showArt ? <img className="empty-art" src="app://mail/user-art/inbox-zero" alt="" onError={() => setArtFailed(true)} /> : null}
      <div className="af-h3">{headline}</div>
      {detail ? <div>{detail}</div> : null}
    </>
  );
}

function Row({ row, selected, owners, onClick, onHover, accountLabel, accountEmail, highlight }: { row: ThreadSummary; selected: boolean; owners: Set<string>; onClick: () => void; onHover: (e: React.MouseEvent) => void; accountLabel: string | null; accountEmail: string | null; highlight?: SearchHighlight | null }) {
  // Gmail builds its snippet from the first text in the body, so on a domain that stamps a
  // "this came from outside" banner every row previews the same warning and the column stops saying
  // anything about any thread. The preview is what the message says.
  const preview = stripBannerPrefix(row.snippet);
  // The row explains itself only when its own text is cut off: the full subject, the start of the snippet, the account.
  return (
    <div className={`row${row.unread ? " unread" : ""}${selected ? " selected" : ""}`} onClick={onClick} onMouseMove={onHover} role="option" aria-selected={selected} data-tip={threadRowTip(row.subject, preview, accountEmail)} data-tip-if-truncated=".row-subject, .row-snippet">
      <span className="dot" />
      <div className="row-main">
        {row.band === "needs_you" && row.attentionReason ? <span className="af-mono row-eyebrow" data-tip={row.attentionReason}>{attentionEyebrow(row.attentionReason)}</span> : null}
        {row.noReplyBy ? <span className="af-mono row-eyebrow">No reply by {eyebrowDate(row.noReplyBy)}</span> : null}
        {row.wakeAt ? <span className="af-mono row-eyebrow">Back {eyebrowDate(row.wakeAt, true)}</span> : null}
        <div className="row-from">
          {participantsLine(row.participants, owners) || "(no sender)"}
          {row.messageCount > 1 ? <span className="nav-count"> {row.messageCount}</span> : null}
        </div>
        <div className="row-subject">{row.subject || "(no subject)"}</div>
        {highlight ? <div className="row-snippet"><SearchExcerpt highlight={highlight} /></div> : <div className="row-snippet">{preview}</div>}
      </div>
      <div className="row-meta">
        <span>{row.scheduled ? `Sends ${sendsAt(row.scheduled.sendAt)}` : listDate(row.lastMessageAt)}</span>
        {row.starred ? (
          <span className="star" data-tip="Starred. S removes the star.">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 1.5l1.9 4.1 4.5.5-3.3 3.1.9 4.4L8 11.4l-4 2.2.9-4.4L1.6 6.1l4.5-.5L8 1.5z" />
            </svg>
          </span>
        ) : null}
        {accountLabel ? <span className="af-mono row-account">{accountLabel}</span> : null}
        {row.canUnsubscribe ? <span className="row-unsub" data-tip="Unsubscribe and archive (U)" data-key={keyLabel("unsubscribe") ?? undefined}>U</span> : null}
      </div>
    </div>
  );
}

/** The mirror eyebrow: where the draft stands with Gmail. Renders uppercase through af-mono. */
export function mirrorLabel(d: Pick<DraftInfo, "mirror">): string {
  if (d.mirror.state === "synced") return "In Gmail";
  if (d.mirror.state === "pending") return "Saving";
  return d.mirror.error ? `Not in Gmail · ${d.mirror.error}` : "Not in Gmail";
}

function DraftRows({ drafts, accountLabels, showAccount }: { drafts: DraftInfo[]; accountLabels: Map<string, string>; showAccount: boolean }) {
  const openDraft = useApp((s) => s.openDraft);
  const deleteDraft = useApp((s) => s.deleteDraft);
  if (drafts.length === 0) return null;
  return (
    <div className="draft-rows">
      {drafts.map((d) => (
        <div className="draft-row" key={d.draftId}>
          <button className="draft-open" data-tip="Open this draft in the editor." onClick={() => openDraft(d)}>
            <span className="af-mono row-eyebrow">{mirrorLabel(d)}</span>
            <span className="af-mono">
              {listDate(d.updatedAt)}
              {showAccount ? ` · ${accountLabels.get(d.accountId) ?? d.accountId}` : ""}
            </span>
            <span className="row-subject">{d.subject || "(no subject)"}</span>
            <span className="row-snippet">{d.to.map((a) => a.name || a.email).join(", ") || "No recipient yet"}</span>
          </button>
          <button className="draft-delete" data-tip="Deletes the draft here and in Gmail." onClick={() => void deleteDraft(d.draftId)}>
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}

export function ThreadList() {
  const rows = useApp((s) => s.rows);
  const drafts = useApp((s) => s.drafts);
  const selected = useApp((s) => s.selected);
  const view = useApp((s) => s.view);
  const split = useApp((s) => s.split);
  const category = useApp((s) => s.category);
  const accounts = useApp((s) => s.status.accounts);
  const filter = useApp((s) => s.accountFilter);
  const progress = useApp((s) => s.progress);
  const searchQuery = useApp((s) => s.searchQuery);
  const searchHits = useApp((s) => s.searchHits);
  const error = useApp((s) => s.error);
  const loading = useApp((s) => s.loading);
  const select = useApp((s) => s.select);
  const readingPane = useApp((s) => s.readingPane);
  const toggleReadingPane = useApp((s) => s.toggleReadingPane);
  const openSelected = useApp((s) => s.openSelected);
  const setSearchQuery = useApp((s) => s.setSearchQuery);
  const setScope = useApp((s) => s.setScope);
  const scope = useApp((s) => s.scope);
  const open = useApp((s) => s.open);
  const loadMore = useApp((s) => s.loadMore);
  const counts = useApp((s) => s.counts);
  const categories = useApp((s) => s.categories);
  const savedSearches = useApp((s) => s.savedSearches);

  const parentRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 74, overscan: 8 });

  // Rows are measured as they mount. A webfont arriving afterwards changes their height, and the
  // stale measurements leave rows overlapping, so measure again once the fonts have settled.
  useEffect(() => {
    let cancelled = false;
    const remeasure = () => { if (!cancelled) virtualizer.measure(); };
    void document.fonts?.ready?.then(remeasure).catch(() => {});
    return () => { cancelled = true; };
  }, [virtualizer]);

  useEffect(() => {
    if (rows.length) virtualizer.scrollToIndex(selected, { align: "auto" });
  }, [selected, rows.length, virtualizer]);

  const owners = useMemo(() => new Set(accounts.map((a) => a.email)), [accounts]);
  const accountLabels = useMemo(() => new Map(accounts.map((a) => [a.id, a.email.split("@")[1] ?? a.id])), [accounts]);
  const backfills = Object.values(progress).filter((p) => !p.finished);
  const done = backfills.reduce((n, p) => n + p.done, 0);
  const total = backfills.reduce((n, p) => n + (p.total ?? 0), 0);

  // The sidebar row that opens this view names it, so a custom category or a saved search reads as itself.
  const rowTitle = useMemo(() => viewTitle(rowDescriptors(categories, savedSearches), { view, split, category }), [categories, savedSearches, view, split, category]);
  const title = searchHits ? `Search: ${searchQuery}` : view === "inbox" && !split && !category ? "Inbox" : rowTitle ?? VIEW_TITLES[view] ?? "Inbox";
  const queueLabel =
    view === "needsyou"
      ? `${counts.needsYou} waiting on you`
      : view === "daily"
        ? `${counts.daily} left today`
        : view === "weekly"
          ? `${counts.weekly} left this week`
          : view === "later"
            ? `${counts.later} later`
            : null;
  const monoLabel = searchHits ? `${rows.length} hits` : queueLabel ?? (filter ? accountLabels.get(filter) : "all accounts");

  return (
    <section className="list" aria-label="Threads">
      <div className="list-head">
        <div className="drag" />
        <div className="list-title">
          <h2 className="af-h3">{title}</h2>
          <span className="af-mono">{monoLabel}</span>
          <button className="pane-toggle" onClick={toggleReadingPane} aria-pressed={readingPane} aria-label={readingPane ? "Hide the reading pane" : "Show the reading pane"} data-tip={readingPane ? "Hide the reading pane. The list runs full width; Enter on a row brings it back." : "Show the reading pane beside the list."} data-key={keyLabel("toggleReadingPane") ?? undefined}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <path d="M7 2.5v11" />
            </svg>
          </button>
        </div>
        <label className="search" data-tip="Search subject, sender, recipients, and message text across every account. Enter runs it." data-key={keyLabel("search") ?? undefined}>
          <span className="af-mono">/</span>
          <input
            id="search-input"
            placeholder="Search mail"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setScope("search")}
            onBlur={() => setScope(open ? "thread" : "list")}
            spellCheck={false}
          />
        </label>
        {scope === "search" && !searchQuery ? (
          <div className="search-ops" aria-label="Search operators">
            {SEARCH_OPS.map(([op, tip]) => (
              <span key={op} data-tip={tip}>{op}</span>
            ))}
          </div>
        ) : null}
        {backfills.length > 0 ? (
          <div className="progress-line" aria-label="Sync progress">
            <i style={{ width: `${total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 12}%` }} />
          </div>
        ) : null}
        {error ? (
          <div className="notice">
            <span className="af-mono">Error</span>
            <span>{error}</span>
            <button data-tip="Clears this error. Nothing else changes." onClick={() => useApp.setState({ error: null })}>Dismiss</button>
          </div>
        ) : null}
      </div>
      {view === "drafts" ? <DraftRows drafts={drafts} accountLabels={accountLabels} showAccount={!filter} /> : null}
      <div className="rows" ref={parentRef} role="listbox" onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 300) void loadMore();
      }}>
        {rows.length === 0 ? (
          <div className="empty">
            {view === "drafts" && drafts.length > 0 ? null : view === "drafts" ? (
              <>
                <div className="af-h3">No drafts</div>
                <div>Esc in a message keeps a draft here and in Gmail. Drafts written in Gmail show up here too.</div>
              </>
            ) : searchHits ? (
              <>
                <div className="af-h3">No results for “{searchQuery}”</div>
                <div>Search covers subject, sender, recipients, and message text.</div>
              </>
            ) : backfills.length > 0 ? (
              <>
                <div className="af-mono">Syncing</div>
                <div>Threads appear as the last 90 days land.</div>
              </>
            ) : loading ? (
              <div className="af-mono">Loading</div>
            ) : view === "inbox" ? (
              <EmptyState headline="Nothing here" detail="New mail shows up within a minute of arriving." />
            ) : view === "needsyou" ? (
              <EmptyState headline="Nothing is waiting on you." detail="This row holds threads where a person asked you something and you have not replied since. Everything asked of you has an answer." />
            ) : view === "daily" ? (
              <EmptyState headline="Daily zero. Nothing left from today." detail={counts.clearedDaily > 0 ? `You cleared ${counts.clearedDaily} today.` : null} />
            ) : view === "weekly" ? (
              <EmptyState headline="Weekly zero. Nothing left from this week." detail={counts.clearedWeekly > 0 ? `You cleared ${counts.clearedWeekly} this week.` : null} />
            ) : isQueueView(view) ? (
              <EmptyState headline="Nothing in Later." detail="Weekly 0 threads older than a week land here." />
            ) : view === "archive" ? (
              <EmptyState headline="Nothing marked done yet." detail="E on a thread takes it out of the inbox and puts it here. Shift+E puts one back." />
            ) : view === "scheduled" ? (
              <EmptyState headline="Nothing scheduled." detail="Shift+Cmd+L in a message sends it later; it waits here until then." />
            ) : view.startsWith("search:") ? (
              <div className="af-h3">Nothing matches {title}</div>
            ) : (
              <div className="af-h3">Nothing in {VIEW_TITLES[view]?.toLowerCase() ?? "this view"}</div>
            )}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              return (
                <div key={`${row.accountId}:${row.id}`} style={{ transform: `translateY(${item.start}px)`, position: "absolute", top: 0, left: 0, width: "100%" }} ref={virtualizer.measureElement} data-index={item.index}>
                  <Row
                    row={row}
                    selected={item.index === selected}
                    owners={owners}
                    accountLabel={filter ? null : accountLabels.get(row.accountId) ?? null}
                    accountEmail={accounts.find((a) => a.id === row.accountId)?.email ?? null}
                    highlight={searchHits?.[item.index]?.highlight ?? null}
                    onClick={() => {
                      select(item.index);
                      void openSelected();
                    }}
                    onHover={(e) => {
                      // Hover moves the cursor row so E, H, S act on what the mouse is over, the way
                      // Superhuman does. Only a real mouse movement counts: rows sliding under a
                      // stationary pointer during keyboard navigation or scrolling must not steal it.
                      const last = lastPointer.current;
                      if (last && last.x === e.clientX && last.y === e.clientY) return;
                      lastPointer.current = { x: e.clientX, y: e.clientY };
                      if (item.index !== selected) select(item.index);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

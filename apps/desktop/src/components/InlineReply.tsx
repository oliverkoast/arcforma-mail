import { useEffect, useRef } from "react";
import { useApp } from "../state/store";
import { draftPreview, hasBody } from "../lib/compose";
import { ComposeEditor, MODE_LABEL } from "./ComposeEditor";
import { ComposeAttachments, ComposeFooter } from "./ComposeFooter";
import { RecipientLine } from "./RecipientLine";
import { ReplyIcons, hint } from "./IconButton";
import type { ComposeDraft, DraftInfo, ThreadView } from "../../shared/types";

/** The newest local draft docked under this thread, for the strip when the reply was parked and the thread reopened. */
export function savedDraftFor(open: ThreadView, drafts: DraftInfo[]): DraftInfo | null {
  return drafts.find((d) => d.threadId === open.thread.id && d.accountId === open.thread.accountId) ?? null;
}

function DraftStrip({ text, onOpen }: { text: string; onOpen: () => void }) {
  return (
    <button type="button" className="draft-strip" data-tip="A draft parked under this message. Open it to keep writing." data-key={hint("reply")} onClick={onOpen}>
      <span className="af-mono">Draft</span>
      <span className="draft-strip-text">{text}</span>
      <span className="af-mono">Open (R)</span>
    </button>
  );
}

function InlineBox({ compose }: { compose: ComposeDraft }) {
  const accounts = useApp((s) => s.status.accounts);
  const updateCompose = useApp((s) => s.updateCompose);
  const dismissCompose = useApp((s) => s.dismissCompose);
  const ref = useRef<HTMLElement>(null);
  const account = accounts.find((a) => a.id === compose.accountId);
  const key = `${compose.draftId ?? ""}:${compose.threadId ?? ""}:${compose.mode}`;
  // Docked under the last message, so the box scrolls into view when it opens.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "end" });
  }, [key]);
  const withBody = hasBody(compose);
  return (
    <section ref={ref} className="inline-reply" aria-label={MODE_LABEL[compose.mode]}>
      <div className="compose-head">
        <span className="af-mono">
          {MODE_LABEL[compose.mode]} · From {account?.email ?? compose.accountId}
        </span>
        <button className="compose-close" data-tip={withBody ? "Collapse the reply to a one-line strip. The draft is kept here and in Gmail." : "Close the empty reply. Nothing is saved."} data-key={hint("closeCompose")} onClick={() => void dismissCompose()}>
          {withBody ? "Keep draft and collapse (Esc)" : "Close (Esc)"}
        </button>
      </div>
      <RecipientLine compose={compose} startExpanded={compose.to.length === 0} />
      {compose.mode === "forward" ? (
        <label className="compose-field">
          <span className="af-mono">Subject</span>
          <input value={compose.subject} onChange={(e) => updateCompose({ subject: e.target.value })} spellCheck={false} />
        </label>
      ) : null}
      <ComposeEditor compose={compose} autofocus={compose.to.length > 0} />
      <ComposeAttachments />
      <ComposeFooter />
    </section>
  );
}

/** The message the inline UI docks under: the anchored compose, else the message a parked draft answers, else the last one. */
function anchorMessageId(open: ThreadView, docked: boolean, anchor: { messageId: string } | null, saved: DraftInfo | null): string | null {
  if (docked && anchor) return anchor.messageId;
  const lastId = open.messages[open.messages.length - 1]?.id ?? null;
  if (saved) return open.messages.find((m) => m.messageIdHeader && m.messageIdHeader === saved.inReplyTo)?.id ?? lastId;
  return null;
}

/**
 * What sits under a message of the open thread: the inline reply box or the
 * one-line strip of a draft that was collapsed or parked, under the message
 * it answers; and under the last message, when nothing is docked anywhere,
 * the reply row.
 */
export function InlineReply({ messageId, isLast }: { messageId: string; isLast: boolean }) {
  const open = useApp((s) => s.open);
  const compose = useApp((s) => s.compose);
  const placement = useApp((s) => s.composePlacement);
  const collapsed = useApp((s) => s.inlineCollapsed);
  const anchor = useApp((s) => s.inlineAnchor);
  const drafts = useApp((s) => s.drafts);
  const openCompose = useApp((s) => s.openCompose);
  const expandInline = useApp((s) => s.expandInline);
  if (!open) return null;
  const docked = Boolean(compose && placement === "inline" && anchor && anchor.threadId === open.thread.id && anchor.accountId === open.thread.accountId);
  const saved = docked ? null : savedDraftFor(open, drafts);
  const at = anchorMessageId(open, docked, anchor, saved);
  if (at === messageId) {
    if (docked && compose) return collapsed ? <DraftStrip text={draftPreview(compose.bodyHtml)} onOpen={expandInline} /> : <InlineBox compose={compose} />;
    if (saved) return <DraftStrip text={draftPreview(saved.bodyHtml)} onOpen={() => openCompose(saved.mode, { draft: saved, placement: "inline" })} />;
  }
  if (!isLast || at || open.thread.scheduled) return null;
  return (
    <div className="reply-row icon-row">
      <ReplyIcons onReply={() => openCompose("reply", { messageId })} onReplyAll={() => openCompose("replyAll", { messageId })} onForward={() => openCompose("forward", { messageId })} />
    </div>
  );
}

import { useApp } from "../state/store";
import { keyLabel } from "../keys/keyLabel";
import type { AiErrorCode } from "../../shared/types";

/** The honest eyebrow for an AI failure. Signed out is the expected state on a fresh machine. */
export function aiEyebrow(code: AiErrorCode): string {
  switch (code) {
    case "not_logged_in":
      return "Sign in to Claude Code";
    case "daemon_down":
      return "AI daemon off";
    case "unauthorized":
      return "AI daemon token mismatch";
    case "timeout":
      return "AI timed out";
    default:
      return "AI unavailable";
  }
}

export function aiHint(code: AiErrorCode, feature: string): string {
  if (code === "not_logged_in") return `${feature} needs Claude. Run claude auth login in a terminal; everything else keeps working.`;
  if (code === "daemon_down") return `${feature} needs the AI daemon. Run packages/ai-daemon/install.sh.`;
  return `${feature} is off for now.`;
}

export function SummaryCard() {
  const summary = useApp((s) => s.summary);
  if (!summary) return null;
  if (summary.ok === "loading") {
    return (
      <div className="ai-card" aria-live="polite" data-tip="Claude is reading the thread and writing a short summary.">
        <span className="af-mono">Summarizing</span>
      </div>
    );
  }
  if (summary.ok === true) {
    return (
      <div className="ai-card" data-tip={summary.cached ? "A Claude summary of the thread, kept until new mail arrives." : "A Claude summary of the thread, written just now. It is kept until new mail arrives."}>
        <span className="af-mono">Summary{summary.cached ? "" : " · new"}</span>
        <p>{summary.summary}</p>
      </div>
    );
  }
  return (
    <div className="ai-card" data-tip="The thread summary needs Claude and is off right now. Everything else keeps working.">
      <span className="af-mono">{aiEyebrow(summary.code)}</span>
      <p>{aiHint(summary.code, "The summary")}</p>
    </div>
  );
}

export function InstantReplies() {
  const replies = useApp((s) => s.replies);
  const accept = useApp((s) => s.acceptInstantReply);
  if (!replies) return null;
  if (replies.ok === "loading") {
    return (
      <div className="replies" aria-live="polite" data-tip="Claude is drafting three short replies from the thread.">
        <span className="af-mono">Instant replies</span>
      </div>
    );
  }
  if (replies.ok !== true) {
    return (
      <div className="replies">
        <span className="af-mono">{aiEyebrow(replies.code)}</span>
        <span className="replies-hint">{aiHint(replies.code, "Instant replies")}</span>
      </div>
    );
  }
  return (
    <div className="replies" data-tip="Three short replies Claude drafted from the thread. Pick one to open it as your reply and edit it before sending.">
      <span className="af-mono">Instant replies · 1, 2, 3 open a reply</span>
      <div className="replies-row">
        {replies.replies.map((r, i) => (
          <button key={i} className="reply-chip" data-tip={`Press ${i + 1} to open this as your reply. It goes into the editor to change before sending.`} data-key={keyLabel(`instantReply${i + 1}`) ?? undefined} onClick={() => accept((i + 1) as 1 | 2 | 3)}>
            <span className="af-mono">{i + 1}</span>
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}

import { useApp } from "../state/store";
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
      <div className="ai-card" aria-live="polite">
        <span className="af-mono">Summarizing</span>
      </div>
    );
  }
  if (summary.ok === true) {
    return (
      <div className="ai-card">
        <span className="af-mono">Summary{summary.cached ? "" : " · new"}</span>
        <p>{summary.summary}</p>
      </div>
    );
  }
  return (
    <div className="ai-card">
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
      <div className="replies" aria-live="polite">
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
    <div className="replies">
      <span className="af-mono">Instant replies · 1, 2, 3 open a reply</span>
      <div className="replies-row">
        {replies.replies.map((r, i) => (
          <button key={i} className="reply-chip" onClick={() => accept((i + 1) as 1 | 2 | 3)}>
            <span className="af-mono">{i + 1}</span>
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}

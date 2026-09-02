import { Fragment } from "react";
import { useApp } from "../state/store";
import { aiEyebrow, aiHint } from "./AiCards";
import type { AskSource } from "../../shared/types";

/** Turns [3] citations into buttons that open the cited thread. */
function Answer({ text, sources, onOpen }: { text: string; sources: AskSource[]; onOpen: (s: AskSource) => void }) {
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\])/g);
  return (
    <p className="ask-answer">
      {parts.map((part, i) => {
        const m = /^\[([\d,\s]+)\]$/.exec(part);
        if (!m) return <Fragment key={i}>{part}</Fragment>;
        const nums = m[1]!.split(",").map((n) => Number(n.trim()));
        return (
          <Fragment key={i}>
            {nums.map((n) => {
              const src = sources.find((s) => s.n === n);
              return src ? (
                <button key={n} className="cite" onClick={() => onOpen(src)} title={src.subject}>
                  {n}
                </button>
              ) : (
                <span key={n}>[{n}]</span>
              );
            })}
          </Fragment>
        );
      })}
    </p>
  );
}

export function AskPanel() {
  const ask = useApp((s) => s.ask);
  const setAskQuestion = useApp((s) => s.setAskQuestion);
  const runAsk = useApp((s) => s.runAsk);
  const closeAsk = useApp((s) => s.closeAsk);
  const openThreadById = useApp((s) => s.openThreadById);
  if (!ask.open) return null;
  const open = (s: AskSource) => {
    closeAsk();
    void openThreadById(s.accountId, s.threadId);
  };
  const r = ask.result;
  return (
    <div className="overlay" onClick={closeAsk}>
      <section className="panel ask" role="dialog" aria-label="Ask AI" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <span className="af-mono">Ask AI · Cmd+Shift+A</span>
          <button onClick={closeAsk}>Close (Esc)</button>
        </div>
        <input id="ask-input" className="ask-input" autoFocus placeholder="Ask about your mail. Enter runs it." value={ask.question} onChange={(e) => setAskQuestion(e.target.value)} spellCheck={false} />
        {ask.running ? <span className="af-mono">Searching, then asking Claude</span> : null}
        {r && r.ok === true ? <Answer text={r.answer} sources={r.sources} onOpen={open} /> : null}
        {r && r.ok === false ? (
          <div className="ai-card">
            <span className="af-mono">{aiEyebrow(r.code)}</span>
            <p>{r.code === "unknown" ? r.error : aiHint(r.code, "The answer")}</p>
          </div>
        ) : null}
        {r && r.sources.length > 0 ? (
          <div className="ask-sources">
            <span className="af-mono">{r.ok === true ? "Sources" : "Search hits, unanswered"}</span>
            {r.sources.slice(0, 12).map((s) => (
              <button key={`${s.accountId}:${s.threadId}`} className="ask-source" onClick={() => open(s)}>
                <span className="af-mono">{s.n}</span>
                <span className="ask-source-subject">{s.subject || "(no subject)"}</span>
                <span className="ask-source-excerpt">{s.excerpt}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

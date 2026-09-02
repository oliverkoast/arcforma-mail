import { useMemo, useState } from "react";
import { SEND_LATER, useApp } from "../state/store";
import { filterSnippets } from "../lib/snippets";
import { IconButton } from "./IconButton";

function SendLaterPopover() {
  const sendCompose = useApp((s) => s.sendCompose);
  const setSendLater = useApp((s) => s.setSendLater);
  const pick = useApp((s) => s.sendLaterPick);
  const [when, setWhen] = useState("");
  const item = (label: string, key: string, onClick: () => void) => (
    <button className="popover-item" onClick={onClick}>
      <span>{label}</span>
      <span className="af-mono">{key}</span>
    </button>
  );
  return (
    <div className="popover compose-popover" role="dialog" aria-label="Send later">
      <span className="af-mono">Send later</span>
      {pick ? (
        <div className="popover-row">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} autoFocus />
          <button
            className="btn btn-sweep btn-compact"
            disabled={!when}
            onClick={() => {
              const t = new Date(when).getTime();
              if (Number.isFinite(t)) void sendCompose(t);
            }}
          >
            Schedule
          </button>
        </div>
      ) : (
        <>
          {item("Tomorrow, 9:00", "T", () => void sendCompose(SEND_LATER.tomorrow()))}
          {item("Next Monday, 9:00", "W", () => void sendCompose(SEND_LATER.nextMonday()))}
          {item("Pick a time", "D", () => setSendLater(true, true))}
        </>
      )}
      <button className="popover-item" onClick={() => setSendLater(false)}>
        <span>Back to the message</span>
        <span className="af-mono">Esc</span>
      </button>
    </div>
  );
}

function SnippetPicker() {
  const snippets = useApp((s) => s.snippets);
  const insertSnippet = useApp((s) => s.insertSnippet);
  const setSnippetPicker = useApp((s) => s.setSnippetPicker);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useMemo(() => filterSnippets(query, snippets), [query, snippets]);
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, Math.max(0, list.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = list[index];
      if (s) insertSnippet(s);
    }
  };
  return (
    <div className="popover compose-popover" role="dialog" aria-label="Snippets">
      <span className="af-mono">Snippets</span>
      <input
        className="picker-input"
        autoFocus
        placeholder="Type to filter"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={onKey}
        spellCheck={false}
      />
      {list.length === 0 ? (
        <div className="picker-empty">{snippets.length === 0 ? "No snippets yet. Add them in Settings." : "Nothing matches."}</div>
      ) : (
        list.map((s, i) => (
          <button key={s.id} className="popover-item" aria-current={i === index ? "true" : undefined} onMouseEnter={() => setIndex(i)} onClick={() => insertSnippet(s)}>
            <span>
              {s.name}
              <span className="picker-preview">{s.bodyText.slice(0, 60)}</span>
            </span>
            <span className="af-mono">;{s.trigger}</span>
          </button>
        ))
      )}
      <button className="popover-item" onClick={() => setSnippetPicker(false)}>
        <span>Close</span>
        <span className="af-mono">Esc</span>
      </button>
    </div>
  );
}

/** Send, Send later, Snippets, and the discard glyph, plus the two popovers they open. Shared by the panel and the inline reply. */
export function ComposeFooter() {
  const sendLaterOpen = useApp((s) => s.sendLaterOpen);
  const snippetPickerOpen = useApp((s) => s.snippetPickerOpen);
  const closeCompose = useApp((s) => s.closeCompose);
  const sendCompose = useApp((s) => s.sendCompose);
  const setSendLater = useApp((s) => s.setSendLater);
  const setSnippetPicker = useApp((s) => s.setSnippetPicker);
  return (
    <>
      <div className="compose-foot">
        <button className="btn btn-sweep btn-compact" onClick={() => void sendCompose(null)} title="Send (Cmd+Enter)">
          Send
        </button>
        <button className="btn btn-nav btn-compact" onClick={() => setSendLater(true)} title="Send later (Cmd+Shift+Enter)">
          Send later
        </button>
        <button className="btn btn-ghost btn-compact" onClick={() => setSnippetPicker(true)} title="Snippets (Cmd+;)">
          Snippets
        </button>
        <IconButton glyph="trash" label="Discard draft" keyHint="Cmd+Shift+D" className="compose-trash" onClick={() => void closeCompose(false)} />
      </div>
      {sendLaterOpen ? <SendLaterPopover /> : null}
      {snippetPickerOpen ? <SnippetPicker /> : null}
    </>
  );
}

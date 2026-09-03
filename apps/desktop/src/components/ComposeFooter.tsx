import { useMemo, useState } from "react";
import { SEND_LATER, useApp } from "../state/store";
import { filterSnippets } from "../lib/snippets";
import { RECEIPT_COMPOSE_TIP, RECEIPT_NO_SERVICE_TIP } from "../lib/receipts";
import { IconButton, hint } from "./IconButton";

function SendLaterPopover() {
  const sendCompose = useApp((s) => s.sendCompose);
  const setSendLater = useApp((s) => s.setSendLater);
  const pick = useApp((s) => s.sendLaterPick);
  const [when, setWhen] = useState("");
  const item = (label: string, key: string, tip: string, onClick: () => void) => (
    <button className="popover-item" data-tip={tip} data-key={key} onClick={onClick}>
      <span>{label}</span>
      <span className="af-mono">{key}</span>
    </button>
  );
  return (
    <div className="popover compose-popover" role="dialog" aria-label="Send later">
      <span className="af-mono">Send later</span>
      {pick ? (
        <div className="popover-row">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} autoFocus data-tip="The date and time to send, in your time zone." />
          <button
            className="btn btn-sweep btn-compact"
            disabled={!when}
            data-tip="Queues the message for that time. It waits under Scheduled until then."
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
          {item("Tomorrow, 9:00", "T", "Sends tomorrow at 9:00 in your time zone. It waits under Scheduled until then.", () => void sendCompose(SEND_LATER.tomorrow()))}
          {item("Next Monday, 9:00", "W", "Sends next Monday at 9:00 in your time zone. It waits under Scheduled until then.", () => void sendCompose(SEND_LATER.nextMonday()))}
          {item("Pick a time", "D", "Choose any date and time to send.", () => setSendLater(true, true))}
        </>
      )}
      <button className="popover-item" data-tip="Closes this menu. The message stays open." data-key={hint("closeSendLater")} onClick={() => setSendLater(false)}>
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
        data-tip="Type to filter by name or trigger. Up and Down move, Enter inserts."
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
          <button key={s.id} className="popover-item" aria-current={i === index ? "true" : undefined} data-tip={`Inserts at the cursor:\n${s.bodyText.replace(/\s+/g, " ").trim().slice(0, 140)}`} onMouseEnter={() => setIndex(i)} onClick={() => insertSnippet(s)}>
            <span>
              {s.name}
              <span className="picker-preview">{s.bodyText.slice(0, 60)}</span>
            </span>
            <span className="af-mono">;{s.trigger}</span>
          </button>
        ))
      )}
      <button className="popover-item" data-tip="Closes the picker without inserting anything." data-key={hint("closeSnippets")} onClick={() => setSnippetPicker(false)}>
        <span>Close</span>
        <span className="af-mono">Esc</span>
      </button>
    </div>
  );
}

/**
 * The read receipt control for this one message. Off unless it is turned on
 * here, every time: there is no global that arms messages on your behalf. With
 * no service configured it says so rather than doing nothing quietly.
 */
function ReadReceiptToggle() {
  const armed = useApp((s) => s.compose?.readReceipt === true);
  const settings = useApp((s) => s.settings);
  const setReadReceipt = useApp((s) => s.setReadReceipt);
  const ready = settings.readReceipts && Boolean(settings.readReceiptsUrl) && settings.readReceiptsTokenSet;
  if (!ready) {
    return (
      <button className="btn btn-ghost btn-compact compose-receipt" disabled data-tip={RECEIPT_NO_SERVICE_TIP} aria-disabled="true">
        Read receipt needs a service
      </button>
    );
  }
  return (
    <button
      className={`btn btn-ghost btn-compact compose-receipt${armed ? " is-armed" : ""}`}
      aria-pressed={armed}
      data-tip={armed ? `Sends this message without the image. ${RECEIPT_COMPOSE_TIP}` : RECEIPT_COMPOSE_TIP}
      onClick={() => setReadReceipt(!armed)}
    >
      {armed ? "Remove the read receipt" : "Ask for a read receipt"}
    </button>
  );
}

/** Send, Send later, Snippets, the read receipt control, and the discard glyph, plus the two popovers they open. Shared by the panel and the inline reply. */
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
        {/* The chord is printed on the button, not left in the tooltip. A shortcut nobody can see is
            a shortcut nobody uses, and the first question it gets asked is whether it still exists. */}
        <button className="btn btn-sweep btn-compact" data-tip="Send now. Z undoes it during the undo window set in Settings." onClick={() => void sendCompose(null)}>
          Send
          {hint("send") ? <span className="af-mono btn-key">{hint("send")}</span> : null}
        </button>
        <button className="btn btn-nav btn-compact" data-tip="Pick a time to send. The message waits under Scheduled until then." data-key={hint("sendLater")} onClick={() => setSendLater(true)}>
          Send later
        </button>
        <button className="btn btn-ghost btn-compact" data-tip="Insert a saved snippet at the cursor. Typing ;trigger then Space does the same inline." data-key={hint("snippets")} onClick={() => setSnippetPicker(true)}>
          Snippets
        </button>
        <ReadReceiptToggle />
        <IconButton glyph="trash" label="Discard draft" keyHint={hint("discardCompose")} tip="Discard this draft. It is deleted here and in Gmail." className="compose-trash" onClick={() => void closeCompose(false)} />
      </div>
      {sendLaterOpen ? <SendLaterPopover /> : null}
      {snippetPickerOpen ? <SnippetPicker /> : null}
    </>
  );
}

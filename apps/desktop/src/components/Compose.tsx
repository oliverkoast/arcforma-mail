import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Snippets } from "../editor/snippets";
import { SEND_LATER, useApp } from "../state/store";
import { formatAddresses, parseAddresses } from "../lib/compose";
import { filterSnippets } from "../lib/snippets";
import type { ComposeMode } from "../../shared/types";

const MODE_LABEL: Record<ComposeMode, string> = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward" };

let insertTextHook: ((text: string) => void) | null = null;

/**
 * Writes plain text into the open compose at the caret, one paragraph per
 * line. Returns false when no editor is mounted so the caller can open one.
 */
export function insertComposeText(text: string): boolean {
  if (!insertTextHook) return false;
  insertTextHook(text);
  return true;
}

function AddressField({ label, value, onCommit, autoFocus }: { label: string; value: string; onCommit: (text: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="compose-field">
      <span className="af-mono">{label}</span>
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(text)} spellCheck={false} autoFocus={autoFocus} placeholder={label === "To" ? "name@example.com" : ""} />
    </label>
  );
}

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

export function Compose() {
  const compose = useApp((s) => s.compose);
  const ghost = useApp((s) => s.composeGhost);
  const sendLaterOpen = useApp((s) => s.sendLaterOpen);
  const snippetPickerOpen = useApp((s) => s.snippetPickerOpen);
  const accounts = useApp((s) => s.status.accounts);
  const updateCompose = useApp((s) => s.updateCompose);
  const closeCompose = useApp((s) => s.closeCompose);
  const sendCompose = useApp((s) => s.sendCompose);
  const setSendLater = useApp((s) => s.setSendLater);
  const setSnippetPicker = useApp((s) => s.setSnippetPicker);
  const setEditorApi = useApp((s) => s.setEditorApi);
  const acceptGhost = useApp((s) => s.acceptGhost);
  const snippetsRef = useRef(useApp.getState().snippets);
  useEffect(() => useApp.subscribe((s) => (snippetsRef.current = s.snippets)), []);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ link: false, heading: false, codeBlock: false, code: false, horizontalRule: false }),
        Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" }),
        Placeholder.configure({ placeholder: "Write your message. ;trigger then Space expands a snippet." }),
        Snippets.configure({ getSnippets: () => snippetsRef.current }),
      ],
      content: compose?.bodyHtml ?? "",
      autofocus: compose && compose.to.length > 0 ? "end" : false,
      onUpdate: ({ editor: ed }) => updateCompose({ bodyHtml: ed.getHTML() }),
      editorProps: { attributes: { class: "compose-body", spellcheck: "true" } },
    },
    [compose?.draftId ?? "", compose?.threadId ?? "", compose?.mode ?? ""]
  );

  useEffect(() => {
    if (!editor) return;
    setEditorApi({
      insertHtml: (html) => editor.chain().focus().insertContent(html).run(),
      setHtml: (html) => editor.chain().focus().setContent(html, { emitUpdate: true }).run(),
      focus: () => editor.commands.focus(),
    });
    insertTextHook = (text) => {
      const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const lines = text.split("\n").map(escape);
      editor
        .chain()
        .focus()
        .insertContent(lines.length > 1 ? lines.map((l) => `<p>${l}</p>`).join("") : lines[0] ?? "")
        .run();
    };
    return () => {
      setEditorApi(null);
      insertTextHook = null;
    };
  }, [editor, setEditorApi]);

  if (!compose) return null;
  const account = accounts.find((a) => a.id === compose.accountId);

  return (
    <section className="compose" role="dialog" aria-label={MODE_LABEL[compose.mode]}>
      <div className="compose-head">
        <span className="af-mono">
          {MODE_LABEL[compose.mode]} · {account?.email ?? compose.accountId}
        </span>
        <button className="compose-close" onClick={() => void closeCompose(true)}>
          Close and keep draft (Esc)
        </button>
      </div>
      <AddressField label="To" value={formatAddresses(compose.to)} onCommit={(t) => updateCompose({ to: parseAddresses(t) })} autoFocus={compose.to.length === 0} />
      <AddressField label="Cc" value={formatAddresses(compose.cc)} onCommit={(t) => updateCompose({ cc: parseAddresses(t) })} />
      <label className="compose-field">
        <span className="af-mono">Subject</span>
        <input value={compose.subject} onChange={(e) => updateCompose({ subject: e.target.value })} spellCheck={false} />
      </label>
      <div className="compose-editor">
        <EditorContent editor={editor} />
        {ghost ? (
          <div className="ghost" aria-live="polite">
            {ghost.status === "loading" ? (
              <span className="af-mono">Drafting a reply</span>
            ) : ghost.status === "ready" ? (
              <>
                <span className="af-mono">Auto-draft · Tab accepts</span>
                <div className="ghost-text">{ghost.text}</div>
                <button className="ghost-accept" onClick={acceptGhost}>
                  Use this draft (Tab)
                </button>
              </>
            ) : (
              <>
                <span className="af-mono">{ghost.code === "not_logged_in" ? "Sign in to Claude Code" : ghost.code === "daemon_down" ? "AI daemon off" : "Auto-draft unavailable"}</span>
                <div className="ghost-text">{ghost.code === "not_logged_in" ? "Auto-draft needs Claude. Write the reply as usual." : ghost.text || "Write the reply as usual."}</div>
              </>
            )}
          </div>
        ) : null}
      </div>
      {compose.quotedHtml ? (
        <details className="compose-quote">
          <summary className="af-mono">Quoted history</summary>
          <div className="compose-quote-body" dangerouslySetInnerHTML={{ __html: compose.quotedHtml }} />
        </details>
      ) : null}
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
        <button className="compose-trash" onClick={() => void closeCompose(false)} aria-label="Discard draft" title="Discard draft (Cmd+Shift+D)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5" />
          </svg>
        </button>
      </div>
      {sendLaterOpen ? <SendLaterPopover /> : null}
      {snippetPickerOpen ? <SnippetPicker /> : null}
    </section>
  );
}

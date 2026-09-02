import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Snippets } from "../editor/snippets";
import { useApp } from "../state/store";
import type { ComposeDraft, ComposeMode } from "../../shared/types";

export const MODE_LABEL: Record<ComposeMode, string> = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward" };

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

/**
 * The TipTap body, the ghost auto-draft under it, and the quoted history.
 * Shared by the floating panel and the inline reply; only one is mounted at a
 * time, so the store's editorApi always points at the editor on screen.
 */
export function ComposeEditor({ compose, autofocus }: { compose: ComposeDraft; autofocus: boolean }) {
  const ghost = useApp((s) => s.composeGhost);
  const updateCompose = useApp((s) => s.updateCompose);
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
      content: compose.bodyHtml,
      autofocus: autofocus ? "end" : false,
      onUpdate: ({ editor: ed }) => updateCompose({ bodyHtml: ed.getHTML() }),
      editorProps: { attributes: { class: "compose-body", spellcheck: "true" } },
    },
    [compose.draftId ?? "", compose.threadId ?? "", compose.mode]
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

  return (
    <>
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
    </>
  );
}

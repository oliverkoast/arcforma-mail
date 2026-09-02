// TipTap extension: `;trigger` followed by Space or Tab expands the snippet in
// place, variables filled from the compose recipients and the account, and
// the caret placed on {cursor} when the body has one. The lookups are getters
// so the list and the recipients can change without re-creating the editor.

import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { CURSOR_TOKEN, expandSnippet, findTrigger, type ExpandedSnippet, type SnippetContext } from "../lib/snippets";
import type { SnippetInfo } from "../../shared/types";

export interface SnippetsOptions {
  getSnippets: () => SnippetInfo[];
  /** The recipients and account the variables read from. Without it, every variable is missing and stays empty. */
  getContext: () => SnippetContext;
  /** Called after each expansion, so the compose can toast the variables that came up empty. */
  onExpand?: (result: ExpandedSnippet, snippet: SnippetInfo) => void;
}

/** Finds the caret token the expansion left, removes it, and puts the selection there. False when there is none. */
export function placeCursorAtToken(editor: Editor): boolean {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isText && node.text) {
      const i = node.text.indexOf(CURSOR_TOKEN);
      if (i >= 0) found = pos + i;
    }
    return found === null;
  });
  if (found === null) return false;
  editor
    .chain()
    .focus()
    .deleteRange({ from: found, to: found + CURSOR_TOKEN.length })
    .setTextSelection(found)
    .run();
  return true;
}

/** The html an expanded snippet inserts; a text-only snippet is wrapped as one paragraph. */
export function expandedHtml(r: ExpandedSnippet): string {
  return r.html || `<p>${r.text}</p>`;
}

/** Inserts expanded snippet html at the caret and lands the caret on {cursor} when the body had one, else after the insert. */
export function insertExpanded(editor: Editor, r: ExpandedSnippet): void {
  editor.chain().focus().insertContent(expandedHtml(r)).run();
  if (r.hasCursor) placeCursorAtToken(editor);
}

export const Snippets = Extension.create<SnippetsOptions>({
  name: "snippets",

  addOptions() {
    return { getSnippets: () => [], getContext: () => ({ recipient: null, account: null }), onExpand: undefined };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const getSnippets = () => this.options.getSnippets();
    const getContext = () => this.options.getContext();
    const onExpand = () => this.options.onExpand;
    return [
      new Plugin({
        key: new PluginKey("arcmailSnippets"),
        props: {
          handleKeyDown(view, event) {
            if (event.key !== " " && event.key !== "Tab") return false;
            if (event.metaKey || event.ctrlKey || event.altKey) return false;
            const { selection } = view.state;
            if (!selection.empty) return false;
            const $from = selection.$from;
            if (!$from.parent.isTextblock) return false;
            const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
            const match = findTrigger(textBefore, getSnippets());
            if (!match) return false;
            event.preventDefault();
            const from = $from.pos - match.length;
            const expanded = expandSnippet(match.snippet, getContext());
            editor.chain().focus().deleteRange({ from, to: $from.pos }).run();
            insertExpanded(editor, expanded);
            onExpand()?.(expanded, match.snippet);
            return true;
          },
        },
      }),
    ];
  },
});

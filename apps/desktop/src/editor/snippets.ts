// TipTap extension: `;trigger` followed by Space or Tab expands the snippet in
// place. The lookup is a getter so the list can change without re-creating
// the editor.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { findTrigger } from "../lib/snippets";
import type { SnippetInfo } from "../../shared/types";

export interface SnippetsOptions {
  getSnippets: () => SnippetInfo[];
}

export const Snippets = Extension.create<SnippetsOptions>({
  name: "snippets",

  addOptions() {
    return { getSnippets: () => [] };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const getSnippets = () => this.options.getSnippets();
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
            editor
              .chain()
              .focus()
              .deleteRange({ from, to: $from.pos })
              .insertContent(match.snippet.bodyHtml || `<p>${match.snippet.bodyText}</p>`)
              .run();
            return true;
          },
        },
      }),
    ];
  },
});

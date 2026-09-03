import { Extension } from "@tiptap/core";

/**
 * Cmd+Enter sends, even with the caret in the body.
 *
 * The window-level key dispatcher resolves this chord correctly, but it never saw it: TipTap's core
 * keymap claims Mod-Enter for exitCode, and ProseMirror's handlers sit on the editor element, below
 * the window, so they run first and the event was consumed before it bubbled up. The binding
 * resolved perfectly in isolation and did nothing in the app, which is exactly the kind of fault a
 * unit test cannot see.
 *
 * Binding it here, at a priority above the core keymap, puts the chord where the caret is. It
 * returns true so nothing further tries to handle it.
 */
export const SendChord = Extension.create<{ onSend: () => void }>({
  name: "arcformaSendChord",
  // Above @tiptap/core's keymap extension, which is what was taking it.
  priority: 1000,
  addOptions() {
    return { onSend: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => {
        this.options.onSend();
        return true;
      },
    };
  },
});

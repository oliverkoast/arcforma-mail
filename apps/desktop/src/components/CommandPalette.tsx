import { useEffect, useMemo, useState } from "react";
import { useApp } from "../state/store";
import { appActions } from "../keys/useKeyboard";
import { keyLabel } from "../keys/keyLabel";
import { buildCommands, filterCommands, type Command } from "../lib/commands";

/**
 * Cmd+K. One input, up to eight rows, the key that does the same thing in
 * mono on the right. Up and Down move, Enter runs, Esc closes (through the
 * keymap's palette scope), the pointer resting on a row selects it. Runs the
 * same action functions the keys do, so a palette command and its key never
 * disagree. No shadow: the brand declares no shadow token (qa/FINDINGS.md
 * F-MAIL-03), so the card separates with its 1 px rule edge alone.
 */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const query = useApp((s) => s.paletteQuery);
  const scope = useApp((s) => s.paletteScope);
  const categories = useApp((s) => s.categories);
  const savedSearches = useApp((s) => s.savedSearches);
  const sidebarLayout = useApp((s) => s.sidebarLayout);
  const accounts = useApp((s) => s.status.accounts);
  const snippets = useApp((s) => s.snippets);
  const openThread = useApp((s) => s.open);
  const rows = useApp((s) => s.rows);
  const selectedRow = useApp((s) => s.selected);
  const setPaletteQuery = useApp((s) => s.setPaletteQuery);
  const closePalette = useApp((s) => s.closePalette);
  const [index, setIndex] = useState(0);

  const thread = openThread?.thread ?? rows[selectedRow] ?? null;
  const commands = useMemo(() => (open ? buildCommands({ scope, categories, savedSearches, sidebarLayout, accounts, snippets, thread }) : []), [open, scope, categories, savedSearches, sidebarLayout, accounts, snippets, thread]);
  const list = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => setIndex(0), [query, open]);
  const current = Math.min(index, Math.max(0, list.length - 1));

  if (!open) return null;

  const run = (c: Command) => {
    closePalette();
    const s = useApp.getState();
    switch (c.run.kind) {
      case "action":
        appActions()[c.run.action]?.();
        break;
      case "moveTo":
        void s.refile({ split: "important", category: c.run.categoryId });
        break;
      case "openView":
        s.setView(c.run.view.view, { split: c.run.view.split ?? null, category: c.run.view.category ?? null });
        break;
      case "signIn":
        void s.signIn(c.run.accountId);
        break;
      case "insertSnippet": {
        const snippet = s.snippets.find((x) => x.id === (c.run as { snippetId: number }).snippetId);
        if (snippet) s.insertSnippet(snippet);
        break;
      }
      case "search":
        s.setSearchQuery(c.run.query);
        void s.runSearch();
        break;
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(current + 1, Math.max(0, list.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(0, current - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = list[current];
      if (c) run(c);
    }
  };

  return (
    <div className="palette-layer" onMouseDown={closePalette}>
      <section className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <span className="af-mono">Command</span>
          <span className="palette-key">{keyLabel("palette") ?? ""}</span>
        </div>
        <input
          id="palette-input"
          className="palette-input"
          autoFocus
          value={query}
          placeholder={scope === "compose" ? "Send, send later, insert a snippet" : "Type a command, a view, or words to search for"}
          data-tip="Type to filter. Up and Down move, Enter runs the selected command, Esc closes. Text that is not a command searches your mail."
          data-key={keyLabel("closePalette") ?? undefined}
          onChange={(e) => setPaletteQuery(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="palette-rows" role="listbox" aria-label="Commands">
          {list.length === 0 ? (
            <div className="palette-empty">Nothing matches.</div>
          ) : (
            list.map((c, i) => (
              <button key={c.id} type="button" role="option" aria-selected={i === current} className={`palette-row${i === current ? " is-selected" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => run(c)}>
                <span className="palette-label">{c.label}</span>
                {c.key ? <span className="palette-key">{c.key}</span> : null}
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

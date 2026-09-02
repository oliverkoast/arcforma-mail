// Snippet trigger detection: `;trigger` immediately before the cursor, typed
// after whitespace or at the start of a block, expands on Space or Tab.

export interface SnippetLike {
  trigger: string;
  bodyHtml: string;
  bodyText: string;
}

export interface TriggerMatch<S extends SnippetLike> {
  snippet: S;
  /** Characters to delete before the cursor, including the semicolon. */
  length: number;
}

const TRIGGER = /(^|\s);([a-z0-9_-]{1,32})$/i;

/** Looks at the text before the cursor and finds a snippet whose trigger was just typed. */
export function findTrigger<S extends SnippetLike>(textBefore: string, snippets: S[]): TriggerMatch<S> | null {
  const m = TRIGGER.exec(textBefore);
  if (!m) return null;
  const word = m[2]!.toLowerCase();
  const snippet = snippets.find((s) => s.trigger.toLowerCase() === word);
  if (!snippet) return null;
  return { snippet, length: word.length + 1 };
}

/** Case-insensitive filter for the picker: trigger or name contains the query. */
export function filterSnippets<S extends SnippetLike & { name: string }>(query: string, snippets: S[]): S[] {
  const q = query.trim().replace(/^;/, "").toLowerCase();
  if (!q) return snippets;
  return snippets.filter((s) => s.trigger.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
}

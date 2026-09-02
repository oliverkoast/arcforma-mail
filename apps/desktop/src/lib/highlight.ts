// Search highlights arrive as text with a private-use marker pair around each
// matched term (HIGHLIGHT_START, HIGHLIGHT_END). The list turns the runs into
// <mark> elements; nothing else in the app ever writes those characters.

import { HIGHLIGHT_END, HIGHLIGHT_START, type HighlightField } from "../../shared/types";

export interface HighlightRun {
  text: string;
  /** True for a matched term. */
  mark: boolean;
}

/** Splits marked text into runs. Unbalanced markers are treated as plain text so a bad snippet never hides words. */
export function splitHighlight(text: string): HighlightRun[] {
  const out: HighlightRun[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(HIGHLIGHT_START, i);
    if (start < 0) {
      out.push({ text: stripMarkers(text.slice(i)), mark: false });
      break;
    }
    const end = text.indexOf(HIGHLIGHT_END, start + 1);
    if (end < 0) {
      out.push({ text: stripMarkers(text.slice(i)), mark: false });
      break;
    }
    if (start > i) out.push({ text: text.slice(i, start), mark: false });
    const term = text.slice(start + 1, end);
    if (term) out.push({ text: term, mark: true });
    i = end + 1;
  }
  return out.filter((r) => r.text.length > 0);
}

export function stripMarkers(text: string): string {
  return text.split(HIGHLIGHT_START).join("").split(HIGHLIGHT_END).join("");
}

/** The eyebrow word for where the match was found. */
export function highlightFieldLabel(field: HighlightField | null): string {
  switch (field) {
    case "subject":
      return "IN SUBJECT";
    case "from":
      return "FROM";
    case "to":
      return "TO";
    case "body":
      return "IN MESSAGE";
    case null:
      return "";
  }
}

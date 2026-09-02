// The matched text under a search hit: the field it came from as an eyebrow,
// the snippet with each hit term in <mark>. Not wired into ThreadList yet;
// see the WIRING TODO in the feature report.

import { highlightFieldLabel, splitHighlight } from "../lib/highlight";
import type { SearchHighlight } from "../../shared/types";

export function SearchExcerpt({ highlight, className }: { highlight: SearchHighlight; className?: string }) {
  const runs = splitHighlight(highlight.text);
  const label = highlightFieldLabel(highlight.field);
  return (
    <span className={className ?? "search-excerpt"}>
      {label ? <span className="af-mono search-excerpt-field">{label} </span> : null}
      {runs.map((r, i) => (r.mark ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
    </span>
  );
}

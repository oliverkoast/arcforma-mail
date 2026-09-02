import { useEffect, useState } from "react";
import { useApp } from "../state/store";
import { formatAddresses, parseAddresses, recipientLine } from "../lib/compose";
import type { ComposeDraft } from "../../shared/types";

function AddressField({ label, value, onCommit, autoFocus }: { label: string; value: string; onCommit: (text: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="compose-field">
      <span className="af-mono">{label}</span>
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(text)} spellCheck={false} autoFocus={autoFocus} placeholder={label === "To" ? "name@example.com" : ""} data-tip={label === "To" ? "Recipients, separated by commas. Names in the form Dana Reyes <dana@example.com> work too." : "Copied recipients, separated by commas."} />
    </label>
  );
}

/**
 * To and Cc. The floating panel always shows both fields. The inline reply
 * starts as one line ("To Dana Reyes, cc Priya"); a click opens the fields.
 */
export function RecipientLine({ compose, startExpanded }: { compose: ComposeDraft; startExpanded: boolean }) {
  const updateCompose = useApp((s) => s.updateCompose);
  const [expanded, setExpanded] = useState(startExpanded);
  if (!expanded) {
    return (
      <button type="button" className="recipient-line" data-tip="Who gets this reply. Click to open the To and Cc fields." onClick={() => setExpanded(true)}>
        <span className="recipient-line-text">{recipientLine(compose.to, compose.cc)}</span>
        <span className="recipient-line-edit">Edit recipients</span>
      </button>
    );
  }
  return (
    <>
      <AddressField label="To" value={formatAddresses(compose.to)} onCommit={(t) => updateCompose({ to: parseAddresses(t) })} autoFocus={compose.to.length === 0} />
      <AddressField label="Cc" value={formatAddresses(compose.cc)} onCommit={(t) => updateCompose({ cc: parseAddresses(t) })} />
    </>
  );
}

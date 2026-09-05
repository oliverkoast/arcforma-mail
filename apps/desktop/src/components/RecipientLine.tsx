import { useEffect, useRef, useState } from "react";
import { invoke } from "../bridge";
import { useApp } from "../state/store";
import { formatAddresses, parseAddresses, recipientLine } from "../lib/compose";
import type { ComposeDraft, RecipientSuggestion } from "../../shared/types";

/** The part being typed: everything after the last comma, which is the address not yet committed. */
function currentTerm(text: string): string {
  return text.slice(text.lastIndexOf(",") + 1).trim();
}

/** Replaces the part being typed with a chosen address, and leaves a comma ready for the next one. */
function withChoice(text: string, choice: RecipientSuggestion): string {
  const head = text.slice(0, text.lastIndexOf(",") + 1);
  const one = choice.name ? `${choice.name} <${choice.email}>` : choice.email;
  return `${head}${head ? " " : ""}${one}, `;
}

/**
 * One address field, with the people already written to offered underneath.
 *
 * Ranked by the store: an address that has been sent to beats one that only ever wrote in, which is
 * what makes typing a company name useful. The list is keyboard-first, because a compose window
 * that needs the mouse to fill in a recipient is slower than typing the address out.
 */
function AddressField({ label, value, onCommit, autoFocus, exclude }: { label: string; value: string; onCommit: (text: string) => void; autoFocus?: boolean; exclude: string }) {
  const [text, setText] = useState(value);
  const [hits, setHits] = useState<RecipientSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  useEffect(() => setText(value), [value]);

  // Every keystroke asks again, and a late answer to an old keystroke is dropped: without the
  // sequence check a slow query can overwrite the list for what is now on screen.
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const term = currentTerm(text);
    void invoke("recipients:suggest", term, exclude ? exclude.split(",") : [])
      .then((r) => {
        if (seq.current === mine) {
          setHits(r);
          setActive(0);
        }
      })
      .catch(() => {
        if (seq.current === mine) setHits([]);
      });
  }, [text, open, exclude]);

  const choose = (hit: RecipientSuggestion) => {
    const next = withChoice(text, hit);
    setText(next);
    onCommit(next);
    setHits([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (hits.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      const hit = hits[active];
      if (!hit) return;
      // Enter on a highlighted name takes it rather than sending or leaving the field.
      e.preventDefault();
      choose(hit);
    } else if (e.key === "Escape") {
      // The field keeps what is typed; only the list closes, so Esc here does not shut the compose.
      e.stopPropagation();
      setHits([]);
    }
  };

  return (
    <label className="compose-field">
      <span className="af-mono">{label}</span>
      <span className="compose-field-input">
        <input
          value={text}
          onChange={(e) => {
            // Typing is intent on its own. Relying on the focus event alone made the list depend on
            // the window being frontmost, which it is not during a headless check, and would not be
            // if the field were filled by anything other than a click.
            setOpen(true);
            setText(e.target.value);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            onCommit(text);
            // After the click on a row has had time to land.
            setTimeout(() => {
              setOpen(false);
              setHits([]);
            }, 120);
          }}
          spellCheck={false}
          autoFocus={autoFocus}
          autoComplete="off"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-autocomplete="list"
          placeholder={label === "To" ? "name@example.com" : ""}
          data-tip={label === "To" ? "Recipients, separated by commas. Type a name, an address, or a company to see people you have written to." : "Copied recipients, separated by commas."}
        />
        {hits.length > 0 ? (
          <ul className="recipient-suggest" role="listbox">
            {hits.map((hit, i) => (
              <li key={hit.email}>
                <button
                  type="button"
                  className={`recipient-suggest-row${i === active ? " is-active" : ""}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(hit)}
                >
                  <span className="recipient-suggest-name">{hit.name || hit.email}</span>
                  {hit.name ? <span className="recipient-suggest-mail">{hit.email}</span> : null}
                  {hit.sent > 0 ? <span className="af-mono recipient-suggest-note">WRITTEN TO</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </span>
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
  // Anyone already on the message is not worth offering again.
  // Joined rather than passed as an array: a fresh array on every render re-ran the lookup effect
  // without end, because its identity changed even when the addresses did not.
  const onIt = [...compose.to, ...compose.cc, ...compose.bcc].map((a) => a.email).join(",");
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
      <AddressField label="To" value={formatAddresses(compose.to)} onCommit={(t) => updateCompose({ to: parseAddresses(t) })} autoFocus={compose.to.length === 0} exclude={onIt} />
      <AddressField label="Cc" value={formatAddresses(compose.cc)} onCommit={(t) => updateCompose({ cc: parseAddresses(t) })} exclude={onIt} />
    </>
  );
}

import { useEffect, useState, type FocusEvent } from "react";
import { useApp } from "../state/store";
import { keyLabel } from "../keys/keyLabel";

/**
 * The bottom-left confirmation. At rest it is the sentence and nothing else:
 * "Marked done." Bring the pointer to it, or Tab into it, and the Undo control
 * appears with its key beside it, while the dismissal timer stops for as long
 * as anyone is there. Z anywhere does the same thing without coming near it,
 * and the live region says so, so nothing here depends on a hover.
 */
export function Toast() {
  const toast = useApp((s) => s.toast);
  const undo = useApp((s) => s.undo);
  const pauseToast = useApp((s) => s.pauseToast);
  const resumeToast = useApp((s) => s.resumeToast);
  const [revealed, setRevealed] = useState(false);
  // Every new toast starts at rest, whatever the last one was showing.
  useEffect(() => {
    setRevealed(false);
  }, [toast]);
  if (!toast) return null;

  const key = keyLabel("undo") ?? "Z";
  const hold = () => {
    setRevealed(true);
    pauseToast();
  };
  // Focus inside the toast keeps it open even when the pointer has gone; the button must not vanish under the keyboard.
  const release = (el: HTMLElement | null) => {
    if (el && document.activeElement && el.contains(document.activeElement)) return;
    setRevealed(false);
    resumeToast();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setRevealed(false);
    resumeToast();
  };

  return (
    <div
      className={`toast${revealed ? " is-open" : ""}`}
      role="status"
      aria-live="polite"
      tabIndex={0}
      onMouseEnter={hold}
      onMouseLeave={(e) => release(e.currentTarget)}
      onFocus={hold}
      onBlur={onBlur}
    >
      {toast.eyebrow ? <span className="af-mono">{toast.eyebrow}</span> : null}
      <span>{toast.text}</span>
      {toast.undo ? (
        <>
          <span className="toast-said">{`Press ${key} to undo, or move to this message for an Undo button.`}</span>
          {revealed ? (
            <button type="button" className="toast-undo" data-tip="Takes the last action back. A sent message comes back as a draft." data-key={key} onClick={() => void undo()}>
              Undo <span className="af-mono">{key}</span>
            </button>
          ) : null}
        </>
      ) : toast.noUndo ? (
        <span className="toast-note">{toast.noUndo}</span>
      ) : null}
    </div>
  );
}

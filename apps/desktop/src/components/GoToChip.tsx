import { useApp } from "../state/store";
import { GO_TO } from "../keys/keymap";

/**
 * What G is waiting for.
 *
 * A prefix chord is invisible by nature: between the two keys the app looks exactly as it did, and
 * anyone who presses G and pauses has no way to know whether it registered or what comes next. This
 * chip is the whole difference between a shortcut people learn and one they press once by accident.
 * It lists every destination rather than a hint to go read the docs, because the list is short
 * enough to read in the time it takes to decide.
 */
export function GoToChip() {
  const armed = useApp((s) => s.goToArmed);
  if (!armed) return null;
  return (
    <div className="goto-chip" role="status" aria-live="polite">
      <span className="af-mono">GO TO</span>
      <span className="goto-keys">
        {GO_TO.map((g) => (
          <span key={g.key}>
            <span className="af-mono goto-key">{g.key.toUpperCase()}</span> {g.label}
          </span>
        ))}
      </span>
    </div>
  );
}

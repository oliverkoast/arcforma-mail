import { useApp } from "../state/store";
import { keyLabel } from "../keys/keyLabel";

export function Toast() {
  const toast = useApp((s) => s.toast);
  const undo = useApp((s) => s.undo);
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      {toast.eyebrow ? <span className="af-mono">{toast.eyebrow}</span> : null}
      <span>{toast.text}</span>
      {toast.undo ? <button data-tip="Undoes the last action. A sent message comes back as a draft." data-key={keyLabel("undo") ?? undefined} onClick={() => void undo()}>Undo (Z)</button> : null}
    </div>
  );
}

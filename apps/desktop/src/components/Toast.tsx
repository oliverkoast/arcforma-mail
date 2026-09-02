import { useApp } from "../state/store";

export function Toast() {
  const toast = useApp((s) => s.toast);
  const undo = useApp((s) => s.undo);
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      {toast.eyebrow ? <span className="af-mono">{toast.eyebrow}</span> : null}
      <span>{toast.text}</span>
      {toast.undo ? <button onClick={() => void undo()}>Undo (Z)</button> : null}
    </div>
  );
}

import type { ReactNode } from "react";

/** One step's frame: eyebrow, heading, body, then whatever the step puts on screen, then its buttons. */
export function StepCard({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children: ReactNode; actions: ReactNode }) {
  return (
    <div className="setup-card">
      <span className="af-mono">{eyebrow}</span>
      <h1 className="af-h2">{title}</h1>
      {children}
      <div className="setup-actions">{actions}</div>
    </div>
  );
}

/** A labelled text field with its own error line, so a wrong paste is answered next to the field. */
export function Field({
  label,
  value,
  onChange,
  placeholder,
  error,
  hint,
  tip,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string | null;
  hint?: string;
  tip?: string;
  type?: "text" | "password";
}) {
  return (
    <label className="setup-field">
      <span className="af-mono">{label}</span>
      <input type={type} value={value} spellCheck={false} autoComplete="off" placeholder={placeholder} data-tip={tip} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className="setup-hint">{hint}</span> : null}
      {error ? <span className="setup-error">{error}</span> : null}
    </label>
  );
}

/** One of a set of choices: a heading, the trade-off written out, and whatever the choice needs when it is picked. */
export function Choice({ on, name, line, onPick, tip, children }: { on: boolean; name: string; line: string; onPick: () => void; tip: string; children?: ReactNode }) {
  return (
    <div className={`setup-choice${on ? " is-on" : ""}`}>
      <button className="setup-choice-head" aria-pressed={on} data-tip={tip} onClick={onPick}>
        <span className="setup-choice-name">{name}</span>
        <span className="setup-choice-line">{line}</span>
        {on ? <span className="af-mono setup-choice-mark">Chosen</span> : null}
      </button>
      {on && children ? <div className="setup-choice-body">{children}</div> : null}
    </div>
  );
}

/** A determinate bar. Percent null draws an empty track and the line under it says what is happening. */
export function ProgressBar({ percent }: { percent: number | null }) {
  return (
    <div className="setup-bar" role="progressbar" aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className="setup-bar-fill" style={{ width: `${percent ?? 0}%` }} />
    </div>
  );
}

/** A short row of found-or-missing facts about the machine. */
export function FactRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="setup-fact">
      <span className={`af-mono${ok ? "" : " eyebrow-flag"}`}>{ok ? "Found" : "Missing"}</span>
      <span className="setup-fact-name">{label}</span>
      <span className="setup-fact-detail">{detail}</span>
    </div>
  );
}

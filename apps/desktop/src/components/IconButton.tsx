import type { ReactNode } from "react";

export type Glyph = "reply" | "replyAll" | "forward" | "done" | "snooze" | "star" | "daily" | "weekly" | "trash";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Small UI glyphs, 16 px, hidden from assistive tech: the button's aria-label carries the meaning. */
function Icon({ glyph }: { glyph: Glyph }): ReactNode {
  switch (glyph) {
    case "reply":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
          <path d="M6.5 3.5L2.5 7l4 3.5M2.5 7h6a5 5 0 0 1 5 5v1" />
        </svg>
      );
    case "replyAll":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
          <path d="M5 3.5L1.5 7 5 10.5M9 3.5L5.5 7 9 10.5M5.5 7h3.5a4.5 4.5 0 0 1 4.5 4.5V13" />
        </svg>
      );
    case "forward":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
          <path d="M9.5 3.5L13.5 7l-4 3.5M13.5 7h-6a5 5 0 0 0-5 5v1" />
        </svg>
      );
    case "done":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
          <path d="M2 9.5v3h12v-3M2 9.5h3.5l1 1.5h3l1-1.5H14M5 6l2 2 4-4.5" />
        </svg>
      );
    case "snooze":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 1.5" />
        </svg>
      );
    case "star":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
          <path d="M8 1.5l1.9 4.1 4.5.5-3.3 3.1.9 4.4L8 11.4l-4 2.2.9-4.4L1.6 6.1l4.5-.5L8 1.5z" />
        </svg>
      );
    case "daily":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" />
        </svg>
      );
    case "weekly":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="1.5" cy="8" r="1" />
          <circle cx="3.7" cy="8" r="1" />
          <circle cx="5.9" cy="8" r="1" />
          <circle cx="8" cy="8" r="1" />
          <circle cx="10.1" cy="8" r="1" />
          <circle cx="12.3" cy="8" r="1" />
          <circle cx="14.5" cy="8" r="1" />
        </svg>
      );
    case "trash":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
          <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5" />
        </svg>
      );
  }
}

export interface IconButtonProps {
  glyph: Glyph;
  /** What the button does, as the tooltip and the accessible name: "Mark done". */
  label: string;
  /** The key that does the same thing, shown in the tooltip: "E", "Cmd+Shift+D". */
  keyHint?: string;
  /** A toggle that is currently on (starred, in a queue) reads in cobalt. */
  active?: boolean;
  onClick: () => void;
  className?: string;
}

/**
 * A 32 px square icon button: no fill, ink-soft glyph, ink on hover, cobalt
 * when active. Every thread action in the reading pane is one of these.
 */
export function IconButton({ glyph, label, keyHint, active, onClick, className }: IconButtonProps) {
  const title = keyHint ? `${label} (${keyHint})` : label;
  return (
    <button type="button" className={`icon-btn${active ? " is-active" : ""}${className ? ` ${className}` : ""}`} title={title} aria-label={title} aria-pressed={active === undefined ? undefined : active} onClick={onClick}>
      <Icon glyph={glyph} />
    </button>
  );
}

/** The three reply actions as icons, for the thread head, each message, and the bottom of the thread. */
export function ReplyIcons({ onReply, onReplyAll, onForward }: { onReply: () => void; onReplyAll: () => void; onForward: () => void }) {
  return (
    <>
      <IconButton glyph="reply" label="Reply" keyHint="R" onClick={onReply} />
      <IconButton glyph="replyAll" label="Reply all" keyHint="A" onClick={onReplyAll} />
      <IconButton glyph="forward" label="Forward" keyHint="F" onClick={onForward} />
    </>
  );
}

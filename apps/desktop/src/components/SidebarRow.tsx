import type React from "react";
import type { Anchor } from "../state/store";
import type { SidebarRowDescriptor } from "../lib/sidebarLayout";

export interface SidebarRowProps {
  row: SidebarRowDescriptor;
  active: boolean;
  count: number;
  /** What the row contains, shown on hover. */
  tip: string;
  disabled: boolean;
  dragging: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onMenu: (anchor: Anchor) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function anchorOf(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { x: r.right, y: r.top };
}

/** One draggable sidebar row: the view button and its count. The row menu is on right-click.
 *
 * There is deliberately no hover "..." button. It sat where the count was, so the count had to hide
 * to make room, and a row emptied out under the pointer at the exact moment you were reading it.
 * Right-click keeps rename, hide and remove reachable, and keyboard users get the same menu because
 * the Menu key and Shift+F10 fire contextmenu on the focused button. */
export function SidebarRow({ row, active, count, tip, disabled, dragging, menuOpen, onOpen, onMenu, onDragStart, onDragEnd }: SidebarRowProps) {
  const start = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData("text/plain", row.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStart();
  };
  return (
    <div className={`nav-row${dragging ? " dragging" : ""}`} data-row-id={row.id} draggable={!disabled} onDragStart={start} onDragEnd={onDragEnd}>
      <button
        className="nav-item"
        aria-current={active ? "true" : undefined}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tip={`${row.label}: ${tip}`}
        onClick={onOpen}
        onContextMenu={(e) => {
          if (disabled) return;
          e.preventDefault();
          onMenu(anchorOf(e.currentTarget));
        }}
        disabled={disabled}
      >
        <span className="nav-label">{row.label}</span>
        {count ? <span className="nav-count">{count}</span> : null}
      </button>
    </div>
  );
}

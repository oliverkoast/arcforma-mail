import type React from "react";
import type { Anchor } from "../state/store";
import type { SidebarRowDescriptor } from "../lib/sidebarLayout";

export interface SidebarRowProps {
  row: SidebarRowDescriptor;
  active: boolean;
  count: number;
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

/** One draggable sidebar row: the view button, its count, and the hover "..." that opens the row menu. */
export function SidebarRow({ row, active, count, disabled, dragging, menuOpen, onOpen, onMenu, onDragStart, onDragEnd }: SidebarRowProps) {
  const start = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData("text/plain", row.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStart();
  };
  return (
    <div className={`nav-row${dragging ? " dragging" : ""}`} data-row-id={row.id} draggable={!disabled} onDragStart={start} onDragEnd={onDragEnd}>
      <button className="nav-item" aria-current={active ? "true" : undefined} onClick={onOpen} disabled={disabled}>
        <span className="nav-label">{row.label}</span>
        {count ? <span className="nav-count">{count}</span> : null}
      </button>
      <button className="nav-more" aria-label={`Options for ${row.label}`} aria-expanded={menuOpen} title="Rename, hide, or remove" disabled={disabled} onClick={(e) => onMenu(anchorOf(e.currentTarget))}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="7" r="1.3" />
          <circle cx="7" cy="7" r="1.3" />
          <circle cx="11.5" cy="7" r="1.3" />
        </svg>
      </button>
    </div>
  );
}

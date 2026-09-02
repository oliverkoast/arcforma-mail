import type React from "react";
import { Fragment, useState } from "react";
import type { Anchor } from "../state/store";
import { SidebarRow, anchorOf } from "./SidebarRow";
import type { SidebarRowDescriptor } from "../lib/sidebarLayout";
import type { SidebarGroupId } from "../../shared/types";

export interface SidebarGroupProps {
  id: SidebarGroupId;
  label: string;
  rows: SidebarRowDescriptor[];
  disabled: boolean;
  isActive: (row: SidebarRowDescriptor) => boolean;
  countOf: (row: SidebarRowDescriptor) => number;
  /** What the row contains, for its tooltip. */
  tipOf: (row: SidebarRowDescriptor) => string;
  menuRowId: string | null;
  addOpen: boolean;
  onOpen: (row: SidebarRowDescriptor) => void;
  onAdd: (anchor: Anchor) => void;
  onRowMenu: (row: SidebarRowDescriptor, anchor: Anchor) => void;
  /** The row id being dragged anywhere in the sidebar, so a group can accept a drop from another group. */
  dragId: string | null;
  setDragId: (id: string | null) => void;
  onMove: (rowId: string, group: SidebarGroupId, beforeId: string | null) => void;
}

/** The visible row whose top half the pointer is over, or null for the end of the group. */
function dropTarget(container: HTMLElement, y: number): string | null {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(".nav-row"))) {
    const r = el.getBoundingClientRect();
    if (y < r.top + r.height / 2) return el.dataset["rowId"] ?? null;
  }
  return null;
}

/**
 * One sidebar group: an eyebrow with a hover "+" and its rows. Native drag
 * and drop: the group is the drop zone, an insertion line shows where the
 * row lands, and a drop calls onMove with the row before which it goes.
 */
export function SidebarGroup(p: SidebarGroupProps) {
  // undefined: nothing hovering; null: drop at the end; a string: drop before that row.
  const [drop, setDrop] = useState<string | null | undefined>(undefined);

  const over = (e: React.DragEvent<HTMLDivElement>) => {
    if (!p.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const next = dropTarget(e.currentTarget, e.clientY);
    if (next !== drop) setDrop(next);
  };
  const leave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(undefined);
  };
  const dropped = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = p.dragId ?? e.dataTransfer.getData("text/plain");
    if (id) p.onMove(id, p.id, drop ?? null);
    setDrop(undefined);
    p.setDragId(null);
  };

  return (
    <div className={`nav-group${drop !== undefined ? " drop-target" : ""}`} data-group={p.id} onDragOver={over} onDragEnter={over} onDragLeave={leave} onDrop={dropped}>
      <div className="nav-group-head">
        <span className="af-mono nav-eyebrow">{p.label}</span>
        <button className="nav-add" aria-label="Add a row" aria-expanded={p.addOpen} data-tip={`Add a row to ${p.label}: a category, a saved search, or a row you hid.`} disabled={p.disabled} onClick={(e) => p.onAdd(anchorOf(e.currentTarget))}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M7 2.5v9M2.5 7h9" />
          </svg>
        </button>
      </div>
      <div className="nav-rows">
        {p.rows.map((row) => (
          <Fragment key={row.id}>
            {drop === row.id ? <div className="nav-drop-line" aria-hidden="true" /> : null}
            <SidebarRow
              row={row}
              active={p.isActive(row)}
              count={p.countOf(row)}
              tip={p.tipOf(row)}
              disabled={p.disabled}
              dragging={p.dragId === row.id}
              menuOpen={p.menuRowId === row.id}
              onOpen={() => p.onOpen(row)}
              onMenu={(anchor) => p.onRowMenu(row, anchor)}
              onDragStart={() => p.setDragId(row.id)}
              onDragEnd={() => {
                p.setDragId(null);
                setDrop(undefined);
              }}
            />
          </Fragment>
        ))}
        {drop === null ? <div className="nav-drop-line" aria-hidden="true" /> : null}
        {p.rows.length === 0 && drop === undefined ? <div className="af-mono nav-rows-empty">No rows. Drag one here or add one.</div> : null}
      </div>
    </div>
  );
}
